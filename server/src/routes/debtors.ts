// Debtors: who owes the company what, and for how long; and accounts on hold. The office sees the
// list (whoever has quotes and invoices); the CEO and Accounts put a client that is not paying on
// hold. A job for a client on hold can still be opened, but it warns first and Accounts is told.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Q } from '../db.ts';
import { audit, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as DB from '../core/debtors.ts';
import * as D from '../core/documents.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { notify } from './field.ts';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

/** Every sent (not paid, not cancelled) invoice, with what is credited, for the age analysis. */
export async function openInvoices(c: Q, clientId?: string): Promise<DB.OpenInvoice[]> {
  const { rows } = await c.query(
    `SELECT i.id, i.invoice_number, c.id AS client_id, c.name AS client, s.name AS store, j.job_number, i.vat_pct::float AS vat_pct,
            to_char(coalesce(i.sent_at, i.created_at) AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS date, to_char(i.due_date, 'YYYY-MM-DD') AS due,
            (SELECT coalesce(sum(round(l.qty * l.unit_price_cents)), 0)::bigint FROM document_lines l WHERE l.invoice_id = i.id) AS ex_vat,
            (SELECT coalesce(sum(cn.amount_cents), 0)::bigint FROM credit_notes cn WHERE cn.invoice_id = i.id) AS credited_ex
       FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN stores s ON s.id = j.store_id JOIN clients c ON c.id = s.client_id
      WHERE i.status = 'sent'${clientId ? ' AND c.id = $1' : ''} ORDER BY i.invoice_number`, clientId ? [clientId] : []);
  return rows.map(r => ({
    id: r.id, number: r.invoice_number, clientId: r.client_id, client: r.client, store: r.store, jobNumber: r.job_number, date: r.date, due: r.due,
    totalCents: D.totals([{ qty: 1, unitPriceCents: Number(r.ex_vat) }], r.vat_pct).totalCents,
    creditedCents: D.totals([{ qty: 1, unitPriceCents: Number(r.credited_ex) }], r.vat_pct).totalCents,
  }));
}

/** A client on hold, if the store's client is (for a warning before a job is opened). */
export async function holdOfStore(c: Q, storeId: string): Promise<{ clientId: string; client: string; reason: string } | null> {
  const r = (await c.query('SELECT c.id, c.name, c.on_hold, c.hold_reason FROM stores s JOIN clients c ON c.id = s.client_id WHERE s.id = $1', [storeId])).rows[0];
  return r?.on_hold ? { clientId: r.id, client: r.name, reason: r.hold_reason } : null;
}

/** A job opened anyway for a client on hold: kept on the client's record, and Accounts and the CEO are told. */
export async function jobOpenedOnHold(c: Q, actorId: string, hold: { clientId: string; client: string; reason: string }, jobId: string, jobNumber: number) {
  await c.query('INSERT INTO client_hold_log (client_id, on_hold, reason, job_id, by_user) VALUES ($1, true, $2, $3, $4)', [hold.clientId, `Job ${jobNumber} opened while on hold`, jobId, actorId]);
  const who = (await c.query('SELECT full_name FROM users WHERE id = $1', [actorId])).rows[0]?.full_name ?? 'Someone';
  const to = (await c.query("SELECT id FROM users WHERE login_level IN ('accounts', 'director', 'creator') AND status = 'active' AND id <> $1", [actorId])).rows;
  for (const u of to) await notify(c, u.id, 'job_on_hold', `${who} opened job ${jobNumber} for ${hold.client}, which is on hold (${hold.reason}).`, { jobId, clientId: hold.clientId });
}

export function registerDebtorRoutes(app: FastifyInstance) {
  const sees = (req: FastifyRequest) => {
    if (!can(req.actor, 'view_quotes_invoices_stock') && !can(req.actor, 'hold_accounts')) throw new Refused(403, ['debtors are for Accounts and the CEO']);
  };

  app.get('/office/debtors', async req => {
    sees(req);
    const t = today();
    const a = DB.ageAnalysis(await openInvoices(req.db), t);
    const info = new Map((await req.db.query('SELECT id, name, pastel_code, on_hold, hold_reason FROM clients')).rows.map(r => [r.id, r]));
    const clients = a.clients.map(c => ({ ...c, pastelCode: info.get(c.clientId)?.pastel_code ?? null, onHold: !!info.get(c.clientId)?.on_hold, holdReason: info.get(c.clientId)?.hold_reason ?? null }));
    // Clients on hold who owe nothing (yet) still show, at the end.
    for (const r of info.values()) {
      if (r.on_hold && !clients.some(c => c.clientId === r.id)) {
        clients.push({ clientId: r.id, client: r.name, bands: Object.fromEntries(DB.AGE_BANDS.map(b => [b, 0])) as Record<DB.AgeBand, number>, total: 0, overdue: 0, invoices: 0, oldestDays: 0, pastelCode: r.pastel_code, onHold: true, holdReason: r.hold_reason });
      }
    }
    return { today: t, totals: a.totals, clients, canHold: can(req.actor, 'hold_accounts') };
  });

  app.get('/office/debtors/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    sees(req);
    const id = parse(Uuid, req.params.id);
    const cl = (await req.db.query(
      `SELECT c.id, c.name, c.pastel_code, c.email, c.phone, c.contact_name, c.on_hold, c.hold_reason, c.hold_at, u.full_name AS hold_by
         FROM clients c LEFT JOIN users u ON u.id = c.hold_by WHERE c.id = $1`, [id])).rows[0];
    if (!cl) throw new Refused(404, ['no such client']);
    const t = today();
    const invoices = (await openInvoices(req.db, id)).filter(i => DB.owing(i) > 0).map(i => ({
      ...i, owing: DB.owing(i), band: DB.ageBand(i.date, t), days: DB.daysBetween(i.date, t), overdueDays: i.due && i.due < t ? DB.daysBetween(i.due, t) : 0,
    }));
    const history = (await req.db.query(
      `SELECT h.on_hold, h.reason, h.at, u.full_name AS by, j.job_number FROM client_hold_log h JOIN users u ON u.id = h.by_user LEFT JOIN jobs j ON j.id = h.job_id
        WHERE h.client_id = $1 ORDER BY h.at DESC LIMIT 30`, [id])).rows;
    const a = DB.ageAnalysis(invoices, t);
    return { client: cl, invoices, summary: a.clients[0] ?? null, history, canHold: can(req.actor, 'hold_accounts') };
  });

  // On hold (with the reason) or off again.
  app.post('/office/clients/:id/hold', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!can(req.actor, 'hold_accounts')) throw new Refused(403, ['only the CEO and Accounts put an account on hold']);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ on: z.boolean(), reason: z.string().trim().max(300).optional() }), req.body);
    if (b.on && (!b.reason || b.reason.length < 3)) throw new Refused(400, ['why the account is on hold (the office sees it when opening a job)']);
    return tx(req.db, async c => {
      const cl = (await c.query('SELECT name, on_hold FROM clients WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cl) throw new Refused(404, ['no such client']);
      if (cl.on_hold === b.on && !b.on) throw new Refused(409, [`${cl.name} is not on hold`]);
      await c.query('UPDATE clients SET on_hold = $2, hold_reason = $3, hold_by = $4, hold_at = now() WHERE id = $1', [id, b.on, b.on ? b.reason : null, req.actor.id]);
      await c.query('INSERT INTO client_hold_log (client_id, on_hold, reason, by_user) VALUES ($1, $2, $3, $4)', [id, b.on, b.on ? b.reason : (b.reason || null), req.actor.id]);
      await audit(c, req.actor.id, b.on ? 'client_on_hold' : 'client_off_hold', 'client', id, { reason: b.reason ?? null });
      return { id, onHold: b.on, reason: b.on ? b.reason : null };
    });
  });
}
