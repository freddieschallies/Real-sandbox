// Van stock: what each technician must carry (his department's list) against what is on his van.
import type { Q } from './db.ts';
import { raiseFlag } from './db.ts';
import * as S from './core/stock.ts';

async function notify(c: Q, to: string | null, kind: string, message: string, details: object = {}) {
  if (!to) return;
  await c.query('INSERT INTO notifications (recipient_id, kind, message, details) VALUES ($1, $2, $3, $4)', [to, kind, message, JSON.stringify(details)]);
}

/** What is on his van (not booked to a job), less anything already on its way back. */
export async function vanOf(c: Q, technicianId: string): Promise<Map<string, number>> {
  const { rows } = await c.query(
    `SELECT h.stock_item_id, (h.qty - COALESCE(p.qty, 0))::float AS qty
       FROM technician_holdings h
       LEFT JOIN pending_returns p ON p.technician_id = h.technician_id AND p.stock_item_id = h.stock_item_id AND p.holding_job_id IS NULL
      WHERE h.technician_id = $1 AND h.holding_job_id IS NULL`, [technicianId]);
  return new Map(rows.filter(r => r.qty > 0).map(r => [r.stock_item_id, Number(r.qty)]));
}

export async function listOf(c: Q, departmentId: string | null) {
  if (!departmentId) return [];
  return (await c.query(
    `SELECT l.stock_item_id, l.qty::float AS qty, i.code, i.description, i.unit FROM van_stock_lists l JOIN stock_items i ON i.id = l.stock_item_id
      WHERE l.department_id = $1 ORDER BY i.description`, [departmentId])).rows as { stock_item_id: string; qty: number; code: string; description: string; unit: string }[];
}

/** His van against his department's list, line by line, with what is extra (not on the list). */
export async function vanReport(c: Q, technicianId: string) {
  const u = (await c.query(
    `SELECT u.id, u.full_name, u.department_id, d.name AS department, m.full_name AS manager FROM users u
       LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN users m ON m.id = d.manager_id WHERE u.id = $1`, [technicianId])).rows[0];
  if (!u) return null;
  const list = await listOf(c, u.department_id);
  const van = await vanOf(c, technicianId);
  const chk = S.vanCheck(list.map(l => ({ stockItemId: l.stock_item_id, qty: l.qty })), van);
  const info = new Map(list.map(l => [l.stock_item_id, l]));
  const extraIds = [...van.keys()].filter(id => !info.has(id));
  const extra = extraIds.length ? (await c.query('SELECT id, code, description, unit FROM stock_items WHERE id = ANY($1) ORDER BY description', [extraIds])).rows
    .map(i => ({ stockItemId: i.id, code: i.code, description: i.description, unit: i.unit, have: van.get(i.id)! })) : [];
  return {
    technicianId, name: u.full_name, departmentId: u.department_id, department: u.department, manager: u.manager,
    hasList: list.length > 0, complete: chk.complete, shortLines: chk.shortLines,
    lines: chk.lines.map(l => ({ ...l, code: info.get(l.stockItemId)!.code, description: info.get(l.stockItemId)!.description, unit: info.get(l.stockItemId)!.unit })),
    extra,
  };
}

/**
 * Checks his van after anything that changes it or his list. Short of the list: an open flag (one
 * at a time) says what is missing, for his manager and the stockroom. Complete again: the flag
 * closes itself, saying who completed it.
 */
export async function checkVan(c: Q, technicianId: string, by: string) {
  const r = await vanReport(c, technicianId);
  if (!r) return null;
  const open = (await c.query("SELECT id FROM flags WHERE technician_id = $1 AND flag_type = 'van_stock_short' AND status <> 'resolved' FOR UPDATE", [technicianId])).rows[0];
  const short = r.lines.filter(l => l.short > 0).map(l => ({ code: l.code, description: l.description, need: l.need, have: l.have, short: l.short }));
  if (short.length) {
    const text = short.map(s => `${s.description} ${s.have} of ${s.need}`).join(', ');
    if (open) {
      await c.query('UPDATE flags SET details = $2, question = $3 WHERE id = $1', [open.id, JSON.stringify({ short }), `Your van is short of the ${r.department} van stock list: ${text}. The stockroom tops it up.`]);
    } else {
      await raiseFlag(c, { type: 'van_stock_short', technicianId, severity: 'normal', question: `Your van is short of the ${r.department} van stock list: ${text}. The stockroom tops it up.`, details: { short } });
      {
        const mgr = (await c.query('SELECT d.manager_id FROM departments d WHERE d.id = $1', [r.departmentId])).rows[0]?.manager_id ?? null;
        await notify(c, mgr, 'van_stock_short', `${r.name}'s van is short: ${text}`, { technicianId });
        const ctl = (await c.query(`SELECT id FROM users u WHERE status <> 'left' AND (login_level = 'stockroom'
           OR EXISTS (SELECT 1 FROM access_overrides o WHERE o.user_id = u.id AND o.action = 'assign_stock' AND o.effect = 'grant'))`)).rows;
        for (const x of ctl) await notify(c, x.id, 'van_stock_short', `${r.name}'s van is short of the van stock list: ${text}`, { technicianId });
      }
    }
  } else if (open) {
    await c.query("UPDATE flags SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution_note = $3 WHERE id = $1",
      [open.id, by, r.hasList ? 'Van stock complete again' : 'No van stock list for his department any more']);
  }
  return r;
}
