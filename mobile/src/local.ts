// Applies job card actions on the phone with the same rules engine the server uses, so the
// technician gets an immediate answer ("still missing: after photo") even with no signal.
import * as J from '../../server/src/core/jobCard.ts';
import type { CardView } from './types.ts';

export function toCore(v: CardView): J.JobCard {
  return {
    jobType: v.job_type,
    status: v.status,
    store: { lat: v.store_lat, lng: v.store_lng, geofenceM: v.geofence_m },
    items: v.items.map(({ status: _s, missing: _m, ...it }) => it),
    visits: v.visits,
    maintenanceChecklistDone: v.checklist.length > 0 && v.checklist.every(c => c.done),
    workshop: v.workshop ? { lat: v.workshop.lat, lng: v.workshop.lng, geofenceM: v.workshop.geofence_m } : null,
    ...(v.machine_at ? { machineAt: v.machine_at } : {}),
    loansOut: v.loans_out ?? 0,
  };
}

/** The card view after a rule succeeded: same header, new visits/items/status, recomputed checks. */
export function fromCore(v: CardView, c: J.JobCard): CardView {
  return {
    ...v,
    status: c.status,
    visits: c.visits,
    currentState: c.visits.at(-1)?.state ?? 'not_started',
    jobMinutes: J.jobMinutes(c),
    items: c.items.map(it => ({ ...it, status: J.itemStatus(it, c.jobType), missing: J.missingOnItem(it, c.jobType) })),
    machine_at: J.machineAt(c),
    loans_out: c.loansOut ?? 0,
    ready_to_deliver: J.machineAt(c) === 'workshop' && c.visits.at(-1)?.place === 'workshop' && c.visits.at(-1)?.state === 'done',
  };
}

export type LocalResult = { ok: true; view: CardView; flags: string[] } | { ok: false; reasons: string[] };

export function apply(v: CardView, rule: (c: J.JobCard) => J.Result): LocalResult {
  const r = rule(toCore(v));
  if (!r.ok) return { ok: false, reasons: r.reasons };
  return { ok: true, view: fromCore(v, r.card), flags: r.flags ?? [] };
}

export { J };
