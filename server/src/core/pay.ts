// What a month's timesheet comes to in wages: normal hours at his rate, overtime and Sundays / public
// holidays at their multiples (a salaried person: the salary, plus overtime at the hourly equivalent).
export interface PaySettings { wagePerHourCents: number | null; salaryCents: number | null; overtimeX: number; doubleX: number }
/** Hours a month of a salaried person (45 hours a week): to work out his hourly equivalent. */
export const MONTH_HOURS = 195;
export function hourlyOf(p: PaySettings): number | null {
  if (p.wagePerHourCents != null) return p.wagePerHourCents;
  if (p.salaryCents != null) return Math.round(p.salaryCents / MONTH_HOURS);
  return null;
}
export function wagesOf(t: { normalMin: number; overtimeMin: number; doubleMin: number }, p: PaySettings) {
  const rate = hourlyOf(p);
  if (rate == null) return null;
  const at = (min: number, x: number) => Math.round((min / 60) * rate * x);
  const normalCents = p.wagePerHourCents == null && p.salaryCents != null ? p.salaryCents : at(t.normalMin, 1);
  const overtimeCents = at(t.overtimeMin, p.overtimeX), doubleCents = at(t.doubleMin, p.doubleX);
  return { rateCents: rate, salaried: p.wagePerHourCents == null, normalCents, overtimeCents, doubleCents, totalCents: normalCents + overtimeCents + doubleCents };
}
