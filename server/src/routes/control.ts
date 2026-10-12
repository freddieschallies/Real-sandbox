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
      `SELECT count(*) FILTER (WHERE status <> 'closed' AND scheduled_date = $1)::int AS today,
              count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
              count(*) FILTER (WHERE status = 'continue_later')::int AS continue_later,
              count(*) FILTER (WHERE status <> 'closed' AND scheduled_date < $1)::int AS carried_over,
              count(*) FILTER (WHERE status <> 'closed' AND priority = 'urgent')::int AS urgent,
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
              count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.lead_technician_id = u.id AND j.status <> 'closed' AND j.scheduled_date <= $1))::int AS without_work
         FROM users u WHERE u.login_level = 'technician' AND u.status = 'active'`, [t]);
    return { date: t, jobs, flags, handoversAwaitingApproval: handovers, fleet: { ...fleet, due: fleet.in_service, missedYesterday: missed }, stock, technicians: techs };
  });

  // ---- Stores (where jobs are) ------------------------------------------------------------

  app.get('/office/stores', async req => {
    office(req);
    const { rows } = await req.db.query(
      `SELECT s.id, s.name, s.branch_code, s.address, s.lat, s.lng, s.geofence_m, c.name AS client,
              (SELECT count(*)::int FROM equipment e WHERE e.store_id = s.id) AS equipment,
              (SELECT count(*)::int FROM jobs j WHERE j.store_id = s.id AND j.status <> 'closed') AS open_jobs
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
      `SELECT u.id, u.full_name, d.name AS department,
              (SELECT count(*)::int FROM jobs j WHERE j.status <> 'closed' AND j.scheduled_date <= $1
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
      if (j.status === 'closed') throw new Refused(409, ['the job is closed']);
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
}
