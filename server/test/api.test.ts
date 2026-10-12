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
import type { InvoiceReader } from '../src/invoiceReader.ts';
import { readPendingInvoices } from '../src/routes/stock.ts';
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
// What the pretend invoice reader 'sees' on the next photo.
let fakeReader: InvoiceReader = async () => { throw new Error('no invoice expected'); };
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


/** Uploads the photos and signatures a handover needs and returns the inspection the phone would send. */
async function inspection(who: string, o: { odometerKm?: number; problem?: string; handoverBy?: 'previous_driver' | 'supervisor' | 'remote_approval'; name?: string } = {}) {
  const photo = async (kind: string) => (await upload(who, '/photos', { kind, takenAt: '2026-10-15T06:40:00+02:00' })).body.id as string;
  const sidePhotos: Record<string, string> = {};
  for (const s of ['front', 'back', 'left', 'right', 'dashboard']) sidePhotos[s] = await photo(`vehicle_${s}`);
  const checks: Record<string, { ok: boolean; note?: string }> = {};
  for (const k of ['tyres', 'lights', 'windscreen_mirrors', 'bodywork', 'interior', 'spare_jack', 'fire_extinguisher', 'first_aid', 'triangle', 'licence_disc']) checks[k] = { ok: true };
  const damagePhotos: string[] = [];
  if (o.problem) { checks[o.problem] = { ok: false, note: 'Dent in the left rear door' }; damagePhotos.push(await photo('vehicle_damage')); }
  const by = o.handoverBy ?? 'supervisor';
  return {
    odometerKm: o.odometerKm ?? 120000, fuelLevel: 'half', checks, sidePhotos, damagePhotos,
    driverSignatureId: await photo('handover_signature'),
    handoverBy: by,
    ...(by === 'remote_approval'
      ? { remoteReason: 'Previous driver already left for site' }
      : { handedOverByName: o.name ?? 'Supervisor', handoverSignatureId: await photo('handover_signature') }),
  };
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
  await user('stock', 'stockroom');
  await user('mech', 'mechanic');
  await db.query('UPDATE departments SET manager_id = $1 WHERE id = $2', [ids.manager, ids.dept]);
  ids.client = (await q("INSERT INTO clients (name) VALUES ('FreshMart') RETURNING id", [])).id;
  ids.store = (await q("INSERT INTO stores (client_id, name, lat, lng) VALUES ($1, 'FreshMart Meerensee', $2, $3) RETURNING id", [ids.client, STORE.lat, STORE.lng])).id;
  ids.equipment = (await q("INSERT INTO equipment (store_id, brand, model, description) VALUES ($1, 'Scotsman', 'AC 86', 'Ice machine') RETURNING id", [ids.store])).id;
  ids.seal = (await q("INSERT INTO stock_items (code, description) VALUES ('VALVE-01', 'Water inlet valve') RETURNING id", [])).id;
  await db.query("INSERT INTO stock_movements (stock_item_id, qty, kind, to_stockroom, created_by) VALUES ($1, 10, 'receive', true, $2)", [ids.seal, ids.admin]);
  await db.query("INSERT INTO stock_movements (stock_item_id, qty, kind, from_stockroom, to_technician_id, created_by) VALUES ($1, 2, 'assign', true, $2, $3)", [ids.seal, ids.tech, ids.admin]);
  ids.policy = (await q("INSERT INTO policy_versions (version, body) VALUES ('1.0', 'Vehicle and App Monitoring Policy') RETURNING id", [])).id;

  app = await buildApp(appDb, { jwtSecret: 'x'.repeat(40), invoiceReader: (img, mime) => fakeReader(img, mime) });
});

after(async () => {
  await app?.close();
  await db?.end();
  await appDb?.end();
  await owner?.end();
});

