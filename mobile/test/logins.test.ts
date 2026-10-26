// The test drive's own logins follow the same rules as the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoLogins, type DemoLoginsState } from '../src/demoLogins.ts';

const people = [
  { id: 'p-1', full_name: 'Sizwe Dlamini', login_level: 'technician', email: 'sizwe@example.com', phone: '072 555 0199' },
  { id: 'office', full_name: 'The CEO', login_level: 'creator', email: 'ceo@example.com', phone: null },
];

test('setup code, own password, lock after five wrong, stop and allow', () => {
  const s: DemoLoginsState = { logins: {}, codes: {}, log: [] };
  const L = new DemoLogins(s, () => people);
  assert.equal(L.state('p-1'), 'none');
  // Logins are looked after by the Admin and the CEO (not HR).
  const hr = { id: 'ad-1', level: 'admin', ceo: false };
  assert.equal(L.manages(hr, people[0]), true);
  assert.equal(L.manages(hr, people[1]), false, "the CEO's login is not the Admin's");
  assert.equal(L.manages({ id: 'hr-1', level: 'hr', ceo: false }, people[0]), false, 'HR does not give setup codes');
  const r = L.issueCode('p-1', 'Precious', 'ZSP');
  assert.ok(r.ok);
  const code = (r.body as { code: string }).code;
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(L.state('p-1'), 'code');
  assert.ok(!JSON.stringify(s).includes(code), 'the code is not kept as typed');
  assert.equal(L.setup('sizwe@example.com', code, 'short').ok, false);
  assert.equal(L.setup('sizwe@example.com', 'AAAA-AAAA', 'Ladder-77-blue').ok, false);
  assert.ok(L.setup('SIZWE@example.com', code.toLowerCase().replace('-', ' '), 'Ladder-77-blue').ok);
  assert.equal(L.setup('sizwe@example.com', code, 'Ladder-77-blue').ok, false, 'works once');
  assert.ok(L.login('sizwe@example.com', 'Ladder-77-blue').ok);
  for (let i = 0; i < 5; i++) assert.equal(L.login('sizwe@example.com', 'nope').ok, false);
  const locked = L.login('sizwe@example.com', 'Ladder-77-blue');
  assert.equal(locked.ok, false);
  assert.equal(!locked.ok && locked.status, 429);
  L.stop('p-1', 'Precious');
  assert.equal(L.state('p-1'), 'stopped');
  L.allow('p-1', 'Precious');
  assert.ok(L.login('sizwe@example.com', 'Ladder-77-blue').ok, 'allowing again also unlocks');
  assert.ok(L.change('p-1', 'Sizwe', 'sizwe@example.com', 'Ladder-77-blue', 'Bucket-42-green').ok);
  assert.ok(L.login('sizwe@example.com', 'Bucket-42-green').ok);
  assert.ok(L.info('p-1', true, false, false).history.some(h => /own password/.test(h.change)));
});
