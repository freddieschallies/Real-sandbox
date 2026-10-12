// Departments and van stock.
// Each department has a department manager; technicians in it work under him. The manager sets the
// department's van stock list (bill of quantities). The stockroom puts van stock on a technician
// against that list; a van short of it is flagged until it is complete again.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, tx, type Q } from '../db.ts';
import { can, departmentsFor, seesPeople, type Actor } from '../core/permissions.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { checkVan, listOf, vanReport } from '../vanRepo.ts';
import { notify } from './field.ts';
import { STANDARD_DEPARTMENTS } from '../core/departments.ts';

const MANAGER_LEVELS = ['management', 'director', 'creator'];

async function techsIn(c: Q, departmentId: string) {
  return (await c.query("SELECT id, full_name FROM users WHERE department_id = $1 AND login_level = 'technician' AND status <> 'left' ORDER BY full_name", [departmentId])).rows as { id: string; full_name: string }[];
}
async function deptOfUser(c: Q, id: string) {
  const u = (await c.query('SELECT id, department_id FROM users WHERE id = $1', [id])).rows[0];
  if (!u) throw new Refused(404, ['no such person']);
  return u as { id: string; department_id: string | null };
}
/**
 * Makes him the manager of one department (managers run one department each): he leaves any other
 * department he managed, the department's previous manager is left without one, and his own
 * department becomes this one. Returns the name of the manager he replaced, if any.
 */
async function makeManager(c: Q, managerId: string, departmentId: string): Promise<string | null> {
  const prev = (await c.query('SELECT d.manager_id, m.full_name, m.login_level FROM departments d LEFT JOIN users m ON m.id = d.manager_id WHERE d.id = $1', [departmentId])).rows[0];
  await c.query('UPDATE departments SET manager_id = NULL WHERE manager_id = $1 AND id <> $2', [managerId, departmentId]);
  await c.query('UPDATE departments SET manager_id = $1 WHERE id = $2', [managerId, departmentId]);
  await c.query("UPDATE users SET department_id = $2 WHERE id = $1 AND login_level = 'management'", [managerId, departmentId]);
  if (prev?.manager_id && prev.manager_id !== managerId) {
    if (prev.login_level === 'management') await c.query('UPDATE users SET department_id = NULL WHERE id = $1', [prev.manager_id]);
    return prev.full_name;
  }
  return null;
}
const assigns = (a: Actor) => can(a, 'assign_departments');
const editsList = (a: Actor, departmentId: string) => can(a, 'set_van_stock', { employeeDepartmentId: departmentId });
const seesVan = (a: Actor, u: { id: string; department_id: string | null }) =>
  a.id === u.id || can(a, 'assign_stock') || seesPeople(a) || can(a, 'set_van_stock', { employeeId: u.id, employeeDepartmentId: u.department_id });

