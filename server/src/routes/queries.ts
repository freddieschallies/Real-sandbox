// Queries: the office or a technician asks any technician something, at any time. The technician
// answers in the same conversation. Messages cannot be changed or removed.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { audit, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { notify } from './field.ts';

export function registerQueryRoutes(app: FastifyInstance) {
  /** Who may start a query: the office (jobs work) and technicians. */
  const mayAsk = (req: FastifyRequest) => req.actor.level === 'technician' || can(req.actor, 'assign_jobs') || req.actor.level === 'creator';

  /** Technicians a query can go to (everyone who may ask sees the list). */
  app.get('/queries/people', async req => {
    if (!mayAsk(req)) throw new Refused(403, ['you cannot send queries']);
    const { rows } = await req.db.query(
      "SELECT id, full_name FROM users WHERE login_level = 'technician' AND status = 'active' AND id <> $1 ORDER BY full_name", [req.actor.id]);
    return rows;
  });

  app.get('/me/queries', async req => {
    const me = req.actor.id;
    const { rows } = await req.db.query(
      `SELECT q.id, q.subject, q.created_at, q.job_id, j.job_number, q.from_user, f.full_name AS from_name, q.to_user, t.full_name AS to_name,
              CASE WHEN q.from_user = $1 THEN q.from_read_at ELSE q.to_read_at END AS my_read_at,
              (SELECT json_agg(json_build_object('id', m.id, 'from', m.from_user, 'name', u.full_name, 'body', m.body, 'at', m.sent_at) ORDER BY m.sent_at)
                 FROM query_messages m JOIN users u ON u.id = m.from_user WHERE m.query_id = q.id) AS messages
         FROM queries q JOIN users f ON f.id = q.from_user JOIN users t ON t.id = q.to_user LEFT JOIN jobs j ON j.id = q.job_id
        WHERE q.from_user = $1 OR q.to_user = $1
        ORDER BY (SELECT max(sent_at) FROM query_messages m WHERE m.query_id = q.id) DESC LIMIT 200`, [me]);
    const out = rows.map(r => {
      const msgs = (r.messages ?? []) as { from: string; at: string }[];
      const last = msgs.at(-1);
      const readAt = r.my_read_at ? new Date(r.my_read_at).getTime() : null;
      const unread = msgs.filter(m => m.from !== me && (readAt == null || Date.parse(m.at) > readAt)).length;
      return { ...r, unread, waitingForAnswer: last?.from === me, lastAt: last?.at ?? r.created_at };
    });
    return { queries: out, unread: out.reduce((n, q) => n + q.unread, 0) };
  });

  app.post('/queries', async (req, reply) => {
    if (!mayAsk(req)) throw new Refused(403, ['you cannot send queries']);
    const b = parse(z.object({ id: Uuid.optional(), toUserId: Uuid, jobId: Uuid.optional(), subject: z.string().trim().min(3, 'what it is about').max(200), body: z.string().trim().min(2, 'the question').max(4000) }), req.body);
    const me = req.actor.id;
    if (b.toUserId === me) throw new Refused(400, ['you cannot send a query to yourself']);
    const out = await tx(req.db, async c => {
      const t = (await c.query("SELECT full_name FROM users WHERE id = $1 AND login_level = 'technician' AND status = 'active'", [b.toUserId])).rows[0];
      if (!t) throw new Refused(400, ['queries go to an active technician']);
      let jobNumber: number | null = null;
      if (b.jobId) {
        const j = (await c.query('SELECT job_number FROM jobs WHERE id = $1', [b.jobId])).rows[0];
        if (!j) throw new Refused(400, ['unknown job']);
        jobNumber = j.job_number;
      }
      const id = b.id ?? randomUUID();
      await c.query('INSERT INTO queries (id, from_user, to_user, job_id, subject, from_read_at) VALUES ($1, $2, $3, $4, $5, now())', [id, me, b.toUserId, b.jobId ?? null, b.subject]);
      await c.query('INSERT INTO query_messages (query_id, from_user, body) VALUES ($1, $2, $3)', [id, me, b.body]);
      const from = (await c.query('SELECT full_name FROM users WHERE id = $1', [me])).rows[0].full_name;
      await notify(c, b.toUserId, 'query', `Query from ${from}${jobNumber ? ` (job ${jobNumber})` : ''}: ${b.subject}`, { queryId: id });
      await audit(c, me, 'query_sent', 'query', id, { to: b.toUserId, jobId: b.jobId ?? null });
      return { id };
    });
    return reply.code(201).send(out);
  });

  app.post('/queries/:id/messages', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ body: z.string().trim().min(1, 'the answer').max(4000) }), req.body);
    const me = req.actor.id;
    const out = await tx(req.db, async c => {
      const q = (await c.query('SELECT from_user, to_user, subject FROM queries WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!q) throw new Refused(404, ['no such query']);
      if (q.from_user !== me && q.to_user !== me) throw new Refused(403, ['not your query']);
      await c.query('INSERT INTO query_messages (query_id, from_user, body) VALUES ($1, $2, $3)', [id, me, b.body]);
      await c.query(`UPDATE queries SET ${q.from_user === me ? 'from_read_at' : 'to_read_at'} = now() WHERE id = $1`, [id]);
      const other = q.from_user === me ? q.to_user : q.from_user;
      const name = (await c.query('SELECT full_name FROM users WHERE id = $1', [me])).rows[0].full_name;
      await notify(c, other, 'query', `${name} answered: ${q.subject}`, { queryId: id });
      return { id };
    });
    return reply.code(201).send(out);
  });

  app.post('/queries/:id/read', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const me = req.actor.id;
    const r = await req.db.query(
      `UPDATE queries SET from_read_at = CASE WHEN from_user = $2 THEN now() ELSE from_read_at END,
                          to_read_at = CASE WHEN to_user = $2 THEN now() ELSE to_read_at END
        WHERE id = $1 AND (from_user = $2 OR to_user = $2) RETURNING id`, [id, me]);
    if (!r.rowCount) throw new Refused(404, ['no such query']);
    return { id };
  });
}
