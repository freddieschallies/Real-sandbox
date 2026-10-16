// Assistants and casual labour (core/crew.ts): the list of them, who was on which job, and casual pay.
// The lead technician ticks who is with him on site (and adds a new casual worker there); the office
// adds or corrects afterwards. Rates and pay: Accounts and the CEO (set_pay) only.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, tx, type Q } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as CR from '../core/crew.ts';
import { DateOnly, Refused, Uuid, parse } from '../http.ts';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const office = (req: FastifyRequest) => can(req.actor, 'assign_jobs') || can(req.actor, 'view_all_job_cards');
/** Who keeps the list of assistants and casuals: the office, HR, Accounts and the CEO. */
const keepsList = (req: FastifyRequest) => office(req) || can(req.actor, 'set_pay') || ['hr', 'admin', 'director', 'creator', 'accounts'].includes(req.actor.level);
const money = (req: FastifyRequest) => can(req.actor, 'set_pay');

async function onJob(c: Q, jobId: string, userId: string) {
  return !!(await c.query('SELECT 1 FROM jobs j WHERE j.id = $1 AND (j.lead_technician_id = $2 OR EXISTS (SELECT 1 FROM job_helpers h WHERE h.job_id = j.id AND h.user_id = $2))', [jobId, userId])).rowCount;
}

/** The people on a job, with their minutes (typed, or the technician's visit). */
export async function jobCrew(c: Q, jobId: string) {
  const rows = (await c.query(
    `SELECT jc.id, jc.member_id, m.full_name, m.kind, to_char(jc.work_date, 'YYYY-MM-DD') AS work_date, jc.minutes, jc.source, jc.note, jc.added_at, u.full_name AS added_by, jc.added_by AS added_by_id,
            coalesce(v.arrived_at, v.started_at) AS from_at, v.ended_at AS to_at
       FROM job_crew jc JOIN crew_members m ON m.id = jc.member_id JOIN users u ON u.id = jc.added_by LEFT JOIN job_visits v ON v.id = jc.visit_id
      WHERE jc.job_id = $1 AND jc.removed_at IS NULL ORDER BY jc.work_date, m.full_name`, [jobId])).rows;
  return rows.map(r => {
    const entry: CR.CrewEntry = { memberId: r.member_id, workDate: r.work_date, minutes: r.minutes, visit: { from: r.from_at ? new Date(r.from_at).toISOString() : null, to: r.to_at ? new Date(r.to_at).toISOString() : null } };
    return { id: r.id, memberId: r.member_id, name: r.full_name, kind: r.kind as CR.CrewKind, workDate: r.work_date, minutes: CR.crewMinutes(entry), typed: r.minutes !== null,
      running: r.minutes === null && !!r.from_at && !r.to_at, source: r.source, note: r.note, addedBy: r.added_by, addedById: r.added_by_id, addedAt: r.added_at, entry };
  });
}

