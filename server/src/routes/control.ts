// The office screen (control base): what needs attention today, stores, technicians, and moving a
// job to another technician. Everything else the office does uses the routes the apps already have.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, tx } from '../db.ts';
import { can, departmentsFor } from '../core/permissions.ts';
import { DateOnly, Refused, Uuid, parse } from '../http.ts';
import { notify } from './field.ts';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const yesterday = () => new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

export function registerControlRoutes(app: FastifyInstance) {
  const office = (req: FastifyRequest) => {
    if (!can(req.actor, 'view_all_job_cards') && !can(req.actor, 'assign_jobs')) throw new Refused(403, ['office only']);
  };

  /** Everything that needs someone in the office, on one screen. */
  app.get('/office/overview', async req => {
    office(req);
    const t = today();
    const one = async (sql: string, p: unknown[] = []) => (await req.db.query(sql, p)).rows[0];
    const jobs = await one(
      `SELECT count(*) FILTER (WHERE status NOT IN ('closed', 'cancelled') AND scheduled_date = $1)::int AS today,
              count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
              count(*) FILTER (WHERE status = 'continue_later')::int AS continue_later,
              count(*) FILTER (WHERE status NOT IN ('closed', 'cancelled') AND scheduled_date < $1)::int AS carried_over,
              count(*) FILTER (WHERE status NOT IN ('closed', 'cancelled') AND priority = 'urgent')::int AS urgent,
              count(*) FILTER (WHERE status = 'closed' AND (closed_at AT TIME ZONE 'Africa/Johannesburg')::date = $1::date)::int AS closed_today
         FROM jobs`, [t]);
    const depts = departmentsFor(req.actor, 'view_flags');
    const flags = depts ? (await one(
      `SELECT count(*)::int AS unresolved, count(*) FILTER (WHERE f.status = 'explained')::int AS explained
         FROM flags f LEFT JOIN users u ON u.id = f.technician_id
        WHERE f.status IN ('open', 'explained', 'escalated') AND ($1::uuid[] IS NULL OR u.department_id = ANY($1))`, [depts === 'all' ? null : depts])) : null;
    const handovers = (await one("SELECT count(*)::int AS n FROM vehicle_inspections WHERE status = 'awaiting_approval'")).n;
    const fleet = await one(
      `SELECT count(*) FILTER (WHERE status = 'in_service')::int AS in_service, count(*) FILTER (WHERE status <> 'in_service')::int AS off,
              (SELECT count(*)::int FROM vehicle_faults WHERE severity = 'safety' AND status IN ('open', 'in_progress')) AS safety_faults,
              (SELECT count(*)::int FROM daily_checks WHERE check_date = $1) AS checked_today
         FROM vehicles WHERE active`, [t]);
    const missed = (await req.db.query(
      `SELECT v.id, v.registration FROM vehicles v
        WHERE v.active AND v.status = 'in_service'
          AND NOT EXISTS (SELECT 1 FROM daily_checks d WHERE d.vehicle_id = v.id AND d.check_date = $1)
        ORDER BY v.registration`, [yesterday()])).rows;
    const stock = await one(
      `SELECT (SELECT count(*)::int FROM stock_issues WHERE status = 'pending') AS to_issue,
              (SELECT count(*)::int FROM stock_returns WHERE status = 'pending') AS to_receive,
              (SELECT count(*)::int FROM workshop_items wi LEFT JOIN workshop_stock w ON w.stock_item_id = wi.stock_item_id
                WHERE wi.min_qty > 0 AND coalesce(w.qty, 0) < wi.min_qty) AS workshop_below_min`);
    const techs = await one(
      `SELECT count(*)::int AS active,
              count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.lead_technician_id = u.id AND j.status NOT IN ('closed', 'cancelled') AND j.scheduled_date <= $1))::int AS without_work
         FROM users u WHERE u.login_level = 'technician' AND u.status = 'active'`, [t]);
    return { date: t, jobs, flags, handoversAwaitingApproval: handovers, fleet: { ...fleet, due: fleet.in_service, missedYesterday: missed }, stock, technicians: techs };
  });

  // ---- Stores (where jobs are) ------------------------------------------------------------

  app.get('/office/stores', async req => {
    office(req);
    const { rows } = await req.db.query(
      `SELECT s.id, s.name, s.branch_code, s.address, s.lat, s.lng, s.geofence_m, c.name AS client,
              (SELECT count(*)::int FROM equipment e WHERE e.store_id = s.id) AS equipment,
              (SELECT count(*)::int FROM jobs j WHERE j.store_id = s.id AND j.status NOT IN ('closed', 'cancelled')) AS open_jobs
         FROM stores s JOIN clients c ON c.id = s.client_id ORDER BY c.name, s.name`);
    return rows;
  });

  app.post('/office/stores', async (req, reply) => {
    if (!can(req.actor, 'manage_stores_equipment')) throw new Refused(403, ['you cannot add stores']);
    const b = parse(z.object({
      client: z.string().trim().min(2, 'client name').max(200), name: z.string().trim().min(2, 'store name').max(200),
      branchCode: z.string().trim().max(50).optional(), address: z.string().trim().max(500).optional(),
      lat: z.number().min(-35).max(-22, 'that is not in South Africa'), lng: z.number().min(16).max(33, 'that is not in South Africa'),
      geofenceM: z.number().int().min(50).max(1000).default(150),
    }), req.body);
    const out = await tx(req.db, async c => {
      const client = (await c.query('SELECT id FROM clients WHERE lower(name) = lower($1)', [b.client])).rows[0]
        ?? (await c.query('INSERT INTO clients (name) VALUES ($1) RETURNING id', [b.client])).rows[0];
      if ((await c.query('SELECT 1 FROM stores WHERE client_id = $1 AND lower(name) = lower($2)', [client.id, b.name])).rowCount) {
        throw new Refused(409, [`${b.client} ${b.name} is already a store`]);
      }
      const s = (await c.query(
        'INSERT INTO stores (client_id, name, branch_code, address, lat, lng, geofence_m) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [client.id, b.name, b.branchCode ?? null, b.address ?? null, b.lat, b.lng, b.geofenceM])).rows[0];
      await audit(c, req.actor.id, 'store_added', 'store', s.id, b);
      return { id: s.id };
    });
    return reply.code(201).send(out);
  });

  // ---- Technicians -------------------------------------------------------------------------

  app.get('/office/technicians', async req => {
    office(req);
    const t = today();
    const { rows } = await req.db.query(
      `SELECT u.id, u.full_name, u.trade, d.name AS department,
              (SELECT count(*)::int FROM jobs j WHERE j.status NOT IN ('closed', 'cancelled') AND j.scheduled_date <= $1
                 AND (j.lead_technician_id = u.id OR EXISTS (SELECT 1 FROM job_helpers h WHERE h.job_id = j.id AND h.user_id = u.id))) AS open_jobs,
              (SELECT count(*)::int FROM jobs j WHERE j.status = 'in_progress' AND j.lead_technician_id = u.id) AS working_now,
              (SELECT v.registration FROM vehicle_scans s JOIN vehicles v ON v.id = s.vehicle_id
                WHERE s.user_id = u.id AND s.released_at IS NULL ORDER BY s.scanned_at DESC LIMIT 1) AS vehicle
         FROM users u LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.login_level = 'technician' AND u.status = 'active' ORDER BY u.full_name`, [t]);
    return rows;
  });

  // ---- Moving a job to another technician ------------------------------------------------------

  app.post('/jobs/:id/assign', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!can(req.actor, 'assign_jobs')) throw new Refused(403, ['you cannot assign jobs']);
    const jobId = parse(Uuid, req.params.id);
    const b = parse(z.object({
      leadTechnicianId: Uuid, helperIds: z.array(Uuid).max(10).default([]), scheduledDate: DateOnly.optional(),
      reason: z.string().trim().min(5, 'say why it moves').max(500),
    }), req.body);
    return tx(req.db, async c => {
      const j = (await c.query('SELECT job_number, status, lead_technician_id FROM jobs WHERE id = $1 FOR UPDATE', [jobId])).rows[0];
      if (!j) throw new Refused(404, ['no such job']);
      if (j.status === 'closed' || j.status === 'cancelled') throw new Refused(409, [`the job is ${j.status}`]);
      if (j.status === 'in_progress' && b.leadTechnicianId !== j.lead_technician_id) {
        throw new Refused(409, ['the technician is busy on this job: he must Continue later before it can move']);
      }
      const ids = [b.leadTechnicianId, ...b.helperIds];
      const ok = new Set((await c.query("SELECT id FROM users WHERE id = ANY($1) AND login_level = 'technician' AND status = 'active'", [ids])).rows.map(r => r.id));
      if (!ok.has(b.leadTechnicianId)) throw new Refused(400, ['lead technician must be an active technician']);
      if (b.helperIds.some(h => !ok.has(h) || h === b.leadTechnicianId)) throw new Refused(400, ['every helper must be another active technician']);
      const before = (await c.query('SELECT user_id FROM job_helpers WHERE job_id = $1', [jobId])).rows.map(r => r.user_id);
      await c.query('UPDATE jobs SET lead_technician_id = $2, scheduled_date = COALESCE($3, scheduled_date) WHERE id = $1', [jobId, b.leadTechnicianId, b.scheduledDate ?? null]);
      await c.query('DELETE FROM job_helpers WHERE job_id = $1', [jobId]);
      for (const h of b.helperIds) await c.query('INSERT INTO job_helpers (job_id, user_id) VALUES ($1, $2)', [jobId, h]);
      const was = new Set([j.lead_technician_id, ...before]);
      const now = new Set(ids);
      for (const u of now) if (!was.has(u)) await notify(c, u, 'job_assigned', `Job ${j.job_number} is now yours${b.scheduledDate ? ` for ${b.scheduledDate}` : ''}: ${b.reason}`, { jobId });
      for (const u of was) if (!now.has(u)) await notify(c, u, 'job_unassigned', `Job ${j.job_number} was moved off you: ${b.reason}`, { jobId });
      await audit(c, req.actor.id, 'job_assigned', 'job', jobId, b);
      return { jobId, leadTechnicianId: b.leadTechnicianId, helperIds: b.helperIds };
    });
  });

  // ---- Editing a job (Admin). Every change is written on the job and the technician is told. ----------

  app.patch('/jobs/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!can(req.actor, 'assign_jobs')) throw new Refused(403, ['you cannot edit jobs']);
    const jobId = parse(Uuid, req.params.id);
    const b = parse(z.object({
      jobType: z.enum(['breakdown', 'planned_maintenance', 'installation', 'quote_visit', 'follow_up']).optional(),
      priority: z.enum(['urgent', 'normal', 'scheduled']).optional(),
      storeId: Uuid.optional(),
      faultReported: z.string().trim().min(3).max(2000).optional(),
      clientOrderRef: z.string().trim().max(100).nullable().optional(),
      scheduledDate: DateOnly.optional(),
      addMaintenanceSteps: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
      reason: z.string().trim().max(500).optional(),
    }), req.body);
    return tx(req.db, async c => {
      const j = (await c.query(
        `SELECT j.job_number, j.status, j.job_type, j.priority, j.store_id, s.name AS store, j.fault_reported, j.client_order_ref,
                to_char(j.scheduled_date, 'YYYY-MM-DD') AS scheduled_date, j.lead_technician_id,
                EXISTS (SELECT 1 FROM job_visits v WHERE v.job_id = j.id) AS started
           FROM jobs j JOIN stores s ON s.id = j.store_id WHERE j.id = $1 FOR UPDATE OF j`, [jobId])).rows[0];
      if (!j) throw new Refused(404, ['no such job']);
      if (j.status === 'cancelled') throw new Refused(409, ['the job is cancelled']);
      const closed = j.status === 'closed';
      const changes: { field: string; old: string | null; new: string | null }[] = [];
      const refused: string[] = [];
      const set: Record<string, unknown> = {};
      const change = (field: string, col: string, oldV: unknown, newV: unknown, shown?: [string | null, string | null]) => {
        if (newV === undefined || (oldV ?? null) === (newV ?? null)) return;
        set[col] = newV;
        changes.push({ field, old: shown ? shown[0] : (oldV as string | null), new: shown ? shown[1] : (newV as string | null) });
      };
      // A closed job is the record of what was done: only the client's order number can still be added.
      if (closed && Object.keys(b).some(k => !['clientOrderRef', 'reason'].includes(k) && (b as Record<string, unknown>)[k] !== undefined)) {
        refused.push('a closed job can only have its client order number changed');
      }
      if (j.started && (b.storeId && b.storeId !== j.store_id)) refused.push('the store cannot change once the technician has been there: cancel and open a new job');
      if (j.started && (b.jobType && b.jobType !== j.job_type)) refused.push('the job type cannot change once work has started');
      if (refused.length) throw new Refused(409, refused);
      if (b.storeId && b.storeId !== j.store_id) {
        const st = (await c.query('SELECT name FROM stores WHERE id = $1', [b.storeId])).rows[0];
        if (!st) throw new Refused(400, ['unknown store']);
        change('store', 'store_id', j.store_id, b.storeId, [j.store, st.name]);
      }
      change('job type', 'job_type', j.job_type, b.jobType);
      change('priority', 'priority', j.priority, b.priority);
      change('fault reported', 'fault_reported', j.fault_reported, b.faultReported);
      change('client order number', 'client_order_ref', j.client_order_ref, b.clientOrderRef === undefined ? undefined : (b.clientOrderRef || null));
      change('date', 'scheduled_date', j.scheduled_date, b.scheduledDate);
      const steps = b.addMaintenanceSteps ?? [];
      if (!changes.length && !steps.length) return { jobId, changes: [] };
      if (j.started && !closed && !(b.reason && b.reason.length >= 5)) throw new Refused(400, ['the technician has started: say why it changes']);
      const cols = Object.keys(set);
      if (cols.length) await c.query(`UPDATE jobs SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [jobId, ...cols.map(k => set[k])]);
      // The first work item is the reported fault: keep it in step while nothing has been done on it.
      if (b.faultReported && !j.started) await c.query("UPDATE work_items SET title = $2 WHERE job_id = $1 AND origin = 'reported'", [jobId, b.faultReported.slice(0, 200)]);
      for (const step of steps) await c.query('INSERT INTO planned_maintenance_checks (job_id, step) VALUES ($1, $2)', [jobId, step]);
      if (steps.length) changes.push({ field: 'checklist', old: null, new: `added: ${steps.join('; ')}` });
      for (const ch of changes) {
        await c.query('INSERT INTO job_changes (job_id, field, old_value, new_value, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6)',
          [jobId, ch.field, ch.old, ch.new, b.reason ?? null, req.actor.id]);
      }
      if (!closed) {
        const text = changes.map(ch => `${ch.field}: ${ch.new ?? '(removed)'}`).join('; ');
        const crew = [j.lead_technician_id, ...(await c.query('SELECT user_id FROM job_helpers WHERE job_id = $1', [jobId])).rows.map(r => r.user_id)];
        for (const u of crew) await notify(c, u, 'job_changed', `Job ${j.job_number} changed by the office: ${text}`, { jobId });
      }
      await audit(c, req.actor.id, 'job_edited', 'job', jobId, { changes, reason: b.reason ?? null });
      return { jobId, changes };
    });
  });

  app.post('/jobs/:id/cancel', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!can(req.actor, 'assign_jobs')) throw new Refused(403, ['you cannot cancel jobs']);
    const jobId = parse(Uuid, req.params.id);
    const b = parse(z.object({ note: z.string().trim().min(5, 'say why the job is cancelled').max(500) }), req.body);
    return tx(req.db, async c => {
      const j = (await c.query('SELECT job_number, status, lead_technician_id FROM jobs WHERE id = $1 FOR UPDATE', [jobId])).rows[0];
      if (!j) throw new Refused(404, ['no such job']);
      if (j.status === 'closed' || j.status === 'cancelled') throw new Refused(409, [`the job is already ${j.status}`]);
      if (j.status === 'in_progress') throw new Refused(409, ['the technician is working on it: he must Continue later first']);
      await c.query("UPDATE jobs SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_note = $3 WHERE id = $1", [jobId, req.actor.id, b.note]);
      await c.query('INSERT INTO job_changes (job_id, field, old_value, new_value, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [jobId, 'status', j.status, 'cancelled', b.note, req.actor.id]);
      // Stock asked for but not yet issued is not needed any more.
      await c.query("UPDATE stock_issues SET status = 'rejected', decided_by = $2, decided_at = now(), note = $3 WHERE job_id = $1 AND status = 'pending'",
        [jobId, req.actor.id, `Job ${j.job_number} cancelled: ${b.note}`]);
      const crew = [j.lead_technician_id, ...(await c.query('SELECT user_id FROM job_helpers WHERE job_id = $1', [jobId])).rows.map(r => r.user_id)];
      for (const u of crew) await notify(c, u, 'job_cancelled', `Job ${j.job_number} was cancelled: ${b.note}. Return any stock booked for it.`, { jobId });
      await audit(c, req.actor.id, 'job_cancelled', 'job', jobId, b);
      return { jobId, status: 'cancelled' };
    });
  });

  app.get('/jobs/:id/changes', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    office(req);
    const jobId = parse(Uuid, req.params.id);
    const { rows } = await req.db.query(
      `SELECT c.changed_at, u.full_name AS by, c.field, c.old_value, c.new_value, c.reason
         FROM job_changes c JOIN users u ON u.id = c.changed_by WHERE c.job_id = $1 ORDER BY c.changed_at DESC`, [jobId]);
    return rows;
  });
}
