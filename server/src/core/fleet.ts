// Fleet rules: when a vehicle is due for a service or a new licence disc, and what a mechanic's
// job card needs before it can be completed. Pure functions, used on the phone and the server.
import { isFullSentence } from './jobCard.ts';

export type VehicleStatus = 'in_service' | 'workshop' | 'off_road';
export type FaultSeverity = 'safety' | 'urgent' | 'normal';
export type FleetJobType = 'service' | 'repair' | 'tyres' | 'brakes' | 'electrical' | 'roadworthy' | 'breakdown' | 'other';

export const JOB_TYPES: FleetJobType[] = ['service', 'repair', 'tyres', 'brakes', 'electrical', 'roadworthy', 'breakdown', 'other'];
export const SERVICE_SOON_KM = 1000;
export const SERVICE_SOON_DAYS = 14;
export const LICENCE_SOON_DAYS = 30;

const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export interface Due { state: 'ok' | 'soon' | 'overdue' | 'unknown'; kmLeft: number | null; daysLeft: number | null; text: string }

/** Service due: whichever comes first, the km or the date. */
export function serviceDue(v: { next_service_km: number | null; next_service_at: string | null }, latestKm: number | null, today: string): Due {
  const kmLeft = v.next_service_km != null && latestKm != null ? v.next_service_km - latestKm : null;
  const daysLeft = v.next_service_at ? days(today, v.next_service_at) : null;
  if (kmLeft == null && daysLeft == null) return { state: 'unknown', kmLeft, daysLeft, text: 'No service due set' };
  const over = (kmLeft != null && kmLeft <= 0) || (daysLeft != null && daysLeft < 0);
  const soon = (kmLeft != null && kmLeft <= SERVICE_SOON_KM) || (daysLeft != null && daysLeft <= SERVICE_SOON_DAYS);
  const parts = [kmLeft != null ? (kmLeft <= 0 ? `${-kmLeft} km over` : `${kmLeft} km to go`) : null,
    daysLeft != null ? (daysLeft < 0 ? `${-daysLeft} days late` : `${daysLeft} days`) : null].filter(Boolean);
  return { state: over ? 'overdue' : soon ? 'soon' : 'ok', kmLeft, daysLeft, text: `Service: ${parts.join(' · ')}` };
}

export function licenceDue(expiry: string | null, today: string): Due {
  if (!expiry) return { state: 'unknown', kmLeft: null, daysLeft: null, text: 'Licence expiry not recorded' };
  const d = days(today, expiry);
  return { state: d < 0 ? 'overdue' : d <= LICENCE_SOON_DAYS ? 'soon' : 'ok', kmLeft: null, daysLeft: d,
    text: d < 0 ? `Licence disc expired ${-d} days ago` : `Licence disc: ${d} days left` };
}

/** The next service after this one: interval km on from the odometer, interval months on from today. */
export function nextService(odometerOut: number, intervalKm: number, intervalMonths: number, today: string) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + intervalMonths);
  return { km: odometerOut + intervalKm, at: d.toISOString().slice(0, 10) };
}

export interface FleetJobDraft {
  jobType: FleetJobType;
  odometerIn: number;
  found?: string | null;
  did?: string | null;
  labourHours?: number | null;
  afterPhotos: number;
  odometerOut?: number | null;
  /** Faults this job card was opened for, and what happened to each. */
  faults: { id: string; severity?: FaultSeverity; outcome?: 'fixed' | 'deferred'; note?: string | null }[];
  nextServiceKm?: number | null;
  nextServiceAt?: string | null;
  vehicleStatusAfter?: VehicleStatus | null;
}

