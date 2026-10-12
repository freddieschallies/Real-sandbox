// Integration tests: real HTTP requests against a fresh test database.
// Needs TEST_DATABASE_ADMIN_URL (a server where the test database can be dropped and re-created).
// The app runs as its own restricted database user, exactly as in production, so row-level
// security is really in force. `db` below is the owner, used only to set up and inspect.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';
import { ensureAppRole, migrate } from '../src/migrate.ts';
import { createCompany } from '../src/routes/platform.ts';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@localhost:5433/postgres?host=/tmp';
const TEST_DB = 'realsandbox_test';
const TEST_URL = ADMIN_URL.replace(/\/postgres(\?|$)/, `/${TEST_DB}$1`);
const PW = 'test-password-123';

const APP_URL = TEST_URL.replace('postgres://postgres@', 'postgres://rs_app_test:test@');

let db: pg.Pool;       // owner connection, company A set on every connection
let owner: pg.Pool;    // owner connection, no company set
let appDb: pg.Pool;    // the app's own restricted connection
let app: FastifyInstance;
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};

const NOW = '2026-10-12T07:00:00+02:00';
const at = (h: number, m = 0) => `2026-10-12T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+02:00`;
const STORE = { lat: -28.7807, lng: 32.0383 };
const SAFE = { areaSafe: true, isolated: true, publicClear: true };

async function call(who: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: object, extra: Record<string, string> = {}) {
  const res = await app.inject({ method, url, payload: body, headers: { ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}), ...extra } });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
}

/** Sends a multipart form with text fields and one small image, the way the phone uploads photos. */
async function upload(who: string, url: string, fields: Record<string, string>, mime = 'image/jpeg') {
  const boundary = '----rs' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.jpg"\r\nContent-Type: ${mime}\r\n\r\n`));
  parts.push(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await app.inject({
    method: 'POST', url, payload: Buffer.concat(parts),
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  return { status: res.statusCode, body: res.json() };
}

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  owner = new pg.Pool({ connectionString: TEST_URL });
  await migrate(owner);
  await ensureAppRole(owner, APP_URL);
  appDb = new pg.Pool({ connectionString: APP_URL });
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'rs-uploads-'));

  // Company A is set up the way the platform owner would: company + its first Creator.
  const a = await createCompany(appDb, 'ZSP Test', { name: 'creator', email: 'creator@zsp.test', password: PW });
  ids.company = a.companyId;
  ids.creator = a.creatorUserId;
  db = new pg.Pool({ connectionString: TEST_URL });
  db.on('connect', c => { c.query("SELECT set_config('app.company_id', $1, false)", [ids.company]); });

  const hash = await hashPassword(PW);
  const q = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rows[0];
  ids.dept = (await q("INSERT INTO departments (name) VALUES ('Refrigeration') RETURNING id", [])).id;
  await db.query('UPDATE users SET department_id = $1 WHERE id = $2', [ids.dept, ids.creator]);
  const user = async (key: string, level: string) => {
    ids[key] = (await q('INSERT INTO users (full_name, email, login_level, department_id, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [key, `${key}@zsp.test`, level, ids.dept, hash])).id;
    await db.query('INSERT INTO logins (email, user_id, company_id) VALUES ($1, $2, $3)', [`${key}@zsp.test`, ids[key], ids.company]);
  };
  await user('admin', 'admin');
  await user('director', 'director');
  await user('manager', 'management');
  await user('tech', 'technician');
  await user('tech2', 'technician');
  await db.query('UPDATE departments SET manager_id = $1 WHERE id = $2', [ids.manager, ids.dept]);
  ids.client = (await q("INSERT INTO clients (name) VALUES ('FreshMart') RETURNING id", [])).id;
  ids.store = (await q("INSERT INTO stores (client_id, name, lat, lng) VALUES ($1, 'FreshMart Meerensee', $2, $3) RETURNING id", [ids.client, STORE.lat, STORE.lng])).id;
  ids.equipment = (await q("INSERT INTO equipment (store_id, brand, model, description) VALUES ($1, 'Scotsman', 'AC 86', 'Ice machine') RETURNING id", [ids.store])).id;
  ids.seal = (await q("INSERT INTO stock_items (code, description) VALUES ('VALVE-01', 'Water inlet valve') RETURNING id", [])).id;
  await db.query("INSERT INTO stock_movements (stock_item_id, qty, kind, to_stockroom, created_by) VALUES ($1, 10, 'receive', true, $2)", [ids.seal, ids.admin]);
  await db.query("INSERT INTO stock_movements (stock_item_id, qty, kind, from_stockroom, to_technician_id, created_by) VALUES ($1, 2, 'assign', true, $2, $3)", [ids.seal, ids.tech, ids.admin]);
  ids.policy = (await q("INSERT INTO policy_versions (version, body) VALUES ('1.0', 'Vehicle and App Monitoring Policy') RETURNING id", [])).id;

  app = await buildApp(appDb, { jwtSecret: 'x'.repeat(40) });
});

after(async () => {
  await app?.close();
  await db?.end();
  await appDb?.end();
  await owner?.end();
});

test('login: wrong password refused, right password gives a token', async () => {
  assert.equal((await call('', 'POST', '/auth/login', { email: 'tech@zsp.test', password: 'nope' })).status, 401);
  for (const who of ['creator', 'director', 'admin', 'manager', 'tech', 'tech2']) {
    const r = await call('', 'POST', '/auth/login', { email: `${who}@zsp.test`, password: PW });
    assert.equal(r.status, 200);
    tokens[who] = r.body.token;
  }
  assert.equal((await call('', 'GET', '/jobs')).status, 401, 'no token');
});

test('nothing works until the monitoring policy is acknowledged', async () => {
  const r = await call('tech', 'GET', '/jobs');
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'policy_required');
  assert.equal((await call('tech', 'GET', '/me')).body.policyAcknowledged, false);
  const pol = await call('tech', 'GET', '/policy/current');
  assert.equal(pol.body.version, '1.0');
  for (const who of ['creator', 'director', 'admin', 'manager', 'tech', 'tech2']) {
    assert.equal((await call(who, 'POST', '/policy/acknowledge', { policyVersionId: ids.policy })).status, 200);
  }
  assert.equal((await call('tech', 'GET', '/jobs')).status, 200);
});

