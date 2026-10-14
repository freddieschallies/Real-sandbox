// Customers, for Accounts and the office: every client with what it was invoiced, paid, credited and
// still owes; and one client with its stores, every job (and where its money stands), every invoice,
// credit note and quote.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { can } from '../core/permissions.ts';
import * as D from '../core/documents.ts';
import { jobOutcome } from '../core/jobOutcome.ts';
import { DateOnly, Refused, Uuid, parse } from '../http.ts';
import { z } from 'zod';
import { audit, type Q } from '../db.ts';
import * as ST from '../core/statement.ts';
import type { Mailer } from '../mailer.ts';
import { letterheadForMail } from './reports.ts';

const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const vat = (ex: number, pct: number) => D.totals([{ qty: 1, unitPriceCents: ex }], pct).totalCents;

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const day = (col: string) => `to_char(${col} AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD')`;

/** Everything a client was invoiced (sent or paid), and every credit note: for its statement. */
export async function statementOf(c: Q, clientId: string, from: string | null, to: string): Promise<ST.Statement> {
  const inv = (await c.query(
    `SELECT i.id, i.invoice_number, ${day('coalesce(i.sent_at, i.created_at)')} AS date, to_char(i.due_date, 'YYYY-MM-DD') AS due,
            CASE WHEN i.status = 'paid' THEN ${day('i.paid_at')} END AS paid, i.paid_ref, j.job_number, s.name AS store, i.client_ref, i.vat_pct::float AS vat_pct,
            (SELECT coalesce(sum(round(l.qty * l.unit_price_cents)), 0) FROM document_lines l WHERE l.invoice_id = i.id)::bigint AS ex
       FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN stores s ON s.id = j.store_id WHERE s.client_id = $1 AND i.status IN ('sent', 'paid')`, [clientId])).rows;
  const cr = (await c.query(
    `SELECT cn.credit_number, ${day('cn.created_at')} AS date, cn.invoice_id, cn.amount_cents::bigint AS ex, cn.vat_pct::float AS vat_pct, cn.reason
       FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id JOIN jobs j ON j.id = i.job_id JOIN stores s ON s.id = j.store_id
      WHERE s.client_id = $1 AND i.status IN ('sent', 'paid')`, [clientId])).rows;
  return ST.buildStatement(
    inv.map(i => ({ id: i.id, number: i.invoice_number, date: i.date, due: i.due, paid: i.paid ?? null, paidRef: i.paid_ref, jobNumber: i.job_number, store: i.store, clientRef: i.client_ref, totalCents: vat(Number(i.ex), i.vat_pct) })),
    cr.map(x => ({ number: x.credit_number, date: x.date, invoiceId: x.invoice_id, reason: x.reason, totalCents: vat(Number(x.ex), x.vat_pct) })),
    from, to);
}

const Period = z.object({ from: DateOnly.nullable().optional(), to: DateOnly.optional() });

