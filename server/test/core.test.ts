import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorWithDefaults as A, can, departmentsFor, effectivePermissions } from '../src/core/permissions.ts';
import * as J from '../src/core/jobCard.ts';
import * as R from '../src/core/rules.ts';
import * as M from '../src/core/phoneMenu.ts';
import { imageSize } from '../src/uploads.ts';

// ---- Permissions -----------------------------------------------------------

const tech = A('t1', 'technician', 'd1');
const admin = A('a1', 'admin');
const stockroom = A('s1', 'stockroom');
const mgrD1 = A('m1', 'management', 'd1');
const mgrD2 = A('m2', 'management', 'd2');
const director = A('dir', 'director');
const creator = A('c', 'creator');
const techInD1 = { employeeId: 't1', employeeDepartmentId: 'd1' };

test('technician sees own work only, and can make estimates', () => {
  assert.ok(can(tech, 'view_own_work', { employeeId: 't1' }));
  assert.ok(!can(tech, 'view_own_work', { employeeId: 't2' }));
  assert.ok(can(tech, 'create_estimate'));
  assert.ok(!can(tech, 'view_quotes_invoices_stock'));
  assert.ok(!can(tech, 'view_flags', techInD1));
});

test('admin cannot see flags, employee log or driving markers', () => {
  assert.ok(can(admin, 'assign_jobs'));
  assert.ok(can(admin, 'view_live_map_positions'));
  assert.ok(!can(admin, 'view_live_driving_markers'));
  assert.ok(!can(admin, 'view_flags', techInD1));
  assert.ok(!can(admin, 'view_employee_log', techInD1));
  // Admin stands in for the stock controller (issuing), but does not receive or count stock.
  assert.ok(can(admin, 'assign_stock'));
  assert.ok(!can(admin, 'manage_stockroom'));
  assert.ok(!can(admin, 'run_stocktake'));
});

test('stockroom is admin level plus stock functions', () => {
  assert.ok(can(stockroom, 'assign_stock'));
  assert.ok(can(stockroom, 'run_stocktake'));
  assert.ok(can(stockroom, 'view_all_job_cards'));
  assert.ok(!can(stockroom, 'view_employee_log', techInD1));
});

test('management is limited to its own department', () => {
  assert.ok(can(mgrD1, 'resolve_flags', techInD1));
  assert.ok(can(mgrD1, 'mark_technician_left', techInD1));
  assert.ok(!can(mgrD1, 'view_employee_log', techInD1), 'staff records are CEO and HR only');
  assert.ok(!can(mgrD2, 'mark_technician_left', techInD1));
  assert.ok(can(mgrD1, 'set_van_stock', techInD1), 'sets the van stock list for his own department');
  assert.ok(!can(mgrD2, 'set_van_stock', techInD1));
  assert.ok(can(mgrD1, 'assign_jobs') && can(mgrD1, 'view_all_job_cards'), 'assigns jobs and checks job cards');
  assert.ok(!can(mgrD1, 'prepare_quotes_invoices') && !can(mgrD1, 'assign_stock'), 'quotes and the stockroom only if the CEO adds them');
  assert.ok(!can(mgrD2, 'resolve_flags', techInD1));
  assert.ok(!can(mgrD1, 'view_director_digest'));
});

test('director sees all departments; creator alone runs the system', () => {
  assert.ok(can(director, 'view_employee_log', techInD1));
  assert.ok(can(director, 'view_director_digest'));
  assert.ok(!can(director, 'manage_users'));
  assert.ok(can(creator, 'manage_users'));
  assert.ok(can(creator, 'view_employee_log', techInD1));
});

test('pricing: directors, plus anyone given pricing access', () => {
  assert.ok(can(director, 'set_prices'));
  assert.ok(!can(admin, 'set_prices'));
  assert.ok(can(A('a2', 'admin', null, [{ action: 'set_prices', effect: 'grant' }]), 'set_prices'));
  assert.ok(can(director, 'manage_access'));
  assert.ok(!can(mgrD1, 'manage_access'));
});

test('the CEO can change access: per login type and per person, departments included', () => {
  // A manager allowed to see two other departments' flags, but not the confidential log
  const m = A('m3', 'management', 'd1', [
    { action: 'view_flags', effect: 'grant', scope: 'selected_departments', departmentIds: ['d1', 'd2'] },
    { action: 'view_employee_log', effect: 'deny' },
  ]);
  assert.ok(can(m, 'view_flags', { employeeDepartmentId: 'd2' }));
  assert.ok(!can(m, 'view_flags', { employeeDepartmentId: 'd3' }));
  assert.ok(!can(m, 'view_employee_log', techInD1));
  assert.deepEqual(departmentsFor(m, 'view_flags'), ['d1', 'd2']);
  // All admins lose pricing view of invoices by a login-type change; one admin gets it back personally
  const p = effectivePermissions('admin', [{ action: 'view_quotes_invoices_stock', effect: 'deny' }], [{ action: 'view_quotes_invoices_stock', effect: 'grant' }]);
  assert.equal(p.view_quotes_invoices_stock, true);
  assert.equal(effectivePermissions('admin', [{ action: 'view_quotes_invoices_stock', effect: 'deny' }], []).view_quotes_invoices_stock, undefined);
  assert.deepEqual(departmentsFor(director, 'view_flags'), 'all');
  assert.equal(departmentsFor(admin, 'view_flags'), null);
});

// ---- Job card forced path -------------------------------------------------

const store = { lat: -28.7807, lng: 32.0383, geofenceM: 150 };
const atStore = { lat: -28.7808, lng: 32.0384 };
const farAway = { lat: -28.75, lng: 32.0 };
const safety = { areaSafe: true, isolated: true, publicClear: true };

function newCard(jobType: J.JobType = 'breakdown'): J.JobCard {
  return {
    jobType, status: 'assigned', store, visits: [],
    items: [{ id: 'i1', title: 'Ice machine not dispensing', origin: 'reported', beforePhotos: 0, afterPhotos: 0, vanStockLines: 0, boughtOutLines: 0, noMaterials: false }],
  };
}

function must(r: J.Result): J.JobCard {
  if (!r.ok) assert.fail('refused: ' + r.reasons.join('; '));
  return r.card;
}

const finishedItem: Partial<J.WorkItem> = {
  equipmentId: 'eq1', beforePhotos: 1, afterPhotos: 1, faultType: 'refrigeration',
  found: 'Water inlet valve blocked with scale', did: 'Replaced the inlet valve and flushed the line',
  vanStockLines: 1, tested: 'yes', outcome: 'complete',
};

test('steps cannot be skipped', () => {
  const c = newCard();
  assert.equal(J.start(c, '2026-10-12T08:00:00Z').ok, false);
  const c1 = must(J.go(c, '2026-10-12T07:30:00Z'));
  assert.equal(J.start(c1, '2026-10-12T08:00:00Z').ok, false, 'start before Arrived');
  assert.equal(J.done(c1, '2026-10-12T08:00:00Z').ok, false, 'done before start');
});

test('arrival outside the store needs a reason and raises a flag', () => {
  const c = must(J.go(newCard(), '2026-10-12T07:30:00Z'));
  const r = J.arrive(c, { at: '2026-10-12T08:00:00Z', vehiclePosition: farAway, managerName: 'Sipho', safety });
  assert.equal(r.ok, false);
  const r2 = J.arrive(c, { at: '2026-10-12T08:00:00Z', vehiclePosition: farAway, managerName: 'Sipho', safety, outsideReason: 'Store moved to temporary site' });
  assert.ok(r2.ok && r2.flags?.includes('arrived_outside_geofence'));
});

test('arrival needs the manager name and all safety ticks', () => {
  const c = must(J.go(newCard(), '2026-10-12T07:30:00Z'));
  const r = J.arrive(c, { at: '2026-10-12T08:00:00Z', vehiclePosition: atStore, managerName: '', safety: { ...safety, isolated: false } });
  assert.ok(!r.ok && r.reasons.length === 2);
});

