// Integration tests: real HTTP requests against a fresh test database.
// Needs TEST_DATABASE_ADMIN_URL (a server where the test database can be dropped and re-created).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@localhost:5433/postgres?host=/tmp';
const TEST_DB = 'realsandbox_test';
const TEST_URL = ADMIN_URL.replace(/\/postgres(\?|$)/, `/${TEST_DB}$1`);
const PW = 'test-password-123';

let db: pg.Pool;
let app: FastifyInstance;
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};

const NOW = '2026-10-12T07:00:00+02:00';
const at = (h: number, m = 0) => `2026-10-12T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+02:00`;
const STORE = { lat: -28.7807, lng: 32.0383 };
const SAFE = { areaSafe: true, isolated: true, publicClear: true };

async function call(who: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: object) {
  const res = await app.inject({ method, url, payload: body, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} });
  return { status: res.statusCode, body: res.json() };
}

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  db = new pg.Pool({ connectionString: TEST_URL });
  await db.query(readFileSync(new URL('../db/001_init.sql', import.meta.url), 'utf8'));

  const hash = await hashPassword(PW);
  const q = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rows[0];
  ids.dept = (await q("INSERT INTO departments (name) VALUES ('Refrigeration') RETURNING id", [])).id;
  const user = async (key: string, level: string) => {
    ids[key] = (await q('INSERT INTO users (full_name, email, login_level, department_id, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [key, `${key}@zsp.test`, level, ids.dept, hash])).id;
  };
  await user('creator', 'creator');
  await user('admin', 'admin');
  await user('manager', 'management');
  await user('tech', 'technician');
  await user('tech2', 'technician');
  ids.client = (await q("INSERT INTO clients (name) VALUES ('FreshMart') RETURNING id", [])).id;
  ids.store = (await q("INSERT INTO stores (client_id, name, lat, lng) VALUES ($1, 'FreshMart Meerensee', $2, $3) RETURNING id", [ids.client, STORE.lat, STORE.lng])).id;
  ids.equipment = (await q("INSERT INTO equipment (store_id, brand, model, description) VALUES ($1, 'Scotsman', 'AC 86', 'Ice machine') RETURNING id", [ids.store])).id;
  ids.seal = (await q("INSERT INTO stock_items (code, description) VALUES ('VALVE-01', 'Water inlet valve') RETURNING id", [])).id;
  await db.query("INSERT INTO stock_movements (stock_item_id, qty, kind, to_stockroom, created_by) VALUES ($1, 10, 'receive', true, $2)", [ids.seal, ids.admin]);
  await db.query("INSERT INTO stock_movements (stock_item_id, qty, kind, from_stockroom, to_technician_id, created_by) VALUES ($1, 2, 'assign', true, $2, $3)", [ids.seal, ids.tech, ids.admin]);
  ids.policy = (await q("INSERT INTO policy_versions (version, body) VALUES ('1.0', 'Vehicle and App Monitoring Policy') RETURNING id", [])).id;

  app = await buildApp(db, { jwtSecret: 'x'.repeat(40) });
});

after(async () => {
  await app?.close();
  await db?.end();
});

test('login: wrong password refused, right password gives a token', async () => {
  assert.equal((await call('', 'POST', '/auth/login', { email: 'tech@zsp.test', password: 'nope' })).status, 401);
  for (const who of ['creator', 'admin', 'manager', 'tech', 'tech2']) {
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
  for (const who of ['creator', 'admin', 'manager', 'tech', 'tech2']) {
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
  await call('tech', 'POST', `${J}/items/${reported.id}/photos`, { kind: 'before', takenAt: at(7, 40) });
  await call('tech', 'PATCH', `${J}/items/${reported.id}`, {
    equipmentId: ids.equipment, faultType: 'refrigeration',
    found: 'Water inlet valve blocked with scale', did: 'Replaced the inlet valve and flushed the line',
    tested: 'yes', outcome: 'complete',
  });
  const tooMany = await call('tech', 'POST', `${J}/items/${reported.id}/materials`, { stockItemId: ids.seal, qty: 5 });
  assert.equal(tooMany.status, 409, 'cannot use more than is in the van');
  assert.equal((await call('tech', 'POST', `${J}/items/${reported.id}/materials`, { stockItemId: ids.seal, qty: 1 })).status, 200);
  const after1 = await call('tech', 'POST', `${J}/items/${reported.id}/photos`, { kind: 'after', takenAt: at(8, 30) });
  assert.equal(after1.body.items[0].status, 'finished');

  // Work item 2: needs a quote
  await call('tech', 'POST', `${J}/items/${found.id}/photos`, { kind: 'before', takenAt: at(8, 35) });
  await call('tech', 'POST', `${J}/items/${found.id}/photos`, { kind: 'after', takenAt: at(8, 50) });
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
  await call('tech', 'POST', `${J}/items/${item}/photos`, { kind: 'before', takenAt: '2026-10-14T07:30:00+02:00' });
  await call('tech', 'POST', `${J}/items/${item}/photos`, { kind: 'after', takenAt: '2026-10-14T09:00:00+02:00' });
  await call('tech', 'PATCH', `${J}/items/${item}`, {
    equipmentId: ids.equipment, faultType: 'refrigeration', noMaterials: true,
    found: 'Compressor seized after the oil ran low', did: 'Fitted the new compressor, regassed and tested the cold room',
    tested: 'yes', outcome: 'complete',
  });
  await call('tech', 'POST', `${J}/done`, { at: '2026-10-14T09:10:00+02:00' });
  const closed = await call('tech', 'POST', `${J}/close`, { at: '2026-10-14T09:15:00+02:00', signOff: { signature: true, managerName: 'Sipho', signedAt: '2026-10-14T09:14:00+02:00' } });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.visits.length, 2);
  assert.equal(closed.body.manager_name, 'Sipho');
});

test('a disabled login stops working immediately', async () => {
  await db.query('UPDATE users SET login_enabled = false WHERE id = $1', [ids.tech2]);
  assert.equal((await call('tech2', 'GET', '/jobs')).status, 401);
});
