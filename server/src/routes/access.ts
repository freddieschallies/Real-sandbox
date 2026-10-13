// The CEO's access screen: what each login type and each person may do.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db, Q } from '../db.ts';
import { audit, tx } from '../db.ts';
import { ACTIONS, CATALOGUE, DEFAULTS, LEVELS, POSITION_LABEL, TRADES, WORK_AREAS, can, isScoped, workOf, type Action, type LoginLevel, type Trade, type WorkArea, seesPeople, HR_POSITIONS, editsProfiles } from '../core/permissions.ts';
import { LOGIN_STATE_SQL } from './logins.ts';
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

/** `log` false when the caller writes one summary line itself (a whole kind of work switched at once). */
async function writeOverride(c: Q, target: { level?: LoginLevel; userId?: string }, action: Action, ch: ChangeT, by: string, log = true) {
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
  if (log) await c.query(
    'INSERT INTO access_changes (changed_by, level, user_id, action, change) VALUES ($1, $2, $3, $4, $5)',
    [by, target.level ?? null, target.userId ?? null, action, describe(ch, action)],
  );
}

async function checkDepartments(c: Q, ch: ChangeT) {
  if (!ch.departmentIds.length) return;
  const { rows } = await c.query('SELECT count(*)::int AS n FROM departments WHERE id = ANY($1)', [ch.departmentIds]);
  if (rows[0].n !== new Set(ch.departmentIds).size) throw new Refused(400, ['unknown department']);
}

