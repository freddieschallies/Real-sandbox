// A technician's day, worked out from what the app recorded: each job (when he pressed Go, arrived,
// started and finished, and pauses), and when he scanned into a vehicle. Nothing is typed in.
//
//   Travel        Go → arrived on site, plus time out collecting parts
//   Work          arrived → finished, less pauses
//   Paused        breaks and other pauses, with the reason he gave
//   Not accounted the rest of his day: from his first scan or Go to his last job finished

export type PauseReason = 'waiting_for_parts' | 'store_asked_to_stop' | 'collecting_parts' | 'break';
export const PAUSE_LABEL: Record<PauseReason, string> = {
  waiting_for_parts: 'Waiting for parts', store_asked_to_stop: 'Store asked to stop', collecting_parts: 'Collecting parts', break: 'Break',
};

export interface VisitIn {
  jobId: string; jobNumber: number; store: string; fault: string;
  goAt: string | null; arrivedAt: string | null; startedAt: string | null; endedAt: string | null;
  pauses: { reason: PauseReason; at: string; resumedAt: string | null }[];
  /** done, continue_later, … and what he wrote when leaving it unfinished */
  state: string; progressNote?: string | null; helper?: boolean;
}
export interface ScanIn { at: string; registration: string; mode: string }

export interface DayJob {
  jobId: string; jobNumber: number; store: string; fault: string;
  go: string | null; arrived: string | null; ended: string | null;
  travelMin: number; workMin: number; pausedMin: number;
  pauses: { reason: PauseReason; label: string; minutes: number }[];
  result: string; helper: boolean;
}
export interface Day {
  start: string | null; end: string | null; spanMin: number;
  travelMin: number; workMin: number; pausedMin: number; unaccountedMin: number;
  jobs: DayJob[]; vehicles: string[]; activity: boolean;
}

/** Time not accounted for that needs a word from the technician when he submits. */
export const EXPLAIN_FROM_MIN = 30;

const ms = (s: string) => new Date(s).getTime();
const mins = (a: number, b: number) => Math.max(0, Math.round((b - a) / 60000));

export function buildDay(visits: VisitIn[], scans: ScanIn[], now: string = new Date().toISOString()): Day {
  const nowMs = ms(now);
  const sorted = [...visits].sort((a, b) => ms(a.goAt ?? a.arrivedAt ?? a.endedAt ?? now) - ms(b.goAt ?? b.arrivedAt ?? b.endedAt ?? now));
  const jobs: DayJob[] = sorted.map(v => {
    const go = v.goAt ? ms(v.goAt) : null;
    const arrived = v.arrivedAt ? ms(v.arrivedAt) : null;
    const ended = v.endedAt ? ms(v.endedAt) : arrived !== null ? Math.max(arrived, nowMs) : null; // still on site: up to now
    const travel = go !== null && arrived !== null ? mins(go, arrived) : 0;
    const pauses = v.pauses.map(p => {
      const to = p.resumedAt ? ms(p.resumedAt) : ended ?? ms(p.at);
      return { reason: p.reason, label: PAUSE_LABEL[p.reason], minutes: mins(ms(p.at), to) };
    });
    const onSite = arrived !== null && ended !== null ? mins(arrived, ended) : 0;
    const parts = pauses.filter(p => p.reason === 'collecting_parts').reduce((n, p) => n + p.minutes, 0);
    const paused = pauses.filter(p => p.reason !== 'collecting_parts').reduce((n, p) => n + p.minutes, 0);
    const result = v.state === 'done' ? 'Finished' : v.state === 'continue_later' ? `Continue later${v.progressNote ? `: ${v.progressNote}` : ''}`
      : v.state === 'on_the_way' ? 'On the way' : v.endedAt ? 'Left site' : 'Still on site';
    return {
      jobId: v.jobId, jobNumber: v.jobNumber, store: v.store, fault: v.fault,
      go: v.goAt, arrived: v.arrivedAt, ended: v.endedAt,
      travelMin: travel + parts, workMin: Math.max(0, onSite - parts - paused), pausedMin: paused, pauses, result, helper: !!v.helper,
    };
  });
  const starts = [...visits.map(v => v.goAt ?? v.arrivedAt), ...scans.map(s => s.at)].filter(Boolean).map(s => ms(s!));
  const ends = visits.map(v => v.endedAt ?? (v.arrivedAt ? now : v.goAt)).filter(Boolean).map(s => ms(s!));
  const start = starts.length ? Math.min(...starts) : null;
  const end = ends.length ? Math.max(...ends) : null;
  const span = start !== null && end !== null && end > start ? mins(start, end) : 0;
  const travelMin = jobs.reduce((n, j) => n + j.travelMin, 0);
  const workMin = jobs.reduce((n, j) => n + j.workMin, 0);
  const pausedMin = jobs.reduce((n, j) => n + j.pausedMin, 0);
  return {
    start: start !== null ? new Date(start).toISOString() : null, end: end !== null && span > 0 ? new Date(end).toISOString() : null, spanMin: span,
    travelMin, workMin, pausedMin, unaccountedMin: Math.max(0, span - travelMin - workMin - pausedMin),
    jobs, vehicles: [...new Set(scans.map(s => s.registration))], activity: visits.length > 0 || scans.length > 0,
  };
}