test('done is refused until every work item is complete, listing what is missing', () => {
  let c = must(J.go(newCard(), '2026-10-12T07:30:00Z'));
  c = must(J.arrive(c, { at: '2026-10-12T08:00:00Z', vehiclePosition: atStore, managerName: 'Sipho', safety }));
  c = must(J.start(c, '2026-10-12T08:05:00Z'));
  c = must(J.updateItem(c, 'i1', { found: 'fixed', did: 'done' }));
  const r = J.done(c, '2026-10-12T09:00:00Z');
  assert.ok(!r.ok);
  const text = r.reasons.join(' ');
  for (const s of ['equipment', 'before photo', 'fault type', 'what did you find', 'materials', 'after photo', 'tested', 'item outcome']) {
    assert.ok(text.includes(s), `missing reason: ${s}`);
  }
});

test('several work items, moved between freely, all needed for Done', () => {
  let c = must(J.go(newCard(), '2026-10-12T07:30:00Z'));
  c = must(J.arrive(c, { at: '2026-10-12T08:00:00Z', vehiclePosition: atStore, managerName: 'Sipho', safety }));
  c = must(J.start(c, '2026-10-12T08:05:00Z'));
  c = must(J.addItem(c, { id: 'i2', title: 'Door seal torn on oven 2', origin: 'found_on_site', beforePhotos: 0, afterPhotos: 0, vanStockLines: 0, boughtOutLines: 0, noMaterials: false }));
  c = must(J.updateItem(c, 'i1', finishedItem));
  assert.equal(J.itemStatus(c.items[0], c.jobType), 'finished');
  assert.equal(J.itemStatus(c.items[1], c.jobType), 'not_started');
  assert.equal(J.done(c, '2026-10-12T09:00:00Z').ok, false);
  c = must(J.updateItem(c, 'i2', { ...finishedItem, vanStockLines: 0, boughtOutLines: 1, outcome: 'needs_quote', tested: 'partly', stillNeeded: 'New seal kit to be quoted and ordered' }));
  c = must(J.done(c, '2026-10-12T09:30:00Z'));
  assert.equal(c.visits[0].state, 'done');
});

test('outcome cannot be Complete when equipment is only partly working', () => {
  const m = J.missingOnItem({ ...(finishedItem as J.WorkItem), id: 'x', title: 'x', origin: 'reported', tested: 'partly' }, 'breakdown');
  assert.ok(m.some(s => s.includes('cannot be Complete')));
});

test('pause excludes time, and collecting parts opens a supply run', () => {
  let c = must(J.go(newCard(), '2026-10-12T07:30:00Z'));
  c = must(J.arrive(c, { at: '2026-10-12T08:00:00Z', vehiclePosition: atStore, managerName: 'Sipho', safety }));
  c = must(J.start(c, '2026-10-12T08:00:00Z'));
  const p = J.pause(c, 'collecting_parts', '2026-10-12T09:00:00Z');
  assert.ok(p.ok && p.flags?.includes('open_supply_run'));
  c = must(J.resume(p.card, '2026-10-12T09:45:00Z'));
  c = must(J.updateItem(c, 'i1', finishedItem));
  c = must(J.done(c, '2026-10-12T10:00:00Z'));
  assert.equal(J.jobMinutes(c), 120 - 45);
});

test('multi-day job: Continue later then a second visit', () => {
  let c = must(J.go(newCard(), '2026-10-12T07:30:00Z'));
  c = must(J.arrive(c, { at: '2026-10-12T08:00:00Z', vehiclePosition: atStore, managerName: 'Sipho', safety }));
  c = must(J.start(c, '2026-10-12T08:00:00Z'));
  const bad = J.continueLater(c, { at: '2026-10-12T16:00:00Z', progress: 'busy', reason: 'more_work_needed', plannedReturn: '2026-10-13', managerInformed: 'Sipho' });
  assert.ok(!bad.ok);
  c = must(J.continueLater(c, { at: '2026-10-12T16:00:00Z', progress: 'Stripped the unit and found the compressor seized', reason: 'waiting_for_parts', plannedReturn: '2026-10-14', managerInformed: 'Sipho' }));
  assert.equal(c.status, 'continue_later');
  c = must(J.go(c, '2026-10-14T07:30:00Z'));
  assert.equal(c.visits.length, 2);
  c = must(J.arrive(c, { at: '2026-10-14T08:00:00Z', vehiclePosition: atStore, managerName: 'Sipho', safety }));
  c = must(J.start(c, '2026-10-14T08:00:00Z'));
  c = must(J.updateItem(c, 'i1', finishedItem));
  c = must(J.done(c, '2026-10-14T10:00:00Z'));
  assert.equal(J.jobMinutes(c), 8 * 60 + 120);
});

test('close-out: signature, or manager unavailable with reason and name (flagged)', () => {
  let c = must(J.go(newCard(), '2026-10-12T07:30:00Z'));
  c = must(J.arrive(c, { at: '2026-10-12T08:00:00Z', vehiclePosition: atStore, managerName: 'Sipho', safety }));
  c = must(J.start(c, '2026-10-12T08:00:00Z'));
  c = must(J.updateItem(c, 'i1', finishedItem));
  assert.equal(J.close(c, { signature: true, managerName: 'Sipho' }, '2026-10-12T10:00:00Z').ok, false, 'close before Done');
  c = must(J.done(c, '2026-10-12T10:00:00Z'));
  assert.equal(J.close(c, { signature: false, reason: '', spokeTo: '' }, '2026-10-12T10:05:00Z').ok, false);
  const r = J.close(c, { signature: false, reason: 'Manager at a meeting', spokeTo: 'Assistant manager Thandi' }, '2026-10-12T10:05:00Z');
  assert.ok(r.ok && r.flags?.includes('manager_unavailable'));
  const closed = must(r);
  assert.equal(J.addItem(closed, { ...closed.items[0], id: 'late' }).ok, false, 'closed card is locked');
});

test('workshop repairs: uplift needs a reason, photo and signature; the workshop visit is checked against its location; delivery before close', () => {
  const ws = { lat: atStore.lat + 0.02, lng: atStore.lng, geofenceM: 150 };
  const T = (h: number) => `2026-10-12T${String(h).padStart(2, '0')}:00:00Z`;
  let c: J.JobCard = { ...newCard(), workshop: ws };
  assert.equal(J.startAtWorkshop(c, { at: T(6), position: ws, safety: { areaSafe: true, isolated: true } }).ok, false, 'machine is on site');
  c = must(J.go(c, T(7)));
  c = must(J.arrive(c, { at: T(8), vehiclePosition: atStore, managerName: 'Sipho', safety }));
  assert.equal(J.uplift(c, { at: T(8), reason: 'Needs stripping in the workshop properly', photos: 1, managerName: 'Sipho', signed: true }).ok, false, 'start first');
  c = must(J.start(c, T(8)));
  const bad = J.uplift(c, { at: T(9), reason: 'broken', photos: 0, managerName: '', signed: false });
  assert.ok(!bad.ok && bad.reasons.length === 4);
  c = must(J.loanOut(c, { photos: 1, managerName: 'Sipho', signed: true }));
  const up = J.uplift(c, { at: T(9), reason: 'Compressor needs stripping in the workshop', photos: 1, managerName: 'Sipho', signed: true });
  assert.ok(up.ok && up.flags?.includes('uplifted'));
  c = must(up);
  assert.equal(J.machineAt(c), 'workshop'); assert.equal(c.status, 'continue_later'); assert.equal(c.visits.at(-1)!.state, 'uplifted');
  // Workshop visit: location checked, two safety ticks, no store manager.
  const far = J.startAtWorkshop(c, { at: T(10), position: atStore, safety: { areaSafe: true, isolated: true } });
  assert.ok(!far.ok && /not at the workshop/.test(far.reasons[0]));
  c = must(J.startAtWorkshop(c, { at: T(10), position: ws, safety: { areaSafe: true, isolated: true } }));
  assert.equal(c.visits.at(-1)!.place, 'workshop'); assert.equal(c.visits.at(-1)!.state, 'arrived');
  c = must(J.start(c, T(10)));
  assert.equal(J.loanBack(c, { photos: 1 }).ok, false, 'loan machines are collected on site');
  c = must(J.updateItem(c, 'i1', finishedItem));
  const wd = J.done(c, T(12));
  assert.ok(wd.ok && wd.flags?.includes('ready_for_delivery'));
  c = must(wd);
  assert.equal(c.status, 'continue_later', 'waits for delivery');
  assert.equal(J.close(c, { signature: true, managerName: 'Sipho' }, T(12)).ok, false, 'not while the machine is in the workshop');
  // Delivery visit.
  c = must(J.go(c, T(13)));
  c = must(J.arrive(c, { at: T(13), vehiclePosition: atStore, managerName: 'Sipho', safety }));
  c = must(J.start(c, T(13)));
  assert.equal(J.done(c, T(13)).ok, false, 'machine still in the workshop');
  assert.equal(J.deliver(c, { photos: 0, receivedBy: '' }).ok, false);
  c = must(J.deliver(c, { photos: 1, receivedBy: 'Sipho' }));
  assert.equal(J.machineAt(c), 'site');
  const d1 = J.done(c, T(14));
  assert.ok(!d1.ok && /loan machine/.test(d1.reasons[0]), 'collect the loan machine first');
  c = must(J.loanBack(c, { photos: 1 }));
  c = must(J.done(c, T(14)));
  assert.ok(J.close(c, { signature: true, managerName: 'Sipho' }, T(14)).ok);
  // Workshop repair: starts in the workshop; the workshop must be set.
  assert.equal(J.machineAt(newCard('workshop_repair')), 'workshop');
  const nows = J.startAtWorkshop(newCard('workshop_repair'), { at: T(8), position: ws, safety: { areaSafe: true, isolated: true } });
  assert.ok(!nows.ok && /not set where the workshop is/.test(nows.reasons[0]));
});

