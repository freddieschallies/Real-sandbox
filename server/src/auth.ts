import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { Db } from './db.ts';
import { audit } from './db.ts';
import type { Actor, LoginLevel } from './core/permissions.ts';

declare module 'fastify' {
  interface FastifyRequest { actor: Actor }
}
declare module '@fastify/jwt' {
  interface FastifyJWT { payload: { sub: string }; user: { sub: string } }
}

/** Loads the actor fresh from the database on every request, so a disabled login stops working at once. */
export async function loadActor(db: Db, userId: string): Promise<Actor | null> {
  const { rows } = await db.query(
    `SELECT u.id, u.login_level, u.department_id, u.login_enabled,
            COALESCE(array_agg(p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}') AS extra
       FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id`,
    [userId],
  );
  const r = rows[0];
  if (!r || !r.login_enabled) return null;
  return { id: r.id, level: r.login_level as LoginLevel, departmentId: r.department_id, extra: r.extra };
}

export async function hasAcknowledgedPolicy(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM policy_acknowledgements a
        WHERE a.user_id = $1
          AND a.policy_version_id = (SELECT id FROM policy_versions ORDER BY published_at DESC LIMIT 1)
     ) AS ok`,
    [userId],
  );
  return rows[0].ok;
}

const PUBLIC = new Set(['/health', '/auth/login']);
const BEFORE_POLICY = new Set(['/me', '/policy/current', '/policy/acknowledge']);

export function registerAuth(app: FastifyInstance, db: Db) {
  app.decorateRequest('actor', null as unknown as Actor);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.routeOptions.url ?? req.url;
    if (PUBLIC.has(path)) return;
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'not signed in' });
    }
    const actor = await loadActor(db, req.user.sub);
    if (!actor) return reply.code(401).send({ error: 'login disabled' });
    req.actor = actor;
    // Nobody uses the app until they have acknowledged the current monitoring policy.
    if (!BEFORE_POLICY.has(path) && !(await hasAcknowledgedPolicy(db, actor.id))) {
      return reply.code(403).send({ error: 'acknowledge the monitoring policy first', code: 'policy_required' });
    }
  });

  const Login = z.object({ email: z.string().email(), password: z.string().min(1) });

  app.post('/auth/login', async (req, reply) => {
    const body = Login.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'email and password required' });
    const { rows } = await db.query(
      'SELECT id, password_hash, login_enabled, full_name, login_level FROM users WHERE lower(email) = lower($1)',
      [body.data.email],
    );
    const u = rows[0];
    const ok = u && u.login_enabled && (await bcrypt.compare(body.data.password, u.password_hash));
    if (!ok) return reply.code(401).send({ error: 'wrong email or password' });
    await audit(db, u.id, 'login', 'user', u.id);
    const token = app.jwt.sign({ sub: u.id }, { expiresIn: '12h' });
    return { token, user: { id: u.id, name: u.full_name, level: u.login_level } };
  });

  app.get('/me', async req => {
    const { rows } = await db.query('SELECT id, full_name, email, login_level, department_id FROM users WHERE id = $1', [req.actor.id]);
    return { ...rows[0], policyAcknowledged: await hasAcknowledgedPolicy(db, req.actor.id) };
  });

  app.get('/policy/current', async (_req, reply) => {
    const { rows } = await db.query('SELECT id, version, body, published_at FROM policy_versions ORDER BY published_at DESC LIMIT 1');
    if (!rows[0]) return reply.code(404).send({ error: 'no policy published' });
    return rows[0];
  });

  app.post('/policy/acknowledge', async (req, reply) => {
    const v = z.object({ policyVersionId: z.string().uuid() }).safeParse(req.body);
    if (!v.success) return reply.code(400).send({ error: 'policyVersionId required' });
    const { rows } = await db.query('SELECT id FROM policy_versions ORDER BY published_at DESC LIMIT 1');
    if (rows[0]?.id !== v.data.policyVersionId) return reply.code(409).send({ error: 'that is not the current policy version' });
    await db.query(
      'INSERT INTO policy_acknowledgements (user_id, policy_version_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.actor.id, v.data.policyVersionId],
    );
    await audit(db, req.actor.id, 'policy_acknowledged', 'policy_version', v.data.policyVersionId);
    return { ok: true };
  });
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
