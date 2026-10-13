// The job card's forced path. Pure functions: given the current card and an action,
// return the new card or a list of reasons the action is refused.
// Times are the phone's own timestamps (ISO strings), so the flow works offline.

import { insideGeofence, type Point } from './geo.ts';

export type VisitState = 'not_started' | 'on_the_way' | 'arrived' | 'working' | 'paused' | 'done' | 'continue_later' | 'uplifted';
export type JobStatus = 'assigned' | 'in_progress' | 'continue_later' | 'closed';
export type FaultType = 'electrical' | 'refrigeration' | 'mechanical' | 'water' | 'wear_and_tear' | 'user_damage' | 'no_fault_found' | 'other';
export type Outcome = 'complete' | 'needs_follow_up' | 'needs_quote' | 'waiting_for_parts';
export type JobType = 'breakdown' | 'planned_maintenance' | 'installation' | 'quote_visit' | 'follow_up' | 'workshop_repair';
/** Where a visit happens, and where the machine being repaired is: at the client's site or in our workshop. */
export type Place = 'site' | 'workshop';
export type PauseReason = 'waiting_for_parts' | 'store_asked_to_stop' | 'collecting_parts' | 'break';
export type UnfinishedReason = 'more_work_needed' | 'waiting_for_parts' | 'store_access' | 'waiting_for_quote_approval' | 'other';

export interface WorkItem {
  id: string;
  title: string;
  origin: 'reported' | 'found_on_site';
  equipmentId?: string;
  beforePhotos: number;
  afterPhotos: number;
  faultType?: FaultType;
  found?: string;
  did?: string;
  vanStockLines: number;
  boughtOutLines: number;
  noMaterials: boolean;
  tested?: 'yes' | 'partly' | 'no';
  outcome?: Outcome;
  stillNeeded?: string;
}

export interface Visit {
  state: VisitState;
  place?: Place;              // missing = at the client's site
  goAt?: string;
  arrivedAt?: string;
  checkedInManager?: string;
  safetyCheck?: { areaSafe: boolean; isolated: boolean; publicClear: boolean };
  startedAt?: string;
  endedAt?: string;
  pauses: { reason: PauseReason; at: string; resumedAt?: string }[];
}

export interface JobCard {
  jobType: JobType;
  status: JobStatus;
  store: Point & { geofenceM: number };
  items: WorkItem[];
  visits: Visit[];            // the last one is the current visit
  maintenanceChecklistDone?: boolean;
  closedAt?: string;
  /** The company's workshop, where workshop repairs are done (set by the office). */
  workshop?: (Point & { geofenceM: number }) | null;
  /** Where the machine is now. Missing: at the site, or in the workshop for a workshop repair. */
  machineAt?: Place;
  /** Loan machines left at the client on this job and not collected yet. */
  loansOut?: number;
}

export type Result = { ok: true; card: JobCard; flags?: string[] } | { ok: false; reasons: string[] };

const refuse = (...reasons: string[]): Result => ({ ok: false, reasons });
const current = (c: JobCard): Visit | undefined => c.visits[c.visits.length - 1];
const withVisit = (c: JobCard, v: Visit): JobCard => ({ ...c, visits: [...c.visits.slice(0, -1), v] });
const ENDED: VisitState[] = ['done', 'continue_later', 'uplifted'];
const ON_SITE: VisitState[] = ['arrived', 'working', 'paused'];
export const placeOf = (v?: Visit): Place => v?.place ?? 'site';
/** Where the machine is now: workshop repairs start in the workshop, everything else at the site. */
export const machineAt = (c: JobCard): Place => c.machineAt ?? (c.jobType === 'workshop_repair' ? 'workshop' : 'site');

/** A full sentence: at least 4 words and 15 characters, so "done" or "fixed" won't pass. */
export function isFullSentence(s?: string): boolean {
  if (!s) return false;
  const t = s.trim();
  return t.length >= 15 && t.split(/\s+/).length >= 4;
}

/** What is still missing on a work item before it counts as finished. */
export function missingOnItem(item: WorkItem, jobType: JobType): string[] {
  const m: string[] = [];
  if (!item.equipmentId) m.push('equipment');
  if (item.beforePhotos < 1) m.push('before photo');
  if (jobType === 'breakdown' && !item.faultType) m.push('fault type');
  if (!isFullSentence(item.found)) m.push('what did you find (a full sentence)');
  if (!isFullSentence(item.did)) m.push('what did you do (a full sentence)');
  if (!item.noMaterials && item.vanStockLines + item.boughtOutLines === 0) m.push('materials, or tick "No materials used"');
  if (item.afterPhotos < 1) m.push('after photo');
  if (!item.tested) m.push('tested and working');
  if (!item.outcome) m.push('item outcome');
  if (item.outcome && item.outcome !== 'complete' && !item.stillNeeded?.trim()) m.push('what is still needed');
  if (item.tested && item.tested !== 'yes' && item.outcome === 'complete') m.push('outcome cannot be Complete when not fully tested and working');
  return m;
}

