// A technician's performance for a period (on his monthly timesheet, when the CEO or Accounts has
// switched it on for him): how his paid hours were spent, how many were invoiced, his jobs, callbacks,
// flags, missing timesheets and unauthorised trips. And, for the CEO and Accounts only, what he made
// the company (his share of what his jobs were invoiced, less credit notes) against what he cost it
// (every paid hour at the labour rate, also office time we cannot invoice, and every km he drove at
// the vehicle's running cost). Pure functions, the same on the server, in the app and on the print-out.

import * as D from './documents.ts';

export interface WorthIn {
  days: number; paidMin: number; workMin: number; travelMin: number; officeMin: number; unaccountedMin: number; invoicedMin: number;
  jobsFinished: number; jobsUnfinished: number; callbacks: number; flags: number; missingSheets: number;
  unauthorisedTrips: number; unauthorisedKm: number;
  /** km he drove in company vehicles (from the tracker, or estimated to and from his jobs). */
  km: number; kmEstimated: boolean;
  /** His share of what his jobs were invoiced, excl. VAT, less credit notes. */
  revenueCents: number;
  costPerHourCents: number; costPerKmCents: number;
}
export interface Worth extends WorthIn {
  /** Invoiced hours as a share of paid hours. */
  recoveryPct: number | null;
  labourCostCents: number; vehicleCostCents: number; unauthorisedCostCents: number; costCents: number; netCents: number;
  /** Rand made for every R1 he costs. */
  perRand: number | null;
  verdict: { text: string; tone: 'good' | 'warn' | 'bad' | 'quiet' };
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export function worthOf(w: WorthIn): Worth {
  const labourCostCents = Math.round((w.paidMin / 60) * w.costPerHourCents);
  const vehicleCostCents = Math.round(w.km * w.costPerKmCents);
  const unauthorisedCostCents = Math.round(w.unauthorisedKm * w.costPerKmCents);
  const costCents = labourCostCents + vehicleCostCents;
  const netCents = w.revenueCents - costCents;
  const perRand = costCents > 0 ? Math.round((w.revenueCents / costCents) * 100) / 100 : null;
  const recoveryPct = pct(w.invoicedMin, w.paidMin);
  const verdict = !w.paidMin ? { text: 'No paid hours in this period', tone: 'quiet' as const }
    : !costCents ? { text: 'Set the labour cost per hour and the cost per km (Accounts → rates) to see his worth', tone: 'quiet' as const }
    : netCents >= 0 && (perRand ?? 0) >= 1.5 ? { text: 'Makes the company clearly more than he costs', tone: 'good' as const }
    : netCents >= 0 ? { text: 'Makes the company a little more than he costs', tone: 'warn' as const }
    : { text: 'Costs the company more than he makes', tone: 'bad' as const };
  return { ...w, recoveryPct, labourCostCents, vehicleCostCents, unauthorisedCostCents, costCents, netCents, perRand, verdict };
}

export interface PerfLine { label: string; value: string; tone?: 'good' | 'warn' | 'bad' }
const hm = (m: number) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const rand = (c: number) => `${c < 0 ? '-' : ''}${D.rand(Math.abs(c))}`;

/** The performance lines (the same in the app and on the print-out). */
export function performanceLines(w: Worth): PerfLine[] {
  const r = w.recoveryPct;
  return [
    { label: 'Paid hours', value: `${hm(w.paidMin)} over ${w.days} day${w.days === 1 ? '' : 's'}` },
    { label: 'On jobs / travelling / office', value: `${hm(w.workMin)} / ${hm(w.travelMin)} / ${hm(w.officeMin)}` },
    { label: 'Hours invoiced', value: `${hm(w.invoicedMin)}${r !== null ? ` (${r}% of paid hours)` : ''}`, tone: r === null ? undefined : r >= 60 ? 'good' : r >= 40 ? 'warn' : 'bad' },
    { label: 'Jobs finished / left to continue', value: `${w.jobsFinished} / ${w.jobsUnfinished}` },
    { label: 'Callbacks (our own work again)', value: String(w.callbacks), tone: w.callbacks ? 'bad' : 'good' },
    { label: 'Time not accounted for', value: hm(w.unaccountedMin), tone: w.unaccountedMin >= 120 ? 'bad' : w.unaccountedMin >= 30 ? 'warn' : 'good' },
    { label: 'Flags', value: String(w.flags), tone: w.flags >= 3 ? 'bad' : w.flags ? 'warn' : 'good' },
    { label: 'Timesheets not submitted', value: String(w.missingSheets), tone: w.missingSheets ? 'bad' : 'good' },
    { label: 'Unauthorised trips', value: w.unauthorisedTrips ? `${w.unauthorisedTrips} (${Math.round(w.unauthorisedKm)} km)` : 'None', tone: w.unauthorisedTrips ? 'bad' : 'good' },
  ];
}

/** The money lines: CEO and Accounts only. */
export function moneyLines(w: Worth): PerfLine[] {
  return [
    { label: 'Made the company (his share of invoices, excl. VAT)', value: rand(w.revenueCents) },
    { label: `Cost: ${hm(w.paidMin)} paid at ${rand(w.costPerHourCents)}/h`, value: rand(w.labourCostCents) },
    { label: `Cost: ${Math.round(w.km)} km${w.kmEstimated ? ' (estimated)' : ''} at ${rand(w.costPerKmCents)}/km`, value: rand(w.vehicleCostCents) },
    ...(w.unauthorisedKm ? [{ label: `Of that, unauthorised trips (${Math.round(w.unauthorisedKm)} km)`, value: rand(w.unauthorisedCostCents), tone: 'bad' as const }] : []),
    { label: 'He cost the company', value: rand(w.costCents) },
    { label: 'Made less cost', value: rand(w.netCents), tone: w.netCents >= 0 ? 'good' : 'bad' },
    { label: 'For every R1 he costs', value: w.perRand !== null ? `R ${w.perRand.toFixed(2)}` : '–', tone: w.perRand === null ? undefined : w.perRand >= 1.5 ? 'good' : w.perRand >= 1 ? 'warn' : 'bad' },
  ];
}
