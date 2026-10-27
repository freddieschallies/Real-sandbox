// What each company has and pays. The owner of Real Sandbox sets, per company, the positions it uses,
// the parts of the app it has and its plan (a monthly amount, and per person on the app); invoices are
// made each month on the company's billing day, and a company that has not paid well after the due
// date is suspended if the owner chose that. The CEO sees the company's positions (and appoints people
// to the work of the ones it does not have), its parts, and its own invoices, with a warning when one
// is overdue. The owner still never sees the company's records: only how many people are on the app.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db, Q } from '../db.ts';
import { inCompany } from '../db.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { accessOf } from '../auth.ts';
import { POSITION_LABEL, WORK_AREAS, workOf } from '../core/permissions.ts';
import { OPTIONAL_POSITIONS, PARTS, PART_KEYS, POSITION_WORK, addDays, invoiceState, monthCharge, planOf, type Billing, type Part } from '../core/plan.ts';
import { notify } from './field.ts';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
export const invoiceNo = (n: number) => `RS-${n}`;

const BILLING_COLS = 'plan_name, base_cents, per_user_cents, free_users, billing_day, due_days, grace_days, auto_suspend, billing_email, notes';
const BillingBody = z.object({
  plan_name: z.string().trim().min(1).max(80),
  base_cents: z.number().int().min(0).max(100_000_000),
  per_user_cents: z.number().int().min(0).max(10_000_000),
  free_users: z.number().int().min(0).max(10_000),
  billing_day: z.number().int().min(1).max(28),
  due_days: z.number().int().min(0).max(60),
  grace_days: z.number().int().min(0).max(90),
  auto_suspend: z.boolean(),
  billing_email: z.string().trim().email().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export const PlanBody = z.object({
  positions: z.array(z.enum(OPTIONAL_POSITIONS)).max(OPTIONAL_POSITIONS.length),
  parts: z.array(z.enum(PART_KEYS as [Part, ...Part[]])).max(PART_KEYS.length),
});

/** People on the app in a company (what the per-person part of the plan counts). */
const usersIn = (c: Q) => c.query("SELECT count(*)::int AS n FROM users WHERE status <> 'left' AND support_owner IS NULL").then(r => Number(r.rows[0].n));
const ceosOf = (c: Q) => c.query("SELECT id FROM users WHERE login_level IN ('creator', 'director') AND status <> 'left' AND support_owner IS NULL").then(r => r.rows.map(x => x.id as string));
const rand = (cents: number) => `R ${(cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function settingsOf(db: Q) {
  return (await db.query('SELECT business_name, details, bank_details, vat_pct::float AS vat_pct, vat_registered FROM platform_settings WHERE id = 1')).rows[0];
}

function withState<T extends { due_on: string; paid_at: string | null; cancelled_at: string | null; number: number }>(inv: T, graceDays: number, on = today()) {
  const state = invoiceState(inv, on, graceDays);
  return { ...inv, label: invoiceNo(inv.number), state, suspendOn: state === 'paid' || state === 'cancelled' ? null : addDays(inv.due_on, graceDays + 1) };
}
const invCols = (t = '') => `${t}id, ${t}number, ${t}company, ${t}period, ${t}plan_name, ${t}users, ${t}lines, ${t}amount_cents,
  to_char(${t}issued_on, 'YYYY-MM-DD') AS issued_on, to_char(${t}due_on, 'YYYY-MM-DD') AS due_on, ${t}paid_at, ${t}paid_ref, ${t}cancelled_at, ${t}cancel_note`;
const INV_COLS = invCols();

/** A month's invoice for a company (refused if it already has one for that month). */
export async function makeInvoice(db: Db, companyId: string, period: string, on = today()) {
  const b = (await db.query(`SELECT ${BILLING_COLS} FROM company_billing WHERE company = $1`, [companyId])).rows[0] as Billing | undefined;
  if (!b) throw new Refused(409, ['set the company\'s plan first']);
  if ((await db.query('SELECT 1 FROM platform_invoices WHERE company = $1 AND period = $2 AND cancelled_at IS NULL', [companyId, period])).rowCount) {
    throw new Refused(409, [`there is already an invoice for ${period}: cancel it first to make it again`]);
  }
  const s = await settingsOf(db);
  const users = await inCompany(db, companyId, usersIn);
  const { lines, amountCents } = monthCharge(b, users, period, { pct: s.vat_pct, registered: s.vat_registered });
  if (!lines.length) throw new Refused(409, ['the plan comes to nothing: set an amount first']);
  const inv = (await db.query(
    `INSERT INTO platform_invoices (company, period, plan_name, users, lines, amount_cents, issued_on, due_on) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${INV_COLS}`,
    [companyId, period, b.plan_name, users, JSON.stringify(lines), amountCents, on, addDays(on, b.due_days)])).rows[0];
  await inCompany(db, companyId, async c => {
    for (const id of await ceosOf(c)) await notify(c, id, 'account_invoice', `Real Sandbox invoice ${invoiceNo(inv.number)}: ${rand(amountCents)}, due ${inv.due_on}. See Settings → Your Real Sandbox account.`, { invoice: inv.id });
  });
  return withState(inv, b.grace_days, on);
}

/**
 * Once a day (and when the owner taps "Run billing now"): each company's invoice on its billing day,
 * a reminder the day an invoice goes overdue, and, where the owner chose it, suspension once an
 * invoice is unpaid past the grace days. Returns what it did.
 */
export async function runBilling(db: Db, on = today()) {
  const out = { invoiced: [] as string[], suspended: [] as string[], reminded: [] as string[] };
  const period = on.slice(0, 7), day = Number(on.slice(8, 10));
  const due = (await db.query(
    `SELECT b.company, c.name FROM company_billing b JOIN companies c ON c.id = b.company
      WHERE c.active AND (b.base_cents > 0 OR b.per_user_cents > 0) AND b.billing_day <= $2
        AND NOT EXISTS (SELECT 1 FROM platform_invoices i WHERE i.company = b.company AND i.period = $1)`, [period, day])).rows;
  for (const r of due) { await makeInvoice(db, r.company, period, on); out.invoiced.push(r.name); }
  const open = (await db.query(
    `SELECT ${invCols('i.')}, i.reminded_at, b.grace_days, b.auto_suspend, c.name, c.active
       FROM platform_invoices i JOIN company_billing b ON b.company = i.company JOIN companies c ON c.id = i.company
      WHERE i.paid_at IS NULL AND i.cancelled_at IS NULL ORDER BY i.due_on`)).rows;
  for (const inv of open) {
    const st = invoiceState(inv, on, inv.grace_days);
    if (st === 'suspend' && inv.auto_suspend && inv.active) {
      await db.query("UPDATE companies SET active = false, suspended_at = now(), suspended_reason = $2 WHERE id = $1 AND active",
        [inv.company, `Invoice ${invoiceNo(inv.number)} not paid (due ${inv.due_on})`]);
      out.suspended.push(inv.name);
    } else if (st === 'overdue' && inv.active && !inv.reminded_at) {
      await db.query('UPDATE platform_invoices SET reminded_at = now() WHERE id = $1', [inv.id]);
      await inCompany(db, inv.company, async c => {
        const when = inv.auto_suspend ? ` The account is suspended on ${addDays(inv.due_on, inv.grace_days + 1)} if it is still unpaid.` : '';
        for (const id of await ceosOf(c)) await notify(c, id, 'account_overdue', `Real Sandbox invoice ${invoiceNo(inv.number)} (${rand(inv.amount_cents)}) is overdue.${when}`, { invoice: inv.id });
      });
      out.reminded.push(inv.name);
    }
  }
  return out;
}

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** The owner's side: plans, positions, parts, invoices, and the owner's own invoice details. */
export function registerOwnerBillingRoutes(app: FastifyInstance, db: Db, guard: Guard) {
  const exists = async (id: string) => {
    if (!(await db.query('SELECT 1 FROM companies WHERE id = $1', [id])).rowCount) throw new Refused(404, ['no such company']);
  };

  app.get('/platform/billing', { preHandler: guard }, async () => {
    const on = today();
    const companies = (await db.query(`SELECT id, name, active, positions, parts FROM companies ORDER BY name`)).rows;
    const billing = new Map((await db.query(`SELECT company, ${BILLING_COLS} FROM company_billing`)).rows.map(r => [r.company, r]));
    const invoices = (await db.query(`SELECT ${INV_COLS} FROM platform_invoices ORDER BY issued_on DESC, number DESC`)).rows;
    let monthCents = 0, overdueCents = 0, owingCents = 0, paidMonthCents = 0;
    const s = await settingsOf(db);
    const out = [];
    for (const co of companies) {
      const b = billing.get(co.id) ?? null;
      const users = await inCompany(db, co.id, usersIn);
      const next = b ? monthCharge(b, users, on.slice(0, 7), { pct: s.vat_pct, registered: s.vat_registered }).amountCents : 0;
      if (co.active) monthCents += next;
      const mine = invoices.filter(i => i.company === co.id).map(i => withState(i, b?.grace_days ?? 14, on));
      for (const i of mine) {
        if (i.state === 'due') owingCents += i.amount_cents;
        if (i.state === 'overdue' || i.state === 'suspend') { overdueCents += i.amount_cents; owingCents += i.amount_cents; }
        if (i.paid_at && new Date(i.paid_at).toISOString().slice(0, 7) === on.slice(0, 7)) paidMonthCents += i.amount_cents;
      }
      out.push({ id: co.id, name: co.name, active: co.active, plan: planOf(co), billing: b, users, monthCents: next, invoices: mine.slice(0, 24) });
    }
    return { today: on, settings: await settingsOf(db), totals: { monthCents, overdueCents, owingCents, paidMonthCents }, companies: out,
      positions: OPTIONAL_POSITIONS.map(p => ({ key: p, label: POSITION_LABEL[p], what: POSITION_WORK[p].what })), parts: PART_KEYS.map(k => ({ key: k, label: PARTS[k] })) };
  });

  // The positions and parts a company has (at set-up, and changed later).
  app.put('/platform/companies/:id/plan', { preHandler: guard }, async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(PlanBody, req.body);
    await exists(id);
    // Someone already in a position the company drops keeps it until the CEO moves them: say so.
    const inUse = await inCompany(db, id, async c => (await c.query(
      "SELECT login_level, count(*)::int AS n FROM users WHERE status <> 'left' AND support_owner IS NULL AND login_level::text <> ALL($1::text[]) AND login_level NOT IN ('technician', 'creator') GROUP BY 1",
      [b.positions])).rows);
    await db.query('UPDATE companies SET positions = $2, parts = $3 WHERE id = $1', [id, b.positions, b.parts]);
    return { plan: planOf(b), stillIn: inUse.map(r => ({ position: r.login_level, label: POSITION_LABEL[r.login_level as keyof typeof POSITION_LABEL], people: r.n })) };
  });

  app.put('/platform/companies/:id/billing', { preHandler: guard }, async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(BillingBody, req.body);
    await exists(id);
    const row = (await db.query(
      `INSERT INTO company_billing (company, ${BILLING_COLS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (company) DO UPDATE SET plan_name = $2, base_cents = $3, per_user_cents = $4, free_users = $5, billing_day = $6, due_days = $7,
         grace_days = $8, auto_suspend = $9, billing_email = $10, notes = $11, updated_at = now() RETURNING ${BILLING_COLS}`,
      [id, b.plan_name, b.base_cents, b.per_user_cents, b.free_users, b.billing_day, b.due_days, b.grace_days, b.auto_suspend, b.billing_email ?? null, b.notes ?? null])).rows[0];
    return row;
  });

  app.post('/platform/companies/:id/invoices', { preHandler: guard }, async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }), req.body ?? {});
    await exists(id);
    return reply.code(201).send(await makeInvoice(db, id, b.period ?? today().slice(0, 7)));
  });

  app.post('/platform/invoices/:id/paid', { preHandler: guard }, async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ ref: z.string().trim().max(120).optional(), on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.body ?? {});
    const inv = (await db.query(
      `UPDATE platform_invoices SET paid_at = coalesce($3::date::timestamptz + interval '12 hours', now()), paid_ref = $2
        WHERE id = $1 AND paid_at IS NULL AND cancelled_at IS NULL RETURNING ${INV_COLS}`, [id, b.ref ?? null, b.on ?? null])).rows[0];
    if (!inv) throw new Refused(409, ['that invoice is already paid or cancelled']);
    // Suspended for not paying, and nothing else unpaid past its grace: open again.
    let reopened = false;
    const co = (await db.query('SELECT active, suspended_reason FROM companies WHERE id = $1', [inv.company])).rows[0];
    if (!co.active && /^Invoice RS-\d+ not paid/.test(co.suspended_reason ?? '')) {
      const g = Number((await db.query('SELECT grace_days FROM company_billing WHERE company = $1', [inv.company])).rows[0]?.grace_days ?? 14);
      const still = (await db.query(`SELECT ${INV_COLS} FROM platform_invoices WHERE company = $1 AND paid_at IS NULL AND cancelled_at IS NULL`, [inv.company])).rows
        .some(i => invoiceState(i, today(), g) === 'suspend');
      if (!still) { await db.query('UPDATE companies SET active = true, suspended_at = NULL, suspended_reason = NULL WHERE id = $1', [inv.company]); reopened = true; }
    }
    await inCompany(db, inv.company, async c => {
      for (const u of await ceosOf(c)) await notify(c, u, 'account_paid', `Thank you: Real Sandbox invoice ${invoiceNo(inv.number)} is paid.`, { invoice: inv.id });
    });
    return { ...inv, label: invoiceNo(inv.number), state: 'paid', reopened };
  });

  app.post('/platform/invoices/:id/cancel', { preHandler: guard }, async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ note: z.string().trim().min(2, 'say why').max(300) }), req.body);
    const inv = (await db.query(
      `UPDATE platform_invoices SET cancelled_at = now(), cancel_note = $2 WHERE id = $1 AND paid_at IS NULL AND cancelled_at IS NULL RETURNING ${INV_COLS}`, [id, b.note])).rows[0];
    if (!inv) throw new Refused(409, ['only an unpaid invoice can be cancelled']);
    return { ...inv, label: invoiceNo(inv.number), state: 'cancelled' };
  });

  app.put('/platform/settings', { preHandler: guard }, async req => {
    const b = parse(z.object({
      business_name: z.string().trim().min(2).max(120), details: z.string().trim().max(1000).nullable().optional(),
      bank_details: z.string().trim().max(1000).nullable().optional(), vat_pct: z.number().min(0).max(30), vat_registered: z.boolean(),
    }), req.body);
    await db.query('UPDATE platform_settings SET business_name = $1, details = $2, bank_details = $3, vat_pct = $4, vat_registered = $5, updated_at = now() WHERE id = 1',
      [b.business_name, b.details ?? null, b.bank_details ?? null, b.vat_pct, b.vat_registered]);
    return settingsOf(db);
  });

  app.post('/platform/billing/run', { preHandler: guard }, async () => runBilling(db));
}

/** The CEO's side: the company's positions (and who does the work of the missing ones), parts, and its account. */
export function registerCompanyPlanRoutes(app: FastifyInstance, db: Db) {
  const ceo = (req: FastifyRequest) => {
    if (!['creator', 'director'].includes(req.actor.level)) throw new Refused(403, ['for the CEO']);
  };

  app.get('/company/plan', async req => {
    ceo(req);
    const plan = req.plan;
    // Everyone's work as it stands, to show who the CEO has appointed to the work of a missing position.
    const people = (await req.db.query(
      "SELECT id, full_name, login_level FROM users WHERE status <> 'left' AND support_owner IS NULL AND login_level <> 'creator' ORDER BY full_name")).rows;
    const work = new Map<string, Record<string, boolean>>();
    for (const p of people) work.set(p.id, workOf((await accessOf(req.db, p.id))?.perms ?? {}));
    const positions = OPTIONAL_POSITIONS.map(p => {
      const has = plan.positions.includes(p);
      const areas = POSITION_WORK[p].areas;
      return {
        key: p, label: POSITION_LABEL[p], has, what: POSITION_WORK[p].what,
        areas: areas.map(a => ({ key: a, label: WORK_AREAS[a].label })),
        // Without the position: the CEO does it, with whoever the CEO gave all of its work.
        appointed: has || !areas.length ? [] : people.filter(u => areas.every(a => work.get(u.id)?.[a])).map(u => ({ id: u.id, name: u.full_name, level: u.login_level, label: POSITION_LABEL[u.login_level as keyof typeof POSITION_LABEL] })),
      };
    });
    return {
      positions, parts: PART_KEYS.map(k => ({ key: k, label: PARTS[k], on: plan.parts.includes(k) })),
      people: people.map(u => ({ id: u.id, name: u.full_name, level: u.login_level, label: POSITION_LABEL[u.login_level as keyof typeof POSITION_LABEL] })),
      account: await accountOf(db, req.companyId),
    };
  });

  app.get('/company/account', async req => { ceo(req); return accountOf(db, req.companyId); });
}

/** A company's own account with Real Sandbox: its plan, its invoices, and any warning. */
export async function accountOf(db: Db, companyId: string) {
  const b = (await db.query(`SELECT ${BILLING_COLS} FROM company_billing WHERE company = $1`, [companyId])).rows[0] ?? null;
  const g = b?.grace_days ?? 14;
  const invoices = (await db.query(`SELECT ${INV_COLS} FROM platform_invoices WHERE company = $1 ORDER BY issued_on DESC, number DESC LIMIT 24`, [companyId])).rows
    .map(i => withState(i, g)).filter(i => i.state !== 'cancelled');
  const unpaid = invoices.filter(i => i.state !== 'paid');
  const late = unpaid.filter(i => i.state === 'overdue' || i.state === 'suspend').sort((a, z) => a.due_on.localeCompare(z.due_on))[0] ?? null;
  return {
    plan: b ? { name: b.plan_name, baseCents: b.base_cents, perUserCents: b.per_user_cents, freeUsers: b.free_users, billingDay: b.billing_day, dueDays: b.due_days, graceDays: b.grace_days, autoSuspend: b.auto_suspend } : null,
    invoices, owingCents: unpaid.reduce((n, i) => n + i.amount_cents, 0),
    overdue: late ? { id: late.id, label: late.label, amountCents: late.amount_cents, dueOn: late.due_on, suspendOn: b?.auto_suspend ? late.suspendOn : null } : null,
    from: await settingsOf(db),
  };
}
