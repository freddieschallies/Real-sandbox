// One company per request. After sign-in, the request gets its own database connection with
// app.company_id set, so row-level security only shows that company's rows. The whole request
// is one transaction: it commits only if the answer is a success, otherwise nothing is kept.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Client, Db, Q } from './db.ts';

declare module 'fastify' {
  interface FastifyRequest { db: Q; companyId: string; pgClient?: Client; keepIfRefused?: ((c: Q) => Promise<void>)[] }
}

/**
 * A record that must be kept even though the request is refused and everything else is undone,
 * e.g. the flag raised when someone tries to book an invoice that was already booked.
 */
export function keepIfRefused(req: FastifyRequest, fn: (c: Q) => Promise<void>) {
  (req.keepIfRefused ??= []).push(fn);
}

/** Opens the company-scoped connection for this request. */
export async function openCompanyConnection(db: Db, req: FastifyRequest, companyId: string) {
  const c = await db.connect();
  req.pgClient = c;
  await c.query("SELECT set_config('app.company_id', $1, false)", [companyId]);
  await c.query('BEGIN');
  req.db = c;
  req.companyId = companyId;
}

export function registerTenancy(app: FastifyInstance) {
  app.decorateRequest('db', null as unknown as Q);
  app.decorateRequest('companyId', '');

  // Finish the transaction before the answer leaves, then keep the offline-replay record.
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const c = req.pgClient;
    if (!c) return payload;
    const ok = reply.statusCode < 400;
    await c.query(ok ? 'COMMIT' : 'ROLLBACK');
    if (!ok && req.keepIfRefused?.length) {
      await c.query('BEGIN');
      for (const fn of req.keepIfRefused) await fn(c);
      await c.query('COMMIT');
    }
    if (req.idemKey && !req.idemReplayed && reply.statusCode < 500 && typeof payload === 'string') {
      await c.query(
        `INSERT INTO sync_requests (user_id, idem_key, method, url, status_code, response)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [req.actor.id, req.idemKey, req.method, req.url, reply.statusCode, payload],
      );
    }
    return payload;
  });

  const release = async (req: FastifyRequest) => {
    const c = req.pgClient;
    if (!c) return;
    req.pgClient = undefined;
    try {
      await c.query('ROLLBACK').catch(() => {});
      await c.query('RESET app.company_id');
      await c.query('RESET app.user_id');
      c.release();
    } catch (e) {
      c.release(e as Error);
    }
  };
  app.addHook('onResponse', release);
  app.addHook('onRequestAbort', release);
}
