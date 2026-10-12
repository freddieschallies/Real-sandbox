// The CEO's access screen: what each login type and each person may do.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Client, Db } from '../db.ts';
import { audit, tx } from '../db.ts';
import { ACTIONS, CATALOGUE, DEFAULTS, LEVELS, can, isScoped, type Action, type LoginLevel } from '../core/permissions.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { loadActor } from '../auth.ts';
import { notify } from './field.ts';

const Change = z.object({
  effect: z.enum(['grant', 'deny', 'default']),
  scope: z.enum(['own_department', 'all_departments', 'selected_departments']).optional(),
  departmentIds: z.array(Uuid).default([]),
});
type ChangeT = z.infer<typeof Change>;

function describe(c: ChangeT, action: Action): string {
  if (c.effect === 'default') return 'back to default';
  if (c.effect === 'deny') return 'removed';
  if (!isScoped(action)) return 'granted';
  return `granted (${(c.scope ?? 'own_department').replace(/_/g, ' ')}${c.scope === 'selected_departments' ? `: ${c.departmentIds.length}` : ''})`;
}

function checkChange(action: string, c: ChangeT): Action {
  if (!(action in CATALOGUE)) throw new Refused(404, ['unknown permission']);
  const a = action as Action;
  if (c.effect === 'grant' && isScoped(a)) {
    if (!c.scope) throw new Refused(400, ['choose which departments this covers']);
    if (c.scope === 'selected_departments' && c.departmentIds.length === 0) throw new Refused(400, ['pick at least one department']);
  }
  return a;
}

async function writeOverride(c: Client, target: { level?: LoginLevel; userId?: string }, action: Action, ch: ChangeT, by: string) {
  const where = target.level ? 'level = $1' : 'user_id = $1';
  const key = target.level ?? target.userId;
  await c.query(`DELETE FROM access_overrides WHERE ${where} AND action = $2`, [key, action]);
  if (ch.effect !== 'default') {
    await c.query(
      `INSERT INTO access_overrides (level, user_id, action, effect, scope, department_ids, set_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [target.level ?? null, target.userId ?? null, action, ch.effect,
       ch.effect === 'grant' && isScoped(action) ? ch.scope : null,
       ch.effect === 'grant' && ch.scope === 'selected_departments' ? ch.departmentIds : [], by],
    );
  }
  await c.query(
    'INSERT INTO access_changes (changed_by, level, user_id, action, change) VALUES ($1, $2, $3, $4, $5)',
    [by, target.level ?? null, target.userId ?? null, action, describe(ch, action)],
  );
}

/** Nobody may remove the last way in: at least one active login must keep "manage_access". */
async function ensureSomeoneCanManageAccess(c: Client, db: Db) {
  const users = await c.query("SELECT id FROM users WHERE login_enabled AND status = 'active'");
  for (const u of users.rows) {
    // Read through this transaction's view of the overrides.
    const a = await loadActor({ query: c.query.bind(c) } as unknown as Db, u.id);
    if (a && can(a, 'manage_access')) return;
  }
  void db;
  throw new Refused(409, ['this would leave nobody able to manage access']);
}

export function registerAccessRoutes(app: FastifyInstance, db: Db) {
  const guard = (req: FastifyRequest) => {
    if (!can(req.actor, 'manage_access')) throw new Refused(403, ['only people who manage access can see this']);
  };

  app.get('/access/catalogue', async req => {
    guard(req);
    return ACTIONS.map(a => ({
      action: a, ...CATALOGUE[a],
      defaults: Object.fromEntries(LEVELS.map(l => [l, DEFAULTS[l][a] ?? false])),
    }));
  });

  app.get('/access/levels', async req => {
    guard(req);
    const { rows } = await db.query('SELECT level, action, effect, scope, department_ids, set_at FROM access_overrides WHERE level IS NOT NULL ORDER BY level, action');
    return rows;
  });

  app.put('/access/levels/:level/:action', async (req: FastifyRequest<{ Params: { level: string; action: string } }>) => {
    guard(req);
    const level = parse(z.enum(LEVELS as [LoginLevel, ...LoginLevel[]]), req.params.level);
    const ch = parse(Change, req.body);
    const action = checkChange(req.params.action, ch);
    await tx(db, async c => {
      await writeOverride(c, { level }, action, ch, req.actor.id);
      await ensureSomeoneCanManageAccess(c, db);
      await audit(c, req.actor.id, 'access_changed', 'login_level', level, { action, change: describe(ch, action) });
    });
    return { level, action, change: describe(ch, action) };
  });

  app.get('/access/users/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    guard(req);
    const id = parse(Uuid, req.params.id);
    const target = await loadActor(db, id);
    const u = (await db.query('SELECT id, full_name, login_level, department_id, login_enabled FROM users WHERE id = $1', [id])).rows[0];
    if (!u) throw new Refused(404, ['no such user']);
    const overrides = (await db.query('SELECT action, effect, scope, department_ids, set_by, set_at FROM access_overrides WHERE user_id = $1', [id])).rows;
    return { user: u, effective: target?.perms ?? {}, overrides };
  });

  app.put('/access/users/:id/:action', async (req: FastifyRequest<{ Params: { id: string; action: string } }>) => {
    guard(req);
    const userId = parse(Uuid, req.params.id);
    const ch = parse(Change, req.body);
    const action = checkChange(req.params.action, ch);
    await tx(db, async c => {
      const u = await c.query('SELECT full_name FROM users WHERE id = $1', [userId]);
      if (!u.rowCount) throw new Refused(404, ['no such user']);
      await writeOverride(c, { userId }, action, ch, req.actor.id);
      await ensureSomeoneCanManageAccess(c, db);
      await audit(c, req.actor.id, 'access_changed', 'user', userId, { action, change: describe(ch, action) });
      // The person is told when their access changes.
      await notify(c, userId, 'access_changed', `Your access changed: ${CATALOGUE[action].label} – ${describe(ch, action)}`, { action });
    });
    return { userId, action, change: describe(ch, action) };
  });

  app.get('/access/changes', async req => {
    guard(req);
    const { rows } = await db.query(
      `SELECT a.at, b.full_name AS changed_by, a.level, u.full_name AS person, a.action, a.change
         FROM access_changes a JOIN users b ON b.id = a.changed_by LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.at DESC LIMIT 500`,
    );
    return rows;
  });
}
