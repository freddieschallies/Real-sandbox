// Daily timesheets. The app makes each technician's day from what it recorded; he checks and submits
// the previous day's (a word is needed for time not accounted for). A day not submitted is flagged.
// HR (and a department manager for his own technicians) sees and exports them, with every job and
// flag of the day on each sheet.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, raiseFlag, tx, type Q } from '../db.ts';
import { can, departmentsFor } from '../core/permissions.ts';
import * as T from '../core/timesheet.ts';
import { DateOnly, Iso, Refused, Uuid, parse } from '../http.ts';
import { notify } from './field.ts';

const sast = (d: Date = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const sastHour = (d: Date = new Date()) => Number(d.toLocaleString('en-GB', { timeZone: 'Africa/Johannesburg', hour: '2-digit', hour12: false }));
const addDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayLabel = (date: string) => new Date(`${date}T12:00:00+02:00`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });

/** Everything the app recorded for him on that day. */
async function dayOf(c: Q, techId: string, date: string): Promise<T.Day> {
  const visits = (await c.query(
    `SELECT v.id, v.job_id, j.job_number, s.name AS store, j.fault_reported, v.go_at, v.arrived_at, v.started_at, v.ended_at, v.state, v.progress_note,
            (v.technician_id <> $1) AS helper
       FROM job_visits v JOIN jobs j ON j.id = v.job_id JOIN stores s ON s.id = j.store_id
      WHERE (COALESCE(v.go_at, v.arrived_at) AT TIME ZONE 'Africa/Johannesburg')::date = $2::date
        AND (v.technician_id = $1 OR EXISTS (SELECT 1 FROM job_helpers h WHERE h.job_id = v.job_id AND h.user_id = $1))`, [techId, date])).rows;
  const pauses = visits.length ? (await c.query('SELECT visit_id, reason, paused_at, resumed_at FROM visit_pauses WHERE visit_id = ANY($1) ORDER BY paused_at', [visits.map(v => v.id)])).rows : [];
  const scans = (await c.query(
    `SELECT s.scanned_at, v.registration, s.mode FROM vehicle_scans s JOIN vehicles v ON v.id = s.vehicle_id
      WHERE s.user_id = $1 AND (s.scanned_at AT TIME ZONE 'Africa/Johannesburg')::date = $2::date ORDER BY s.scanned_at`, [techId, date])).rows;
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return T.buildDay(
    visits.map(v => ({
      jobId: v.job_id, jobNumber: v.job_number, store: v.store, fault: v.fault_reported, goAt: iso(v.go_at), arrivedAt: iso(v.arrived_at), startedAt: iso(v.started_at), endedAt: iso(v.ended_at),
      pauses: pauses.filter(p => p.visit_id === v.id).map(p => ({ reason: p.reason, at: iso(p.paused_at)!, resumedAt: iso(p.resumed_at) })), state: v.state, progressNote: v.progress_note, helper: v.helper,
    })),
    scans.map(s => ({ at: iso(s.scanned_at)!, registration: s.registration, mode: s.mode })),
  );
}

async function flagsOn(c: Q, techId: string, date: string) {
  return (await c.query(
    `SELECT id, flag_type, severity, raised_at, question, explanation, status, resolution_note FROM flags
      WHERE technician_id = $1 AND ((raised_at AT TIME ZONE 'Africa/Johannesburg')::date = $2::date OR details->>'workDate' = $2::text) ORDER BY raised_at`, [techId, date])).rows;
}

async function rulesOf(c: Q): Promise<T.PayRules> {
  const r = (await c.query('SELECT weekday_normal_min, saturday_normal_min FROM timesheet_settings')).rows[0];
  return r ? { weekdayNormalMin: r.weekday_normal_min, saturdayNormalMin: r.saturday_normal_min } : T.DEFAULT_PAY;
}

/** One technician's sheet for one day: what he submitted, or what the app has for the day so far, with the pay split. */
async function sheetFor(c: Q, techId: string, date: string, rules?: T.PayRules) {
  const ts = (await c.query('SELECT t.submitted_at, t.sheet, t.note, f.full_name AS filled_by FROM timesheets t LEFT JOIN users f ON f.id = t.filled_by WHERE t.technician_id = $1 AND t.work_date = $2', [techId, date])).rows[0];
  const day: T.Day = ts?.sheet ?? await dayOf(c, techId, date);
  return { date, label: dayLabel(date), weekday: T.isWeekday(date), submitted: ts ? { at: ts.submitted_at, note: ts.note, filledBy: ts.filled_by ?? null } : null, day,
    pay: T.payOf(day, date, rules ?? await rulesOf(c)), flags: await flagsOn(c, techId, date) };
}