test('planned maintenance needs its checklist', () => {
  let c = must(J.go(newCard('planned_maintenance'), '2026-10-12T07:30:00Z'));
  c = must(J.arrive(c, { at: '2026-10-12T08:00:00Z', vehiclePosition: atStore, managerName: 'Sipho', safety }));
  c = must(J.start(c, '2026-10-12T08:00:00Z'));
  c = must(J.updateItem(c, 'i1', finishedItem));
  assert.equal(J.done(c, '2026-10-12T09:00:00Z').ok, false);
  must(J.done({ ...c, maintenanceChecklistDone: true }, '2026-10-12T09:00:00Z'));
});

// ---- Monitoring rules -------------------------------------------------------

test('slow to site: 30 min over asks, 60 min over alerts, no stops reads as traffic', () => {
  assert.deepEqual(R.slowToSite(50, 30, 0), { level: 'none' });
  assert.deepEqual(R.slowToSite(65, 30, 25), { level: 'ask', overBy: 35, likelyTraffic: false });
  assert.deepEqual(R.slowToSite(95, 30, 2), { level: 'alert', overBy: 65, likelyTraffic: true });
});

test('normal trip time: map estimate until 5 trips, then the median', () => {
  assert.equal(R.normalTripMinutes([20, 25], 30), 30);
  assert.equal(R.normalTripMinutes([20, 25, 22, 40, 21], 30), 22);
});

test('open job card flag respects Continue later and its return date', () => {
  const now = '2026-10-14T09:00:00Z';
  assert.equal(R.openCardFlag({ status: 'in_progress', lastActivityAt: '2026-10-13T10:00:00Z', now }), false);
  assert.equal(R.openCardFlag({ status: 'in_progress', lastActivityAt: '2026-10-13T08:00:00Z', now }), true);
  assert.equal(R.openCardFlag({ status: 'continue_later', lastActivityAt: '2026-10-10T08:00:00Z', plannedReturn: '2026-10-14', now }), false);
  assert.equal(R.openCardFlag({ status: 'continue_later', lastActivityAt: '2026-10-10T08:00:00Z', plannedReturn: '2026-10-13', now }), true);
});

test('vehicle scan needs ignition within 10 minutes', () => {
  assert.ok(R.scanConfirmed('2026-10-12T07:00:00Z', '2026-10-12T07:06:00Z'));
  assert.ok(!R.scanConfirmed('2026-10-12T07:00:00Z', '2026-10-12T07:15:00Z'));
  assert.ok(!R.scanConfirmed('2026-10-12T07:00:00Z'));
});

test('fuel mismatch reasons', () => {
  assert.deepEqual(R.fuelProblems({ litres: 50, tankLitres: 80, vehicleStoppedAtLogTime: true }), []);
  assert.equal(R.fuelProblems({ litres: 95, tankLitres: 80, vehicleStoppedAtLogTime: false, litresPer100km: 15, normalLitresPer100km: 10 }).length, 3);
});

test('exit checklist blocks leaving until jobs, stock and tools are settled', () => {
  assert.equal(R.exitChecklist({ openJobCards: 2, stocktakeSignedOff: false, toolsAllAccountedFor: false }).length, 3);
  assert.deepEqual(R.exitChecklist({ openJobCards: 0, stocktakeSignedOff: true, toolsAllAccountedFor: true }), []);
});

import * as H from '../src/core/handover.ts';

test('handover: who must inspect', () => {
  assert.equal(H.needsInspection('driving', 'other', 'me', true), true);
  assert.equal(H.needsInspection('driving', 'me', 'me', true), false);
  assert.equal(H.needsInspection('driving', 'me', 'me', false), true, 'never inspected');
  assert.equal(H.needsInspection('riding_along', 'other', 'me', true), false);
});

test('handover: everything recorded and signed before it counts', () => {
  const full: H.Inspection = {
    odometerKm: 1000, fuelLevel: 'half',
    checks: Object.fromEntries(H.CHECKS.map(c => [c[0], { ok: true }])),
    sidePhotos: Object.fromEntries(H.SIDES.map(s => [s, `p-${s}`])), damagePhotos: [],
    driverSignatureId: 'sig', handoverBy: 'previous_driver', handedOverByName: 'Sipho', handoverSignatureId: 'sig2',
  };
  assert.deepEqual(H.missingOnInspection(full), []);
  assert.ok(H.missingOnInspection({ ...full, checks: { ...full.checks, tyres: { ok: false } } }).some(m => /describe the problem/.test(m)));
  assert.ok(H.missingOnInspection({ ...full, checks: { ...full.checks, tyres: { ok: false, note: 'Front left bald' } } }).includes('a photo of each problem found'));
  assert.ok(H.missingOnInspection({ ...full, handoverSignatureId: undefined }).includes("previous driver's signature"));
  assert.deepEqual(H.missingOnInspection({ ...full, handoverBy: 'remote_approval', handoverSignatureId: undefined, remoteReason: 'He left early' }), []);
  assert.ok(H.missingOnInspection(full, { odometerKm: 2000, problems: [] })[0].startsWith('odometer cannot be lower'));
  const dented = { ...full, checks: { ...full.checks, bodywork: { ok: false, note: 'Dent left door' } }, damagePhotos: ['d'] };
  assert.deepEqual(H.newProblems(dented, { odometerKm: 900, problems: [] }), ['bodywork']);
  assert.deepEqual(H.newProblems(dented, { odometerKm: 900, problems: ['bodywork'] }), []);
});

import * as St from '../src/core/stock.ts';

test('stock: using on a job draws this job first, then van stock, then other jobs; pending returns are off limits', () => {
  const h = [{ holdingJobId: 'other', qty: 5 }, { holdingJobId: null, qty: 2 }, { holdingJobId: 'this', qty: 1, pendingReturn: 0 }];
  assert.deepEqual(St.drawPlan(h, 2, 'this'), { ok: true, take: [{ holdingJobId: 'this', qty: 1 }, { holdingJobId: null, qty: 1 }] });
  assert.deepEqual(St.drawPlan(h, 4, 'this'), { ok: true, take: [{ holdingJobId: 'this', qty: 1 }, { holdingJobId: null, qty: 2 }, { holdingJobId: 'other', qty: 1 }] });
  assert.deepEqual(St.drawPlan([{ holdingJobId: null, qty: 3, pendingReturn: 2 }], 2, 'x'), { ok: false, have: 1 });
  assert.equal(St.mustReturn('job', 'closed'), true);
  assert.equal(St.mustReturn('job', 'in_progress'), false);
  assert.equal(St.mustReturn(null, null), false);
});

