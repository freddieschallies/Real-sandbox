import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outbox } from '../src/outbox.ts';
import { Offline, type Request, type Response, type Transport } from '../src/transport.ts';

class Fake implements Transport {
  offline = false; seen: Request[] = []; refuse = new Set<string>();
  async send(r: Request): Promise<Response> {
    if (this.offline) throw new Offline('x');
    this.seen.push(r);
    return this.refuse.has(r.path) ? { status: 409, body: { reasons: ['nope'] } } : { status: 200, body: {} };
  }
}
const make = () => { const t = new Fake(); let saved: any = null; const o = new Outbox(() => t, () => 'tok', s => { saved = s; }); return { t, o, saved: () => saved }; };

test('keeps work while offline and sends it in order later, once each', async () => {
  const { t, o, saved } = make();
  t.offline = true;
  o.add({ id: 'a', label: 'go', method: 'POST', path: '/jobs/1/go', jobId: '1' });
  o.add({ id: 'b', label: 'arrive', method: 'POST', path: '/jobs/1/arrive', jobId: '1' });
  assert.equal(await o.flush(), 'offline');
  assert.equal(saved().entries.length, 2);
  t.offline = false;
  assert.equal(await o.flush(), 'done');
  assert.deepEqual(t.seen.map(r => [r.path, r.idemKey]), [['/jobs/1/go', 'a'], ['/jobs/1/arrive', 'b']]);
  assert.equal(o.waiting, 0);
});

test('a refusal stops the queue; discarding drops later changes on the same job only', async () => {
  const { t, o } = make();
  t.refuse.add('/jobs/1/arrive');
  o.add({ id: 'a', label: 'arrive', method: 'POST', path: '/jobs/1/arrive', jobId: '1' });
  o.add({ id: 'b', label: 'start', method: 'POST', path: '/jobs/1/start', jobId: '1' });
  o.add({ id: 'c', label: 'fuel', method: 'POST', path: '/fuel' });
  assert.equal(await o.flush(), 'blocked');
  assert.deepEqual(o.blocked?.reasons, ['nope']);
  assert.equal(await o.flush(), 'blocked');
  const gone = o.discardBlocked();
  assert.deepEqual(gone.map(e => e.id), ['a', 'b']);
  assert.equal(await o.flush(), 'done');
  assert.equal(t.seen.at(-1)?.path, '/fuel');
});
