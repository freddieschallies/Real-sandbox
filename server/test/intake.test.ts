// Reading breakdown emails: the MIME reader, the rules that find the store, fault and call log
// number, and the IMAP client against a pretend Gmail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, newPart, parseAddress, parseMail, decodeWords } from '../src/mime.ts';
import { findCallRef, groupLine, guessStore, readByRules, type StoreRef } from '../src/core/breakdownRead.ts';
import { Imap } from '../src/imap.ts';
import { callCentreMail, fakeImap } from './fakeImap.ts';

process.env.JWT_SECRET ??= 'x'.repeat(40);
const { sealSecret, openSecret } = await import('../src/intake.ts');

const STORES: StoreRef[] = [
  { id: 's1', name: 'Spar Arboretum', client: 'Spar' },
  { id: 's2', name: 'SuperSpar Meerensee', client: 'Spar' },
  { id: 's3', name: 'FreshMart Meerensee', client: 'FreshMart' },
  { id: 's4', name: 'Boxer Esikhawini', client: 'Boxer' },
];

test('an email: encoded subject, sender, text from quoted-printable, the picture attached', () => {
  const raw = callCentreMail({ id: 'abc@cc.test', from: '"Call Centre – Spar" <calls@cc.test>', subject: 'Call logged – Ref 784512 – café', text: 'Store: Spar Arboretum\nFault: Ice machine not making ice\nLog no: CC784512 (café)', picture: true });
  const m = parseMail(Buffer.from(raw));
  assert.equal(m.messageId, 'abc@cc.test');
  assert.deepEqual(m.from, { name: 'Call Centre – Spar', address: 'calls@cc.test' });
  assert.equal(m.subject, 'Call logged – Ref 784512 – café');
  assert.match(m.text, /Ice machine not making ice/);
  assert.match(m.text, /café/);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, 'fault.jpg');
  assert.equal(m.attachments[0].data[0], 0xff);
});

test('HTML only, quoted replies dropped, addresses and encoded words', () => {
  assert.equal(htmlToText('<style>p{}</style><p>Hello&nbsp;there</p><div>Fridge&amp;freezer</div>'), 'Hello there\nFridge&freezer');
  assert.equal(newPart('Still not fixed!\n\nOn Mon, 12 Oct 2026 at 09:00 Jane <j@x.co.za> wrote:\n> old text'), 'Still not fixed!');
  assert.deepEqual(parseAddress('jane@x.co.za'), { name: null, address: 'jane@x.co.za' });
  assert.equal(decodeWords('=?iso-8859-1?Q?Caf=E9_Spar?='), 'Café Spar');
});

test('the rules: breakdown or not, the store, the call log number, urgent', () => {
  const r = readByRules('Call logged', 'Good morning\nPlease attend: Spar Arboretum cold room not cooling, stock at risk.\nCall ref: CC-784512', STORES);
  assert.equal(r.kind, 'breakdown');
  assert.equal(r.storeId, 's1');
  assert.equal(r.callRef, 'CC-784512');
  assert.equal(r.urgent, true);
  assert.match(r.fault ?? '', /cold room not cooling/);
  assert.equal(readByRules('Statement September', 'Please find your statement attached. Remittance to follow.', STORES).kind, 'other');
  assert.equal(readByRules('Quote please', 'Can we get a quotation for a new ice machine?', STORES).kind, 'inquiry');
  assert.equal(findCallRef('Please call me on 072 555 0106'), null, 'a phone number is not a log number');
  assert.equal(findCallRef('Log No. 55123'), '55123');
  assert.equal(findCallRef('Ticket #INC0012345'), 'INC0012345');
  // Two Meerensee stores: the client decides; unclear stays unknown.
  assert.equal(guessStore('FreshMart Meerensee oven', STORES).store?.id, 's3');
  assert.equal(guessStore('the oven at Meerensee', STORES).store, null);
  assert.equal(guessStore('SuperSpar Meerensee: fridge warm', [...STORES, { id: 's5', name: 'Meerensee Demo Spar', client: 'Spar' }]).store?.id, 's2', 'the whole name wins over a shared suburb');
  assert.equal(readByRules('Call logged', 'Please attend to the following call.\nStore: Spar Arboretum\nFault: Ice machine not making ice', STORES).fault, 'Ice machine not making ice');
  assert.equal(readByRules('', 'Boxer Esikhawini: combi oven not heating', STORES).fault, 'Combi oven not heating');
  assert.match(groupLine({ kind: 'new', via: 'email', store: 'Spar Arboretum', fault: 'Cold room not cooling', callRef: 'CC-784512', urgent: true }), /URGENT.*\nSpar Arboretum\nCold room not cooling · Call log CC-784512/);
});

test('app passwords are kept scrambled', () => {
  const s = sealSecret('abcd efgh ijkl mnop');
  assert.ok(!s.includes('abcd'));
  assert.equal(openSecret(s), 'abcd efgh ijkl mnop');
});

test('IMAP: wrong password refused; new emails found and fetched without marking them read', async () => {
  const box = { user: 'breakdowns@zsp.test', pass: 'apppassword1234', uidValidity: 7, logins: 0, fetched: [] as number[], mails: [
    { uid: 10, date: new Date(Date.now() - 3 * 86_400_000), raw: callCentreMail({ id: 'old@x', from: 'a@b.c', subject: 'old', text: 'old' }) },
    { uid: 11, date: new Date(), raw: callCentreMail({ id: 'new@x', from: 'a@b.c', subject: 'Breakdown', text: 'Oven not heating', picture: true }) },
  ] };
  const srv = await fakeImap(box);
  try {
    const bad = new Imap({ host: '127.0.0.1', port: srv.port, secure: false, user: box.user, pass: 'nope' });
    await assert.rejects(bad.connect(), /refused the email address or app password/);
    await bad.logout();
    const imap = new Imap({ host: '127.0.0.1', port: srv.port, secure: false, user: box.user, pass: box.pass });
    await imap.connect();
    const inbox = await imap.openInbox();
    assert.deepEqual(inbox, { uidValidity: 7, uidNext: 12 });
    assert.deepEqual(await imap.newUids(null, new Date(Date.now() - 86_400_000)), [11], 'first time: only the last day');
    assert.deepEqual(await imap.newUids(11, new Date()), [], 'nothing after the last one read');
    const raw = await imap.fetch(11);
    assert.ok(raw);
    assert.equal(parseMail(raw!).attachments.length, 1);
    await imap.logout();
  } finally { await srv.close(); }
});
