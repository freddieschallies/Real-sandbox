// Daily timesheets. The app makes each technician's day from what it recorded; he checks and submits
// the previous day's (a word is needed for time not accounted for). A day not submitted is flagged.
// HR (and a department manager for his own technicians) sees and exports them, with every job and
// flag of the day on each sheet.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, raiseFlag, tx, type Q } from '../db.ts';
import { can, departmentsFor } from '../core/permissions.ts';
import * as T from '../core/timesheet.ts';
import * as W from '../core/worth.ts';
import { kmBetween, ROAD_FACTOR } from '../core/clientRates.ts';
import { companyRates } from './clientRates.ts';
import { DateOnly, Iso, Refused, Uuid, parse } from '../http.ts';
import { notify } from './field.ts';
import { wagesOf } from '../core/pay.ts';
import { payOf } from './pay.ts';

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
async function hoursOf(c: Q): Promise<T.WorkHours> {
  const r = (await c.query('SELECT work_start_min, work_end_min FROM timesheet_settings')).rows[0];
  return r ? { startMin: r.work_start_min, endMin: r.work_end_min } : T.DEFAULT_HOURS;
}

// ---- Office time, trips and hours invoiced on each day ------------------------------------------

/** What a request needs once: the rules, the working hours, each technician's home and vehicle settings, each job's invoices. */
interface Ctx {
  rules: T.PayRules; hours: T.WorkHours; techs: Map<string, { mayTakeHome: boolean; home: { lat: number; lng: number } | null; showPerformance: boolean; costPerHourCents: number | null }>;
  jobs: Map<string, { hours: number; revenueCents: number; people: number; minutes: number; storeAt: { lat: number; lng: number } | null }>;
  workshop: { lat: number; lng: number } | null | undefined;
}
async function ctxOf(c: Q): Promise<Ctx> {
  return { rules: await rulesOf(c), hours: await hoursOf(c), techs: new Map(), jobs: new Map(), workshop: undefined };
}
async function techOf(c: Q, x: Ctx, techId: string) {
  const hit = x.techs.get(techId);
  if (hit) return hit;
  const r = (await c.query('SELECT may_take_vehicle_home, home_lat, home_lng, show_performance, cost_per_hour_cents FROM technician_settings WHERE user_id = $1', [techId])).rows[0];
  const t = { mayTakeHome: !!r?.may_take_vehicle_home, home: r?.home_lat != null ? { lat: r.home_lat, lng: r.home_lng } : null, showPerformance: !!r?.show_performance, costPerHourCents: r?.cost_per_hour_cents ?? null };
  x.techs.set(techId, t);
  return t;
}
/** For each job: the hours invoiced (labour and travel time), what it was invoiced less credit notes, how many technicians, and its minutes of work. */
async function jobsOf(c: Q, x: Ctx, ids: string[]) {
  const need = [...new Set(ids)].filter(id => !x.jobs.has(id));
  if (need.length) {
    const { rows } = await c.query(
      `SELECT j.id, s.lat, s.lng, 1 + (SELECT count(*)::int FROM job_helpers h WHERE h.job_id = j.id) AS people,
              (SELECT coalesce(sum(l.qty) FILTER (WHERE l.kind = 'labour' OR (l.kind = 'travel' AND l.description ILIKE 'travel time%')), 0)
                 FROM document_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.job_id = j.id AND i.status IN ('sent', 'paid'))::float AS hours,
              (SELECT coalesce(sum(round(l.qty * l.unit_price_cents)), 0) FROM document_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.job_id = j.id AND i.status IN ('sent', 'paid'))::bigint
                - (SELECT coalesce(sum(cn.amount_cents), 0) FROM credit_notes cn WHERE cn.job_id = j.id)::bigint AS revenue,
              (SELECT coalesce(sum(extract(epoch FROM (coalesce(v.ended_at, now()) - v.arrived_at)) / 60), 0) FROM job_visits v WHERE v.job_id = j.id AND v.arrived_at IS NOT NULL)
                - (SELECT coalesce(sum(extract(epoch FROM (coalesce(p.resumed_at, v.ended_at, now()) - p.paused_at)) / 60), 0) FROM visit_pauses p JOIN job_visits v ON v.id = p.visit_id WHERE v.job_id = j.id) AS minutes
         FROM jobs j JOIN stores s ON s.id = j.store_id WHERE j.id = ANY($1)`, [need]);
    for (const r of rows) x.jobs.set(r.id, { hours: Number(r.hours), revenueCents: Math.max(0, Number(r.revenue)), people: r.people, minutes: Math.max(0, Number(r.minutes)), storeAt: r.lat != null ? { lat: r.lat, lng: r.lng } : null });
  }
  return x.jobs;
}
async function extrasOf(c: Q, techId: string, date: string): Promise<T.ExtraIn[]> {
  return (await c.query(
    `SELECT e.id, e.kind, e.started_at, e.minutes, e.note, u.full_name AS added_by, (e.added_by <> e.technician_id) AS by_office
       FROM timesheet_extra_time e JOIN users u ON u.id = e.added_by WHERE e.technician_id = $1 AND e.work_date = $2 AND e.removed_at IS NULL ORDER BY e.started_at`, [techId, date])).rows
    .map(r => ({ id: r.id, kind: r.kind, start: new Date(r.started_at).toISOString(), minutes: r.minutes, note: r.note, addedBy: r.added_by, byOffice: r.by_office }));
}
async function tripsOn(c: Q, x: Ctx, techId: string, date: string) {
  const rows = (await c.query(
    `SELECT t.id, t.started_at, t.ended_at, coalesce(t.distance_km, 0)::float AS km, v.registration, t.purpose::text AS purpose, t.start_lat, t.start_lng, t.end_lat, t.end_lng,
            s.name AS store, s.lat AS store_lat, s.lng AS store_lng, a.note AS allowed_note, a.allowed_at, ab.full_name AS allowed_by
       FROM trips t JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN job_visits jv ON jv.id = t.job_visit_id LEFT JOIN jobs j ON j.id = jv.job_id
       LEFT JOIN stores s ON s.id = coalesce(t.destination_store_id, j.store_id) LEFT JOIN trip_allowed a ON a.trip_id = t.id LEFT JOIN users ab ON ab.id = a.allowed_by
      WHERE t.driver_id = $1 AND (t.started_at AT TIME ZONE 'Africa/Johannesburg')::date = $2::date ORDER BY t.started_at`, [techId, date])).rows;
  const tech = await techOf(c, x, techId);
  const all = rows.map(r => T.tripCheck({
    id: r.id, startedAt: new Date(r.started_at).toISOString(), endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null, km: r.km, registration: r.registration, purpose: r.purpose,
    start: r.start_lat != null ? { lat: r.start_lat, lng: r.start_lng } : null, end: r.end_lat != null ? { lat: r.end_lat, lng: r.end_lng } : null,
    store: r.store, storeAt: r.store_lat != null ? { lat: r.store_lat, lng: r.store_lng } : null,
    allowed: r.allowed_by ? { by: r.allowed_by, note: r.allowed_note, at: new Date(r.allowed_at).toISOString() } : null,
  }, { hours: x.hours, mayTakeHome: tech.mayTakeHome, home: tech.home }));
  return { problems: all.filter(t => t.why.length), km: all.reduce((n, t) => n + t.km, 0), tracked: all.length > 0 };
}

