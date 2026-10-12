import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorWithDefaults as A, can, departmentsFor, effectivePermissions } from '../src/core/permissions.ts';
import * as J from '../src/core/jobCard.ts';
import * as R from '../src/core/rules.ts';

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
  assert.ok(!can(admin, 'assign_stock'));
});

test('stockroom is admin level plus stock functions', () => {
  assert.ok(can(stockroom, 'assign_stock'));
  assert.ok(can(stockroom, 'run_stocktake'));
  assert.ok(can(stockroom, 'view_all_job_cards'));
  assert.ok(!can(stockroom, 'view_employee_log', techInD1));
});

test('management is limited to its own department', () => {
  assert.ok(can(mgrD1, 'view_employee_log', techInD1));
  assert.ok(can(mgrD1, 'mark_technician_left', techInD1));
  assert.ok(!can(mgrD2, 'view_employee_log', techInD1));
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