export function itemStatus(item: WorkItem, jobType: JobType): 'not_started' | 'in_progress' | 'finished' {
  if (missingOnItem(item, jobType).length === 0) return 'finished';
  const touched = item.beforePhotos > 0 || !!item.found || !!item.did || item.faultType || item.vanStockLines > 0;
  return touched ? 'in_progress' : 'not_started';
}

// --- Actions -----------------------------------------------------------------

export function go(c: JobCard, at: string): Result {
  if (c.status === 'closed') return refuse('job is closed');
  const v = current(c);
  if (v && !ENDED.includes(v.state)) return refuse('a visit is already under way');
  const visit: Visit = { state: 'on_the_way', goAt: at, pauses: [] };
  return { ok: true, card: { ...c, status: 'in_progress', visits: [...c.visits, visit] } };
}

export interface ArriveInput {
  at: string;
  vehiclePosition?: Point;          // from the tracker at that moment
  phonePosition?: Point;            // only for a dropped-off passenger
  managerName: string;
  safety: { areaSafe: boolean; isolated: boolean; publicClear: boolean };
  outsideReason?: string;           // "I'm at a different location"
}

export function arrive(c: JobCard, i: ArriveInput): Result {
  const v = current(c);
  if (!v || v.state !== 'on_the_way') return refuse('tap Go before Arrived');
  const reasons: string[] = [];
  if (!i.managerName?.trim()) reasons.push('store manager checked in with');
  if (!(i.safety.areaSafe && i.safety.isolated && i.safety.publicClear)) reasons.push('all three safety checks');
  const pos = i.phonePosition ?? i.vehiclePosition;
  // A store with no map point yet cannot be checked: Arrived counts, and the office is told to pin it.
  const pinned = Number.isFinite(c.store?.lat) && Number.isFinite(c.store?.lng) && c.store.lat !== null && c.store.lng !== null;
  const inside = !pinned || (pos ? insideGeofence(pos, c.store, c.store.geofenceM) : false);
  const flags: string[] = [];
  if (!pinned) flags.push('store_not_pinned');
  if (!inside) {
    if (!i.outsideReason?.trim()) reasons.push('you are not at the store: are you in a different vehicle or location? give a reason');
    else flags.push('arrived_outside_geofence');
  }
  if (reasons.length) return refuse(...reasons);
  return {
    ok: true,
    flags,
    card: withVisit(c, { ...v, state: 'arrived', arrivedAt: i.at, checkedInManager: i.managerName.trim(), safetyCheck: i.safety }),
  };
}

export function start(c: JobCard, at: string): Result {
  const v = current(c);
  if (!v || v.state !== 'arrived') return refuse('confirm Arrived before starting the job');
  return { ok: true, card: withVisit(c, { ...v, state: 'working', startedAt: at }) };
}

export function pause(c: JobCard, reason: PauseReason, at: string): Result {
  const v = current(c);
  if (!v || v.state !== 'working') return refuse('can only pause while working');
  const flags = reason === 'collecting_parts' ? ['open_supply_run'] : [];
  return { ok: true, flags, card: withVisit(c, { ...v, state: 'paused', pauses: [...v.pauses, { reason, at }] }) };
}

export function resume(c: JobCard, at: string): Result {
  const v = current(c);
  if (!v || v.state !== 'paused') return refuse('job is not paused');
  const pauses = v.pauses.map((p, i) => (i === v.pauses.length - 1 ? { ...p, resumedAt: at } : p));
  return { ok: true, card: withVisit(c, { ...v, state: 'working', pauses }) };
}

export function addItem(c: JobCard, item: WorkItem): Result {
  if (c.status === 'closed') return refuse('job is closed');
  if (c.items.some(x => x.id === item.id)) return refuse('item already exists');
  return { ok: true, card: { ...c, items: [...c.items, item] } };
}

export function updateItem(c: JobCard, id: string, patch: Partial<WorkItem>): Result {
  if (c.status === 'closed') return refuse('job is closed');
  if (!c.items.some(x => x.id === id)) return refuse('no such item');
  return { ok: true, card: { ...c, items: c.items.map(x => (x.id === id ? { ...x, ...patch, id } : x)) } };
}