test('only Admin and above can create jobs; the reported fault becomes the first work item', async () => {
  const job = { jobType: 'breakdown', storeId: ids.store, faultReported: 'Ice machine not dispensing', scheduledDate: '2026-10-12', leadTechnicianId: ids.tech, clientOrderRef: 'PO-5521' };
  assert.equal((await call('tech', 'POST', '/jobs', job)).status, 403);
  const r = await call('admin', 'POST', '/jobs', job);
  assert.equal(r.status, 201);
  ids.job = r.body.id;
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].origin, 'reported');
  assert.equal(r.body.currentState, 'not_started');
});

test('technicians see only their own jobs and cannot act on others', async () => {
  assert.equal((await call('tech', 'GET', '/jobs')).body.length, 1);
  assert.equal((await call('tech2', 'GET', '/jobs')).body.length, 0);
  assert.equal((await call('admin', 'GET', '/jobs')).body.length, 1);
  assert.equal((await call('tech2', 'POST', `/jobs/${ids.job}/go`, { at: NOW })).status, 403);
  assert.equal((await call('tech2', 'GET', `/jobs/${ids.job}`)).status, 403);
});

test('the forced path: no skipping, geofence on arrival, Done blocked until every item is complete', async () => {
  const J = `/jobs/${ids.job}`;
  assert.equal((await call('tech', 'POST', `${J}/start`, { at: at(7) })).status, 409, 'start before Go');
  assert.equal((await call('tech', 'POST', `${J}/go`, { at: at(7) })).status, 200);

  const far = await call('tech', 'POST', `${J}/arrive`, { at: at(7, 30), position: { lat: -28.75, lng: 32.0 }, managerName: 'Sipho', safety: SAFE });
  assert.equal(far.status, 409);
  assert.match(far.body.reasons.join(' '), /not at the store/);

  assert.equal((await call('tech', 'POST', `${J}/arrive`, { at: at(7, 30), position: STORE, managerName: 'Sipho', safety: SAFE })).status, 200);
  assert.equal((await call('tech', 'POST', `${J}/start`, { at: at(7, 35) })).status, 200);

  // A second problem found on site
  const added = await call('tech', 'POST', `${J}/items`, { title: 'Drain line blocked' });
  assert.equal(added.body.items.length, 2);
  const [reported, found] = added.body.items;
  assert.equal(found.origin, 'found_on_site');

  const early = await call('tech', 'POST', `${J}/done`, { at: at(8) });
  assert.equal(early.status, 409);
  assert.ok(early.body.reasons.some((r: string) => r.includes('before photo')));

  // "fixed" is not a full sentence
  const lazy = await call('tech', 'PATCH', `${J}/items/${reported.id}`, { found: 'fixed', did: 'done' });
  assert.ok(lazy.body.items[0].missing.some((m: string) => m.includes('full sentence')));

  // Work item 1: full details, photos, van stock
  await upload('tech', `${J}/items/${reported.id}/photos`, { kind: 'before', takenAt: at(7, 40) });
  await call('tech', 'PATCH', `${J}/items/${reported.id}`, {
    equipmentId: ids.equipment, faultType: 'refrigeration',
    found: 'Water inlet valve blocked with scale', did: 'Replaced the inlet valve and flushed the line',
    tested: 'yes', outcome: 'complete',
  });
  const tooMany = await call('tech', 'POST', `${J}/items/${reported.id}/materials`, { stockItemId: ids.seal, qty: 5 });
  assert.equal(tooMany.status, 409, 'cannot use more than is in the van');
  assert.equal((await call('tech', 'POST', `${J}/items/${reported.id}/materials`, { stockItemId: ids.seal, qty: 1 })).status, 200);
  const after1 = await upload('tech', `${J}/items/${reported.id}/photos`, { kind: 'after', takenAt: at(8, 30) });
  assert.equal(after1.body.items[0].status, 'finished');

  // Work item 2: needs a quote
  await upload('tech', `${J}/items/${found.id}/photos`, { kind: 'before', takenAt: at(8, 35) });
  await upload('tech', `${J}/items/${found.id}/photos`, { kind: 'after', takenAt: at(8, 50) });
  const it2 = await call('tech', 'PATCH', `${J}/items/${found.id}`, {
    equipmentId: ids.equipment, faultType: 'water', noMaterials: true,
    found: 'Drain line cracked behind the unit', did: 'Cleared the blockage and taped the crack for now',
    tested: 'partly', outcome: 'needs_quote', stillNeeded: 'Replace the drain line section, quote to follow',
  });
  assert.equal(it2.body.items[1].status, 'finished');

  // Pause for parts: excluded from job time
  await call('tech', 'POST', `${J}/pause`, { at: at(9), reason: 'collecting_parts' });
  assert.equal((await call('tech', 'POST', `${J}/done`, { at: at(9, 10) })).status, 409, 'cannot finish while paused');
  await call('tech', 'POST', `${J}/resume`, { at: at(9, 30) });

  const done = await call('tech', 'POST', `${J}/done`, { at: at(10) });
  assert.equal(done.status, 200);
  assert.equal(done.body.jobMinutes, 145 - 30);

  const van = await db.query('SELECT qty FROM technician_stock WHERE technician_id = $1 AND stock_item_id = $2', [ids.tech, ids.seal]);
  assert.equal(Number(van.rows[0].qty), 1, 'valve taken off his van stock');
});