/** Every trip between two dates (South African days), checked the same way as on the timesheets, with the
 *  driver's name and department; for one vehicle, or the drivers of some departments. */
export async function tripsBetween(c: Q, from: string, to: string, opts: { vehicleId?: string; departments?: 'all' | string[]; limit?: number } = {}) {
  const x = await ctxOf(c);
  const rows = (await c.query(
    `SELECT t.id, t.started_at, t.ended_at, coalesce(t.distance_km, 0)::float AS km, v.id AS vehicle_id, v.registration, t.purpose::text AS purpose, t.start_lat, t.start_lng, t.end_lat, t.end_lng,
            s.name AS store, s.lat AS store_lat, s.lng AS store_lng, a.note AS allowed_note, a.allowed_at, ab.full_name AS allowed_by,
            t.driver_id, d.full_name AS driver, d.department_id
       FROM trips t JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN users d ON d.id = t.driver_id
       LEFT JOIN job_visits jv ON jv.id = t.job_visit_id LEFT JOIN jobs j ON j.id = jv.job_id
       LEFT JOIN stores s ON s.id = coalesce(t.destination_store_id, j.store_id) LEFT JOIN trip_allowed a ON a.trip_id = t.id LEFT JOIN users ab ON ab.id = a.allowed_by
      WHERE (t.started_at AT TIME ZONE 'Africa/Johannesburg')::date BETWEEN $1::date AND $2::date
        AND ($3::uuid IS NULL OR t.vehicle_id = $3) AND ($4::uuid[] IS NULL OR d.department_id = ANY($4))
      ORDER BY t.started_at DESC LIMIT $5`,
    [from, to, opts.vehicleId ?? null, !opts.departments || opts.departments === 'all' ? null : opts.departments, opts.limit ?? 2000])).rows;
  const out = [];
  for (const r of rows) {
    const tech = r.driver_id ? await techOf(c, x, r.driver_id) : { mayTakeHome: false, home: null };
    const t = T.tripCheck({
      id: r.id, startedAt: new Date(r.started_at).toISOString(), endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null, km: r.km, registration: r.registration, purpose: r.purpose,
      start: r.start_lat != null ? { lat: r.start_lat, lng: r.start_lng } : null, end: r.end_lat != null ? { lat: r.end_lat, lng: r.end_lng } : null,
      store: r.store, storeAt: r.store_lat != null ? { lat: r.store_lat, lng: r.store_lng } : null,
      allowed: r.allowed_by ? { by: r.allowed_by, note: r.allowed_note, at: new Date(r.allowed_at).toISOString() } : null,
    }, { hours: x.hours, mayTakeHome: tech.mayTakeHome, home: tech.home });
    out.push({ ...t, vehicleId: r.vehicle_id as string, driverId: r.driver_id as string | null, driver: r.driver as string | null });
  }
  return out;
}
/** Who may allow a trip (the same people who see that technician's timesheets). */
export const tripScope = (a: Parameters<typeof scopeOf>[0]) => scopeOf(a);

