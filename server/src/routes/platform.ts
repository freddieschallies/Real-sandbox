// The platform owner (the business selling the app) manages companies: create one with its
// first Creator login, list them, suspend or reactivate them. It never sees company data: the
// dashboard shows counts and yes/no only. The one way in is tech support, when the company's CEO
// allows it for a set time (routes/support.ts); everything support does is in the company's history.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { hashPassword, loadActor } from '../auth.ts';
import { STANDARD_DEPARTMENTS } from '../core/departments.ts';
import { audit, inCompany, type Q } from '../db.ts';
import { notify } from './field.ts';
import { issueCode } from './logins.ts';
import { setupOf } from './setup.ts';
import { openGrant, supportLogin } from './support.ts';
import { backupStatus, cloudShare, storageOf } from '../storage.ts';
import { PlanBody, registerOwnerBillingRoutes } from './billing.ts';

/**
 * How a company is getting on, as counts and yes/no only: never its customers, jobs, prices or people's details.
 * The CEO's name and email are there so the owner can give them a new setup code when they are locked out.
 */
async function healthOf(c: Q, companyId: string) {
  const n = async (sql: string) => Number((await c.query(sql)).rows[0]?.n ?? 0);
  const setup = await setupOf(c, companyId);
  const wa = (await c.query('SELECT mode, state FROM whatsapp_link')).rows[0];
  const pastel = (await c.query('SELECT setup_done_at FROM pastel_settings')).rows[0];
  const ceo = (await c.query(
    `SELECT id, full_name, email, password_hash LIKE '$2%' AS has_password, login_enabled, locked_until > now() AS locked, last_login_at
       FROM users WHERE login_level = 'creator' AND status <> 'left' AND support_owner IS NULL ORDER BY created_at LIMIT 1`)).rows[0];
  const g = await openGrant(c);
  return {
    people: await n("SELECT count(*)::int AS n FROM users WHERE status <> 'left' AND support_owner IS NULL"),
    activeWeek: await n("SELECT count(*)::int AS n FROM users WHERE last_login_at > now() - interval '7 days' AND support_owner IS NULL"),
    jobsMonth: await n("SELECT count(*)::int AS n FROM jobs WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg'"),
    lastActivity: (await c.query('SELECT max(at) AS at FROM audit_log')).rows[0]?.at ?? null,
    setup: { done: setup.done, total: setup.total },
    whatsapp: wa ? { mode: wa.mode ?? 'phone', connected: wa.state === 'connected' } : null,
    pastel: !!pastel?.setup_done_at,
    ceo: ceo ? { id: ceo.id, name: ceo.full_name, email: ceo.email, login: !ceo.login_enabled || !ceo.has_password ? 'none' : ceo.locked ? 'locked' : 'on', lastLogin: ceo.last_login_at } : null,
    support: g ? { until: g.until, grantedBy: g.granted_by, reason: g.reason, enteredAt: g.entered_at } : null,
  };
}

