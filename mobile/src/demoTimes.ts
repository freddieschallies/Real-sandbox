// Demo timesheets: past days made up the same way each time (a few jobs a day with travel, work,
// the odd break or trip for parts, sometimes time not accounted for), and the demo technician's real
// jobs for today. Most past days are submitted; Thabo still owes yesterday's and Ayanda owes a few.
import * as T from '../../server/src/core/timesheet.ts';
import type { Flag } from './types.ts';
import type { DemoOfficeState } from './demoOffice.ts';
import { mayHaveIncidents } from './demoReal.ts';

export interface DemoTimesState { submitted: Record<string, { at: string; note: string | null; day: T.Day; filledBy?: string | null }>; seeded?: boolean; rules?: T.PayRules;
  /** Who looked at timesheets (the log HR and the CEO see). */ views?: { at: string; by: string; userId: string | null; departmentId: string | null; from?: string; to?: string; history?: boolean }[] }
export interface RealVisit { jobId: string; jobNumber: number; store: string; fault: string; techIds: string[]; visits: { goAt?: string; arrivedAt?: string; startedAt?: string; endedAt?: string; state: string; pauses: { reason: string; at: string; resumedAt?: string }[] }[] }

type Res = { ok: true; body: unknown } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown): Res => ({ ok: true, body });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });

