// Quotes and invoices, the company's details for its letterhead, and the rates. Prepared by the
// office (whoever the CEO gave quotes and invoices), priced from the CEO's rates and the price list.
// A draft can be changed freely; once sent it is locked and only its status moves on.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Q } from '../db.ts';
import { audit, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as D from '../core/documents.ts';
import * as Jc from '../core/jobCard.ts';
import { NO_CHARGE_REASONS, type NoChargeReason } from '../core/jobOutcome.ts';
import { DateOnly, Refused, Uuid, parse } from '../http.ts';
import { loadCard } from '../jobsRepo.ts';
import { notify } from './field.ts';
import { priceRulesForJob, travelForJob } from './clientRates.ts';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const Line = z.object({
  kind: z.enum(['labour', 'call_out', 'travel', 'stock', 'bought_out', 'other']),
  description: z.string().trim().max(300),
  qty: z.number().min(0).max(100000),
  unitPriceCents: z.number().int().min(0).max(1_000_000_000),
  stockItemId: Uuid.nullish(),
  workItemId: Uuid.nullish(),
});
type LineT = z.infer<typeof Line>;

async function rates(c: Q): Promise<Record<string, number>> {
  const { rows } = await c.query('SELECT key, amount_cents FROM rates');
  return Object.fromEntries(rows.map(r => [r.key, Number(r.amount_cents)]));
}

async function profile(c: Q) {
  return (await c.query('SELECT * FROM company_profile')).rows[0] ?? null;
}

async function linesOf(c: Q, col: 'quote_id' | 'invoice_id', id: string) {
  const { rows } = await c.query(
    `SELECT id, kind, description, qty::float AS qty, unit_price_cents AS "unitPriceCents", stock_item_id AS "stockItemId", work_item_id AS "workItemId"
       FROM document_lines WHERE ${col} = $1 ORDER BY position, id`, [id]);
  return rows as (D.DocLine & { id: string })[];
}

async function writeLines(c: Q, col: 'quote_id' | 'invoice_id', id: string, lines: LineT[]) {
  await c.query(`DELETE FROM document_lines WHERE ${col} = $1`, [id]);
  let pos = 0;
  for (const l of lines) {
    if (!(l.qty > 0)) continue;
    await c.query(
      `INSERT INTO document_lines (${col}, kind, description, qty, unit_price_cents, stock_item_id, work_item_id, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, l.kind, l.description, l.qty, l.unitPriceCents, l.stockItemId ?? null, l.workItemId ?? null, pos++]);
  }
}

/** Who the document is for: the store and its client, from the job or the store itself. */
const WHO = `s.name AS store, s.address AS store_address, c.name AS client, s.email AS store_email`;

export function registerDocumentRoutes(app: FastifyInstance) {
  const see = (req: FastifyRequest) => { if (!can(req.actor, 'view_quotes_invoices_stock') && !can(req.actor, 'prepare_quotes_invoices')) throw new Refused(403, ['quotes and invoices are not part of your work']); };
  const prep = (req: FastifyRequest) => { if (!can(req.actor, 'prepare_quotes_invoices')) throw new Refused(403, ['you cannot prepare quotes and invoices']); };

  // ---- Quotes from technicians --------------------------------------------------------------------
  // A technician quotes on one of his jobs that is not finished, or from scratch for a store with a
  // job card linked for reference. He picks the work and the parts; prices come from the price list
  // (bought-out items at his estimate). It goes to the office as a draft to check, price and send.
  const quoter = (req: FastifyRequest) => { if (!can(req.actor, 'create_estimate')) throw new Refused(403, ['quotes from site are for technicians']); };
  const myJobs = async (c: Q, userId: string) => (await c.query(
    `SELECT j.id, j.job_number, j.status, s.name AS store, j.fault_reported, to_char(j.scheduled_date, 'YYYY-MM-DD') AS scheduled_date
       FROM jobs j JOIN stores s ON s.id = j.store_id
      WHERE (j.lead_technician_id = $1 OR EXISTS (SELECT 1 FROM job_helpers h WHERE h.job_id = j.id AND h.user_id = $1)) AND j.status <> 'cancelled'
        AND (j.status <> 'closed' OR j.scheduled_date > current_date - 120)
      ORDER BY (j.status = 'closed'), j.scheduled_date DESC LIMIT 60`, [userId])).rows as { id: string; job_number: number; status: string; store: string }[];

  app.get('/me/quote-options', async req => {
    quoter(req);
    const stores = (await req.db.query('SELECT s.id, s.name, s.address, c.name AS client FROM stores s JOIN clients c ON c.id = s.client_id ORDER BY c.name, s.name')).rows;
    const jobs = (await myJobs(req.db, req.actor.id)).map(j => ({ ...j, open: j.status !== 'closed' }));
    return { stores, jobs };
  });

  app.get('/me/quotes', async req => {
    quoter(req);
    const { rows } = await req.db.query(
      `SELECT q.id, q.quote_number, q.status, q.title, q.created_at, j.job_number, rf.job_number AS reference_job_number, s.name AS store,
              (SELECT coalesce(sum(round(l.qty * l.unit_price_cents)), 0)::bigint FROM document_lines l WHERE l.quote_id = q.id) AS ex_vat_cents
         FROM quotes q LEFT JOIN jobs j ON j.id = q.job_id LEFT JOIN jobs rf ON rf.id = q.reference_job_id JOIN stores s ON s.id = coalesce(q.store_id, j.store_id)
        WHERE q.created_by = $1 AND q.from_technician ORDER BY q.created_at DESC LIMIT 50`, [req.actor.id]);
    return rows.map(r => ({ ...r, ex_vat_cents: Number(r.ex_vat_cents) }));
  });

  app.post('/me/quotes', async (req, reply) => {
    quoter(req);
    const b = parse(z.object({
      jobId: Uuid.optional(), storeId: Uuid.optional(), referenceJobId: Uuid.optional(),
      title: z.string().trim().min(3, 'what the quote is for').max(300), notes: z.string().trim().max(2000).optional(),
      labourHours: z.number().min(0).max(500).default(0),
      stockLines: z.array(z.object({ stockItemId: Uuid, qty: z.number().positive().max(10000) })).max(100).default([]),
      boughtOutLines: z.array(z.object({ description: z.string().trim().min(2).max(300), qty: z.number().positive().max(10000), estimatedPriceCents: z.number().int().min(0).max(1_000_000_000).default(0) })).max(100).default([]),
    }).refine(x => x.jobId || x.storeId, 'the job, or the store it is for'), req.body);
    if (!b.labourHours && !b.stockLines.length && !b.boughtOutLines.length) throw new Refused(400, ['add the work: labour hours, parts or items to buy']);
    const out = await tx(req.db, async c => {
      const mine = await myJobs(c, req.actor.id);
      let storeId = b.storeId ?? null;
      if (b.jobId) {
        const j = mine.find(x => x.id === b.jobId);
        if (!j) throw new Refused(403, ['you are not on that job']);
        if (j.status === 'closed') throw new Refused(409, ['that job is finished: start a new quote and link the job card for reference']);
        storeId = null;
      } else if (!(await c.query('SELECT 1 FROM stores WHERE id = $1', [storeId])).rowCount) throw new Refused(400, ['unknown store']);
      if (b.referenceJobId && !mine.some(x => x.id === b.referenceJobId)) throw new Refused(403, ['link one of your own job cards']);
      const r = await rates(c);
      const lines: LineT[] = [];
      if (b.labourHours) lines.push({ kind: 'labour', description: 'Labour', qty: b.labourHours, unitPriceCents: r.labour_per_hour ?? 0 });
      for (const l of b.stockLines) {
        const it = (await c.query('SELECT description, selling_price_cents, category FROM stock_items WHERE id = $1 AND active', [l.stockItemId])).rows[0];
        if (!it) throw new Refused(400, ['unknown part']);
        lines.push({ kind: 'stock', description: it.description, qty: l.qty, unitPriceCents: it.selling_price_cents ?? 0, stockItemId: l.stockItemId });
      }
      for (const l of b.boughtOutLines) lines.push({ kind: 'bought_out', description: l.description, qty: l.qty, unitPriceCents: l.estimatedPriceCents });
      const p = await profile(c);
      const q = (await c.query(
        `INSERT INTO quotes (job_id, store_id, title, notes, created_by, vat_pct, from_technician, reference_job_id) VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING id, quote_number`,
        [b.jobId ?? null, storeId, b.title, b.notes ?? null, req.actor.id, p?.vat_pct ?? 15, b.jobId ? null : b.referenceJobId ?? null])).rows[0];
      await writeLines(c, 'quote_id', q.id, lines);
      await audit(c, req.actor.id, 'quote_submitted', 'quote', q.id, { number: q.quote_number, jobId: b.jobId ?? null, referenceJobId: b.referenceJobId ?? null });
      const who = (await c.query('SELECT full_name FROM users WHERE id = $1', [req.actor.id])).rows[0].full_name;
      for (const o of (await c.query("SELECT id FROM users WHERE login_level IN ('admin', 'accounts', 'director', 'creator') AND status <> 'left'")).rows) {
        await notify(c, o.id, 'quote_submitted', `${who} submitted quote ${q.quote_number}: ${b.title}. Check it, price it and send it.`, { quoteId: q.id });
      }
      return { id: q.id, quoteNumber: q.quote_number, unpriced: lines.filter(l => !l.unitPriceCents).map(l => l.description) };
    });
    return reply.code(201).send(out);
  });

  // ---- The company's details and rates (the CEO) ----------------------------------------------

  // The company's name and logo for the app's header and letterheads: every signed-in person.
  app.get('/company/brand', async req => {
    const p = (await req.db.query('SELECT legal_name, trading_name, logo_photo_id FROM company_profile')).rows[0];
    const c = (await req.db.query('SELECT name FROM companies WHERE id = current_company()')).rows[0];
    const t = (await req.db.query('SELECT accent FROM company_theme')).rows[0];
    return { name: p?.trading_name || p?.legal_name || c?.name || '', logoPhotoId: p?.logo_photo_id ?? null, accent: t?.accent ?? 'orange',
      canTheme: ['director', 'creator'].includes(req.actor.level) };
  });

  // The director (CEO) picks the company's colour theme; everyone's app shows it.
  app.put('/company/theme', async req => {
    if (!['director', 'creator'].includes(req.actor.level)) throw new Refused(403, ['only the director chooses the colour theme']);
    const b = parse(z.object({ accent: z.enum(['orange', 'blue', 'green']) }), req.body);
    return tx(req.db, async c => {
      await c.query(`INSERT INTO company_theme (accent, updated_by) VALUES ($1, $2)
                     ON CONFLICT (company_id) DO UPDATE SET accent = EXCLUDED.accent, updated_by = EXCLUDED.updated_by, updated_at = now()`, [b.accent, req.actor.id]);
      await audit(c, req.actor.id, 'theme_changed', 'company', null, b);
      return b;
    });
  });

  app.get('/office/company', async req => {
    see(req);
    return { profile: await profile(req.db), rates: await rates(req.db), rateKeys: D.RATE_KEYS.map(k => ({ key: k, label: D.RATE_LABEL[k] })) };
  });

  app.put('/office/company', async req => {
    if (!can(req.actor, 'set_prices')) throw new Refused(403, ['only the CEO (prices and rates) sets the company details']);
    const b = parse(z.object({
      legalName: z.string().trim().min(2).max(200), tradingName: z.string().trim().max(200).nullish(), regNo: z.string().trim().max(50).nullish(),
      vatNo: z.string().trim().max(50).nullish(), address: z.string().trim().max(500).nullish(), phone: z.string().trim().max(50).nullish(),
      email: z.string().trim().email().max(200).nullish().or(z.literal('')), bankDetails: z.string().trim().max(500).nullish(),
      quoteTerms: z.string().trim().max(2000).nullish(), invoiceTerms: z.string().trim().max(2000).nullish(),
      vatPct: z.number().min(0).max(30).default(15), quoteValidDays: z.number().int().min(1).max(365).default(30), invoiceDueDays: z.number().int().min(0).max(365).default(30),
      logoPhotoId: Uuid.nullish(),
    }), req.body);
    if (b.logoPhotoId && !(await req.db.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'logo'", [b.logoPhotoId])).rowCount) throw new Refused(409, ['upload the logo first']);
    await req.db.query(
      `INSERT INTO company_profile (legal_name, trading_name, reg_no, vat_no, address, phone, email, bank_details, quote_terms, invoice_terms, vat_pct, quote_valid_days, invoice_due_days, logo_photo_id, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (company_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, trading_name = EXCLUDED.trading_name, reg_no = EXCLUDED.reg_no, vat_no = EXCLUDED.vat_no,
         address = EXCLUDED.address, phone = EXCLUDED.phone, email = EXCLUDED.email, bank_details = EXCLUDED.bank_details, quote_terms = EXCLUDED.quote_terms,
         invoice_terms = EXCLUDED.invoice_terms, vat_pct = EXCLUDED.vat_pct, quote_valid_days = EXCLUDED.quote_valid_days, invoice_due_days = EXCLUDED.invoice_due_days,
         logo_photo_id = COALESCE(EXCLUDED.logo_photo_id, company_profile.logo_photo_id), updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [b.legalName, b.tradingName ?? null, b.regNo ?? null, b.vatNo ?? null, b.address ?? null, b.phone ?? null, b.email || null, b.bankDetails ?? null,
       b.quoteTerms ?? null, b.invoiceTerms ?? null, b.vatPct, b.quoteValidDays, b.invoiceDueDays, b.logoPhotoId ?? null, req.actor.id]);
    await audit(req.db, req.actor.id, 'company_profile', 'company', null, b);
    return { profile: await profile(req.db) };
  });

  app.put('/office/rates', async req => {
    if (!can(req.actor, 'set_prices')) throw new Refused(403, ['only the CEO sets rates']);
    const b = parse(z.object(Object.fromEntries(D.RATE_KEYS.map(k => [k, z.number().int().min(0).max(100_000_000).optional()]))), req.body) as Record<string, number | undefined>;
    return tx(req.db, async c => {
      const old = await rates(c);
      for (const [key, cents] of Object.entries(b)) {
        if (cents === undefined || old[key] === cents) continue;
        await c.query(`INSERT INTO rates (key, amount_cents, updated_by) VALUES ($1, $2, $3)
                       ON CONFLICT (company_id, key) DO UPDATE SET amount_cents = EXCLUDED.amount_cents, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, cents, req.actor.id]);
        await c.query('INSERT INTO price_changes (what, old_cents, new_cents, changed_by) VALUES ($1, $2, $3, $4)', [`rate:${key}`, old[key] ?? null, cents, req.actor.id]);
      }
      return { rates: await rates(c) };
    });
  });

  // ---- Quotes ----------------------------------------------------------------------------

  app.get('/quotes', async (req: FastifyRequest<{ Querystring: { status?: string } }>) => {
    see(req);
    const { rows } = await req.db.query(
      `SELECT q.id, q.quote_number, q.status, q.title, q.created_at, q.sent_at, to_char(q.valid_until, 'YYYY-MM-DD') AS valid_until, q.accepted_at, q.declined_at,
              q.vat_pct::float AS vat_pct, j.job_number, j.id AS job_id, ${WHO}, u.full_name AS created_by, q.from_technician, rf.job_number AS reference_job_number,
              (SELECT coalesce(sum(round(l.qty * l.unit_price_cents)), 0)::bigint FROM document_lines l WHERE l.quote_id = q.id) AS ex_vat_cents
         FROM quotes q LEFT JOIN jobs j ON j.id = q.job_id JOIN stores s ON s.id = coalesce(q.store_id, j.store_id) JOIN clients c ON c.id = s.client_id
         JOIN users u ON u.id = q.created_by LEFT JOIN jobs rf ON rf.id = q.reference_job_id
        WHERE ($1::text IS NULL OR q.status::text = $1) ORDER BY (q.status = 'draft') DESC, q.quote_number DESC LIMIT 500`, [req.query.status ?? null]);
    return rows.map(r => ({ ...r, ex_vat_cents: Number(r.ex_vat_cents), total_cents: D.totals([{ qty: 1, unitPriceCents: Number(r.ex_vat_cents) }], r.vat_pct).totalCents }));
  });

  app.get('/quotes/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    see(req);
    const id = parse(Uuid, req.params.id);
    const q = (await req.db.query(
      `SELECT q.*, to_char(q.valid_until, 'YYYY-MM-DD') AS valid_until, q.vat_pct::float AS vat_pct, j.job_number, ${WHO}, u.full_name AS created_by_name, rj.job_number AS resulting_job_number, rf.job_number AS reference_job_number
         FROM quotes q LEFT JOIN jobs j ON j.id = q.job_id JOIN stores s ON s.id = coalesce(q.store_id, j.store_id) JOIN clients c ON c.id = s.client_id
         JOIN users u ON u.id = q.created_by LEFT JOIN jobs rj ON rj.id = q.resulting_job_id LEFT JOIN jobs rf ON rf.id = q.reference_job_id WHERE q.id = $1`, [id])).rows[0];
    if (!q) throw new Refused(404, ['no such quote']);
    const lines = await linesOf(req.db, 'quote_id', id);
    return { quote: q, lines, totals: D.totals(lines, q.vat_pct), company: await profile(req.db) };
  });

  app.post('/quotes', async (req, reply) => {
    prep(req);
    const b = parse(z.object({
      jobId: Uuid.optional(), storeId: Uuid.optional(), title: z.string().trim().min(3, 'what the quote is for').max(300),
      clientRef: z.string().trim().max(100).optional(), notes: z.string().trim().max(2000).optional(), fromEstimateId: Uuid.optional(), lines: z.array(Line).max(200).default([]),
    }).refine(x => x.jobId || x.storeId, 'a job or a store'), req.body);
    const out = await tx(req.db, async c => {
      if (b.jobId && !(await c.query('SELECT 1 FROM jobs WHERE id = $1', [b.jobId])).rowCount) throw new Refused(400, ['unknown job']);
      if (b.storeId && !(await c.query('SELECT 1 FROM stores WHERE id = $1', [b.storeId])).rowCount) throw new Refused(400, ['unknown store']);
      const p = await profile(c);
      const q = (await c.query(
        `INSERT INTO quotes (job_id, store_id, title, client_ref, notes, from_estimate_id, created_by, vat_pct) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, quote_number`,
        [b.jobId ?? null, b.jobId ? null : b.storeId, b.title, b.clientRef ?? null, b.notes ?? null, b.fromEstimateId ?? null, req.actor.id, p?.vat_pct ?? 15])).rows[0];
      let lines = b.lines;
      // Start from the technician's on-site estimate: same items and quantities, office prices.
      if (b.fromEstimateId && !lines.length) {
        const e = (await c.query('SELECT labour_hours::float AS h, lines FROM estimates WHERE id = $1', [b.fromEstimateId])).rows[0];
        if (!e) throw new Refused(400, ['unknown estimate']);
        const r = await rates(c);
        lines = [
          ...(e.h > 0 ? [{ kind: 'labour' as const, description: 'Labour', qty: e.h, unitPriceCents: r.labour_per_hour ?? 0 }] : []),
          ...(e.lines as { description?: string; code?: string; qty: number; unitPriceCents: number; boughtOut?: boolean; stockItemId?: string }[]).map(l => ({
            kind: (l.boughtOut ? 'bought_out' : 'stock') as LineT['kind'], description: l.description ?? l.code ?? 'Item', qty: l.qty, unitPriceCents: l.unitPriceCents, stockItemId: l.stockItemId ?? null,
          })),
        ];
      }
      await writeLines(c, 'quote_id', q.id, lines);
      await audit(c, req.actor.id, 'quote_created', 'quote', q.id, { number: q.quote_number });
      return { id: q.id, quoteNumber: q.quote_number };
    });
    return reply.code(201).send(out);
  });

  app.put('/quotes/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    prep(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ title: z.string().trim().min(3).max(300), clientRef: z.string().trim().max(100).nullish(), notes: z.string().trim().max(2000).nullish(), lines: z.array(Line).max(200) }), req.body);
    return tx(req.db, async c => {
      const q = (await c.query('SELECT status FROM quotes WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!q) throw new Refused(404, ['no such quote']);
      if (q.status !== 'draft') throw new Refused(409, ['a sent quote cannot be changed: make a new one']);
      await c.query('UPDATE quotes SET title = $2, client_ref = $3, notes = $4, updated_at = now() WHERE id = $1', [id, b.title, b.clientRef ?? null, b.notes ?? null]);
      await writeLines(c, 'quote_id', id, b.lines);
      return { id };
    });
  });

  app.post('/quotes/:id/send', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    prep(req);
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const q = (await c.query('SELECT status, quote_number FROM quotes WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!q) throw new Refused(404, ['no such quote']);
      if (q.status !== 'draft') throw new Refused(409, ['already sent']);
      const missing = D.missingToSend({ lines: await linesOf(c, 'quote_id', id) });
      if (!(await profile(c))) missing.push("the company's details (CEO: Accounts, Company details and rates)");
      if (missing.length) throw new Refused(409, missing);
      const days = (await profile(c)).quote_valid_days;
      await c.query("UPDATE quotes SET status = 'sent', sent_at = now(), valid_until = $2, updated_at = now() WHERE id = $1", [id, addDays(today(), days)]);
      await audit(c, req.actor.id, 'quote_sent', 'quote', id);
      return { id, status: 'sent' };
    });
  });

  /** The client said yes: optionally open the job to do the work straight away. */
  app.post('/quotes/:id/accept', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    prep(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({
      note: z.string().trim().max(500).optional(), clientRef: z.string().trim().max(100).optional(),
      newJob: z.object({ scheduledDate: DateOnly, leadTechnicianId: Uuid, priority: z.enum(['urgent', 'normal', 'scheduled']).default('scheduled') }).optional(),
    }), req.body);
    return tx(req.db, async c => {
      const q = (await c.query(
        'SELECT q.status, q.quote_number, q.title, q.client_ref, coalesce(q.store_id, j.store_id) AS store_id FROM quotes q LEFT JOIN jobs j ON j.id = q.job_id WHERE q.id = $1 FOR UPDATE OF q', [id])).rows[0];
      if (!q) throw new Refused(404, ['no such quote']);
      if (q.status !== 'sent') throw new Refused(409, ['only a sent quote can be accepted']);
      let jobId: string | null = null;
      let jobNumber: number | null = null;
      if (b.newJob) {
        if (!can(req.actor, 'assign_jobs')) throw new Refused(403, ['you cannot open jobs: accept it without a job and ask whoever does']);
        const t = (await c.query("SELECT 1 FROM users WHERE id = $1 AND login_level = 'technician' AND status = 'active'", [b.newJob.leadTechnicianId])).rowCount;
        if (!t) throw new Refused(400, ['lead technician must be an active technician']);
        const j = (await c.query(
          `INSERT INTO jobs (job_type, priority, store_id, client_order_ref, fault_reported, scheduled_date, lead_technician_id, created_by)
           VALUES ('follow_up', $1, $2, $3, $4, $5, $6, $7) RETURNING id, job_number`,
          [b.newJob.priority, q.store_id, b.clientRef ?? q.client_ref ?? null, `Quote ${q.quote_number} accepted: ${q.title}`, b.newJob.scheduledDate, b.newJob.leadTechnicianId, req.actor.id])).rows[0];
        await c.query("INSERT INTO work_items (job_id, title, origin) VALUES ($1, $2, 'reported')", [j.id, `Quote ${q.quote_number}: ${q.title}`.slice(0, 200)]);
        await notify(c, b.newJob.leadTechnicianId, 'job_assigned', `New job ${j.job_number}: quote ${q.quote_number} accepted (${q.title})`, { jobId: j.id });
        jobId = j.id; jobNumber = j.job_number;
      }
      await c.query("UPDATE quotes SET status = 'accepted', accepted_at = now(), decision_note = $2, resulting_job_id = $3, updated_at = now() WHERE id = $1", [id, b.note ?? null, jobId]);
      await audit(c, req.actor.id, 'quote_accepted', 'quote', id, { jobId });
      return { id, status: 'accepted', jobId, jobNumber };
    });
  });

  app.post('/quotes/:id/decline', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    prep(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ note: z.string().trim().min(3, 'what the client said').max(500) }), req.body);
    const r = await req.db.query("UPDATE quotes SET status = 'declined', declined_at = now(), decision_note = $2, updated_at = now() WHERE id = $1 AND status = 'sent' RETURNING id", [id, b.note]);
    if (!r.rowCount) throw new Refused(409, ['only a sent quote can be declined']);
    return { id, status: 'declined' };
  });

  /** A draft is thrown away; a sent quote is marked cancelled. */
  app.post('/quotes/:id/cancel', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    prep(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ note: z.string().trim().min(3).max(500) }), req.body);
    return tx(req.db, async c => {
      const q = (await c.query('SELECT status FROM quotes WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!q) throw new Refused(404, ['no such quote']);
      if (q.status === 'draft') {
        await c.query('DELETE FROM document_lines WHERE quote_id = $1', [id]);
        await c.query('DELETE FROM quotes WHERE id = $1', [id]);
        await audit(c, req.actor.id, 'quote_deleted', 'quote', id, b);
        return { id, status: 'deleted' };
      }
      if (q.status !== 'sent') throw new Refused(409, [`the quote is ${q.status}`]);
      await c.query("UPDATE quotes SET status = 'cancelled', decision_note = $2, updated_at = now() WHERE id = $1", [id, b.note]);
      return { id, status: 'cancelled' };
    });
  });

  // ---- Invoices ------------------------------------------------------------------------------

  // Closed at no charge: a warranty job, a callback on our own work, goodwill, covered by a contract, no
  // fault found. It leaves the "to invoice" list and shows as "no charge" on the job card. Taken off
  // again if it must be invoiced after all.
  app.post('/jobs/:id/no-charge', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    prep(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ reason: z.enum(Object.keys(NO_CHARGE_REASONS) as [NoChargeReason, ...NoChargeReason[]]), note: z.string().trim().max(500).optional() }), req.body);
    if (b.reason === 'other' && (!b.note || b.note.length < 3)) throw new Refused(400, ['say why there is no charge']);
    return tx(req.db, async c => {
      const j = (await c.query('SELECT j.job_number, j.status, nc.reason AS no_charge_reason FROM jobs j LEFT JOIN job_no_charge nc ON nc.job_id = j.id WHERE j.id = $1', [id])).rows[0];
      if (!j) throw new Refused(404, ['no such job']);
      if (j.status !== 'closed') throw new Refused(409, [j.status === 'cancelled' ? 'the job is cancelled' : 'close the job first (the technician signs it off)']);
      const inv = (await c.query("SELECT invoice_number, status FROM invoices WHERE job_id = $1 AND status <> 'cancelled'", [id])).rows[0];
      if (inv) throw new Refused(409, [inv.status === 'draft' ? `cancel draft invoice ${inv.invoice_number} first` : `invoice ${inv.invoice_number} was sent: credit it instead`]);
      await c.query(`INSERT INTO job_no_charge (job_id, reason, note, decided_by) VALUES ($1, $2, $3, $4)
                     ON CONFLICT (job_id) DO UPDATE SET reason = $2, note = $3, decided_by = $4, decided_at = now()`, [id, b.reason, b.note || null, req.actor.id]);
      await c.query('INSERT INTO job_changes (job_id, field, old_value, new_value, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, 'billing', j.no_charge_reason ? `no charge (${NO_CHARGE_REASONS[j.no_charge_reason as NoChargeReason]})` : 'to invoice', `no charge (${NO_CHARGE_REASONS[b.reason]})`, b.note || null, req.actor.id]);
      await audit(c, req.actor.id, 'job_no_charge', 'job', id, b);
      return { id, noChargeReason: b.reason };
    });
  });

  app.delete('/jobs/:id/no-charge', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    prep(req);
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const j = (await c.query('SELECT reason AS no_charge_reason FROM job_no_charge WHERE job_id = $1 FOR UPDATE', [id])).rows[0];
      if (!j?.no_charge_reason) throw new Refused(409, ['this job is not marked no charge']);
      await c.query('DELETE FROM job_no_charge WHERE job_id = $1', [id]);
      await c.query('INSERT INTO job_changes (job_id, field, old_value, new_value, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, 'billing', `no charge (${NO_CHARGE_REASONS[j.no_charge_reason as NoChargeReason]})`, 'to invoice', null, req.actor.id]);
      await audit(c, req.actor.id, 'job_charge_again', 'job', id);
      return { id, noChargeReason: null };
    });
  });

  /** Closed jobs with no invoice yet (not those closed at no charge). */
  app.get('/office/to-invoice', async req => {
    see(req);
    const { rows } = await req.db.query(
      `SELECT j.id, j.job_number, j.job_type, j.closed_at, j.fault_reported, j.client_order_ref, ${WHO}, u.full_name AS lead_technician
         FROM jobs j JOIN stores s ON s.id = j.store_id JOIN clients c ON c.id = s.client_id JOIN users u ON u.id = j.lead_technician_id
        WHERE j.status = 'closed' AND NOT EXISTS (SELECT 1 FROM job_no_charge nc WHERE nc.job_id = j.id) AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status <> 'cancelled')
        ORDER BY j.closed_at`);
    return rows;
  });

  app.get('/invoices', async (req: FastifyRequest<{ Querystring: { status?: string } }>) => {
    see(req);
    const { rows } = await req.db.query(
      `SELECT i.id, i.invoice_number, i.status, i.created_at, i.sent_at, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.paid_at, i.vat_pct::float AS vat_pct,
              j.job_number, j.id AS job_id, ${WHO}, u.full_name AS created_by,
              (SELECT coalesce(sum(round(l.qty * l.unit_price_cents)), 0)::bigint FROM document_lines l WHERE l.invoice_id = i.id) AS ex_vat_cents,
              (SELECT coalesce(sum(cn.amount_cents), 0)::bigint FROM credit_notes cn WHERE cn.invoice_id = i.id) AS credited_cents
         FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN stores s ON s.id = j.store_id JOIN clients c ON c.id = s.client_id JOIN users u ON u.id = i.created_by
        WHERE ($1::text IS NULL OR i.status::text = $1) ORDER BY (i.status = 'draft') DESC, i.invoice_number DESC LIMIT 500`, [req.query.status ?? null]);
    return rows.map(r => {
      const ex = Number(r.ex_vat_cents);
      return { ...r, ex_vat_cents: ex, credited_cents: Number(r.credited_cents), total_cents: D.totals([{ qty: 1, unitPriceCents: ex }], r.vat_pct).totalCents, overdue: r.status === 'sent' && r.due_date && r.due_date < today() };
    });
  });

  app.get('/invoices/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    see(req);
    const id = parse(Uuid, req.params.id);
    const i = (await req.db.query(
      `SELECT i.*, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.vat_pct::float AS vat_pct, j.job_number, j.client_order_ref AS job_order_ref, j.fault_reported,
              to_char(j.closed_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS job_closed, ${WHO}, u.full_name AS created_by_name
         FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN stores s ON s.id = j.store_id JOIN clients c ON c.id = s.client_id JOIN users u ON u.id = i.created_by
        WHERE i.id = $1`, [id])).rows[0];
    if (!i) throw new Refused(404, ['no such invoice']);
    const lines = await linesOf(req.db, 'invoice_id', id);
    const credits = (await req.db.query(
      `SELECT cn.id, cn.credit_number, cn.amount_cents::bigint AS amount_cents, cn.vat_pct::float AS vat_pct, cn.reason, cn.created_at, u.full_name AS created_by
         FROM credit_notes cn JOIN users u ON u.id = cn.created_by WHERE cn.invoice_id = $1 ORDER BY cn.credit_number`, [id])).rows
      .map(r => ({ ...r, amount_cents: Number(r.amount_cents), total_cents: D.totals([{ qty: 1, unitPriceCents: Number(r.amount_cents) }], r.vat_pct).totalCents }));
    return { invoice: i, lines, totals: D.totals(lines, i.vat_pct), credits, company: await profile(req.db) };
  });

  // A credit note against an invoice already sent or paid: in full, or part of it (excluding VAT),
  // with the reason. The invoice itself never changes; together they never credit more than it was.
  app.post('/invoices/:id/credit', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    prep(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ amountCents: z.number().int().positive().optional(), reason: z.string().trim().min(5, 'say why it is credited').max(500) }), req.body);
    const out = await tx(req.db, async c => {
      const i = (await c.query('SELECT status, job_id, invoice_number, vat_pct::float AS vat_pct FROM invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!i) throw new Refused(404, ['no such invoice']);
      if (!['sent', 'paid'].includes(i.status)) throw new Refused(409, [i.status === 'draft' ? 'a draft invoice is changed or deleted, not credited' : `the invoice is ${i.status}`]);
      const ex = Number((await c.query('SELECT coalesce(sum(round(qty * unit_price_cents)), 0)::bigint AS n FROM document_lines WHERE invoice_id = $1', [id])).rows[0].n);
      const done = Number((await c.query('SELECT coalesce(sum(amount_cents), 0)::bigint AS n FROM credit_notes WHERE invoice_id = $1', [id])).rows[0].n);
      const left = ex - done;
      if (left <= 0) throw new Refused(409, [`invoice ${i.invoice_number} is already credited in full`]);
      const amount = b.amountCents ?? left;
      if (amount > left) throw new Refused(409, [`at most R ${(left / 100).toFixed(2)} (excl. VAT) is left to credit on invoice ${i.invoice_number}`]);
      const cn = (await c.query('INSERT INTO credit_notes (invoice_id, job_id, amount_cents, vat_pct, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, credit_number',
        [id, i.job_id, amount, i.vat_pct, b.reason, req.actor.id])).rows[0];
      await audit(c, req.actor.id, 'invoice_credited', 'invoice', id, { creditNumber: cn.credit_number, amountCents: amount });
      return { id: cn.id, creditNumber: cn.credit_number, amountCents: amount, full: amount === left && done === 0 };
    });
    return reply.code(201).send(out);
  });

  /** A draft invoice for a closed job, worked out from the job card: time on site, call-outs, parts used, items bought. */
  app.post('/invoices', async (req, reply) => {
    prep(req);
    const b = parse(z.object({ jobId: Uuid }), req.body);
    const out = await tx(req.db, async c => {
      const loaded = await loadCard(c, b.jobId, true);
      if (!loaded) throw new Refused(404, ['no such job']);
      const j = (await c.query('SELECT j.job_number, j.job_type, j.status, j.client_order_ref, nc.reason AS no_charge_reason FROM jobs j LEFT JOIN job_no_charge nc ON nc.job_id = j.id WHERE j.id = $1', [b.jobId])).rows[0];
      if (j?.no_charge_reason) throw new Refused(409, [`job ${j.job_number} was closed at no charge: take that off the job first if it must be invoiced`]);
      if (j.status !== 'closed') throw new Refused(409, ['only a closed job can be invoiced']);
      if ((await c.query("SELECT 1 FROM invoices WHERE job_id = $1 AND status <> 'cancelled'", [b.jobId])).rowCount) throw new Refused(409, ['this job already has an invoice']);
      const helpers = (await c.query('SELECT count(*)::int AS n FROM job_helpers WHERE job_id = $1', [b.jobId])).rows[0].n;
      const stockUsed = (await c.query(
        `SELECT m.stock_item_id AS "stockItemId", i.description, sum(m.qty)::float AS qty, i.selling_price_cents AS "sellingPriceCents", i.cost_cents AS "costCents"
           FROM stock_movements m JOIN stock_items i ON i.id = m.stock_item_id
          WHERE m.job_id = $1 AND m.kind = 'use_on_job' GROUP BY m.stock_item_id, i.description, i.selling_price_cents, i.cost_cents ORDER BY i.description`, [b.jobId])).rows;
      const boughtOut = (await c.query('SELECT description, qty::float AS qty, price_cents AS "costCents" FROM bought_out_items WHERE job_id = $1 ORDER BY description', [b.jobId])).rows;
      const lines = D.invoiceDraft({
        jobType: j.job_type, jobNumber: j.job_number, minutesOnSite: Jc.jobMinutes(loaded.card), technicians: 1 + helpers,
        visits: loaded.card.visits.length, stockUsed, boughtOut, travel: await travelForJob(c, b.jobId, loaded.card),
      }, await priceRulesForJob(c, b.jobId));
      const p = await profile(c);
      const inv = (await c.query(
        'INSERT INTO invoices (job_id, created_by, client_ref, vat_pct, due_date) VALUES ($1, $2, $3, $4, NULL) RETURNING id, invoice_number',
        [b.jobId, req.actor.id, j.client_order_ref ?? null, p?.vat_pct ?? 15])).rows[0];
      await writeLines(c, 'invoice_id', inv.id, lines);
      await audit(c, req.actor.id, 'invoice_drafted', 'invoice', inv.id, { jobId: b.jobId });
      return { id: inv.id, invoiceNumber: inv.invoice_number, missing: D.missingToSend({ lines }) };
    });
    return reply.code(201).send(out);
  });

  app.put('/invoices/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    prep(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ clientRef: z.string().trim().max(100).nullish(), notes: z.string().trim().max(2000).nullish(), lines: z.array(Line).max(200) }), req.body);
    return tx(req.db, async c => {
      const i = (await c.query('SELECT status FROM invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!i) throw new Refused(404, ['no such invoice']);
      if (i.status !== 'draft') throw new Refused(409, ['a sent invoice cannot be changed: cancel it and make a new one']);
      await c.query('UPDATE invoices SET client_ref = $2, notes = $3, updated_at = now() WHERE id = $1', [id, b.clientRef ?? null, b.notes ?? null]);
      await writeLines(c, 'invoice_id', id, b.lines);
      return { id };
    });
  });

  app.post('/invoices/:id/send', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    prep(req);
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const i = (await c.query('SELECT status FROM invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!i) throw new Refused(404, ['no such invoice']);
      if (i.status !== 'draft') throw new Refused(409, ['already sent']);
      const p = await profile(c);
      const missing = D.missingToSend({ lines: await linesOf(c, 'invoice_id', id) });
      if (!p) missing.push("the company's details (CEO: Accounts, Company details and rates)");
      if (missing.length) throw new Refused(409, missing);
      await c.query("UPDATE invoices SET status = 'sent', sent_at = now(), due_date = $2, updated_at = now() WHERE id = $1", [id, addDays(today(), p.invoice_due_days)]);
      await audit(c, req.actor.id, 'invoice_sent', 'invoice', id);
      return { id, status: 'sent' };
    });
  });

  app.post('/invoices/:id/paid', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    prep(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ ref: z.string().trim().min(2, 'the payment reference').max(100), paidOn: DateOnly.optional() }), req.body);
    const r = await req.db.query("UPDATE invoices SET status = 'paid', paid_at = $3::date, paid_ref = $2, updated_at = now() WHERE id = $1 AND status = 'sent' RETURNING id",
      [id, b.ref, b.paidOn ?? today()]);
    if (!r.rowCount) throw new Refused(409, ['only a sent invoice can be marked paid']);
    await audit(req.db, req.actor.id, 'invoice_paid', 'invoice', id, b);
    return { id, status: 'paid' };
  });

  /** A draft is thrown away; a sent invoice is cancelled (kept on record) so a corrected one can be made. */
  app.post('/invoices/:id/cancel', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    prep(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ note: z.string().trim().min(5, 'say why it is cancelled').max(500) }), req.body);
    return tx(req.db, async c => {
      const i = (await c.query('SELECT status FROM invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!i) throw new Refused(404, ['no such invoice']);
      if (i.status === 'draft') {
        await c.query('DELETE FROM document_lines WHERE invoice_id = $1', [id]);
        await c.query('DELETE FROM invoices WHERE id = $1', [id]);
        await audit(c, req.actor.id, 'invoice_deleted', 'invoice', id, b);
        return { id, status: 'deleted' };
      }
      if (i.status !== 'sent') throw new Refused(409, [`the invoice is ${i.status}`]);
      await c.query("UPDATE invoices SET status = 'cancelled', cancelled_at = now(), cancel_note = $2, updated_at = now() WHERE id = $1", [id, b.note]);
      await audit(c, req.actor.id, 'invoice_cancelled', 'invoice', id, b);
      return { id, status: 'cancelled' };
    });
  });
}