export function registerCrewRoutes(app: FastifyInstance) {
  app.get('/crew-members', async (req: FastifyRequest<{ Querystring: { all?: string } }>) => {
    const all = req.query.all === '1' && keepsList(req);
    const { rows } = await req.db.query(
      `SELECT m.id, m.full_name, m.phone, m.kind, m.day_rate_cents, m.hour_rate_cents, m.note, m.active, m.added_at, u.full_name AS added_by,
              (SELECT max(jc.work_date) FROM job_crew jc WHERE jc.member_id = m.id AND jc.removed_at IS NULL) AS last_day
         FROM crew_members m JOIN users u ON u.id = m.added_by WHERE ($1::boolean OR m.active) ORDER BY m.kind, m.full_name`, [all]);
    const pay = money(req);
    return {
      members: rows.map(r => ({ id: r.id, full_name: r.full_name, kind: r.kind, phone: keepsList(req) ? r.phone : undefined, active: r.active, note: keepsList(req) ? r.note : undefined,
        lastDay: r.last_day ? new Date(r.last_day).toLocaleDateString('en-CA') : null, addedBy: r.added_by,
        ...(pay ? { dayRateCents: r.day_rate_cents, hourRateCents: r.hour_rate_cents } : {}) })),
      canEdit: keepsList(req), canPay: pay,
    };
  });

  // A new assistant or casual worker. The technician on site may add a casual worker (name and phone only).
  app.post('/crew-members', async (req, reply) => {
    const b = parse(z.object({
      id: Uuid.optional(), fullName: z.string().trim().min(2).max(120), phone: z.string().trim().max(30).optional(), kind: z.enum(['assistant', 'casual']),
      dayRateCents: z.number().int().min(0).nullish(), hourRateCents: z.number().int().min(0).nullish(), note: z.string().trim().max(300).optional(),
    }), req.body);
    if (!keepsList(req) && (b.kind !== 'casual' || b.dayRateCents != null || b.hourRateCents != null)) throw new Refused(403, ['on site you add a casual worker by name; the office does the rest']);
    if ((b.dayRateCents != null || b.hourRateCents != null) && !money(req)) throw new Refused(403, ['rates are set by Accounts or the CEO']);
    return tx(req.db, async c => {
      if (b.id) {
        const had = (await c.query('SELECT id, full_name FROM crew_members WHERE id = $1', [b.id])).rows[0];
        if (had) return reply.code(200).send({ id: had.id, full_name: had.full_name, existing: true });
      }
      const same = (await c.query('SELECT id, full_name FROM crew_members WHERE lower(full_name) = lower($1) AND active', [b.fullName])).rows[0];
      if (same) return reply.code(200).send({ id: same.id, full_name: same.full_name, existing: true });
      const id = b.id ?? randomUUID();
      await c.query(`INSERT INTO crew_members (id, full_name, phone, kind, day_rate_cents, hour_rate_cents, note, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, b.fullName, b.phone || null, b.kind, b.dayRateCents ?? null, b.hourRateCents ?? null, b.note || null, req.actor.id]);
      await audit(c, req.actor.id, 'crew_member_added', 'crew_member', id, { kind: b.kind });
      return reply.code(201).send({ id, full_name: b.fullName, existing: false });
    });
  });

  app.patch('/crew-members/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!keepsList(req)) throw new Refused(403, ['the office keeps the list of assistants and casual labour']);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({
      fullName: z.string().trim().min(2).max(120).optional(), phone: z.string().trim().max(30).nullish(), kind: z.enum(['assistant', 'casual']).optional(),
      dayRateCents: z.number().int().min(0).nullish(), hourRateCents: z.number().int().min(0).nullish(), note: z.string().trim().max(300).nullish(), active: z.boolean().optional(),
    }), req.body);
    if ((b.dayRateCents !== undefined || b.hourRateCents !== undefined) && !money(req)) throw new Refused(403, ['rates are set by Accounts or the CEO']);
    return tx(req.db, async c => {
      const m = (await c.query('SELECT * FROM crew_members WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!m) throw new Refused(404, ['no such person']);
      await c.query(
        `UPDATE crew_members SET full_name = $2, phone = $3, kind = $4, day_rate_cents = $5, hour_rate_cents = $6, note = $7, active = $8 WHERE id = $1`,
        [id, b.fullName ?? m.full_name, b.phone === undefined ? m.phone : b.phone, b.kind ?? m.kind, b.dayRateCents === undefined ? m.day_rate_cents : b.dayRateCents,
          b.hourRateCents === undefined ? m.hour_rate_cents : b.hourRateCents, b.note === undefined ? m.note : b.note, b.active ?? m.active]);
      await audit(c, req.actor.id, 'crew_member_changed', 'crew_member', id);
      return { id };
    });
  });

  app.get('/jobs/:id/crew', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const jobId = parse(Uuid, req.params.id);
    if (!office(req) && !can(req.actor, 'set_pay') && !(await onJob(req.db, jobId, req.actor.id))) throw new Refused(403, ['not your job card']);
    const crew = (await jobCrew(req.db, jobId)).map(({ entry, ...x }) => ({ ...x, canRemove: office(req) || (x.addedById === req.actor.id && x.workDate === today()) }));
    return { crew, canAdd: true, office: office(req), today: today(), hours: CR.crewHours(crew.map(x => ({ memberId: x.memberId, workDate: x.workDate, minutes: x.minutes })), new Date()) };
  });

  // On site: who is with the technician today (their time follows his visit). Office: a day and hours.
  app.post('/jobs/:id/crew', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const jobId = parse(Uuid, req.params.id);
    const b = parse(z.object({ id: Uuid.optional(), memberId: Uuid, workDate: DateOnly.optional(), hours: z.number().min(0).max(24).optional(), note: z.string().trim().max(300).optional() }), req.body);
    const isOffice = office(req);
    if (!isOffice && !(await onJob(req.db, jobId, req.actor.id))) throw new Refused(403, ['not your job card']);
    return tx(req.db, async c => {
      if (b.id && (await c.query('SELECT 1 FROM job_crew WHERE id = $1', [b.id])).rowCount) return reply.code(200).send({ id: b.id });
      const job = (await c.query('SELECT status FROM jobs WHERE id = $1', [jobId])).rows[0];
      if (!job) throw new Refused(404, ['no such job']);
      if (job.status === 'cancelled') throw new Refused(409, ['the job is cancelled']);
      const m = (await c.query('SELECT full_name FROM crew_members WHERE id = $1 AND active', [b.memberId])).rows[0];
      if (!m) throw new Refused(404, ['no such assistant or casual worker']);
      let visitId: string | null = null;
      const day = isOffice && b.workDate ? b.workDate : today();
      if (!isOffice || !b.workDate) {
        visitId = (await c.query(
          `SELECT id FROM job_visits WHERE job_id = $1 AND (go_at AT TIME ZONE 'Africa/Johannesburg')::date = $2::date ORDER BY go_at DESC LIMIT 1`, [jobId, day])).rows[0]?.id ?? null;
        if (!isOffice && !visitId) throw new Refused(409, ['tap Go on the job first: their time follows yours on site']);
      }
      const minutes = b.hours !== undefined ? Math.round(b.hours * 60) : null;
      if (isOffice && !visitId && minutes === null) throw new Refused(400, ['how many hours they worked']);
      if ((await c.query('SELECT 1 FROM job_crew WHERE job_id = $1 AND member_id = $2 AND work_date = $3 AND removed_at IS NULL', [jobId, b.memberId, day])).rowCount) {
        throw new Refused(409, [`${m.full_name} is already on this job for that day`]);
      }
      const id = b.id ?? randomUUID();
      await c.query(`INSERT INTO job_crew (id, job_id, member_id, visit_id, work_date, minutes, source, note, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, jobId, b.memberId, visitId, day, minutes, isOffice ? 'office' : 'site', b.note || null, req.actor.id]);
      await audit(c, req.actor.id, 'job_crew_added', 'job', jobId, { member: m.full_name, day });
      return reply.code(201).send({ id });
    });
  });

  app.post('/job-crew/:id/remove', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const e = (await c.query("SELECT job_id, added_by, to_char(work_date, 'YYYY-MM-DD') AS day FROM job_crew WHERE id = $1 AND removed_at IS NULL", [id])).rows[0];
      if (!e) throw new Refused(404, ['not on the job']);
      if (!office(req) && !(e.added_by === req.actor.id && e.day === today())) throw new Refused(403, ['ask the office to take them off']);
      await c.query('UPDATE job_crew SET removed_at = now(), removed_by = $2 WHERE id = $1', [id, req.actor.id]);
      await audit(c, req.actor.id, 'job_crew_removed', 'job', e.job_id);
      return { id };
    });
  });

  // Casual labour to pay: a day rate for each day worked, per person, for a period; and marking it paid.
  app.get('/crew/pay', async (req: FastifyRequest<{ Querystring: { from?: string; to?: string } }>) => {
    if (!money(req)) throw new Refused(403, ['pay is for Accounts and the CEO']);
    const q = parse(z.object({ from: DateOnly.optional(), to: DateOnly.optional() }), req.query);
    const to = q.to ?? today();
    const from = q.from ?? new Date(Date.now() - 6 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
    const members = (await req.db.query('SELECT id, full_name, kind, phone, day_rate_cents, hour_rate_cents FROM crew_members')).rows;
    const entries = (await req.db.query(
      `SELECT jc.member_id, to_char(jc.work_date, 'YYYY-MM-DD') AS work_date, j.job_number FROM job_crew jc JOIN jobs j ON j.id = jc.job_id
        WHERE jc.removed_at IS NULL AND jc.work_date BETWEEN $1 AND $2`, [from, to])).rows;
    const paid = (await req.db.query(
      `SELECT p.member_id, to_char(p.period_from, 'YYYY-MM-DD') AS f, to_char(p.period_to, 'YYYY-MM-DD') AS t, p.amount_cents, p.paid_at, u.full_name AS by
         FROM crew_payments p JOIN users u ON u.id = p.paid_by WHERE p.period_to >= $1 AND p.period_from <= $2`, [from, to])).rows;
    const byId = new Map(members.map(m => [m.id, m]));
    const casual = entries.filter(e => byId.get(e.member_id)?.kind === 'casual');
    const pay = CR.casualPay(casual.map(e => ({ memberId: e.member_id, workDate: e.work_date })), id => byId.get(id)?.day_rate_cents ?? null);
    return {
      from, to,
      casuals: pay.map(p => ({ ...p, name: byId.get(p.memberId)!.full_name, phone: byId.get(p.memberId)!.phone,
        jobs: [...new Set(casual.filter(e => e.member_id === p.memberId).map(e => e.job_number))],
        paid: paid.filter(x => x.member_id === p.memberId).map(x => ({ from: x.f, to: x.t, amountCents: x.amount_cents, at: x.paid_at, by: x.by })) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      totalCents: pay.reduce((n, p) => n + (p.amountCents ?? 0), 0),
      noRate: pay.filter(p => p.dayRateCents === null).length,
    };
  });

  app.post('/crew/pay', async req => {
    if (!money(req)) throw new Refused(403, ['pay is for Accounts and the CEO']);
    const b = parse(z.object({ memberId: Uuid, from: DateOnly, to: DateOnly, note: z.string().trim().max(300).optional() }), req.body);
    return tx(req.db, async c => {
      const m = (await c.query("SELECT full_name, day_rate_cents FROM crew_members WHERE id = $1 AND kind = 'casual'", [b.memberId])).rows[0];
      if (!m) throw new Refused(404, ['no such casual worker']);
      if (m.day_rate_cents === null) throw new Refused(409, [`set ${m.full_name}'s day rate first`]);
      const days = Number((await c.query('SELECT count(DISTINCT work_date)::int AS n FROM job_crew WHERE member_id = $1 AND removed_at IS NULL AND work_date BETWEEN $2 AND $3', [b.memberId, b.from, b.to])).rows[0].n);
      if (!days) throw new Refused(409, ['no days worked in that period']);
      if ((await c.query('SELECT 1 FROM crew_payments WHERE member_id = $1 AND period_from <= $3 AND period_to >= $2', [b.memberId, b.from, b.to])).rowCount) {
        throw new Refused(409, [`${m.full_name} was already paid for part of that period`]);
      }
      const amount = days * m.day_rate_cents;
      await c.query('INSERT INTO crew_payments (member_id, period_from, period_to, days, amount_cents, paid_by, note) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [b.memberId, b.from, b.to, days, amount, req.actor.id, b.note || null]);
      await audit(c, req.actor.id, 'casual_paid', 'crew_member', b.memberId, { days });
      return { days, amountCents: amount };
    });
  });
}

/** Hours of assistants and casuals on a job, for the invoice (charged at the assistant rate). */
export async function crewHoursForJob(c: Q, jobId: string) {
  return CR.crewHours((await jobCrew(c, jobId)).map(x => x.entry));
}

/** What the assistants and casuals on a job cost: their hour rate, or a casual's day rate spread over that day's jobs. */
export async function crewCostCents(c: Q, jobId: string) {
  const rows = (await c.query(
    `SELECT jc.job_id, jc.member_id, to_char(jc.work_date, 'YYYY-MM-DD') AS work_date, jc.minutes, coalesce(v.arrived_at, v.started_at) AS from_at, v.ended_at AS to_at,
            m.day_rate_cents, m.hour_rate_cents
       FROM job_crew jc JOIN crew_members m ON m.id = jc.member_id LEFT JOIN job_visits v ON v.id = jc.visit_id
      WHERE jc.removed_at IS NULL AND (jc.member_id, jc.work_date) IN (SELECT member_id, work_date FROM job_crew WHERE job_id = $1 AND removed_at IS NULL)`, [jobId])).rows;
  if (!rows.length) return 0;
  const rates = new Map(rows.map(r => [r.member_id, { dayCents: r.day_rate_cents, hourCents: r.hour_rate_cents }]));
  return CR.crewCostForJob(jobId, rows.map(r => ({
    jobId: r.job_id, memberId: r.member_id, workDate: r.work_date,
    minutes: CR.crewMinutes({ memberId: r.member_id, workDate: r.work_date, minutes: r.minutes, visit: { from: r.from_at ? new Date(r.from_at).toISOString() : null, to: r.to_at ? new Date(r.to_at).toISOString() : null } }),
  })), id => rates.get(id) ?? { dayCents: null, hourCents: null });
}
