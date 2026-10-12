// Staff records (issues, warnings, commendations) and each person's tools and PPE.
// Staff records: only the CEO and whoever the CEO gives "Staff records (HR)" read, add or delete them.
// Tools and PPE: the stockroom keeps the list; the office can see it; each person sees their own.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, tx, type Q } from '../db.ts';
import { notify } from './field.ts';
import { POSITION_LABEL, TRADES, can, seesPeople, type Actor, type LoginLevel, type Trade } from '../core/permissions.ts';
import { DateOnly, Refused, Uuid, parse } from '../http.ts';

export const ENTRY_TYPES = {
  observation: 'Issue / note', verbal_warning: 'Verbal warning', written_warning: 'Written warning',
  final_written_warning: 'Final written warning', commendation: 'Commendation', correction: 'Correction',
} as const;
type EntryType = keyof typeof ENTRY_TYPES;
const WARNINGS: EntryType[] = ['verbal_warning', 'written_warning', 'final_written_warning'];

async function person(c: Q, id: string) {
  const u = (await c.query('SELECT id, full_name, department_id FROM users WHERE id = $1', [id])).rows[0];
  if (!u) throw new Refused(404, ['no such person']);
  return u as { id: string; full_name: string; department_id: string | null };
}
const subject = (u: { id: string; department_id: string | null }) => ({ employeeId: u.id, employeeDepartmentId: u.department_id });

export const recordsAllowed = (a: Actor, u: { id: string; department_id: string | null }) => ({
  read: can(a, 'view_employee_log', subject(u)) && a.id !== u.id, write: can(a, 'write_employee_log', subject(u)) && a.id !== u.id,
});
export const kitAllowed = (a: Actor, userId: string) => ({
  read: a.id === userId || can(a, 'assign_stock') || seesPeople(a), write: can(a, 'assign_stock'),
});

async function kitList(c: Q, userId: string) {
  const rows = (await c.query(
    `SELECT k.id, k.kind, k.name, k.detail, k.qty::float AS qty, k.stock_item_id, i.code AS stock_code, to_char(k.replace_by, 'YYYY-MM-DD') AS replace_by,
            k.issued_at, ib.full_name AS issued_by, k.status, k.closed_at, cb.full_name AS closed_by, k.close_note
       FROM person_kit k JOIN users ib ON ib.id = k.issued_by LEFT JOIN users cb ON cb.id = k.closed_by LEFT JOIN stock_items i ON i.id = k.stock_item_id
      WHERE k.user_id = $1 ORDER BY (k.status = 'issued') DESC, k.kind DESC, k.name, k.issued_at DESC`, [userId])).rows;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
  const held = rows.filter(r => r.status === 'issued').map(r => ({ ...r, due: !!r.replace_by && r.replace_by <= today }));
  return { held, history: rows.filter(r => r.status !== 'issued'), dueForReplacement: held.filter(r => r.due).length };
}