export function registerClientRoutes(app: FastifyInstance, mailer: Mailer | null = null) {
  const sees = (req: FastifyRequest) => {
    if (!can(req.actor, 'view_quotes_invoices_stock') && !can(req.actor, 'view_all_job_cards')) throw new Refused(403, ['customers are for Accounts and the office']);
  };

  app.get('/office/clients', async req => {
    sees(req);
    const { rows } = await req.db.query(
      `SELECT c.id, c.name, c.pastel_code, c.on_hold, c.contact_name, c.phone, c.email,
              (SELECT count(*)::int FROM stores s WHERE s.client_id = c.id) AS stores,
              (SELECT count(*)::int FROM jobs j JOIN stores s ON s.id = j.store_id WHERE s.client_id = c.id) AS jobs,
              (SELECT count(*)::int FROM jobs j JOIN stores s ON s.id = j.store_id WHERE s.client_id = c.id AND j.status NOT IN ('closed', 'cancelled')) AS open_jobs,
              (SELECT max(j.created_at) FROM jobs j JOIN stores s ON s.id = j.store_id WHERE s.client_id = c.id) AS last_job,
              EXISTS (SELECT 1 FROM client_rates r WHERE r.client_id = c.id) AS own_rates
         FROM clients c ORDER BY c.name`);
    // Money per client (incl. VAT): invoiced (sent or paid), paid, credited, still owed.
    const money = (await req.db.query(
      `SELECT s.client_id, i.status, i.vat_pct::float AS vat_pct,
              (SELECT coalesce(sum(round(l.qty * l.unit_price_cents)), 0) FROM document_lines l WHERE l.invoice_id = i.id)::bigint AS ex,
              (SELECT coalesce(sum(cn.amount_cents), 0) FROM credit_notes cn WHERE cn.invoice_id = i.id)::bigint AS cr
         FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN stores s ON s.id = j.store_id WHERE i.status IN ('sent', 'paid')`)).rows;
    const by = new Map<string, { invoiced: number; paid: number; credited: number; owing: number; invoices: number }>();
    for (const m of money) {
      const g = by.get(m.client_id) ?? { invoiced: 0, paid: 0, credited: 0, owing: 0, invoices: 0 };
      const total = vat(Number(m.ex), m.vat_pct), credit = vat(Number(m.cr), m.vat_pct);
      g.invoices++; g.invoiced += total; g.credited += credit;
      if (m.status === 'paid') g.paid += total; else g.owing += Math.max(0, total - credit);
      by.set(m.client_id, g);
    }
    return rows.map(r => ({ ...r, ...(by.get(r.id) ?? { invoiced: 0, paid: 0, credited: 0, owing: 0, invoices: 0 }) }));
  });

  app.get('/office/clients/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    sees(req);
    const id = parse(Uuid, req.params.id);
    const client = (await req.db.query(
      `SELECT c.id, c.name, c.pastel_code, c.account_code, c.contact_name, c.phone, c.email, c.on_hold, c.hold_reason,
              EXISTS (SELECT 1 FROM client_rates r WHERE r.client_id = c.id) AS own_rates FROM clients c WHERE c.id = $1`, [id])).rows[0];
    if (!client) throw new Refused(404, ['no such client']);
    const stores = (await req.db.query(
      `SELECT s.id, s.name, s.address, s.branch_code, (SELECT count(*)::int FROM jobs j WHERE j.store_id = s.id) AS jobs
         FROM stores s WHERE s.client_id = $1 ORDER BY s.name`, [id])).rows;
    const jobs = (await req.db.query(
      `SELECT j.id, j.job_number, j.job_type, j.status, j.scheduled_date, j.fault_reported, s.name AS store, u.full_name AS technician, j.client_order_ref,
              to_char(j.closed_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS closed, j.cancelled_by_party, nc.reason AS no_charge_reason,
              inv.invoice_number, inv.status AS invoice_status, (SELECT coalesce(sum(cn.amount_cents), 0) FROM credit_notes cn WHERE cn.job_id = j.id)::bigint AS credited_cents
         FROM jobs j JOIN stores s ON s.id = j.store_id JOIN users u ON u.id = j.lead_technician_id LEFT JOIN job_no_charge nc ON nc.job_id = j.id
         LEFT JOIN LATERAL (SELECT i.invoice_number, i.status FROM invoices i WHERE i.job_id = j.id AND i.status <> 'cancelled' ORDER BY i.created_at DESC LIMIT 1) inv ON true
        WHERE s.client_id = $1 ORDER BY j.job_number DESC LIMIT 1000`, [id])).rows
      .map(j => ({ ...j, credited_cents: Number(j.credited_cents), outcome: jobOutcome({ ...j, credited_cents: Number(j.credited_cents) }) }));
    const invoices = (await req.db.query(
      `SELECT i.id, i.invoice_number, i.status, i.created_at, i.sent_at, i.paid_at, i.paid_ref, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.vat_pct::float AS vat_pct,
              j.job_number, s.name AS store, i.client_ref,
              (SELECT coalesce(sum(round(l.qty * l.unit_price_cents)), 0) FROM document_lines l WHERE l.invoice_id = i.id)::bigint AS ex_vat,
              (SELECT coalesce(sum(cn.amount_cents), 0) FROM credit_notes cn WHERE cn.invoice_id = i.id)::bigint AS credited_ex
         FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN stores s ON s.id = j.store_id WHERE s.client_id = $1 ORDER BY i.invoice_number DESC`, [id])).rows
      .map(i => ({ ...i, total_cents: vat(Number(i.ex_vat), i.vat_pct), credited_cents: vat(Number(i.credited_ex), i.vat_pct) }));
    const credits = (await req.db.query(
      `SELECT cn.id, cn.credit_number, cn.amount_cents::bigint AS amount_cents, cn.vat_pct::float AS vat_pct, cn.reason, cn.created_at, u.full_name AS created_by,
              i.id AS invoice_id, i.invoice_number, j.job_number
         FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id JOIN jobs j ON j.id = cn.job_id JOIN stores s ON s.id = j.store_id JOIN users u ON u.id = cn.created_by
        WHERE s.client_id = $1 ORDER BY cn.credit_number DESC`, [id])).rows
      .map(c => ({ ...c, amount_cents: Number(c.amount_cents), total_cents: vat(Number(c.amount_cents), c.vat_pct) }));
    const quotes = (await req.db.query(
      `SELECT q.id, q.quote_number, q.status, q.title, q.created_at, q.sent_at, s.name AS store, j.job_number,
              (SELECT coalesce(sum(round(l.qty * l.unit_price_cents)), 0) FROM document_lines l WHERE l.quote_id = q.id)::bigint AS ex_vat, q.vat_pct::float AS vat_pct
         FROM quotes q LEFT JOIN jobs j ON j.id = q.job_id JOIN stores s ON s.id = coalesce(q.store_id, j.store_id) WHERE s.client_id = $1 ORDER BY q.quote_number DESC`, [id])).rows
      .map(q => ({ ...q, total_cents: vat(Number(q.ex_vat), q.vat_pct) }));
    const live = invoices.filter(i => i.status === 'sent' || i.status === 'paid');
    const summary = {
      jobs: jobs.length, openJobs: jobs.filter(j => !['closed', 'cancelled'].includes(j.status)).length,
      invoiced: live.reduce((n, i) => n + i.total_cents, 0), paid: live.filter(i => i.status === 'paid').reduce((n, i) => n + i.total_cents, 0),
      credited: credits.reduce((n, c) => n + c.total_cents, 0),
      owing: live.filter(i => i.status === 'sent').reduce((n, i) => n + Math.max(0, i.total_cents - i.credited_cents), 0),
      toInvoice: jobs.filter(j => j.outcome.key === 'to_invoice').length,
    };
    return { client, stores, jobs, invoices, credits, quotes, summary };
  });

  // ---- Statements: what the client was invoiced, credited and paid, the running balance and the age analysis.
  const period = (q: unknown) => { const p = parse(Period, q); const to = p.to ?? today(); const from = p.from ?? null; if (from && from > to) throw new Refused(400, ['the start is after the end']); return { from, to }; };

  app.get('/office/clients/:id/statement', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    sees(req);
    const id = parse(Uuid, req.params.id);
    const client = (await req.db.query('SELECT id, name, pastel_code, contact_name, email, phone FROM clients WHERE id = $1', [id])).rows[0];
    if (!client) throw new Refused(404, ['no such client']);
    const { from, to } = period(req.query);
    const statement = await statementOf(req.db, id, from, to);
    const company = (await req.db.query('SELECT bank_details, invoice_terms FROM company_profile')).rows[0] ?? {};
    const emails = (await req.db.query(
      `SELECT e.sent_to, e.sent_at, e.ok, e.error, to_char(e.period_from, 'YYYY-MM-DD') AS period_from, to_char(e.period_to, 'YYYY-MM-DD') AS period_to, e.balance_cents::bigint AS balance_cents, u.full_name AS sent_by
         FROM statement_emails e JOIN users u ON u.id = e.sent_by WHERE e.client_id = $1 ORDER BY e.sent_at DESC LIMIT 20`, [id])).rows.map(e => ({ ...e, balance_cents: Number(e.balance_cents) }));
    const storeEmails = (await req.db.query("SELECT DISTINCT email FROM stores WHERE client_id = $1 AND coalesce(email, '') <> ''", [id])).rows.map(r => r.email as string);
    return { client, statement, company, emails, storeEmails, canEmail: !!mailer && can(req.actor, 'prepare_quotes_invoices'), mailReady: !!mailer };
  });

  app.post('/office/clients/:id/statement/email', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    sees(req);
    if (!can(req.actor, 'prepare_quotes_invoices')) throw new Refused(403, ['statements are sent by Accounts']);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ to: z.array(z.string().trim().email('a valid email address')).min(1, 'who to send it to').max(10), from: DateOnly.nullable().optional(), upTo: DateOnly.optional(), message: z.string().trim().max(2000).optional() }), req.body);
    const { from, to } = period({ from: b.from, to: b.upTo });
    const c = req.db;
    const client = (await c.query('SELECT id, name, pastel_code, contact_name, email FROM clients WHERE id = $1', [id])).rows[0];
    if (!client) throw new Refused(404, ['no such client']);
    if (!mailer) throw new Refused(503, ['email is not set up on the server yet (MAIL_URL): print the statement or save it as PDF instead']);
    const s = await statementOf(c, id, from, to);
    const { prof, head, foot, pics } = await letterheadForMail(c);
    const html = `<div style="max-width:700px;font:14px Arial;color:#111"><style>${ST.STATEMENT_CSS}</style>${head}
${b.message ? `<p style="padding:0 24px">${esc(b.message).replace(/\n/g, '<br>')}</p>` : ''}${ST.statementHtml(s, client, prof)}<hr style="border:0;border-top:1px solid #ddd;margin:16px 0">${foot}</div>`;
    const text = [`Statement for ${client.name}`, s.from ? `${s.from} to ${s.to}` : `To ${s.to}`, b.message ?? '',
      ...s.lines.map(l => `${l.date}  ${l.ref}  ${l.description}  ${l.debitCents ? D.rand(l.debitCents) : ''}${l.creditCents ? `-${D.rand(l.creditCents)}` : ''}  ${D.rand(l.balanceCents)}`),
      `Balance due: ${D.rand(s.closing)}`, `Current ${D.rand(s.ages.current)} · 30 days ${D.rand(s.ages.d30)} · 60 days ${D.rand(s.ages.d60)} · 90 days ${D.rand(s.ages.d90)} · 120 days + ${D.rand(s.ages.d120)}`,
      prof.bank_details ? `Banking details: ${prof.bank_details}` : ''].filter(Boolean).join('\n');
    let ok = true, error: string | null = null;
    try {
      await mailer({ to: b.to, replyTo: prof.email || null, fromName: prof.trading_name || prof.legal_name || null, subject: `Statement: ${client.name}, balance ${D.rand(s.closing)}`, html, text, pictures: pics });
    } catch (e) { ok = false; error = (e as Error).message.slice(0, 300); }
    await c.query('INSERT INTO statement_emails (client_id, sent_to, period_from, period_to, balance_cents, sent_by, ok, error) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [id, b.to, from, to, s.closing, req.actor.id, ok, error]);
    await audit(c, req.actor.id, 'statement_emailed', 'client', id, { to: b.to, from, upTo: to, balance: s.closing, ok });
    if (!ok) throw new Refused(502, [`the email did not go: ${error}`]);
    return { ok: true, to: b.to, balance: s.closing };
  });
}
