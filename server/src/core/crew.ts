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
