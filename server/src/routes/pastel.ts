// Sending quotes and invoices to Sage Pastel Partner: the office downloads an import batch and
// imports it in Pastel (Process, Customers, Invoices or Quotations, then Import). Each document goes
// into one batch only, so nothing is imported twice.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Q } from '../db.ts';
import { audit, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as P from '../core/pastel.ts';
import { Refused, Uuid, parse } from '../http.ts';

const DEFAULTS: P.PastelSettings = { yearStartMonth: 3, taxType: '01', codes: {}, store: null };

export async function pastelSettings(c: Q): Promise<P.PastelSettings> {
  const r = (await c.query('SELECT year_start_month, tax_type, codes, store FROM pastel_settings')).rows[0];
  return r ? { yearStartMonth: r.year_start_month, taxType: r.tax_type, codes: r.codes ?? {}, store: r.store } : DEFAULTS;
}

type Kind = 'invoice' | 'quote';
const T = { invoice: { table: 'invoices', num: 'invoice_number', ready: "('sent', 'paid')", col: 'invoice_id' }, quote: { table: 'quotes', num: 'quote_number', ready: "('sent', 'accepted')", col: 'quote_id' } };

/** Documents of one kind as Pastel sees them. */
async function docs(c: Q, kind: Kind, where: string, params: unknown[]): Promise<(P.PastelDoc & { id: string; batchId: string | null; status: string })[]> {
  const t = T[kind];
  const { rows } = await c.query(
    `SELECT d.id, d.${t.num} AS number, d.status, d.pastel_batch_id, to_char(coalesce(d.sent_at, d.created_at) AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS date,
            to_char(${kind === 'invoice' ? 'd.due_date' : 'd.valid_until'}, 'YYYY-MM-DD') AS due, d.client_ref, d.notes,
            cl.pastel_code, s.name AS store, s.address, j.job_number
       FROM ${t.table} d ${kind === 'invoice' ? 'JOIN jobs j ON j.id = d.job_id' : 'LEFT JOIN jobs j ON j.id = d.job_id'}
       JOIN stores s ON s.id = ${kind === 'invoice' ? 'j.store_id' : 'coalesce(d.store_id, j.store_id)'} JOIN clients cl ON cl.id = s.client_id
      WHERE ${where} ORDER BY d.${t.num}`, params);
  const out = [];
  for (const r of rows) {
    const lines = (await c.query(
      `SELECT l.kind, l.description, l.qty::float AS qty, l.unit_price_cents AS "unitPriceCents", i.code AS "stockCode", i.unit
         FROM document_lines l LEFT JOIN stock_items i ON i.id = l.stock_item_id WHERE l.${t.col} = $1 ORDER BY l.position, l.id`, [r.id])).rows;
    out.push({
      id: r.id, batchId: r.pastel_batch_id, status: r.status, kind, number: r.number, customerCode: r.pastel_code, date: r.date, dueDate: r.due,
      orderNumber: r.client_ref, message: [r.job_number ? `Job ${r.job_number}` : null, r.notes].filter(Boolean).join('. ') || null,
      deliverTo: [r.store, ...(r.address ?? '').split(/,\s*/)], contact: null, lines,
    });
  }
  return out;
}

export function registerPastelRoutes(app: FastifyInstance) {
  const books = (req: FastifyRequest) => { if (!can(req.actor, 'prepare_quotes_invoices')) throw new Refused(403, ['quotes and invoices are not part of your work']); };

  app.get('/pastel/settings', async req => {
    books(req);
    return { settings: await pastelSettings(req.db), lineTypes: P.LINE_TYPE_LABEL };
  });

  app.put('/pastel/settings', async req => {
    books(req);
    const Code = z.object({ code: z.string().trim().min(1).max(15), lineType: z.union([z.literal(4), z.literal(6)]) });
    const b = parse(z.object({
      yearStartMonth: z.number().int().min(1).max(12), taxType: z.string().regex(/^[0-9]{2}$/, 'tax type is two digits, e.g. 01'),
      codes: z.object({ labour: Code.optional(), call_out: Code.optional(), travel: Code.optional(), bought_out: Code.optional(), other: Code.optional() }),
      store: z.string().trim().max(3).nullish(),
    }), req.body);
    await req.db.query(
      `INSERT INTO pastel_settings (year_start_month, tax_type, codes, store, updated_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id) DO UPDATE SET year_start_month = EXCLUDED.year_start_month, tax_type = EXCLUDED.tax_type, codes = EXCLUDED.codes,
         store = EXCLUDED.store, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [b.yearStartMonth, b.taxType, JSON.stringify(b.codes), b.store || null, req.actor.id]);
    await audit(req.db, req.actor.id, 'pastel_settings', 'company', null, b);
    return { settings: await pastelSettings(req.db) };
  });

  app.get('/pastel/clients', async req => {
    books(req);
    const { rows } = await req.db.query(
      `SELECT c.id, c.name, c.pastel_code, (SELECT count(*)::int FROM stores s WHERE s.client_id = c.id) AS stores FROM clients c ORDER BY c.name`);
    return rows;
  });

  app.put('/pastel/clients/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    books(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ code: z.string().trim().toUpperCase().max(6, 'Pastel customer codes are at most 6 characters').nullable() }), req.body);
    const clash = b.code ? (await req.db.query('SELECT name FROM clients WHERE upper(pastel_code) = $1 AND id <> $2', [b.code, id])).rows[0] : null;
    if (clash) throw new Refused(409, [`${b.code} is already ${clash.name}`]);
    const r = await req.db.query('UPDATE clients SET pastel_code = $2 WHERE id = $1 RETURNING id', [id, b.code || null]);
    if (!r.rowCount) throw new Refused(404, ['no such client']);
    return { id, code: b.code || null };
  });

  /** Sent documents not yet in Pastel, with anything that stops them going. */
  app.get('/pastel/ready', async (req: FastifyRequest<{ Querystring: { kind?: string } }>) => {
    books(req);
    const kind = parse(z.enum(['invoice', 'quote']).default('invoice'), req.query.kind);
    const s = await pastelSettings(req.db);
    const list = await docs(req.db, kind, `d.status IN ${T[kind].ready} AND d.pastel_batch_id IS NULL`, []);
    return list.map(d => ({ id: d.id, number: d.number, date: d.date, customerCode: d.customerCode, store: d.deliverTo[0], lines: d.lines.length, problems: P.missingForPastel(d, s) }));
  });

  /** A batch of every ready document without problems (or the ones chosen). */
  app.post('/pastel/batches', async (req, reply) => {
    books(req);
    const b = parse(z.object({ kind: z.enum(['invoice', 'quote']), ids: z.array(Uuid).max(500).optional() }), req.body);
    const out = await tx(req.db, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pastel:${b.kind}`]);
      const s = await pastelSettings(c);
      const t = T[b.kind];
      const all = await docs(c, b.kind, `d.status IN ${t.ready} AND d.pastel_batch_id IS NULL${b.ids ? ' AND d.id = ANY($1)' : ''}`, b.ids ? [b.ids] : []);
      const ok = all.filter(d => !P.missingForPastel(d, s).length);
      const skipped = all.filter(d => !ok.includes(d)).map(d => ({ number: d.number, reasons: P.missingForPastel(d, s) }));
      if (!ok.length) throw new Refused(409, skipped.length ? skipped.map(x => `${b.kind} ${x.number}: ${x.reasons.join('; ')}`) : [`no ${b.kind}s waiting to go to Pastel`]);
      const vat = Number((await c.query('SELECT vat_pct FROM company_profile')).rows[0]?.vat_pct ?? 15);
      const file = P.pastelFile(ok, s, vat);
      const batch = (await c.query('INSERT INTO pastel_batches (kind, numbers, file, created_by) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
        [b.kind, ok.map(d => d.number), file, req.actor.id])).rows[0];
      await c.query(`UPDATE ${t.table} SET pastel_batch_id = $2 WHERE id = ANY($1)`, [ok.map(d => d.id), batch.id]);
      await audit(c, req.actor.id, 'pastel_batch', 'pastel_batch', batch.id, { kind: b.kind, numbers: ok.map(d => d.number) });
      return { id: batch.id, kind: b.kind, numbers: ok.map(d => d.number), skipped, filename: `pastel-${b.kind}s-${batch.created_at.toISOString().slice(0, 10)}-${batch.id.slice(0, 6)}.csv`, file };
    });
    return reply.code(201).send(out);
  });

  app.get('/pastel/batches', async req => {
    books(req);
    const { rows } = await req.db.query(
      `SELECT b.id, b.kind, b.numbers, b.created_at, u.full_name AS created_by FROM pastel_batches b JOIN users u ON u.id = b.created_by ORDER BY b.created_at DESC LIMIT 100`);
    return rows;
  });

  /** The file again, e.g. if the import in Pastel failed. */
  app.get('/pastel/batches/:id/file', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    books(req);
    const id = parse(Uuid, req.params.id);
    const r = (await req.db.query('SELECT kind, file, created_at FROM pastel_batches WHERE id = $1', [id])).rows[0];
    if (!r) throw new Refused(404, ['no such batch']);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="pastel-${r.kind}s-${r.created_at.toISOString().slice(0, 10)}-${id.slice(0, 6)}.csv"`);
    return r.file;
  });
}
