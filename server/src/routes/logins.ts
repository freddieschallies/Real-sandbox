// Each person's own sign-in. HR or the CEO adds a person and gives them a one-time setup code; the
// person signs in with their email and chooses their own password with it, so nobody else knows it.
// A forgotten password: a new code. A lost phone: sign them out on every phone. Someone who must not
// get in: stop the login (it stops at once on every phone). Everything is logged.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, tx, type Q } from '../db.ts';
import { HR_POSITIONS, LEVELS, POSITION_LABEL, TRADES, can, editsProfiles, looksAfterLogins, type Actor, type LoginLevel, type Trade } from '../core/permissions.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { hashCode, newSetupCode } from '../auth.ts';
import { ensureSomeoneCanManageAccess } from './access.ts';

/** How long a setup code works. */
export const CODE_DAYS = 7;

/** Whether `a` may give, reset or stop the login of someone in position `level`. Never your own (use "My password"). */
export function managesLogin(a: Actor, target: { id: string; login_level: string }): boolean {
  if (target.id === a.id) return false;
  if (can(a, 'manage_access')) return target.login_level !== 'creator' || a.level === 'creator';
  // The admin looks after everyone's login except the directors' and the CEO's.
  if (a.level === 'admin') return target.login_level !== 'director' && target.login_level !== 'creator';
  return false;
}

/** The state of someone's login, in one word, for the People list. */
export const LOGIN_STATE_SQL = `CASE WHEN u.login_enabled AND u.password_hash LIKE '$2%' AND u.locked_until > now() THEN 'locked' WHEN u.login_enabled AND u.password_hash LIKE '$2%' THEN 'on'
  WHEN EXISTS (SELECT 1 FROM login_codes lc WHERE lc.user_id = u.id AND lc.used_at IS NULL AND lc.cancelled_at IS NULL AND lc.expires_at > now()) THEN 'code'
  WHEN u.password_hash LIKE '$2%' THEN 'stopped' ELSE 'none' END`;

async function target(c: Q, id: string) {
  const u = (await c.query(
    `SELECT u.id, u.full_name, u.email, u.login_level, u.status, u.login_enabled, u.password_hash LIKE '$2%' AS has_password, u.password_set_at,
            u.last_login_at, u.locked_until > now() AS locked, u.locked_until,
            CASE WHEN u.login_enabled AND u.password_hash LIKE '$2%' THEN 'on' ELSE ${LOGIN_STATE_SQL} END AS state
       FROM users u WHERE u.id = $1 FOR UPDATE`, [id])).rows[0];
  if (!u) throw new Refused(404, ['no such person']);
  return u;
}

const log = (c: Q, by: string, userId: string, change: string) =>
  c.query('INSERT INTO access_changes (changed_by, user_id, action, change) VALUES ($1, $2, $3, $4)', [by, userId, 'login', change]);

/** The person's email in the sign-in directory (shared by every company, so one email is one person). */
export async function registerEmail(c: Q, companyId: string, userId: string, email: string | null) {
  if (!email) {
    await c.query('DELETE FROM logins WHERE user_id = $1', [userId]);
    return;
  }
  const taken = (await c.query('SELECT user_id FROM logins WHERE email = lower($1)', [email])).rows[0];
  if (taken && taken.user_id !== userId) throw new Refused(409, ['that email is already someone else\'s sign-in: use another one']);
  await c.query(
    `INSERT INTO logins (email, user_id, company_id) VALUES (lower($1), $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email`, [email, userId, companyId]);
}