/** What is still missing before a mechanic job card can be completed. */
export function missingToComplete(j: FleetJobDraft): string[] {
  const m: string[] = [];
  if (!isFullSentence(j.found ?? undefined)) m.push('what did you find (a full sentence)');
  if (!isFullSentence(j.did ?? undefined)) m.push('what did you do (a full sentence)');
  if (!(j.labourHours != null && j.labourHours > 0)) m.push('labour hours');
  if (j.afterPhotos < 1) m.push('at least one after photo');
  if (j.odometerOut == null) m.push('odometer when done');
  else if (j.odometerOut < j.odometerIn) m.push(`odometer when done cannot be lower than when it came in (${j.odometerIn} km)`);
  for (const f of j.faults) {
    if (!f.outcome) m.push('say for every fault whether it is fixed or deferred');
    else if (f.outcome === 'deferred' && !(f.note && f.note.trim().length >= 5)) m.push('why a fault is deferred');
  }
  if (j.jobType === 'service' && !(j.nextServiceKm && j.nextServiceAt)) m.push('next service (km and date)');
  if (!j.vehicleStatusAfter) m.push('can the vehicle go back on the road?');
  if (j.vehicleStatusAfter === 'in_service' && j.faults.some(f => f.outcome === 'deferred' && f.severity === 'safety')) {
    m.push('a safety fault cannot be deferred while the vehicle goes back on the road');
  }
  return [...new Set(m)];
}

/** A vehicle the mechanic has taken off the road can't be driven. */
export function canDrive(status: VehicleStatus): { ok: true } | { ok: false; reason: string } {
  if (status === 'in_service') return { ok: true };
  return { ok: false, reason: status === 'workshop' ? 'this vehicle is in the workshop: speak to the mechanic' : 'this vehicle is off the road: speak to the mechanic' };
}

// ---- Daily checks: the mechanic checks oil, water and tyres on every vehicle in service, every day ----

export type FluidResult = 'ok' | 'topped_up' | 'problem';
export type TyreResult = 'ok' | 'pressure_adjusted' | 'problem';

export interface DailyCheckDraft {
  odometerKm?: number | null;
  oil?: FluidResult; oilLitres?: number | null;
  water?: FluidResult; waterLitres?: number | null;
  tyres?: TyreResult;
  notes?: string | null;
}

/** What is still missing before a daily check can be saved. Oil that was added must always be noted, in litres. */
export function missingOnDailyCheck(d: DailyCheckDraft, lastKm: number | null): string[] {
  const out: string[] = [];
  if (d.odometerKm == null || Number.isNaN(d.odometerKm)) out.push('odometer reading (km)');
  else if (lastKm != null && d.odometerKm < lastKm) out.push(`odometer cannot be lower than the last reading (${lastKm} km)`);
  if (!d.oil) out.push('oil: OK, topped up or a problem');
  else if (d.oil === 'topped_up' && !(d.oilLitres != null && d.oilLitres > 0)) out.push('how much oil was added (litres)');
  if (d.oil && d.oil !== 'topped_up' && d.oilLitres) out.push('oil litres only when oil was added: choose "Topped up"');
  if (!d.water) out.push('water: OK, topped up or a problem');
  if (!d.tyres) out.push('tyres: OK, pressure adjusted or a problem');
  const problems = [d.oil, d.water, d.tyres].filter(x => x === 'problem').length;
  if (problems && !(d.notes && d.notes.trim().length >= 10)) out.push('what the problem is (a short sentence)');
  return out;
}

/** Faults a daily check raises. Tyre problems are safety faults; oil and water problems urgent. */
export function faultsFromDailyCheck(d: DailyCheckDraft): { description: string; severity: FaultSeverity }[] {
  const note = d.notes?.trim() ? `: ${d.notes.trim()}` : '';
  const out: { description: string; severity: FaultSeverity }[] = [];
  if (d.oil === 'problem') out.push({ description: `Daily check, oil${note}`, severity: 'urgent' });
  if (d.water === 'problem') out.push({ description: `Daily check, water / coolant${note}`, severity: 'urgent' });
  if (d.tyres === 'problem') out.push({ description: `Daily check, tyres${note}`, severity: 'safety' });
  return out;
}

export const OIL_WATCH_DAYS = 7;
export const OIL_WATCH_TIMES = 3;
export const OIL_WATCH_LITRES = 2;

/** An engine that keeps needing oil is burning or leaking it: 3 top-ups or 2 litres within 7 days. */
export function oilWatch(topUps: { litres: number }[]): { flag: boolean; text: string } {
  const litres = Math.round(topUps.reduce((n, t) => n + t.litres, 0) * 100) / 100;
  const flag = topUps.length >= OIL_WATCH_TIMES || litres >= OIL_WATCH_LITRES;
  return { flag, text: `Using oil: topped up ${topUps.length} time${topUps.length === 1 ? '' : 's'} (${litres} L) in ${OIL_WATCH_DAYS} days. Check for leaks or burning oil.` };
}