const sast = (d: Date = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const addDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayLabel = (date: string) => new Date(`${date}T12:00:00+02:00`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
const at = (date: string, min: number) => `${date}T${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}:00+02:00`;
const sastDateOf = (iso: string) => sast(new Date(iso));
const addMonths = (m: string, n: number) => { const d = new Date(`${m}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function rng(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const FAULTS = ['Display fridge not cooling', 'Ice machine leaking', 'Oven door seal torn', 'Cold room alarm going off', 'Bakery oven not heating', 'Freezer iced up',
  'Dishwasher not draining', 'Lights tripping in the deli', 'Geyser leaking in the staff room', 'Blocked drain behind the prep area', 'Condenser fan noisy'];
const NOTES = ['Loaded the van at the yard and waited for stock from the stockroom.', 'Waited for the store manager to open the plant room.', 'Fuel and a quick stop at the office for a key.', 'Waited at the yard for the vehicle to come back from the workshop.'];

export class DemoTimes {
  constructor(public t: DemoTimesState, private o: DemoOfficeState, private flags: Flag[], private real: RealVisit[]) {
    if (!t.seeded) {
      // Ayanda has not submitted his last few days: flagged, as the server does.
      for (const date of this.missingSeed('tech-3')) {
        if (!this.flags.some(f => f.flag_type === 'timesheet_missing' && f.tech === 'tech-3' && f.details?.workDate === date)) {
          this.flags.push({ id: `flag-ts-tech-3-${date}`, flag_type: 'timesheet_missing', severity: 'normal', raised_at: `${addDays(date, 1)}T10:00:00+02:00`, status: 'open',
            question: `Your timesheet for ${dayLabel(date)} was not submitted. Check it and submit it now.`, explanation: null, details: { workDate: date }, tech: 'tech-3' });
        }
      }
      t.seeded = true;
    }
  }

  private name(id: string) { return this.person(id)?.p.full_name ?? id; }
  /** Someone on the staff, or someone who has left (with the day they left). */
  person(id: string) {
    const p = this.o.people.find(x => x.id === id);
    if (p) return { p, leftOn: null as string | null };
    const l = (this.o.leavers ?? []).find(x => x.person.id === id);
    return l ? { p: l.person, leftOn: l.date } : null;
  }
  /** The demo keeps four months of history. */
  since() { return `${addMonths(sast().slice(0, 7), -3)}-01`; }
  private missingSeed(techId: string) {
    const y = addDays(sast(), -1);
    const days = [y, addDays(y, -1), addDays(y, -2), addDays(y, -3)].filter(T.isWeekday);
    return techId === 'tech-3' ? days.slice(0, 2) : techId === 'me' ? [y].filter(T.isWeekday) : [];
  }

  /** What the app has for him on that day. */
  dayOf(techId: string, date: string): T.Day {
    const real = this.real.filter(r => r.techIds.includes(techId)).flatMap(r => (r.visits ?? []).filter(v => v.goAt && sastDateOf(v.goAt) === date).map(v => ({
      jobId: r.jobId, jobNumber: r.jobNumber, store: r.store, fault: r.fault, goAt: v.goAt ?? null, arrivedAt: v.arrivedAt ?? null, startedAt: v.startedAt ?? null, endedAt: v.endedAt ?? null,
      pauses: (v.pauses ?? []).map(p => ({ reason: p.reason as T.PauseReason, at: p.at, resumedAt: p.resumedAt ?? null })), state: v.state, helper: r.techIds[0] !== techId,
    })));
    if (real.length || date >= sast()) return T.buildDay(real, []);
    return this.synth(techId, date);
  }

  private synth(techId: string, date: string): T.Day {
    const r = rng(`${techId}|${date}`);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const who = this.person(techId);
    const p = who?.p;
    if (!p || p.login_level !== 'technician' || dow === 0 || (dow === 6 && r() > 0.25) || (who!.leftOn && date > who!.leftOn) || date < this.since()) return T.buildDay([], []);
    const stores = this.o.stores;
    const reg = { me: 'ND 412-778', 'tech-2': 'ND 503-221', 'tech-3': 'ND 771-330', 'tech-4': 'ND 503-221' }[techId] ?? 'ND 412-778';
    const scan = 7 * 60 + Math.round(r() * 40);
    // Long gaps (time not accounted for) only for someone who may carry example incidents: in the
    // real-data demo that is the Example Tech alone.
    const gaps = mayHaveIncidents(techId);
    const first = r() < 0.2 && gaps ? 45 + Math.round(r() * 35) : 10 + Math.round(r() * 15);
    let cursor = scan + (gaps ? first : 5 + Math.round(first % 8));
    const endBy = dow === 6 ? 12 * 60 : 16 * 60 + 30;
    const visits: T.VisitIn[] = [];
    let hadBreak = false;
    for (let i = 0; i < 4 && cursor < endBy - 60; i++) {
      const travel = 15 + Math.round(r() * 30);
      const onSite = 60 + Math.round(r() * 90);
      const go = cursor, arrived = go + travel, ended = arrived + onSite;
      const pauses: T.VisitIn['pauses'] = [];
      if (!hadBreak && ended > 12 * 60 && r() < 0.6) { const b = Math.max(arrived + 20, 12 * 60); if (b + 30 < ended) { pauses.push({ reason: 'break', at: at(date, b), resumedAt: at(date, b + 30) }); hadBreak = true; } }
      if (r() < 0.15) { const b = arrived + 25; pauses.push({ reason: 'collecting_parts', at: at(date, b), resumedAt: at(date, b + 20 + Math.round(r() * 20)) }); }
      const st = stores[Math.floor(r() * stores.length)];
      const cont = r() < 0.15;
      visits.push({ jobId: `demo-${techId}-${date}-${i}`, jobNumber: 9800 + Math.floor(r() * 190), store: st.name, fault: FAULTS[Math.floor(r() * FAULTS.length)],
        goAt: at(date, go), arrivedAt: at(date, arrived), startedAt: at(date, arrived + 5), endedAt: at(date, ended), pauses,
        state: cont ? 'continue_later' : 'done', progressNote: cont ? 'Part ordered, back tomorrow' : null });
      const gap = r() < 0.1 && gaps ? 40 + Math.round(r() * 30) : Math.round(r() * 12);
      cursor = ended + (gaps ? gap : Math.round(gap / 3));
    }
    return T.buildDay(visits, [{ at: at(date, scan), registration: reg, mode: techId === 'tech-4' ? 'riding_along' : 'driving' }], at(date, 23 * 60));
  }

  private flagsOn(techId: string, date: string) {
    return this.flags.filter(f => (f.tech ?? 'me') === techId && (sastDateOf(f.raised_at) === date || f.details?.workDate === date))
      .map(f => ({ id: f.id, flag_type: f.flag_type, question: f.question, explanation: f.explanation, status: f.status, resolution_note: f.resolution_note ?? null }));
  }

  private submitted(techId: string, date: string) {
    const k = `${techId}|${date}`;
    if (this.t.submitted[k]) return this.t.submitted[k];
    // Seeded: every finished day before the ones still owed was submitted the next morning.
    const y = addDays(sast(), -1);
    if (date > y || this.missingSeed(techId).includes(date) || date < this.since()) return null;
    if (techId === 'me' && date === y) return null;
    const day = this.dayOf(techId, date);
    if (!day.activity) return null;
    const r = rng(`sub|${techId}|${date}`);
    return { at: `${addDays(date, 1)}T07:${String(5 + Math.floor(r() * 40)).padStart(2, '0')}:00+02:00`, note: day.unaccountedMin >= T.EXPLAIN_FROM_MIN ? NOTES[Math.floor(r() * NOTES.length)] : null, day };
  }

  rules(): T.PayRules { return this.t.rules ?? T.DEFAULT_PAY; }
  setRules(b: { weekdayNormalMin?: number; saturdayNormalMin?: number }): Res {
    const w = Number(b.weekdayNormalMin), sa = Number(b.saturdayNormalMin);
    if (!(w >= 60 && w <= 720) || !(sa >= 0 && sa <= 720)) return bad(400, 'hours like 8:00 (between 1 and 12 hours on a weekday)');
    this.t.rules = { weekdayNormalMin: w, saturdayNormalMin: sa };
    return good(this.t.rules);
  }

  sheet(techId: string, date: string) {
    const sub = this.submitted(techId, date);
    const day = sub?.day ?? this.dayOf(techId, date);
    return { date, label: dayLabel(date), weekday: T.isWeekday(date), submitted: sub ? { at: sub.at, note: sub.note, filledBy: (sub as { filledBy?: string | null }).filledBy ?? null } : null, day, pay: T.payOf(day, date, this.rules()), flags: this.flagsOn(techId, date) };
  }

  mine(techId: string) {
    const today = sast();
    const due = [];
    for (const date of T.daysBetween(addDays(today, -7), addDays(today, -1))) {
      if (this.submitted(techId, date)) continue;
      const day = this.dayOf(techId, date);
      if (!T.isWeekday(date) && !day.activity) continue;
      due.push({ ...this.sheet(techId, date), overdue: date < addDays(today, -1) || Number(new Date().toLocaleString('en-GB', { timeZone: 'Africa/Johannesburg', hour: '2-digit', hour12: false })) >= 10 });
    }
    for (const d of due.filter(x => x.overdue && mayHaveIncidents(techId))) {
      if (!this.flags.some(f => f.flag_type === 'timesheet_missing' && (f.tech ?? 'me') === techId && f.details?.workDate === d.date)) {
        this.flags.push({ id: `flag-ts-${techId}-${d.date}`, flag_type: 'timesheet_missing', severity: 'normal', raised_at: new Date().toISOString(), status: 'open',
          question: `Your timesheet for ${d.label} was not submitted. Check it and submit it now.`, explanation: null, details: { workDate: d.date }, ...(techId === 'me' ? {} : { tech: techId }) });
      }
    }
    const recent = T.daysBetween(addDays(today, -14), addDays(today, -1)).reverse().map(date => ({ date, sub: this.submitted(techId, date) })).filter(x => x.sub).slice(0, 10)
      .map(x => ({ ...this.sheet(techId, x.date) }));
    return { due, recent, explainFromMin: T.EXPLAIN_FROM_MIN };
  }

  submit(techId: string, date: string, b: { at?: string; note?: string }): Res {
    if (date >= sast(new Date(b.at ?? Date.now()))) return bad(400, 'only a finished day can be submitted');
    if (this.submitted(techId, date)) return bad(409, 'this day is already submitted; corrections go through your manager');
    const day = this.dayOf(techId, date);
    const note = b.note?.trim() || null;
    if (day.unaccountedMin >= T.EXPLAIN_FROM_MIN && (!note || note.length < 5)) return bad(400, `say what the ${T.hm(day.unaccountedMin)} not accounted for was`);
    this.t.submitted[`${techId}|${date}`] = { at: b.at ?? new Date().toISOString(), note, day };
    for (const f of this.flags) if (f.flag_type === 'timesheet_missing' && (f.tech ?? 'me') === techId && f.details?.workDate === date && f.status !== 'resolved') Object.assign(f, { status: 'resolved', resolution_note: 'Timesheet submitted' });
    return good({ date, day });
  }

  /** The CEO fills in a day the technician did not submit, as the app made it. */
  fill(techId: string, date: string, by: string): Res {
    if (date >= sast()) return bad(400, 'only a finished day can be filled in');
    if (!this.o.people.some(p => p.id === techId && p.login_level === 'technician')) return bad(404, 'no such technician');
    if (this.submitted(techId, date)) return bad(409, 'this day is already submitted; corrections go through the manager');
    this.t.submitted[`${techId}|${date}`] = { at: new Date().toISOString(), note: null, day: this.dayOf(techId, date), filledBy: by };
    for (const f of this.flags) if (f.flag_type === 'timesheet_missing' && (f.tech ?? 'me') === techId && f.details?.workDate === date && f.status !== 'resolved') Object.assign(f, { status: 'resolved', resolution_note: 'Filled in by the CEO' });
    return good({ date });
  }

  exportFor(from: string, to: string, techs: { id: string; department: string | null }[], canFill = false): Res {
    if (to < from) return bad(400, 'the end date is before the start date');
    const dates = T.daysBetween(from, to);
    if (dates.length > 31) return bad(400, 'at most 31 days at a time');
    const today = sast();
    return good({
      from, to, generatedAt: new Date().toISOString(), rules: this.rules(), canFill,
      technicians: techs.map(t => {
        const days = dates.filter(d => d <= today).map(d => this.sheet(t.id, d))
          .filter(s => s.submitted || s.day.activity || s.weekday || s.flags.length)
          .map(s => ({ ...s, status: s.submitted ? 'submitted' : s.date === today ? 'today' : s.day.activity || s.weekday ? 'not_submitted' : 'none' }));
        const sum = (k: 'travelMin' | 'workMin' | 'pausedMin' | 'unaccountedMin') => days.reduce((n, d) => n + d.day[k], 0);
        const pay = (k: 'paidMin' | 'normalMin' | 'overtimeMin' | 'doubleMin') => days.reduce((n, d) => n + d.pay[k], 0);
        return { id: t.id, full_name: this.name(t.id), department: t.department, days,
          totals: { travelMin: sum('travelMin'), workMin: sum('workMin'), pausedMin: sum('pausedMin'), unaccountedMin: sum('unaccountedMin'),
            paidMin: pay('paidMin'), normalMin: pay('normalMin'), overtimeMin: pay('overtimeMin'), doubleMin: pay('doubleMin'),
            jobs: days.reduce((n, d) => n + d.day.jobs.length, 0), flags: days.reduce((n, d) => n + d.flags.length, 0),
            submitted: days.filter(d => d.status === 'submitted').length, notSubmitted: days.filter(d => d.status === 'not_submitted').length } };
      }),
    });
  }

  viewed(v: { by: string; userId: string | null; departmentId: string | null; from?: string; to?: string; history?: boolean }) {
    (this.t.views ??= []).unshift({ at: new Date().toISOString(), ...v });
    this.t.views.splice(300);
  }

  /** One person's timesheets month by month, three months a time. */
  history(techId: string, before?: string | null) {
    const who = this.person(techId);
    if (!who) return bad(404, 'no such technician');
    const today = sast();
    const since = this.since();
    const last = [before ? addMonths(before, -1) : today.slice(0, 7), who.leftOn ? who.leftOn.slice(0, 7) : today.slice(0, 7)].sort()[0];
    const months = [last, addMonths(last, -1), addMonths(last, -2)].filter(m => m >= since.slice(0, 7));
    const out = months.map(m => {
      const end = [addDays(`${addMonths(m, 1)}-01`, -1), addDays(today, -1), who.leftOn ?? '9999-12-31'].sort()[0];
      const start = [`${m}-01`, since].sort()[1];
      const days = (start <= end ? T.daysBetween(start, end) : []).map(date => this.sheet(techId, date))
        .filter(sh => sh.submitted || sh.day.activity || sh.weekday || sh.flags.length)
        .map(sh => ({ date: sh.date, label: sh.label, status: sh.submitted ? (sh.submitted.filledBy ? 'filled' : 'submitted') : sh.day.activity || sh.weekday ? 'missing' : 'none',
          submittedAt: sh.submitted?.at ?? null, filledBy: sh.submitted?.filledBy ?? null, note: sh.submitted?.note ?? null,
          travelMin: sh.day.travelMin, workMin: sh.day.workMin, unaccountedMin: sh.day.unaccountedMin, ...sh.pay, flags: sh.flags.length }));
      const sum = (k: 'travelMin' | 'workMin' | 'unaccountedMin' | 'normalMin' | 'overtimeMin' | 'doubleMin') => days.reduce((n, d) => n + d[k], 0);
      return { month: m, label: monthLabel(m), days: days.reverse(), totals: { travelMin: sum('travelMin'), workMin: sum('workMin'), unaccountedMin: sum('unaccountedMin'),
        normalMin: sum('normalMin'), overtimeMin: sum('overtimeMin'), doubleMin: sum('doubleMin'),
        submitted: days.filter(d => d.status === 'submitted').length, filled: days.filter(d => d.status === 'filled').length, missing: days.filter(d => d.status === 'missing').length } };
    });
    const oldest = months.at(-1) ?? last;
    return good({ person: { id: techId, full_name: who.p.full_name, left: !!who.leftOn, left_on: who.leftOn, since }, months: out, older: oldest > since.slice(0, 7) ? oldest : null });
  }

  /** The log of one person's timesheets: submitted, filled in, missing, explained, closed, and who looked. */
  log(techId: string, deptOf: (id: string) => string | null) {
    const who = this.person(techId);
    if (!who) return bad(404, 'no such technician');
    const events: { at: string; kind: string; text: string; by: string }[] = [];
    const today = sast();
    for (const date of T.daysBetween(this.since(), addDays(today, -1))) {
      const sub = this.submitted(techId, date);
      if (!sub) continue;
      const by = (sub as { filledBy?: string | null }).filledBy;
      events.push(by ? { at: sub.at, kind: 'filled', by, text: `Filled in ${dayLabel(date)} for him (he had not submitted it)` }
        : { at: sub.at, kind: 'submitted', by: who.p.full_name, text: `Submitted ${dayLabel(date)}${sub.day.unaccountedMin >= T.EXPLAIN_FROM_MIN ? ` (${T.hm(sub.day.unaccountedMin)} not accounted for)` : ''}` });
    }
    for (const f of this.flags.filter(f => f.flag_type === 'timesheet_missing' && (f.tech ?? 'me') === techId)) {
      const d = String(f.details?.workDate ?? '');
      events.push({ at: f.raised_at, kind: 'missing', by: 'The app', text: `Flagged: ${dayLabel(d)} not submitted by 10:00 the next day` });
      if (f.explanation) events.push({ at: f.raised_at, kind: 'explained', by: who.p.full_name, text: `Explained the missing ${dayLabel(d)}: ${f.explanation}` });
      if (f.status === 'resolved') {
        const sub = this.t.submitted[`${techId}|${d}`];
        events.push({ at: sub?.at ?? f.raised_at, kind: 'resolved', by: sub?.filledBy ?? who.p.full_name, text: `Missing ${dayLabel(d)} closed: ${f.resolution_note ?? ''}` });
      }
    }
    const dept = deptOf(techId);
    const range = (v: { from?: string; to?: string }) => (v.from ? (v.from === v.to ? dayLabel(v.from) : `${dayLabel(v.from)} – ${dayLabel(v.to ?? v.from)}`) : '');
    for (const v of this.t.views ?? []) {
      if (v.history && v.userId === techId) events.push({ at: v.at, kind: 'viewed', by: v.by, text: 'Opened his timesheet history' });
      else if (!v.history && (v.userId === techId || (!v.userId && (!v.departmentId || v.departmentId === dept)))) {
        events.push({ at: v.at, kind: 'viewed', by: v.by, text: `Looked at ${v.userId ? 'his timesheets' : v.departmentId ? 'his department\'s timesheets' : 'everyone\'s timesheets'} for ${range(v)}` });
      }
    }
    events.sort((a, b) => b.at.localeCompare(a.at));
    return good({ person: { id: techId, full_name: who.p.full_name, left: !!who.leftOn }, events });
  }
}