export function registerLoginRoutes(app: FastifyInstance) {
  const office = (req: FastifyRequest) => {
    if (!editsProfiles(req.actor)) throw new Refused(403, ['only HR or the CEO looks after logins']);
  };
  // Logins and passwords are for the admin and the CEO only.
  const logins = (req: FastifyRequest) => {
    if (!looksAfterLogins(req.actor)) throw new Refused(403, ['only Admin or the CEO looks after logins and passwords']);
  };
  const may = (req: FastifyRequest, u: { id: string; login_level: string; full_name: string }) => {
    if (u.id === req.actor.id) throw new Refused(403, ['change your own password under Settings → My password']);
    if (!managesLogin(req.actor, u)) {
      throw new Refused(403, [can(req.actor, 'manage_access') ? 'only the Creator looks after the Creator\'s login'
        : `the admin looks after everyone's login except the directors' and the CEO's; ${u.full_name.split(' ')[0]}'s is the CEO's`]);
    }
  };

  // ---- Add a person ----------------------------------------------------------------------------
  app.post('/people', async req => {
    office(req);
    const b = parse(z.object({
      fullName: z.string().trim().min(3, 'their full name').max(100),
      email: z.string().trim().email('a valid email').max(200).optional().or(z.literal('')),
      phone: z.string().trim().max(30).optional(),
      position: z.enum(LEVELS as [LoginLevel, ...LoginLevel[]]),
      trade: z.enum(Object.keys(TRADES) as [Trade, ...Trade[]]).nullish(),
      departmentId: Uuid.nullish(),
    }), req.body);
    const full = can(req.actor, 'manage_access');
    if (!full && !HR_POSITIONS.includes(b.position)) throw new Refused(403, ['HR adds technicians, admin, department managers and stock controllers; the other positions are the CEO\'s']);
    if (b.position === 'creator' && req.actor.level !== 'creator') throw new Refused(403, ['only the Creator adds another Creator']);
    if (b.trade && b.position !== 'technician') throw new Refused(400, ['only technicians have a trade']);
    return tx(req.db, async c => {
      if ((await c.query("SELECT 1 FROM users WHERE lower(full_name) = lower($1) AND status <> 'left'", [b.fullName])).rowCount) {
        throw new Refused(409, [`${b.fullName} is already under People`]);
      }
      if (b.departmentId && !(await c.query('SELECT 1 FROM departments WHERE id = $1', [b.departmentId])).rowCount) throw new Refused(400, ['unknown department']);
      const email = b.email ? b.email.toLowerCase() : null;
      if (email && (await c.query('SELECT 1 FROM users WHERE lower(email) = $1', [email])).rowCount) throw new Refused(409, ['that email is already someone else\'s']);
      // No password yet: the person chooses one with the setup code.
      const id = (await c.query(
        `INSERT INTO users (full_name, email, phone, login_level, trade, department_id, password_hash, login_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, '!', false) RETURNING id`,
        [b.fullName, email, b.phone || null, b.position, b.trade ?? null, b.departmentId ?? null])).rows[0].id as string;
      await registerEmail(c, req.companyId, id, email);
      await c.query('INSERT INTO access_changes (changed_by, user_id, action, change) VALUES ($1, $2, $3, $4)', [req.actor.id, id, 'added', `Added as ${POSITION_LABEL[b.position]}`]);
      await audit(c, req.actor.id, 'person_added', 'user', id, { position: b.position });
      return { id, full_name: b.fullName, position: POSITION_LABEL[b.position] };
    });
  });

  // ---- One person's login ----------------------------------------------------------------------
  app.get('/people/:id/login', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    logins(req);
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const u = await target(c, id);
      const code = (await c.query(
        `SELECT l.issued_at, l.expires_at, b.full_name AS issued_by FROM login_codes l JOIN users b ON b.id = l.issued_by
          WHERE l.user_id = $1 AND l.used_at IS NULL AND l.cancelled_at IS NULL AND l.expires_at > now()`, [id])).rows[0] ?? null;
      const history = (await c.query(
        `SELECT a.at, a.change, b.full_name AS by FROM access_changes a JOIN users b ON b.id = a.changed_by
          WHERE a.user_id = $1 AND a.action IN ('login', 'added') ORDER BY a.at DESC LIMIT 12`, [id])).rows;
      return {
        email: u.email, state: u.state, hasPassword: u.has_password, passwordSetAt: u.password_set_at, lastSignIn: u.last_login_at,
        locked: !!u.locked, lockedUntil: u.locked ? u.locked_until : null, codeWaiting: code, left: u.status === 'left',
        canManage: u.status !== 'left' && managesLogin(req.actor, u), mine: u.id === req.actor.id, codeDays: CODE_DAYS, history,
      };
    });
  });

  // A setup code: for the first sign-in, or a forgotten password. Shown once; only its hash is kept.
  // It replaces any code still waiting and unlocks a locked login. The current password keeps
  // working until the person uses the code.
  app.post('/people/:id/login/code', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    logins(req);
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const u = await target(c, id);
      may(req, u);
      if (u.status === 'left') throw new Refused(409, [`${u.full_name} has left the company`]);
      if (!u.email) throw new Refused(409, [`${u.full_name.split(' ')[0]} needs an email first: it is what he signs in with (edit the contact details)`]);
      await registerEmail(c, req.companyId, id, u.email);
      await c.query("UPDATE login_codes SET cancelled_at = now(), cancel_reason = 'replaced by a new code' WHERE user_id = $1 AND used_at IS NULL AND cancelled_at IS NULL", [id]);
      const code = newSetupCode();
      const expires = (await c.query(
        `INSERT INTO login_codes (user_id, code_hash, issued_by, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4)) RETURNING expires_at`,
        [id, hashCode(id, code), req.actor.id, CODE_DAYS])).rows[0].expires_at as Date;
      await c.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [id]);
      await log(c, req.actor.id, id, u.has_password ? 'New setup code (to reset the password)' : 'Setup code given for the first sign-in');
      await audit(c, req.actor.id, 'login_code_issued', 'user', id);
      const company = (await c.query('SELECT name FROM companies WHERE id = $1', [req.companyId])).rows[0]?.name ?? '';
      const until = expires.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', timeZone: 'Africa/Johannesburg' });
      return {
        code, expiresAt: expires.toISOString(), email: u.email,
        // Ready to send by WhatsApp or SMS. The code alone is no use without the email, and works once.
        message: `Hi ${u.full_name.split(' ')[0]}, this is your ${company} job card app sign-in.\n`
          + `1. Open the app and tap "I have a setup code".\n2. Email: ${u.email}\n3. Setup code: ${code}\n`
          + `4. Choose your own password (at least 8 characters). Don't tell anyone your password.\n`
          + `The code works once, until ${until}.`,
      };
    });
  });

  app.post('/people/:id/login/stop', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    logins(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
    return tx(req.db, async c => {
      const u = await target(c, id);
      may(req, u);
      await c.query('UPDATE users SET login_enabled = false, session_epoch = session_epoch + 1 WHERE id = $1', [id]);
      await c.query("UPDATE login_codes SET cancelled_at = now(), cancel_reason = 'login stopped' WHERE user_id = $1 AND used_at IS NULL AND cancelled_at IS NULL", [id]);
      await ensureSomeoneCanManageAccess(c);
      await log(c, req.actor.id, id, `Login stopped${b.reason ? `: ${b.reason}` : ''}`);
      await audit(c, req.actor.id, 'login_stopped', 'user', id, { reason: b.reason ?? null });
      return { id, state: u.has_password ? 'stopped' : 'none' };
    });
  });

  app.post('/people/:id/login/allow', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    logins(req);
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const u = await target(c, id);
      may(req, u);
      if (u.status === 'left') throw new Refused(409, [`${u.full_name} has left the company`]);
      if (!u.has_password) throw new Refused(409, [`${u.full_name.split(' ')[0]} has not chosen a password yet: give a setup code`]);
      await c.query('UPDATE users SET login_enabled = true, failed_logins = 0, locked_until = NULL WHERE id = $1', [id]);
      await log(c, req.actor.id, id, 'Login allowed again');
      await audit(c, req.actor.id, 'login_allowed', 'user', id);
      return { id, state: 'on' };
    });
  });

  // A lost or changed phone: every phone signed in as this person is signed out; the password stays.
  app.post('/people/:id/login/sign-out', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    logins(req);
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const u = await target(c, id);
      may(req, u);
      await c.query('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1', [id]);
      await log(c, req.actor.id, id, 'Signed out on every phone');
      await audit(c, req.actor.id, 'login_signed_out', 'user', id);
      return { id };
    });
  });
}