test('stock: invoice lines matched by code or description', () => {
  const items = [{ id: '1', code: 'VALVE-01', description: 'Water inlet valve 24V', supplierCode: 'WV-24' }, { id: '2', code: 'FUSE-10A', description: 'Fuse 10A' }];
  assert.equal(St.matchItem({ description: 'anything', supplierCode: 'wv-24', qty: 1 }, items)?.id, '1');
  assert.equal(St.matchItem({ description: 'FUSE 10a', qty: 1 }, items)?.id, '2');
  assert.equal(St.matchItem({ description: 'Cable ties', qty: 1 }, items), null);
  assert.deepEqual(St.invoiceProblems({ supplierName: '', invoiceNumber: 'A1', lines: [{ description: 'x', qty: 0 }] }), ['supplier name', 'line 1: quantity']);
  assert.equal(St.linesTotalCents([{ description: 'a', qty: 2, unitPriceCents: 150 }, { description: 'b', qty: 1, unitPriceCents: 100 }]), 400);
});

import * as V from '../src/core/vehicleCode.ts';

const DISC = '%MVL1CC09%0154%4025T09N%1%4025015ABCD1%ND412778%BCD123X%Bakkie / Bakkie%TOYOTA%HILUX%White / Wit%AHTFR22G406123456%1GD1234567%2027-03-31%';

test('vehicle codes: a licence disc is read as the vehicle, a typed registration works too', () => {
  const d = V.parseLicenceDisc(DISC)!;
  assert.equal(d.registration, 'ND412778');
  assert.equal(d.make, 'TOYOTA');
  assert.equal(d.expiry, '2027-03-31');
  assert.ok(V.registrationCandidates(DISC).includes('ND412778'));
  assert.equal(V.describeCode(DISC), 'Licence disc · ND412778 · TOYOTA HILUX');
  assert.equal(V.parseLicenceDisc('RS-V1'), null);
  assert.deepEqual(V.registrationCandidates('nd 412-778'), ['ND412778']);
});

import * as Fl from '../src/core/fleet.ts';

test('fleet: service and licence due, next service, what a mechanic job card needs', () => {
  assert.equal(Fl.serviceDue({ next_service_km: 100000, next_service_at: '2027-01-01' }, 99500, '2026-10-12').state, 'soon');
  assert.equal(Fl.serviceDue({ next_service_km: 100000, next_service_at: '2027-01-01' }, 100200, '2026-10-12').state, 'overdue');
  assert.equal(Fl.serviceDue({ next_service_km: 100000, next_service_at: '2026-10-01' }, 90000, '2026-10-12').state, 'overdue', 'date passed');
  assert.equal(Fl.licenceDue('2026-10-30', '2026-10-12').state, 'soon');
  assert.deepEqual(Fl.nextService(88260, 15000, 12, '2026-10-16'), { km: 103260, at: '2027-10-16' });
  const base = { jobType: 'repair' as const, odometerIn: 100, found: 'Brake pads worn down to metal', did: 'Replaced front brake pads and skimmed discs', labourHours: 2, afterPhotos: 1, odometerOut: 110, faults: [], vehicleStatusAfter: 'in_service' as const };
  assert.deepEqual(Fl.missingToComplete(base), []);
  assert.ok(Fl.missingToComplete({ ...base, odometerOut: 90 })[0].startsWith('odometer when done cannot be lower'));
  assert.ok(Fl.missingToComplete({ ...base, faults: [{ id: 'f', severity: 'safety', outcome: 'deferred', note: 'no parts yet' }] }).includes('a safety fault cannot be deferred while the vehicle goes back on the road'));
  assert.deepEqual(Fl.missingToComplete({ ...base, faults: [{ id: 'f', severity: 'safety', outcome: 'deferred', note: 'no parts yet' }], vehicleStatusAfter: 'off_road' }), []);
  assert.equal(Fl.canDrive('off_road').ok, false);
});

test('workshop counts: pouring losses within the allowance are noted, bigger ones are short', async () => {
  const W = await import('../src/core/workshop.ts');
  assert.equal(W.allowance(10, true), 0.5, '5 % of what was poured');
  assert.equal(W.allowance(1, true), 0.25, 'at least a quarter litre');
  assert.equal(W.allowance(10, false), 0, 'counted items must match');
  assert.deepEqual(W.countResult(24, 24, 3, true), { loss: 0, allowance: 0.25, result: 'ok' });
  assert.equal(W.countResult(24, 23.8, 3, true).result, 'within_allowance');
  assert.equal(W.countResult(24, 23, 3, true).result, 'short');
  assert.equal(W.countResult(5, 4, 0, false).result, 'short');
  assert.equal(W.countResult(24, 25, 3, true).result, 'over');
  assert.deepEqual(W.missingOnCount(23, '', { result: 'short' }), ['what happened (a short note)']);
});

test('quotes and invoices: totals with VAT, labour per quarter hour, draft from a closed job', async () => {
  const D = await import('../src/core/documents.ts');
  const R = await import('../src/core/clientRates.ts');
  assert.deepEqual(D.totals([{ qty: 1.5, unitPriceCents: 65000 }, { qty: 2, unitPriceCents: 12050 }], 15), { exVatCents: 121600, vatCents: 18240, totalCents: 139840 });
  assert.equal(D.quarterHours(61), 1.25);
  assert.equal(D.quarterHours(0), 0);
  const lines = D.invoiceDraft({ jobType: 'breakdown', jobNumber: 10231, minutesOnSite: 95, technicians: 2, visits: 1,
    stockUsed: [{ stockItemId: 's1', description: 'Water inlet valve', qty: 1, sellingPriceCents: null }], boughtOut: [{ description: 'Hose clamp', qty: 2, costCents: 1000 }] },
    R.priceRules({ labour_per_hour: 65000, call_out: 45000, bought_out_markup_pct: 20 }, null));
  assert.deepEqual(lines.map(l => [l.kind, l.qty, l.unitPriceCents]), [['labour', 3.5, 65000], ['call_out', 1, 45000], ['stock', 1, 0], ['bought_out', 2, 1200]]);
  assert.deepEqual(D.missingToSend({ lines }), ['line 3 (Water inlet valve): a price']);
});

test("a client's own rates: switched-off rates are not charged; parts marked up in three price bands", async () => {
  const D = await import('../src/core/documents.ts');
  const R = await import('../src/core/clientRates.ts');
  const company = { labour_per_hour: 65000, call_out: 45000, travel_per_km: 850, travel_per_hour: 30000, bought_out_markup_pct: 20 };
  const own = R.startingRates(company);
  assert.equal(own.rates.labour_per_hour.cents, 65000, 'starts from the company rates');
  own.rates.labour_per_hour.cents = 58000;
  own.rates.travel_per_hour.on = false;   // this client is not charged travel time
  own.markup.bands = [{ upToCents: 50000, pct: 60 }, { upToCents: 200000, pct: 40 }, { upToCents: null, pct: 25 }];
  assert.deepEqual(R.ratesProblems(own), []);
  // The cheaper the part, the bigger the mark-up.
  assert.equal(R.markedUp(10000, own.markup), 16000, 'R100 part: 60%');
  assert.equal(R.markedUp(50000, own.markup), 80000, 'R500 is still the first band');
  assert.equal(R.markedUp(150000, own.markup), 210000, 'R1 500 part: 40%');
  assert.equal(R.markedUp(400000, own.markup), 500000, 'R4 000 part: 25%');
  const job = { jobType: 'breakdown', jobNumber: 10240, minutesOnSite: 60, technicians: 1, visits: 1,
    stockUsed: [{ stockItemId: 's1', description: 'Fan motor', qty: 1, sellingPriceCents: 99900, costCents: 150000 }, { stockItemId: 's2', description: 'Fuse', qty: 2, sellingPriceCents: 1500, costCents: null }],
    boughtOut: [{ description: 'Hose clamp', qty: 2, costCents: 1000 }], travel: { km: 42, minutes: 50, kmEstimated: true } };
  const lines = D.invoiceDraft(job, R.priceRules(company, own));
  assert.deepEqual(lines.map(l => [l.kind, l.qty, l.unitPriceCents]), [
    ['labour', 1, 58000], ['call_out', 1, 45000], ['travel', 42, 850],
    ['stock', 1, 210000], ['stock', 2, 1500], ['bought_out', 2, 1600],
  ], 'no travel time line; a part without a cost keeps its selling price');
  assert.match(lines[2].description, /estimated km/);
  // Everything switched off: only the parts.
  for (const k of R.CLIENT_RATE_KEYS) own.rates[k].on = false;
  own.markup.on = false;
  assert.deepEqual(D.invoiceDraft(job, R.priceRules(company, own)).map(l => l.kind), ['stock', 'stock', 'bought_out']);
  assert.equal(D.invoiceDraft(job, R.priceRules(company, own)).find(l => l.kind === 'bought_out')!.unitPriceCents, 1200, 'mark-up off: the company mark-up on bought-out items');
  // Bands must go up; a rate that is on needs an amount.
  own.rates.call_out = { on: true, cents: 0 };
  own.markup.bands = [{ upToCents: 200000, pct: 60 }, { upToCents: 50000, pct: 40 }, { upToCents: null, pct: 25 }];
  assert.deepEqual(R.ratesProblems(own), ['Call-out fee: a rate, or untick it', 'mark-up: the second band must end above the first']);
  assert.ok(Math.abs(R.kmBetween({ lat: -28.78, lng: 32.04 }, { lat: -28.75, lng: 31.9 }) - 14.0) < 1);
});

