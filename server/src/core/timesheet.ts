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
