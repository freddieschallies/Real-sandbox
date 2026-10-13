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
import { purgeOldPhotos } from '../src/retention.ts';
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
// Emails the server would send.
let mailBox: { to: string[]; subject: string; html: string; pictures: { cid: string }[] }[] = [];
let fakeReader: InvoiceReader = async () => { throw new Error('no invoice expected'); };
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};

const NOW = '2026-10-12T07:00:00+02:00';
const at = (h: number, m = 0) => `2026-10-12T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+02:00`;
const STORE = { lat: -28.7807, lng: 32.0383 };
const SAFE = { areaSafe: true, isolated: true, publicClear: true };

async function call(who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: object, extra: Record<string, string> = {}) {
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
  await user('hr', 'hr');
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

  app = await buildApp(appDb, { jwtSecret: 'x'.repeat(40), invoiceReader: (img, mime) => fakeReader(img, mime), mailer: async m => { mailBox.push(m as never); } });
});

after(async () => {
  await app?.close();
  await db?.end();
  await appDb?.end();
  await owner?.end();
});

test('login: wrong password refused, right password gives a token', async () => {
  assert.equal((await call('', 'POST', '/auth/login', { email: 'tech@zsp.test', password: 'nope' })).status, 401);
  for (const who of ['creator', 'director', 'admin', 'manager', 'tech', 'tech2', 'stock', 'mech', 'hr']) {
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
  for (const who of ['creator', 'director', 'admin', 'manager', 'tech', 'tech2', 'stock', 'mech', 'hr']) {
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

test('photo size: pictures that did not go through the app\'s compressor are refused; the CEO sees the storage used', async () => {
  // A PNG header that says 6000 × 4000.
  const big = Buffer.alloc(40); big.writeUInt32BE(0x89504e47, 0); big.writeUInt32BE(0x0d0a1a0a, 4); big.writeUInt32BE(6000, 16); big.writeUInt32BE(4000, 20);
  const boundary = '----rsbig';
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nstock_item\r\n--${boundary}\r\nContent-Disposition: form-data; name="takenAt"\r\n\r\n2026-10-12T08:00:00+02:00\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`), big, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await app.inject({ method: 'POST', url: '/photos', payload, headers: { authorization: `Bearer ${tokens.tech}`, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(r.statusCode, 400); assert.match(r.json().reasons[0], /6000 × 4000/);
  const ok = await upload('tech', '/photos', { kind: 'stock_item', takenAt: '2026-10-12T08:00:00+02:00' });
  assert.equal(ok.status, 201, 'a small one is fine');
  const st = await call('director', 'GET', '/company/storage');
  assert.equal(st.status, 200); assert.ok(st.body.photos >= 1 && st.body.bytes > 0 && Array.isArray(st.body.kinds));
  assert.equal((await call('admin', 'GET', '/company/storage')).status, 403);
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

test('the mechanic books vehicles in, sees where they are, and puts a technician in a vehicle when his phone is off', async () => {
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  // Booking a vehicle in for a service.
  assert.equal((await call('tech', 'POST', `/fleet/vehicles/${ids.v1}/bookings`, { jobType: 'service', bookedFor: day(3), reason: 'Due for a service', at: '2026-10-16T09:00:00+02:00' })).status, 403);
  assert.equal((await call('mech', 'POST', `/fleet/vehicles/${ids.v1}/bookings`, { jobType: 'service', bookedFor: day(-1), reason: 'Due for a service', at: '2026-10-16T09:00:00+02:00' })).status, 409, 'not in the past');
  const bk = await call('mech', 'POST', `/fleet/vehicles/${ids.v1}/bookings`, { jobType: 'service', bookedFor: day(3), timeSlot: 'afternoon', reason: 'Due for a service', at: '2026-10-16T09:00:00+02:00' });
  assert.equal(bk.status, 201, JSON.stringify(bk.body));
  assert.match((await call('mech', 'POST', `/fleet/vehicles/${ids.v1}/bookings`, { jobType: 'repair', bookedFor: day(4), reason: 'Another one', at: '2026-10-16T09:00:00+02:00' })).body.reasons[0], /already booked/);
  assert.equal((await call('mech', 'POST', `/fleet/bookings/${bk.body.id}/move`, { bookedFor: day(5) })).status, 400, 'say why it moves');
  assert.equal((await call('mech', 'POST', `/fleet/bookings/${bk.body.id}/move`, { bookedFor: day(5), note: 'Parts arrive later' })).status, 200);
  const list = (await call('manager', 'GET', '/fleet/bookings')).body;
  assert.equal(list[0].booked_for, day(5));
  assert.equal(list[0].time_slot, 'afternoon');

  // Where every vehicle is.
  await db.query('INSERT INTO tracker_positions (vehicle_id, recorded_at, lat, lng, speed_kmh, ignition) VALUES ($1, now() - interval \'10 minutes\', -28.75, 32.05, 0, false), ($1, now() - interval \'2 minutes\', -28.78, 32.04, 45, true)', [ids.v1]);
  const pos = (await call('mech', 'GET', '/fleet/positions')).body;
  const p1 = pos.find((v: { id: string }) => v.id === ids.v1);
  assert.equal(p1.lat, -28.78, 'latest position only');
  assert.equal(p1.minutesAgo, 2);
  assert.ok(pos.some((v: { lat: number | null }) => v.lat === null), 'vehicles without a tracker fix still listed');

  // Tech's phone is broken: the mechanic puts him in the vehicle.
  const techs = (await call('mech', 'GET', '/fleet/technicians')).body;
  assert.ok(techs.some((t: { id: string; vehicle_id: string | null }) => t.id === ids.tech && t.vehicle_id === null));
  assert.equal((await call('mech', 'POST', `/fleet/vehicles/${ids.v1}/assign`, { technicianId: ids.tech, mode: 'driving', reason: 'x', at: '2026-10-16T09:10:00+02:00' })).status, 400, 'a real reason');
  assert.match((await call('mech', 'POST', `/fleet/vehicles/${ids.v1}/assign`, { technicianId: ids.tech, mode: 'driving', reason: 'His phone screen is broken', at: '2026-10-16T09:10:00+02:00' })).body.reasons[0], /odometer/);
  const as = await call('mech', 'POST', `/fleet/vehicles/${ids.v1}/assign`, { technicianId: ids.tech, mode: 'driving', reason: 'His phone screen is broken', km: 88400, at: '2026-10-16T09:10:00+02:00' });
  assert.equal(as.status, 200, JSON.stringify(as.body));
  const today = (await call('tech', 'GET', '/me/today?date=2026-10-16')).body.vehicle;
  assert.equal(today.registration, 'ND 412-778');
  assert.equal(today.assigned_by_mechanic, true);
  assert.equal(today.booking.bookedFor, day(5), 'the driver sees the booking');
  assert.ok((await call('tech', 'GET', '/me/notifications')).body.some((n: { message: string }) => /mechanic put you in ND 412-778/.test(n.message)));
  const out = await db.query('SELECT driver_id FROM tracker_driver_outbox WHERE vehicle_id = $1 ORDER BY created_at DESC LIMIT 1', [ids.v1]);
  assert.equal(out.rows[0].driver_id, ids.tech, 'the tracker is told who drives');
  assert.equal((await db.query('SELECT assign_reason FROM vehicle_scans WHERE id = $1', [as.body.scanId])).rows[0].assign_reason, 'His phone screen is broken');

  // And takes it off his name again.
  assert.equal((await call('mech', 'POST', `/fleet/technicians/${ids.tech}/release`, { reason: 'Back at the yard', at: '2026-10-16T16:00:00+02:00' })).status, 409, 'km needed');
  assert.equal((await call('mech', 'POST', `/fleet/technicians/${ids.tech}/release`, { reason: 'Back at the yard', km: 88450, at: '2026-10-16T16:00:00+02:00' })).status, 200);
  assert.equal((await call('tech', 'GET', '/me/today?date=2026-10-16')).body.vehicle, null);

  // A booking turns into a job card.
  const job = await call('mech', 'POST', `/fleet/vehicles/${ids.v1}/jobs`, { jobType: 'service', reason: 'Booked service', odometerIn: 88450, bookingId: bk.body.id, at: '2026-10-16T16:10:00+02:00' });
  assert.equal(job.status, 201, JSON.stringify(job.body));
  assert.equal((await call('mech', 'GET', '/fleet/bookings')).body.find((b: { id: string }) => b.id === bk.body.id).status, 'started');
  assert.equal((await call('mech', 'POST', `/fleet/bookings/${bk.body.id}/cancel`, { note: 'Not needed now' })).status, 409, 'already started');
  await db.query("UPDATE fleet_jobs SET status = 'completed', completed_at = now(), found = 'x', did = 'x', labour_hours = 1, odometer_out = 88450 WHERE id = $1", [job.body.id]).catch(() => undefined);
  await db.query("UPDATE vehicles SET status = 'in_service' WHERE id = $1", [ids.v1]);
});

test('daily checks: oil, water and tyres every day; oil added is always noted, and an engine using oil is flagged', async () => {
  const last = Number((await db.query('SELECT max(km) AS km FROM odometer_readings WHERE vehicle_id = $1', [ids.v2])).rows[0].km ?? 0);
  const C = `/fleet/vehicles/${ids.v2}/daily-check`;
  const at = '2026-10-17T07:00:00+02:00';
  assert.equal((await call('tech', 'POST', C, { odometerKm: last + 10, oil: 'ok', water: 'ok', tyres: 'ok', at })).status, 403, 'the mechanic does them');
  const list0 = (await call('mech', 'GET', '/fleet/daily-checks')).body;
  assert.ok(list0.due >= 1);
  assert.equal(list0.vehicles.find((v: { vehicle_id: string }) => v.vehicle_id === ids.v2).id, null);

  const noLitres = await call('mech', 'POST', C, { odometerKm: last + 10, oil: 'topped_up', water: 'ok', tyres: 'ok', at });
  assert.equal(noLitres.status, 409);
  assert.deepEqual(noLitres.body.reasons, ['how much oil was added (litres)']);
  assert.match((await call('mech', 'POST', C, { odometerKm: last + 10, oil: 'ok', water: 'ok', tyres: 'problem', at })).body.reasons[0], /what the problem is/);
  assert.match((await call('mech', 'POST', C, { odometerKm: 1, oil: 'ok', water: 'ok', tyres: 'ok', at })).body.reasons[0], /cannot be lower/);

  // Two top-ups earlier this week are on record; today's is the third.
  const company = (await db.query('SELECT company_id FROM vehicles WHERE id = $1', [ids.v2])).rows[0].company_id;
  for (const ago of [2, 4]) {
    await db.query(
      `INSERT INTO daily_checks (company_id, vehicle_id, check_date, checked_at, checked_by, odometer_km, oil, oil_litres, water, tyres)
       VALUES ($1, $2, current_date - $3::int, now() - ($3::int * interval '1 day'), $4, $5, 'topped_up', 0.5, 'ok', 'ok')`, [company, ids.v2, ago, ids.mech, last]);
  }
  const ok = await call('mech', 'POST', C, { odometerKm: last + 10, oil: 'topped_up', oilLitres: 0.5, water: 'ok', tyres: 'problem', notes: 'Front right tyre worn on the inside edge', at });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.match(ok.body.oilWarning, /Using oil: topped up 3 times \(1.5 L\)/);
  assert.equal(ok.body.faults.length, 1, 'the tyre problem became a fault');
  const faults = (await call('mech', 'GET', '/fleet/faults')).body.filter((f: { vehicle_id: string }) => f.vehicle_id === ids.v2);
  assert.ok(faults.some((f: { description: string; severity: string }) => /^Daily check, tyres/.test(f.description) && f.severity === 'safety'));
  assert.ok(faults.some((f: { description: string }) => /^Using oil/.test(f.description)));
  assert.equal((await call('mech', 'POST', C, { odometerKm: last + 20, oil: 'ok', water: 'ok', tyres: 'ok', at })).body.reasons[0], 'ND 503-221 was already checked today');
  const fleet = (await call('mech', 'GET', '/fleet')).body.find((v: { id: string }) => v.id === ids.v2);
  assert.equal(fleet.checked_today.oilLitres, 0.5);
  const det = (await call('mech', 'GET', `/fleet/vehicles/${ids.v2}`)).body;
  assert.equal(det.dailyChecks.length, 3);
  assert.equal(det.dailyChecks[0].oil_litres, 0.5);
  assert.ok(det.km.some((k: { source: string }) => k.source === 'daily_check'), 'the km is logged too');
  await assert.rejects(db.query('UPDATE daily_checks SET oil = $2 WHERE id = $1', [ok.body.id, 'ok']), /locked/);
});

test('workshop stock: set by the stock controller, used on job cards and daily checks, small pouring losses allowed but recorded', async () => {
  const company = (await db.query('SELECT company_id FROM vehicles WHERE id = $1', [ids.v1])).rows[0].company_id;
  const oil = (await db.query("INSERT INTO stock_items (company_id, code, description, unit, measured) VALUES ($1, 'OIL-1540', 'Engine oil 15W-40', 'L', true) RETURNING id", [company])).rows[0].id;
  const filter = (await db.query("INSERT INTO stock_items (company_id, code, description) VALUES ($1, 'OF-HILUX', 'Oil filter Hilux') RETURNING id", [company])).rows[0].id;
  for (const [it, qty] of [[oil, 60], [filter, 4]]) {
    await db.query("INSERT INTO stock_movements (stock_item_id, qty, kind, to_stockroom, created_by) VALUES ($1, $2, 'receive', true, $3)", [it, qty, ids.stock]);
  }
  const at = '2026-10-17T08:00:00+02:00';
  // The stock controller decides what the workshop keeps; the mechanic cannot.
  assert.equal((await call('mech', 'PUT', `/fleet/workshop/items/${oil}`, { minQty: 20, dailyCheckUse: 'oil' })).status, 403);
  assert.equal((await call('stock', 'PUT', `/fleet/workshop/items/${oil}`, { minQty: 20, dailyCheckUse: 'oil' })).status, 200);
  assert.equal((await call('stock', 'PUT', `/fleet/workshop/items/${filter}`, { minQty: 2 })).status, 200);
  let ws = (await call('mech', 'GET', '/fleet/workshop')).body;
  assert.equal(ws.belowMin, 2, 'nothing in the workshop yet');

  assert.match((await call('stock', 'POST', '/fleet/workshop/issue', { lines: [{ itemId: oil, qty: 100 }], at })).body.reasons[0], /only 60 L in the stockroom/);
  assert.equal((await call('mech', 'POST', '/fleet/workshop/issue', { lines: [{ itemId: oil, qty: 25 }], at })).status, 403, 'the mechanic does not issue to himself');
  assert.equal((await call('stock', 'POST', '/fleet/workshop/issue', { lines: [{ itemId: oil, qty: 25 }, { itemId: filter, qty: 2 }], at })).status, 200);
  assert.ok((await call('mech', 'GET', '/me/notifications')).body.some((n: { message: string }) => /Stock issued to the workshop: 25 L Engine oil/.test(n.message)));

  // A daily check top-up comes off the workshop oil.
  const km1 = Number((await db.query('SELECT max(km) AS km FROM odometer_readings WHERE vehicle_id = $1', [ids.v1])).rows[0].km);
  const dc = await call('mech', 'POST', `/fleet/vehicles/${ids.v1}/daily-check`, { odometerKm: km1 + 5, oil: 'topped_up', oilLitres: 1, water: 'ok', tyres: 'ok', at });
  assert.equal(dc.status, 201, JSON.stringify(dc.body));
  // A part from the workshop on a job card.
  const km2 = Number((await db.query('SELECT max(km) AS km FROM odometer_readings WHERE vehicle_id = $1', [ids.v2])).rows[0].km);
  const job = await call('mech', 'POST', `/fleet/vehicles/${ids.v2}/jobs`, { jobType: 'service', reason: 'Oil and filter change', odometerIn: km2, vehicleStatus: 'in_service', at });
  assert.equal(job.status, 201, JSON.stringify(job.body));
  assert.equal((await call('mech', 'POST', `/fleet/jobs/${job.body.id}/parts`, { description: 'Oil filter Hilux', qty: 1, source: 'workshop' })).status, 400, 'which item');
  assert.equal((await call('mech', 'POST', `/fleet/jobs/${job.body.id}/parts`, { description: 'Oil filter Hilux', qty: 1, source: 'workshop', stockItemId: filter })).status, 201);
  assert.match((await call('mech', 'POST', `/fleet/jobs/${job.body.id}/parts`, { description: 'Oil filter Hilux', qty: 5, source: 'workshop', stockItemId: filter })).body.reasons[0], /only 1 each/);
  ws = (await call('mech', 'GET', '/fleet/workshop')).body;
  const line = (id: string) => ws.lines.find((l: { id: string }) => l.id === id);
  assert.equal(line(oil).qty, 24);
  assert.equal(line(filter).qty, 1);
  assert.equal(line(filter).belowMin, true);

  // A spill is noted straight away.
  assert.equal((await call('mech', 'POST', '/fleet/workshop/loss', { itemId: oil, qty: 0.2, reason: 'x', at })).status, 400);
  assert.equal((await call('mech', 'POST', '/fleet/workshop/loss', { itemId: oil, qty: 0.2, reason: 'Spilt while pouring into ND 412-778', at })).status, 201);
  // A dip a little short: within the pouring allowance, recorded as a small loss, no flag.
  const c1 = await call('mech', 'POST', '/fleet/workshop/count', { itemId: oil, counted: 23.7, at: '2026-10-17T16:00:00+02:00' });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  assert.equal(c1.body.result, 'within_allowance');
  assert.equal(c1.body.loss, 0.1);
  assert.equal(c1.body.allowance, 0.25);
  // A big shortfall needs a note and goes to the office.
  const c2 = await call('mech', 'POST', '/fleet/workshop/count', { itemId: oil, counted: 22, at: '2026-10-17T17:00:00+02:00' });
  assert.equal(c2.status, 409);
  assert.deepEqual(c2.body.reasons, ['what happened (a short note)']);
  assert.equal((await call('mech', 'POST', '/fleet/workshop/count', { itemId: oil, counted: 22, note: 'Drum tap was dripping overnight', at: '2026-10-17T17:00:00+02:00' })).body.result, 'short');
  assert.ok((await db.query("SELECT 1 FROM flags WHERE flag_type = 'workshop_stock_short'")).rowCount, 'the office is asked');
  ws = (await call('stock', 'GET', '/fleet/workshop')).body;
  assert.equal(ws.lines.find((l: { id: string }) => l.id === oil).qty, 22);
  const moves = (await call('mech', 'GET', `/fleet/workshop/movements?itemId=${oil}`)).body;
  assert.deepEqual(moves.map((m: { kind: string }) => m.kind), ['workshop_loss', 'workshop_loss', 'workshop_loss', 'use_on_fleet', 'assign']);
  assert.equal(moves[3].registration, 'ND 412-778', 'which vehicle the oil went into');
  assert.equal((await call('stock', 'GET', '/fleet/workshop/movements')).status, 200);
  assert.equal((await call('tech', 'GET', '/fleet/workshop')).status, 403);
});

test('vehicle photos: fault and damage photos kept 2 years, routine inspection photos 90 days, the latest handover always kept', async () => {
  const kinds = async () => (await db.query(
    `SELECT p.id, p.kind::text, p.purged_at IS NOT NULL AS gone FROM photos p`)).rows as { id: string; kind: string; gone: boolean }[];
  const latest = new Set((await db.query(
    `SELECT unnest(photo_ids) AS id FROM (SELECT DISTINCT ON (vehicle_id) photo_ids FROM vehicle_inspections ORDER BY vehicle_id, inspected_at DESC) l`)).rows.map(r => r.id));
  const newDamage = new Set((await db.query('SELECT unnest(photo_ids) AS id FROM vehicle_inspections WHERE cardinality(new_problems) > 0')).rows.map(r => r.id));
  const routineBefore = (await kinds()).filter(p => ['vehicle_front', 'vehicle_back', 'vehicle_left', 'vehicle_right', 'vehicle_dashboard'].includes(p.kind));
  assert.ok(routineBefore.length > 10, 'the handover tests took routine photos');

  assert.equal(await purgeOldPhotos(appDb, new Date('2026-12-01T00:00:00Z')), 0, 'nothing goes inside 90 days');
  const n = await purgeOldPhotos(appDb, new Date('2027-03-01T00:00:00Z'));
  assert.ok(n > 0, 'routine photos older than 90 days are removed');
  let all = await kinds();
  for (const p of all.filter(x => x.gone)) {
    assert.ok(!latest.has(p.id), 'never the latest handover of a vehicle');
    assert.ok(!newDamage.has(p.id), 'never a handover where new damage was found');
    assert.ok(['vehicle_front', 'vehicle_back', 'vehicle_left', 'vehicle_right', 'vehicle_dashboard'].includes(p.kind), `only routine photos (${p.kind})`);
  }
  assert.ok(all.filter(x => ['vehicle_damage', 'handover_signature'].includes(x.kind)).every(x => !x.gone), 'damage photos and signatures stay');
  const gone = all.find(x => x.gone)!;
  const r = await call('director', 'GET', `/photos/${gone.id}`);
  assert.equal(r.status, 410);
  assert.match(r.body.reasons[0], /routine inspection photo, removed after 90 days/);
  assert.ok((await db.query('SELECT count(*)::int AS n FROM vehicle_inspections')).rows[0].n > 0, 'the inspection records themselves stay');

  await purgeOldPhotos(appDb, new Date('2029-01-01T00:00:00Z'));
  all = await kinds();
  assert.ok(all.some(x => x.kind === 'vehicle_damage' && x.gone), 'after 2 years the damage photos go too');
  assert.ok(all.filter(x => latest.has(x.id)).every(x => !x.gone), 'the latest handover is still kept');
  assert.ok(all.filter(x => !['vehicle_front', 'vehicle_back', 'vehicle_left', 'vehicle_right', 'vehicle_dashboard', 'vehicle_damage', 'handover_signature', 'fleet_fault'].includes(x.kind)).every(x => !x.gone), 'job photos, slips and signatures on job cards are not touched');
});

test('the office screen: what needs attention, stores, technicians, and moving a job to another technician', async () => {
  assert.equal((await call('tech', 'GET', '/office/overview')).status, 403, 'technicians do not see the office screen');
  const o = (await call('admin', 'GET', '/office/overview')).body;
  assert.equal(typeof o.jobs.today, 'number');
  assert.equal(typeof o.fleet.checked_today, 'number');
  assert.ok(Array.isArray(o.fleet.missedYesterday));
  assert.equal(typeof o.stock.workshop_below_min, 'number');
  assert.equal(typeof o.technicians.active, 'number');

  // A new store, then a job there.
  assert.equal((await call('tech', 'POST', '/office/stores', { client: 'Spar', name: 'Spar Arboretum', lat: -28.75, lng: 32.06 })).status, 403);
  assert.match((await call('admin', 'POST', '/office/stores', { client: 'Spar', name: 'Spar Arboretum', lat: 51.5, lng: -0.1 })).body.reasons[0], /South Africa/);
  const st = await call('admin', 'POST', '/office/stores', { client: 'Spar', name: 'Spar Arboretum', address: 'Arboretum, Richards Bay', lat: -28.7465, lng: 32.0584 });
  assert.equal(st.status, 201, JSON.stringify(st.body));
  assert.equal((await call('admin', 'POST', '/office/stores', { client: 'SPAR', name: 'spar arboretum', lat: -28.7465, lng: 32.0584 })).status, 409, 'no duplicates');
  assert.ok((await call('admin', 'GET', '/office/stores')).body.some((x: { name: string; client: string }) => x.name === 'Spar Arboretum' && x.client === 'Spar'));

  const techs = (await call('admin', 'GET', '/office/technicians')).body;
  assert.ok(techs.some((x: { id: string }) => x.id === ids.tech) && techs.some((x: { id: string }) => x.id === ids.tech2));
  const job = await call('admin', 'POST', '/jobs', { jobType: 'breakdown', priority: 'urgent', storeId: st.body.id, faultReported: 'Display fridge not cooling', scheduledDate: '2026-10-20', leadTechnicianId: ids.tech });
  assert.equal(job.status, 201);
  const J = job.body.id ?? job.body.jobId;
  assert.equal((await call('admin', 'POST', `/jobs/${J}/assign`, { leadTechnicianId: ids.tech2 })).status, 400, 'say why');
  const mv = await call('admin', 'POST', `/jobs/${J}/assign`, { leadTechnicianId: ids.tech2, helperIds: [ids.tech], scheduledDate: '2026-10-21', reason: 'Thabo is on leave on the 20th' });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  assert.ok((await call('tech2', 'GET', '/me/notifications')).body.some((n: { message: string }) => /is now yours for 2026-10-21/.test(n.message)));
  const list = (await call('admin', 'GET', '/jobs')).body.find((x: { id: string }) => x.id === J);
  assert.equal(list.lead_technician, (await db.query('SELECT full_name FROM users WHERE id = $1', [ids.tech2])).rows[0].full_name);
  assert.equal((await call('tech2', 'GET', `/jobs/${J}`)).status, 200, 'the new technician can open it');
  assert.equal((await call('admin', 'POST', `/jobs/${J}/assign`, { leadTechnicianId: ids.tech2, helperIds: [ids.tech2], reason: 'Same person twice' })).status, 400);
  assert.equal((await call('tech', 'POST', `/jobs/${J}/assign`, { leadTechnicianId: ids.tech, reason: 'I want it back' })).status, 403);
});

test('the office edits jobs (every change on the job), cancels them, and makes quotes and invoices', async () => {
  // Editing a job that has not started.
  const j = await call('admin', 'POST', '/jobs', { jobType: 'breakdown', priority: 'normal', storeId: ids.store, faultReported: 'Combi oven error 34', scheduledDate: '2026-10-22', leadTechnicianId: ids.tech });
  const J = j.body.id;
  assert.equal((await call('tech', 'PATCH', `/jobs/${J}`, { priority: 'urgent' })).status, 403);
  const e1 = await call('admin', 'PATCH', `/jobs/${J}`, { priority: 'urgent', faultReported: 'Combi oven error 34, steam generator', clientOrderRef: 'PO-7781', scheduledDate: '2026-10-21' });
  assert.equal(e1.status, 200, JSON.stringify(e1.body));
  assert.deepEqual(e1.body.changes.map((c: { field: string }) => c.field), ['priority', 'fault reported', 'client order number', 'date']);
  const card = (await call('tech', 'GET', `/jobs/${J}`)).body;
  assert.equal(card.items[0].title, 'Combi oven error 34, steam generator', 'the reported work item follows');
  assert.ok((await call('tech', 'GET', '/me/notifications')).body.some((n: { message: string }) => /changed by the office: priority: urgent/.test(n.message)));
  const hist = (await call('admin', 'GET', `/jobs/${J}/changes`)).body;
  assert.equal(hist.length, 4);
  assert.ok(hist.some((h: { field: string; old_value: string; new_value: string }) => h.field === 'date' && h.old_value === '2026-10-22' && h.new_value === '2026-10-21'));
  // Cancelling it: off the technician's day, kept on record.
  assert.equal((await call('admin', 'POST', `/jobs/${J}/cancel`, {})).status, 400);
  assert.equal((await call('admin', 'POST', `/jobs/${J}/cancel`, { note: 'Client fixed it themselves' })).status, 200);
  assert.equal((await call('admin', 'PATCH', `/jobs/${J}`, { priority: 'normal' })).status, 409);
  assert.equal((await call('tech', 'POST', `/jobs/${J}/go`, { at: '2026-10-21T08:00:00+02:00' })).body.reasons[0], 'the office cancelled this job');
  assert.ok(!(await call('tech', 'GET', '/me/today?date=2026-10-21')).body.jobs.some((x: { id: string }) => x.id === J));

  // Company details and rates come from the CEO.
  assert.equal((await call('admin', 'PUT', '/office/company', { legalName: 'Zululand Service Providers' })).status, 403);
  assert.equal((await call('director', 'PUT', '/office/company', { legalName: 'Zululand Service Providers (Pty) Ltd', vatNo: '4123456789', address: 'Alton, Richards Bay', vatPct: 15, invoiceDueDays: 30 })).status, 200);
  assert.equal((await call('director', 'PUT', '/office/rates', { labour_per_hour: 65000, call_out: 45000, bought_out_markup_pct: 20 })).status, 200);

  // A quote for a store, sent, accepted, and the job it opens.
  assert.equal((await call('tech', 'POST', '/quotes', { storeId: ids.store, title: 'Replace door seals' })).status, 403);
  const q = await call('admin', 'POST', '/quotes', { storeId: ids.store, title: 'Replace both oven door seals', lines: [{ kind: 'stock', description: 'Oven door seal 1/1', qty: 2, unitPriceCents: 0 }, { kind: 'labour', description: 'Labour', qty: 1.5, unitPriceCents: 65000 }] });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  assert.equal(q.body.quoteNumber, 5001);
  assert.match((await call('admin', 'POST', `/quotes/${q.body.id}/send`, {})).body.reasons[0], /line 1 \(Oven door seal 1\/1\): a price/);
  assert.equal((await call('admin', 'PUT', `/quotes/${q.body.id}`, { title: 'Replace both oven door seals', lines: [{ kind: 'stock', description: 'Oven door seal 1/1', qty: 2, unitPriceCents: 85000 }, { kind: 'labour', description: 'Labour', qty: 1.5, unitPriceCents: 65000 }] })).status, 200);
  assert.equal((await call('admin', 'POST', `/quotes/${q.body.id}/send`, {})).status, 200);
  const qv = (await call('admin', 'GET', `/quotes/${q.body.id}`)).body;
  assert.deepEqual(qv.totals, { exVatCents: 267500, vatCents: 40125, totalCents: 307625 });
  assert.equal(qv.company.legal_name, 'Zululand Service Providers (Pty) Ltd');
  assert.equal((await call('admin', 'PUT', `/quotes/${q.body.id}`, { title: 'Changed', lines: [] })).status, 409, 'sent quotes are locked');
  await assert.rejects(db.query('UPDATE document_lines SET qty = 1 WHERE quote_id = $1', [q.body.id]), /cannot be changed/);
  const acc = await call('admin', 'POST', `/quotes/${q.body.id}/accept`, { clientRef: 'PO-9001', newJob: { scheduledDate: '2026-10-23', leadTechnicianId: ids.tech } });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.ok(acc.body.jobNumber > 0, 'the work is opened as a job');
  assert.equal((await call('admin', 'GET', '/quotes')).body[0].status, 'accepted');

  // An invoice for a closed job, drafted from the job card.
  const closed = (await db.query("SELECT id FROM jobs WHERE status = 'closed' ORDER BY closed_at LIMIT 1")).rows[0].id;
  assert.ok((await call('admin', 'GET', '/office/to-invoice')).body.some((x: { id: string }) => x.id === closed));
  assert.equal((await call('admin', 'POST', '/invoices', { jobId: J })).status, 409, 'only closed jobs');
  const inv = await call('admin', 'POST', '/invoices', { jobId: closed });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  assert.equal(inv.body.invoiceNumber, 7001);
  assert.equal((await call('admin', 'POST', '/invoices', { jobId: closed })).status, 409, 'one invoice per job');
  const iv = (await call('admin', 'GET', `/invoices/${inv.body.id}`)).body;
  assert.equal(iv.lines[0].kind, 'labour', 'labour from the job timers');
  assert.equal(iv.lines[0].unitPriceCents, 65000);
  const priced = iv.lines.map((l: { unitPriceCents: number }) => ({ ...l, unitPriceCents: l.unitPriceCents || 12000 }));
  assert.equal((await call('admin', 'PUT', `/invoices/${inv.body.id}`, { lines: priced, notes: 'Thank you' })).status, 200);
  assert.equal((await call('admin', 'POST', `/invoices/${inv.body.id}/send`, {})).status, 200);
  assert.equal((await call('admin', 'POST', `/invoices/${inv.body.id}/paid`, { ref: 'EFT 22831' })).status, 200);
  assert.equal((await call('admin', 'GET', '/invoices')).body.find((x: { id: string }) => x.id === inv.body.id).status, 'paid');
  assert.ok(!(await call('admin', 'GET', '/office/to-invoice')).body.some((x: { id: string }) => x.id === closed));
  assert.equal((await call('tech', 'GET', '/invoices')).status, 403);

  // Into Sage Pastel Partner: codes first, then one import batch; each invoice goes once.
  const ready0 = (await call('admin', 'GET', '/pastel/ready?kind=invoice')).body;
  const mineInv = ready0.find((x: { id: string }) => x.id === inv.body.id);
  assert.ok(mineInv.problems.some((p: string) => /customer code/.test(p)), JSON.stringify(mineInv));
  assert.equal((await call('admin', 'POST', '/pastel/batches', { kind: 'invoice' })).status, 409, 'nothing ready without codes');
  const client = (await call('admin', 'GET', '/pastel/clients')).body.find((c: { name: string }) => c.name === 'FreshMart');
  assert.equal((await call('admin', 'PUT', `/pastel/clients/${client.id}`, { code: 'FRESHMART' })).status, 400, 'max 6 characters');
  assert.equal((await call('admin', 'PUT', `/pastel/clients/${client.id}`, { code: 'fre001' })).status, 200);
  assert.equal((await call('admin', 'PUT', '/pastel/settings', { yearStartMonth: 3, taxType: '01', store: '001', codes: {
    labour: { code: 'LAB001', lineType: 4 }, call_out: { code: 'CALL01', lineType: 4 }, travel: { code: '1050000', lineType: 6 }, bought_out: { code: '1000000', lineType: 6 }, other: { code: '1000000', lineType: 6 } } })).status, 200);
  const stockLines = iv.lines.filter((l: { kind: string }) => l.kind === 'stock').length;
  if (stockLines) await db.query("UPDATE stock_items SET code = upper(code) WHERE code IS NOT NULL");
  const ready = (await call('admin', 'GET', '/pastel/ready?kind=invoice')).body.find((x: { id: string }) => x.id === inv.body.id);
  assert.deepEqual(ready.problems, []);
  const batch = await call('admin', 'POST', '/pastel/batches', { kind: 'invoice' });
  assert.equal(batch.status, 201, JSON.stringify(batch.body));
  assert.ok(batch.body.numbers.includes(7001));
  const rows = batch.body.file.split('\r\n').filter(Boolean);
  assert.match(rows[0], /^Header,,,,FRE001,\d+,\d\d\/\d\d\/\d{4},/);
  assert.ok(rows.slice(1).every((r: string) => r.startsWith('Detail,0,')));
  assert.ok(!(await call('admin', 'GET', '/pastel/ready?kind=invoice')).body.some((x: { id: string }) => x.id === inv.body.id), 'not sent twice');
  const again = await app.inject({ method: 'GET', url: `/pastel/batches/${batch.body.id}/file`, headers: { authorization: `Bearer ${tokens.admin}` } });
  assert.equal(again.statusCode, 200);
  assert.match(String(again.headers['content-disposition']), /pastel-invoices-/);
  assert.equal((await call('tech', 'GET', '/pastel/ready')).status, 403);
});

test('queries: the office or a technician asks any technician at any time; both see the conversation', async () => {
  assert.equal((await call('mech', 'POST', '/queries', { toUserId: ids.tech, subject: 'Hello there', body: 'Hello' })).status, 403, 'the mechanic does not send queries');
  assert.equal((await call('admin', 'POST', '/queries', { toUserId: ids.stock, subject: 'Keys', body: 'Where are the keys?' })).status, 400, 'only to technicians');
  assert.equal((await call('tech', 'POST', '/queries', { toUserId: ids.tech, subject: 'Me', body: 'Myself' })).status, 400);
  const people = (await call('tech', 'GET', '/queries/people')).body;
  assert.ok(people.some((p: { id: string }) => p.id === ids.tech2) && !people.some((p: { id: string }) => p.id === ids.tech));
  const q = await call('admin', 'POST', '/queries', { toUserId: ids.tech, subject: 'Harbour Deli access card', body: 'Did you get the access card from the store manager?' });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  assert.ok((await call('tech', 'GET', '/me/notifications')).body.some((n: { message: string }) => /Query from .*Harbour Deli access card/.test(n.message)));
  let mine = (await call('tech', 'GET', '/me/queries')).body;
  assert.equal(mine.unread, 1);
  assert.equal(mine.queries[0].messages[0].body, 'Did you get the access card from the store manager?');
  assert.equal((await call('tech2', 'POST', `/queries/${q.body.id}/messages`, { body: 'Not mine' })).status, 403, 'only the two people in it');
  assert.equal((await call('tech', 'POST', `/queries/${q.body.id}/messages`, { body: 'Yes, it is in the van.' })).status, 201);
  mine = (await call('tech', 'GET', '/me/queries')).body;
  assert.equal(mine.unread, 0, 'answering marks it read');
  const office = (await call('admin', 'GET', '/me/queries')).body;
  assert.equal(office.unread, 1);
  assert.equal(office.queries[0].messages.length, 2);
  assert.equal((await call('admin', 'POST', `/queries/${q.body.id}/read`, {})).status, 200);
  assert.equal((await call('admin', 'GET', '/me/queries')).body.unread, 0);
  // Technician to technician, about a job.
  const job = (await db.query('SELECT id FROM jobs ORDER BY job_number LIMIT 1')).rows[0].id;
  assert.equal((await call('tech', 'POST', '/queries', { toUserId: ids.tech2, jobId: job, subject: 'Spare contactor', body: 'Do you have a 25A contactor in your van?' })).status, 201);
  assert.equal((await call('tech2', 'GET', '/me/queries')).body.queries[0].job_number > 0, true);
  await assert.rejects(db.query('UPDATE query_messages SET body = $1', ['changed']), /cannot be edited/);
});

test('stockroom order list: a minimum per item, a photo of the part, ordered until delivered, and where it was last used', async () => {
  const company = (await db.query('SELECT company_id FROM stock_items WHERE id = $1', [ids.seal])).rows[0].company_id;
  const fuse = (await db.query("INSERT INTO stock_items (company_id, code, description) VALUES ($1, 'FUSE-10A', 'Fuse 10A') RETURNING id", [company])).rows[0].id;
  await db.query("INSERT INTO stock_movements (stock_item_id, qty, kind, to_stockroom, created_by) VALUES ($1, 3, 'receive', true, $2)", [fuse, ids.stock]);
  assert.equal((await call('tech', 'PUT', `/stock/items/${fuse}/settings`, { minQty: 10 })).status, 403);
  const photo = await upload('stock', '/photos', { kind: 'stock_item', takenAt: '2026-10-17T09:00:00+02:00' });
  assert.equal((await call('stock', 'PUT', `/stock/items/${fuse}/settings`, { minQty: 10, reorderQty: 20, photoId: photo.body.id, supplierName: 'Voltex Richards Bay' })).status, 200);
  let ol = (await call('stock', 'GET', '/stock/order-list')).body;
  const line = ol.toOrder.find((x: { id: string }) => x.id === fuse);
  assert.equal(line.suggested, 20, 'the set order quantity');
  assert.equal(line.in_stockroom, 3);
  assert.equal((await call('stock', 'GET', '/stock/stockroom')).body.find((x: { id: string }) => x.id === fuse).photoId, photo.body.id);
  assert.equal((await call('stock', 'POST', `/stock/items/${fuse}/ordered`, { qty: 20, note: 'Voltex order 5521' })).status, 200);
  ol = (await call('stock', 'GET', '/stock/order-list')).body;
  assert.ok(ol.ordered.some((x: { id: string }) => x.id === fuse) && !ol.toOrder.some((x: { id: string }) => x.id === fuse));
  assert.equal((await call('stock', 'POST', '/stock/deliveries', { at: '2026-10-18T09:00:00+02:00', supplierName: 'Voltex', reference: 'INV-5521', lines: [{ stockItemId: fuse, qty: 20 }] })).status, 201);
  ol = (await call('stock', 'GET', '/stock/order-list')).body;
  assert.ok(!ol.ordered.some((x: { id: string }) => x.id === fuse) && !ol.toOrder.some((x: { id: string }) => x.id === fuse), 'delivered and above the minimum');
  // Where the valve was last used (it was used on a job card earlier).
  const room = (await call('stock', 'GET', '/stock/stockroom')).body.find((x: { id: string }) => x.id === ids.seal);
  assert.ok(room.lastUsed && room.lastUsed.jobNumber > 0, JSON.stringify(room.lastUsed));
  const hist = (await call('stock', 'GET', `/stock/items/${ids.seal}/history`)).body;
  assert.ok(hist.some((h: { kind: string; job_number: number }) => h.kind === 'use_on_job' && h.job_number > 0));
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

  // No mechanic of their own: the Admin (and a technician) also get the mechanic's work, keeping their position.
  assert.equal((await call('admin', 'GET', '/fleet')).status, 403);
  assert.equal((await call('manager', 'PUT', `/access/users/${ids.admin}/fleet-duty`, { on: true })).status, 403, 'only whoever manages access');
  const duty = await call('director', 'PUT', `/access/users/${ids.admin}/fleet-duty`, { on: true });
  assert.equal(duty.status, 200, JSON.stringify(duty.body));
  assert.equal((await call('director', 'PUT', `/access/users/${ids.tech2}/fleet-duty`, { on: true })).status, 200);
  const me = (await call('admin', 'GET', '/me')).body;
  assert.equal(me.login_level, 'admin', 'still Admin');
  assert.equal(me.fleetDuty, true);
  assert.equal((await call('admin', 'GET', '/fleet/technicians')).status, 200, 'can run the fleet');
  assert.equal((await call('admin', 'GET', '/jobs')).status, 200, 'and still do Admin work');
  const people = (await call('director', 'GET', '/access/positions')).body.people;
  assert.equal(people.filter((x: { does_fleet: boolean }) => x.does_fleet).length, 3, 'mechanic plus the two extra');
  await call('tech', 'POST', `/fleet/vehicles/${ids.v2}/faults`, { description: 'Indicator on the right is not working', severity: 'urgent', at: '2026-10-16T07:30:00+02:00' });
  assert.ok((await call('admin', 'GET', '/me/notifications')).body.some((n: { message: string }) => /ND 503-221/.test(n.message)), 'extra mechanics hear about faults too');
  assert.equal((await call('director', 'PUT', `/access/users/${ids.mech}/fleet-duty`, { on: false })).status, 409, 'a mechanic by position');
  assert.equal((await call('director', 'PUT', `/access/users/${ids.admin}/fleet-duty`, { on: false })).status, 200);
  assert.equal((await call('director', 'PUT', `/access/users/${ids.tech2}/fleet-duty`, { on: false })).status, 200);
  assert.equal((await call('admin', 'GET', '/fleet')).status, 403, 'taken away at once');

  // A chosen Admin also runs the stockroom, with full access; other Admins only stand in to issue.
  assert.equal((await call('admin', 'GET', '/stock/stockroom')).status, 403);
  assert.equal((await call('admin', 'GET', '/stock/issues')).status, 200, 'any admin issues when the stock controller is out');
  assert.equal((await call('manager', 'PUT', `/access/users/${ids.admin}/stock-duty`, { on: true })).status, 403, 'only whoever manages access');
  assert.equal((await call('director', 'PUT', `/access/users/${ids.stock}/stock-duty`, { on: true })).status, 409, 'already a stock controller');
  assert.equal((await call('director', 'PUT', `/access/users/${ids.admin}/stock-duty`, { on: true })).status, 200);
  const am = (await call('admin', 'GET', '/me')).body;
  assert.equal(am.login_level, 'admin');
  assert.equal(am.stockDuty, true);
  assert.ok(am.permissions.includes('manage_stockroom') && am.permissions.includes('assign_jobs'));
  assert.equal((await call('admin', 'GET', '/stock/issues')).status, 200, 'full stockroom access');
  assert.equal((await call('admin', 'GET', '/stock/stockroom')).status, 200);
  assert.ok((await call('director', 'GET', '/access/positions')).body.people.find((x: { id: string }) => x.id === ids.admin).does_stock);
  assert.equal((await call('director', 'PUT', `/access/users/${ids.admin}/stock-duty`, { on: false })).status, 200);
  assert.equal((await call('admin', 'GET', '/stock/stockroom')).status, 403, 'taken away at once');

  // People: the Admin sees everyone; only someone given positions and access changes them.
  const pp = (await call('admin', 'GET', '/people')).body;
  assert.equal(pp.canManage, false);
  assert.ok(pp.trades.some((t: { label: string }) => t.label === 'Foodservice tech'));
  assert.equal((await call('admin', 'PUT', `/access/users/${ids.tech}/trade`, { trade: 'electrician' })).status, 403);
  assert.equal((await call('director', 'PUT', `/access/users/${ids.tech}/trade`, { trade: 'electrician' })).status, 200);
  assert.equal((await call('director', 'PUT', `/access/users/${ids.admin}/trade`, { trade: 'plumber' })).status, 409, 'only technicians');
  assert.equal((await call('admin', 'GET', '/people')).body.people.find((x: { id: string }) => x.id === ids.tech).tradeLabel, 'Electrician');
  assert.equal((await call('tech', 'GET', '/people')).status, 403);
  assert.equal((await call('director', 'PUT', `/access/users/${ids.admin}/work`, { area: 'access', on: true })).status, 200);
  assert.equal((await call('admin', 'GET', '/people')).body.canManage, true, 'given positions and access by the CEO');
  assert.equal((await call('admin', 'PUT', `/access/users/${ids.tech}/trade`, { trade: 'foodservice' })).status, 200);
  assert.equal((await call('director', 'PUT', `/access/users/${ids.admin}/work`, { area: 'access', on: false })).status, 200);
  assert.equal((await call('admin', 'PUT', `/access/users/${ids.tech}/trade`, { trade: 'plumber' })).status, 403, 'taken away again');

  // A profile: what they are busy with now, contact details for the office, personal details only with access.
  const pic = await upload('director', '/photos', { kind: 'profile', takenAt: '2026-10-17T09:00:00+02:00' });
  assert.equal((await call('admin', 'PUT', `/people/${ids.tech}/profile`, { phone: '082 555 0101' })).status, 403);
  assert.equal((await call('director', 'PUT', `/people/${ids.tech}/profile`, { phone: '082 555 0101', emergencyName: 'Nandi Mkhize', emergencyPhone: '083 555 0199',
    idNumber: '9001015800085', dateOfBirth: '1990-01-01', homeAddress: '12 Pelican Rd, Meerensee', startDate: '2019-02-01', photoId: pic.body.id })).status, 200);
  const prof = (await call('director', 'GET', `/people/${ids.tech}`)).body;
  assert.equal(prof.contact.phone, '082 555 0101');
  assert.equal(prof.personal.id_number, '9001015800085');
  assert.equal(prof.photo_id, pic.body.id);
  assert.ok('vehicle' in prof.now && 'job' in prof.now && Array.isArray(prof.now.with));
  const asAdmin = (await call('admin', 'GET', `/people/${ids.tech}`)).body;
  assert.equal(asAdmin.contact.emergency_phone, '083 555 0199', 'the office sees contact details');
  assert.equal(asAdmin.personal, null, 'but not personal details');
  assert.equal((await call('tech2', 'GET', `/people/${ids.tech}`)).status, 403);
  assert.equal((await call('admin', 'GET', '/people')).body.people.find((x: { id: string }) => x.id === ids.tech).photo_id, pic.body.id);

  // The CEO decides which Admin does which work.
  const before = (await call('admin', 'GET', '/me')).body.work;
  assert.deepEqual([before.jobs, before.documents, before.stockroom, before.fleet], [true, true, false, false], 'an Admin by default: jobs, quotes and invoices');
  assert.equal((await call('director', 'PUT', `/access/users/${ids.creator}/work`, { area: 'jobs', on: false })).status, 409, 'the CEO always has everything');
  assert.equal((await call('director', 'PUT', `/access/users/${ids.admin}/work`, { area: 'jobs', on: false })).status, 200);
  assert.equal((await call('admin', 'GET', '/me')).body.work.jobs, false);
  assert.equal((await call('admin', 'POST', '/jobs', { jobType: 'breakdown', storeId: ids.store, faultReported: 'Test', scheduledDate: '2026-10-20', leadTechnicianId: ids.tech })).status, 403, 'this Admin no longer opens jobs');
  const w = await call('director', 'PUT', `/access/users/${ids.admin}/work`, { area: 'flags', on: true });
  assert.equal(w.body.work.flags, true);
  assert.equal((await call('admin', 'GET', '/flags')).status, 200, 'flags for every department');
  const ppl = (await call('director', 'GET', '/access/positions')).body;
  assert.ok(ppl.areas.some((a: { key: string }) => a.key === 'stockroom'));
  assert.equal(ppl.people.find((x: { id: string }) => x.id === ids.admin).work.flags, true);
  await call('director', 'PUT', `/access/users/${ids.admin}/work`, { area: 'jobs', on: true });
  await call('director', 'PUT', `/access/users/${ids.admin}/work`, { area: 'flags', on: false });
  assert.equal((await call('director', 'PUT', `/access/users/${ids.director}/position`, { position: 'technician' })).status, 200, 'the Creator can still manage access');
  assert.equal((await call('creator', 'PUT', `/access/users/${ids.director}/position`, { position: 'director' })).status, 200);
});

test('staff records: only the CEO and HR read, add and delete them; deleting leaves a line', async () => {
  assert.equal((await call('manager', 'GET', `/people/${ids.tech}/record`)).status, 403, 'not managers by default');
  assert.equal((await call('admin', 'POST', `/people/${ids.tech}/record`, { type: 'observation', whatHappened: 'Late for the Meerensee job' })).status, 403);
  const noReason = await call('director', 'POST', `/people/${ids.tech}/record`, { type: 'written_warning', whatHappened: 'Third late arrival this month' });
  assert.equal(noReason.status, 400, 'a warning must say the action taken and why');
  const w = await call('director', 'POST', `/people/${ids.tech}/record`, { type: 'written_warning', happenedOn: '2026-10-09', whatHappened: 'Third late arrival this month',
    actionTaken: 'Written warning, valid 6 months', reason: 'Repeated late arrival after a verbal warning' });
  assert.equal(w.status, 200);
  const n = await call('director', 'POST', `/people/${ids.tech}/record`, { type: 'observation', whatHappened: 'Left the van unlocked at the yard' });
  // The CEO gives the Admin HR work.
  assert.equal((await call('director', 'PUT', `/access/users/${ids.admin}/work`, { area: 'hr', on: true })).status, 200);
  const rec = await call('admin', 'GET', `/people/${ids.tech}/record`);
  assert.equal(rec.status, 200);
  assert.equal(rec.body.entries.length, 2);
  assert.equal(rec.body.summary.written, 1);
  assert.equal((await call('admin', 'GET', `/people/${ids.admin}/record`)).status, 403, 'nobody reads their own record');
  const del = await app.inject({ method: 'DELETE', url: `/people/${ids.tech}/record/${n.body.id}`, headers: { authorization: `Bearer ${tokens.admin}` } });
  assert.equal(del.statusCode, 200);
  const after = (await call('director', 'GET', `/people/${ids.tech}/record`)).body;
  assert.equal(after.entries.length, 1);
  assert.equal(after.deletions.length, 1);
  assert.equal(after.deletions[0].deleted_by, 'admin');
  await assert.rejects(db.query('UPDATE employee_log_entries SET what_happened = $1 WHERE id = $2', ['changed', w.body.id]), 'records cannot be edited');
  assert.equal((await call('director', 'GET', `/people/${ids.tech}`)).body.record.write, true);
  await call('director', 'PUT', `/access/users/${ids.admin}/work`, { area: 'hr', on: false });
  assert.equal((await call('admin', 'GET', `/people/${ids.tech}/record`)).status, 403);
});

test('tools and PPE: the stockroom keeps each person\'s list; stock goes out and comes back', async () => {
  const boots = (await db.query("INSERT INTO stock_items (code, description, category) VALUES ('PPE-BOOT', 'Safety boots', 'ppe') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO stock_movements (stock_item_id, qty, kind, to_stockroom, created_by) VALUES ($1, 4, 'receive', true, $2)", [boots, ids.stock]);
  const onHand = async () => Number((await db.query('SELECT qty FROM stockroom_stock WHERE stock_item_id = $1', [boots])).rows[0].qty);
  assert.equal((await call('manager', 'POST', `/people/${ids.tech}/kit`, { kind: 'tool', name: 'Fluke multimeter' })).status, 403, 'only the stockroom (or whoever stands in)');
  const meter = await call('stock', 'POST', `/people/${ids.tech}/kit`, { kind: 'tool', name: 'Fluke multimeter', detail: 'Serial 4471' });
  assert.equal(meter.status, 200);
  const b = await call('stock', 'POST', `/people/${ids.tech}/kit`, { kind: 'ppe', stockItemId: boots, detail: 'Size 9', replaceBy: '2026-01-01' });
  assert.equal(b.status, 200);
  assert.equal((await call('stock', 'POST', `/people/${ids.tech}/kit`, { kind: 'tool', stockItemId: boots })).status, 409, 'boots are PPE, not a tool');
  assert.equal((await call('stock', 'POST', `/people/${ids.tech}/kit`, { kind: 'ppe', stockItemId: ids.seal })).status, 409, 'a valve is stock, not PPE');
  assert.ok(!(await call('tech', 'GET', '/stock/catalogue')).body.some((x: { code: string }) => x.code === 'PPE-BOOT'), 'PPE is not booked onto jobs');
  const openJob = (await db.query("SELECT id FROM jobs WHERE lead_technician_id = $1 AND status NOT IN ('closed', 'cancelled') LIMIT 1", [ids.tech])).rows[0];
  if (openJob) {
    const r = await call('tech', 'POST', `/jobs/${openJob.id}/stock-out`, { at: '2026-10-16T08:00:00+02:00', lines: [{ stockItemId: boots, qty: 1 }] });
    assert.match(r.body.reasons[0], /tool or PPE/);
  }
  assert.equal(await onHand(), 3, 'boots came out of the stockroom');
  assert.equal((await call('stock', 'POST', `/people/${ids.tech}/kit`, { kind: 'ppe', stockItemId: boots, qty: 10 })).status, 409, 'not more than is in stock');
  const mine = (await call('tech', 'GET', '/me/kit')).body;
  assert.equal(mine.held.length, 2);
  assert.equal(mine.dueForReplacement, 1, 'boots past their replace-by date');
  assert.equal((await call('tech2', 'GET', `/people/${ids.tech}/kit`)).status, 403);
  assert.equal((await call('admin', 'GET', `/people/${ids.tech}/kit`)).status, 200, 'the office can see it');
  assert.equal((await call('stock', 'POST', `/kit/${meter.body.id}/close`, { status: 'lost' })).status, 400, 'lost needs a note');
  assert.equal((await call('stock', 'POST', `/kit/${meter.body.id}/close`, { status: 'lost', note: 'Left at Boxer Esikhawini, not found' })).status, 200);
  assert.equal((await call('stock', 'POST', `/kit/${b.body.id}/close`, { status: 'returned' })).status, 200);
  assert.equal(await onHand(), 4, 'returned boots back in stock');
  assert.equal((await call('stock', 'POST', `/kit/${b.body.id}/close`, { status: 'returned' })).status, 409);
  const everyone = (await call('stock', 'GET', '/kit/people')).body;
  const t = everyone.find((x: { id: string }) => x.id === ids.tech);
  assert.equal(t.tools, 0);
  assert.ok(!('phone' in t) && !('email' in t), 'the stockroom sees names, not contact details');
  assert.equal((await call('stock', 'GET', `/people/${ids.tech}`)).status, 403, 'the stock controller cannot open profiles');
  assert.equal((await call('stock', 'GET', '/people')).status, 403);
  const list = (await call('stock', 'GET', `/people/${ids.tech}/kit`)).body;
  assert.equal(list.held.length, 0);
  assert.equal(list.history.length, 2);
  await assert.rejects(db.query('DELETE FROM person_kit WHERE id = $1', [meter.body.id]));
});

test('department managers: techs under them, the van stock list they set, vans short of it flagged and topped up', async () => {
  const fuse = (await db.query("INSERT INTO stock_items (code, description) VALUES ('FUSE-20A', 'Fuse 20A') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO stock_movements (stock_item_id, qty, kind, to_stockroom, created_by) VALUES ($1, 30, 'receive', true, $2)", [fuse, ids.stock]);
  const boots = (await db.query("SELECT id FROM stock_items WHERE code = 'PPE-BOOT'")).rows[0].id;
  const openFlag = async (who: string) => (await db.query("SELECT details FROM flags WHERE technician_id = $1 AND flag_type = 'van_stock_short' AND status <> 'resolved'", [who])).rows;

  // The manager sees his department and sets its list; the admin cannot.
  const mine = (await call('manager', 'GET', '/van-stock')).body.departments;
  assert.equal(mine[0].id, ids.dept, 'his own department first');
  assert.equal(mine[0].canEdit, true);
  assert.equal(mine.filter((x: { canEdit: boolean }) => x.canEdit).length, 1, 'only his own to change');
  assert.equal((await call('admin', 'PUT', `/van-stock/departments/${ids.dept}/items/${fuse}`, { qty: 5 })).status, 403);
  assert.equal((await call('manager', 'PUT', `/van-stock/departments/${ids.dept}/items/${boots}`, { qty: 1 })).status, 409, 'PPE is not van stock');
  const set = await call('manager', 'PUT', `/van-stock/departments/${ids.dept}/items/${fuse}`, { qty: 5 });
  assert.equal(set.status, 200);
  assert.ok(set.body.techs.every((t: { complete: boolean }) => !t.complete), 'every van is now short');
  assert.equal((await openFlag(ids.tech)).length, 1, 'flagged');
  const me = (await call('tech', 'GET', '/me/van')).body;
  assert.equal(me.complete, false);
  assert.equal(me.lines.find((l: { code: string }) => l.code === 'FUSE-20A').short, 5);
  assert.ok((await call('stock', 'GET', '/kit/people')).body.find((x: { id: string }) => x.id === ids.tech).van_short >= 1, 'the stockroom sees it');

  // The stockroom tops him up: the flag closes itself.
  assert.equal((await call('manager', 'POST', `/van-stock/technicians/${ids.tech}/issue`, { lines: [{ stockItemId: fuse, qty: 5 }] })).status, 403);
  assert.equal((await call('stock', 'POST', `/van-stock/technicians/${ids.tech}/issue`, { lines: [{ stockItemId: fuse, qty: 500 }] })).status, 409, 'not more than the stockroom has');
  const top = await call('stock', 'POST', `/van-stock/technicians/${ids.tech}/issue`, { lines: [{ stockItemId: fuse, qty: 5 }] });
  assert.equal(top.status, 200);
  const shortElse = top.body.lines.filter((l: { short: number }) => l.short > 0);
  assert.equal(shortElse.length, 0, JSON.stringify(shortElse));
  assert.equal((await openFlag(ids.tech)).length, 0, 'complete again: the flag is closed');
  const closed = (await db.query("SELECT resolution_note FROM flags WHERE technician_id = $1 AND flag_type = 'van_stock_short' ORDER BY raised_at DESC LIMIT 1", [ids.tech])).rows[0];
  assert.equal(closed.resolution_note, 'Van stock complete again');

  // The list goes up: short again, one flag at a time.
  await call('manager', 'PUT', `/van-stock/departments/${ids.dept}/items/${fuse}`, { qty: 6 });
  await call('manager', 'PUT', `/van-stock/departments/${ids.dept}/items/${fuse}`, { qty: 7 });
  const again = await openFlag(ids.tech);
  assert.equal(again.length, 1);
  assert.equal(again[0].details.short[0].short, 2);
  assert.equal((await call('manager', 'GET', `/van-stock/departments/${ids.dept}/changes`)).body.length, 3, 'every change is kept');

  // Departments: the CEO sets them up and puts technicians under a manager.
  assert.equal((await call('admin', 'POST', '/departments', { name: 'Gas' })).status, 403);
  assert.equal((await call('director', 'POST', '/departments', { name: 'Gas', managerId: ids.tech })).status, 409, 'a technician cannot manage a department');
  const plumbing = await call('director', 'POST', '/departments', { name: 'Gas' });
  assert.equal(plumbing.status, 200);
  assert.equal((await call('manager', 'PUT', `/van-stock/departments/${plumbing.body.id}/items/${fuse}`, { qty: 1 })).status, 403, 'not his department');
  const hr = await call('director', 'POST', '/departments', { name: 'HVAC', managerId: ids.manager });
  assert.equal((await call('manager', 'PUT', `/van-stock/departments/${hr.body.id}/items/${fuse}`, { qty: 1 })).status, 200, 'he now runs HVAC');
  await call('manager', 'PUT', `/van-stock/departments/${hr.body.id}/items/${fuse}`, { qty: 0 });
  await call('director', 'PUT', `/departments/${ids.dept}`, { managerId: ids.manager });
  const moved = await call('director', 'PUT', `/access/users/${ids.tech}/department`, { departmentId: plumbing.body.id });
  assert.equal(moved.status, 200);
  assert.equal((await openFlag(ids.tech)).length, 0, 'no list in Plumbing yet: nothing short');
  assert.ok(!(await call('director', 'GET', `/people/${ids.manager}`)).body.team.some((t: { id: string }) => t.id === ids.tech), 'no longer under him');
  await call('director', 'PUT', `/access/users/${ids.tech}/department`, { departmentId: ids.dept });
  assert.ok((await call('director', 'GET', `/people/${ids.manager}`)).body.team.some((t: { id: string }) => t.id === ids.tech), 'back under him');
  assert.equal((await openFlag(ids.tech)).length, 1, 'back in Refrigeration: short again');
  assert.equal((await call('director', 'GET', `/people/${ids.tech}`)).body.manager, 'manager');
  await call('manager', 'PUT', `/van-stock/departments/${ids.dept}/items/${fuse}`, { qty: 0 });
  assert.equal((await openFlag(ids.tech)).length, 0, 'off the list: complete');

  // His team on a map: only the technicians under him.
  await call('director', 'PUT', `/access/users/${ids.tech2}/department`, { departmentId: plumbing.body.id });
  const map = (await call('manager', 'GET', '/team/map')).body;
  assert.equal(map.all, false);
  assert.ok(map.technicians.some((t: { id: string }) => t.id === ids.tech), 'his technician');
  assert.ok(!map.technicians.some((t: { id: string }) => t.id === ids.tech2), 'not another department\'s');
  assert.ok('location' in map.technicians[0].now && 'vehicle' in map.technicians[0].now);
  assert.ok((await call('director', 'GET', '/team/map')).body.technicians.some((t: { id: string }) => t.id === ids.tech2), 'the CEO sees everyone');
  assert.equal((await call('stock', 'GET', '/team/map')).status, 403);
  assert.equal((await call('tech', 'GET', '/team/map')).status, 403);
  await call('director', 'PUT', `/access/users/${ids.tech2}/department`, { departmentId: ids.dept });
});

test('HR: puts technicians and department managers in one department each, keeps staff records, and nothing else', async () => {
  const me = (await call('hr', 'GET', '/me')).body;
  assert.equal(me.work.hr, true);
  assert.equal(me.work.jobs, false);
  assert.equal((await call('hr', 'GET', '/people')).status, 200, 'HR sees people');
  assert.ok((await call('hr', 'GET', `/people/${ids.tech}`)).body.personal, 'HR keeps the personal details too');
  assert.equal((await call('manager', 'GET', `/people/${ids.tech}`)).body.personal, null, 'not the department manager');
  assert.equal((await call('hr', 'GET', `/people/${ids.tech}/record`)).status, 200, 'and the staff records');
  assert.equal((await call('hr', 'GET', '/office/overview')).status, 403, 'not jobs');
  // HR sets technician, admin, department manager and stock controller; the rest stay with the CEO.
  assert.equal((await call('hr', 'PUT', `/access/users/${ids.tech2}/position`, { position: 'stockroom' })).status, 200);
  assert.equal((await call('hr', 'PUT', `/access/users/${ids.tech2}/position`, { position: 'technician' })).status, 200);
  assert.equal((await call('hr', 'PUT', `/access/users/${ids.tech2}/position`, { position: 'director' })).status, 403, 'not a director');
  assert.equal((await call('hr', 'PUT', `/access/users/${ids.mech}/position`, { position: 'technician' })).status, 403, 'not the mechanic');
  assert.equal((await call('hr', 'PUT', `/access/users/${ids.hr}/position`, { position: 'admin' })).status, 403, 'not herself');
  assert.equal((await call('hr', 'PUT', `/access/users/${ids.tech2}/trade`, { trade: 'plumber' })).status, 200, 'and trades');
  assert.equal((await call('hr', 'GET', '/people')).body.settablePositions.length, 4);
  assert.equal((await call('manager', 'PUT', `/access/users/${ids.tech2}/position`, { position: 'admin' })).status, 403, 'not a manager');

  const mgr2 = (await db.query("INSERT INTO users (full_name, email, login_level, password_hash) VALUES ('mgr2', 'mgr2@zsp.test', 'management', 'x') RETURNING id")).rows[0].id;
  // Every company starts with Electrical, Plumbing, Service and Foodservice.
  const elec = { body: { id: (await call('hr', 'GET', '/departments')).body.departments.find((x: { name: string }) => x.name === 'Electrical').id as string } };
  assert.equal((await call('admin', 'PUT', `/access/users/${mgr2}/department`, { departmentId: elec.body.id })).status, 403, 'not the admin');
  const a = await call('hr', 'PUT', `/access/users/${mgr2}/department`, { departmentId: elec.body.id });
  assert.equal(a.status, 200);
  assert.equal(a.body.manages, elec.body.id, 'a department manager put in a department runs it');
  const managerOf = async (deptId: string) => (await call('hr', 'GET', '/departments')).body.departments.find((x: { id: string }) => x.id === deptId).manager_id;
  assert.equal(await managerOf(elec.body.id), mgr2);

  // One department each: moving him to Refrigeration takes him off Electrical and replaces its manager.
  const b = await call('hr', 'PUT', `/access/users/${mgr2}/department`, { departmentId: ids.dept });
  assert.equal(b.body.replaced, 'manager');
  assert.equal(await managerOf(ids.dept), mgr2);
  assert.equal(await managerOf(elec.body.id), null);
  assert.equal((await db.query('SELECT department_id FROM users WHERE id = $1', [ids.manager])).rows[0].department_id, null, 'the old manager has no department now');
  const back = await call('hr', 'PUT', `/access/users/${ids.manager}/department`, { departmentId: ids.dept });
  assert.equal(back.body.replaced, 'mgr2');
  assert.equal(await managerOf(ids.dept), ids.manager);

  // Technicians: one department, under its manager.
  assert.equal((await call('hr', 'PUT', `/access/users/${ids.tech}/department`, { departmentId: elec.body.id })).status, 200);
  assert.equal((await call('hr', 'GET', `/people/${ids.tech}`)).body.department, 'Electrical');
  await call('hr', 'PUT', `/access/users/${ids.tech}/department`, { departmentId: ids.dept });
  assert.equal((await call('hr', 'GET', `/people/${ids.tech}`)).body.manager, 'manager');

  // The CEO can give an Admin the HR work too.
  await call('director', 'PUT', `/access/users/${ids.admin}/work`, { area: 'hr', on: true });
  assert.equal((await call('admin', 'PUT', `/access/users/${ids.tech2}/department`, { departmentId: ids.dept })).status, 200);
  await call('director', 'PUT', `/access/users/${ids.admin}/work`, { area: 'hr', on: false });
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

test('daily timesheets: made by the app, the previous day submitted by the technician, missing ones flagged, HR exports them', async () => {
  // HR's sheet for 12 Oct: job 1 (Go 07:00, arrived 07:30, out for parts 09:00 to 09:30, finished 10:00).
  const hr = await call('hr', 'GET', '/timesheets?from=2026-10-12&to=2026-10-12');
  assert.equal(hr.status, 200);
  const tech = hr.body.technicians.find((t: { id: string }) => t.id === ids.tech);
  const day = tech.days[0];
  const j1 = day.day.jobs.find((j: { jobId: string }) => j.jobId === ids.job);
  assert.ok(j1, 'the job is on his sheet');
  assert.equal(j1.travelMin, 30 + 30, 'driving there, and out for parts');
  assert.equal(j1.workMin, 150 - 30, 'on site less the time out for parts');
  assert.ok(Array.isArray(day.flags), 'flags of the day are on the sheet');
  assert.ok(tech.totals.workMin >= 120);
  assert.equal(day.pay.dayType, 'weekday');
  assert.equal(day.pay.normalMin + day.pay.overtimeMin, day.day.travelMin + day.day.workMin, 'paid: normal plus overtime');
  assert.ok('overtimeMin' in tech.totals && 'doubleMin' in tech.totals);
  assert.equal((await call('manager', 'PUT', '/timesheets/settings', { weekdayNormalMin: 540, saturdayNormalMin: 0 })).status, 403, 'HR or the CEO sets the hours');
  assert.equal((await call('hr', 'PUT', '/timesheets/settings', { weekdayNormalMin: 60, saturdayNormalMin: 0 })).status, 200);
  const ot = (await call('hr', 'GET', `/timesheets?from=2026-10-12&to=2026-10-12&userId=${ids.tech}`)).body.technicians[0].days[0].pay;
  assert.equal(ot.normalMin, 60, 'one normal hour, the rest overtime');
  await call('hr', 'PUT', '/timesheets/settings', { weekdayNormalMin: 480, saturdayNormalMin: 0 });
  assert.equal((await call('manager', 'GET', '/timesheets?from=2026-10-12&to=2026-10-12')).status, 200, 'his manager sees his department');
  assert.equal((await call('admin', 'GET', '/timesheets?from=2026-10-12&to=2026-10-12')).status, 403, 'not the admin');
  assert.equal((await call('hr', 'GET', '/timesheets?from=2026-10-01&to=2026-11-15')).status, 400, 'up to a month at a time');
  assert.equal((await call('hr', 'GET', `/timesheets?from=2026-10-12&to=2026-10-12&userId=${ids.tech}`)).body.technicians.length, 1, 'one person');

  // He submits a finished day; time not accounted for needs a word.
  const sheet = (await call('tech', 'GET', '/me/timesheets/2026-10-14')).body;
  assert.equal(sheet.submitted, null);
  if (sheet.day.unaccountedMin >= 30) {
    assert.equal((await call('tech', 'POST', '/me/timesheets/2026-10-14/submit', { at: '2026-10-15T06:30:00+02:00' })).status, 400, 'say what the time was');
  }
  assert.equal((await call('tech', 'POST', '/me/timesheets/2026-10-14/submit', { at: '2026-10-14T16:00:00+02:00', note: 'Waited at the yard' })).status, 400, 'not before the day is over');
  const sent = await call('tech', 'POST', '/me/timesheets/2026-10-14/submit', { at: '2026-10-15T06:30:00+02:00', note: 'Loaded the van at the yard first' });
  assert.equal(sent.status, 200);
  assert.equal((await call('tech', 'POST', '/me/timesheets/2026-10-14/submit', { at: '2026-10-15T06:31:00+02:00', note: 'again' })).status, 409, 'once');
  assert.equal((await call('tech', 'GET', '/me/timesheets/2026-10-14')).body.submitted.note, 'Loaded the van at the yard first');
  await assert.rejects(db.query("UPDATE timesheets SET note = 'changed' WHERE id = $1", [sent.body.id]), 'kept as submitted');

  // A technician who has not submitted his finished days is flagged, and submitting closes the flag.
  await db.query("UPDATE users SET created_at = now() - interval '5 days' WHERE id = $1", [ids.tech2]);
  const owed = (await call('tech2', 'GET', '/me/timesheets')).body;
  assert.ok(owed.due.length >= 1, 'he owes at least one day');
  const late = owed.due.find((d: { overdue: boolean }) => d.overdue);
  assert.ok(late, 'one is overdue');
  const missing = await db.query("SELECT id FROM flags WHERE technician_id = $1 AND flag_type = 'timesheet_missing' AND details->>'workDate' = $2 AND status = 'open'", [ids.tech2, late.date]);
  assert.equal(missing.rowCount, 1);
  await call('tech2', 'GET', '/me/timesheets');
  assert.equal((await db.query("SELECT 1 FROM flags WHERE technician_id = $1 AND flag_type = 'timesheet_missing' AND details->>'workDate' = $2", [ids.tech2, late.date])).rowCount, 1, 'flagged once');
  assert.equal((await call('tech2', 'POST', `/me/timesheets/${late.date}/submit`, { at: new Date().toISOString(), note: 'Day off, sick' })).status, 200);
  assert.equal((await db.query("SELECT status FROM flags WHERE id = $1", [missing.rows[0].id])).rows[0].status, 'resolved');
});

test('company logo: the CEO sets it and everyone in the company sees it; other photos stay private', async () => {
  const logo = await upload('director', '/photos', { kind: 'logo', takenAt: '2026-10-12T08:00:00+02:00' });
  assert.equal(logo.status, 201);
  const cur = (await call('director', 'GET', '/office/company')).body.profile ?? {};
  assert.equal((await call('admin', 'PUT', '/office/company', { legalName: 'ZSP', logoPhotoId: logo.body.id })).status, 403, 'not the admin');
  assert.equal((await call('director', 'PUT', '/office/company', { ...{ legalName: cur.legal_name ?? 'Zululand Service Providers' }, logoPhotoId: logo.body.id })).status, 200);
  const brand = (await call('tech', 'GET', '/company/brand')).body;
  assert.equal(brand.logoPhotoId, logo.body.id, 'the technician sees the logo');
  const pic = async (who: string, id: string) => (await app.inject({ method: 'GET', url: `/photos/${id}`, headers: { authorization: `Bearer ${tokens[who]}` } })).statusCode;
  assert.equal(await pic('tech', logo.body.id), 200);
  const sig = await upload('director', '/photos', { kind: 'fuel_slip', takenAt: '2026-10-12T08:00:00+02:00' });
  assert.equal(await pic('tech', sig.body.id), 403, 'other photos stay private');
});

test('departments: switched off and on; people moved out first; nobody put in one that is off', async () => {
  const d = (await call('hr', 'GET', '/departments')).body;
  for (const n of ['Admin', 'Electrical', 'Plumbing', 'Service', 'Foodservice']) assert.ok(d.departments.some((x: { name: string; active: boolean }) => x.name === n && x.active), `${n} from the start`);
  assert.deepEqual(d.missing, [], 'Refrigeration is set up in this test company too');
  // Admin is a department too: the office staff are put in it.
  const adminDept = d.departments.find((x: { name: string }) => x.name === 'Admin').id;
  assert.ok(d.members.some((m: { id: string }) => m.id === ids.admin), 'office staff can be placed in a department');
  assert.equal((await call('hr', 'PUT' as 'POST', `/access/users/${ids.admin}/department`, { departmentId: adminDept })).status, 200);
  assert.equal((await call('hr', 'GET', '/departments')).body.departments.find((x: { id: string }) => x.id === adminDept).staff, 1);
  const svc = { body: { id: d.departments.find((x: { name: string }) => x.name === 'Service').id as string } };
  assert.equal((await call('director', 'PUT' as 'POST', `/access/users/${ids.tech2}/department`, { departmentId: svc.body.id })).status, 200);
  const off = await call('hr', 'PUT' as 'POST', `/departments/${svc.body.id}`, { active: false });
  assert.equal(off.status, 409, 'not while someone works in it');
  assert.match(off.body.reasons[0], /move everyone in Service/);
  await call('director', 'PUT' as 'POST', `/access/users/${ids.tech2}/department`, { departmentId: ids.dept });
  assert.equal((await call('admin', 'PUT' as 'POST', `/departments/${svc.body.id}`, { active: false })).status, 403, 'not the admin');
  assert.equal((await call('hr', 'PUT' as 'POST', `/departments/${svc.body.id}`, { active: false })).status, 200);
  const after = (await call('hr', 'GET', '/departments')).body;
  assert.equal(after.departments.find((x: { id: string }) => x.id === svc.body.id).active, false);
  assert.ok(!after.missing.includes('Service'), 'set up, just off');
  assert.equal((await call('director', 'PUT' as 'POST', `/access/users/${ids.tech2}/department`, { departmentId: svc.body.id })).status, 409, 'nobody into a department that is off');
  assert.ok(!(await call('director', 'GET', '/van-stock')).body.departments.some((x: { id: string }) => x.id === svc.body.id), 'no van list for a department that is off');
  // HR renames a department and gives it a logo; every list shows the new name.
  assert.equal((await call('hr', 'PUT' as 'POST', `/departments/${ids.dept}`, { name: 'Cold rooms' })).status, 200);
  assert.equal((await call('director', 'GET', `/people/${ids.tech}`)).body.department, 'Cold rooms', 'the profile shows the new name');
  assert.ok((await call('director', 'GET', '/van-stock')).body.departments.some((x: { name: string }) => x.name === 'Cold rooms'), 'so do the van stock lists');
  const pic = await upload('hr', '/photos', { kind: 'vehicle_front', takenAt: '2026-10-12T08:00:00+02:00' });
  assert.equal((await call('hr', 'PUT' as 'POST', `/departments/${ids.dept}`, { logoPhotoId: pic.body.id })).status, 400, 'a logo picture only');
  const logo = await upload('hr', '/photos', { kind: 'logo', takenAt: '2026-10-12T08:00:00+02:00' });
  assert.equal((await call('hr', 'PUT' as 'POST', `/departments/${ids.dept}`, { logoPhotoId: logo.body.id })).status, 200);
  assert.equal((await call('director', 'GET', `/people/${ids.tech}`)).body.departmentLogo, logo.body.id);
  assert.equal((await call('admin', 'PUT' as 'POST', `/departments/${ids.dept}`, { name: 'X dept' })).status, 403, 'not the admin');
  await call('hr', 'PUT' as 'POST', `/departments/${ids.dept}`, { name: 'Refrigeration' });
  const on = await call('hr', 'POST', '/departments', { name: 'service' });
  assert.equal(on.status, 200); assert.equal(on.body.id, svc.body.id, 'adding it again switches the same one back on');
  assert.equal((await call('hr', 'POST', '/departments', { name: 'Service' })).status, 409, 'already there');
});

test('timesheets: only the CEO fills in one the technician did not submit, marked as filled in by the CEO', async () => {
  const date = '2026-09-21';
  assert.equal((await call('hr', 'POST', `/timesheets/${ids.tech2}/${date}/fill`, {})).status, 403, 'not HR');
  assert.equal((await call('manager', 'POST', `/timesheets/${ids.tech2}/${date}/fill`, {})).status, 403, 'not the manager');
  assert.equal((await call('admin', 'POST', `/timesheets/${ids.tech2}/${date}/fill`, {})).status, 403, 'not the admin');
  assert.equal((await call('director', 'POST', `/timesheets/${ids.admin}/${date}/fill`, {})).status, 404, 'technicians only');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
  assert.equal((await call('director', 'POST', `/timesheets/${ids.tech2}/${today}/fill`, {})).status, 400, 'a finished day only');
  const f = await call('director', 'POST', `/timesheets/${ids.tech2}/${date}/fill`, {});
  assert.equal(f.status, 200);
  assert.equal((await call('director', 'POST', `/timesheets/${ids.tech2}/${date}/fill`, {})).status, 409, 'once');
  const sheet = (await call('hr', 'GET', `/timesheets?from=${date}&to=${date}&userId=${ids.tech2}`)).body;
  assert.equal(sheet.canFill, false, 'HR does not get the button');
  assert.ok(sheet.technicians[0].days[0].submitted.filledBy, 'shows who filled it in');
  assert.equal((await call('director', 'GET', `/timesheets?from=${date}&to=${date}`)).body.canFill, true);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM notifications WHERE recipient_id = $1 AND kind = 'timesheet'", [ids.tech2])).rows[0].n, 1, 'the technician is told');
});

test('HR edits profiles and ends employment: the person leaves every list, the login stops, and HR keeps the record', async () => {
  assert.equal((await call('hr', 'GET', `/people/${ids.tech2}`)).body.canEdit, true, 'HR edits profiles');
  assert.ok((await call('hr', 'GET', `/people/${ids.tech2}`)).body.personal, 'and sees personal details');
  assert.equal((await call('hr', 'PUT' as 'POST', `/people/${ids.tech2}/profile`, { phone: '082 000 1111', emergencyName: 'Mother' })).status, 200);
  assert.equal((await call('admin', 'PUT' as 'POST', `/people/${ids.tech2}/profile`, { phone: '1' })).status, 403, 'not the admin');
  // Someone to let go: a new technician with a pair of boots on his name.
  const leaver = (await db.query("INSERT INTO users (full_name, email, login_level, password_hash) VALUES ('Leaver Tech', 'leaver@zsp.test', 'technician', $1) RETURNING id", [await hashPassword(PW)])).rows[0].id;
  await db.query("INSERT INTO logins (email, user_id, company_id) VALUES ('leaver@zsp.test', $1, $2)", [leaver, ids.company]);
  await db.query("INSERT INTO person_kit (user_id, kind, name, issued_by) VALUES ($1, 'ppe', 'Safety boots', $2)", [leaver, ids.hr]);
  assert.equal((await call('admin', 'POST', `/people/${leaver}/terminate`, { date: '2026-10-12', reason: 'resigned' })).status, 403, 'not the admin');
  assert.equal((await call('hr', 'POST', `/people/${ids.director}/terminate`, { date: '2026-10-12', reason: 'resigned' })).status, 403, 'not the CEO');
  assert.equal((await call('hr', 'POST', `/people/${leaver}/terminate`, { date: '2026-10-12', reason: 'other' })).status, 400, 'other needs a reason');
  const t = await call('hr', 'POST', `/people/${leaver}/terminate`, { date: '2026-10-12', reason: 'resigned', note: 'Moved to Durban' });
  assert.equal(t.status, 200);
  assert.equal(t.body.onName.kit.length, 1, 'what is still on his name is kept');
  assert.equal((await call('hr', 'POST', `/people/${leaver}/terminate`, { date: '2026-10-12', reason: 'resigned' })).status, 409, 'once');
  assert.ok(!(await call('director', 'GET', '/people')).body.people.some((x: { id: string }) => x.id === leaver), 'off the people list');
  assert.ok(!(await call('hr', 'GET', '/departments')).body.members.some((x: { id: string }) => x.id === leaver), 'off the departments');
  assert.equal((await call('', 'POST', '/auth/login', { email: 'leaver@zsp.test', password: PW })).status, 401, 'the login stops');
  const gone = (await call('hr', 'GET', '/people/terminated')).body;
  assert.equal(gone[0].full_name, 'Leaver Tech'); assert.equal(gone[0].reasonLabel, 'Resigned'); assert.equal(gone[0].items_on_name, 1);
  assert.equal((await call('admin', 'GET', '/people/terminated')).status, 403);
  const prof = (await call('hr', 'GET', `/people/${leaver}`)).body;
  assert.equal(prof.termination.reason, 'resigned'); assert.equal(prof.canEdit, false, 'the record stays as it was');
  assert.equal((await call('hr', 'GET', `/people/${leaver}/record`)).status, 200, 'his staff record is still there');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'terminated'")).rows[0].n, 1, 'the stockroom is told to collect');
  await assert.rejects(db.query('DELETE FROM terminations WHERE user_id = $1', [leaver]), 'the record cannot be deleted');
});

test('timesheets: HR and the CEO open anyone\'s, all the way back and after they left, with a log of every submission, fill-in, missing day and view', async () => {
  await db.query("UPDATE users SET created_at = now() - interval '40 days' WHERE id = $1", [ids.tech]);
  const people = (await call('hr', 'GET', '/timesheets/people')).body;
  assert.equal(people.full, true);
  const leaver = people.people.find((x: { full_name: string }) => x.full_name === 'Leaver Tech');
  assert.ok(leaver && leaver.left, 'people who left are there, marked');
  assert.ok(!(await call('manager', 'GET', '/timesheets/people')).body.people.some((x: { left: boolean }) => x.left), 'a manager sees only his own, not leavers');
  assert.equal((await call('admin', 'GET', '/timesheets/people')).status, 403);
  // Leavers in the export when asked for.
  const y = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
  const without = (await call('director', 'GET', `/timesheets?from=${y}&to=${y}`)).body.technicians;
  const withLeft = (await call('director', 'GET', `/timesheets?from=${y}&to=${y}&includeLeft=1`)).body.technicians;
  assert.ok(!without.some((t: { id: string }) => t.id === leaver.id)); assert.ok(withLeft.some((t: { id: string; left: boolean }) => t.id === leaver.id && t.left));
  assert.equal((await call('director', 'GET', `/timesheets?from=${y}&to=${y}&userId=${leaver.id}`)).status, 200, 'one person who left');
  // History: three months at a time, back to when he started.
  const h = await call('hr', 'GET', `/timesheets/person/${ids.tech}/history`);
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.ok(h.body.months.length >= 2, 'this month and last');
  assert.ok(h.body.months.flatMap((m: { days: unknown[] }) => m.days).length > 0, 'his days');
  const d0 = h.body.months.flatMap((m: { days: { status: string }[] }) => m.days)[0];
  assert.ok(['submitted', 'filled', 'missing', 'none'].includes(d0.status) && 'overtimeMin' in d0);
  assert.equal((await call('director', 'GET', `/timesheets/person/${leaver.id}/history`)).status, 200, 'the CEO opens a leaver\'s');
  assert.equal((await call('tech', 'GET', `/timesheets/person/${ids.tech2}/history`)).status, 403);
  // The log: HR and the CEO only.
  const log = await call('hr', 'GET', `/timesheets/person/${ids.tech2}/log`);
  assert.equal(log.status, 200, JSON.stringify(log.body));
  const kinds = new Set(log.body.events.map((e: { kind: string }) => e.kind));
  assert.ok(kinds.has('submitted') && kinds.has('missing') && kinds.has('resolved'), [...kinds].join());
  assert.ok(log.body.events.some((e: { kind: string; by: string }) => e.kind === 'viewed'), 'who looked at his timesheets');
  assert.equal((await call('manager', 'GET', `/timesheets/person/${ids.tech2}/log`)).status, 403, 'not a manager');
  assert.ok((await call('director', 'GET', `/timesheets/person/${ids.tech}/log`)).body.events.some((e: { text: string }) => /history/.test(e.text)), 'opening the history is logged too');
});

test('technicians submit quotes: on a job not finished, or from scratch with a job card for reference; the office prices and sends', async () => {
  const open = await call('admin', 'POST', '/jobs', { jobType: 'breakdown', storeId: ids.store, faultReported: 'Cold room door seal torn', scheduledDate: '2026-10-13', leadTechnicianId: ids.tech });
  const opts = (await call('tech', 'GET', '/me/quote-options')).body;
  assert.ok(opts.stores.some((x: { id: string }) => x.id === ids.store), 'the stores to quote for');
  assert.ok(opts.jobs.some((x: { id: string; open: boolean }) => x.id === open.body.id && x.open), 'his open jobs');
  assert.ok(opts.jobs.some((x: { id: string; open: boolean }) => x.id === ids.job && !x.open), 'and his finished ones, for reference');
  assert.equal((await call('admin', 'GET', '/me/quote-options')).body.stores.length > 0, true);
  const work = { labourHours: 2, stockLines: [{ stockItemId: ids.seal, qty: 1 }], boughtOutLines: [{ description: 'Door gasket 1.8 m', qty: 1, estimatedPriceCents: 85000 }] };
  assert.equal((await call('tech', 'POST', '/me/quotes', { jobId: open.body.id, title: 'Replace door seal' })).status, 400, 'the work is needed');
  assert.equal((await call('tech2', 'POST', '/me/quotes', { jobId: open.body.id, title: 'Replace door seal', ...work })).status, 403, 'only on his own jobs');
  assert.equal((await call('tech', 'POST', '/me/quotes', { jobId: ids.job, title: 'More work', ...work })).status, 409, 'not on a finished job');
  const onJob = await call('tech', 'POST', '/me/quotes', { jobId: open.body.id, title: 'Replace door seal', notes: 'Seal torn along the bottom', ...work });
  assert.equal(onJob.status, 201);
  assert.equal((await call('tech2', 'POST', '/me/quotes', { storeId: ids.store, referenceJobId: ids.job, title: 'New fridge', ...work })).status, 403, 'link his own job cards only');
  const fresh = await call('tech', 'POST', '/me/quotes', { storeId: ids.store, referenceJobId: ids.job, title: 'Second ice machine for the deli', ...work });
  assert.equal(fresh.status, 201);
  const list = (await call('admin', 'GET', '/quotes')).body;
  const q1 = list.find((x: { id: string }) => x.id === onJob.body.id);
  assert.equal(q1.from_technician, true); assert.equal(q1.status, 'draft', 'a draft for the office');
  const q2 = (await call('admin', 'GET', `/quotes/${fresh.body.id}`)).body;
  assert.equal(q2.quote.reference_job_number, list.find((x: { id: string }) => x.id === fresh.body.id).reference_job_number);
  assert.ok(q2.quote.reference_job_number, 'the job card linked for reference');
  assert.equal(q2.lines.find((l: { kind: string }) => l.kind === 'bought_out').unit_price_cents ?? q2.lines.find((l: { kind: string }) => l.kind === 'bought_out').unitPriceCents, 85000);
  assert.equal((await call('tech', 'GET', '/me/quotes')).body.length, 2, 'he sees what he submitted');
  assert.equal((await call('mech', 'POST', '/me/quotes', { storeId: ids.store, title: 'x', ...work })).status, 403, 'not the mechanic');
});

test('credit notes: part or all of a sent invoice, with a reason; the office filters jobs by invoiced and credited', async () => {
  const inv = (await call('admin', 'GET', '/invoices')).body.find((x: { invoice_number: number }) => x.invoice_number === 7001);
  const jobsBefore = (await call('admin', 'GET', '/jobs')).body;
  assert.equal(jobsBefore.find((j: { id: string }) => j.id === inv.job_id).billing, 'invoiced');
  assert.ok(jobsBefore.some((j: { billing: string }) => j.billing === 'not_invoiced'), 'and jobs not invoiced yet');
  assert.equal((await call('tech', 'POST', `/invoices/${inv.id}/credit`, { reason: 'Wrong part charged' })).status, 403);
  assert.equal((await call('admin', 'POST', `/invoices/${inv.id}/credit`, { reason: 'no' })).status, 400, 'a reason');
  assert.equal((await call('admin', 'POST', `/invoices/${inv.id}/credit`, { amountCents: inv.ex_vat_cents + 1, reason: 'Overcharged on labour' })).status, 409, 'not more than the invoice');
  const part = await call('admin', 'POST', `/invoices/${inv.id}/credit`, { amountCents: 10000, reason: 'Call-out charged twice' });
  assert.equal(part.status, 201); assert.equal(part.body.creditNumber, 9001);
  const rest = await call('admin', 'POST', `/invoices/${inv.id}/credit`, { reason: 'Client disputes the rest of the invoice' });
  assert.equal(rest.status, 201); assert.equal(rest.body.amountCents, inv.ex_vat_cents - 10000, 'the rest');
  assert.equal((await call('admin', 'POST', `/invoices/${inv.id}/credit`, { reason: 'Once more please' })).status, 409, 'nothing left to credit');
  const d = (await call('admin', 'GET', `/invoices/${inv.id}`)).body;
  assert.equal(d.credits.length, 2); assert.equal(d.invoice.status, 'paid', 'the invoice itself does not change');
  assert.equal((await call('admin', 'GET', '/jobs')).body.find((j: { id: string }) => j.id === inv.job_id).billing, 'credited');
  await assert.rejects(db.query('DELETE FROM credit_notes WHERE invoice_id = $1', [inv.id]), 'credit notes are kept');
});

test('parts report: a Foodservice technician who needs parts reports it step by step before leaving site; it becomes a quote and goes out on the letterhead', async () => {
  const sent: { to: string[]; subject: string; html: string; pictures: { cid: string }[] }[] = [];
  mailBox = sent;
  await db.query('UPDATE departments SET parts_report = true WHERE id = $1', [ids.dept]);
  const created = await call('admin', 'POST', '/jobs', { jobType: 'breakdown', storeId: ids.store, faultReported: 'Combi oven not heating', scheduledDate: '2026-10-12', leadTechnicianId: ids.tech });
  const J = `/jobs/${created.body.id}`;
  await call('tech', 'POST', `${J}/go`, { at: at(9) });
  await call('tech', 'POST', `${J}/arrive`, { at: at(9, 20), position: STORE, managerName: 'Sipho', safety: SAFE });
  await call('tech', 'POST', `${J}/start`, { at: at(9, 25) });
  const card = (await call('tech', 'GET', J)).body;
  assert.equal(card.parts_report_required, true, 'his department asks for it');
  const later = { at: at(11), progress: 'Heating element burnt out, needs a new one from Rational', reason: 'waiting_for_parts', plannedReturn: '2026-10-15', managerInformed: 'Sipho' };
  assert.equal((await call('tech', 'POST', `${J}/continue-later`, later)).status, 400, 'he must say whether another quote is needed');
  assert.equal((await call('tech', 'POST', `${J}/continue-later`, { ...later, quoteNeeded: true })).status, 409, 'the report first');
  const pic = async (kind: string) => (await upload('tech', '/photos', { kind, takenAt: at(10), jobId: created.body.id })).body.id as string;
  const report = { at: at(10, 30), machinePhotoId: await pic('report_machine'), serialPhotoId: await pic('report_serial'), serialText: 'E11SI2201', partPhotoId: await pic('report_part'),
    partDescription: 'Heating element 9 kW', partQty: 1, extraPhotoIds: [await pic('report_extra')], notes: 'Element shorted to earth' };
  assert.equal((await call('tech', 'POST', `${J}/parts-report`, { ...report, serialPhotoId: report.machinePhotoId })).status, 400, 'each photo of its own kind');
  assert.equal((await call('tech2', 'POST', `${J}/parts-report`, report)).status, 403, 'only someone on the job');
  const r = await call('tech', 'POST', `${J}/parts-report`, report);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.quoteNumber, 'a draft quote for the office');
  assert.equal((await call('tech', 'POST', `${J}/continue-later`, { ...later, quoteNeeded: true })).status, 200, 'now he can leave');
  const q = (await call('admin', 'GET', `/quotes/${r.body.quoteId}`)).body;
  assert.equal(q.quote.from_technician, true); assert.match(q.lines[0].description, /Heating element/);
  // The letterhead: the CEO's, used on the email.
  const top = await upload('director', '/photos', { kind: 'letterhead', takenAt: at(8) });
  assert.equal((await call('admin', 'PUT' as 'POST', '/company/letterhead', { headerPhotoId: top.body.id })).status, 403, 'only the CEO');
  assert.equal((await call('director', 'PUT' as 'POST', '/company/letterhead', { headerPhotoId: top.body.id })).status, 200);
  assert.equal((await call('tech', 'GET', '/company/letterhead')).body.headerPhotoId, top.body.id, 'everyone uses it');
  const full = (await call('admin', 'GET', `/parts-reports/${r.body.id}`)).body;
  assert.equal(full.report.serial_text, 'E11SI2201'); assert.equal(full.canEmail, true);
  assert.equal((await call('tech2', 'GET', `/parts-reports/${r.body.id}`)).status, 403);
  assert.equal((await call('admin', 'POST', `/parts-reports/${r.body.id}/email`, { to: ['not-an-email'] })).status, 400);
  const e = await call('admin', 'POST', `/parts-reports/${r.body.id}/email`, { to: ['manager@store.test'], message: 'Please see the report below.' });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ['manager@store.test']);
  assert.match(sent[0].html, /cid:letterhead-top/, 'on the letterhead');
  assert.match(sent[0].html, /E11SI2201/); assert.ok(sent[0].pictures.length >= 4, 'the photos go with it');
  assert.equal((await call('admin', 'GET', `/parts-reports/${r.body.id}`)).body.emails.length, 1, 'kept');
  await db.query('UPDATE departments SET parts_report = false WHERE id = $1', [ids.dept]);
});

test('workshop repairs: uplifted from site with a signature, a loan machine left, repaired in the workshop, delivered back; the card stays open until both are back', async () => {
  const d = (day: number, h: number, m = 0) => `2026-10-${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+02:00`;
  const WS = { lat: -28.7950, lng: 32.0500 };
  // The office sets the workshop and the loan machines.
  assert.equal((await call('tech', 'PUT' as 'POST', '/company/workshop', { name: 'Workshop', ...WS })).status, 403, 'the office sets it');
  assert.equal((await call('admin', 'PUT' as 'POST', '/company/workshop', { name: 'Our workshop', address: 'Alton', ...WS, geofenceM: 150 })).status, 200);
  assert.equal((await call('tech', 'GET', '/company/workshop')).body.workshop.name, 'Our workshop');
  assert.equal((await call('tech', 'POST', '/loan-machines', { name: 'Ice machine' })).status, 403);
  const loan = (await call('admin', 'POST', '/loan-machines', { name: 'Loan ice machine 1', serial: 'LN-001' })).body;
  assert.equal(loan.out, false);

  const created = await call('admin', 'POST', '/jobs', { jobType: 'breakdown', storeId: ids.store, faultReported: 'Ice machine compressor noisy', scheduledDate: '2026-10-26', leadTechnicianId: ids.tech });
  const id = created.body.id, J = `/jobs/${id}`, item = created.body.items[0].id;
  assert.equal(created.body.machine_at, 'site');
  assert.equal((await call('tech', 'POST', `${J}/workshop-start`, { at: d(26, 8), position: WS, safety: { areaSafe: true, isolated: true } })).status, 409, 'the machine is still on site');
  await call('tech', 'POST', `${J}/go`, { at: d(26, 9) });
  await call('tech', 'POST', `${J}/arrive`, { at: d(26, 9, 20), position: STORE, managerName: 'Sipho', safety: SAFE });
  await call('tech', 'POST', `${J}/start`, { at: d(26, 9, 25) });
  const pic = async (kind: string) => (await upload('tech', '/photos', { kind, takenAt: d(26, 10), jobId: id })).body.id as string;
  assert.equal((await upload('tech', '/photos', { kind: 'uplift', takenAt: d(26, 10) })).status, 400, 'belongs to a job');
  const sig = (await upload('tech', '/photos', { kind: 'signature', takenAt: d(26, 10), jobId: id }, 'image/png')).body.id;
  const uplift = { at: d(26, 10, 30), reason: 'Compressor bearings worn, needs to be stripped in the workshop', managerName: 'Sipho', signaturePhotoId: sig, photoIds: [await pic('uplift')], equipmentId: ids.equipment };
  assert.equal((await call('tech', 'POST', `${J}/uplift`, { ...uplift, reason: 'broken' })).status, 409, 'a full sentence why');
  assert.equal((await call('tech', 'POST', `${J}/uplift`, { ...uplift, photoIds: [sig] })).status, 409, 'photos of the right kind');
  // A loan machine first, signed for.
  const lo = { at: d(26, 10, 20), loanMachineId: loan.id, photoIds: [await pic('loan')], managerName: 'Sipho', signaturePhotoId: sig };
  assert.equal((await call('tech', 'POST', `${J}/loan-out`, lo)).status, 200);
  assert.equal((await call('tech', 'POST', `${J}/loan-out`, lo)).status, 409, 'already out');
  const lifted = await call('tech', 'POST', `${J}/uplift`, uplift);
  assert.equal(lifted.status, 200, JSON.stringify(lifted.body));
  assert.equal(lifted.body.machine_at, 'workshop'); assert.equal(lifted.body.status, 'continue_later'); assert.equal(lifted.body.currentState, 'uplifted');
  assert.equal(lifted.body.loans_out, 1); assert.equal(lifted.body.loans_out_list[0].name, 'Loan ice machine 1');
  const loans = (await call('admin', 'GET', '/loan-machines')).body;
  assert.equal(loans.find((x: { id: string }) => x.id === loan.id).store, 'FreshMart Meerensee', 'the office sees where it is');
  const listed = (await call('admin', 'GET', '/jobs')).body.find((x: { id: string }) => x.id === id);
  assert.equal(listed.machine_at, 'workshop'); assert.equal(listed.loans_out, 1);
  assert.equal((await call('admin', 'PUT' as 'POST', `/loan-machines/${loan.id}`, { active: false })).status, 409, 'cannot retire one that is out');
  // In the workshop: checked against its location, no store manager.
  const far = await call('tech', 'POST', `${J}/workshop-start`, { at: d(27, 8), position: STORE, safety: { areaSafe: true, isolated: true } });
  assert.equal(far.status, 409); assert.match(far.body.reasons[0], /not at the workshop/);
  const ws = await call('tech', 'POST', `${J}/workshop-start`, { at: d(27, 8), position: WS, safety: { areaSafe: true, isolated: true } });
  assert.equal(ws.status, 200, JSON.stringify(ws.body)); assert.equal(ws.body.visits.at(-1).place, 'workshop');
  await call('tech', 'POST', `${J}/start`, { at: d(27, 8, 5) });
  await upload('tech', `${J}/items/${item}/photos`, { kind: 'before', takenAt: d(27, 8, 10) });
  await upload('tech', `${J}/items/${item}/photos`, { kind: 'after', takenAt: d(27, 11) });
  await call('tech', 'PATCH', `${J}/items/${item}`, { equipmentId: ids.equipment, faultType: 'mechanical', noMaterials: true,
    found: 'Compressor bearings worn and noisy under load', did: 'Replaced the compressor bearings and tested for two hours', tested: 'yes', outcome: 'complete' });
  const done = await call('tech', 'POST', `${J}/done`, { at: d(27, 13) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.ready_to_deliver, true); assert.equal(done.body.status, 'continue_later', 'waits for delivery');
  assert.equal((await call('admin', 'GET', '/jobs')).body.find((x: { id: string }) => x.id === id).ready_to_deliver, true);
  // Delivery back, and the loan machine collected.
  await call('tech', 'POST', `${J}/go`, { at: d(28, 9) });
  await call('tech', 'POST', `${J}/arrive`, { at: d(28, 9, 20), position: STORE, managerName: 'Sipho', safety: SAFE });
  await call('tech', 'POST', `${J}/start`, { at: d(28, 9, 25) });
  assert.equal((await call('tech', 'POST', `${J}/done`, { at: d(28, 9, 30) })).status, 409, 'not done while the machine is in the workshop');
  const pic2 = async (kind: string) => (await upload('tech', '/photos', { kind, takenAt: d(28, 9, 40), jobId: id })).body.id as string;
  const back = await call('tech', 'POST', `${J}/deliver`, { at: d(28, 9, 45), photoIds: [await pic2('delivery')], receivedBy: 'Sipho' });
  assert.equal(back.status, 200, JSON.stringify(back.body)); assert.equal(back.body.machine_at, 'site');
  const early = await call('tech', 'POST', `${J}/done`, { at: d(28, 10) });
  assert.equal(early.status, 409); assert.match(early.body.reasons.join(), /loan machine/, 'collect the loan machine before Done');
  assert.equal((await call('tech', 'POST', `${J}/loan-back`, { at: d(28, 10, 6), loanMachineId: loan.id, photoIds: [] })).status, 400, 'a photo');
  assert.equal((await call('tech', 'POST', `${J}/loan-back`, { at: d(28, 10, 6), loanMachineId: loan.id, photoIds: [await pic2('loan')] })).status, 200);
  assert.equal((await call('tech', 'POST', `${J}/done`, { at: d(28, 10, 7) })).status, 200);
  const sig2 = (await upload('tech', '/photos', { kind: 'signature', takenAt: d(28, 10, 1), jobId: id }, 'image/png')).body.id;
  const close = { at: d(28, 10, 5), signOff: { signature: true, managerName: 'Sipho', signaturePhotoId: sig2 } };
  const closed = await call('tech', 'POST', `${J}/close`, { ...close, at: d(28, 10, 8) });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.deepEqual(closed.body.moves.map((m: { kind: string }) => m.kind), ['loan_out', 'uplifted', 'delivered', 'loan_back']);
  assert.equal((await call('admin', 'GET', '/loan-machines')).body.find((x: { id: string }) => x.id === loan.id).out, false, 'back in');

  // A workshop repair: the machine is brought in, so the job starts in the workshop.
  const wr = await call('admin', 'POST', '/jobs', { jobType: 'workshop_repair', storeId: ids.store, faultReported: 'Microwave brought in, not heating', scheduledDate: '2026-10-29', leadTechnicianId: ids.tech });
  assert.equal(wr.body.machine_at, 'workshop');
  const W = `/jobs/${wr.body.id}`;
  assert.equal((await call('tech', 'POST', `${W}/workshop-start`, { at: d(29, 8), position: WS, safety: { areaSafe: true, isolated: true } })).status, 200);
  await call('tech', 'POST', `${W}/start`, { at: d(29, 8, 5) });
  const wpic = async (kind: string) => (await upload('tech', '/photos', { kind, takenAt: d(29, 9), jobId: wr.body.id })).body.id as string;
  // The client collects it at the workshop.
  assert.equal((await call('tech', 'POST', `${W}/deliver`, { at: d(29, 12), photoIds: [await wpic('delivery')], receivedBy: 'Sipho (collected)' })).status, 200);
  const wv = (await call('tech', 'GET', W)).body;
  assert.equal(wv.machine_at, 'site'); assert.equal(wv.moves[0].place, 'workshop');
});

test('vehicle barcodes: the mechanic gives a vehicle a new sticker code (the old one stops working) or keeps the one on it', async () => {
  const list = await call('mech', 'GET', '/fleet/barcodes');
  assert.equal(list.status, 200); assert.equal(list.body.canEdit, true);
  const v = list.body.vehicles[0];
  const fresh = await call('mech', 'POST', `/fleet/vehicles/${v.id}/barcode`, {});
  assert.equal(fresh.status, 200); assert.match(fresh.body.barcode, /^V-[A-Z2-9]{6}$/); assert.equal(fresh.body.previous, v.barcode);
  assert.equal((await call('tech2', 'GET', `/vehicles/lookup?barcode=${fresh.body.barcode}`)).body.vehicle.registration, v.registration, 'the new sticker scans');
  if (v.barcode !== v.registration) assert.equal((await call('tech2', 'GET', `/vehicles/lookup?barcode=${encodeURIComponent(v.barcode)}`)).status, 404, 'the old sticker no longer works');
  assert.equal((await call('mech', 'POST', `/fleet/vehicles/${v.id}/barcode`, { code: 'bad code!' })).status, 400);
  const other = list.body.vehicles[1];
  if (other) assert.equal((await call('mech', 'POST', `/fleet/vehicles/${other.id}/barcode`, { code: fresh.body.barcode })).status, 409, 'one code, one vehicle');
  assert.equal((await call('tech', 'POST', `/fleet/vehicles/${v.id}/barcode`, {})).status, 403, 'the mechanic only');
});

test('tool store: tools and ladders with serials and barcodes, booked out for a job with a signature, signed back with their condition', async () => {
  assert.equal((await call('tech', 'GET', '/tool-store')).status, 403, 'the stockroom keeps it');
  const ladder = await call('stock', 'POST', '/tool-store', { name: 'Step ladder 2.4 m', kind: 'ladder', serial: 'LAD-2401' });
  assert.equal(ladder.status, 201, JSON.stringify(ladder.body)); assert.match(ladder.body.barcode, /^T-/);
  assert.equal((await call('stock', 'POST', '/tool-store', { name: 'Another ladder', kind: 'ladder', serial: 'lad-2401' })).status, 409, 'one serial number, one tool');
  const drill = (await call('stock', 'POST', '/tool-store', { name: 'Core drill', barcode: 'zsp-t-0099' })).body;
  assert.equal(drill.barcode, 'ZSP-T-0099', 'an existing sticker kept');
  assert.equal((await call('stock', 'GET', `/tool-store/find?code=${ladder.body.barcode}`)).body.id, ladder.body.id, 'scanning the sticker finds it');
  assert.equal((await call('stock', 'GET', '/tool-store/find?code=lad-2401')).body.id, ladder.body.id, 'so does the serial number');
  const job = (await call('admin', 'POST', '/jobs', { jobType: 'breakdown', storeId: ids.store, faultReported: 'Light fittings out in the warehouse', scheduledDate: '2026-10-30', leadTechnicianId: ids.tech })).body;
  const sig = async () => (await upload('stock', '/photos', { kind: 'tool_signature', takenAt: '2026-10-30T07:00:00+02:00' }, 'image/png')).body.id as string;
  const out = { userId: ids.tech, jobId: job.id, signaturePhotoId: await sig() };
  assert.equal((await call('stock', 'POST', `/tool-store/${ladder.body.id}/book-out`, { ...out, signaturePhotoId: '00000000-0000-4000-8000-000000000001' })).status, 409, 'he signs first');
  assert.equal((await call('stock', 'POST', `/tool-store/${ladder.body.id}/book-out`, { ...out, userId: ids.tech2 })).status, 400, 'the job must be his');
  const booked = await call('stock', 'POST', `/tool-store/${ladder.body.id}/book-out`, out);
  assert.equal(booked.status, 200, JSON.stringify(booked.body)); assert.equal(booked.body.out.jobNumber, job.job_number); assert.equal(booked.body.out.overdue, false);
  assert.equal((await call('stock', 'POST', `/tool-store/${ladder.body.id}/book-out`, { ...out, signaturePhotoId: await sig() })).status, 409, 'already out');
  const mine = (await call('tech', 'GET', '/me/tools')).body;
  assert.equal(mine.length, 1); assert.equal(mine[0].name, 'Step ladder 2.4 m'); assert.equal(mine[0].due, 'when the job is done');
  assert.equal((await call('tech', 'GET', `/jobs/${job.id}`)).body.tools_out[0].name, 'Step ladder 2.4 m', 'on his job card');
  assert.equal((await call('stock', 'PUT' as 'POST', `/tool-store/${ladder.body.id}`, { active: false })).status, 409, 'cannot retire it while out');
  // Sign back: damaged needs a word.
  assert.equal((await call('stock', 'POST', `/tool-store/${ladder.body.id}/return`, { condition: 'damaged', signaturePhotoId: await sig() })).status, 400);
  const back = await call('stock', 'POST', `/tool-store/${ladder.body.id}/return`, { condition: 'damaged', note: 'Bottom rung bent', signaturePhotoId: await sig() });
  assert.equal(back.status, 200); assert.equal(back.body.out, null); assert.equal(back.body.condition, 'damaged');
  assert.equal((await call('tech', 'GET', '/me/tools')).body.length, 0);
  const hist = (await call('stock', 'GET', `/tool-store/${ladder.body.id}/history`)).body;
  assert.equal(hist.length, 1); assert.equal(hist[0].return_condition, 'damaged'); assert.ok(hist[0].out_signature_photo_id && hist[0].return_signature_photo_id);
  await assert.rejects(db.query('UPDATE tool_bookings SET return_note = $1 WHERE id = $2', ['changed', hist[0].id]), 'kept as signed');
  await assert.rejects(db.query('DELETE FROM tool_bookings WHERE id = $1', [hist[0].id]));
  // A picture of how it looks: the tool, and the vehicle's profile picture; everyone can see them.
  const tp = (await upload('stock', '/photos', { kind: 'tool', takenAt: '2026-10-30T08:00:00+02:00' })).body.id;
  assert.equal((await call('stock', 'PUT' as 'POST', `/tool-store/${ladder.body.id}`, { photoId: hist[0].out_signature_photo_id })).status, 409, 'a picture of the tool');
  assert.equal((await call('stock', 'PUT' as 'POST', `/tool-store/${ladder.body.id}`, { photoId: tp })).body.photo_id, tp);
  const veh = (await call('mech', 'GET', '/fleet/barcodes')).body.vehicles[0];
  const vp = (await upload('mech', '/photos', { kind: 'vehicle_profile', takenAt: '2026-10-30T08:00:00+02:00' })).body.id;
  assert.equal((await call('tech', 'POST', `/fleet/vehicles/${veh.id}/photo`, { photoId: vp })).status, 403);
  assert.equal((await call('mech', 'POST', `/fleet/vehicles/${veh.id}/photo`, { photoId: vp })).status, 200);
  assert.equal((await call('mech', 'GET', `/fleet/vehicles/${veh.id}`)).body.vehicle.photo_id, vp, 'on the vehicle');
  assert.equal((await call('tech2', 'GET', `/vehicles/lookup?barcode=${encodeURIComponent(veh.barcode)}`)).body.vehicle.photo_id, vp, 'the technician sees it when he scans');
  assert.equal((await app.inject({ method: 'GET', url: `/photos/${vp}`, headers: { authorization: `Bearer ${tokens.tech2}` } })).statusCode, 200, 'and can open it');
  // The admin prints every sticker: vehicles and tools.
  const all = await call('admin', 'GET', '/barcodes');
  assert.equal(all.status, 200); assert.ok(all.body.vehicles.length >= 1); assert.ok(all.body.tools.some((t: { serial: string }) => t.serial === 'LAD-2401'));
  assert.equal((await call('tech', 'GET', '/barcodes')).status, 403);
});

test('phone menus: the CEO or an admin pins tabs per position; everyone gets their own position\'s choice', async () => {
  assert.deepEqual((await call('stock', 'GET', '/me/phone-menu')).body, { pinned: null, canEdit: false }, 'automatic until chosen');
  assert.equal((await call('stock', 'GET', '/phone-menus')).status, 403, 'not the stock controller');
  assert.equal((await call('manager', 'PUT' as 'POST', '/phone-menus/stockroom', { pinned: ['issue'] })).status, 403, 'not a manager');
  const list = (await call('admin', 'GET', '/phone-menus')).body;
  const ceo = list.positions.find((p: { level: string }) => p.level === 'creator');
  assert.ok(ceo.usual.includes('settings') && ceo.usual.length > 5, 'the CEO has more than five tabs');
  assert.ok(!list.positions.some((p: { level: string }) => p.level === 'technician'), 'technicians have no tab bar');
  const hr = list.positions.find((p: { level: string }) => p.level === 'hr');
  assert.deepEqual(hr.usual, ['departments', 'timesheets', 'people']);
  assert.equal((await call('admin', 'PUT' as 'POST', '/phone-menus/stockroom', { pinned: ['issue', 'nope'] })).status, 400, 'only tabs that position has');
  assert.equal((await call('admin', 'PUT' as 'POST', '/phone-menus/stockroom', { pinned: ['issue', 'issue'] })).status, 400, 'each tab once');
  assert.equal((await call('admin', 'PUT' as 'POST', '/phone-menus/stockroom', { pinned: ['issue', 'receive', 'room', 'order', 'people'] })).status, 400, 'four at most');
  assert.equal((await call('admin', 'PUT' as 'POST', '/phone-menus/technician', { pinned: ['today'] })).status, 400);
  assert.equal((await call('admin', 'PUT' as 'POST', '/phone-menus/stockroom', { pinned: ['people', 'issue'] })).status, 200);
  assert.deepEqual((await call('stock', 'GET', '/me/phone-menu')).body, { pinned: ['people', 'issue'], canEdit: false });
  assert.equal((await call('mech', 'GET', '/me/phone-menu')).body.pinned, null, 'other positions unchanged');
  assert.equal((await call('director', 'PUT' as 'POST', '/phone-menus/stockroom', { pinned: null })).status, 200, 'the CEO puts it back to automatic');
  assert.equal((await call('stock', 'GET', '/me/phone-menu')).body.pinned, null);
});

test('colour theme: the director chooses one of three for the whole company', async () => {
  assert.equal((await call('tech', 'GET', '/company/brand')).body.accent, 'orange', 'orange to start');
  assert.equal((await call('tech', 'GET', '/company/brand')).body.canTheme, false);
  assert.equal((await call('admin', 'PUT' as 'POST', '/company/theme', { accent: 'blue' })).status, 403, 'not the admin');
  assert.equal((await call('hr', 'PUT' as 'POST', '/company/theme', { accent: 'blue' })).status, 403, 'not HR');
  assert.equal((await call('director', 'PUT' as 'POST', '/company/theme', { accent: 'pink' })).status, 400, 'one of the three');
  assert.equal((await call('director', 'PUT' as 'POST', '/company/theme', { accent: 'green' })).status, 200);
  assert.equal((await call('tech', 'GET', '/company/brand')).body.accent, 'green', 'everyone gets it');
  await call('creator', 'PUT' as 'POST', '/company/theme', { accent: 'orange' });
});

test('estimates: prices only from the price list, always marked not official', async () => {
  const J = `/jobs/${ids.job3}`;
  const item = (await call('tech', 'GET', J)).body.items[0].id;
  const body = { at: '2026-10-15T09:00:00+02:00', labourHours: 2, stockLines: [{ stockItemId: ids.seal, qty: 1 }], boughtOutLines: [{ description: 'Element 3kW', qty: 1, estimatedPriceCents: 85000 }] };
  const noPrices = await call('tech', 'POST', `${J}/items/${item}/estimate`, body);
  assert.equal(noPrices.status, 409);
  await db.query("INSERT INTO rates (key, amount_cents, updated_by) VALUES ('labour_per_hour', 55000, $1) ON CONFLICT (company_id, key) DO UPDATE SET amount_cents = 55000", [ids.creator]);
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
  const log = { body: (await call('director', 'GET', '/access/changes')).body.filter((c: { action: string }) => !c.action.startsWith('work:') && !['position', 'fleet_duty', 'stock_duty', 'trade', 'department', 'terminated'].includes(c.action)) };
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

test('own logins: HR adds a person, gives a setup code; he chooses his own password and stays signed in 30 days', async () => {
  // HR adds a technician (not a director: that is the CEO's).
  assert.equal((await call('hr', 'POST', '/people', { fullName: 'Sizwe Dlamini', email: 'sizwe@zsp.test', position: 'director' })).status, 403);
  assert.equal((await call('tech', 'POST', '/people', { fullName: 'Sizwe Dlamini', email: 'sizwe@zsp.test', position: 'technician' })).status, 403, 'not a technician\'s work');
  const add = await call('hr', 'POST', '/people', { fullName: 'Sizwe Dlamini', email: 'Sizwe@zsp.test', position: 'technician', trade: 'electrician', departmentId: ids.dept });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const sizwe = add.body.id as string;
  assert.equal((await call('hr', 'POST', '/people', { fullName: 'Someone Else', email: 'sizwe@zsp.test', position: 'technician' })).status, 409, 'one email, one person');
  const list = (await call('hr', 'GET', '/people')).body;
  assert.equal(list.canAdd, true);
  assert.equal(list.people.find((p: { id: string }) => p.id === sizwe).login, 'none', 'no login yet');
  // Without a password he cannot sign in at all.
  assert.equal((await call('', 'POST', '/auth/login', { email: 'sizwe@zsp.test', password: '!' })).status, 401);

  // The code: shown once, ready to send. Only its hash is kept.
  const code = await call('hr', 'POST', `/people/${sizwe}/login/code`, {});
  assert.equal(code.status, 200, JSON.stringify(code.body));
  assert.match(code.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(code.body.message, /sizwe@zsp\.test/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM login_codes WHERE code_hash = $1', [code.body.code])).rows[0].n, 0, 'not stored as typed');
  assert.equal((await call('hr', 'GET', '/people')).body.people.find((p: { id: string }) => p.id === sizwe).login, 'code');

  // A weak password, a wrong code: refused. The code is case and dash insensitive.
  assert.equal((await call('', 'POST', '/auth/setup', { email: 'sizwe@zsp.test', code: code.body.code, password: 'short' })).status, 400);
  assert.equal((await call('', 'POST', '/auth/setup', { email: 'sizwe@zsp.test', code: code.body.code, password: 'sizwe1234' })).status, 400, 'not his email name');
  assert.equal((await call('', 'POST', '/auth/setup', { email: 'sizwe@zsp.test', code: 'AAAA-AAAA', password: 'Ladder-77-blue' })).status, 401);
  const typed = code.body.code.toLowerCase().replace('-', ' ');
  const set = await call('', 'POST', '/auth/setup', { email: 'SIZWE@zsp.test', code: typed, password: 'Ladder-77-blue', remember: true });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.signedInFor, '30 days');
  const claims = JSON.parse(Buffer.from(set.body.token.split('.')[1], 'base64url').toString());
  assert.ok(claims.exp - claims.iat >= 30 * 86400 - 5, 'signed in for 30 days on his phone');
  assert.equal((await call('', 'POST', '/auth/setup', { email: 'sizwe@zsp.test', code: code.body.code, password: 'Another-88-red' })).status, 401, 'the code works once');
  tokens.sizwe = set.body.token;
  assert.equal((await call('sizwe', 'GET', '/me')).status, 200);
  // Signing in normally: 12 hours unless he keeps it signed in on his own phone.
  const short = await call('', 'POST', '/auth/login', { email: 'sizwe@zsp.test', password: 'Ladder-77-blue' });
  assert.equal(short.status, 200);
  const c2 = JSON.parse(Buffer.from(short.body.token.split('.')[1], 'base64url').toString());
  assert.ok(c2.exp - c2.iat <= 12 * 3600);
  // Nobody in the office knows his password: HR sees the log, not the password.
  const info = (await call('hr', 'GET', `/people/${sizwe}/login`)).body;
  assert.equal(info.state, 'on');
  assert.ok(info.lastSignIn);
  assert.ok(info.history.some((h: { change: string }) => /own password/.test(h.change)));
  assert.equal((await call('hr', 'GET', `/people/${ids.creator}/login`)).body.canManage, false, 'HR does not touch the CEO\'s login');
  assert.equal((await call('hr', 'POST', `/people/${ids.creator}/login/code`, {})).status, 403);
  assert.equal((await call('hr', 'POST', `/people/${ids.hr}/login/stop`, {})).status, 403, 'not your own');
});

test('own logins: wrong passwords lock it; a lost phone is signed out; a stopped login stops at once', async () => {
  const sizwe = (await db.query("SELECT id FROM users WHERE email = 'sizwe@zsp.test'")).rows[0].id;
  for (let i = 0; i < 5; i++) assert.equal((await call('', 'POST', '/auth/login', { email: 'sizwe@zsp.test', password: `wrong-${i}` })).status, 401);
  const locked = await call('', 'POST', '/auth/login', { email: 'sizwe@zsp.test', password: 'Ladder-77-blue' });
  assert.equal(locked.status, 429, 'locked after five wrong passwords, even with the right one');
  assert.match(locked.body.reasons[0], /15 minutes/);
  assert.equal((await call('hr', 'GET', '/people')).body.people.find((p: { id: string }) => p.id === sizwe).login, 'locked', 'HR sees it is locked');
  // A new code unlocks; the old password still works until he uses it.
  const code = (await call('hr', 'POST', `/people/${sizwe}/login/code`, {})).body.code;
  assert.equal((await call('', 'POST', '/auth/login', { email: 'sizwe@zsp.test', password: 'Ladder-77-blue' })).status, 200);
  // A code is cancelled after five wrong tries.
  for (let i = 0; i < 5; i++) await call('', 'POST', '/auth/setup', { email: 'sizwe@zsp.test', code: 'ZZZZ-ZZZZ', password: 'Ladder-77-blue' });
  assert.equal((await call('', 'POST', '/auth/setup', { email: 'sizwe@zsp.test', code, password: 'Ladder-77-blue' })).status, 401);

  // Lost phone: every phone signed in as him is signed out; he signs in again with his password.
  assert.equal((await call('sizwe', 'GET', '/me')).status, 200);
  assert.equal((await call('hr', 'POST', `/people/${sizwe}/login/sign-out`, {})).status, 200);
  assert.equal((await call('sizwe', 'GET', '/me')).status, 401);
  tokens.sizwe = (await call('', 'POST', '/auth/login', { email: 'sizwe@zsp.test', password: 'Ladder-77-blue', remember: true })).body.token;
  assert.equal((await call('sizwe', 'GET', '/me')).status, 200);

  // He changes his password: this phone stays in (a new token), others are out.
  const old = tokens.sizwe;
  assert.equal((await call('sizwe', 'POST', '/me/password', { current: 'nope', password: 'Bucket-42-green' })).status, 403);
  const ch = await call('sizwe', 'POST', '/me/password', { current: 'Ladder-77-blue', password: 'Bucket-42-green' });
  assert.equal(ch.status, 200);
  assert.equal((await call('sizwe', 'GET', '/me')).status, 401, 'the old sign-in is gone');
  tokens.sizwe = ch.body.token;
  assert.equal((await call('sizwe', 'GET', '/me')).status, 200);
  assert.equal(JSON.parse(Buffer.from(ch.body.token.split('.')[1], 'base64url').toString()).r, true, 'still kept signed in on his phone');

  // Stopped: at once, on every phone; the right password is told it is stopped.
  assert.equal((await call('hr', 'POST', `/people/${sizwe}/login/stop`, { reason: 'On suspension' })).status, 200);
  assert.equal((await call('sizwe', 'GET', '/me')).status, 401);
  assert.equal((await call('', 'POST', '/auth/login', { email: 'sizwe@zsp.test', password: 'Bucket-42-green' })).status, 403);
  assert.equal((await call('hr', 'GET', '/people')).body.people.find((p: { id: string }) => p.id === sizwe).login, 'stopped');
  assert.equal((await call('hr', 'POST', `/people/${sizwe}/login/allow`, {})).status, 200);
  assert.equal((await call('', 'POST', '/auth/login', { email: 'sizwe@zsp.test', password: 'Bucket-42-green' })).status, 200);

  // His email changes: he signs in with the new one.
  assert.equal((await call('hr', 'PUT', `/people/${sizwe}/profile`, { email: 'sizwe.d@zsp.test' })).status, 200);
  assert.equal((await call('', 'POST', '/auth/login', { email: 'sizwe@zsp.test', password: 'Bucket-42-green' })).status, 401);
  assert.equal((await call('', 'POST', '/auth/login', { email: 'sizwe.d@zsp.test', password: 'Bucket-42-green' })).status, 200);
  assert.equal((await call('hr', 'PUT', `/people/${sizwe}/profile`, { email: 'creator@zsp.test' })).status, 409, 'someone else\'s sign-in');
  // Someone without an email gets one before a code.
  const noMail = (await call('creator', 'POST', '/people', { fullName: 'Vusi Mkhize', position: 'mechanic' })).body.id;
  assert.equal((await call('creator', 'POST', `/people/${noMail}/login/code`, {})).status, 409);
});

test('the stock controller is out: admin issues stock and tools, and it is noted who did', async () => {
  const job = (await db.query("SELECT id FROM jobs WHERE lead_technician_id = $1 AND status NOT IN ('closed', 'cancelled') LIMIT 1", [ids.tech])).rows[0];
  assert.ok(job, 'the technician has an open job');
  const req = await call('tech', 'POST', `/jobs/${job.id}/stock-out`, { at: NOW, lines: [{ stockItemId: ids.seal, qty: 1 }] });
  assert.ok(req.status < 300, JSON.stringify(req.body));
  const me = (await call('admin', 'GET', '/me')).body;
  assert.equal(me.stockCover, true, 'admin can open the stockroom to stand in');
  assert.equal(me.stockDuty, false);
  const waiting = (await call('admin', 'GET', '/stock/issues')).body;
  const mine = waiting.find((i: { id: string }) => i.id === req.body.id);
  assert.ok(mine, 'admin sees what is waiting');
  const r = await call('admin', 'POST', `/stock/issues/${mine.id}/issue`, { at: NOW, lines: mine.lines.map((l: { lineId: string }) => ({ lineId: l.lineId, qtyIssued: 1 })) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.issuedBy, 'admin (Admin)');
  const reg = (await call('stock', 'GET', '/stock/issues?status=issued')).body.find((i: { id: string }) => i.id === mine.id);
  assert.equal(reg.decided_by, 'admin');
  assert.equal(reg.decidedByStandIn, 'Admin');
  const told = (await db.query("SELECT message FROM notifications WHERE recipient_id = $1 AND kind = 'stockroom_cover' ORDER BY created_at DESC LIMIT 1", [ids.stock])).rows[0];
  assert.match(told.message, /^admin \(Admin\) issued stock to tech/);
  assert.equal((await call('admin', 'POST', '/stock/deliveries', { id: crypto.randomUUID(), at: NOW, supplierName: 'X', reference: 'R1', lines: [] })).status, 403, 'receiving stays with the stockroom');
  // The stock controller's own issues are not "stood in".
  const reg2 = (await call('stock', 'GET', '/stock/issues?status=issued')).body.filter((i: { decided_by: string }) => i.decided_by === 'stock');
  assert.ok(reg2.every((i: { decidedByStandIn: string | null }) => i.decidedByStandIn === null));
});