test('login: wrong password refused, right password gives a token', async () => {
  assert.equal((await call('', 'POST', '/auth/login', { email: 'tech@zsp.test', password: 'nope' })).status, 401);
  for (const who of ['creator', 'director', 'admin', 'manager', 'tech', 'tech2', 'stock', 'mech']) {
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
  for (const who of ['creator', 'director', 'admin', 'manager', 'tech', 'tech2', 'stock', 'mech']) {
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
  const noInspection = await call('tech', 'POST', '/vehicles/scan', { barcode: 'RS-V2', mode: 'driving', at: '2026-10-15T06:50:00+02:00', reason: 'breakdown' });
  assert.equal(noInspection.status, 409, 'never inspected: must inspect before driving');
  const ok = await call('tech', 'POST', '/vehicles/scan', { barcode: 'RS-V2', mode: 'driving', at: '2026-10-15T06:50:00+02:00', reason: 'breakdown', inspection: await inspection('tech') });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.vehicle.registration, 'ND 503-221');
  const notes = await call('manager', 'GET', '/me/notifications');
  assert.ok(notes.body.some((n: { kind: string }) => n.kind === 'vehicle_swap'));
  const outbox = await db.query('SELECT driver_id FROM tracker_driver_outbox WHERE vehicle_id = $1', [ids.v2]);
  assert.equal(outbox.rows[0].driver_id, ids.tech);
  // back into his own vehicle: no reason needed, the other scan is released
  assert.equal((await call('tech', 'POST', '/vehicles/scan', { barcode: 'RS-V1', mode: 'driving', at: '2026-10-15T06:55:00+02:00', inspection: await inspection('tech', { odometerKm: 88000 }) })).status, 200);
  const open = await db.query('SELECT count(*)::int AS n FROM vehicle_scans WHERE user_id = $1 AND released_at IS NULL', [ids.tech]);
  assert.equal(open.rows[0].n, 1);
});

test('vehicle scan: the licence disc or the registration finds the vehicle', async () => {
  const disc = '%MVL1CC09%0154%4025T09N%1%4025015ABCD1%ND412778%BCD123X%Bakkie / Bakkie%TOYOTA%HILUX%White / Wit%AHTFR22G406123456%1GD1234567%2027-03-31%';
  const byDisc = await call('tech2', 'GET', `/vehicles/lookup?barcode=${encodeURIComponent(disc)}`);
  assert.equal(byDisc.status, 200);
  assert.equal(byDisc.body.vehicle.registration, 'ND 412-778');
  assert.equal((await call('tech2', 'GET', '/vehicles/lookup?barcode=nd412778')).body.vehicle.registration, 'ND 412-778');
  assert.equal((await call('tech2', 'GET', '/vehicles/lookup?barcode=XX999999')).status, 404);
});

test('vehicle handover: inspect and sign to take over, new damage flagged to the previous driver, remote handover approved', async () => {
  // tech drove V1 last (previous test). tech2 takes it over.
  const look = await call('tech2', 'GET', '/vehicles/lookup?barcode=RS-V1');
  assert.equal(look.status, 200);
  assert.equal(look.body.needsInspection, true);
  assert.equal(look.body.lastDriver.id, ids.tech);
  assert.equal(look.body.lastInspection.odometerKm, 88000);
  const scan = (b: object) => call('tech2', 'POST', '/vehicles/scan', { barcode: 'RS-V1', mode: 'driving', at: '2026-10-15T14:00:00+02:00', reason: 'swapped_with_colleague', ...b });

  assert.equal((await scan({})).status, 409, 'no inspection, no vehicle');
  const lower = await scan({ inspection: await inspection('tech2', { odometerKm: 87000, handoverBy: 'previous_driver', name: 'tech' }) });
  assert.equal(lower.status, 409);
  assert.match(lower.body.reasons.join(), /odometer cannot be lower/);
  const half = await inspection('tech2', { odometerKm: 88150, problem: 'bodywork', handoverBy: 'previous_driver', name: 'tech' });
  const noDamagePhoto = await scan({ inspection: { ...half, damagePhotos: [] } });
  assert.match(noDamagePhoto.body.reasons.join(), /photo of each problem/);
  const someoneElsesPhoto = await upload('tech', '/photos', { kind: 'vehicle_front', takenAt: '2026-10-15T14:00:00+02:00' });
  assert.equal((await scan({ inspection: { ...half, sidePhotos: { ...half.sidePhotos, front: someoneElsesPhoto.body.id } } })).status, 409, 'photos must be his own');

  const ok = await scan({ inspection: half });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.handoverStatus, 'signed');
  const flag = (await db.query("SELECT technician_id, severity, question FROM flags WHERE flag_type = 'vehicle_new_damage'")).rows[0];
  assert.equal(flag.technician_id, ids.tech, 'the previous driver answers for new damage');
  assert.equal(flag.severity, 'high');
  const row = (await db.query('SELECT previous_driver_id, problems, new_problems, acceptance_text FROM vehicle_inspections WHERE driver_id = $1', [ids.tech2])).rows.at(-1);
  assert.equal(row.previous_driver_id, ids.tech);
  assert.deepEqual(row.new_problems, ['bodywork']);
  assert.match(row.acceptance_text, /accept full responsibility/);

  // Same driver scanning back into the same vehicle: no new inspection. Passengers never inspect.
  assert.equal((await call('tech2', 'GET', '/vehicles/lookup?barcode=RS-V1')).body.needsInspection, false);
  assert.equal((await call('tech2', 'POST', '/vehicles/scan', { barcode: 'RS-V1', mode: 'driving', at: '2026-10-15T15:00:00+02:00', reason: 'swapped_with_colleague' })).status, 200);
  assert.equal((await call('tech', 'POST', '/vehicles/scan', { barcode: 'RS-V1', mode: 'riding_along', at: '2026-10-15T15:01:00+02:00' })).status, 200);

  // The bodywork problem is known now, so the next handover doesn't blame anyone for it again.
  const back = await call('tech', 'POST', '/vehicles/scan', {
    barcode: 'RS-V1', mode: 'driving', at: '2026-10-15T17:00:00+02:00',
    inspection: await inspection('tech', { odometerKm: 88200, problem: 'bodywork', handoverBy: 'remote_approval' }),
  });
  assert.equal(back.status, 200);
  assert.equal(back.body.handoverStatus, 'awaiting_approval');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM flags WHERE flag_type = 'vehicle_new_damage'")).rows[0].n, 1);
  assert.equal((await call('tech', 'GET', '/me/today?date=2026-10-15')).body.vehicle.handover_status, 'awaiting_approval');

  assert.equal((await call('tech', 'POST', `/vehicles/inspections/${back.body.inspectionId}/decide`, { approve: true })).status, 403);
  const pending = await call('manager', 'GET', '/vehicles/inspections?status=awaiting_approval');
  assert.equal(pending.body.length, 1);
  assert.equal((await call('manager', 'POST', `/vehicles/inspections/${back.body.inspectionId}/decide`, { approve: false })).status, 400, 'a rejection needs a reason');
  const approved = await call('manager', 'POST', `/vehicles/inspections/${back.body.inspectionId}/decide`, { approve: true });
  assert.equal(approved.body.status, 'approved');
  assert.equal((await call('manager', 'POST', `/vehicles/inspections/${back.body.inspectionId}/decide`, { approve: true })).status, 409);

  // The record is evidence: nobody can change it afterwards, not even directly in the database.
  await assert.rejects(db.query('UPDATE vehicle_inspections SET odometer_km = 1 WHERE id = $1', [back.body.inspectionId]), /cannot be edited/);
  await assert.rejects(db.query('DELETE FROM vehicle_inspections WHERE id = $1', [back.body.inspectionId]), /cannot be deleted/);
});