/** Nobody may remove the last way in: at least one active login must keep "manage_access". */
export async function ensureSomeoneCanManageAccess(c: Q) {
  const users = await c.query("SELECT id FROM users WHERE login_enabled AND status = 'active'");
  for (const u of users.rows) {
    const a = await loadActor(c, u.id);
    if (a && can(a, 'manage_access')) return;
  }
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
    const { rows } = await req.db.query('SELECT level, action, effect, scope, department_ids, set_at FROM access_overrides WHERE level IS NOT NULL ORDER BY level, action');
    return rows;
  });

  app.put('/access/levels/:level/:action', async (req: FastifyRequest<{ Params: { level: string; action: string } }>) => {
    guard(req);
    const level = parse(z.enum(LEVELS as [LoginLevel, ...LoginLevel[]]), req.params.level);
    const ch = parse(Change, req.body);
    const action = checkChange(req.params.action, ch);
    await tx(req.db, async c => {
      await checkDepartments(c, ch);
      await writeOverride(c, { level }, action, ch, req.actor.id);
      await ensureSomeoneCanManageAccess(c);
      await audit(c, req.actor.id, 'access_changed', 'login_level', level, { action, change: describe(ch, action) });
    });
    return { level, action, change: describe(ch, action) };
  });

  app.get('/access/users/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    guard(req);
    const id = parse(Uuid, req.params.id);
    const target = await loadActor(req.db, id);
    const u = (await req.db.query('SELECT id, full_name, login_level, department_id, login_enabled FROM users WHERE id = $1', [id])).rows[0];
    if (!u) throw new Refused(404, ['no such user']);
    const overrides = (await req.db.query('SELECT action, effect, scope, department_ids, set_by, set_at FROM access_overrides WHERE user_id = $1', [id])).rows;
    return { user: u, effective: target?.perms ?? {}, overrides };
  });

  /** Everyone, for the office. Only whoever manages access (the CEO, or someone given it) can change positions, trades and work. */
  app.get('/people', async req => {
    if (!seesPeople(req.actor)) throw new Refused(403, ['people are not part of your work']);
    const manage = can(req.actor, 'manage_access');
    const logins = editsProfiles(req.actor);
    const { rows } = await req.db.query(
      `SELECT u.id, u.full_name, u.login_level, u.trade, d.name AS department, u.status, p.photo_id, ${LOGIN_STATE_SQL} AS login
         FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.status <> 'left' ORDER BY u.full_name`);
    const people = [];
    for (const r of rows) {
      const a = await loadActor(req.db, r.id);
      people.push({ ...r, login: logins ? r.login : undefined, position: POSITION_LABEL[r.login_level as LoginLevel], tradeLabel: r.trade ? TRADES[r.trade as Trade] : null, work: workOf(a?.perms ?? {}) });
    }
    return {
      canManage: manage,
      // HR and the CEO add people and give them their logins.
      canAdd: logins, addPositions: logins ? (manage ? LEVELS.filter(l => l !== 'creator' || req.actor.level === 'creator') : HR_POSITIONS) : [],
      canSetPositions: manage || can(req.actor, 'set_positions'),
      settablePositions: manage ? LEVELS : can(req.actor, 'set_positions') ? HR_POSITIONS : [],
      positions: LEVELS.map(l => ({ level: l, label: POSITION_LABEL[l] })),
      trades: Object.entries(TRADES).map(([key, label]) => ({ key, label })),
      areas: Object.entries(WORK_AREAS).map(([key, a]) => ({ key, label: a.label })),
      people,
    };
  });

  app.put('/access/users/:id/trade', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!can(req.actor, 'manage_access') && !can(req.actor, 'set_positions')) throw new Refused(403, ['only the CEO or HR sets trades']);
    const userId = parse(Uuid, req.params.id);
    const b = parse(z.object({ trade: z.enum(Object.keys(TRADES) as [Trade, ...Trade[]]).nullable() }), req.body);
    return tx(req.db, async c => {
      const u = (await c.query("SELECT full_name, login_level, trade FROM users WHERE id = $1 AND status <> 'left'", [userId])).rows[0];
      if (!u) throw new Refused(404, ['no such user']);
      if (u.login_level !== 'technician') throw new Refused(409, ['only technicians have a trade']);
      if (u.trade === b.trade) return { userId, trade: b.trade };
      await c.query('UPDATE users SET trade = $2 WHERE id = $1', [userId, b.trade]);
      const change = `Trade: ${u.trade ? TRADES[u.trade as Trade] : 'none'} → ${b.trade ? TRADES[b.trade] : 'none'}`;
      await c.query('INSERT INTO access_changes (changed_by, user_id, action, change) VALUES ($1, $2, $3, $4)', [req.actor.id, userId, 'trade', change]);
      await audit(c, req.actor.id, 'trade_changed', 'user', userId, { from: u.trade, to: b.trade });
      return { userId, trade: b.trade };
    });
  });

  // The CEO gives each person their position: technician, mechanic, stock controller, manager...
  // The position decides which app opens on their phone and what they may do by default.
  app.get('/access/positions', async req => {
    guard(req);
    const { rows } = await req.db.query(
      `SELECT u.id, u.full_name, u.login_level, u.department_id,
              u.login_level = 'mechanic' OR EXISTS (SELECT 1 FROM access_overrides o WHERE o.user_id = u.id AND o.action = 'manage_fleet' AND o.effect = 'grant') AS does_fleet,
              u.login_level = 'stockroom' OR EXISTS (SELECT 1 FROM access_overrides o WHERE o.user_id = u.id AND o.action = 'manage_stockroom' AND o.effect = 'grant') AS does_stock
         FROM users u WHERE u.status <> 'left' ORDER BY u.full_name`);
    const people = [];
    for (const r of rows) {
      const a = await loadActor(req.db, r.id);
      people.push({ ...r, position: POSITION_LABEL[r.login_level as LoginLevel], work: workOf(a?.perms ?? {}) });
    }
    return {
      positions: LEVELS.map(l => ({ level: l, label: POSITION_LABEL[l] })),
      areas: Object.entries(WORK_AREAS).map(([key, a]) => ({ key, label: a.label })),
      people,
    };
  });

  app.put('/access/users/:id/position', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const full = can(req.actor, 'manage_access');
    if (!full && !can(req.actor, 'set_positions')) throw new Refused(403, ['only the CEO or HR sets positions']);
    const userId = parse(Uuid, req.params.id);
    const b = parse(z.object({ position: z.enum(LEVELS as [LoginLevel, ...LoginLevel[]]) }), req.body);
    return tx(req.db, async c => {
      const u = (await c.query('SELECT full_name, login_level FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
      if (!u) throw new Refused(404, ['no such user']);
      if (u.login_level === b.position) return { userId, position: b.position, label: POSITION_LABEL[b.position] };
      if (!full && (!HR_POSITIONS.includes(u.login_level) || !HR_POSITIONS.includes(b.position))) {
        throw new Refused(403, ['HR sets technician, admin, department manager or stock controller; the other positions are the CEO\'s']);
      }
      if (userId === req.actor.id && !full) throw new Refused(403, ['you cannot change your own position']);
      if ((b.position === 'creator' || u.login_level === 'creator') && req.actor.level !== 'creator') {
        throw new Refused(403, ['only the Creator can give or take the Creator position']);
      }
      await c.query('UPDATE users SET login_level = $2 WHERE id = $1', [userId, b.position]);
      // No longer a department manager: his department has no manager until HR gives it one.
      if (u.login_level === 'management') await c.query('UPDATE departments SET manager_id = NULL WHERE manager_id = $1', [userId]);
      await ensureSomeoneCanManageAccess(c);
      const change = `${POSITION_LABEL[u.login_level as LoginLevel]} → ${POSITION_LABEL[b.position]}`;
      await c.query('INSERT INTO access_changes (changed_by, user_id, action, change) VALUES ($1, $2, $3, $4)', [req.actor.id, userId, 'position', change]);
      await audit(c, req.actor.id, 'position_changed', 'user', userId, { from: u.login_level, to: b.position });
      await notify(c, userId, 'position_changed', `Your position is now ${POSITION_LABEL[b.position]}. Open the app again to see your screens.`, { position: b.position });
      return { userId, position: b.position, label: POSITION_LABEL[b.position] };
    });
  });

  // Small companies have no mechanic of their own: the CEO can give the mechanic's work to as many
  // people as he likes, on top of their own position (an Admin who also looks after the vehicles).
  app.put('/access/users/:id/fleet-duty', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    guard(req);
    const userId = parse(Uuid, req.params.id);
    const b = parse(z.object({ on: z.boolean() }), req.body);
    return tx(req.db, async c => {
      const u = (await c.query("SELECT full_name, login_level FROM users WHERE id = $1 AND status <> 'left'", [userId])).rows[0];
      if (!u) throw new Refused(404, ['no such user']);
      if (u.login_level === 'mechanic') throw new Refused(409, [b.on ? 'already a mechanic' : 'a mechanic by position: change the position instead']);
      for (const action of ['view_fleet', 'manage_fleet'] as Action[]) await writeOverride(c, { userId }, action, { effect: b.on ? 'grant' : 'default', departmentIds: [] }, req.actor.id, false);
      const change = b.on ? `${POSITION_LABEL[u.login_level as LoginLevel]} + mechanic` : `${POSITION_LABEL[u.login_level as LoginLevel]}, no longer mechanic`;
      await c.query('INSERT INTO access_changes (changed_by, user_id, action, change) VALUES ($1, $2, $3, $4)', [req.actor.id, userId, 'fleet_duty', change]);
      await audit(c, req.actor.id, 'fleet_duty', 'user', userId, { on: b.on });
      await notify(c, userId, 'position_changed', b.on ? 'You now also do the mechanic\'s work: open the app again to see the Fleet screens.' : 'You no longer do the mechanic\'s work.', { fleetDuty: b.on });
      return { userId, fleetDuty: b.on, change };
    });
  });

  // Full stockroom access on top of someone's own position (e.g. an Admin who also runs the stockroom).
  const STOCK_ACTIONS = ['manage_stockroom', 'assign_stock', 'run_stocktake'] as Action[];
  app.put('/access/users/:id/stock-duty', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    guard(req);
    const userId = parse(Uuid, req.params.id);
    const b = parse(z.object({ on: z.boolean() }), req.body);
    return tx(req.db, async c => {
      const u = (await c.query("SELECT full_name, login_level FROM users WHERE id = $1 AND status <> 'left'", [userId])).rows[0];
      if (!u) throw new Refused(404, ['no such user']);
      if (u.login_level === 'stockroom') throw new Refused(409, [b.on ? 'already a stock controller' : 'a stock controller by position: change the position instead']);
      for (const action of STOCK_ACTIONS) await writeOverride(c, { userId }, action, { effect: b.on ? 'grant' : 'default', departmentIds: [] }, req.actor.id, false);
      const change = b.on ? `${POSITION_LABEL[u.login_level as LoginLevel]} + stockroom` : `${POSITION_LABEL[u.login_level as LoginLevel]}, no longer stockroom`;
      await c.query('INSERT INTO access_changes (changed_by, user_id, action, change) VALUES ($1, $2, $3, $4)', [req.actor.id, userId, 'stock_duty', change]);
      await audit(c, req.actor.id, 'stock_duty', 'user', userId, { on: b.on });
      await notify(c, userId, 'position_changed', b.on ? 'You now have full stockroom access: open the app again to see the Stockroom screens.' : 'Your stockroom access was taken away.', { stockDuty: b.on });
      return { userId, stockDuty: b.on, change };
    });
  });

  /** The CEO turns a kind of work on or off for one person. The CEO himself always has everything. */
  app.put('/access/users/:id/work', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    guard(req);
    const userId = parse(Uuid, req.params.id);
    const b = parse(z.object({ area: z.enum(Object.keys(WORK_AREAS) as [WorkArea, ...WorkArea[]]), on: z.boolean() }), req.body);
    return tx(req.db, async c => {
      const u = (await c.query("SELECT full_name, login_level FROM users WHERE id = $1 AND status <> 'left'", [userId])).rows[0];
      if (!u) throw new Refused(404, ['no such user']);
      if (u.login_level === 'creator') throw new Refused(409, ['the CEO always has full access']);
      const area = WORK_AREAS[b.area];
      for (const action of area.actions as readonly Action[]) {
        await writeOverride(c, { userId }, action, b.on ? { effect: 'grant', scope: isScoped(action) ? 'all_departments' : undefined, departmentIds: [] } : { effect: 'deny', departmentIds: [] }, req.actor.id, false);
      }
      const change = `${area.label}: ${b.on ? 'on' : 'off'}`;
      await c.query('INSERT INTO access_changes (changed_by, user_id, action, change) VALUES ($1, $2, $3, $4)', [req.actor.id, userId, `work:${b.area}`, change]);
      await audit(c, req.actor.id, 'work_changed', 'user', userId, b);
      await notify(c, userId, 'access_changed', `${b.on ? 'You can now do' : 'You no longer do'}: ${area.label}. Open the app again to see the change.`, { area: b.area, on: b.on });
      const actor = await loadActor(c, userId);
      return { userId, area: b.area, on: b.on, work: workOf(actor?.perms ?? {}) };
    });
  });

  app.put('/access/users/:id/:action', async (req: FastifyRequest<{ Params: { id: string; action: string } }>) => {
    guard(req);
    const userId = parse(Uuid, req.params.id);
    const ch = parse(Change, req.body);
    const action = checkChange(req.params.action, ch);
    await tx(req.db, async c => {
      const u = await c.query('SELECT full_name FROM users WHERE id = $1', [userId]);
      if (!u.rowCount) throw new Refused(404, ['no such user']);
      await checkDepartments(c, ch);
      await writeOverride(c, { userId }, action, ch, req.actor.id);
      await ensureSomeoneCanManageAccess(c);
      await audit(c, req.actor.id, 'access_changed', 'user', userId, { action, change: describe(ch, action) });
      // The person is told when their access changes.
      await notify(c, userId, 'access_changed', `Your access changed: ${CATALOGUE[action].label} – ${describe(ch, action)}`, { action });
    });
    return { userId, action, change: describe(ch, action) };
  });

  app.get('/access/changes', async req => {
    guard(req);
    const { rows } = await req.db.query(
      `SELECT a.at, b.full_name AS changed_by, a.level, u.full_name AS person, a.action, a.change
         FROM access_changes a JOIN users b ON b.id = a.changed_by LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.at DESC LIMIT 500`,
    );
    return rows;
  });
}