/** Done for the whole job: every item finished, checklist done for planned maintenance. */
export function done(c: JobCard, at: string): Result {
  const v = current(c);
  if (!v || v.state !== 'working') return refuse('can only finish while working (resume first if paused)');
  const reasons: string[] = [];
  if (c.items.length === 0) reasons.push('at least one work item');
  for (const it of c.items) {
    const m = missingOnItem(it, c.jobType);
    if (m.length) reasons.push(`${it.title}: ${m.join(', ')}`);
  }
  if (c.jobType === 'planned_maintenance' && !c.maintenanceChecklistDone) reasons.push('planned maintenance checklist');
  const inWorkshop = machineAt(c) === 'workshop';
  const loans = (c.loansOut ?? 0) > 0;
  if (placeOf(v) === 'site' && inWorkshop) reasons.push('the machine is still in the workshop: deliver it back first (or Continue later)');
  else if (placeOf(v) === 'site' && loans) reasons.push('collect the loan machine first (or Continue later)');
  if (reasons.length) return refuse(...reasons);
  // Repaired in the workshop: the visit is done and the job waits for the machine to go back (and the loan machine to come in).
  if (placeOf(v) === 'workshop' && (inWorkshop || loans)) {
    return { ok: true, flags: [inWorkshop ? 'ready_for_delivery' : 'loan_to_collect'], card: { ...withVisit(c, { ...v, state: 'done', endedAt: at }), status: 'continue_later' } };
  }
  return { ok: true, card: withVisit(c, { ...v, state: 'done', endedAt: at }) };
}

export interface ContinueLaterInput {
  at: string;
  progress: string;
  reason: UnfinishedReason;
  plannedReturn: string;   // YYYY-MM-DD
  managerInformed: string;
}

export function continueLater(c: JobCard, i: ContinueLaterInput): Result {
  const v = current(c);
  if (!v || !['working', 'paused'].includes(v.state)) return refuse('can only continue later from site');
  const reasons: string[] = [];
  if (!isFullSentence(i.progress)) reasons.push('progress so far (a full sentence)');
  if (!i.plannedReturn) reasons.push('planned return date');
  else if (i.plannedReturn < i.at.slice(0, 10)) reasons.push('return date cannot be in the past');
  if (placeOf(v) === 'site' && !i.managerInformed?.trim()) reasons.push('store manager informed');
  if (reasons.length) return refuse(...reasons);
  return { ok: true, card: { ...withVisit(c, { ...v, state: 'continue_later', endedAt: i.at }), status: 'continue_later' } };
}

export type SignOff = { signature: true; managerName: string } | { signature: false; reason: string; spokeTo: string };

export function close(c: JobCard, s: SignOff, at: string): Result {
  const v = current(c);
  if (!v || v.state !== 'done') return refuse('press Done before sign-off');
  if (machineAt(c) === 'workshop') return refuse('the machine is still in the workshop: deliver it back first');
  if ((c.loansOut ?? 0) > 0) return refuse('collect the loan machine first');
  if (s.signature) {
    if (!s.managerName?.trim()) return refuse('store manager name');
    return { ok: true, card: { ...c, status: 'closed', closedAt: at } };
  }
  const reasons: string[] = [];
  if (!s.reason?.trim()) reasons.push('reason the manager is unavailable');
  if (!s.spokeTo?.trim()) reasons.push('name of who you spoke to');
  if (c.items.some(it => it.afterPhotos < 1)) reasons.push('after photos are required as evidence when unsigned');
  if (reasons.length) return refuse(...reasons);
  return { ok: true, flags: ['manager_unavailable'], card: { ...c, status: 'closed', closedAt: at } };
}

/** Job time on site in minutes, excluding pauses, across all visits. */
export function jobMinutes(c: JobCard): number {
  let total = 0;
  for (const v of c.visits) {
    if (!v.startedAt || !v.endedAt) continue;
    let ms = Date.parse(v.endedAt) - Date.parse(v.startedAt);
    for (const p of v.pauses) ms -= Date.parse(p.resumedAt ?? v.endedAt) - Date.parse(p.at);
    total += ms;
  }
  return Math.round(total / 60000);
}

// --- Workshop repairs, upliftment and loan machines ---------------------------------------

export interface WorkshopStartInput {
  at: string;
  position?: Point;
  safety: { areaSafe: boolean; isolated: boolean };
  outsideReason?: string;
}