test('close-out: manager unavailable needs a reason and a name, raises a flag, then the card locks', async () => {
  const J = `/jobs/${ids.job}`;
  const bad = await call('tech', 'POST', `${J}/close`, { at: at(10, 5), signOff: { signature: false, reason: '', spokeTo: '' } });
  assert.equal(bad.status, 409);
  const ok = await call('tech', 'POST', `${J}/close`, { at: at(10, 5), signOff: { signature: false, reason: 'Manager at a regional meeting', spokeTo: 'Assistant manager Thandi' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'closed');

  const flags = await db.query("SELECT flag_type, technician_id FROM flags WHERE job_id = $1", [ids.job]);
  assert.deepEqual(flags.rows.map(r => r.flag_type), ['manager_unavailable']);

  assert.equal((await call('tech', 'POST', `${J}/items`, { title: 'Late addition' })).status, 409, 'closed card is locked');
  await assert.rejects(db.query("UPDATE jobs SET fault_reported = 'edited' WHERE id = $1", [ids.job]), /closed and locked/);
});

test('a multi-day job: Continue later, then a second visit and a signed close', async () => {
  const created = await call('admin', 'POST', '/jobs', { jobType: 'breakdown', storeId: ids.store, faultReported: 'Cold room not holding temperature', scheduledDate: '2026-10-12', leadTechnicianId: ids.tech });
  const J = `/jobs/${created.body.id}`;
  const item = created.body.items[0].id;
  await call('tech', 'POST', `${J}/go`, { at: at(11) });
  await call('tech', 'POST', `${J}/arrive`, { at: at(11, 20), position: STORE, managerName: 'Sipho', safety: SAFE });
  await call('tech', 'POST', `${J}/start`, { at: at(11, 25) });
  const vague = await call('tech', 'POST', `${J}/continue-later`, { at: at(16), progress: 'busy', reason: 'waiting_for_parts', plannedReturn: '2026-10-14', managerInformed: 'Sipho' });
  assert.equal(vague.status, 409);
  const parked = await call('tech', 'POST', `${J}/continue-later`, { at: at(16), progress: 'Compressor seized, new one ordered from the supplier', reason: 'waiting_for_parts', plannedReturn: '2026-10-14', managerInformed: 'Sipho' });
  assert.equal(parked.body.status, 'continue_later');

  await call('tech', 'POST', `${J}/go`, { at: '2026-10-14T07:00:00+02:00' });
  await call('tech', 'POST', `${J}/arrive`, { at: '2026-10-14T07:20:00+02:00', position: STORE, managerName: 'Sipho', safety: SAFE });
  await call('tech', 'POST', `${J}/start`, { at: '2026-10-14T07:25:00+02:00' });
  await upload('tech', `${J}/items/${item}/photos`, { kind: 'before', takenAt: '2026-10-14T07:30:00+02:00' });
  await upload('tech', `${J}/items/${item}/photos`, { kind: 'after', takenAt: '2026-10-14T09:00:00+02:00' });
  await call('tech', 'PATCH', `${J}/items/${item}`, {
    equipmentId: ids.equipment, faultType: 'refrigeration', noMaterials: true,
    found: 'Compressor seized after the oil ran low', did: 'Fitted the new compressor, regassed and tested the cold room',
    tested: 'yes', outcome: 'complete',
  });
  await call('tech', 'POST', `${J}/done`, { at: '2026-10-14T09:10:00+02:00' });
  const noSig = await call('tech', 'POST', `${J}/close`, { at: '2026-10-14T09:15:00+02:00', signOff: { signature: true, managerName: 'Sipho', signaturePhotoId: '00000000-0000-4000-8000-000000000001' } });
  assert.equal(noSig.status, 409, 'signature must be uploaded first');
  const sig = await upload('tech', '/photos', { kind: 'signature', takenAt: '2026-10-14T09:14:00+02:00', jobId: created.body.id }, 'image/png');
  assert.equal(sig.status, 201);
  const closed = await call('tech', 'POST', `${J}/close`, { at: '2026-10-14T09:15:00+02:00', signOff: { signature: true, managerName: 'Sipho', signaturePhotoId: sig.body.id } });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.visits.length, 2);
  assert.equal(closed.body.manager_name, 'Sipho');
});

test('offline replay: the same request sent twice is applied once', async () => {
  const created = await call('admin', 'POST', '/jobs', { jobType: 'breakdown', storeId: ids.store, faultReported: 'Bain marie not heating', scheduledDate: '2026-10-15', leadTechnicianId: ids.tech });
  ids.job3 = created.body.id;
  const key = { 'idempotency-key': 'go-job3-abcdef12' };
  const first = await call('tech', 'POST', `/jobs/${ids.job3}/go`, { at: '2026-10-15T07:00:00+02:00' }, key);
  const again = await call('tech', 'POST', `/jobs/${ids.job3}/go`, { at: '2026-10-15T07:00:00+02:00' }, key);
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(again.headers['idempotent-replay'], 'true');
  const visits = await db.query('SELECT count(*)::int AS n FROM job_visits WHERE job_id = $1', [ids.job3]);
  assert.equal(visits.rows[0].n, 1, 'only one visit despite two sends');
  const misuse = await call('tech', 'POST', `/jobs/${ids.job3}/start`, { at: '2026-10-15T07:10:00+02:00' }, key);
  assert.equal(misuse.status, 422, 'a key cannot be reused for a different request');
});

test('photo uploads: images only, stored and readable', async () => {
  const J = `/jobs/${ids.job3}`;
  const item = (await call('tech', 'GET', J)).body.items[0].id;
  const bad = await upload('tech', `${J}/items/${item}/photos`, { kind: 'before', takenAt: '2026-10-15T07:30:00+02:00' }, 'application/pdf');
  assert.equal(bad.status, 400);
  const ok = await upload('tech', `${J}/items/${item}/photos`, { kind: 'before', takenAt: '2026-10-15T07:30:00+02:00' });
  assert.equal(ok.status, 200);
  const photoId = (await db.query("SELECT id FROM photos WHERE work_item_id = $1", [item])).rows[0].id;
  const res = await app.inject({ method: 'GET', url: `/photos/${photoId}`, headers: { authorization: `Bearer ${tokens.admin}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload.length, 10);
});

test("my day, my van stock", async () => {
  const day = await call('tech', 'GET', '/me/today?date=2026-10-15');
  assert.ok(day.body.jobs.some((j: { id: string }) => j.id === ids.job3));
  const stock = await call('tech', 'GET', '/me/stock');
  assert.deepEqual(stock.body.map((s: { code: string; qty: number }) => [s.code, s.qty]), [['VALVE-01', 1]]);
});

test('vehicle scan-in: reason needed for another vehicle, managers told, tracker driver queued', async () => {
  const v = async (reg: string, barcode: string, owner: string) => {
    const id = (await db.query('INSERT INTO vehicles (registration, tank_litres, barcode) VALUES ($1, 80, $2) RETURNING id', [reg, barcode])).rows[0].id;
    await db.query('INSERT INTO technician_settings (user_id, usual_vehicle_id) VALUES ($1, $2)', [owner, id]);
    return id;
  };
  ids.v1 = await v('ND 412-778', 'RS-V1', ids.tech);
  ids.v2 = await v('ND 503-221', 'RS-V2', ids.tech2);
  const noReason = await call('tech', 'POST', '/vehicles/scan', { barcode: 'RS-V2', mode: 'driving', at: '2026-10-15T06:50:00+02:00' });
  assert.equal(noReason.status, 409);
  const ok = await call('tech', 'POST', '/vehicles/scan', { barcode: 'RS-V2', mode: 'driving', at: '2026-10-15T06:50:00+02:00', reason: 'breakdown' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.vehicle.registration, 'ND 503-221');
  const notes = await call('manager', 'GET', '/me/notifications');
  assert.ok(notes.body.some((n: { kind: string }) => n.kind === 'vehicle_swap'));
  const outbox = await db.query('SELECT driver_id FROM tracker_driver_outbox WHERE vehicle_id = $1', [ids.v2]);
  assert.equal(outbox.rows[0].driver_id, ids.tech);
  // back into his own vehicle: no reason needed, the other scan is released
  assert.equal((await call('tech', 'POST', '/vehicles/scan', { barcode: 'RS-V1', mode: 'driving', at: '2026-10-15T06:55:00+02:00' })).status, 200);
  const open = await db.query('SELECT count(*)::int AS n FROM vehicle_scans WHERE user_id = $1 AND released_at IS NULL', [ids.tech]);
  assert.equal(open.rows[0].n, 1);
});

test('fuel: slip required, logged against the vehicle, impossible litres flagged', async () => {
  const noSlip = await call('tech', 'POST', '/fuel', { litres: 50, amountCents: 115000, slipPhotoId: '00000000-0000-4000-8000-000000000002', at: '2026-10-15T08:00:00+02:00' });
  assert.equal(noSlip.status, 409);
  const slip = await upload('tech', '/photos', { kind: 'fuel_slip', takenAt: '2026-10-15T08:00:00+02:00' });
  const ok = await call('tech', 'POST', '/fuel', { litres: 50, amountCents: 115000, slipPhotoId: slip.body.id, at: '2026-10-15T08:00:00+02:00' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.vehicle, 'ND 412-778', 'defaults to the vehicle he scanned into');
  const slip2 = await upload('tech', '/photos', { kind: 'fuel_slip', takenAt: '2026-10-15T12:00:00+02:00' });
  const big = await call('tech', 'POST', '/fuel', { litres: 95, amountCents: 220000, slipPhotoId: slip2.body.id, at: '2026-10-15T12:00:00+02:00' });
  assert.equal(big.body.problems.length, 1);
});

test('flags: technician explains, Management resolves with a note, Admin cannot see', async () => {
  const mine = await call('tech', 'GET', '/me/flags');
  const fuel = mine.body.find((f: { flag_type: string }) => f.flag_type === 'fuel_mismatch');
  assert.ok(fuel);
  assert.equal((await call('tech', 'POST', `/flags/${fuel.id}/explain`, { explanation: 'oops' })).status, 400);
  assert.equal((await call('tech', 'POST', `/flags/${fuel.id}/explain`, { explanation: 'Filled a jerry can for the generator at the store, slip shows both' })).status, 200);
  assert.equal((await call('admin', 'GET', '/flags')).status, 403);
  const inbox = await call('manager', 'GET', '/flags');
  const f = inbox.body.find((x: { id: string }) => x.id === fuel.id);
  assert.equal(f.status, 'explained');
  assert.equal((await call('manager', 'POST', `/flags/${fuel.id}/resolve`, { note: '' })).status, 400);
  assert.equal((await call('manager', 'POST', `/flags/${fuel.id}/resolve`, { note: 'Checked the slip, generator fuel for the store. Fine.' })).status, 200);
});

test('supply runs: top-up waits for approval, a new supplier is learned and flagged, stock lands in the van', async () => {
  const run = await call('tech', 'POST', '/supply-runs', { at: '2026-10-15T13:00:00+02:00', purpose: 'stock_topup', newSupplierName: 'Coastal Electrical Supplies' });
  assert.equal(run.status, 201);
  assert.equal(run.body.status, 'awaiting_approval');
  assert.equal(run.body.newSupplier, true);
  const slip = await upload('tech', '/photos', { kind: 'supplier_slip', takenAt: '2026-10-15T13:30:00+02:00' });
  const early = await call('tech', 'POST', `/supply-runs/${run.body.id}/collect`, { at: '2026-10-15T13:30:00+02:00', slipPhotoId: slip.body.id });
  assert.equal(early.status, 409, 'cannot collect before approval');
  assert.equal((await call('tech2', 'POST', `/supply-runs/${run.body.id}/approve`)).status, 403);
  assert.equal((await call('manager', 'POST', `/supply-runs/${run.body.id}/approve`)).status, 200);
  const done = await call('tech', 'POST', `/supply-runs/${run.body.id}/collect`, { at: '2026-10-15T13:30:00+02:00', slipPhotoId: slip.body.id, slipAmountCents: 45000, stock: [{ stockItemId: ids.seal, qty: 3 }] });
  assert.equal(done.status, 200);
  const stock = await call('tech', 'GET', '/me/stock');
  assert.equal(stock.body[0].qty, 4);
  const flags = await db.query("SELECT 1 FROM flags WHERE flag_type = 'new_supplier'");
  assert.equal(flags.rowCount, 1);
});

test('timesheet: checked against the job timers, mismatch flagged, one sheet per day', async () => {
  // Job 1 on 12 Oct: 145 min on site minus a 30 min pause = 115 recorded
  const sheet = await call('tech', 'POST', '/timesheets', { workDate: '2026-10-12', at: '2026-10-13T07:00:00+02:00', lines: [{ jobId: ids.job, minutes: 180 }] });
  assert.equal(sheet.status, 201);
  assert.equal(sheet.body.matches, false);
  const line = sheet.body.lines.find((l: { jobId: string }) => l.jobId === ids.job);
  assert.equal(line.recordedMinutes, 115);
  const flag = await db.query("SELECT details FROM flags WHERE flag_type = 'timesheet_mismatch' AND technician_id = $1", [ids.tech]);
  assert.equal(flag.rowCount, 1);
  assert.equal((await call('tech', 'POST', '/timesheets', { workDate: '2026-10-12', at: '2026-10-13T07:05:00+02:00', lines: [] })).status, 409);
});

test('estimates: prices only from the price list, always marked not official', async () => {
  const J = `/jobs/${ids.job3}`;
  const item = (await call('tech', 'GET', J)).body.items[0].id;
  const body = { at: '2026-10-15T09:00:00+02:00', labourHours: 2, stockLines: [{ stockItemId: ids.seal, qty: 1 }], boughtOutLines: [{ description: 'Element 3kW', qty: 1, estimatedPriceCents: 85000 }] };
  const noPrices = await call('tech', 'POST', `${J}/items/${item}/estimate`, body);
  assert.equal(noPrices.status, 409);
  await db.query("INSERT INTO rates (key, amount_cents, updated_by) VALUES ('labour_per_hour', 55000, $1)", [ids.creator]);
  await db.query('UPDATE stock_items SET selling_price_cents = 32000 WHERE id = $1', [ids.seal]);
  const est = await call('tech', 'POST', `${J}/items/${item}/estimate`, body);
  assert.equal(est.status, 200);
  assert.equal(est.body.label, 'Estimate only, not official');
  assert.equal(est.body.total_cents, 2 * 55000 + 32000 + 85000);
});

test('the CEO decides access: changes apply at once, are logged, and nobody can be locked out', async () => {
  assert.equal((await call('admin', 'GET', '/access/catalogue')).status, 403);
  assert.equal((await call('admin', 'GET', '/flags')).status, 403);
  // CEO gives this one admin read access to flags across all departments
  const g = await call('director', 'PUT', `/access/users/${ids.admin}/view_flags`, { effect: 'grant', scope: 'all_departments' });
  assert.equal(g.status, 200);
  assert.equal((await call('admin', 'GET', '/flags')).status, 200, 'applies on the very next request');
  assert.ok((await call('admin', 'GET', '/me/notifications')).body.some((n: { kind: string }) => n.kind === 'access_changed'), 'the person is told');
  // A scoped permission needs its departments
  assert.equal((await call('director', 'PUT', `/access/users/${ids.admin}/view_employee_log`, { effect: 'grant' })).status, 400);
  // Taking manage_access from all Directors is fine while the Creator keeps it ...
  assert.equal((await call('creator', 'PUT', '/access/levels/director/manage_access', { effect: 'deny' })).status, 200);
  assert.equal((await call('director', 'GET', '/access/catalogue')).status, 403);
  // ... but removing it from the Creator too would leave nobody in charge
  const lock = await call('creator', 'PUT', '/access/levels/creator/manage_access', { effect: 'deny' });
  assert.equal(lock.status, 409);
  assert.equal((await call('creator', 'PUT', '/access/levels/director/manage_access', { effect: 'default' })).status, 200);
  assert.equal((await call('director', 'GET', '/access/catalogue')).status, 200);
  const log = await call('director', 'GET', '/access/changes');
  assert.equal(log.body.length, 3, 'every change is in the history');
  assert.equal(log.body[2].change, 'granted (all departments)');
});

test('platform owner creates a second company, but cannot see any company data', async () => {
  await owner.query("INSERT INTO platform_admins (full_name, email, password_hash) VALUES ('Platform', 'owner@platform.test', $1)", [await hashPassword(PW)]);
  const login = await call('', 'POST', '/platform/login', { email: 'owner@platform.test', password: PW });
  assert.equal(login.status, 200);
  tokens.platform = login.body.token;
  assert.equal((await call('platform', 'GET', '/jobs')).status, 401, 'a platform login is not a company login');
  assert.equal((await call('creator', 'GET', '/platform/companies')).status, 403, 'a company login cannot manage companies');

  const dup = await call('platform', 'POST', '/platform/companies', { name: 'Other Co', creator: { name: 'Clash', email: 'tech@zsp.test', password: PW } });
  assert.equal(dup.status, 409, 'one email = one person = one company');
  const b = await call('platform', 'POST', '/platform/companies', { name: 'Coastal Cooling', creator: { name: 'Bea Creator', email: 'bea@coastal.test', password: PW } });
  assert.equal(b.status, 201);
  ids.companyB = b.body.companyId;
  const list = await call('platform', 'GET', '/platform/companies');
  assert.deepEqual(list.body.map((c: { name: string }) => c.name), ['Coastal Cooling', 'ZSP Test']);
});

test('company B sees nothing of company A, and cannot link to its records', async () => {
  const login = await call('', 'POST', '/auth/login', { email: 'bea@coastal.test', password: PW });
  assert.equal(login.status, 200);
  assert.equal(login.body.company.name, 'Coastal Cooling');
  tokens.bea = login.body.token;
  // Company B has its own policy to publish and acknowledge
  const pb = new pg.Client({ connectionString: TEST_URL });
  await pb.connect();
  await pb.query("SELECT set_config('app.company_id', $1, false)", [ids.companyB]);
  const pol = (await pb.query("INSERT INTO policy_versions (version, body) VALUES ('1.0', 'Coastal policy') RETURNING id")).rows[0].id;
  await pb.end();
  assert.equal((await call('bea', 'GET', '/jobs')).status, 403);
  await call('bea', 'POST', '/policy/acknowledge', { policyVersionId: pol });

  assert.deepEqual((await call('bea', 'GET', '/jobs')).body, [], "A's jobs are invisible");
  assert.equal((await call('bea', 'GET', `/jobs/${ids.job}`)).status, 404, "A's job card cannot be opened by id");
  assert.equal((await call('bea', 'GET', '/flags')).body.length, 0);
  const steal = await call('bea', 'POST', '/jobs', { jobType: 'breakdown', storeId: ids.store, faultReported: 'Using A store', scheduledDate: '2026-10-15', leadTechnicianId: ids.tech });
  assert.equal(steal.status, 400, "cannot create a job on A's store or for A's technician");
  assert.equal((await call('bea', 'GET', `/access/users/${ids.tech}`)).status, 404, "A's people do not exist for B");
  const photo = (await owner.query("SELECT id FROM photos LIMIT 1")).rows[0].id;
  assert.equal((await call('bea', 'GET', `/photos/${photo}`)).status, 404, "A's photos cannot be fetched");
  // B numbers its own jobs from the start
  const pc = new pg.Client({ connectionString: TEST_URL });
  await pc.connect();
  await pc.query("SELECT set_config('app.company_id', $1, false)", [ids.companyB]);
  const cl = (await pc.query("INSERT INTO clients (name) VALUES ('FreshMart') RETURNING id")).rows[0].id;
  const st = (await pc.query("INSERT INTO stores (client_id, name, lat, lng) VALUES ($1, 'FreshMart Meerensee', -28.78, 32.03) RETURNING id", [cl])).rows[0].id;
  const tb = (await pc.query("INSERT INTO users (full_name, email, login_level, password_hash) VALUES ('Ben', 'ben@coastal.test', 'technician', 'x') RETURNING id")).rows[0].id;
  await pc.end();
  const jb = await call('bea', 'POST', '/jobs', { jobType: 'breakdown', storeId: st, faultReported: 'Fridge warm', scheduledDate: '2026-10-15', leadTechnicianId: tb });
  assert.equal(jb.status, 201);
  assert.equal(jb.body.job_number, 10001, 'same client and store names, own numbering');
});

test('the database itself enforces separation, whatever the app asks', async () => {
  const c = await appDb.connect();
  try {
    assert.equal((await c.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n, 0, 'no company set: nothing visible');
    await assert.rejects(c.query("INSERT INTO clients (name) VALUES ('Sneaky')"), 'no company set: cannot write');
    await c.query("SELECT set_config('app.company_id', $1, false)", [ids.companyB]);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n, 1, 'only B\'s one job');
    const upd = await c.query("UPDATE jobs SET priority = 'urgent' WHERE id = $1", [ids.job3]);
    assert.equal(upd.rowCount, 0, "cannot change A's job even by its id");
    await assert.rejects(c.query('INSERT INTO clients (company_id, name) VALUES ($1, $2)', [ids.company, 'Planted']), 'cannot write rows into A');
  } finally {
    await c.query('RESET app.company_id');
    c.release();
  }
});

test('a suspended company is locked out at once', async () => {
  assert.equal((await call('platform', 'PATCH', `/platform/companies/${ids.companyB}`, { active: false })).status, 400, 'needs a reason');
  assert.equal((await call('platform', 'PATCH', `/platform/companies/${ids.companyB}`, { active: false, reason: 'Account overdue' })).status, 200);
  const r = await call('bea', 'GET', '/jobs');
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'company_suspended');
  assert.equal((await call('', 'POST', '/auth/login', { email: 'bea@coastal.test', password: PW })).status, 403);
  assert.equal((await call('tech', 'GET', '/me/stock')).status, 200, 'company A unaffected');
});

test('a disabled login stops working immediately', async () => {
  await db.query('UPDATE users SET login_enabled = false WHERE id = $1', [ids.tech2]);
  assert.equal((await call('tech2', 'GET', '/jobs')).status, 401);
});
