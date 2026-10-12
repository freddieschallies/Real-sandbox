// Supply runs, timesheets and the flags inbox.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import { checkVan } from '../vanRepo.ts';
import { audit, raiseFlag, tx } from '../db.ts';
import { can, departmentsFor } from '../core/permissions.ts';
import { DateOnly, Iso, Refused, Uuid, parse } from '../http.ts';
import { isOnJob } from '../jobsRepo.ts';
import { managerOf, notify } from './field.ts';

export const TIMESHEET_TOLERANCE_MIN = 15;

/** Working-day date (SAST) of a timestamp. */
const sastDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

export function registerOfficeRoutes(app: FastifyInstance, db: Db) {
  // ---- Supply runs ------------------------------------------------------------

  app.post('/supply-runs', async (req, reply) => {
    const b = parse(z.object({
      id: Uuid.optional(),
      at: Iso,
      purpose: z.enum(['job_parts', 'stock_topup']),
      jobId: Uuid.optional(),
      supplierId: Uuid.optional(),
      newSupplierName: z.string().trim().min(2).max(200).optional(),
    }).refine(x => !!x.supplierId !== !!x.newSupplierName, 'choose a supplier or type a new one'), req.body);
    const me = req.actor.id;
    const out = await tx(req.db, async c => {
      const open = await c.query("SELECT 1 FROM supply_runs WHERE technician_id = $1 AND status IN ('awaiting_approval', 'approved')", [me]);
      if (open.rowCount) throw new Refused(409, ['finish your open supply run first']);
      if (b.purpose === 'job_parts') {
        if (!b.jobId) throw new Refused(400, ['which job are the parts for?']);
        if (!(await isOnJob(c, b.jobId, me))) throw new Refused(403, ['you are not on that job']);
      }
      let supplierId = b.supplierId;
      let isNew = false;
      if (b.newSupplierName) {
        const existing = await c.query("SELECT id FROM suppliers WHERE lower(name) = lower($1) AND status <> 'rejected'", [b.newSupplierName]);
        if (existing.rows[0]) supplierId = existing.rows[0].id;
        else {
          supplierId = (await c.query("INSERT INTO suppliers (name, first_named_by) VALUES ($1, $2) RETURNING id", [b.newSupplierName, me])).rows[0].id;
          isNew = true;
        }
      } else {
        const s = await c.query("SELECT status FROM suppliers WHERE id = $1", [supplierId]);
        if (!s.rowCount) throw new Refused(404, ['unknown supplier']);
        if (s.rows[0].status === 'rejected') throw new Refused(409, ['management rejected this supplier']);
      }
      const selfApprove = (await c.query('SELECT may_approve_own_topups FROM technician_settings WHERE user_id = $1', [me])).rows[0]?.may_approve_own_topups ?? false;
      const needsApproval = b.purpose === 'stock_topup' && !selfApprove;
      const id = b.id ?? randomUUID();
      await c.query(
        `INSERT INTO supply_runs (id, technician_id, supplier_id, purpose, job_id, started_at, status, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, me, supplierId, b.purpose, b.jobId ?? null, b.at, needsApproval ? 'awaiting_approval' : 'approved',
         needsApproval ? null : (b.purpose === 'stock_topup' ? me : null), needsApproval ? null : b.at],
      );
      const mgr = await managerOf(c, me);
      if (needsApproval) await notify(c, mgr, 'topup_approval', 'Van stock top-up run waiting for your approval', { supplyRunId: id });
      if (isNew) {
        await notify(c, mgr, 'new_supplier', `New supplier named on a supply run: ${b.newSupplierName}`, { supplierId, supplyRunId: id });
        await raiseFlag(c, { type: 'new_supplier', technicianId: me, severity: 'low', details: { supplierId, name: b.newSupplierName, supplyRunId: id } });
      }
      return { id, status: needsApproval ? 'awaiting_approval' : 'approved', supplierId, newSupplier: isNew };
    });
    return reply.code(201).send(out);
  });

  app.post('/supply-runs/:id/approve', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const r = (await c.query(
        `SELECT s.status, s.technician_id, u.department_id FROM supply_runs s JOIN users u ON u.id = s.technician_id WHERE s.id = $1 FOR UPDATE OF s`,
        [id],
      )).rows[0];
      if (!r) throw new Refused(404, ['no such supply run']);
      if (!can(req.actor, 'resolve_flags', { employeeId: r.technician_id, employeeDepartmentId: r.department_id })) throw new Refused(403, ['you do not have approval rights for this technician']);
      if (r.status !== 'awaiting_approval') throw new Refused(409, ['this run is not waiting for approval']);
      await c.query("UPDATE supply_runs SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1", [id, req.actor.id]);
      await notify(c, r.technician_id, 'topup_approved', 'Your van stock top-up run is approved', { supplyRunId: id });
      return { id, status: 'approved' };
    });
  });

  app.post('/supply-runs/:id/collect', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({
      at: Iso, slipPhotoId: Uuid, slipAmountCents: z.number().int().min(0).optional(),
      stock: z.array(z.object({ stockItemId: Uuid, qty: z.number().positive() })).default([]),
    }), req.body);
    const me = req.actor.id;
    return tx(req.db, async c => {
      const r = (await c.query('SELECT status, technician_id, job_id FROM supply_runs WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r || r.technician_id !== me) throw new Refused(404, ['no such supply run of yours']);
      if (r.status === 'awaiting_approval') throw new Refused(409, ['wait for your manager to approve this run']);
      if (r.status !== 'approved') throw new Refused(409, ['this run is already closed']);
      const slip = await c.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'supplier_slip' AND taken_by = $2", [b.slipPhotoId, me]);
      if (!slip.rowCount) throw new Refused(409, ['upload the supplier slip photo first']);
      for (const l of b.stock) {
        await c.query(
          `INSERT INTO stock_movements (stock_item_id, qty, kind, to_technician_id, job_id, holding_job_id, supply_run_id, created_by)
           VALUES ($1, $2, 'supply_run', $3, $4, $4, $5, $3)`,
          [l.stockItemId, l.qty, me, r.job_id, id],
        );
      }
      await c.query(
        "UPDATE supply_runs SET status = 'collected', collected_at = $2, slip_photo_id = $3, slip_amount_cents = $4 WHERE id = $1",
        [id, b.at, b.slipPhotoId, b.slipAmountCents ?? null],
      );
      if (!r.job_id && b.stock.length) await checkVan(c, me, me);
      return { id, status: 'collected', stockAdded: b.stock.length };
    });
  });

  // ---- Timesheets: the technician's own account, checked against the timers ----

  app.post('/timesheets', async (req, reply) => {
    const b = parse(z.object({
      workDate: DateOnly,
      at: Iso,
      lines: z.array(z.object({ jobId: Uuid, minutes: z.number().int().min(0).max(24 * 60) })).max(50),
    }), req.body);
    const me = req.actor.id;
    if (b.workDate > sastDate(new Date(b.at))) throw new Refused(400, ['cannot submit a timesheet for a future day']);
    const out = await tx(req.db, async c => {
      const exists = await c.query('SELECT 1 FROM timesheets WHERE technician_id = $1 AND work_date = $2', [me, b.workDate]);
      if (exists.rowCount) throw new Refused(409, ['a timesheet for this day is already submitted; corrections go through your supervisor']);
      const ts = (await c.query('INSERT INTO timesheets (technician_id, work_date, submitted_at) VALUES ($1, $2, $3) RETURNING id', [me, b.workDate, b.at])).rows[0].id;
      for (const l of b.lines) await c.query('INSERT INTO timesheet_lines (timesheet_id, job_id, minutes) VALUES ($1, $2, $3)', [ts, l.jobId, l.minutes]);

      // What the job timers recorded for him that day (his own visits, or visits on jobs he helped on).
      const visits = (await c.query(
        `SELECT v.id, v.job_id, v.started_at, v.ended_at
           FROM job_visits v
          WHERE v.started_at IS NOT NULL AND v.ended_at IS NOT NULL
            AND (v.started_at AT TIME ZONE 'Africa/Johannesburg')::date = $2::date
            AND (v.technician_id = $1 OR EXISTS (SELECT 1 FROM job_helpers h WHERE h.job_id = v.job_id AND h.user_id = $1))`,
        [me, b.workDate],
      )).rows;
      const recorded = new Map<string, number>();
      for (const v of visits) {
        const pauses = (await c.query('SELECT paused_at, resumed_at FROM visit_pauses WHERE visit_id = $1', [v.id])).rows;
        let ms = v.ended_at.getTime() - v.started_at.getTime();
        for (const p of pauses) ms -= (p.resumed_at ?? v.ended_at).getTime() - p.paused_at.getTime();
        recorded.set(v.job_id, (recorded.get(v.job_id) ?? 0) + Math.round(ms / 60000));
      }

      const claimed = new Map(b.lines.map(l => [l.jobId, l.minutes]));
      const jobIds = new Set([...claimed.keys(), ...recorded.keys()]);
      const lines = [];
      const mismatches = [];
      for (const jobId of jobIds) {
        const cl = claimed.get(jobId) ?? 0;
        const rec = recorded.get(jobId) ?? 0;
        const line = { jobId, claimedMinutes: cl, recordedMinutes: rec, differenceMinutes: cl - rec };
        lines.push(line);
        if (Math.abs(cl - rec) > TIMESHEET_TOLERANCE_MIN) mismatches.push(line);
      }
      if (mismatches.length) {
        await raiseFlag(c, {
          type: 'timesheet_mismatch', technicianId: me,
          question: 'Your timesheet does not match the job timers. Explain the difference.',
          details: { timesheetId: ts, workDate: b.workDate, mismatches },
        });
      }
      await audit(c, me, 'timesheet_submitted', 'timesheet', ts, { workDate: b.workDate, mismatches: mismatches.length });
      return { id: ts, workDate: b.workDate, lines, matches: mismatches.length === 0 };
    });
    return reply.code(201).send(out);
  });

  // ---- Flags inbox (Management sees its department, Director and Creator see all) ----

  app.get('/flags', async req => {
    const q = parse(z.object({ status: z.enum(['open', 'explained', 'resolved', 'escalated', 'unresolved']).default('unresolved'), departmentId: Uuid.optional() }), req.query);
    const allowed = departmentsFor(req.actor, 'view_flags');
    if (!allowed) throw new Refused(403, ['you do not have access to flags']);
    if (q.departmentId && allowed !== 'all' && !allowed.includes(q.departmentId)) throw new Refused(403, ['you do not have access to that department']);
    const deptFilter: string[] | null = q.departmentId ? [q.departmentId] : (allowed === 'all' ? null : allowed);
    const { rows } = await req.db.query(
      `SELECT f.id, f.flag_type, f.severity, f.raised_at, f.question, f.explanation, f.explained_at, f.status,
              f.details, f.job_id, j.job_number, f.vehicle_id, u.full_name AS technician, d.name AS department
         FROM flags f
         LEFT JOIN users u ON u.id = f.technician_id
         LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN jobs j ON j.id = f.job_id
        WHERE ($1::uuid[] IS NULL OR u.department_id = ANY($1))
          AND (CASE WHEN $2 = 'unresolved' THEN f.status IN ('open', 'explained', 'escalated') ELSE f.status::text = $2 END)
        ORDER BY f.severity DESC, f.raised_at DESC
        LIMIT 500`,
      [deptFilter, q.status],
    );
    return rows;
  });

  app.post('/flags/:id/resolve', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ note: z.string().trim().min(5, 'add a note saying how it was handled').max(2000) }), req.body);
    return tx(req.db, async c => {
      const f = (await c.query(
        'SELECT f.status, f.technician_id, u.department_id FROM flags f LEFT JOIN users u ON u.id = f.technician_id WHERE f.id = $1 FOR UPDATE OF f',
        [id],
      )).rows[0];
      if (!f) throw new Refused(404, ['no such flag']);
      if (!can(req.actor, 'resolve_flags', { employeeId: f.technician_id, employeeDepartmentId: f.department_id })) throw new Refused(403, ['not your department']);
      if (f.status === 'resolved') throw new Refused(409, ['already resolved']);
      await c.query("UPDATE flags SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution_note = $3 WHERE id = $1", [id, req.actor.id, b.note]);
      await audit(c, req.actor.id, 'flag_resolved', 'flag', id);
      return { id, status: 'resolved' };
    });
  });
}
