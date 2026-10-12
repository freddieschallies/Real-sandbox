// Vehicle handover inspection. Whoever takes over a vehicle as its driver inspects it, photographs it,
// and signs that he accepts responsibility for it in that condition. The previous driver or a
// supervisor signs that it was handed over like that; if neither is there, a supervisor approves
// remotely and the vehicle shows "awaiting approval" until then.

export const CHECKS = [
  ['tyres', 'Tyres (tread, pressure, no damage)'],
  ['lights', 'Lights and indicators work'],
  ['windscreen_mirrors', 'Windscreen and mirrors (no cracks)'],
  ['bodywork', 'Bodywork (no new dents or scratches)'],
  ['interior', 'Interior clean, seats and belts OK'],
  ['spare_jack', 'Spare wheel, jack and wheel spanner'],
  ['fire_extinguisher', 'Fire extinguisher'],
  ['first_aid', 'First aid kit'],
  ['triangle', 'Warning triangle'],
  ['licence_disc', 'Licence disc valid'],
] as const;
export type CheckKey = typeof CHECKS[number][0];

export const SIDES = ['front', 'back', 'left', 'right', 'dashboard'] as const;
export type Side = typeof SIDES[number];
export const SIDE_LABEL: Record<Side, string> = {
  front: 'Front', back: 'Back', left: 'Left side', right: 'Right side', dashboard: 'Dashboard (odometer and fuel gauge)',
};

export const FUEL_LEVELS = ['empty', 'quarter', 'half', 'three_quarters', 'full'] as const;
export type FuelLevel = typeof FUEL_LEVELS[number];

export type HandoverBy = 'previous_driver' | 'supervisor' | 'remote_approval';

export interface CheckResult { ok: boolean; note?: string }

export interface Inspection {
  odometerKm?: number;
  fuelLevel?: FuelLevel;
  checks: Partial<Record<CheckKey, CheckResult>>;
  sidePhotos: Partial<Record<Side, string>>;   // photo ids
  damagePhotos: string[];
  driverSignatureId?: string;                  // the new driver accepting responsibility
  handoverBy?: HandoverBy;
  handedOverByName?: string;
  handoverSignatureId?: string;
  remoteReason?: string;                       // why nobody could sign on the spot
}

export interface PreviousInspection { odometerKm: number; problems: CheckKey[] }

/** A driver needs a handover inspection when he takes over a vehicle someone else drove last (or nobody ever inspected). */
export function needsInspection(mode: 'driving' | 'riding_along', lastDriverId: string | null, me: string, hasEverBeenInspected: boolean): boolean {
  if (mode !== 'driving') return false;
  if (!hasEverBeenInspected) return true;
  return lastDriverId !== me;
}

/** What is still missing before the handover can be submitted. Empty means complete. */
export function missingOnInspection(i: Inspection, prev?: PreviousInspection | null): string[] {
  const m: string[] = [];
  if (i.odometerKm === undefined || !Number.isFinite(i.odometerKm) || i.odometerKm < 0) m.push('odometer reading (km)');
  else if (prev && i.odometerKm < prev.odometerKm) m.push(`odometer cannot be lower than the last reading (${prev.odometerKm} km)`);
  if (!i.fuelLevel) m.push('fuel level');
  for (const [k, label] of CHECKS) {
    const r = i.checks[k];
    if (!r) m.push(label);
    else if (!r.ok && !(r.note && r.note.trim().length >= 5)) m.push(`${label}: describe the problem`);
  }
  for (const s of SIDES) if (!i.sidePhotos[s]) m.push(`photo: ${SIDE_LABEL[s]}`);
  if (problemsOf(i).length && i.damagePhotos.length === 0) m.push('a photo of each problem found');
  if (!i.driverSignatureId) m.push('your signature accepting the vehicle');
  if (!i.handoverBy) m.push('who handed the vehicle over');
  else if (i.handoverBy === 'remote_approval') {
    if (!i.remoteReason || i.remoteReason.trim().length < 5) m.push('why nobody can sign the handover now');
  } else {
    if (!i.handedOverByName?.trim()) m.push(i.handoverBy === 'previous_driver' ? 'name of the previous driver' : 'name of the supervisor');
    if (!i.handoverSignatureId) m.push(i.handoverBy === 'previous_driver' ? "previous driver's signature" : "supervisor's signature");
  }
  return m;
}

export function problemsOf(i: Inspection): CheckKey[] {
  return CHECKS.map(c => c[0]).filter(k => i.checks[k] && !i.checks[k]!.ok);
}

/** Problems that were not there at the last handover: the previous driver is answerable for these. */
export function newProblems(i: Inspection, prev?: PreviousInspection | null): CheckKey[] {
  const before = new Set(prev?.problems ?? []);
  return problemsOf(i).filter(k => !before.has(k));
}

export const ACCEPTANCE_TEXT =
  'I have inspected this vehicle and accept full responsibility for it, its equipment and its condition as recorded here, until I hand it over with a new inspection.';
