// Offline safety. The phone queues requests while there is no signal and replays them later,
// each with an Idempotency-Key header. A replayed key returns the stored answer, so a job is
// never started twice or stock taken off the van twice because a request was sent again.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest { idemKey?: string; idemReplayed?: boolean }
}

const KEY = /^[A-Za-z0-9_-]{8,100}$/;

export function registerSync(app: FastifyInstance) {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'POST' && req.method !== 'PATCH') return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !req.actor) return;
    if (!KEY.test(key)) return reply.code(400).send({ error: 'bad Idempotency-Key' });
    req.idemKey = key;
    const { rows } = await req.db.query(
      'SELECT method, url, status_code, response FROM sync_requests WHERE user_id = $1 AND idem_key = $2',
      [req.actor.id, key],
    );
    const hit = rows[0];
    if (!hit) return;
    if (hit.method !== req.method || hit.url !== req.url) {
      return reply.code(422).send({ error: 'Idempotency-Key already used for a different request' });
    }
    req.idemReplayed = true;
    reply.header('idempotent-replay', 'true').header('content-type', 'application/json; charset=utf-8');
    return reply.code(hit.status_code).send(hit.response);
  });
  // The replay record is written by tenancy.ts once the request's transaction is finished.
}
