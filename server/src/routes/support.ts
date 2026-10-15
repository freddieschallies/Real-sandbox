// Tech support from Real Sandbox: the CEO lets support into the company for a set time, sees when
// support is in, and can end it at any moment. Support works through a hidden login of its own
// ("Support: <name>"), so everything it does is in the company's history under that name.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, tx, type Q } from '../db.ts';
import { can } from '../core/permissions.ts';
import { Refused, parse } from '../http.ts';
import { notify } from './field.ts';

export const SUPPORT_HOURS = [1, 4, 24, 72] as const;

/** The support visit that is open now, if any. */
export async function openGrant(c: Q) {
  return (await c.query(
    `SELECT g.id, g.until, g.granted_at, g.reason, g.entered_at, g.entered_by, u.full_name AS granted_by
       FROM support_grants g JOIN users u ON u.id = g.granted_by
      WHERE g.ended_at IS NULL AND g.until > now() ORDER BY g.granted_at DESC LIMIT 1`)).rows[0] ?? null;
}

/** The hidden login a platform owner uses inside a company: made the first time it is needed. */
export async function supportLogin(c: Q, owner: { id: string; name: string }) {
  const had = (await c.query('SELECT id, session_epoch FROM users WHERE support_owner = $1', [owner.id])).rows[0];
  const name = `Support: ${owner.name.split(' ')[0]} (Real Sandbox)`;
  if (had) {
    await c.query('UPDATE users SET full_name = $2 WHERE id = $1', [had.id, name]);
    return { id: had.id as string, epoch: had.session_epoch as number, name };
  }
  // A Creator's rights, but never a person on the staff lists (status 'left') and no password: it is only opened from the owner's dashboard.
  const r = (await c.query(
    `INSERT INTO users (full_name, login_level, password_hash, login_enabled, status, support_owner)
     VALUES ($1, 'creator', '!', true, 'left', $2) RETURNING id, session_epoch`, [name, owner.id])).rows[0];
  return { id: r.id as string, epoch: r.session_epoch as number, name };
}

const view = (g: { id: string; until: Date; granted_at: Date; reason: string | null; entered_at: Date | null; entered_by: string | null; granted_by: string } | null) =>
  g ? { id: g.id, until: g.until, grantedAt: g.granted_at, reason: g.reason, enteredAt: g.entered_at, enteredBy: g.entered_by, grantedBy: g.granted_by } : null;

export function registerSupportRoutes(app: FastifyInstance) {
  const ceo = (req: FastifyRequest) => {
    if (!can(req.actor, 'manage_access')) throw new Refused(403, ['only the CEO lets Real Sandbox support in']);
    if (req.user.s) throw new Refused(403, ['support cannot give itself more time: the CEO does that']);
  };

  app.get('/support', async req => {
    const g = await openGrant(req.db);
    const mine = can(req.actor, 'manage_access') && !req.user.s;
    const history = mine ? (await req.db.query(
      `SELECT g.id, g.granted_at, g.until, g.ended_at, g.reason, g.entered_at, g.entered_by, a.full_name AS granted_by, e.full_name AS ended_by
         FROM support_grants g JOIN users a ON a.id = g.granted_by LEFT JOIN users e ON e.id = g.ended_by
        ORDER BY g.granted_at DESC LIMIT 10`)).rows.map(r => ({
      id: r.id, grantedAt: r.granted_at, until: r.until, endedAt: r.ended_at, reason: r.reason, enteredAt: r.entered_at, enteredBy: r.entered_by, grantedBy: r.granted_by, endedBy: r.ended_by,
    })) : [];
    return { active: view(g), canGrant: mine, hours: SUPPORT_HOURS, history, isSupport: !!req.user.s };
  });

  app.post('/support/grant', async req => {
    ceo(req);
    const b = parse(z.object({ hours: z.number().int().min(1).max(72), reason: z.string().trim().max(300).optional() }), req.body);
    return tx(req.db, async c => {
      await c.query('UPDATE support_grants SET ended_at = now(), ended_by = $1 WHERE ended_at IS NULL', [req.actor.id]);
      const g = (await c.query(
        `INSERT INTO support_grants (granted_by, until, reason) VALUES ($1, now() + make_interval(hours => $2), $3) RETURNING id`,
        [req.actor.id, b.hours, b.reason || null])).rows[0];
      await audit(c, req.actor.id, 'support_allowed', 'support', g.id, { hours: b.hours, reason: b.reason ?? null });
      return { active: view(await openGrant(c)) };
    });
  });

  // The CEO ends it, or support says it is finished. From then on support's sign-in no longer works.
  app.post('/support/end', async req => {
    if (!req.user.s && !can(req.actor, 'manage_access')) throw new Refused(403, ['only the CEO ends support access']);
    return tx(req.db, async c => {
      const g = await openGrant(c);
      if (!g) return { active: null };
      await c.query('UPDATE support_grants SET ended_at = now(), ended_by = $2 WHERE id = $1', [g.id, req.actor.id]);
      await audit(c, req.actor.id, 'support_ended', 'support', g.id);
      if (req.user.s) await notify(c, (await c.query('SELECT granted_by FROM support_grants WHERE id = $1', [g.id])).rows[0].granted_by, 'support',
        'Real Sandbox support has finished and signed out of your company.');
      return { active: null };
    });
  });
}