/** 0:00 style hours and minutes. */
export const hm = (m: number) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}`;

/** Days from a to b inclusive, as YYYY-MM-DD. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}
export const isWeekday = (date: string) => { const d = new Date(`${date}T12:00:00Z`).getUTCDay(); return d >= 1 && d <= 5; };

// ---- Pay: normal time, overtime and double time --------------------------------------------------
// Paid time is travel plus work (pauses and time not accounted for are not paid). On a weekday the
// first hours up to the normal day are normal time and the rest overtime (1.5×); Saturday is normal
// up to the Saturday hours (none by default) and overtime after; Sundays and public holidays are
// double time (2×). The normal hours are the company's setting.

export interface PayRules { weekdayNormalMin: number; saturdayNormalMin: number }
export const DEFAULT_PAY: PayRules = { weekdayNormalMin: 8 * 60, saturdayNormalMin: 0 };
export interface Pay { paidMin: number; normalMin: number; overtimeMin: number; doubleMin: number; dayType: 'weekday' | 'saturday' | 'sunday' | 'holiday'; holiday: string | null }

export function payOf(day: Day, date: string, rules: PayRules = DEFAULT_PAY): Pay {
  const paid = day.travelMin + day.workMin;
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  const holiday = publicHoliday(date);
  if (holiday || dow === 0) return { paidMin: paid, normalMin: 0, overtimeMin: 0, doubleMin: paid, dayType: holiday ? 'holiday' : 'sunday', holiday };
  const normalCap = dow === 6 ? rules.saturdayNormalMin : rules.weekdayNormalMin;
  const normal = Math.min(paid, normalCap);
  return { paidMin: paid, normalMin: normal, overtimeMin: paid - normal, doubleMin: 0, dayType: dow === 6 ? 'saturday' : 'weekday', holiday: null };
}

/** South African public holidays (a holiday on a Sunday moves to the Monday). */
export function publicHoliday(date: string): string | null {
  const y = Number(date.slice(0, 4));
  const list = holidaysOf(y);
  return list.get(date) ?? null;
}
const cache = new Map<number, Map<string, string>>();
function holidaysOf(y: number) {
  const hit = cache.get(y);
  if (hit) return hit;
  const m = new Map<string, string>();
  const iso = (mo: number, d: number) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const add = (date: string, name: string) => {
    m.set(date, name);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 0) { const n = new Date(`${date}T12:00:00Z`); n.setUTCDate(n.getUTCDate() + 1); m.set(n.toISOString().slice(0, 10), `${name} (observed)`); }
  };
  add(iso(1, 1), "New Year's Day"); add(iso(3, 21), 'Human Rights Day'); add(iso(4, 27), 'Freedom Day'); add(iso(5, 1), "Workers' Day");
  add(iso(6, 16), 'Youth Day'); add(iso(8, 9), "National Women's Day"); add(iso(9, 24), 'Heritage Day'); add(iso(12, 16), 'Day of Reconciliation');
  add(iso(12, 25), 'Christmas Day'); add(iso(12, 26), 'Day of Goodwill');
  // Easter Sunday (Anonymous Gregorian algorithm): Good Friday is two days before, Family Day the Monday after.
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mm + 114) / 31), dayN = ((h + l - 7 * mm + 114) % 31) + 1;
  const easter = new Date(Date.UTC(y, month - 1, dayN, 12));
  const shift = (n: number) => { const x = new Date(easter); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  m.set(shift(-2), 'Good Friday'); m.set(shift(1), 'Family Day');
  cache.set(y, m);
  return m;
}
