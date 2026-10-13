// The platform owner (the business selling the app) manages companies: create one with its
// first Creator login, list them, suspend or reactivate them. It never sees company data:
// these routes only touch the companies, logins and platform tables, which hold none.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { hashPassword } from '../auth.ts';
import { STANDARD_DEPARTMENTS } from '../core/departments.ts';

export async function createCompany(db: Db, name: string, creator: { name: string; email: string; password: string }) {
  const email = creator.email.toLowerCase();
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    if ((await c.query('SELECT 1 FROM logins WHERE email = $1', [email])).rowCount) throw new Refused(409, ['that email already has a login']);
    if ((await c.query('SELECT 1 FROM companies WHERE lower(name) = lower($1)', [name])).rowCount) throw new Refused(409, ['a company with that name exists']);
    const companyId = (await c.query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
    await c.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
    const userId = (await c.query(
      "INSERT INTO users (full_name, email, login_level, password_hash) VALUES ($1, $2, 'creator', $3) RETURNING id",
      [creator.name, email, await hashPassword(creator.password)],
    )).rows[0].id;
    await c.query('INSERT INTO logins (email, user_id, company_id) VALUES ($1, $2, $3)', [email, userId, companyId]);
    // The usual departments to start with; HR or the CEO switches off what the business doesn't do.
    for (const d of STANDARD_DEPARTMENTS.filter(x => x.startsOn)) await c.query('INSERT INTO departments (name, parts_report) VALUES ($1, $2)', [d.name, !!d.partsReport]);
    await c.query("INSERT INTO audit_log (action, entity, entity_id, details) VALUES ('company_created', 'company', $1, $2)", [companyId, JSON.stringify({ name })]);
    await c.query('COMMIT');
    return { companyId, creatorUserId: userId };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export function registerPlatformRoutes(app: FastifyInstance, db: Db) {
  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'not signed in' });
    }
    if (!req.user.platform) return reply.code(403).send({ error: 'platform owners only' });
    const { rows } = await db.query('SELECT login_enabled FROM platform_admins WHERE id = $1', [req.user.sub]);
    if (!rows[0]?.login_enabled) return reply.code(401).send({ error: 'login disabled' });
  };

  app.post('/platform/login', async (req, reply) => {
    const b = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const u = (await db.query('SELECT id, password_hash, login_enabled, full_name FROM platform_admins WHERE email = lower($1)', [b.email])).rows[0];
    if (!u || !u.login_enabled || !(await bcrypt.compare(b.password, u.password_hash))) return reply.code(401).send({ error: 'wrong email or password' });
    return { token: app.jwt.sign({ sub: u.id, platform: true }, { expiresIn: '8h' }), name: u.full_name };
  });

  app.get('/platform/companies', { preHandler: guard }, async () => {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.active, c.created_at, c.suspended_at, c.suspended_reason,
              (SELECT count(*)::int FROM logins l WHERE l.company_id = c.id) AS logins
         FROM companies c ORDER BY c.name`,
    );
    return rows;
  });

  app.post('/platform/companies', { preHandler: guard }, async (req, reply) => {
    const b = parse(z.object({
      name: z.string().trim().min(2).max(200),
      creator: z.object({ name: z.string().trim().min(2), email: z.string().email(), password: z.string().min(10, 'password must be at least 10 characters') }),
    }), req.body);
    return reply.code(201).send(await createCompany(db, b.name, b.creator));
  });

  app.patch('/platform/companies/:id', { preHandler: guard }, async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ active: z.boolean(), reason: z.string().trim().max(500).optional() }), req.body);
    if (!b.active && !b.reason) throw new Refused(400, ['give a reason for suspending']);
    const { rows } = await db.query(
      `UPDATE companies SET active = $2, suspended_at = CASE WHEN $2 THEN NULL ELSE now() END,
              suspended_reason = CASE WHEN $2 THEN NULL ELSE $3 END
        WHERE id = $1 RETURNING id, name, active`,
      [id, b.active, b.reason ?? null],
    );
    if (!rows[0]) throw new Refused(404, ['no such company']);
    return rows[0];
  });
}