export function registerDepartmentRoutes(app: FastifyInstance) {
  // ---- Departments: managers and the technicians under them ----------------------------------
  app.get('/departments', async req => {
    if (!seesPeople(req.actor) && !can(req.actor, 'assign_stock')) throw new Refused(403, ['departments are not part of your work']);
    const departments = (await req.db.query(
      `SELECT d.id, d.name, d.active, d.manager_id, m.full_name AS manager,
              (SELECT count(*) FROM users u WHERE u.department_id = d.id AND u.login_level = 'technician' AND u.status <> 'left')::int AS technicians,
              (SELECT count(*) FROM users u WHERE u.department_id = d.id AND u.status <> 'left')::int AS staff,
              (SELECT count(*) FROM van_stock_lists l WHERE l.department_id = d.id)::int AS van_lines
         FROM departments d LEFT JOIN users m ON m.id = d.manager_id ORDER BY d.name`)).rows as { name: string; active: boolean }[];
    const managers = (await req.db.query(
      `SELECT id, full_name, login_level FROM users WHERE login_level = ANY($1) AND status <> 'left' ORDER BY (login_level = 'management') DESC, full_name`, [MANAGER_LEVELS])).rows;
    // Who works where: everyone below the CEO, each in one department (or none yet). Technicians work
    // under its manager; the office staff are usually in Admin.
    const members = (await req.db.query(
      `SELECT id, full_name, login_level, trade, department_id FROM users
        WHERE login_level NOT IN ('director', 'creator') AND status <> 'left' ORDER BY full_name`)).rows;
    // The usual departments not set up yet, to switch on with one tap.
    const missing = STANDARD_DEPARTMENTS.filter(x => !departments.some(d => d.name.toLowerCase() === x.name.toLowerCase())).map(x => x.name);
    return { canManage: assigns(req.actor), departments, managers, members, missing };
  });

  const Dept = z.object({ name: z.string().trim().min(2, 'the department name').max(60), managerId: Uuid.nullish(), active: z.boolean().optional() });
  async function checkManager(c: Q, managerId: string | null | undefined) {
    if (!managerId) return;
    const m = (await c.query("SELECT login_level FROM users WHERE id = $1 AND status <> 'left'", [managerId])).rows[0];
    if (!m) throw new Refused(404, ['no such person']);
    if (!MANAGER_LEVELS.includes(m.login_level)) throw new Refused(409, ['make the person a Department manager first']);
  }

  app.post('/departments', async req => {
    if (!assigns(req.actor)) throw new Refused(403, ['only HR (or the CEO) sets up departments']);
    const b = parse(Dept, req.body);
    return tx(req.db, async c => {
      await checkManager(c, b.managerId);
      const same = (await c.query('SELECT id, active FROM departments WHERE lower(name) = lower($1)', [b.name])).rows[0];
      if (same?.active) throw new Refused(409, [`there is already a ${b.name} department`]);
      // Switched off before: switch it back on (with its van stock list).
      const d = same ? (await c.query('UPDATE departments SET active = true WHERE id = $1 RETURNING id', [same.id])).rows[0]
        : (await c.query('INSERT INTO departments (name) VALUES ($1) RETURNING id', [b.name])).rows[0];
      if (b.managerId) await makeManager(c, b.managerId, d.id);
      await audit(c, req.actor.id, 'department_created', 'department', d.id, b);
      if (b.managerId) await notify(c, b.managerId, 'department', `You manage the ${b.name} department.`);
      return { id: d.id };
    });
  });

  app.put('/departments/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!assigns(req.actor)) throw new Refused(403, ['only HR (or the CEO) sets up departments']);
    const id = parse(Uuid, req.params.id);
    const b = parse(Dept.partial(), req.body);
    return tx(req.db, async c => {
      const d = (await c.query('SELECT name, manager_id, active FROM departments WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!d) throw new Refused(404, ['no such department']);
      if (b.active === false && d.active) {
        // Off only once nobody works in it: they are moved first, so nobody is left without a department by surprise.
        const n = (await c.query("SELECT count(*)::int AS n FROM users WHERE department_id = $1 AND status <> 'left'", [id])).rows[0].n;
        if (n || d.manager_id) throw new Refused(409, [`move everyone in ${d.name} (${Math.max(n, 1)} ${Math.max(n, 1) === 1 ? 'person' : 'people'}) to another department first`]);
        if (b.managerId) throw new Refused(409, ['a switched-off department has no manager']);
      }
      if (b.active === undefined && !d.active && b.managerId) throw new Refused(409, [`switch ${d.name} on first`]);
      await checkManager(c, b.managerId);
      if (b.name && (await c.query('SELECT 1 FROM departments WHERE lower(name) = lower($1) AND id <> $2', [b.name, id])).rowCount) throw new Refused(409, [`there is already a ${b.name} department`]);
      if (b.name) await c.query('UPDATE departments SET name = $2 WHERE id = $1', [id, b.name]);
      if (b.active !== undefined) await c.query('UPDATE departments SET active = $2 WHERE id = $1', [id, b.active]);
      let replaced: string | null = null;
      if (b.managerId) replaced = await makeManager(c, b.managerId, id);
      else if (b.managerId === null && d.manager_id) {
        await c.query('UPDATE departments SET manager_id = NULL WHERE id = $1', [id]);
        await c.query("UPDATE users SET department_id = NULL WHERE id = $1 AND login_level = 'management'", [d.manager_id]);
      }
      await audit(c, req.actor.id, 'department_changed', 'department', id, b);
      if (b.managerId && b.managerId !== d.manager_id) await notify(c, b.managerId, 'department', `You manage the ${b.name ?? d.name} department.`);
      return { id, replaced };
    });
  });

  // Puts a person in one department: a technician works under its manager; a department manager
  // becomes its manager (one department each).
  app.put('/access/users/:id/department', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!assigns(req.actor)) throw new Refused(403, ['only HR (or the CEO) puts people in departments']);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ departmentId: Uuid.nullable() }), req.body);
    return tx(req.db, async c => {
      const u = (await c.query("SELECT u.full_name, u.login_level, d.name AS dept FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = $1 AND u.status <> 'left'", [id])).rows[0];
      if (!u) throw new Refused(404, ['no such person']);
      const d = b.departmentId ? (await c.query('SELECT d.name, d.active, m.full_name AS manager FROM departments d LEFT JOIN users m ON m.id = d.manager_id WHERE d.id = $1', [b.departmentId])).rows[0] : null;
      if (b.departmentId && !d) throw new Refused(404, ['no such department']);
      if (d && !d.active) throw new Refused(409, [`${d.name} is switched off: switch it on under Departments first`]);
      let replaced: string | null = null;
      if (u.login_level === 'management') {
        if (b.departmentId) replaced = await makeManager(c, id, b.departmentId);
        else { await c.query('UPDATE departments SET manager_id = NULL WHERE manager_id = $1', [id]); await c.query('UPDATE users SET department_id = NULL WHERE id = $1', [id]); }
      } else await c.query('UPDATE users SET department_id = $2 WHERE id = $1', [id, b.departmentId]);
      await c.query('INSERT INTO access_changes (changed_by, user_id, action, change) VALUES ($1, $2, $3, $4)',
        [req.actor.id, id, 'department', `Department: ${u.dept ?? 'none'} → ${d?.name ?? 'none'}`]);
      await audit(c, req.actor.id, 'department_set', 'user', id, b);
      if (d) await notify(c, id, 'department', u.login_level === 'management' ? `You manage the ${d.name} department.` : `You are now in the ${d.name} department${d.manager ? `, under ${d.manager}` : ''}.`);
      const van = u.login_level === 'technician' ? await checkVan(c, id, req.actor.id) : null;
      return { userId: id, departmentId: b.departmentId, manages: u.login_level === 'management' ? b.departmentId : null, replaced, van: van ? { complete: van.complete, shortLines: van.shortLines } : null };
    });
  });

  // ---- Van stock lists ------------------------------------------------------------------------
  // The lists the person can see: his own department's (a department manager), all (CEO, stockroom).
  app.get('/van-stock', async req => {
    const scope = departmentsFor(req.actor, 'set_van_stock');
    const all = scope === 'all' || can(req.actor, 'assign_stock') || seesPeople(req.actor);
    if (!all && !scope) throw new Refused(403, ['van stock lists are not part of your work']);
    return tx(req.db, async c => {
      const depts = (await c.query(
        `SELECT d.id, d.name, m.full_name AS manager FROM departments d LEFT JOIN users m ON m.id = d.manager_id
          WHERE d.active AND ($1::boolean OR d.id = ANY($2)) ORDER BY (d.id = ANY($2)) DESC, d.name`, [all, scope === 'all' ? [] : scope ?? []])).rows;
      const out = [];
      for (const d of depts) {
        const lines = await listOf(c, d.id);
        const techs = [];
        for (const t of await techsIn(c, d.id)) {
          const r = (await vanReport(c, t.id))!;
          techs.push({ id: t.id, full_name: t.full_name, complete: r.complete, shortLines: r.shortLines });
        }
        out.push({ ...d, canEdit: editsList(req.actor, d.id), lines: lines.map(l => ({ stockItemId: l.stock_item_id, code: l.code, description: l.description, unit: l.unit, qty: l.qty })), techs });
      }
      return { departments: out };
    });
  });

  // Sets how many of an item every technician in the department must carry (0 takes it off the list).
  app.put('/van-stock/departments/:id/items/:stockItemId', async (req: FastifyRequest<{ Params: { id: string; stockItemId: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const itemId = parse(Uuid, req.params.stockItemId);
    const b = parse(z.object({ qty: z.number().min(0).max(10_000) }), req.body);
    if (!editsList(req.actor, id)) throw new Refused(403, ['only the department\'s manager (or the CEO) sets its van stock list']);
    return tx(req.db, async c => {
      if (!(await c.query('SELECT 1 FROM departments WHERE id = $1', [id])).rowCount) throw new Refused(404, ['no such department']);
      const it = (await c.query('SELECT description, category, active FROM stock_items WHERE id = $1', [itemId])).rows[0];
      if (!it || !it.active) throw new Refused(404, ['no such stock item']);
      if (it.category !== 'stock') throw new Refused(409, [`${it.description} is ${it.category === 'ppe' ? 'PPE' : 'a tool'}: those are issued by name, not carried as van stock`]);
      const old = (await c.query('SELECT qty::float AS qty FROM van_stock_lists WHERE department_id = $1 AND stock_item_id = $2', [id, itemId])).rows[0]?.qty ?? null;
      if (b.qty === 0) await c.query('DELETE FROM van_stock_lists WHERE department_id = $1 AND stock_item_id = $2', [id, itemId]);
      else await c.query(
        `INSERT INTO van_stock_lists (department_id, stock_item_id, qty, set_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, department_id, stock_item_id) DO UPDATE SET qty = EXCLUDED.qty, set_by = EXCLUDED.set_by, set_at = now()`, [id, itemId, b.qty, req.actor.id]);
      if (old !== (b.qty || null)) {
        await c.query('INSERT INTO van_stock_list_changes (department_id, stock_item_id, old_qty, new_qty, changed_by) VALUES ($1, $2, $3, $4, $5)', [id, itemId, old, b.qty || null, req.actor.id]);
      }
      const techs = [];
      for (const t of await techsIn(c, id)) {
        const r = (await checkVan(c, t.id, req.actor.id))!;
        techs.push({ id: t.id, full_name: t.full_name, complete: r.complete, shortLines: r.shortLines });
      }
      return { departmentId: id, stockItemId: itemId, qty: b.qty, techs };
    });
  });

  app.get('/van-stock/departments/:id/changes', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    if (!editsList(req.actor, id) && !can(req.actor, 'assign_stock')) throw new Refused(403, ['not your department']);
    return (await req.db.query(
      `SELECT x.changed_at, u.full_name AS by, i.code, i.description, x.old_qty::float AS old_qty, x.new_qty::float AS new_qty
         FROM van_stock_list_changes x JOIN users u ON u.id = x.changed_by JOIN stock_items i ON i.id = x.stock_item_id
        WHERE x.department_id = $1 ORDER BY x.changed_at DESC LIMIT 200`, [id])).rows;
  });

  // One technician's van against his list.
  app.get('/van-stock/technicians/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const u = await deptOfUser(req.db, id);
    if (!seesVan(req.actor, u)) throw new Refused(403, ['not your technician']);
    return { ...(await vanReport(req.db, id)), canIssue: can(req.actor, 'assign_stock') };
  });
  app.get('/me/van', async req => ({ ...(await vanReport(req.db, req.actor.id)), canIssue: false }));

  // The stockroom puts van stock on a technician (to complete his list, or anything extra).
  app.post('/van-stock/technicians/:id/issue', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!can(req.actor, 'assign_stock')) throw new Refused(403, ['the stockroom issues van stock']);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ lines: z.array(z.object({ stockItemId: Uuid, qty: z.number().positive().max(10_000) })).min(1).max(100) }), req.body);
    return tx(req.db, async c => {
      const u = (await c.query("SELECT full_name, login_level FROM users WHERE id = $1 AND status <> 'left'", [id])).rows[0];
      if (!u) throw new Refused(404, ['no such person']);
      if (u.login_level !== 'technician') throw new Refused(409, ['van stock is for technicians']);
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`stock:${id}`]);
      const problems: string[] = [];
      const items = [];
      for (const l of b.lines) {
        const it = (await c.query('SELECT i.code, i.description, i.category, COALESCE(s.qty, 0)::float AS on_hand FROM stock_items i LEFT JOIN stockroom_stock s ON s.stock_item_id = i.id WHERE i.id = $1', [l.stockItemId])).rows[0];
        if (!it) { problems.push('unknown stock item'); continue; }
        if (it.category !== 'stock') problems.push(`${it.code} is ${it.category === 'ppe' ? 'PPE' : 'a tool'}: issue it by name on his People page`);
        else if (it.on_hand < l.qty) problems.push(`${it.code}: only ${it.on_hand} in the stockroom`);
        items.push({ ...it, ...l });
      }
      if (problems.length) throw new Refused(409, problems);
      for (const l of items) {
        await c.query(`INSERT INTO stock_movements (stock_item_id, qty, kind, from_stockroom, to_technician_id, note, created_by) VALUES ($1, $2, 'assign', true, $3, 'Van stock', $4)`,
          [l.stockItemId, l.qty, id, req.actor.id]);
      }
      await audit(c, req.actor.id, 'van_stock_issued', 'user', id, { lines: b.lines });
      await notify(c, id, 'van_stock', `Van stock put on your name: ${items.map(i => `${i.description} × ${i.qty}`).join(', ')}`);
      return checkVan(c, id, req.actor.id);
    });
  });
}
