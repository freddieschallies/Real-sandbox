// Assistants and casual labour: people who work with the technicians but do not use the app (no login,
// no job cards of their own). The lead technician ticks who is with him on the job card, or the office
// adds them afterwards. Their time on a job follows the technician's visit (arrived until done), unless
// someone typed the hours. Assistants' time is charged on the invoice at the assistant rate; casual
// workers are paid a day rate for each day they worked. Pure functions, the same on the server and in the app.

export type CrewKind = 'assistant' | 'casual';
export const CREW_KIND_LABEL: Record<CrewKind, string> = { assistant: 'Assistant', casual: 'Casual labour' };

export interface CrewEntry { memberId: string; workDate: string; minutes: number | null; visit?: { from: string | null; to: string | null } | null }

/** Minutes one person worked on a job: what was typed, or the technician's visit from arriving until done. */
export function crewMinutes(e: CrewEntry, now = new Date()): number {
  if (e.minutes !== null && e.minutes !== undefined) return e.minutes;
  const from = e.visit?.from ? Date.parse(e.visit.from) : NaN;
  if (Number.isNaN(from)) return 0;
  const to = e.visit?.to ? Date.parse(e.visit.to) : now.getTime();
  return Math.max(0, Math.round((to - from) / 60_000));
}

/** Hours on the invoice: all the assistants' and casuals' time together, per started quarter hour. */
export const crewHours = (entries: CrewEntry[], now = new Date()) => Math.ceil(entries.reduce((n, e) => n + crewMinutes(e, now), 0) / 15) / 4;

/** What casual workers are owed for a period: a day rate for every day they worked (however many jobs). */
export function casualPay(entries: { memberId: string; workDate: string }[], rateOf: (memberId: string) => number | null) {
  const days = new Map<string, Set<string>>();
  for (const e of entries) { const s = days.get(e.memberId) ?? new Set<string>(); s.add(e.workDate); days.set(e.memberId, s); }
  return [...days].map(([memberId, set]) => {
    const rate = rateOf(memberId);
    const list = [...set].sort();
    return { memberId, days: list, dayCount: list.length, dayRateCents: rate, amountCents: rate === null ? null : rate * list.length };
  });
}

/** A casual's day rate spread over the jobs he worked on that day, for profit per job. */
export function crewCostForJob(jobId: string, entries: { jobId: string; memberId: string; workDate: string; minutes: number }[],
  rate: (memberId: string) => { dayCents: number | null; hourCents: number | null }): number {
  let cost = 0;
  for (const e of entries.filter(x => x.jobId === jobId)) {
    const r = rate(e.memberId);
    if (r.hourCents) { cost += Math.round((e.minutes / 60) * r.hourCents); continue; }
    if (!r.dayCents) continue;
    const sameDay = entries.filter(x => x.memberId === e.memberId && x.workDate === e.workDate);
    const total = sameDay.reduce((n, x) => n + Math.max(1, x.minutes), 0);
    cost += Math.round(r.dayCents * (Math.max(1, e.minutes) / total));
  }
  return cost;
}

// ---- The weekly timesheet of someone without the app -------------------------------------------------
import { payOf, publicHoliday, type Pay, type PayRules } from './timesheet.ts';

export interface CrewTimeIn { id: string; date: string; minutes: number; what: string; kind: 'job' | 'other'; jobNumber?: number | null; running?: boolean; addedBy?: string }
export interface CrewDay { date: string; items: CrewTimeIn[]; minutes: number; pay: Pay }
export interface CrewWeek {
  start: string; end: string; days: CrewDay[];
  totals: { minutes: number; normalMin: number; overtimeMin: number; doubleMin: number; daysWorked: number };
  pay: { basis: 'day' | 'hour' | null; cents: number | null; text: string | null };
}

/** The Monday of the week a day is in. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const plus = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** A person's week, Monday to Sunday: each day's jobs and other work, normal time, overtime and double time
 *  (the company's timesheet rules, Sundays and public holidays), and what that comes to: a casual worker's
 *  day rate for each day worked, or the hour rate (overtime at 1.5, Sundays and public holidays at 2). */
export function crewWeek(start: string, items: CrewTimeIn[], rules: PayRules, rate: { kind: CrewKind; dayRateCents: number | null; hourRateCents: number | null } | null): CrewWeek {
  const s = weekStart(start);
  const days: CrewDay[] = [0, 1, 2, 3, 4, 5, 6].map(n => {
    const date = plus(s, n);
    const list = items.filter(i => i.date === date).sort((a, b) => a.kind.localeCompare(b.kind) || (a.jobNumber ?? 0) - (b.jobNumber ?? 0));
    const minutes = list.reduce((m, i) => m + i.minutes, 0);
    return { date, items: list, minutes, pay: payOf({ travelMin: 0, workMin: minutes, officeMin: 0 } as never, date, rules) };
  });
  const sum = (f: (d: CrewDay) => number) => days.reduce((m, d) => m + f(d), 0);
  const totals = { minutes: sum(d => d.minutes), normalMin: sum(d => d.pay.normalMin), overtimeMin: sum(d => d.pay.overtimeMin), doubleMin: sum(d => d.pay.doubleMin), daysWorked: days.filter(d => d.minutes > 0).length };
  let pay: CrewWeek['pay'] = { basis: null, cents: null, text: null };
  const r = (c: number) => `R ${(c / 100).toFixed(2)}`;
  if (rate?.kind === 'casual' && rate.dayRateCents != null) {
    pay = { basis: 'day', cents: totals.daysWorked * rate.dayRateCents, text: `${totals.daysWorked} day${totals.daysWorked === 1 ? '' : 's'} × ${r(rate.dayRateCents)}` };
  } else if (rate?.hourRateCents != null) {
    const h = rate.hourRateCents;
    const cents = Math.round((totals.normalMin / 60) * h + (totals.overtimeMin / 60) * h * 1.5 + (totals.doubleMin / 60) * h * 2);
    pay = { basis: 'hour', cents, text: `${r(h)} an hour; overtime × 1.5, Sundays and public holidays × 2` };
  }
  return { start: s, end: plus(s, 6), days, totals, pay };
}
export { publicHoliday };