const CEO = ['director', 'creator'];
/** HR and the CEO always see every technician's timesheets, past and present, including people who have left. */
const FULL = ['hr', 'director', 'creator'];
const scopeOf = (a: { level: string } & Parameters<typeof departmentsFor>[0]) => (FULL.includes(a.level) ? 'all' as const : departmentsFor(a, 'view_timesheets'));
const ym = (date: string) => date.slice(0, 7);
const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const addMonths = (m: string, n: number) => { const d = new Date(`${m}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };

/** One technician someone may see the timesheets of: HR and the CEO everyone (also people who left), a manager his own. */
async function personFor(c: Q, actor: Parameters<typeof scopeOf>[0], userId: string) {
  const scope = scopeOf(actor);
  if (!scope) throw new Refused(403, ['timesheets are for HR, the CEO and department managers']);
  const u = (await c.query(
    `SELECT u.id, u.full_name, u.status, u.department_id, (u.created_at AT TIME ZONE 'Africa/Johannesburg')::date::text AS since, t.terminated_on::text AS left_on
       FROM users u LEFT JOIN terminations t ON t.user_id = u.id WHERE u.id = $1 AND u.login_level = 'technician'`, [userId])).rows[0];
  if (!u) throw new Refused(404, ['no such technician']);
  if (scope !== 'all' && (u.status === 'left' || !scope.includes(u.department_id))) throw new Refused(403, ['not one of your technicians']);
  return u as { id: string; full_name: string; status: string; since: string; left_on: string | null };
}

/** Keeps a day's sheet as it is now (it cannot change after), with the minutes per job; closes its missing flag. */
async function saveSheet(c: Q, techId: string, date: string, day: T.Day, at: string, note: string | null, filledBy: string | null) {
  if ((await c.query('SELECT 1 FROM timesheets WHERE technician_id = $1 AND work_date = $2', [techId, date])).rowCount) throw new Refused(409, ['this day is already submitted; corrections go through the manager']);
  const ts = (await c.query('INSERT INTO timesheets (technician_id, work_date, submitted_at, sheet, note, unaccounted_min, filled_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [techId, date, at, JSON.stringify(day), note, day.unaccountedMin, filledBy])).rows[0].id as string;
  const perJob = new Map<string, number>();
  for (const j of day.jobs) perJob.set(j.jobId, (perJob.get(j.jobId) ?? 0) + j.workMin);
  for (const [jobId, m] of perJob) await c.query('INSERT INTO timesheet_lines (timesheet_id, job_id, minutes) VALUES ($1, $2, $3)', [ts, jobId, m]);
  await c.query(`UPDATE flags SET status = 'resolved', resolved_by = $1, resolved_at = now(), resolution_note = $3
                  WHERE technician_id = $2 AND flag_type = 'timesheet_missing' AND details->>'workDate' = $4 AND status <> 'resolved'`,
    [filledBy ?? techId, techId, filledBy ? 'Filled in by the CEO' : 'Timesheet submitted', date]);
  return ts;
}

/** The finished days he still owes a timesheet for: the last week, weekdays and any day he worked. */
async function owed(c: Q, techId: string) {
  const u = (await c.query("SELECT (created_at AT TIME ZONE 'Africa/Johannesburg')::date::text AS since FROM users WHERE id = $1", [techId])).rows[0];
  const today = sast();
  const from = [addDays(today, -7), u?.since ?? today].sort()[1];
  const out: { date: string; label: string; day: T.Day; pay: T.Pay; overdue: boolean }[] = [];
  for (const date of T.daysBetween(from, addDays(today, -1))) {
    if ((await c.query('SELECT 1 FROM timesheets WHERE technician_id = $1 AND work_date = $2', [techId, date])).rowCount) continue;
    const day = await dayOf(c, techId, date);
    if (!T.isWeekday(date) && !day.activity) continue;
    out.push({ date, label: dayLabel(date), day, pay: T.payOf(day, date, await rulesOf(c)), overdue: date < addDays(today, -1) || sastHour() >= 10 });
  }
  return out;
}

export function registerTimesheetRoutes(app: FastifyInstance) {
  // ---- The technician's own --------------------------------------------------------------------
  app.get('/me/timesheets', async req => {
    if (req.actor.level !== 'technician') return { due: [], recent: [] };
    return tx(req.db, async c => {
      const due = await owed(c, req.actor.id);
      // A finished day not submitted by 10:00 the next morning is flagged, once.
      for (const d of due.filter(x => x.overdue)) {
        const has = await c.query("SELECT 1 FROM flags WHERE technician_id = $1 AND flag_type = 'timesheet_missing' AND details->>'workDate' = $2", [req.actor.id, d.date]);
        if (!has.rowCount) await raiseFlag(c, { type: 'timesheet_missing', technicianId: req.actor.id, question: `Your timesheet for ${d.label} was not submitted. Check it and submit it now.`, details: { workDate: d.date } });
      }
      const rules = await rulesOf(c);
      const recent = (await c.query(
        `SELECT t.work_date::text AS date, t.submitted_at, t.note, t.sheet, f.full_name AS filled_by FROM timesheets t LEFT JOIN users f ON f.id = t.filled_by WHERE t.technician_id = $1 ORDER BY t.work_date DESC LIMIT 14`, [req.actor.id])).rows
        .filter(r => r.sheet).map(r => ({ date: r.date, label: dayLabel(r.date), submitted: { at: r.submitted_at, note: r.note, filledBy: r.filled_by ?? null }, day: r.sheet, pay: T.payOf(r.sheet, r.date, rules), flags: [] }));
      return { due, recent, explainFromMin: T.EXPLAIN_FROM_MIN };
    });
  });

  app.get('/me/timesheets/:date', async (req: FastifyRequest<{ Params: { date: string } }>) => {
    const date = parse(DateOnly, req.params.date);
    return sheetFor(req.db, req.actor.id, date);
  });

  app.post('/me/timesheets/:date/submit', async (req: FastifyRequest<{ Params: { date: string } }>) => {
    const date = parse(DateOnly, req.params.date);
    const b = parse(z.object({ at: Iso, note: z.string().trim().max(1000).optional() }), req.body);
    if (req.actor.level !== 'technician') throw new Refused(403, ['timesheets are for technicians']);
    if (date >= sast(new Date(b.at))) throw new Refused(400, ['only a finished day can be submitted']);
    return tx(req.db, async c => {
      const day = await dayOf(c, req.actor.id, date);
      if (day.unaccountedMin >= T.EXPLAIN_FROM_MIN && (!b.note || b.note.length < 5)) throw new Refused(400, [`say what the ${T.hm(day.unaccountedMin)} not accounted for was`]);
      const ts = await saveSheet(c, req.actor.id, date, day, b.at, b.note || null, null);
      await audit(c, req.actor.id, 'timesheet_submitted', 'timesheet', ts, { workDate: date, unaccountedMin: day.unaccountedMin });
      return { id: ts, date, day };
    });
  });

  // The CEO alone can fill in a timesheet the technician did not submit: as the app made it, marked
  // as filled in by the CEO. The technician is told; time not accounted for stays on it as it was.
  app.post('/timesheets/:userId/:date/fill', async (req: FastifyRequest<{ Params: { userId: string; date: string } }>) => {
    const userId = parse(Uuid, req.params.userId);
    const date = parse(DateOnly, req.params.date);
    const b = parse(z.object({ note: z.string().trim().max(1000).optional() }), req.body ?? {});
    if (!CEO.includes(req.actor.level)) throw new Refused(403, ['only the CEO fills in a technician\'s timesheet']);
    if (date >= sast()) throw new Refused(400, ['only a finished day can be filled in']);
    return tx(req.db, async c => {
      const t = (await c.query("SELECT full_name FROM users WHERE id = $1 AND login_level = 'technician'", [userId])).rows[0];
      if (!t) throw new Refused(404, ['no such technician']);
      const day = await dayOf(c, userId, date);
      const ts = await saveSheet(c, userId, date, day, new Date().toISOString(), b.note || null, req.actor.id);
      await audit(c, req.actor.id, 'timesheet_filled', 'timesheet', ts, { technicianId: userId, workDate: date, unaccountedMin: day.unaccountedMin });
      await notify(c, userId, 'timesheet', `Your timesheet for ${dayLabel(date)} was filled in by the CEO, as the app made it.`);
      return { id: ts, date, day, filledBy: req.actor.id };
    });
  });

  // ---- Normal hours (for overtime) ----------------------------------------------------------------
  app.get('/timesheets/settings', async req => {
    if (!departmentsFor(req.actor, 'view_timesheets') && req.actor.level !== 'technician') throw new Refused(403, ['timesheets are for HR and department managers']);
    return { ...(await rulesOf(req.db)), canEdit: can(req.actor, 'assign_departments') || can(req.actor, 'manage_access') };
  });
  app.put('/timesheets/settings', async req => {
    if (!can(req.actor, 'assign_departments') && !can(req.actor, 'manage_access')) throw new Refused(403, ['only HR or the CEO sets the normal hours']);
    const b = parse(z.object({ weekdayNormalMin: z.number().int().min(60).max(720), saturdayNormalMin: z.number().int().min(0).max(720) }), req.body);
    return tx(req.db, async c => {
      await c.query(`INSERT INTO timesheet_settings (weekday_normal_min, saturday_normal_min, updated_by) VALUES ($1, $2, $3)
                     ON CONFLICT (company_id) DO UPDATE SET weekday_normal_min = EXCLUDED.weekday_normal_min, saturday_normal_min = EXCLUDED.saturday_normal_min, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [b.weekdayNormalMin, b.saturdayNormalMin, req.actor.id]);
      await audit(c, req.actor.id, 'timesheet_settings', 'company', null, b);
      return b;
    });
  });

  // ---- HR's export ------------------------------------------------------------------------------
  // Individual or group (a department, or everyone), for a day, a week or a month (up to 31 days).
  app.get('/timesheets', async (req: FastifyRequest<{ Querystring: Record<string, string> }>) => {
    const q = parse(z.object({ from: DateOnly, to: DateOnly, userId: Uuid.optional(), departmentId: Uuid.optional(), includeLeft: z.enum(['1', '0']).optional() }), req.query);
    const scope = scopeOf(req.actor);
    if (!scope) throw new Refused(403, ['timesheets are for HR, the CEO and department managers']);
    // People who have left: HR and the CEO, when asked for (or when that one person is asked for).
    const withLeft = scope === 'all' && (q.includeLeft === '1' || !!q.userId);
    if (q.to < q.from) throw new Refused(400, ['the end date is before the start date']);
    const dates = T.daysBetween(q.from, q.to);
    if (dates.length > 31) throw new Refused(400, ['at most 31 days at a time']);
    const today = sast();
    return tx(req.db, async c => {
      const techs = (await c.query(
        `SELECT u.id, u.full_name, u.trade, u.status, d.name AS department FROM users u LEFT JOIN departments d ON d.id = u.department_id
          WHERE u.login_level = 'technician' AND (u.status <> 'left' OR $5::boolean) AND ($1::boolean OR u.department_id = ANY($2))
            AND ($3::uuid IS NULL OR u.id = $3) AND ($4::uuid IS NULL OR u.department_id = $4)
          ORDER BY (u.status = 'left'), d.name NULLS LAST, u.full_name`, [scope === 'all', scope === 'all' ? [] : scope, q.userId ?? null, q.departmentId ?? null, withLeft])).rows;
      if (q.userId && !techs.length) throw new Refused(403, ['not one of your technicians']);
      const rules = await rulesOf(c);
      const technicians = [];
      for (const t of techs) {
        const days: (Awaited<ReturnType<typeof sheetFor>> & { status: string })[] = [];
        for (const date of dates) {
          if (date > today) continue;
          const sh = await sheetFor(c, t.id, date, rules);
          if (!sh.submitted && !sh.day.activity && !sh.weekday && !sh.flags.length) continue;
          days.push({ ...sh, status: sh.submitted ? 'submitted' : date === today ? 'today' : sh.day.activity || sh.weekday ? 'not_submitted' : 'none' });
        }
        const sum = (k: 'travelMin' | 'workMin' | 'pausedMin' | 'unaccountedMin') => days.reduce((n, d) => n + d.day[k], 0);
        const pay = (k: 'paidMin' | 'normalMin' | 'overtimeMin' | 'doubleMin') => days.reduce((n, d) => n + d.pay[k], 0);
        technicians.push({
          id: t.id, full_name: t.full_name, department: t.department, days, left: t.status === 'left',
          totals: { travelMin: sum('travelMin'), workMin: sum('workMin'), pausedMin: sum('pausedMin'), unaccountedMin: sum('unaccountedMin'),
            paidMin: pay('paidMin'), normalMin: pay('normalMin'), overtimeMin: pay('overtimeMin'), doubleMin: pay('doubleMin'),
            jobs: days.reduce((n, d) => n + d.day.jobs.length, 0), flags: days.reduce((n, d) => n + d.flags.length, 0),
            submitted: days.filter(d => d.status === 'submitted').length, notSubmitted: days.filter(d => d.status === 'not_submitted').length },
        });
      }
      await audit(c, req.actor.id, 'timesheets_viewed', 'timesheets', null, q);
      return { from: q.from, to: q.to, generatedAt: new Date().toISOString(), rules, technicians, canFill: CEO.includes(req.actor.level) };
    });
  });

  // ---- Every person's timesheets, all the way back -------------------------------------------------

  // The people whose timesheets someone may open: HR and the CEO everyone, including people who left.
  app.get('/timesheets/people', async req => {
    const scope = scopeOf(req.actor);
    if (!scope) throw new Refused(403, ['timesheets are for HR, the CEO and department managers']);
    const { rows } = await req.db.query(
      `SELECT u.id, u.full_name, u.status = 'left' AS left, t.terminated_on::text AS left_on, d.name AS department
         FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN terminations t ON t.user_id = u.id
        WHERE u.login_level = 'technician' AND ($1::boolean OR (u.status <> 'left' AND u.department_id = ANY($2)))
        ORDER BY (u.status = 'left'), u.full_name`, [scope === 'all', scope === 'all' ? [] : scope]);
    return { people: rows, full: scope === 'all' };
  });

  // One person's timesheets month by month (three months a time, going back to when he started):
  // every day's status and hours, so any previous sheet can be opened.
  app.get('/timesheets/person/:userId/history', async (req: FastifyRequest<{ Params: { userId: string }; Querystring: Record<string, string> }>) => {
    const userId = parse(Uuid, req.params.userId);
    const q = parse(z.object({ before: z.string().regex(/^\d{4}-\d{2}$/).optional() }), req.query);
    return tx(req.db, async c => {
      const u = await personFor(c, req.actor, userId);
      const today = sast();
      const last = [q.before ? addMonths(q.before, -1) : ym(today), u.left_on ? ym(u.left_on) : ym(today)].sort()[0];
      const months = [last, addMonths(last, -1), addMonths(last, -2)].filter(m => m >= ym(u.since));
      const rules = await rulesOf(c);
      const out = [];
      for (const m of months) {
        const end = [addDays(`${addMonths(m, 1)}-01`, -1), addDays(today, -1), u.left_on ?? '9999-12-31'].sort()[0];
        const start = [`${m}-01`, u.since].sort()[1];
        const days: ({ date: string; label: string; status: string; submittedAt: string | null; filledBy: string | null; note: string | null; travelMin: number; workMin: number; unaccountedMin: number; flags: number } & T.Pay)[] = [];
        for (const date of start <= end ? T.daysBetween(start, end) : []) {
          const sh = await sheetFor(c, userId, date, rules);
          if (!sh.submitted && !sh.day.activity && !sh.weekday && !sh.flags.length) continue;
          days.push({ date, label: sh.label, status: sh.submitted ? (sh.submitted.filledBy ? 'filled' : 'submitted') : sh.day.activity || sh.weekday ? 'missing' : 'none',
            submittedAt: sh.submitted?.at ?? null, filledBy: sh.submitted?.filledBy ?? null, note: sh.submitted?.note ?? null,
            travelMin: sh.day.travelMin, workMin: sh.day.workMin, unaccountedMin: sh.day.unaccountedMin, ...sh.pay, flags: sh.flags.length });
        }
        const sum = (k: 'travelMin' | 'workMin' | 'unaccountedMin' | 'normalMin' | 'overtimeMin' | 'doubleMin') => days.reduce((n, d) => n + d[k], 0);
        out.push({ month: m, label: monthLabel(m), days: days.reverse(),
          totals: { travelMin: sum('travelMin'), workMin: sum('workMin'), unaccountedMin: sum('unaccountedMin'), normalMin: sum('normalMin'), overtimeMin: sum('overtimeMin'), doubleMin: sum('doubleMin'),
            submitted: days.filter(d => d.status === 'submitted').length, filled: days.filter(d => d.status === 'filled').length, missing: days.filter(d => d.status === 'missing').length } });
      }
      const oldest = months.at(-1) ?? last;
      await audit(c, req.actor.id, 'timesheet_history_viewed', 'user', userId, { months });
      return { person: { id: u.id, full_name: u.full_name, left: u.status === 'left', left_on: u.left_on, since: u.since }, months: out, older: oldest > ym(u.since) ? oldest : null };
    });
  });

  // The log of one person's timesheets: submitted, filled in by the CEO, flagged as missing (and
  // explained or resolved), and who looked at them. HR and the CEO only.
  app.get('/timesheets/person/:userId/log', async (req: FastifyRequest<{ Params: { userId: string } }>) => {
    const userId = parse(Uuid, req.params.userId);
    if (!FULL.includes(req.actor.level)) throw new Refused(403, ['the timesheet log is for HR and the CEO']);
    return tx(req.db, async c => {
      const u = await personFor(c, req.actor, userId);
      const dept = (await c.query('SELECT department_id FROM users WHERE id = $1', [userId])).rows[0]?.department_id ?? null;
      const ev = (await c.query(
        `SELECT a.at, a.action, a.details, coalesce(x.full_name, 'The app') AS by_name, ts.work_date::text AS ts_date
           FROM audit_log a LEFT JOIN users x ON x.id = a.actor_id
           LEFT JOIN timesheets ts ON a.entity = 'timesheet' AND ts.id::text = a.entity_id
          WHERE (a.action = 'timesheet_submitted' AND a.actor_id = $1)
             OR (a.action = 'timesheet_filled' AND a.details->>'technicianId' = $1::text)
             OR (a.action = 'timesheet_history_viewed' AND a.entity_id = $1::text)
             OR (a.action = 'timesheets_viewed' AND (a.details->>'userId' = $1::text OR (a.details->>'userId' IS NULL AND (a.details->>'departmentId' IS NULL OR a.details->>'departmentId' = $2::text))))
          ORDER BY a.at DESC LIMIT 300`, [userId, dept])).rows;
      const flags = (await c.query(
        `SELECT f.raised_at, f.explained_at, f.explanation, f.resolved_at, f.resolution_note, f.details->>'workDate' AS work_date, r.full_name AS resolved_by
           FROM flags f LEFT JOIN users r ON r.id = f.resolved_by WHERE f.technician_id = $1 AND f.flag_type = 'timesheet_missing' ORDER BY f.raised_at DESC LIMIT 200`, [userId])).rows;
      const day = (d: string | null | undefined) => (d ? dayLabel(d) : '');
      const range = (x: { from?: string; to?: string }) => (x.from ? (x.from === x.to ? day(x.from) : `${day(x.from)} – ${day(x.to)}`) : '');
      const events: { at: string; kind: string; text: string; by: string }[] = [];
      for (const e of ev) {
        const d = e.details ?? {};
        const at = new Date(e.at).toISOString();
        if (e.action === 'timesheet_submitted') events.push({ at, kind: 'submitted', by: e.by_name, text: `Submitted ${day(d.workDate ?? e.ts_date)}${d.unaccountedMin ? ` (${T.hm(d.unaccountedMin)} not accounted for)` : ''}` });
        else if (e.action === 'timesheet_filled') events.push({ at, kind: 'filled', by: e.by_name, text: `Filled in ${day(d.workDate)} for him (he had not submitted it)` });
        else if (e.action === 'timesheet_history_viewed') events.push({ at, kind: 'viewed', by: e.by_name, text: 'Opened his timesheet history' });
        else events.push({ at, kind: 'viewed', by: e.by_name, text: `Looked at ${d.userId ? 'his timesheets' : d.departmentId ? 'his department\'s timesheets' : 'everyone\'s timesheets'} for ${range(d)}` });
      }
      for (const f of flags) {
        events.push({ at: new Date(f.raised_at).toISOString(), kind: 'missing', by: 'The app', text: `Flagged: ${day(f.work_date)} not submitted by 10:00 the next day` });
        if (f.explained_at) events.push({ at: new Date(f.explained_at).toISOString(), kind: 'explained', by: u.full_name, text: `Explained the missing ${day(f.work_date)}: ${f.explanation ?? ''}` });
        if (f.resolved_at) events.push({ at: new Date(f.resolved_at).toISOString(), kind: 'resolved', by: f.resolved_by ?? 'The app', text: `Missing ${day(f.work_date)} closed: ${f.resolution_note ?? ''}` });
      }
      events.sort((a, b) => b.at.localeCompare(a.at));
      return { person: { id: u.id, full_name: u.full_name, left: u.status === 'left' }, events };
    });
  });
}