export async function createCompany(db: Db, name: string, creator: { name: string; email: string; password?: string }) {
  const email = creator.email.toLowerCase();
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    if ((await c.query('SELECT 1 FROM logins WHERE email = $1', [email])).rowCount) throw new Refused(409, ['that email already has a login']);
    if ((await c.query('SELECT 1 FROM companies WHERE lower(name) = lower($1)', [name])).rowCount) throw new Refused(409, ['a company with that name exists']);
    const companyId = (await c.query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
    await c.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
    // Without a password the CEO chooses their own with a setup code from the owner (the usual way).
    const userId = (await c.query(
      creator.password ? "INSERT INTO users (full_name, email, login_level, password_hash, password_set_at) VALUES ($1, $2, 'creator', $3, now()) RETURNING id"
        : "INSERT INTO users (full_name, email, login_level, password_hash, login_enabled) VALUES ($1, $2, 'creator', $3, false) RETURNING id",
      [creator.name, email, creator.password ? await hashPassword(creator.password) : '!'],
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
    const { rows } = await db.query('SELECT login_enabled, full_name FROM platform_admins WHERE id = $1', [req.user.sub]);
    if (!rows[0]?.login_enabled) return reply.code(401).send({ error: 'login disabled' });
    owners.set(req, { id: req.user.sub, name: rows[0].full_name });
  };
  const owners = new WeakMap<FastifyRequest, { id: string; name: string }>();
  const ownerOf = (req: FastifyRequest) => owners.get(req)!;
  const companyName = async (id: string) => {
    const r = (await db.query('SELECT name, active FROM companies WHERE id = $1', [id])).rows[0];
    if (!r) throw new Refused(404, ['no such company']);
    return r as { name: string; active: boolean };
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

  // The owner's dashboard: every company with how it is getting on (counts only).
  app.get('/platform/dashboard', { preHandler: guard }, async req => {
    const { rows } = await db.query('SELECT id, name, active, created_at, suspended_at, suspended_reason FROM companies ORDER BY name');
    const companies = [];
    const fresh = (req.query as { fresh?: string }).fresh === '1';
    for (const r of rows) companies.push({ ...r, ...(await inCompany(db, r.id, async c => ({ ...(await healthOf(c, r.id)), storage: await storageOf(c, r.id, fresh) }))) });
    // Space each company takes on the office server and in the cloud, and how the daily backup went.
    const backup = await backupStatus();
    const all = companies.map(c => c.storage);
    for (const c of companies) c.storage = { ...c.storage, cloudBytes: cloudShare(c.storage, all, backup) };
    return { owner: ownerOf(req).name, companies, backup };
  });

  // A CEO who is locked out or forgot their password: a new setup code (their old password stops working once they use it).
  app.post('/platform/companies/:id/ceo-code', { preHandler: guard }, async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const co = await companyName(id);
    if (!co.active) throw new Refused(409, ['the company is suspended: reactivate it first']);
    return inCompany(db, id, async c => {
      const ceo = (await c.query("SELECT id, full_name FROM users WHERE login_level = 'creator' AND status <> 'left' AND support_owner IS NULL ORDER BY created_at LIMIT 1")).rows[0];
      if (!ceo) throw new Refused(404, ['the company has no CEO login']);
      const me = await supportLogin(c, ownerOf(req));
      const actor = await loadActor(c, me.id);
      const out = await issueCode(c, actor!, id, ceo.id);
      await notify(c, ceo.id, 'support', `${me.name} gave you a new setup code to sign in.`);
      return { ...out, name: ceo.full_name, company: co.name };
    });
  });

  // Open a company as support: only while the CEO allows it, and only until the time the CEO chose.
  app.post('/platform/companies/:id/enter', { preHandler: guard }, async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const co = await companyName(id);
    if (!co.active) throw new Refused(409, ['the company is suspended: reactivate it first']);
    const owner = ownerOf(req);
    return inCompany(db, id, async c => {
      const g = await openGrant(c);
      if (!g) throw new Refused(409, [`${co.name}'s CEO has not let support in`, 'Ask the CEO to open Settings → Real Sandbox support and tap "Let support in".']);
      const me = await supportLogin(c, owner);
      const first = (await c.query('UPDATE support_grants SET entered_at = now(), entered_by = $2 WHERE id = $1 AND entered_at IS NULL RETURNING id', [g.id, owner.name])).rowCount;
      await audit(c, me.id, 'support_entered', 'support', g.id);
      if (first) await notify(c, (await c.query('SELECT granted_by FROM support_grants WHERE id = $1', [g.id])).rows[0].granted_by, 'support',
        `${me.name} has opened your company to help. You can end it any time under Settings → Real Sandbox support.`);
      const seconds = Math.max(60, Math.floor((new Date(g.until).getTime() - Date.now()) / 1000));
      const token = app.jwt.sign({ sub: me.id, cid: id, v: me.epoch, s: g.id }, { expiresIn: `${seconds}s` });
      return { token, user: { id: me.id, name: me.name, level: 'creator' }, company: { id, name: co.name }, until: g.until, signedInFor: 'until support access ends' };
    });
  });

  app.post('/platform/companies', { preHandler: guard }, async (req, reply) => {
    const b = parse(z.object({
      name: z.string().trim().min(2).max(200),
      creator: z.object({ name: z.string().trim().min(2), email: z.string().email(), password: z.string().min(10, 'password must be at least 10 characters').optional() }),
      // The positions the company uses and the parts it has (left out: everything).
      plan: PlanBody.optional(),
    }), req.body);
    const made = await createCompany(db, b.name, b.creator);
    if (b.plan) await db.query('UPDATE companies SET positions = $2, parts = $3 WHERE id = $1', [made.companyId, b.plan.positions, b.plan.parts]);
    if (b.creator.password) return reply.code(201).send(made);
    // No password typed by the owner: the CEO gets a setup code and chooses their own.
    const code = await inCompany(db, made.companyId, async c => {
      const me = await supportLogin(c, ownerOf(req));
      return issueCode(c, (await loadActor(c, me.id))!, made.companyId, made.creatorUserId);
    });
    return reply.code(201).send({ ...made, code });
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

  registerOwnerBillingRoutes(app, db, guard);
}