test('Pastel: credit notes and supplier invoices go to their own code', async () => {
  const P = await import('../src/core/pastel.ts');
  const s = { yearStartMonth: 3, taxType: '01', codes: { credit: { code: '1050000', lineType: 6 as const } }, store: null };
  const credit = { kind: 'credit' as const, number: 9001, customerCode: 'SPA001', date: '2026-10-13', dueDate: null, orderNumber: 'INV 7001', message: 'Charged twice',
    deliverTo: [], contact: null, codeFor: 'credit' as const, lines: [{ kind: 'other' as const, description: 'Credit inv 7001', qty: 1, unitPriceCents: 120000 }] };
  assert.deepEqual(P.missingForPastel(credit, s), []);
  const file = P.pastelFile([credit], s, 15);
  assert.match(file, /^Header,,,,SPA001,8,13\/10\/2026,INV 7001,/);
  assert.match(file, /\r\nDetail,0,1,1200\.00,1380\.00,,01,0,0,1050000,Credit inv 7001,6,,\r\n$/);
  const sup = { ...credit, kind: 'supplier_invoice' as const, number: 'IN-55', customerCode: null, codeFor: 'purchases' as const, noVat: true };
  assert.deepEqual(P.missingForPastel(sup, s), ["the supplier's Pastel code", 'a Pastel code for supplier invoices (the purchases account) (Accounts, Pastel codes)']);
  const s2 = { ...s, codes: { purchases: { code: '2000000', lineType: 6 as const } } };
  assert.match(P.pastelFile([{ ...sup, customerCode: 'VOL001' }], s2, 15), /Detail,0,1,1200\.00,1200\.00,,00,/, 'no VAT: tax type 00');
  // Lines that add up go as they are; otherwise one line for the whole invoice.
  const lines = [{ description: 'Valve', qty: 2, unitPriceCents: 25000 }, { description: 'Ties', qty: 1, unitPriceCents: 5000 }];
  assert.equal(P.supplierLines({ number: 'A1', supplier: 'Voltex', totalCents: 63250, vatCents: 8250, vatPct: 15, lines }).length, 2);
  assert.deepEqual(P.supplierLines({ number: 'A1', supplier: 'Voltex', totalCents: 70000, vatCents: null, vatPct: 15, lines }).map(l => [l.description, l.unitPriceCents]), [['Voltex invoice A1', 60870]]);
});

test('order list: how many to order', async () => {
  const S = await import('../src/core/stock.ts');
  assert.equal(S.orderQty(3, 10, 20), 20);
  assert.equal(S.orderQty(3, 10, null), 7);
  assert.equal(S.orderQty(3, 10, 5), 7, 'never less than what gets it back to the minimum');
  assert.equal(S.orderQty(12, 10, 20), 0);
  assert.equal(S.orderQty(2.5, 10, null), 8);
});

test('Pastel Partner import file: header and detail rows, periods, codes', async () => {
  const P = await import('../src/core/pastel.ts');
  assert.equal(P.period('2026-03-15', 3), 1);
  assert.equal(P.period('2026-02-10', 3), 12);
  assert.equal(P.period('2026-10-12', 1), 10);
  const s = { yearStartMonth: 3, taxType: '01', codes: { labour: { code: 'LAB001', lineType: 4 as const }, call_out: { code: '1000000', lineType: 6 as const } }, store: '001' };
  const doc = {
    kind: 'invoice' as const, number: 7001, customerCode: 'FRE001', date: '2026-10-12', dueDate: '2026-11-11', orderNumber: 'PO-14231',
    message: 'Job 10231, ice machine', deliverTo: ['FreshMart Meerensee', 'Meerensee Mall, Richards Bay'], contact: 'Sipho Dube',
    lines: [
      { kind: 'labour' as const, description: 'Labour, job 10231', qty: 1.75, unitPriceCents: 65000 },
      { kind: 'call_out' as const, description: 'Call-out', qty: 1, unitPriceCents: 45000 },
      { kind: 'stock' as const, description: 'Water inlet valve 24V', qty: 1, unitPriceCents: 32000, stockCode: 'VALVE-01', unit: 'each' },
    ],
  };
  assert.deepEqual(P.missingForPastel(doc, s), []);
  const f = P.pastelFile([doc], s, 15).split('\r\n');
  assert.equal(f[0], 'Header,,,,FRE001,8,12/10/2026,PO-14231,N,0,Job 10231 ice machine,,,FreshMart Meerensee,Meerensee Mall Richards Bay,,,,,0,11/11/2026,,,Sipho Dube,,,,N,');
  assert.equal(f[0].split(',').length, 29, 'header columns A to AC');
  assert.equal(f[1], 'Detail,0,1.75,650.00,747.50,,01,0,0,LAB001,Labour job 10231,4,,001');
  assert.equal(f[2], 'Detail,0,1,450.00,517.50,,01,0,0,1000000,Call-out,6,,');
  assert.equal(f[3].split(',').length, 14, 'detail columns A to N');
  assert.equal(f[3], 'Detail,0,1,320.00,368.00,each,01,0,0,VALVE-01,Water inlet valve 24V,4,,001');
  assert.deepEqual(P.missingForPastel({ ...doc, customerCode: null, lines: [...doc.lines, { kind: 'travel' as const, description: 'Travel', qty: 40, unitPriceCents: 900 }] }, s),
    ["the client's Pastel customer code", 'a Pastel code for travel lines (Accounts, Pastel codes)']);
});

test('van check: each line of the list against the van', () => {
  const r = St.vanCheck([{ stockItemId: 'a', qty: 5 }, { stockItemId: 'b', qty: 2 }], new Map([['a', 5], ['b', 0.5], ['c', 9]]));
  assert.equal(r.complete, false);
  assert.equal(r.shortLines, 1);
  assert.deepEqual(r.lines.map(l => l.short), [0, 1.5]);
  assert.equal(St.vanCheck([], new Map()).complete, true, 'no list: nothing short');
});