test('stock control: book out for a job, supplier invoice read and confirmed, use on the job, return confirmed by the stock controller', async () => {
  const created = await call('admin', 'POST', '/jobs', { jobType: 'breakdown', storeId: ids.store, faultReported: 'Cold room door seal torn', scheduledDate: '2026-10-16', leadTechnicianId: ids.tech });
  const jobId = created.body.id as string;
  const itemId = created.body.items[0].id as string;
  const inv = async (who = 'tech') => (await call(who, 'GET', '/me/inventory')).body as { stockItemId: string; code: string; holdingJobId: string | null; qty: number; pendingReturn: number; mustReturn: boolean }[];
  const holding = async (code: string, job: string | null, who = 'tech') => (await inv(who)).find(h => h.code === code && h.holdingJobId === job);
  const roomQty = async () => Number((await db.query('SELECT qty FROM stockroom_stock WHERE stock_item_id = $1', [ids.seal])).rows[0].qty);
  const room0 = await roomQty();
  const vanBefore = (await holding('VALVE-01', null))?.qty ?? 0;

  // Booking out: straight onto his name, against this job. Can't book what the stockroom hasn't got.
  assert.equal((await call('tech2', 'POST', `/jobs/${jobId}/stock-out`, { at: '2026-10-16T08:00:00+02:00', lines: [{ stockItemId: ids.seal, qty: 1 }] })).status, 403);
  const tooMany = await call('tech', 'POST', `/jobs/${jobId}/stock-out`, { at: '2026-10-16T08:00:00+02:00', lines: [{ stockItemId: ids.seal, qty: 500 }] });
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.body.reasons[0], /only \d+ in the stockroom/);
  const asked = await call('tech', 'POST', `/jobs/${jobId}/stock-out`, { at: '2026-10-16T08:00:00+02:00', lines: [{ stockItemId: ids.seal, qty: 4 }] });
  assert.equal(asked.status, 201);
  assert.equal(asked.body.status, 'pending');
  assert.equal(await holding('VALVE-01', jobId), undefined, 'nothing moves until the stock controller issues it');
  assert.equal(await roomQty(), room0);
  assert.equal((await call('tech', 'GET', `/jobs/${jobId}/stock`)).body[0].requested, 4);
  assert.ok((await call('stock', 'GET', '/me/notifications')).body.some((n: { kind: string }) => n.kind === 'stock_request'));

  // The stock controller picks it, ticks every line, and may issue less than asked.
  assert.equal((await call('tech', 'GET', '/stock/issues')).status, 403);
  const req1 = (await call('stock', 'GET', '/stock/issues')).body.find((r: { id: string }) => r.id === asked.body.id);
  const line1 = req1.lines[0].lineId;
  assert.equal((await call('stock', 'POST', `/stock/issues/${asked.body.id}/issue`, { at: '2026-10-16T08:10:00+02:00', lines: [] })).status, 400);
  assert.equal((await call('stock', 'POST', `/stock/issues/${asked.body.id}/issue`, { at: '2026-10-16T08:10:00+02:00', lines: [{ lineId: line1, qtyIssued: 5 }] })).status, 409, 'not more than asked');
  const pic = await upload('stock', '/photos', { kind: 'stock_item', takenAt: '2026-10-16T08:10:00+02:00' });
  const issued = await call('stock', 'POST', `/stock/issues/${asked.body.id}/issue`, { at: '2026-10-16T08:10:00+02:00', lines: [{ lineId: line1, qtyIssued: 3, photoId: pic.body.id }] });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.deepEqual(issued.body.short, ['VALVE-01']);
  assert.equal((await call('stock', 'POST', `/stock/issues/${asked.body.id}/issue`, { at: '2026-10-16T08:11:00+02:00', lines: [{ lineId: line1, qtyIssued: 3 }] })).status, 409, 'only once');
  assert.equal((await holding('VALVE-01', jobId))!.qty, 3);
  assert.equal(await roomQty(), room0 - 3);
  const out = { body: (await call('tech', 'GET', `/jobs/${jobId}/stock`)).body };
  assert.equal(out.body[0].booked, 3);
  assert.equal(out.body[0].requested, 0);

  // A request can be rejected, with a reason; nothing moves.
  const asked2 = await call('tech', 'POST', `/jobs/${jobId}/stock-out`, { at: '2026-10-16T08:20:00+02:00', lines: [{ stockItemId: ids.seal, qty: 1 }] });
  assert.equal((await call('stock', 'POST', `/stock/issues/${asked2.body.id}/reject`, { at: '2026-10-16T08:21:00+02:00', reason: '' })).status, 400);
  assert.equal((await call('stock', 'POST', `/stock/issues/${asked2.body.id}/reject`, { at: '2026-10-16T08:21:00+02:00', reason: 'Use the one in your van first' })).status, 200);
  assert.equal(await roomQty(), room0 - 3);
  assert.equal((await call('tech', 'GET', '/me/stock-requests')).body.find((r: { id: string }) => r.id === asked2.body.id).status, 'rejected');

  // Supplier invoice: photo in, read automatically, technician checks and confirms.
  fakeReader = async () => ({
    supplierName: 'Voltex Richards Bay', invoiceNumber: 'INV-88812', invoiceDate: '2026-10-16', totalCents: 63250, vatCents: 8250,
    lines: [
      { description: 'Water inlet valve', supplierCode: 'WV-24', qty: 2, unitPriceCents: 25000 },
      { description: 'Cable ties 300mm (100)', supplierCode: 'CT300', qty: 1, unitPriceCents: 5000 },
    ],
  });
  const photo = await upload('tech', '/photos', { kind: 'supplier_slip', takenAt: '2026-10-16T09:00:00+02:00' });
  const scanned = await call('tech', 'POST', '/supplier-invoices', { photoId: photo.body.id, jobId, at: '2026-10-16T09:00:00+02:00' });
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.status, 'reading');
  await readPendingInvoices(appDb, fakeReader);
  const mine = (await call('tech', 'GET', '/me/supplier-invoices')).body;
  const read = mine.find((x: { id: string }) => x.id === scanned.body.id);
  assert.equal(read.status, 'to_confirm');
  assert.equal(read.read_result.lines.length, 2);
  const confirmBody = { supplierName: read.read_result.supplierName, invoiceNumber: read.read_result.invoiceNumber, invoiceDate: '2026-10-16', totalCents: 63250, at: '2026-10-16T09:05:00+02:00', lines: read.read_result.lines };
  const confirmed = await call('tech', 'POST', `/supplier-invoices/${scanned.body.id}/confirm`, confirmBody);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.changedFromRead, false);
  assert.equal(confirmed.body.newItems.length, 1, 'cable ties are new: they get a stock item at once');
  assert.match(confirmed.body.newItems[0], /^NEW-1001 /);
  assert.equal((await holding('VALVE-01', jobId))!.qty, 5, 'matched to our valve by description, held for the job');
  assert.equal((await holding('NEW-1001', jobId))!.qty, 1);
  assert.ok((await call('stock', 'GET', '/me/notifications')).body.some((n: { kind: string }) => n.kind === 'new_stock_items'));
  assert.equal((await call('tech', 'POST', `/supplier-invoices/${scanned.body.id}/confirm`, confirmBody)).status, 409);

  // Someone else trying to book the same invoice: refused and flagged.
  const photo2 = await upload('tech2', '/photos', { kind: 'supplier_slip', takenAt: '2026-10-16T10:00:00+02:00' });
  const again = await call('tech2', 'POST', '/supplier-invoices', { photoId: photo2.body.id, at: '2026-10-16T10:00:00+02:00' });
  await readPendingInvoices(appDb, fakeReader);
  const dup = await call('tech2', 'POST', `/supplier-invoices/${again.body.id}/confirm`, { ...confirmBody, at: '2026-10-16T10:01:00+02:00' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.reasons[0], /already booked by tech/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM flags WHERE flag_type = 'duplicate_supplier_invoice' AND technician_id = $1", [ids.tech2])).rows[0].n, 1);

  // An unreadable photo: he types the lines; a changed reading is recorded.
  fakeReader = async () => { throw new Error('not a readable invoice'); };
  const photo3 = await upload('tech', '/photos', { kind: 'supplier_slip', takenAt: '2026-10-16T11:00:00+02:00' });
  const blurry = await call('tech', 'POST', '/supplier-invoices', { photoId: photo3.body.id, at: '2026-10-16T11:00:00+02:00' });
  await readPendingInvoices(appDb, fakeReader);
  assert.equal((await call('tech', 'GET', '/me/supplier-invoices')).body.find((x: { id: string }) => x.id === blurry.body.id).status, 'unreadable');
  assert.equal((await call('tech', 'POST', `/supplier-invoices/${blurry.body.id}/confirm`, {
    supplierName: 'Voltex Richards Bay', invoiceNumber: 'INV-88990', at: '2026-10-16T11:05:00+02:00',
    lines: [{ description: 'Fuse 10A', qty: 4, unitPriceCents: 800 }],
  })).status, 200);
  assert.equal((await holding('NEW-1002', null))!.qty, 4, 'no job given: van stock');

  // Using it on the job takes what was booked for this job first; van stock is untouched.
  assert.equal((await call('tech', 'POST', `/jobs/${jobId}/items/${itemId}/materials`, { stockItemId: ids.seal, qty: 4 })).status, 200);
  assert.equal((await holding('VALVE-01', jobId))!.qty, 1);
  assert.equal((await holding('VALVE-01', null))?.qty ?? 0, vanBefore);
  const js = (await call('tech', 'GET', `/jobs/${jobId}/stock`)).body.find((l: { code: string }) => l.code === 'VALVE-01');
  assert.deepEqual([js.booked, js.used, js.onTechnician], [5, 4, 1]);

  // Job closed: what is left must go back. It stays on his name until the stock controller confirms.
  await db.query("UPDATE jobs SET status = 'closed', closed_at = now(), manager_unavailable_reason = 'Closed for the test', manager_unavailable_spoke_to = 'Test' WHERE id = $1", [jobId]);
  assert.equal((await holding('VALVE-01', jobId))!.mustReturn, true);
  const cableId = (await holding('NEW-1001', jobId))!.stockItemId;
  assert.equal((await call('tech', 'POST', '/me/returns', { at: '2026-10-17T07:30:00+02:00', lines: [{ stockItemId: ids.seal, holdingJobId: jobId, qty: 2 }] })).status, 409);
  const ret = await call('tech', 'POST', '/me/returns', { at: '2026-10-17T07:30:00+02:00', lines: [
    { stockItemId: ids.seal, holdingJobId: jobId, qty: 1 }, { stockItemId: cableId, holdingJobId: jobId, qty: 1 }] });
  assert.equal(ret.status, 201);
  assert.equal((await holding('VALVE-01', jobId))!.qty, 1, 'still his until received');
  assert.equal((await holding('VALVE-01', jobId))!.pendingReturn, 1);
  assert.equal((await call('tech', 'POST', '/me/returns', { at: '2026-10-17T07:31:00+02:00', lines: [{ stockItemId: ids.seal, holdingJobId: jobId, qty: 1 }] })).status, 409, 'cannot return it twice');

  assert.equal((await call('tech', 'GET', '/stock/returns')).status, 403);
  const pending = (await call('stock', 'GET', '/stock/returns')).body.find((r: { id: string }) => r.id === ret.body.id);
  const lineOf = (code: string) => pending.lines.find((l: { code: string }) => l.code === code).lineId;
  assert.equal((await call('stock', 'POST', `/stock/returns/${ret.body.id}/receive`, { lines: [{ lineId: lineOf('VALVE-01'), qtyReceived: 1 }] })).status, 400, 'every line must be counted');
  const got = await call('stock', 'POST', `/stock/returns/${ret.body.id}/receive`, { lines: [{ lineId: lineOf('VALVE-01'), qtyReceived: 1 }, { lineId: lineOf('NEW-1001'), qtyReceived: 0 }] });
  assert.equal(got.status, 200);
  assert.equal(got.body.short.length, 1);
  assert.equal(await holding('VALVE-01', jobId), undefined, 'received: off his name');
  assert.equal(await roomQty(), room0 - 3 + 1);
  assert.equal((await holding('NEW-1001', jobId))!.qty, 1, 'not received: still his');
  const shortFlag = (await db.query("SELECT technician_id, question FROM flags WHERE flag_type = 'stock_return_short'")).rows[0];
  assert.equal(shortFlag.technician_id, ids.tech);
  assert.match(shortFlag.question, /stays on your name/);
  assert.equal((await call('stock', 'POST', `/stock/returns/${ret.body.id}/receive`, { lines: [] })).status, 400);

  // Deliveries into the stockroom, and naming the new items from invoices.
  const delivered = await call('stock', 'POST', '/stock/deliveries', { at: '2026-10-17T09:00:00+02:00', supplierName: 'Voltex Richards Bay', reference: 'DN-5512', lines: [{ stockItemId: ids.seal, qty: 10 }] });
  assert.equal(delivered.status, 201);
  assert.equal(await roomQty(), room0 - 3 + 1 + 10);
  assert.equal((await call('stock', 'POST', '/stock/deliveries', { at: '2026-10-17T09:05:00+02:00', supplierName: 'voltex richards bay', reference: 'dn-5512', lines: [{ stockItemId: ids.seal, qty: 10 }] })).status, 409, 'same delivery twice');
  assert.equal((await call('tech', 'POST', '/stock/deliveries', { at: '2026-10-17T09:00:00+02:00', supplierName: 'X', reference: 'Y', lines: [{ stockItemId: ids.seal, qty: 1 }] })).status, 403);
  const room = (await call('stock', 'GET', '/stock/stockroom')).body;
  const newOne = room.find((i: { code: string }) => i.code === 'NEW-1001');
  assert.equal(newOne.needsReview, true);
  assert.equal(newOne.withTechnicians, 1);
  assert.equal((await call('stock', 'PATCH', `/stock/items/${newOne.id}`, { code: 'VALVE-01', description: 'Cable ties', unit: 'each' })).status, 409, 'code already used');
  const named = await call('stock', 'PATCH', `/stock/items/${newOne.id}`, { code: 'TIE-300', description: 'Cable ties 300mm (100)', unit: 'pack' });
  assert.equal(named.body.needsReview, false);
  assert.equal((await holding('TIE-300', jobId))!.qty, 1, 'still on his name under the new code');
  assert.equal((await call('stock', 'GET', '/stock/overview')).body.newItems, 1, 'NEW-1002 still to name');

  // The issued register: what was issued to whom, by whom.
  const register = (await call('stock', 'GET', '/stock/issues?status=issued')).body;
  const first = register.find((r: { id: string }) => r.id === asked.body.id);
  assert.equal(first.technician, 'tech');
  assert.equal(first.decided_by, 'stock');
  assert.equal(first.lines[0].qtyIssued, 3);
  assert.equal((await call('stock', 'GET', `/stock/issues?status=issued&technicianId=${ids.tech2}`)).body.length, 0);

  // The stock controller sees everything that is out, and every movement as it happens.
  assert.equal((await call('tech', 'GET', '/stock/holdings')).status, 403);
  const out2 = (await call('stock', 'GET', '/stock/holdings')).body;
  const tie = out2.find((h: { code: string }) => h.code === 'TIE-300');
  assert.equal(tie.technician, 'tech');
  assert.equal(tie.mustReturn, true);
  const feed = (await call('stock', 'GET', '/stock/activity?limit=50')).body;
  assert.ok(feed.some((a: { kind: string; jobNumber: number; technician: string }) => a.kind === 'use_on_job' && a.technician === 'tech' && a.jobNumber === created.body.job_number), 'use on the job card shows live');
  assert.ok(feed.some((a: { kind: string; reference: string }) => a.kind === 'receive' && a.reference === 'Voltex Richards Bay DN-5512'));
  const newest = feed[0].at;
  assert.equal((await call('stock', 'GET', `/stock/activity?since=${encodeURIComponent(newest)}`)).body.length, 0);

  // The movement record can't be quietly changed.
  await assert.rejects(db.query('UPDATE stock_movements SET qty = 1 WHERE stock_item_id = $1', [ids.seal]), /cannot be edited/);
  await assert.rejects(db.query('DELETE FROM stock_movements WHERE stock_item_id = $1', [ids.seal]), /cannot be edited/);
});