/** The day as everyone sees it: his office time on it, hours invoiced, trips not allowed. Also (for the
 *  CEO and Accounts only, never on the day itself) what his share of the jobs was invoiced, and the km he drove. */
async function fullDay(c: Q, x: Ctx, techId: string, date: string, base: T.Day) {
  const day = T.withExtras(base, await extrasOf(c, techId, date));
  const jobs = await jobsOf(c, x, day.jobs.map(j => j.jobId));
  let invoicedMin = 0, revenueCents = 0, estKm = 0;
  for (const j of day.jobs) {
    const m = jobs.get(j.jobId);
    if (!m || !m.minutes) continue;
    const part = Math.min(1, j.workMin / m.minutes) / m.people;
    invoicedMin += m.hours * 60 * part;
    revenueCents += m.revenueCents * part;
    if (!j.helper && j.arrived) {
      if (x.workshop === undefined) { const w = (await c.query('SELECT lat, lng FROM company_workshop')).rows[0]; x.workshop = w ? { lat: w.lat, lng: w.lng } : null; }
      if (x.workshop && m.storeAt) estKm += kmBetween(x.workshop, m.storeAt) * ROAD_FACTOR * 2;
    }
  }
  const trips = await tripsOn(c, x, techId, date);
  return { day: { ...day, invoicedMin: Math.round(invoicedMin), trips: trips.problems }, revenueCents: Math.round(revenueCents), km: trips.tracked ? trips.km : estKm, kmEstimated: !trips.tracked && estKm > 0 };
}

/** One technician's sheet for one day: what he submitted, or what the app has for the day so far (with his
 *  office time, hours invoiced and trips not allowed), with the pay split. `money` stays on the server side. */
async function sheetFor(c: Q, techId: string, date: string, x?: Ctx) {
  const cx = x ?? await ctxOf(c);
  const ts = (await c.query('SELECT t.submitted_at, t.sheet, t.note, f.full_name AS filled_by FROM timesheets t LEFT JOIN users f ON f.id = t.filled_by WHERE t.technician_id = $1 AND t.work_date = $2', [techId, date])).rows[0];
  const base: T.Day = ts?.sheet ?? await dayOf(c, techId, date);
  const f = await fullDay(c, cx, techId, date, base);
  return { date, label: dayLabel(date), weekday: T.isWeekday(date), submitted: ts ? { at: ts.submitted_at, note: ts.note, filledBy: ts.filled_by ?? null } : null, day: f.day,
    pay: T.payOf(f.day, date, cx.rules), flags: await flagsOn(c, techId, date), money: { revenueCents: f.revenueCents, km: f.km, kmEstimated: f.kmEstimated } };
}