export function registerStaffRoutes(app: FastifyInstance) {
  // ---- Staff records ----------------------------------------------------------------------
  app.get('/people/:id/record', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const u = await person(c, id);
      const may = recordsAllowed(req.actor, u);
      if (!may.read) throw new Refused(403, ['staff records are for the CEO and HR only']);
      await c.query('INSERT INTO log_views (employee_id, viewer_id) VALUES ($1, $2)', [id, req.actor.id]);
      const entries = (await c.query(
        `SELECT e.id, e.entry_type, to_char(e.happened_on, 'YYYY-MM-DD') AS happened_on, e.what_happened, e.action_taken, e.reason, e.corrects_entry_id,
                e.linked_job_id, j.job_number, e.created_at, a.full_name AS author
           FROM employee_log_entries e JOIN users a ON a.id = e.author_id LEFT JOIN jobs j ON j.id = e.linked_job_id
          WHERE e.employee_id = $1 ORDER BY e.happened_on DESC, e.created_at DESC`, [id])).rows
        .map(e => ({ ...e, typeLabel: ENTRY_TYPES[e.entry_type as EntryType] }));
      const deletions = (await c.query(
        `SELECT to_char(d.entry_happened_on, 'YYYY-MM-DD') AS entry_happened_on, d.deleted_at, u.full_name AS deleted_by
           FROM employee_log_deletions d JOIN users u ON u.id = d.deleted_by WHERE d.employee_id = $1 ORDER BY d.deleted_at DESC`, [id])).rows;
      const active = (t: string) => entries.filter(e => e.entry_type === t).length;
      return {
        canWrite: may.write, types: Object.entries(ENTRY_TYPES).filter(([k]) => k !== 'correction').map(([key, label]) => ({ key, label, warning: WARNINGS.includes(key as EntryType) })),
        summary: { issues: active('observation'), verbal: active('verbal_warning'), written: active('written_warning'), final: active('final_written_warning'), commendations: active('commendation') },
        entries, deletions,
      };
    });
  });

  app.post('/people/:id/record', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({
      type: z.enum(Object.keys(ENTRY_TYPES) as [EntryType, ...EntryType[]]), happenedOn: DateOnly.optional(),
      whatHappened: z.string().trim().min(5, 'say what happened').max(4000), actionTaken: z.string().trim().max(2000).optional(), reason: z.string().trim().max(2000).optional(),
      correctsEntryId: Uuid.optional(), jobId: Uuid.optional(),
    }), req.body);
    return tx(req.db, async c => {
      const u = await person(c, id);
      if (!recordsAllowed(req.actor, u).write) throw new Refused(403, ['only the CEO and HR add staff records']);
      const missing: string[] = [];
      if (WARNINGS.includes(b.type)) {
        if (!b.actionTaken || b.actionTaken.length < 3) missing.push('the action taken (a warning must say what was done)');
        if (!b.reason || b.reason.length < 3) missing.push('the reason for the warning');
      }
      if (b.type === 'correction' && !b.correctsEntryId) missing.push('which record this corrects');
      if (missing.length) throw new Refused(400, missing);
      if (b.happenedOn && b.happenedOn > new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' })) throw new Refused(400, ['the date cannot be in the future']);
      if (b.correctsEntryId && !(await c.query('SELECT 1 FROM employee_log_entries WHERE id = $1 AND employee_id = $2', [b.correctsEntryId, id])).rowCount) throw new Refused(404, ['no such record for this person']);
      const r = await c.query(
        `INSERT INTO employee_log_entries (employee_id, author_id, entry_type, what_happened, action_taken, reason, corrects_entry_id, linked_job_id, happened_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, current_date)) RETURNING id`,
        [id, req.actor.id, b.type, b.whatHappened, b.actionTaken || null, b.reason || null, b.correctsEntryId ?? null, b.jobId ?? null, b.happenedOn ?? null]);
      await audit(c, req.actor.id, 'staff_record_added', 'user', id, { type: b.type });
      return { id: r.rows[0].id };
    });
  });

  app.delete('/people/:id/record/:entryId', async (req: FastifyRequest<{ Params: { id: string; entryId: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const entryId = parse(Uuid, req.params.entryId);
    return tx(req.db, async c => {
      const u = await person(c, id);
      if (!recordsAllowed(req.actor, u).write) throw new Refused(403, ['only the CEO and HR delete staff records']);
      const e = (await c.query("SELECT to_char(happened_on, 'YYYY-MM-DD') AS d FROM employee_log_entries WHERE id = $1 AND employee_id = $2", [entryId, id])).rows[0];
      if (!e) throw new Refused(404, ['no such record']);
      // Corrections of this record go with it.
      const gone = (await c.query('DELETE FROM employee_log_entries WHERE id = $1 OR corrects_entry_id = $1 RETURNING id', [entryId])).rowCount ?? 1;
      await c.query('INSERT INTO employee_log_deletions (employee_id, entry_happened_on, deleted_by) VALUES ($1, $2, $3)', [id, e.d, req.actor.id]);
      await audit(c, req.actor.id, 'staff_record_deleted', 'user', id, { happenedOn: e.d });
      return { deleted: gone };
    });
  });

  // ---- Tools and PPE ------------------------------------------------------------------------
  app.get('/people/:id/kit', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    if (!kitAllowed(req.actor, id).read) throw new Refused(403, ['not your list']);
    await person(req.db, id);
    return { ...(await kitList(req.db, id)), canWrite: kitAllowed(req.actor, id).write };
  });
  // The stockroom's People: names with their PPE, tools and stock, and nothing personal (no contact
  // details, no ID number, no address, not where they are).
  app.get('/kit/people', async req => {
    if (!can(req.actor, 'assign_stock')) throw new Refused(403, ['the stockroom keeps tools and PPE']);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
    const rows = (await req.db.query(
      `SELECT u.id, u.full_name, u.login_level, u.trade, p.photo_id,
              count(k.id) FILTER (WHERE k.status = 'issued' AND k.kind = 'tool')::int AS tools,
              count(k.id) FILTER (WHERE k.status = 'issued' AND k.kind = 'ppe')::int AS ppe,
              count(k.id) FILTER (WHERE k.status = 'issued' AND k.replace_by <= $1::date)::int AS due,
              COALESCE((SELECT SUM(h.qty) FROM technician_holdings h WHERE h.technician_id = u.id AND h.qty > 0), 0)::float AS stock
         FROM users u LEFT JOIN person_kit k ON k.user_id = u.id LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE u.status <> 'left' GROUP BY u.id, p.photo_id ORDER BY (u.login_level = 'technician') DESC, u.full_name`, [today])).rows;
    return rows.map(r => ({ ...r, position: POSITION_LABEL[r.login_level as LoginLevel], tradeLabel: r.trade ? TRADES[r.trade as Trade] : null }));
  });

  app.get('/me/kit', async req => ({ ...(await kitList(req.db, req.actor.id)), canWrite: false }));

  app.post('/people/:id/kit', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    if (!kitAllowed(req.actor, id).write) throw new Refused(403, ['the stockroom keeps tools and PPE']);
    const b = parse(z.object({
      kind: z.enum(['tool', 'ppe']), name: z.string().trim().min(2, 'what the item is').max(120).optional(), detail: z.string().trim().max(200).optional(),
      qty: z.number().positive().max(1000).default(1), stockItemId: Uuid.optional(), replaceBy: DateOnly.optional(),
    }), req.body);
    return tx(req.db, async c => {
      const u = await person(c, id);
      let name = b.name;
      if (b.stockItemId) {
        const s = (await c.query('SELECT i.description, i.category, COALESCE(s.qty, 0)::float AS on_hand FROM stock_items i LEFT JOIN stockroom_stock s ON s.stock_item_id = i.id WHERE i.id = $1', [b.stockItemId])).rows[0];
        if (!s) throw new Refused(404, ['no such stock item']);
        if (s.category !== b.kind) throw new Refused(409, [`${s.description} is ${s.category === 'stock' ? 'stock (parts for jobs)' : s.category === 'ppe' ? 'PPE' : 'a tool'}, not ${b.kind === 'ppe' ? 'PPE' : 'a tool'}`]);
        if (s.on_hand < b.qty) throw new Refused(409, [`only ${s.on_hand} in the stockroom`]);
        name ??= s.description;
      }
      if (!name) throw new Refused(400, ['what the item is']);
      const k = (await c.query(
        `INSERT INTO person_kit (user_id, kind, name, detail, qty, stock_item_id, replace_by, issued_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [id, b.kind, name, b.detail || null, b.qty, b.stockItemId ?? null, b.replaceBy ?? null, req.actor.id])).rows[0];
      if (b.stockItemId) {
        await c.query(`INSERT INTO stock_movements (stock_item_id, qty, kind, from_stockroom, person_kit_id, note, created_by) VALUES ($1, $2, 'issue_kit', true, $3, $4, $5)`,
          [b.stockItemId, b.qty, k.id, `${b.kind === 'ppe' ? 'PPE' : 'Tool'} issued to ${u.full_name}`, req.actor.id]);
      }
      await audit(c, req.actor.id, 'kit_issued', 'user', id, { kind: b.kind, name, qty: b.qty });
      await notify(c, id, 'kit_issued', `${b.kind === 'ppe' ? 'PPE' : 'A tool'} was put on your name: ${name}${b.qty !== 1 ? ` × ${b.qty}` : ''}.`, { kitId: k.id });
      return { id: k.id };
    });
  });

  app.post('/kit/:kitId/close', async (req: FastifyRequest<{ Params: { kitId: string } }>) => {
    const kitId = parse(Uuid, req.params.kitId);
    const b = parse(z.object({ status: z.enum(['returned', 'lost', 'damaged']), note: z.string().trim().max(1000).optional(), backToStock: z.boolean().default(true) }), req.body);
    return tx(req.db, async c => {
      const k = (await c.query("SELECT k.*, u.full_name FROM person_kit k JOIN users u ON u.id = k.user_id WHERE k.id = $1", [kitId])).rows[0];
      if (!k) throw new Refused(404, ['no such item']);
      if (!kitAllowed(req.actor, k.user_id).write) throw new Refused(403, ['the stockroom keeps tools and PPE']);
      if (k.status !== 'issued') throw new Refused(409, [`this item is already ${k.status}`]);
      if (b.status !== 'returned' && (!b.note || b.note.length < 5)) throw new Refused(400, [`say how it was ${b.status}`]);
      await c.query("UPDATE person_kit SET status = $2, closed_by = $3, closed_at = now(), close_note = $4 WHERE id = $1", [kitId, b.status, req.actor.id, b.note || null]);
      if (b.status === 'returned' && k.stock_item_id && b.backToStock) {
        await c.query(`INSERT INTO stock_movements (stock_item_id, qty, kind, to_stockroom, person_kit_id, note, created_by) VALUES ($1, $2, 'return_kit', true, $3, $4, $5)`,
          [k.stock_item_id, k.qty, kitId, `Returned by ${k.full_name}`, req.actor.id]);
      }
      await audit(c, req.actor.id, `kit_${b.status}`, 'user', k.user_id, { kitId, note: b.note ?? null });
      return { id: kitId, status: b.status };
    });
  });

  app.put('/kit/:kitId', async (req: FastifyRequest<{ Params: { kitId: string } }>) => {
    const kitId = parse(Uuid, req.params.kitId);
    const b = parse(z.object({ detail: z.string().trim().max(200).nullish(), replaceBy: DateOnly.nullish() }), req.body);
    if (!can(req.actor, 'assign_stock')) throw new Refused(403, ['the stockroom keeps tools and PPE']);
    return tx(req.db, async c => {
      const k = (await c.query('SELECT status FROM person_kit WHERE id = $1', [kitId])).rows[0];
      if (!k) throw new Refused(404, ['no such item']);
      if (k.status !== 'issued') throw new Refused(409, [`this item is already ${k.status}`]);
      await c.query('UPDATE person_kit SET detail = CASE WHEN $2 THEN $3 ELSE detail END, replace_by = CASE WHEN $4 THEN $5::date ELSE replace_by END WHERE id = $1',
        [kitId, b.detail !== undefined, b.detail || null, b.replaceBy !== undefined, b.replaceBy ?? null]);
      return { id: kitId };
    });
  });
}