/** Start a visit in our workshop, on a machine that is there (uplifted, or brought in). No travel, no store manager. */
export function startAtWorkshop(c: JobCard, i: WorkshopStartInput): Result {
  if (c.status === 'closed') return refuse('job is closed');
  const v = current(c);
  if (v && !ENDED.includes(v.state)) return refuse('a visit is already under way');
  if (machineAt(c) !== 'workshop') return refuse('the machine is not in the workshop: uplift it from site first');
  if (!c.workshop) return refuse('the office has not set where the workshop is yet (Settings, Workshop)');
  const reasons: string[] = [];
  if (!(i.safety.areaSafe && i.safety.isolated)) reasons.push('both safety checks');
  const inside = i.position ? insideGeofence(i.position, c.workshop, c.workshop.geofenceM) : false;
  const flags: string[] = [];
  if (!inside) {
    if (!i.outsideReason?.trim()) reasons.push('you are not at the workshop: give a reason');
    else flags.push('arrived_outside_geofence');
  }
  if (reasons.length) return refuse(...reasons);
  const visit: Visit = { state: 'arrived', place: 'workshop', goAt: i.at, arrivedAt: i.at, safetyCheck: { ...i.safety, publicClear: true }, pauses: [] };
  return { ok: true, flags, card: { ...c, status: 'in_progress', visits: [...c.visits, visit] } };
}

export interface UpliftInput {
  at: string;
  reason: string;          // why it goes to the workshop
  photos: number;          // of the machine before it is loaded
  managerName: string;     // who at the store agreed
  signed: boolean;         // their signature for the machine
}

/** Uplift: the machine leaves site for the workshop. Ends this visit; the job carries on in the workshop. */
export function uplift(c: JobCard, i: UpliftInput): Result {
  const v = current(c);
  if (!v || placeOf(v) !== 'site' || !['working', 'paused'].includes(v.state)) return refuse('uplift from site, after starting the job');
  if (machineAt(c) === 'workshop') return refuse('the machine is already in the workshop');
  const reasons: string[] = [];
  if (!isFullSentence(i.reason)) reasons.push('why it goes to the workshop (a full sentence)');
  if (i.photos < 1) reasons.push('a photo of the machine before it is loaded');
  if (!i.managerName?.trim()) reasons.push('the store manager who agreed');
  if (!i.signed) reasons.push("the store manager's signature for the machine");
  if (reasons.length) return refuse(...reasons);
  const ended = withVisit(c, { ...v, state: 'uplifted', endedAt: i.at });
  return { ok: true, flags: ['uplifted'], card: { ...ended, status: 'continue_later', machineAt: 'workshop' } };
}

/** A loan machine left at the client while theirs is in the workshop. */
export function loanOut(c: JobCard, i: { photos: number; managerName: string; signed: boolean }): Result {
  if (c.status === 'closed') return refuse('job is closed');
  const v = current(c);
  if (!v || placeOf(v) !== 'site' || !ON_SITE.includes(v.state)) return refuse('leave a loan machine while on site');
  const reasons: string[] = [];
  if (i.photos < 1) reasons.push('a photo of the loan machine in place');
  if (!i.managerName?.trim()) reasons.push('the store manager who took it');
  if (!i.signed) reasons.push("the store manager's signature for the loan machine");
  if (reasons.length) return refuse(...reasons);
  return { ok: true, card: { ...c, loansOut: (c.loansOut ?? 0) + 1 } };
}

/** The loan machine collected again. */
export function loanBack(c: JobCard, i: { photos: number }): Result {
  if (c.status === 'closed') return refuse('job is closed');
  const v = current(c);
  if (!v || placeOf(v) !== 'site' || !ON_SITE.includes(v.state)) return refuse('collect the loan machine while on site');
  if ((c.loansOut ?? 0) < 1) return refuse('no loan machine is out on this job');
  if (i.photos < 1) return refuse('a photo of the loan machine as you collect it');
  return { ok: true, card: { ...c, loansOut: (c.loansOut ?? 0) - 1 } };
}

/** The repaired machine handed back: delivered on site, or collected by the client at the workshop. */
export function deliver(c: JobCard, i: { photos: number; receivedBy: string }): Result {
  if (c.status === 'closed') return refuse('job is closed');
  const v = current(c);
  if (!v || !ON_SITE.includes(v.state)) return refuse('arrive at the store, or start at the workshop, first');
  if (machineAt(c) !== 'workshop') return refuse('the machine is not in the workshop');
  const reasons: string[] = [];
  if (i.photos < 1) reasons.push(placeOf(v) === 'site' ? 'a photo of the machine back in place' : 'a photo of the machine as it is collected');
  if (!i.receivedBy?.trim()) reasons.push('who received it');
  if (reasons.length) return refuse(...reasons);
  return { ok: true, card: { ...c, machineAt: 'site' } };
}