test('fleet: the mechanic sees every vehicle, faults from handovers, job cards linked to the vehicle; off-road vehicles cannot be driven', async () => {
  assert.equal((await call('tech', 'GET', '/fleet')).status, 403, 'technicians do not run the fleet');
  assert.equal((await call('mech', 'GET', '/jobs')).status, 200);
  assert.equal((await call('mech', 'GET', '/jobs')).body.length, 0, 'the mechanic sees no store jobs');
  const fleet = (await call('mech', 'GET', '/fleet')).body;
  const v1 = fleet.find((v: { registration: string }) => v.registration === 'ND 412-778');
  assert.equal(v1.km, 88200, 'km from the handovers');
  assert.ok(v1.open_faults >= 1, 'the bodywork problem found at handover is a fault');
  assert.equal((await call('manager', 'GET', '/fleet')).status, 200, 'management can look');
  assert.equal((await call('manager', 'POST', `/fleet/vehicles/${ids.v1}/jobs`, { jobType: 'service', reason: 'Service', odometerIn: 88300, at: '2026-10-16T08:00:00+02:00' })).status, 403);

  // A technician reports a safety fault on another vehicle: the mechanic hears at once.
  const rep = await call('tech2', 'POST', `/fleet/vehicles/${ids.v2}/faults`, { description: 'Brakes pulling hard to the left', severity: 'safety', at: '2026-10-16T07:00:00+02:00' });
  assert.equal(rep.status, 201);
  assert.ok((await call('mech', 'GET', '/me/notifications')).body.some((n: { message: string }) => /SAFETY: ND 503-221/.test(n.message)));
  assert.equal((await call('mech', 'GET', '/fleet/faults')).body[0].severity, 'safety', 'worst first');
  assert.equal((await call('mech', 'POST', `/fleet/faults/${rep.body.id}/defer`, { note: 'Next week', at: '2026-10-16T07:10:00+02:00' })).status, 409, 'a safety fault cannot be deferred');

  // Vehicle details.
  assert.equal((await call('mech', 'PATCH', `/fleet/vehicles/${ids.v1}`, { make: 'Toyota', model: 'Hilux 2.4', licenceExpiry: '2026-11-01' })).status, 200);

  // A mechanic job card on the vehicle: takes it off the road while it is open.
  const detail0 = (await call('mech', 'GET', `/fleet/vehicles/${ids.v1}`)).body;
  const bodywork = detail0.faults.find((f: { source: string; status: string }) => f.source === 'handover' && f.status === 'open');
  assert.equal((await call('mech', 'POST', `/fleet/vehicles/${ids.v1}/jobs`, { jobType: 'service', reason: '15 000 km service and door dent', odometerIn: 88000, at: '2026-10-16T08:00:00+02:00' })).status, 409, 'odometer cannot go backwards');
  const job = await call('mech', 'POST', `/fleet/vehicles/${ids.v1}/jobs`, { jobType: 'service', reason: '15 000 km service and door dent', odometerIn: 88250, faultIds: [bodywork.id], vehicleStatus: 'workshop', at: '2026-10-16T08:00:00+02:00' });
  assert.equal(job.status, 201, JSON.stringify(job.body));
  assert.equal(job.body.number, 3001);
  assert.equal((await call('mech', 'POST', `/fleet/vehicles/${ids.v1}/jobs`, { jobType: 'repair', reason: 'Second card', odometerIn: 88250, at: '2026-10-16T08:01:00+02:00' })).status, 409, 'one open card per vehicle');
  const drive = await call('tech', 'POST', '/vehicles/scan', { barcode: 'RS-V1', mode: 'driving', at: '2026-10-16T08:30:00+02:00' });
  assert.equal(drive.status, 409);
  assert.match(drive.body.reasons[0], /in the workshop/);

  const J = `/fleet/jobs/${job.body.id}`;
  const early = await call('mech', 'POST', `${J}/complete`, { at: '2026-10-16T12:00:00+02:00', odometerOut: 88260, vehicleStatusAfter: 'in_service' });
  assert.equal(early.status, 409);
  for (const r of ['what did you find', 'labour hours', 'after photo', 'fixed or deferred', 'next service']) assert.ok(early.body.reasons.some((x: string) => x.includes(r)), r);

  const after = await upload('mech', '/photos', { kind: 'fleet_after', takenAt: '2026-10-16T11:50:00+02:00' });
  assert.equal((await call('mech', 'PATCH', J, { found: 'Oil dirty and due, rear left door dented inwards', did: 'Changed oil and filters, panel beat and resprayed the door', labourHours: 3.5, addAfterPhotoIds: [after.body.id] })).status, 200);
  assert.equal((await call('mech', 'POST', `${J}/parts`, { description: 'Oil filter', qty: 1, unitCostCents: 18500, source: 'bought' })).status, 400, 'bought needs a slip');
  const slip = await upload('mech', '/photos', { kind: 'fleet_slip', takenAt: '2026-10-16T09:00:00+02:00' });
  assert.equal((await call('mech', 'POST', `${J}/parts`, { description: 'Oil filter', qty: 1, unitCostCents: 18500, source: 'bought', slipPhotoId: slip.body.id })).status, 201);
  const done = await call('mech', 'POST', `${J}/complete`, {
    at: '2026-10-16T12:00:00+02:00', odometerOut: 88260, faults: [{ id: bodywork.id, outcome: 'fixed' }],
    nextServiceKm: 103260, nextServiceAt: '2027-10-16', vehicleStatusAfter: 'in_service',
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  const detail = (await call('mech', 'GET', `/fleet/vehicles/${ids.v1}`)).body;
  assert.equal(detail.vehicle.status, 'in_service');
  assert.equal(detail.vehicle.next_service_km, 103260);
  assert.equal(detail.faults.find((f: { id: string }) => f.id === bodywork.id).status, 'fixed');
  assert.equal(detail.jobs[0].parts_cents, 18500);
  assert.deepEqual([...new Set(detail.km.map((k: { source: string }) => k.source))].sort(), ['fleet_job', 'handover']);
  assert.equal(detail.licenceDue.state, 'soon');
  assert.equal((await call('mech', 'PATCH', J, { found: 'changed later on' })).status, 409, 'completed cards are locked');
  await assert.rejects(db.query('UPDATE fleet_jobs SET labour_hours = 1 WHERE id = $1', [job.body.id]), /completed and locked/);
  assert.equal((await call('tech', 'POST', '/vehicles/scan', { barcode: 'RS-V1', mode: 'driving', at: '2026-10-16T12:30:00+02:00' })).status, 200, 'back on the road');
});

test('a technician releases the vehicle from his name, with the km and where he left it', async () => {
  // tech is driving ND 412-778 (end of the fleet test).
  const no = await call('tech', 'POST', '/vehicles/release', { at: '2026-10-16T17:00:00+02:00' });
  assert.equal(no.status, 409);
  assert.deepEqual(no.body.reasons, ['odometer reading (km)', 'where you left the vehicle']);
  assert.match((await call('tech', 'POST', '/vehicles/release', { at: '2026-10-16T17:00:00+02:00', km: 88300, place: 'home' })).body.reasons[0], /not approved to take a vehicle home/);
  assert.match((await call('tech', 'POST', '/vehicles/release', { at: '2026-10-16T17:00:00+02:00', km: 1000, place: 'office_yard' })).body.reasons[0], /cannot be lower/);
  const ok = await call('tech', 'POST', '/vehicles/release', { at: '2026-10-16T17:00:00+02:00', km: 88300, place: 'office_yard' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.released, 'ND 412-778');
  assert.equal((await call('tech', 'GET', '/me/today?date=2026-10-16')).body.vehicle, null);
  assert.equal((await call('tech', 'POST', '/vehicles/release', { at: '2026-10-16T17:01:00+02:00' })).status, 409, 'nothing left on his name');
  assert.equal((await db.query("SELECT km FROM odometer_readings WHERE source = 'release'")).rows[0].km, 88300);
  const out = await db.query('SELECT driver_id FROM tracker_driver_outbox WHERE vehicle_id = $1 ORDER BY created_at DESC LIMIT 1', [ids.v1]);
  assert.equal(out.rows[0].driver_id, null, 'the tracker is told nobody is driving it');
  assert.equal((await call('tech2', 'GET', '/vehicles/lookup?barcode=RS-V1')).body.needsInspection, true, 'the next driver still inspects it');
});

test('the CEO assigns each person a position; it takes effect at once and is logged', async () => {
  assert.equal((await call('manager', 'PUT', `/access/users/${ids.tech2}/position`, { position: 'mechanic' })).status, 403, 'only whoever manages access');
  const list = (await call('director', 'GET', '/access/positions')).body;
  assert.ok(list.positions.some((p: { label: string }) => p.label === 'Mechanic (fleet)'));
  const r = await call('director', 'PUT', `/access/users/${ids.tech2}/position`, { position: 'mechanic' });
  assert.equal(r.status, 200);
  assert.equal(r.body.label, 'Mechanic (fleet)');
  assert.equal((await call('tech2', 'GET', '/fleet')).status, 200, 'mechanic access straight away, same login');
  assert.equal((await call('tech2', 'GET', '/me')).body.login_level, 'mechanic');
  assert.equal((await call('director', 'PUT', `/access/users/${ids.tech2}/position`, { position: 'creator' })).status, 403, 'only the Creator makes a Creator');
  const log = (await call('director', 'GET', '/access/changes')).body;
  assert.ok(log.some((c: { action: string; change: string }) => c.action === 'position' && c.change === 'Technician → Mechanic (fleet)'));
  assert.equal((await call('director', 'PUT', `/access/users/${ids.tech2}/position`, { position: 'technician' })).status, 200);
  assert.equal((await call('director', 'PUT', `/access/users/${ids.director}/position`, { position: 'technician' })).status, 200, 'the Creator can still manage access');
  assert.equal((await call('creator', 'PUT', `/access/users/${ids.director}/position`, { position: 'director' })).status, 200);
});

test('fuel: slip required, logged against the vehicle, impossible litres flagged', async () => {
  // He released ND 412-778 in the test before; he drove it last, so he scans back in without an inspection.
  assert.equal((await call('tech', 'POST', '/vehicles/scan', { barcode: 'RS-V1', mode: 'driving', at: '2026-10-16T17:30:00+02:00' })).status, 200);
  // He released ND 412-778 in the test before; he drove it last, so he scans back in without an inspection.
  assert.equal((await call('tech', 'POST', '/vehicles/scan', { barcode: 'RS-V1', mode: 'driving', at: '2026-10-16T17:30:00+02:00' })).status, 200);
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
  assert.equal(stock.body.find((l: { code: string }) => l.code === 'VALVE-01').qty, 4);
  const flags = await db.query("SELECT 1 FROM flags WHERE flag_type = 'new_supplier' AND details->>'supplyRunId' = $1", [run.body.id]);
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
  const log = { body: (await call('director', 'GET', '/access/changes')).body.filter((c: { action: string }) => c.action !== 'position') };
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
