// Monitoring rules that don't need live tracker data to define: thresholds and checks.

export const SLOW_ASK_MIN = 30;        // technician is asked
export const SLOW_ALERT_MIN = 60;      // supervisor alerted immediately
export const OPEN_CARD_HOURS = 24;
export const SCAN_CONFIRM_MIN = 10;
export const MIN_TRIPS_FOR_BASELINE = 5;

export type SlowResult = { level: 'none' } | { level: 'ask' | 'alert'; overBy: number; likelyTraffic: boolean };

/**
 * Compare a trip with the normal time for that route.
 * normalMinutes: learned median, or the map estimate while the route has fewer than 5 trips.
 * stoppedMinutes: time the vehicle stood still during the trip (from the tracker).
 */
export function slowToSite(tripMinutes: number, normalMinutes: number, stoppedMinutes: number): SlowResult {
  const overBy = Math.round(tripMinutes - normalMinutes);
  if (overBy < SLOW_ASK_MIN) return { level: 'none' };
  // Slow the whole way with hardly any stops reads as traffic: still reported, marked low priority.
  const likelyTraffic = stoppedMinutes < 10;
  return { level: overBy >= SLOW_ALERT_MIN ? 'alert' : 'ask', overBy, likelyTraffic };
}

/** Median of past trip times; trips with unexplained long stops are excluded by the caller. */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function normalTripMinutes(pastTrips: number[], mapEstimate: number): number {
  return pastTrips.length >= MIN_TRIPS_FOR_BASELINE ? median(pastTrips) : mapEstimate;
}

/**
 * Open job card: flags when the card has had no activity for 24 hours and wasn't parked
 * with Continue later, or when it is still open after its planned return date.
 */
export function openCardFlag(o: {
  status: 'assigned' | 'in_progress' | 'continue_later' | 'closed';
  lastActivityAt: string;
  plannedReturn?: string;     // YYYY-MM-DD
  now: string;
}): boolean {
  if (o.status === 'closed') return false;
  if (o.status === 'continue_later') return !!o.plannedReturn && o.now.slice(0, 10) > o.plannedReturn;
  if (o.status === 'assigned') return false;
  const hours = (Date.parse(o.now) - Date.parse(o.lastActivityAt)) / 3_600_000;
  return hours >= OPEN_CARD_HOURS;
}

/** A barcode scan only counts if that vehicle's ignition comes on within 10 minutes. */
export function scanConfirmed(scannedAt: string, ignitionOnAt?: string): boolean {
  if (!ignitionOnAt) return false;
  const diff = (Date.parse(ignitionOnAt) - Date.parse(scannedAt)) / 60000;
  return diff >= -1 && diff <= SCAN_CONFIRM_MIN;
}

export interface FuelCheck {
  litres: number;
  tankLitres: number;
  vehicleStoppedAtLogTime: boolean;
  litresPer100km?: number;
  normalLitresPer100km?: number;
}

/** Reasons a fuel entry raises a Fuel mismatch flag. Empty = fine. */
export function fuelProblems(f: FuelCheck): string[] {
  const p: string[] = [];
  if (f.litres > f.tankLitres) p.push(`${f.litres} L is more than the ${f.tankLitres} L tank`);
  if (!f.vehicleStoppedAtLogTime) p.push('tracker does not show the vehicle stopped at that time');
  if (f.litresPer100km && f.normalLitresPer100km && f.litresPer100km > f.normalLitresPer100km * 1.25) {
    p.push(`fuel use ${f.litresPer100km.toFixed(1)} L/100 km against a normal ${f.normalLitresPer100km.toFixed(1)}`);
  }
  return p;
}

/** Exit checklist before a technician who leaves the company can be marked as left. */
export function exitChecklist(o: { openJobCards: number; stocktakeSignedOff: boolean; toolsAllAccountedFor: boolean }): string[] {
  const missing: string[] = [];
  if (o.openJobCards > 0) missing.push(`${o.openJobCards} open job card(s) must be closed and concluded`);
  if (!o.stocktakeSignedOff) missing.push('stock take not signed off');
  if (!o.toolsAllAccountedFor) missing.push('tool check not signed off');
  return missing;
}