test('timesheet day: travel, work, paused and not accounted from what the app recorded', async () => {
  const T = await import('../src/core/timesheet.ts');
  const t = (hhmm: string) => `2026-10-12T${hhmm}:00+02:00`;
  const day = T.buildDay([
    { jobId: 'a', jobNumber: 1, store: 'Spar', fault: 'Fridge', goAt: t('07:30'), arrivedAt: t('08:00'), startedAt: t('08:05'), endedAt: t('10:00'),
      pauses: [{ reason: 'collecting_parts', at: t('08:30'), resumedAt: t('09:00') }], state: 'done' },
    { jobId: 'b', jobNumber: 2, store: 'Boxer', fault: 'Oven', goAt: t('11:00'), arrivedAt: t('11:20'), startedAt: t('11:25'), endedAt: t('13:20'),
      pauses: [{ reason: 'break', at: t('12:00'), resumedAt: t('12:30') }], state: 'continue_later', progressNote: 'Needs a part' },
  ], [{ at: t('07:00'), registration: 'ND 1', mode: 'driving' }], t('23:00'));
  assert.equal(day.start, new Date(t('07:00')).toISOString());
  assert.equal(day.spanMin, 380, '07:00 to 13:20');
  assert.equal(day.travelMin, 30 + 30 + 20, 'driving to both jobs, plus out for parts');
  assert.equal(day.workMin, 90 + 90, 'on site less pauses');
  assert.equal(day.pausedMin, 30);
  assert.equal(day.unaccountedMin, 380 - 80 - 180 - 30, 'the yard before the first Go, and 10:00 to 11:00');
  assert.equal(day.jobs[1].result, 'Continue later: Needs a part');
  assert.equal(T.hm(day.unaccountedMin), '1:30');
  assert.equal(T.buildDay([], []).activity, false);
  assert.deepEqual(T.daysBetween('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});

test('pay: normal, overtime (1.5x) and double time (Sundays and public holidays)', async () => {
  const T = await import('../src/core/timesheet.ts');
  const day = (travel: number, work: number) => ({ ...T.buildDay([], []), travelMin: travel, workMin: work });
  const mon = T.payOf(day(90, 480), '2026-10-12');
  assert.deepEqual([mon.paidMin, mon.normalMin, mon.overtimeMin, mon.doubleMin], [570, 480, 90, 0], 'weekday: 8 hours normal, the rest overtime');
  assert.equal(T.payOf(day(60, 180), '2026-10-10').overtimeMin, 240, 'Saturday: overtime');
  assert.equal(T.payOf(day(60, 180), '2026-10-11').doubleMin, 240, 'Sunday: double time');
  assert.equal(T.payOf(day(0, 300), '2026-09-24').dayType, 'holiday', 'Heritage Day');
  assert.equal(T.publicHoliday('2026-04-03'), 'Good Friday');
  assert.equal(T.publicHoliday('2026-04-06'), 'Family Day');
  assert.equal(T.publicHoliday('2026-08-10'), "National Women's Day (observed)", 'a Sunday holiday moves to Monday');
  assert.equal(T.payOf(day(0, 600), '2026-10-12', { weekdayNormalMin: 540, saturdayNormalMin: 0 }).overtimeMin, 60, 'company setting');
});

test('phone menu: up to five tabs show; more go under More; pinned ones first, a lone leftover joins the bar', () => {
  const t = (...k: string[]) => k.map(key => ({ key }));
  const keys = (x: { key: string }[]) => x.map(y => y.key).join(',');
  const { arrangeTabs } = M;
  let r = arrangeTabs(t('a', 'b', 'c', 'd', 'e'), null);
  assert.equal(keys(r.bar), 'a,b,c,d,e'); assert.equal(r.more.length, 0);
  r = arrangeTabs(t('a', 'b', 'c', 'd', 'e', 'f'), null);
  assert.equal(keys(r.bar), 'a,b,c,d'); assert.equal(keys(r.more), 'e,f');
  r = arrangeTabs(t('a', 'b', 'c', 'd', 'e', 'f'), ['f', 'c']);
  assert.equal(keys(r.bar), 'f,c'); assert.equal(keys(r.more), 'a,b,d,e');
  r = arrangeTabs(t('a', 'b', 'c'), ['c', 'a']);
  assert.equal(keys(r.bar), 'c,a,b', 'a More with one tab is pointless');
  r = arrangeTabs(t('a', 'b', 'c', 'd', 'e', 'f'), ['x', 'y']);
  assert.equal(keys(r.bar), 'a,b,c,d', 'none of the pinned tabs: automatic');
  assert.deepEqual(M.usualTabs('hr'), ['departments', 'timesheets', 'people']);
  assert.ok(M.usualTabs('admin').includes('settings') && !M.usualTabs('management').includes('settings'));
  assert.deepEqual(M.usualTabs('technician'), []);
});

test('email: one HTML message with its pictures inside, lines starting with a dot doubled', async () => {
  const { buildMime } = await import('../src/mailer.ts');
  const raw = buildMime('ZSP <reports@zsp.test>', { to: ['a@b.test'], subject: 'Site report 1001', html: '<p>Hi</p>', text: 'Hi\n.hidden', pictures: [{ cid: 'part', mime: 'image/jpeg', data: Buffer.from([1, 2, 3]) }] });
  assert.match(raw, /multipart\/related/); assert.match(raw, /Content-ID: <part>/); assert.match(raw, /To: a@b\.test/);
  assert.ok(!/\r\n\.[^.]/.test(raw), 'no line starts with a single dot');
  assert.match(buildMime('x@y.test', { to: ['a@b.test'], subject: 'Verslag – ü', html: '', text: '', pictures: [] }), /Subject: =\?UTF-8\?B\?/);
});

test('image size from the file header: PNG and JPEG', () => {
  const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(1600, 16); png.writeUInt32BE(1200, 20);
  assert.deepEqual(imageSize(png), { width: 1600, height: 1200 });
  // JPEG: SOI, an APP0 segment, then a baseline frame of 1200 high by 1600 wide.
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0xb0, 0x06, 0x40, 0x03, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { width: 1600, height: 1200 });
  assert.equal(imageSize(Buffer.from('not an image')), null);
});


import { toolDue } from '../src/routes/toolStore.ts';
test('tool store: a tool is due back when its job is done, and late from 10:00 the morning after', () => {
  const out = new Date('2026-10-12T07:00:00+02:00');
  assert.equal(toolDue({ outAt: out, jobId: 'j', jobClosedAt: null, jobOpen: true }, new Date('2026-10-20T12:00:00+02:00')).overdue, false, 'job still open');
  const closed = new Date('2026-10-13T15:00:00+02:00');
  assert.equal(toolDue({ outAt: out, jobId: 'j', jobClosedAt: closed, jobOpen: false }, new Date('2026-10-14T09:59:00+02:00')).overdue, false);
  assert.equal(toolDue({ outAt: out, jobId: 'j', jobClosedAt: closed, jobOpen: false }, new Date('2026-10-14T10:00:00+02:00')).overdue, true);
  assert.equal(toolDue({ outAt: out, jobId: null, jobClosedAt: null, jobOpen: false }, new Date('2026-10-13T10:01:00+02:00')).overdue, true, 'no job: back the same day');
});


import { newVehicleCode, qrMatrix, qrSvg, validVehicleCode } from '../src/core/qr.ts';
test('QR stickers: the right size for the code, the three corner squares, the same code every time, new codes', () => {
  const m = qrMatrix('ZSP-V07');
  assert.equal(m.length, 21, 'a short code fits version 1 (21 × 21)');
  const corner = (x: number, y: number) => [0, 1, 2, 3, 4, 5, 6].every(i => m[y][x + i] && m[y + 6][x + i] && m[y + i][x] && m[y + i][x + 6]) && m[y + 3][x + 3] && !m[y + 1][x + 1];
  assert.ok(corner(0, 0) && corner(14, 0) && corner(0, 14), 'finder squares in three corners');
  assert.deepEqual(qrMatrix('ZSP-V07'), m, 'the same code every time');
  assert.equal(qrMatrix('x'.repeat(60)).length, 4 * 4 + 17, 'longer text, bigger code');
  assert.equal(qrMatrix('y'.repeat(150)).length, 4 * 8 + 17, 'version 8 for 150 characters at level M');
  assert.throws(() => qrMatrix('z'.repeat(300)));
  assert.match(qrSvg('T-4KQ7MA'), /^<svg[^>]+viewBox="0 0 29 29"/);
  const c = newVehicleCode();
  assert.match(c, /^V-[A-HJ-NP-Z2-9]{6}$/); assert.ok(validVehicleCode(c));
  assert.ok(validVehicleCode('ZSP-V07')); assert.ok(!validVehicleCode('zsp v07'));
});

test('statement: brought forward, credit notes and payments, the running balance and the ages on the day', async () => {
  const { buildStatement, periodDates } = await import('../src/core/statement.ts');
  const inv = [
    { id: 'a', number: 1001, date: '2026-05-10', due: '2026-06-09', totalCents: 115000, paid: '2026-06-20', paidRef: 'EFT 1' },
    { id: 'b', number: 1002, date: '2026-06-15', due: '2026-07-15', totalCents: 23000, paid: null },
    { id: 'c', number: 1003, date: '2026-09-01', due: '2026-10-01', totalCents: 57500, paid: null },
  ];
  const cr = [{ number: 5001, date: '2026-06-01', invoiceId: 'a', totalCents: 15000, reason: 'Callout waived' }];
  const all = buildStatement(inv, cr, null, '2026-10-14');
  assert.deepEqual(all.lines.map(l => l.kind), ['invoice', 'credit', 'invoice', 'payment', 'invoice']);
  assert.equal(all.lines.find(l => l.kind === 'payment')!.creditCents, 100000, 'paid what was left after the credit note');
  assert.equal(all.closing, 23000 + 57500);
  assert.equal(all.ages.d120, 23000, '15 June is 121 days before 14 October');
  assert.equal(all.ages.d30, 57500);
  assert.equal(all.overdue, 23000 + 57500);
  const sep = buildStatement(inv, cr, '2026-09-01', '2026-09-30');
  assert.equal(sep.opening, 23000);
  assert.equal(sep.lines.length, 1);
  assert.equal(sep.closing, 80500);
  // On 31 May: invoice 1001 was still owed (not yet paid), before its credit note.
  const may = buildStatement(inv, cr, null, '2026-05-31');
  assert.equal(may.closing, 115000);
  assert.equal(may.ages.current, 115000);
  assert.deepEqual(periodDates('last', '2026-03-14'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(periodDates('three', '2026-01-05'), { from: '2025-11-01', to: '2026-01-05' });
  assert.deepEqual(periodDates('all', '2026-01-05'), { from: null, to: '2026-01-05' });
});

test('office time on a day, overlaps, unauthorised trips, and a technician\'s worth', async () => {
  const T = await import('../src/core/timesheet.ts');
  const W = await import('../src/core/worth.ts');
  const day = T.buildDay([{ jobId: 'j', jobNumber: 1, store: 'S', fault: 'f', goAt: '2026-10-12T06:00:00Z', arrivedAt: '2026-10-12T06:30:00Z', startedAt: null, endedAt: '2026-10-12T09:00:00Z', pauses: [], state: 'done' }],
    [{ at: '2026-10-12T05:30:00Z', registration: 'X', mode: 'in' }], '2026-10-12T15:00:00Z');
  assert.equal(day.unaccountedMin, 30, 'scanned in at 05:30, went at 06:00');
  const w = T.withExtras(day, [{ id: 'a', kind: 'getting_ready', start: '2026-10-12T05:30:00Z', minutes: 30, note: null }, { id: 'b', kind: 'driving_back', start: '2026-10-12T09:00:00Z', minutes: 25, note: null }]);
  assert.equal(w.unaccountedMin, 0);
  assert.equal(w.officeMin, 30);
  assert.equal(w.travelMin, 30 + 25, 'driving back is travel');
  assert.equal(T.payOf(w, '2026-10-12').paidMin, 30 + 150 + 30 + 25);
  assert.deepEqual(T.withExtras(w, w.extras!), w, 'the same again');
  assert.match(T.extraClash(day, '2026-10-12T06:15:00Z', 30, [], '2026-10-12T15:00:00Z')!, /job 1/);
  assert.equal(T.extraClash(day, '2026-10-12T09:00:00Z', 30, [], '2026-10-12T15:00:00Z'), null);
  assert.match(T.extraClash(day, '2026-10-12T14:50:00Z', 30, [], '2026-10-12T15:00:00Z')!, /later than now/);
  const hours = T.DEFAULT_HOURS;
  const trip = (o: Partial<Parameters<typeof T.tripCheck>[0]>) => T.tripCheck({ id: 't', startedAt: '2026-10-12T08:00:00Z', endedAt: '2026-10-12T08:30:00Z', km: 10, registration: 'X', purpose: 'job', ...o }, { hours, mayTakeHome: false, home: { lat: -28.75, lng: 32.05 } });
  assert.deepEqual(trip({}).why, []);
  assert.deepEqual(trip({ purpose: 'none' }).why, ['no_reason']);
  assert.deepEqual(trip({ purpose: 'fuel', startedAt: '2026-10-12T17:00:00Z', endedAt: '2026-10-12T17:20:00Z' }).why, ['after_hours'], '19:00 in South Africa');
  assert.deepEqual(trip({ purpose: 'fuel', startedAt: '2026-10-11T08:00:00Z', endedAt: '2026-10-11T08:20:00Z' }).why, ['after_hours'], 'a Sunday');
  assert.deepEqual(trip({ purpose: 'commute' }).why, ['home']);
  assert.deepEqual(trip({ purpose: 'office', end: { lat: -28.7501, lng: 32.0501 } }).why, ['home'], 'ended at his home');
  assert.deepEqual(trip({ start: { lat: -28.78, lng: 32.03 }, storeAt: { lat: -28.75, lng: 32.03 }, km: 25 }).why, ['detour'], '3 km away, drove 25 km');
  assert.equal(trip({ purpose: 'none', allowed: { by: 'M', note: 'ok', at: '' } }).unauthorised, false);
  assert.deepEqual(T.tripCheck({ id: 't', startedAt: '2026-10-12T06:00:00Z', endedAt: null, km: 5, registration: 'X', purpose: 'commute' }, { hours, mayTakeHome: true, home: null }).why, [], 'he may take it home');
  const worth = W.worthOf({ days: 20, paidMin: 160 * 60, workMin: 100 * 60, travelMin: 40 * 60, officeMin: 20 * 60, unaccountedMin: 0, invoicedMin: 110 * 60, jobsFinished: 40, jobsUnfinished: 3, callbacks: 1, flags: 0, missingSheets: 0,
    unauthorisedTrips: 1, unauthorisedKm: 20, km: 2000, kmEstimated: false, revenueCents: 9_000_000, costPerHourCents: 15000, costPerKmCents: 400 });
  assert.equal(worth.labourCostCents, 2_400_000);
  assert.equal(worth.vehicleCostCents, 800_000);
  assert.equal(worth.netCents, 5_800_000);
  assert.equal(worth.perRand, 2.81);
  assert.equal(worth.recoveryPct, 68.8);
  assert.equal(worth.verdict.tone, 'good');
  assert.equal(W.moneyLines(worth).find(l => l.label.startsWith('Of that'))!.value, 'R 80,00');
});

test('pastel set-up: reads Pastel\'s lists with or without headings, matches names, suggests where lines go', async () => {
  const PS = await import('../src/core/pastelSetup.ts');
  // Pastel's own export: no headings; the code is the column of unique codes, the name the column with words.
  const raw = [['FRE001', 'FreshMart Group (Pty) Ltd', '0', 'Y'], ['SPA002', 'Spar Central', '0', 'Y'], ['TSE003', 'Tsebo Call Centre CC', '0', 'N']];
  assert.deepEqual(PS.readPastelList(raw), [{ code: 'FRE001', name: 'FreshMart Group (Pty) Ltd' }, { code: 'SPA002', name: 'Spar Central' }, { code: 'TSE003', name: 'Tsebo Call Centre CC' }]);
  // A listing report with headings.
  const report = [['Customer listing', ''], ['Account', 'Name', 'Balance'], ['FRE001', 'FreshMart Group', '1200.00'], ['', 'Total', '1200.00']];
  assert.deepEqual(PS.readPastelList(report), [{ code: 'FRE001', name: 'FreshMart Group' }]);
  assert.deepEqual(PS.readPastelList([['just words here', 'and more words']]), []);
  // Names: (Pty) Ltd, CC and punctuation don't matter; a close name is "check", none is "none"; a known code is "has".
  const theirs = PS.readPastelList(raw);
  const m = PS.matchNames([
    { id: '1', name: 'FreshMart Group', code: null }, { id: '2', name: 'SPAR - Central', code: null }, { id: '3', name: 'Tsebo', code: null },
    { id: '4', name: 'Woolworths', code: null }, { id: '5', name: 'Anything', code: 'TSE003' },
  ], theirs);
  assert.deepEqual(m.map(x => [x.id, x.how, x.code]), [['1', 'sure', 'FRE001'], ['2', 'sure', 'SPA002'], ['3', 'sure', 'TSE003'], ['4', 'none', null], ['5', 'has', 'TSE003']]);
  // Stock: the stockroom code is Pastel's, or a match by description.
  const items = PS.matchItems([{ id: 'a', code: 'FUSE-10A', description: 'Fuse 10A', pastelCode: null }, { id: 'b', code: 'V1', description: 'Water inlet valve', pastelCode: null }],
    [{ code: 'FUSE-10A', name: 'Fuse 10 amp' }, { code: 'VAL001', name: 'Water Inlet Valve' }]);
  assert.deepEqual(items.map(x => [x.how, x.code]), [['has', 'FUSE-10A'], ['sure', 'VAL001']]);
  // Lines: labour as a service item when there is one, sales and purchases GL accounts, returns for credit notes.
  const s = PS.suggestLineCodes(
    [{ code: '1000000', name: 'Sales' }, { code: '1050000', name: 'Sales Returns' }, { code: '2000000', name: 'Purchases' }, { code: '1100000', name: 'Travel Recovered' }],
    [{ code: 'LABOUR', name: 'Labour per hour' }, { code: 'CALLOUT', name: 'Call-out fee' }]);
  assert.deepEqual(s.labour, { code: 'LABOUR', lineType: 4, name: 'Labour per hour' });
  assert.deepEqual(s.call_out, { code: 'CALLOUT', lineType: 4, name: 'Call-out fee' });
  assert.equal(s.travel?.code, '1100000');
  assert.equal(s.bought_out?.code, '1000000');
  assert.equal(s.credit?.code, '1050000');
  assert.equal(s.purchases?.code, '2000000');
});

test('stock search: codes with or without dashes, word starts, plurals, typos, sizes and trade words; best first', async () => {
  const { findStock, stockScore } = await import('../src/core/stockSearch.ts');
  const items = [
    { code: 'VALVE-01', description: 'Water inlet valve 24V', supplierCode: 'WV-24', supplierName: 'Scotsman Parts SA' },
    { code: 'CONT-25A', description: 'Contactor 25A 230V coil', supplierName: 'Voltex Richards Bay' },
    { code: 'FUSE-10A', description: 'Fuse 10A' },
    { code: 'GAS-R404', description: 'Refrigerant R404A', supplierName: 'Refrigeration Supplies' },
    { code: 'SEAL-04', description: 'Oven door seal 1/1' },
    { code: 'CAB-25', description: 'Cable 2.5mm twin and earth' },
    { code: 'TIE-300', description: 'Cable ties 300 mm (pack of 100)' },
    { code: 'VALVE-02', description: 'Drain valve 230V' },
  ];
  const first = (q: string) => findStock(items, q)[0]?.code;
  assert.equal(first('valve01'), 'VALVE-01', 'code without the dash');
  assert.equal(first('VALVE-02'), 'VALVE-02', 'exact code first');
  assert.equal(first('WV-24'), 'VALVE-01', 'supplier code');
  assert.equal(first('inlet valv'), 'VALVE-01', 'start of a word');
  assert.equal(first('valves 24v'), 'VALVE-01', 'plural and rating');
  assert.equal(first('contacter 25'), 'CONT-25A', 'a typo');
  assert.equal(first('r404'), 'GAS-R404', 'refrigerant by its number');
  assert.equal(first('gasket oven'), 'SEAL-04', 'the trade\'s other word');
  assert.equal(first('2.5 mm cable'), 'CAB-25', 'a size');
  assert.equal(first('2,5mm'), 'CAB-25', 'a comma decimal');
  assert.equal(first('300mm cable ties'), 'TIE-300');
  assert.deepEqual(findStock(items, 'valve').map(i => i.code).sort(), ['VALVE-01', 'VALVE-02']);
  assert.equal(findStock(items, 'banana').length, 0, 'nothing when a word is not there');
  assert.equal(stockScore(items[2], 'fuse 99'), 0);
  assert.equal(findStock(items, '').length, items.length);
});

test('assistants and casual labour: time follows the visit unless typed; quarter hours on the invoice; a casual day rate once a day, spread over that day\'s jobs', async () => {
  const CR = await import('../src/core/crew.ts');
  const visit = { from: '2026-10-12T08:00:00+02:00', to: '2026-10-12T10:10:00+02:00' };
  assert.equal(CR.crewMinutes({ memberId: 'a', workDate: '2026-10-12', minutes: null, visit }), 130);
  assert.equal(CR.crewMinutes({ memberId: 'a', workDate: '2026-10-12', minutes: 45, visit }), 45, 'typed by the office wins');
  assert.equal(CR.crewMinutes({ memberId: 'a', workDate: '2026-10-12', minutes: null, visit: { from: visit.from, to: null } }, new Date('2026-10-12T09:00:00+02:00')), 60, 'still on site');
  assert.equal(CR.crewHours([{ memberId: 'a', workDate: 'd', minutes: 130 }, { memberId: 'b', workDate: 'd', minutes: 50 }]), 3, '180 minutes');
  assert.equal(CR.crewHours([{ memberId: 'a', workDate: 'd', minutes: 61 }]), 1.25, 'per started quarter hour');
  const pay = CR.casualPay([{ memberId: 'j', workDate: '2026-10-12' }, { memberId: 'j', workDate: '2026-10-12' }, { memberId: 'j', workDate: '2026-10-13' }, { memberId: 'k', workDate: '2026-10-12' }],
    id => (id === 'j' ? 35000 : null));
  assert.deepEqual(pay.map(p => [p.memberId, p.dayCount, p.amountCents]), [['j', 2, 70000], ['k', 1, null]]);
  const day = [{ jobId: 'x', memberId: 'j', workDate: 'd', minutes: 120 }, { jobId: 'y', memberId: 'j', workDate: 'd', minutes: 360 }];
  assert.equal(CR.crewCostForJob('x', day, () => ({ dayCents: 40000, hourCents: null })), 10000, 'a quarter of his day');
  assert.equal(CR.crewCostForJob('y', day, () => ({ dayCents: 40000, hourCents: null })), 30000);
  assert.equal(CR.crewCostForJob('x', day, () => ({ dayCents: null, hourCents: 6000 })), 12000, 'an hour rate');
});

test('the weekly timesheet of someone without the app: Monday to Sunday, normal, overtime and double time, and the pay', async () => {
  const CR = await import('../src/core/crew.ts');
  assert.equal(CR.weekStart('2026-10-18'), '2026-10-12', 'Sunday belongs to the week from Monday');
  const items = [
    { id: 'a', date: '2026-10-12', minutes: 420, what: 'Job 1', kind: 'job' as const, jobNumber: 1 },
    { id: 'b', date: '2026-10-12', minutes: 180, what: 'Workshop', kind: 'other' as const },
    { id: 'c', date: '2026-10-18', minutes: 120, what: 'Job 2', kind: 'job' as const, jobNumber: 2 },
  ];
  const rules = { weekdayNormalMin: 480, saturdayNormalMin: 0 };
  const w = CR.crewWeek('2026-10-14', items, rules, { kind: 'assistant', dayRateCents: null, hourRateCents: 6000 });
  assert.equal(w.start, '2026-10-12'); assert.equal(w.end, '2026-10-18');
  assert.deepEqual(w.totals, { minutes: 720, normalMin: 480, overtimeMin: 120, doubleMin: 120, daysWorked: 2 });
  assert.equal(w.pay.cents, 48000 + 18000 + 24000, '8 h normal, 2 h at 1.5, 2 h on Sunday at 2');
  const casual = CR.crewWeek('2026-10-12', items, rules, { kind: 'casual', dayRateCents: 35000, hourRateCents: null });
  assert.deepEqual([casual.pay.basis, casual.pay.cents], ['day', 70000], 'two days at the day rate');
  assert.equal(CR.crewWeek('2026-12-14', [{ id: 'h', date: '2026-12-16', minutes: 300, what: 'Job', kind: 'job' }], rules, null).totals.doubleMin, 300, 'a public holiday is double time');
  assert.equal(CR.crewWeek('2026-10-12', items, rules, { kind: 'assistant', dayRateCents: null, hourRateCents: null }).pay.cents, null, 'no rate: no amount');
});

test('colour themes: every ready-made colour and any own colour keep text on buttons readable, on dark and on light screens', async () => {
  const T = await import('../src/core/themes.ts');
  for (const k of T.ACCENT_KEYS) {
    const c = T.accentColours(k);
    assert.ok(T.contrast(c.dark, T.DARK_TEXT) >= 4.5, `${k} on dark screens`);
    assert.ok(T.contrast(c.light, '#FFFFFF') >= 4.5, `${k} on light screens`);
  }
  for (const own of ['#FFFF00', '#000080', '#E8701A', '#777777', '#00FF00', '#111111', '#FFFFFF']) {
    const c = T.accentColours(own as `#${string}`);
    assert.ok(T.contrast(c.dark, T.DARK_TEXT) >= 4.5 && T.contrast(c.light, '#FFFFFF') >= 4.5, own);
  }
  assert.equal(T.isAccent('teal'), true); assert.equal(T.isAccent('#12ab9F'), true);
  assert.equal(T.isAccent('nope'), false); assert.equal(T.isAccent('#12ab9'), false); assert.equal(T.isAccent('red; drop'), false);
});