const CEO = ['director', 'creator'];
/** HR and the CEO always see every technician's timesheets, past and present, including people who have left. */
const FULL = ['hr', 'director', 'creator'];
/** Accounts sees them all too (for what each technician makes and costs). */
const ALL = [...FULL, 'accounts'];
const scopeOf = (a: { level: string } & Parameters<typeof departmentsFor>[0]) => (ALL.includes(a.level) ? 'all' as const : departmentsFor(a, 'view_timesheets'));
/** What a technician made and cost the company: the CEO and Accounts only. */
const MONEY = ['director', 'creator', 'accounts'];
/** His performance (when switched on for him): the CEO, Accounts and HR. */
const PERFORMANCE = [...MONEY, 'hr'];
const ym = (date: string) => date.slice(0, 7);
const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const addMonths = (m: string, n: number) => { const d = new Date(`${m}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };

/** One technician someone may see the timesheets of: HR and the CEO everyone (also people who left), a manager his own. */
async function personFor(c: Q, actor: Parameters<typeof scopeOf>[0], userId: string) {
  const scope = scopeOf(actor);
  if (!scope) throw new Refused(403, ['timesheets are for HR, the CEO, Accounts and department managers']);
  const u = (await c.query(
    `SELECT u.id, u.full_name, u.status, u.department_id, (u.created_at AT TIME ZONE 'Africa/Johannesburg')::date::text AS since, t.terminated_on::text AS left_on
       FROM users u LEFT JOIN terminations t ON t.user_id = u.id WHERE u.id = $1 AND u.login_level = 'technician'`, [userId])).rows[0];
  if (!u) throw new Refused(404, ['no such technician']);
  if (scope !== 'all' && (u.status === 'left' || !scope.includes(u.department_id))) throw new Refused(403, ['not one of your technicians']);
  return u as { id: string; full_name: string; status: string; since: string; left_on: string | null };
}

/** Keeps a day's sheet as it is now (it cannot change after), with the minutes per job; closes its missing flag. */
async function saveSheet(c: Q, techId: string, date: string, day: T.Day, unaccountedMin: number, at: string, note: string | null, filledBy: string | null) {
  if ((await c.query('SELECT 1 FROM timesheets WHERE technician_id = $1 AND work_date = $2', [techId, date])).rowCount) throw new Refused(409, ['this day is already submitted; corrections go through the manager']);
  // The day is kept as the app recorded it; his office time stays in its own list (the office can still take it off).
  const ts = (await c.query('INSERT INTO timesheets (technician_id, work_date, submitted_at, sheet, note, unaccounted_min, filled_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [techId, date, at, JSON.stringify(day), note, unaccountedMin, filledBy])).rows[0].id as string;
  const perJob = new Map<string, number>();
  for (const j of day.jobs) perJob.set(j.jobId, (perJob.get(j.jobId) ?? 0) + j.workMin);
  for (const [jobId, m] of perJob) await c.query('INSERT INTO timesheet_lines (timesheet_id, job_id, minutes) VALUES ($1, $2, $3)', [ts, jobId, m]);
  await c.query(`UPDATE flags SET status = 'resolved', resolved_by = $1, resolved_at = now(), resolution_note = $3
                  WHERE technician_id = $2 AND flag_type = 'timesheet_missing' AND details->>'workDate' = $4 AND status <> 'resolved'`,
    [filledBy ?? techId, techId, filledBy ? 'Filled in by the CEO' : 'Timesheet submitted', date]);
  return ts;
}

/** The finished days he still owes a timesheet for: the last week, weekdays and any day he worked. */
async function owed(c: Q, techId: string, x: Ctx) {
  const u = (await c.query("SELECT (created_at AT TIME ZONE 'Africa/Johannesburg')::date::text AS since FROM users WHERE id = $1", [techId])).rows[0];
  const today = sast();
  const from = [addDays(today, -7), u?.since ?? today].sort()[1];
  const out: { date: string; label: string; day: T.Day; pay: T.Pay; overdue: boolean; flags: [] }[] = [];
  for (const date of T.daysBetween(from, addDays(today, -1))) {
    if ((await c.query('SELECT 1 FROM timesheets WHERE technician_id = $1 AND work_date = $2', [techId, date])).rowCount) continue;
    const { day } = await fullDay(c, x, techId, date, await dayOf(c, techId, date));
    if (!T.isWeekday(date) && !day.activity) continue;
    out.push({ date, label: dayLabel(date), day, pay: T.payOf(day, date, x.rules), overdue: date < addDays(today, -1) || sastHour() >= 10, flags: [] });
  }
  return out;
}

/** A day he may still add office time to: today, or a day of the last week he has not submitted. */
async function openDay(c: Q, techId: string, date: string) {
  const today = sast();
  if (date > today) throw new Refused(400, ['not a day in the future']);
  if (date < addDays(today, -7)) throw new Refused(409, ['too long ago: ask your manager']);
  if ((await c.query('SELECT 1 FROM timesheets WHERE technician_id = $1 AND work_date = $2', [techId, date])).rowCount) throw new Refused(409, ['this day is already submitted: ask your manager']);
}

export function registerTimesheetRoutes(app: FastifyInstance) {
  // ---- The technician's own --------------------------------------------------------------------
  app.get('/me/timesheets', async req => {
    if (req.actor.level !== 'technician') return { due: [], recent: [] };
    return tx(req.db, async c => {
      const x = await ctxOf(c);
      const due = await owed(c, req.actor.id, x);
      // A finished day not submitted by 10:00 the next morning is flagged, once.
      for (const d of due.filter(x => x.overdue)) {
        const has = await c.query("SELECT 1 FROM flags WHERE technician_id = $1 AND flag_type = 'timesheet_missing' AND details->>'workDate' = $2", [req.actor.id, d.date]);
        if (!has.rowCount) await raiseFlag(c, { type: 'timesheet_missing', technicianId: req.actor.id, question: `Your timesheet for ${d.label} was not submitted. Check it and submit it now.`, details: { workDate: d.date } });
      }
      const recent = [];
      for (const r of (await c.query(
        `SELECT t.work_date::text AS date, t.submitted_at, t.note, t.sheet, f.full_name AS filled_by FROM timesheets t LEFT JOIN users f ON f.id = t.filled_by WHERE t.technician_id = $1 ORDER BY t.work_date DESC LIMIT 14`, [req.actor.id])).rows.filter(r => r.sheet)) {
        const { day } = await fullDay(c, x, req.actor.id, r.date, r.sheet);
        recent.push({ date: r.date, label: dayLabel(r.date), submitted: { at: r.submitted_at, note: r.note, filledBy: r.filled_by ?? null }, day, pay: T.payOf(day, r.date, x.rules), flags: [] });
      }
      // Today so far: he can add office time as it happens (a meeting this morning).
      const t = sast();
      const { day: todayDay } = await fullDay(c, x, req.actor.id, t, await dayOf(c, req.actor.id, t));
      return { due, recent, today: { date: t, label: dayLabel(t), day: todayDay }, explainFromMin: T.EXPLAIN_FROM_MIN, extraKinds: T.EXTRA_KINDS.map(k => ({ key: k, label: T.EXTRA_LABEL[k] })) };
    });
  });

  app.get('/me/timesheets/:date', async (req: FastifyRequest<{ Params: { date: string } }>) => {
    const date = parse(DateOnly, req.params.date);
    const { money: _m, ...sheet } = await sheetFor(req.db, req.actor.id, date);
    return sheet;
  });

  // Office time he adds himself: what it was, when it started and how long. It counts straight away;
  // his manager, HR or the CEO can take it off (he is told why). Sent again (no signal), it is kept once.
  app.post('/me/timesheets/:date/extra', async (req: FastifyRequest<{ Params: { date: string } }>) => {
    const date = parse(DateOnly, req.params.date);
    const b = parse(z.object({ id: Uuid.optional(), kind: z.enum(T.EXTRA_KINDS), start: Iso, minutes: z.number().int(), note: z.string().trim().max(300).optional() }), req.body);
    if (req.actor.level !== 'technician') throw new Refused(403, ['office time is added by the technician']);
    return tx(req.db, async c => {
      if (b.id) { const had = (await c.query('SELECT id FROM timesheet_extra_time WHERE id = $1 AND technician_id = $2', [b.id, req.actor.id])).rows[0]; if (had) return { id: had.id, again: true }; }
      await openDay(c, req.actor.id, date);
      if (sast(new Date(b.start)) !== date) throw new Refused(400, ['the time is not on that day']);
      if (b.kind === 'other' && (!b.note || b.note.length < 3)) throw new Refused(400, ['say what it was']);
      const day = await dayOf(c, req.actor.id, date);
      const clash = T.extraClash(day, b.start, b.minutes, await extrasOf(c, req.actor.id, date));
      if (clash) throw new Refused(409, [clash]);
      const id = (await c.query(
        'INSERT INTO timesheet_extra_time (id, technician_id, work_date, kind, started_at, minutes, note, added_by) VALUES (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $2) RETURNING id',
        [b.id ?? null, req.actor.id, date, b.kind, b.start, b.minutes, b.note || null])).rows[0].id as string;
      await audit(c, req.actor.id, 'office_time_added', 'timesheet_extra_time', id, { workDate: date, kind: b.kind, minutes: b.minutes });
      return { id };
    });
  });
  // Taken off again by him, before the day is submitted.
  app.delete('/me/timesheets/extra/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const e = (await c.query('SELECT work_date::text AS date FROM timesheet_extra_time WHERE id = $1 AND technician_id = $2 AND removed_at IS NULL', [id, req.actor.id])).rows[0];
      if (!e) throw new Refused(404, ['no such office time']);
      await openDay(c, req.actor.id, e.date);
      await c.query('DELETE FROM timesheet_extra_time WHERE id = $1', [id]);
      await audit(c, req.actor.id, 'office_time_deleted', 'timesheet_extra_time', id, { workDate: e.date });
      return { id, deleted: true };
    });
  });

  app.post('/me/timesheets/:date/submit', async (req: FastifyRequest<{ Params: { date: string } }>) => {
    const date = parse(DateOnly, req.params.date);
    const b = parse(z.object({ at: Iso, note: z.string().trim().max(1000).optional() }), req.body);
    if (req.actor.level !== 'technician') throw new Refused(403, ['timesheets are for technicians']);
    if (date >= sast(new Date(b.at))) throw new Refused(400, ['only a finished day can be submitted']);
    return tx(req.db, async c => {
      const base = await dayOf(c, req.actor.id, date);
      const day = T.withExtras(base, await extrasOf(c, req.actor.id, date));
      if (day.unaccountedMin >= T.EXPLAIN_FROM_MIN && (!b.note || b.note.length < 5)) throw new Refused(400, [`say what the ${T.hm(day.unaccountedMin)} not accounted for was (or add it as office time)`]);
      const ts = await saveSheet(c, req.actor.id, date, base, day.unaccountedMin, b.at, b.note || null, null);
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
      const base = await dayOf(c, userId, date);
      const day = T.withExtras(base, await extrasOf(c, userId, date));
      const ts = await saveSheet(c, userId, date, base, day.unaccountedMin, new Date().toISOString(), b.note || null, req.actor.id);
      await audit(c, req.actor.id, 'timesheet_filled', 'timesheet', ts, { technicianId: userId, workDate: date, unaccountedMin: day.unaccountedMin });
      await notify(c, userId, 'timesheet', `Your timesheet for ${dayLabel(date)} was filled in by the CEO, as the app made it.`);
      return { id: ts, date, day, filledBy: req.actor.id };
    });
  });

  // ---- Normal hours (for overtime) ----------------------------------------------------------------
  app.get('/timesheets/settings', async req => {
    if (!departmentsFor(req.actor, 'view_timesheets') && req.actor.level !== 'technician') throw new Refused(403, ['timesheets are for HR and department managers']);
    const h = await hoursOf(req.db);
    return { ...(await rulesOf(req.db)), workStartMin: h.startMin, workEndMin: h.endMin, canEdit: can(req.actor, 'assign_departments') || can(req.actor, 'manage_access') };
  });
  app.put('/timesheets/settings', async req => {
    if (!can(req.actor, 'assign_departments') && !can(req.actor, 'manage_access')) throw new Refused(403, ['only HR or the CEO sets the normal hours']);
    const b = parse(z.object({ weekdayNormalMin: z.number().int().min(60).max(720), saturdayNormalMin: z.number().int().min(0).max(720),
      workStartMin: z.number().int().min(0).max(1439).optional(), workEndMin: z.number().int().min(1).max(1440).optional() }), req.body);
    if (b.workStartMin !== undefined && b.workEndMin !== undefined && b.workEndMin <= b.workStartMin) throw new Refused(400, ['the working day must end after it starts']);
    return tx(req.db, async c => {
      const h = await hoursOf(c);
      await c.query(`INSERT INTO timesheet_settings (weekday_normal_min, saturday_normal_min, work_start_min, work_end_min, updated_by) VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (company_id) DO UPDATE SET weekday_normal_min = EXCLUDED.weekday_normal_min, saturday_normal_min = EXCLUDED.saturday_normal_min,
                       work_start_min = EXCLUDED.work_start_min, work_end_min = EXCLUDED.work_end_min, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [b.weekdayNormalMin, b.saturdayNormalMin, b.workStartMin ?? h.startMin, b.workEndMin ?? h.endMin, req.actor.id]);
      await audit(c, req.actor.id, 'timesheet_settings', 'company', null, b);
      return b;
    });
  });

  // ---- The office: office time taken off, trips allowed, and per technician what shows ----------------

  // His manager, HR, Accounts or the CEO takes office time off (it stops counting); he is told why.
  app.post('/timesheets/extra/:id/remove', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ reason: z.string().trim().min(5, 'why it is taken off (he is told)').max(500) }), req.body);
    return tx(req.db, async c => {
      const e = (await c.query('SELECT technician_id, work_date::text AS date, kind, minutes FROM timesheet_extra_time WHERE id = $1 AND removed_at IS NULL', [id])).rows[0];
      if (!e) throw new Refused(404, ['no such office time']);
      await personFor(c, req.actor, e.technician_id);
      await c.query('UPDATE timesheet_extra_time SET removed_at = now(), removed_by = $2, removed_reason = $3 WHERE id = $1', [id, req.actor.id, b.reason]);
      await audit(c, req.actor.id, 'office_time_removed', 'timesheet_extra_time', id, { technicianId: e.technician_id, workDate: e.date, reason: b.reason });
      await notify(c, e.technician_id, 'timesheet', `${T.EXTRA_LABEL[e.kind as T.ExtraKind] ?? 'Office time'} (${T.hm(e.minutes)}) on ${dayLabel(e.date)} was taken off your timesheet: ${b.reason}`);
      return { id, removed: true };
    });
  });

  // A trip that looks unauthorised but was allowed (e.g. the manager sent him): it no longer counts.
  app.post('/timesheets/trips/:id/allow', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ note: z.string().trim().min(3, 'why it was allowed').max(500) }), req.body);
    return tx(req.db, async c => {
      const t = (await c.query('SELECT driver_id FROM trips WHERE id = $1', [id])).rows[0];
      if (!t?.driver_id) throw new Refused(404, ['no such trip']);
      await personFor(c, req.actor, t.driver_id);
      await c.query(`INSERT INTO trip_allowed (trip_id, note, allowed_by) VALUES ($1, $2, $3)
                     ON CONFLICT (trip_id) DO UPDATE SET note = EXCLUDED.note, allowed_by = EXCLUDED.allowed_by, allowed_at = now()`, [id, b.note, req.actor.id]);
      await audit(c, req.actor.id, 'trip_allowed', 'trip', id, { technicianId: t.driver_id, note: b.note });
      return { id, allowed: true };
    });
  });
  app.delete('/timesheets/trips/:id/allow', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const t = (await c.query('SELECT driver_id FROM trips WHERE id = $1', [id])).rows[0];
      if (!t?.driver_id) throw new Refused(404, ['no such trip']);
      await personFor(c, req.actor, t.driver_id);
      await c.query('DELETE FROM trip_allowed WHERE trip_id = $1', [id]);
      await audit(c, req.actor.id, 'trip_allowed_undone', 'trip', id, { technicianId: t.driver_id });
      return { id, allowed: false };
    });
  });

  // Per technician, the CEO and Accounts only: show his performance on his monthly timesheet, and what an hour of him costs.
  app.put('/timesheets/worth/:userId', async (req: FastifyRequest<{ Params: { userId: string } }>) => {
    const userId = parse(Uuid, req.params.userId);
    if (!can(req.actor, 'set_pay')) throw new Refused(403, ['only the CEO and Accounts set this']);
    const b = parse(z.object({ showPerformance: z.boolean(), costPerHourCents: z.number().int().min(0).max(10_000_000).nullable().optional() }), req.body);
    return tx(req.db, async c => {
      await personFor(c, req.actor, userId);
      const cost = b.costPerHourCents === undefined ? (await c.query('SELECT cost_per_hour_cents FROM technician_settings WHERE user_id = $1', [userId])).rows[0]?.cost_per_hour_cents ?? null : b.costPerHourCents;
      await c.query(`INSERT INTO technician_settings (user_id, show_performance, cost_per_hour_cents, updated_by) VALUES ($1, $2, $3, $4)
                     ON CONFLICT (user_id) DO UPDATE SET show_performance = EXCLUDED.show_performance, cost_per_hour_cents = EXCLUDED.cost_per_hour_cents, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [userId, b.showPerformance, cost, req.actor.id]);
      await audit(c, req.actor.id, 'technician_worth_settings', 'user', userId, { showPerformance: b.showPerformance, costSet: cost !== null });
      return { userId, showPerformance: b.showPerformance, costPerHourCents: cost };
    });
  });

  // ---- HR's export ------------------------------------------------------------------------------
  // Individual or group (a department, or everyone), for a day, a week or a month (up to 31 days).
  app.get('/timesheets', async (req: FastifyRequest<{ Querystring: Record<string, string> }>) => {
    const q = parse(z.object({ from: DateOnly, to: DateOnly, userId: Uuid.optional(), departmentId: Uuid.optional(), includeLeft: z.enum(['1', '0']).optional() }), req.query);
    const scope = scopeOf(req.actor);
    if (!scope) throw new Refused(403, ['timesheets are for HR, the CEO, Accounts and department managers']);
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
      const x = await ctxOf(c);
      const level = req.actor.level;
      const canMoney = can(req.actor, 'set_pay'), canPerformance = canMoney || PERFORMANCE.includes(level);
      const rates = canPerformance ? await companyRates(c) : null;
      const technicians = [];
      for (const t of techs) {
        const days: (Omit<Awaited<ReturnType<typeof sheetFor>>, 'money'> & { status: string })[] = [];
        let revenueCents = 0, km = 0, kmEstimated = false;
        for (const date of dates) {
          if (date > today) continue;
          const { money, ...sh } = await sheetFor(c, t.id, date, x);
          if (!sh.submitted && !sh.day.activity && !sh.weekday && !sh.flags.length) continue;
          revenueCents += money.revenueCents; km += money.km; kmEstimated ||= money.kmEstimated;
          days.push({ ...sh, status: sh.submitted ? 'submitted' : date === today ? 'today' : sh.day.activity || sh.weekday ? 'not_submitted' : 'none' });
        }
        const sum = (k: 'travelMin' | 'workMin' | 'pausedMin' | 'unaccountedMin' | 'officeMin' | 'invoicedMin') => days.reduce((n, d) => n + (d.day[k] ?? 0), 0);
        const pay = (k: 'paidMin' | 'normalMin' | 'overtimeMin' | 'doubleMin') => days.reduce((n, d) => n + d.pay[k], 0);
        const trips = days.flatMap(d => (d.day.trips ?? []).filter(tr => tr.unauthorised));
        const totals = {
          travelMin: sum('travelMin'), workMin: sum('workMin'), pausedMin: sum('pausedMin'), unaccountedMin: sum('unaccountedMin'), officeMin: sum('officeMin'), invoicedMin: sum('invoicedMin'),
          paidMin: pay('paidMin'), normalMin: pay('normalMin'), overtimeMin: pay('overtimeMin'), doubleMin: pay('doubleMin'),
          jobs: days.reduce((n, d) => n + d.day.jobs.length, 0), flags: days.reduce((n, d) => n + d.flags.length, 0),
          submitted: days.filter(d => d.status === 'submitted').length, notSubmitted: days.filter(d => d.status === 'not_submitted').length,
          unauthorisedTrips: trips.length, unauthorisedKm: Math.round(trips.reduce((n, tr) => n + tr.km, 0)),
        };
        // His performance (CEO, Accounts, HR) when switched on for him; the money part for the CEO and Accounts only.
        const settings = await techOf(c, x, t.id);
        let performance: W.PerfLine[] | null = null, money: W.PerfLine[] | null = null, verdict: W.Worth['verdict'] | null = null;
        if (canPerformance && settings.showPerformance) {
          const callbacks = Number((await c.query(
            `SELECT count(*)::int AS n FROM jobs j JOIN job_no_charge n ON n.job_id = j.id WHERE j.lead_technician_id = $1 AND n.reason = 'callback'
                AND (j.closed_at AT TIME ZONE 'Africa/Johannesburg')::date BETWEEN $2 AND $3`, [t.id, q.from, q.to])).rows[0].n);
          const jobsDone = days.flatMap(d => d.day.jobs.filter(j => !j.helper));
          const w = W.worthOf({
            days: days.filter(d => d.pay.paidMin > 0).length, paidMin: totals.paidMin, workMin: totals.workMin, travelMin: totals.travelMin, officeMin: totals.officeMin,
            unaccountedMin: totals.unaccountedMin, invoicedMin: totals.invoicedMin,
            jobsFinished: jobsDone.filter(j => j.result === 'Finished').length, jobsUnfinished: jobsDone.filter(j => j.result.startsWith('Continue later')).length,
            callbacks, flags: totals.flags, missingSheets: totals.notSubmitted, unauthorisedTrips: totals.unauthorisedTrips, unauthorisedKm: totals.unauthorisedKm,
            km, kmEstimated, revenueCents, costPerHourCents: settings.costPerHourCents ?? rates?.labour_cost_per_hour ?? 0, costPerKmCents: rates?.vehicle_cost_per_km ?? 0,
          });
          performance = W.performanceLines(w);
          if (canMoney) { money = W.moneyLines(w); verdict = w.verdict; }
        }
        // His wages for the period (from his pay on his profile): the CEO and Accounts only.
        const wages = canMoney ? wagesOf(totals, await payOf(c, t.id)) : null;
        technicians.push({
          id: t.id, full_name: t.full_name, department: t.department, days, left: t.status === 'left', totals, performance, money, verdict, wages,
          settings: canMoney ? { showPerformance: settings.showPerformance, costPerHourCents: settings.costPerHourCents } : canPerformance ? { showPerformance: settings.showPerformance } : null,
        });
      }
      await audit(c, req.actor.id, 'timesheets_viewed', 'timesheets', null, q);
      return { from: q.from, to: q.to, generatedAt: new Date().toISOString(), rules: x.rules, hours: x.hours, technicians, canFill: CEO.includes(req.actor.level), canMoney, canPerformance,
        companyCostPerHourCents: canMoney ? rates?.labour_cost_per_hour ?? 0 : null };
    });
  });

  // ---- Every person's timesheets, all the way back -------------------------------------------------

  // The people whose timesheets someone may open: HR and the CEO everyone, including people who left.
  app.get('/timesheets/people', async req => {
    const scope = scopeOf(req.actor);
    if (!scope) throw new Refused(403, ['timesheets are for HR, the CEO, Accounts and department managers']);
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
      const x = await ctxOf(c);
      const out = [];
      for (const m of months) {
        const end = [addDays(`${addMonths(m, 1)}-01`, -1), addDays(today, -1), u.left_on ?? '9999-12-31'].sort()[0];
        const start = [`${m}-01`, u.since].sort()[1];
        const days: ({ date: string; label: string; status: string; submittedAt: string | null; filledBy: string | null; note: string | null; travelMin: number; workMin: number; unaccountedMin: number; flags: number } & T.Pay)[] = [];
        for (const date of start <= end ? T.daysBetween(start, end) : []) {
          const sh = await sheetFor(c, userId, date, x);
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
