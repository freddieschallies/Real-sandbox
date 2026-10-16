import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { standardPolicy } from './core/setup.ts';
import type { Db, Q } from './db.ts';
import { audit } from './db.ts';
import { keepIfRefused, openCompanyConnection } from './tenancy.ts';
import { Refused, parse } from './http.ts';
import { CATALOGUE, can, effectivePermissions, looksAfterLogins, workOf, type Actor, type LoginLevel, type Override } from './core/permissions.ts';

declare module 'fastify' {
  interface FastifyRequest { actor: Actor }
}
declare module '@fastify/jwt' {
  // v: the person's session number (raised to sign them out on every phone); r: kept signed in on their own phone;
  // s: Real Sandbox support, working in the company for the time the CEO allowed (the support visit's id).
  interface FastifyJWT { payload: { sub: string; cid?: string; platform?: boolean; v?: number; r?: boolean; s?: string }; user: { sub: string; cid?: string; platform?: boolean; v?: number; r?: boolean; s?: string } }
}

/**
 * Loads the actor fresh from the database on every request, so a stopped login or an access change
 * applies at once. With `session`, a sign-in from before the person was signed out everywhere (or
 * changed their password) no longer counts.
 */
export async function loadActor(db: Q, userId: string, session?: number): Promise<Actor | null> {
  const { rows } = await db.query('SELECT id, login_level, department_id, login_enabled, session_epoch FROM users WHERE id = $1', [userId]);
  const r = rows[0];
  if (!r || !r.login_enabled) return null;
  if (session !== undefined && r.session_epoch !== session) return null;
  const level = r.login_level as LoginLevel;
  const o = await db.query(
    `SELECT level, user_id, action, effect, scope, department_ids FROM access_overrides
      WHERE level = $1 OR user_id = $2`,
    [level, userId],
  );
  const toOverride = (x: { action: string; effect: string; scope: string | null; department_ids: string[] }): Override => ({
    action: x.action as Override['action'], effect: x.effect as Override['effect'],
    scope: (x.scope ?? undefined) as Override['scope'], departmentIds: x.department_ids,
  });
  const known = (x: { action: string }) => x.action in CATALOGUE;
  const perms = effectivePermissions(
    level,
    o.rows.filter(x => x.level && known(x)).map(toOverride),
    o.rows.filter(x => x.user_id && known(x)).map(toOverride),
  );
  return { id: r.id, level, departmentId: r.department_id, perms };
}

