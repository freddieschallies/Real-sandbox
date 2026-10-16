// The history (db/072_history.sql): every change to the company's records, who made it and when,
// kept for good for in case of fraud. Only the Creator (the CEO) reads it; nobody can change or
// delete it, and the check shows whether anything was ever taken out or altered behind the app.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db, Q } from '../db.ts';
import { eachCompany } from '../intake.ts';
import { Refused, parse } from '../http.ts';

/** What each kind of record is called. */
export const RECORD_LABEL: Record<string, string> = {
  jobs: 'Job card', job_visits: 'Job visit', work_items: 'Work on a job', job_helpers: 'Helper on a job', job_changes: 'Job change', job_no_charge: 'No charge on a job',
  job_reports: 'Parts report', invoices: 'Invoice', quotes: 'Quote', credit_notes: 'Credit note', document_lines: 'Quote or invoice line', estimates: 'Estimate',
  stock_items: 'Stock item', stock_movements: 'Stock movement', stock_issues: 'Stock issue', stock_issue_lines: 'Stock issue line', stock_returns: 'Stock return',
  stock_return_lines: 'Stock return line', stocktakes: 'Stock take', stocktake_lines: 'Stock take count', stock_deliveries: 'Stock delivery',
  purchase_orders: 'Purchase order', purchase_order_lines: 'Purchase order line', supplier_invoices: 'Supplier invoice', supplier_invoice_lines: 'Supplier invoice line',
  suppliers: 'Supplier', bought_out_items: 'Bought-out item', price_changes: 'Price change', rates: 'Rates', client_rates: 'Client rates',
  users: 'Person', user_profiles: 'Person\'s details', access_overrides: 'Access', access_changes: 'Access change', login_codes: 'Setup code', logins: 'Login email',
  employee_pay: 'Pay', employee_log_entries: 'Staff record', employee_log_deletions: 'Staff record deleted', terminations: 'Left the company',
  clients: 'Customer', stores: 'Store', store_managers: 'Store manager', client_hold_log: 'Account on hold',
  timesheets: 'Timesheet', timesheet_lines: 'Timesheet line', timesheet_extra_time: 'Office time', flags: 'Flag', queries: 'Query', query_messages: 'Query message',
  vehicles: 'Vehicle', vehicle_scans: 'Vehicle scan', vehicle_faults: 'Vehicle fault', vehicle_inspections: 'Vehicle handover', fuel_logs: 'Fuel', trips: 'Trip',
  fleet_jobs: 'Vehicle repair', fleet_job_parts: 'Vehicle repair part', daily_checks: 'Daily check', odometer_readings: 'Odometer',
  tools: 'Tool', tool_bookings: 'Tool booking', tool_assignments: 'Tool on someone\'s name', person_kit: 'Tools and PPE',
  breakdowns: 'Breakdown', photos: 'Photo', departments: 'Department', pastel_batches: 'Pastel export', policy_versions: 'Monitoring policy',
  policy_acknowledgements: 'Policy accepted', support_grants: 'Support access', company_profile: 'Company details', wa_messages: 'WhatsApp message', wa_chats: 'WhatsApp chat',
  van_stock_lists: 'Van stock list', loan_machines: 'Loan machine', workshop_items: 'Workshop stock',
};
const OP_LABEL = { add: 'Added', change: 'Changed', delete: 'Deleted' } as const;
const label = (t: string) => RECORD_LABEL[t] ?? (t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ').replace(/s$/, ''));

const HIDE = new Set(['id', 'company_id', 'created_at']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rand = (c: number) => `R ${(c / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A value as a person reads it. */
export function show(k: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (k.endsWith('_cents') && typeof v === 'number') return rand(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string' && UUID.test(v)) return `#${v.slice(0, 8)}`;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' });
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}
const field = (k: string) => k.replace(/_cents$/, '').replace(/_id$/, '').replace(/_/g, ' ');

/** The record's name in a few words: job 10231, invoice 1043, VALVE-01, Thabo Mkhize. */
function nameOf(r: Record<string, unknown> | null): string {
  if (!r) return '';
  const pick = (k: string) => (r[k] != null && r[k] !== '' ? String(r[k]) : null);
  return pick('job_number') ? `job ${pick('job_number')}` : pick('invoice_number') ? `invoice ${pick('invoice_number')}` : pick('quote_number') ? `quote ${pick('quote_number')}`
    : pick('po_number') ? `PO ${pick('external_number') ?? pick('po_number')}` : pick('code') && pick('description') ? `${pick('code')} · ${pick('description')}`
    : pick('full_name') ?? pick('registration') ?? pick('name') ?? pick('description') ?? pick('title') ?? pick('email') ?? '';
}

interface Row { id: string; at: Date; actor_id: string | null; actor_name: string | null; tbl: string; op: 'add' | 'change' | 'delete'; row_id: string | null; old: Record<string, unknown> | null; new: Record<string, unknown> | null }
export function describe(r: Row) {
  const changes: { field: string; from: string; to: string }[] = [];
  if (r.op === 'change' && r.old && r.new) {
    for (const k of Object.keys({ ...r.old, ...r.new })) {
      if (HIDE.has(k) || JSON.stringify(r.old[k]) === JSON.stringify(r.new[k])) continue;
      changes.push({ field: field(k), from: show(k, r.old[k]), to: show(k, r.new[k]) });
    }
  } else {
    const x = (r.new ?? r.old) ?? {};
    for (const k of Object.keys(x)) {
      if (HIDE.has(k) || x[k] === null || x[k] === '' || (typeof x[k] === 'string' && UUID.test(x[k] as string))) continue;
      changes.push(r.op === 'add' ? { field: field(k), from: '', to: show(k, x[k]) } : { field: field(k), from: show(k, x[k]), to: '' });
      if (changes.length >= 8) break;
    }
  }
  return {
    id: String(r.id), at: r.at, who: r.actor_name ?? (r.actor_id ? 'someone' : 'The app (automatic)'), whoId: r.actor_id,
    what: label(r.tbl), kind: r.tbl, op: r.op, opLabel: OP_LABEL[r.op], name: nameOf(r.new ?? r.old), changes,
  };
}

export async function sealAll(db: Db) {
  await eachCompany(db, async (c, id) => { await c.query('SELECT history_seal($1)', [id]); });
}

export function registerHistoryRoutes(app: FastifyInstance) {
  const creator = (req: FastifyRequest) => {
    if (req.actor.level !== 'creator' || req.user.s) throw new Refused(403, ['the history is for the Creator (the CEO) only']);
  };

  app.get('/history', async (req: FastifyRequest<{ Querystring: Record<string, string> }>) => {
    creator(req);
    const q = parse(z.object({
      q: z.string().trim().max(100).optional(), who: z.string().uuid().optional(), what: z.string().max(60).regex(/^[a-z_]+$/).optional(),
      op: z.enum(['add', 'change', 'delete']).optional(), days: z.coerce.number().int().min(1).max(3650).optional(), before: z.coerce.number().int().positive().optional(),
    }), req.query);
    const { rows } = await req.db.query(
      `SELECT id, at, actor_id, actor_name, tbl, op, row_id, old, new FROM history
        WHERE ($1::text IS NULL OR actor_name ILIKE '%' || $1 || '%' OR coalesce(new, old)::text ILIKE '%' || $1 || '%' OR old::text ILIKE '%' || $1 || '%')
          AND ($2::uuid IS NULL OR actor_id = $2) AND ($3::text IS NULL OR tbl = $3) AND ($4::text IS NULL OR op = $4)
          AND ($5::int IS NULL OR at > now() - make_interval(days => $5)) AND ($6::bigint IS NULL OR id < $6)
        ORDER BY id DESC LIMIT 100`,
      [q.q || null, q.who ?? null, q.what ?? null, q.op ?? null, q.days ?? null, q.before ?? null]);
    const people = (await req.db.query(
      `SELECT actor_id AS id, max(actor_name) AS name, count(*)::int AS n FROM history WHERE actor_id IS NOT NULL GROUP BY actor_id ORDER BY max(actor_name)`)).rows;
    const kinds = (await req.db.query('SELECT tbl, count(*)::int AS n FROM history GROUP BY tbl ORDER BY count(*) DESC')).rows.map(r => ({ key: r.tbl, label: label(r.tbl), n: r.n }));
    const since = (await req.db.query('SELECT min(at) AS at, count(*)::int AS n FROM history')).rows[0];
    return { entries: rows.map(describe), people, kinds, since: since.at, total: since.n, more: rows.length === 100 ? Number(rows[rows.length - 1].id) : null };
  });

  app.get('/history/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    creator(req);
    const id = parse(z.coerce.number().int().positive(), req.params.id);
    const r = (await req.db.query('SELECT id, at, actor_id, actor_name, tbl, op, row_id, old, new, hash FROM history WHERE id = $1', [id])).rows[0];
    if (!r) throw new Refused(404, ['no such entry']);
    const all = Object.keys({ ...(r.old ?? {}), ...(r.new ?? {}) }).filter(k => !HIDE.has(k))
      .map(k => ({ field: field(k), before: r.old ? show(k, r.old[k]) : '', after: r.new ? show(k, r.new[k]) : '', changed: JSON.stringify(r.old?.[k]) !== JSON.stringify(r.new?.[k]) }));
    // Everything else that happened to the same record, oldest first.
    const same = r.row_id ? (await req.db.query('SELECT id, at, actor_id, actor_name, tbl, op, row_id, old, new FROM history WHERE tbl = $1 AND row_id = $2 ORDER BY id', [r.tbl, r.row_id])).rows.map(describe) : [];
    return { ...describe(r), fields: all, fingerprint: r.hash, record: same };
  });

  // Seals what is there and checks every entry, and that none were taken out or slipped in.
  app.post('/history/check', async req => {
    creator(req);
    await seal(req.db, req.companyId);
    const v = (await req.db.query('SELECT * FROM history_verify($1)', [req.companyId])).rows[0];
    const bad = v.bad_id ? (await req.db.query('SELECT at FROM history WHERE id = $1', [v.bad_id])).rows[0]?.at ?? null : null;
    const seal1 = (await req.db.query('SELECT max(at) AS at, max(upto_id) AS upto FROM history_seals')).rows[0];
    return { ok: v.ok, checked: Number(v.checked), problem: v.problem, badId: v.bad_id ? String(v.bad_id) : null, badAt: bad, sealedAt: seal1.at };
  });
}

async function seal(c: Q, companyId: string) { await c.query('SELECT history_seal($1)', [companyId]); }
