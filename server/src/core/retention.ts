// How long vehicle photos are kept on file.
export const FAULT_PHOTO_YEARS = 2;
export const ROUTINE_INSPECTION_DAYS = 90;

/** Photos taken all round the vehicle at a handover. */
export const ROUTINE_KINDS = ['vehicle_front', 'vehicle_back', 'vehicle_left', 'vehicle_right', 'vehicle_dashboard'] as const;
/** Always evidence of a fault, damage or acceptance of the vehicle. */
export const EVIDENCE_KINDS = ['fleet_fault', 'vehicle_damage', 'handover_signature'] as const;

export const RULES = [
  `Fault and damage photos, handover signatures, and all photos of a handover where new damage was found: ${FAULT_PHOTO_YEARS} years.`,
  `Routine inspection photos (nothing new found): ${ROUTINE_INSPECTION_DAYS} days.`,
  "Each vehicle's latest handover photos are always kept, so the next driver has something to compare with.",
  'Only the picture is removed. The record of the inspection (km, fuel, checks, who signed) is kept for good.',
];