export async function hasAcknowledgedPolicy(db: Q, userId: string): Promise<boolean> {
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

const PUBLIC = new Set(['/health', '/auth/login', '/auth/setup', '/platform/login']);
const BEFORE_POLICY = new Set(['/me', '/me/password', '/policy/current', '/policy/acknowledge', '/policy/publish']);

export async function companyActive(db: Db, companyId: string): Promise<boolean> {
  const { rows } = await db.query('SELECT active FROM companies WHERE id = $1', [companyId]);
  return rows[0]?.active === true;
}

export function registerAuth(app: FastifyInstance, db: Db) {
  app.decorateRequest('actor', null as unknown as Actor);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.routeOptions.url ?? req.url;
    // The WhatsApp link on the same server signs its requests with its own key (routes/breakdowns.ts).
    // /d/: a document link for a client (a week, signed: routes/jobDocuments.ts).
    if (PUBLIC.has(path) || path.startsWith('/platform/') || path.startsWith('/internal/') || path.startsWith('/webhooks/') || path.startsWith('/d/') || path.startsWith('/x/') || path.startsWith('/help/')) return;
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'not signed in' });
    }
    if (req.user.sub?.startsWith('doc:') || req.user.sub?.startsWith('exp:')) return reply.code(401).send({ error: 'not signed in' });
    const cid = req.user.cid;
    if (req.user.platform || !cid) return reply.code(401).send({ error: 'not signed in to a company' });
    if (!(await companyActive(db, cid))) return reply.code(403).send({ error: 'this company account is suspended', code: 'company_suspended' });
    await openCompanyConnection(db, req, cid);
    const actor = await loadActor(req.db, req.user.sub, req.user.v ?? 0);
    if (!actor) return reply.code(401).send({ error: 'signed out: sign in again' });
    req.actor = actor;
    // Who is doing this, for the history (db/072_history.sql).
    await req.db.query("SELECT set_config('app.user_id', $1, false)", [actor.id]);
    if (req.user.s) {
      // Support only while the CEO's permission lasts: ended or run out means signed out at once.
      const ok = (await req.db.query('SELECT 1 FROM support_grants WHERE id = $1 AND ended_at IS NULL AND until > now()', [req.user.s])).rowCount;
      if (!ok) return reply.code(401).send({ error: 'support access has ended: the CEO can let you in again', code: 'support_ended' });
      return;
    }
    // Nobody uses the app until they have acknowledged the current monitoring policy.
    if (!BEFORE_POLICY.has(path) && !(await hasAcknowledgedPolicy(req.db, actor.id))) {
      return reply.code(403).send({ error: 'acknowledge the monitoring policy first', code: 'policy_required' });
    }
  });

  const Login = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200), remember: z.boolean().optional() });
  const fail = (reply: FastifyReply, status: number, ...reasons: string[]) => reply.code(status).send({ error: reasons[0], reasons });

  app.post('/auth/login', async (req, reply) => {
    const body = Login.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'type your email and password');
    const wrong = () => fail(reply, 401, 'wrong email or password', 'First time? Tap "I have a setup code" and use the code the office gave you.');
    const dir = (await db.query('SELECT user_id, company_id FROM logins WHERE email = lower($1)', [body.data.email])).rows[0];
    if (!dir) return wrong();
    if (!(await companyActive(db, dir.company_id))) return reply.code(403).send({ error: 'this company account is suspended', code: 'company_suspended' });
    await openCompanyConnection(db, req, dir.company_id);
    const u = (await req.db.query(
      `SELECT id, password_hash, login_enabled, full_name, login_level, status, session_epoch, password_set_at, failed_logins,
              locked_until > now() AS locked, ceil(extract(epoch FROM locked_until - now()) / 60)::int AS locked_min
         FROM users WHERE id = $1`, [dir.user_id])).rows[0];
    if (!u || u.status === 'left') return wrong();
    if (u.locked) return fail(reply, 429, `too many wrong passwords: try again in ${u.locked_min} minute${u.locked_min === 1 ? '' : 's'}`, 'Forgot it? Ask the office for a new setup code.');
    if (!(await bcrypt.compare(body.data.password, u.password_hash))) {
      // Kept even though the sign-in is refused: five wrong passwords in a row lock the login for 15 minutes.
      keepIfRefused(req, async c => {
        await c.query(
          `UPDATE users SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
                  locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = $1`, [u.id, MAX_WRONG]);
        if (u.failed_logins + 1 >= MAX_WRONG) await audit(c, null, 'login_locked', 'user', u.id);
      });
      return wrong();
    }
    if (!u.login_enabled) return fail(reply, 403, 'your login is stopped', 'Ask the office (HR or the CEO) to allow it again.');
    await req.db.query("SELECT set_config('app.user_id', $1, false)", [u.id]);
    await req.db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
    await audit(req.db, u.id, 'login', 'user', u.id, { remember: !!body.data.remember });
    return signedIn(dir.company_id, u, !!body.data.remember);
  });

  /** The answer to a successful sign-in: 30 days on the person's own phone, otherwise 12 hours. */
  const signedIn = async (cid: string, u: { id: string; full_name: string; login_level: string; session_epoch: number }, remember: boolean) => {
    const token = app.jwt.sign({ sub: u.id, cid, v: u.session_epoch, ...(remember ? { r: true } : {}) }, { expiresIn: remember ? '30d' : '12h' });
    const company = (await db.query('SELECT name FROM companies WHERE id = $1', [cid])).rows[0].name;
    return { token, user: { id: u.id, name: u.full_name, level: u.login_level }, company: { id: cid, name: company }, signedInFor: remember ? '30 days' : '12 hours' };
  };

  // First sign-in (or a forgotten password): the setup code from the office, and the person's own
  // new password. The code works once and only until it expires; five wrong tries cancel it.
  const Setup = z.object({ email: z.string().trim().email(), code: z.string().max(40), password: z.string().max(200), remember: z.boolean().optional() });
  app.post('/auth/setup', async (req, reply) => {
    const body = Setup.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'type your email, the setup code and a new password');
    const b = body.data;
    const wrong = () => fail(reply, 401, 'wrong email or setup code, or the code has expired', 'Ask the office for a new setup code.');
    const weak = passwordProblem(b.password, b.email);
    if (weak) return fail(reply, 400, weak);
    const dir = (await db.query('SELECT user_id, company_id FROM logins WHERE email = lower($1)', [b.email])).rows[0];
    if (!dir) return wrong();
    if (!(await companyActive(db, dir.company_id))) return reply.code(403).send({ error: 'this company account is suspended', code: 'company_suspended' });
    await openCompanyConnection(db, req, dir.company_id);
    const u = (await req.db.query("SELECT id, full_name, login_level, status, session_epoch FROM users WHERE id = $1 FOR UPDATE", [dir.user_id])).rows[0];
    if (!u || u.status === 'left') return wrong();
    const code = (await req.db.query(
      'SELECT id, code_hash, wrong_tries FROM login_codes WHERE user_id = $1 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > now() FOR UPDATE', [u.id])).rows[0];
    if (!code) return wrong();
    if (!sameHash(code.code_hash, hashCode(u.id, b.code))) {
      keepIfRefused(req, async c => {
        await c.query(
          `UPDATE login_codes SET wrong_tries = wrong_tries + 1,
                  cancelled_at = CASE WHEN wrong_tries + 1 >= $2 THEN now() END, cancel_reason = CASE WHEN wrong_tries + 1 >= $2 THEN 'too many wrong tries' END
            WHERE id = $1`, [code.id, MAX_WRONG]);
      });
      return wrong();
    }
    const epoch = u.session_epoch + 1;
    await req.db.query("SELECT set_config('app.user_id', $1, false)", [u.id]);
    await req.db.query(
      `UPDATE users SET password_hash = $2, password_set_at = now(), login_enabled = true, failed_logins = 0, locked_until = NULL,
              session_epoch = $3, last_login_at = now() WHERE id = $1`, [u.id, await hashPassword(b.password), epoch]);
    await req.db.query('UPDATE login_codes SET used_at = now() WHERE id = $1', [code.id]);
    await req.db.query('INSERT INTO access_changes (changed_by, user_id, action, change) VALUES ($1, $1, $2, $3)', [u.id, 'login', 'Chose their own password with the setup code']);
    await audit(req.db, u.id, 'login_set_up', 'user', u.id, { remember: !!b.remember });
    return signedIn(dir.company_id, { ...u, session_epoch: epoch }, !!b.remember);
  });

  // Changing your own password signs you out on every other phone; this one stays signed in.
  app.post('/me/password', async req => {
    // Only the admin and the CEO change their own password here; everyone else gets a new setup code from them.
    if (!looksAfterLogins(req.actor)) throw new Refused(403, ['ask Admin or the CEO for a new setup code to change your password']);
    const b = parse(z.object({ current: z.string().max(200), password: z.string().max(200) }), req.body);
    const u = (await req.db.query('SELECT id, full_name, login_level, email, password_hash, session_epoch FROM users WHERE id = $1 FOR UPDATE', [req.actor.id])).rows[0];
    if (!(await bcrypt.compare(b.current, u.password_hash))) throw new Refused(403, ['your current password is wrong']);
    const weak = passwordProblem(b.password, u.email ?? '');
    if (weak) throw new Refused(400, [weak]);
    if (b.password === b.current) throw new Refused(400, ['the new password is the same as the old one']);
    const epoch = u.session_epoch + 1;
    await req.db.query('UPDATE users SET password_hash = $2, password_set_at = now(), session_epoch = $3 WHERE id = $1', [u.id, await hashPassword(b.password), epoch]);
    await req.db.query('UPDATE login_codes SET cancelled_at = now(), cancel_reason = $2 WHERE user_id = $1 AND used_at IS NULL AND cancelled_at IS NULL', [u.id, 'password changed']);
    await req.db.query('INSERT INTO access_changes (changed_by, user_id, action, change) VALUES ($1, $1, $2, $3)', [u.id, 'login', 'Changed their own password']);
    await audit(req.db, u.id, 'password_changed', 'user', u.id);
    return signedIn(req.companyId, { ...u, session_epoch: epoch }, !!req.user.r);
  });

  app.get('/me', async req => {
    const { rows } = await req.db.query('SELECT id, full_name, email, login_level, department_id FROM users WHERE id = $1', [req.actor.id]);
    const company = (await db.query('SELECT id, name FROM companies WHERE id = $1', [req.companyId])).rows[0];
    return { ...rows[0], company, fleetDuty: can(req.actor, 'manage_fleet') && rows[0].login_level !== 'mechanic',
      stockDuty: can(req.actor, 'manage_stockroom') && rows[0].login_level !== 'stockroom',
      // Standing in for the stock controller: issuing stock and tools, not receiving or counting.
      stockCover: can(req.actor, 'assign_stock') && !can(req.actor, 'manage_stockroom') && rows[0].login_level !== 'stockroom',
      permissions: Object.entries(req.actor.perms ?? {}).filter(([, v]) => !!v).map(([k]) => k),
      work: workOf(req.actor.perms ?? {}), policyAcknowledged: !!req.user.s || await hasAcknowledgedPolicy(req.db, req.actor.id),
      support: req.user.s ? (await req.db.query('SELECT until FROM support_grants WHERE id = $1', [req.user.s])).rows[0] ?? null : null };
  });

  app.get('/policy/current', async (req, reply) => {
    const { rows } = await req.db.query('SELECT id, version, body, published_at FROM policy_versions ORDER BY published_at DESC LIMIT 1');
    if (!rows[0]) {
      // A new company: the CEO publishes it (the usual policy with the company's name, which they may change first).
      const canPublish = can(req.actor, 'manage_access');
      const company = canPublish ? (await req.db.query('SELECT name FROM companies WHERE id = $1', [req.companyId])).rows[0]?.name ?? 'The company' : null;
      return reply.code(404).send({ error: 'no policy published', code: 'no_policy', canPublish, draft: company ? standardPolicy(company) : null });
    }
    return rows[0];
  });

  // The CEO publishes the company's monitoring policy (the first one from the start-up, or a new version).
  // Everyone reads and accepts it at their next sign-in.
  app.post('/policy/publish', async (req, reply) => {
    if (!can(req.actor, 'manage_access')) return reply.code(403).send({ error: 'only the CEO publishes the monitoring policy', reasons: ['only the CEO publishes the monitoring policy'] });
    const v = z.object({ body: z.string().trim().min(200, 'the policy text (at least a few paragraphs)').max(20000) }).safeParse(req.body);
    if (!v.success) return reply.code(400).send({ error: v.error.issues[0].message, reasons: v.error.issues.map(i => i.message) });
    const n = Number((await req.db.query('SELECT count(*)::int AS n FROM policy_versions')).rows[0].n);
    const version = `${n + 1}.0`;
    const id = (await req.db.query('INSERT INTO policy_versions (version, body) VALUES ($1, $2) RETURNING id', [version, v.data.body])).rows[0].id;
    await audit(req.db, req.actor.id, 'policy_published', 'policy_version', id, { version });
    return { id, version };
  });

  app.post('/policy/acknowledge', async (req, reply) => {
    const v = z.object({ policyVersionId: z.string().uuid() }).safeParse(req.body);
    if (!v.success) return reply.code(400).send({ error: 'policyVersionId required' });
    const { rows } = await req.db.query('SELECT id FROM policy_versions ORDER BY published_at DESC LIMIT 1');
    if (rows[0]?.id !== v.data.policyVersionId) return reply.code(409).send({ error: 'that is not the current policy version' });
    await req.db.query(
      'INSERT INTO policy_acknowledgements (user_id, policy_version_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.actor.id, v.data.policyVersionId],
    );
    await audit(req.db, req.actor.id, 'policy_acknowledged', 'policy_version', v.data.policyVersionId);
    return { ok: true };
  });
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);

/** Five wrong passwords (or setup codes) in a row. */
export const MAX_WRONG = 5;

/** What is wrong with a new password, or null. Long enough, and not just the email or a run of one key. */
export function passwordProblem(pw: string, email: string): string | null {
  if (pw.length < 8) return 'choose a password of at least 8 characters';
  if (pw.length > 200) return 'that password is too long';
  const lower = pw.toLowerCase();
  const name = email.toLowerCase().split('@')[0];
  if (lower === email.toLowerCase() || (name.length >= 4 && lower.includes(name))) return 'do not use your email in the password';
  if (new Set(lower).size < 4) return 'use a mix of letters and numbers, not the same few keys';
  if (['password', '12345678', '123456789', 'qwertyui', 'qwerty123', 'password1'].includes(lower)) return 'that password is too easy to guess';
  return null;
}

// Setup codes: 8 characters without look-alikes (no 0/O, 1/I/L), shown as ABCD-EFGH.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newSetupCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const normalCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** Stored as a hash only, tied to the person, so a code read from the database is no use. */
export const hashCode = (userId: string, code: string) => createHash('sha256').update(`${userId}:${normalCode(code)}`).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
