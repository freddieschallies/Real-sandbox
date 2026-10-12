// The mechanic's side: vehicles, km, faults and mechanic job cards linked to a vehicle.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Db, Q } from '../db.ts';
import { audit, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as F from '../core/fleet.ts';
import { DateOnly, Iso, Refused, Uuid, parse } from '../http.ts';
import { managerOf, notify } from './field.ts';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

export async function latestKm(c: Q, vehicleId: string): Promise<number | null> {
  const r = (await c.query('SELECT max(km) AS km FROM odometer_readings WHERE vehicle_id = $1', [vehicleId])).rows[0];
  return r.km == null ? null : Number(r.km);
}

/** Records a km reading; refuses one lower than what is already on record. */
export async function recordKm(c: Q, vehicleId: string, km: number, at: string, source: 'handover' | 'fleet_job' | 'mechanic' | 'release' | 'daily_check', sourceId: string | null, by: string) {
  const last = await latestKm(c, vehicleId);
  if (last != null && km < last) throw new Refused(409, [`odometer cannot be lower than the last reading (${last} km)`]);
  await c.query('INSERT INTO odometer_readings (vehicle_id, km, read_at, source, source_id, recorded_by) VALUES ($1, $2, $3, $4, $5, $6)',
    [vehicleId, km, at, source, sourceId, by]);
}

/** Problems found at a handover become faults for the mechanic. */
const HANDOVER_SEVERITY: Record<string, F.FaultSeverity> = { tyres: 'safety', lights: 'safety', windscreen_mirrors: 'safety', fire_extinguisher: 'urgent' };
export async function faultsFromHandover(c: Q, vehicleId: string, inspectionId: string, by: string, at: string, problems: { key: string; label: string; note?: string }[], photoIds: string[]) {
  for (const p of problems) {
    await c.query(
      `INSERT INTO vehicle_faults (vehicle_id, description, severity, source, source_id, reported_by, reported_at, photo_ids)
       VALUES ($1, $2, $3, 'handover', $4, $5, $6, $7)`,
      [vehicleId, `${p.label}${p.note ? `: ${p.note}` : ''}`, HANDOVER_SEVERITY[p.key] ?? 'normal', inspectionId, by, at, photoIds],
    );
  }
}

async function mechanics(c: Q): Promise<string[]> {
  // Everyone doing the mechanic's work: by position, or given it on top of their own position.
  return (await c.query(
    `SELECT id FROM users u WHERE status <> 'left' AND (login_level = 'mechanic'
       OR EXISTS (SELECT 1 FROM access_overrides o WHERE o.user_id = u.id AND o.action = 'manage_fleet' AND o.effect = 'grant'))`)).rows.map(r => r.id);
}

export function registerFleetRoutes(app: FastifyInstance, _db: Db) {
  const viewer = (req: FastifyRequest) => { if (!can(req.actor, 'view_fleet')) throw new Refused(403, ['fleet only']); };
  const mechanic = (req: FastifyRequest) => { if (!can(req.actor, 'manage_fleet')) throw new Refused(403, ['mechanic only']); };

  // ---- The fleet at a glance ------------------------------------------------------

  app.get('/fleet', async req => {
    viewer(req);
    const { rows } = await req.db.query(
      `SELECT v.id, v.registration, v.description, v.make, v.model, v.year, v.status, v.status_note, v.licence_expiry, v.next_service_km, v.next_service_at,
              (SELECT max(km) FROM odometer_readings o WHERE o.vehicle_id = v.id) AS km,
              (SELECT u.full_name FROM vehicle_scans s JOIN users u ON u.id = s.user_id
                WHERE s.vehicle_id = v.id AND s.mode = 'driving' AND s.released_at IS NULL ORDER BY s.scanned_at DESC LIMIT 1) AS driver,
              (SELECT count(*) FROM vehicle_faults f WHERE f.vehicle_id = v.id AND f.status IN ('open', 'in_progress'))::int AS open_faults,
              (SELECT count(*) FROM vehicle_faults f WHERE f.vehicle_id = v.id AND f.status IN ('open', 'in_progress') AND f.severity = 'safety')::int AS safety_faults,
              (SELECT json_build_object('id', j.id, 'number', j.number, 'type', j.job_type) FROM fleet_jobs j WHERE j.vehicle_id = v.id AND j.status = 'open') AS open_job,
              (SELECT json_build_object('oil', d.oil, 'oilLitres', d.oil_litres::float, 'water', d.water, 'tyres', d.tyres, 'at', d.checked_at)
                 FROM daily_checks d WHERE d.vehicle_id = v.id AND d.check_date = $1) AS checked_today
         FROM vehicles v WHERE v.active ORDER BY v.registration`, [today()],
    );
    const t = today();
    return rows.map(r => {
      const km = r.km == null ? null : Number(r.km);
      const nextAt = r.next_service_at ? toDate(r.next_service_at) : null;
      const lic = r.licence_expiry ? toDate(r.licence_expiry) : null;
      return { ...r, km, next_service_at: nextAt, licence_expiry: lic,
        serviceDue: F.serviceDue({ next_service_km: r.next_service_km, next_service_at: nextAt }, km, t), licenceDue: F.licenceDue(lic, t) };
    });
  });

  app.get('/fleet/vehicles/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    viewer(req);
    const id = parse(Uuid, req.params.id);
    const v = (await req.db.query('SELECT * FROM vehicles WHERE id = $1', [id])).rows[0];
    if (!v) throw new Refused(404, ['no such vehicle']);
    const q = (sql: string) => req.db.query(sql, [id]).then(r => r.rows);
    const dailyChecks = (await req.db.query(
      `SELECT d.id, to_char(d.check_date, 'YYYY-MM-DD') AS check_date, d.checked_at, u.full_name AS by, d.odometer_km, d.oil, d.oil_litres::float AS oil_litres,
              d.water, d.water_litres::float AS water_litres, d.tyres, d.notes
         FROM daily_checks d JOIN users u ON u.id = d.checked_by WHERE d.vehicle_id = $1 ORDER BY d.check_date DESC LIMIT 30`, [id])).rows;
    const [faults, jobs, km, inspections] = await Promise.all([
      q(`SELECT f.*, u.full_name AS reported_by_name FROM vehicle_faults f JOIN users u ON u.id = f.reported_by
          WHERE f.vehicle_id = $1 ORDER BY (f.status IN ('open', 'in_progress')) DESC, f.reported_at DESC LIMIT 100`),
      q(`SELECT j.id, j.number, j.job_type, j.status, j.reason, j.opened_at, j.completed_at, j.odometer_in, j.odometer_out, j.found_text, j.did_text,
                j.labour_hours, u.full_name AS mechanic,
                (SELECT COALESCE(SUM(p.qty * COALESCE(p.unit_cost_cents, 0)), 0) FROM fleet_job_parts p WHERE p.job_id = j.id)::int AS parts_cents
           FROM fleet_jobs j JOIN users u ON u.id = j.opened_by WHERE j.vehicle_id = $1 ORDER BY j.opened_at DESC LIMIT 50`),
      q(`SELECT o.km, o.read_at, o.source, u.full_name AS by FROM odometer_readings o JOIN users u ON u.id = o.recorded_by
          WHERE o.vehicle_id = $1 ORDER BY o.read_at DESC LIMIT 60`),
      q(`SELECT i.id, i.inspected_at, i.odometer_km, i.fuel_level, i.problems, i.new_problems, u.full_name AS driver
           FROM vehicle_inspections i JOIN users u ON u.id = i.driver_id WHERE i.vehicle_id = $1 ORDER BY i.inspected_at DESC LIMIT 10`),
    ]);
    const latest = km.length ? Math.max(...km.map((k: { km: number }) => Number(k.km))) : null;
    const t = today();
    return {
      vehicle: { ...v, licence_expiry: v.licence_expiry ? toDate(v.licence_expiry) : null, next_service_at: v.next_service_at ? toDate(v.next_service_at) : null, km: latest },
      serviceDue: F.serviceDue({ next_service_km: v.next_service_km, next_service_at: v.next_service_at ? toDate(v.next_service_at) : null }, latest, t),
      licenceDue: F.licenceDue(v.licence_expiry ? toDate(v.licence_expiry) : null, t),
      faults, jobs, km: km.map((k: { km: number }) => ({ ...k, km: Number(k.km) })), inspections, dailyChecks,
    };
  });

  // ---- Vehicle details, status and km --------------------------------------------------

  app.patch('/fleet/vehicles/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    mechanic(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({
      make: z.string().trim().max(60).nullish(), model: z.string().trim().max(60).nullish(), year: z.number().int().min(1950).max(2100).nullish(),
      vin: z.string().trim().max(40).nullish(), engineNo: z.string().trim().max(40).nullish(), licenceExpiry: DateOnly.nullish(),
      serviceIntervalKm: z.number().int().positive().max(100000).optional(), serviceIntervalMonths: z.number().int().positive().max(60).optional(),
      nextServiceKm: z.number().int().min(0).nullish(), nextServiceAt: DateOnly.nullish(),
    }).strict(), req.body);
    const cols: Record<string, string> = { make: 'make', model: 'model', year: 'year', vin: 'vin', engineNo: 'engine_no', licenceExpiry: 'licence_expiry',
      serviceIntervalKm: 'service_interval_km', serviceIntervalMonths: 'service_interval_months', nextServiceKm: 'next_service_km', nextServiceAt: 'next_service_at' };
    const sets: string[] = []; const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(b)) { if (v !== undefined) { vals.push(v); sets.push(`${cols[k]} = $${vals.length}`); } }
    if (!sets.length) throw new Refused(400, ['nothing to change']);
    const r = await req.db.query(`UPDATE vehicles SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, vals);
    if (!r.rowCount) throw new Refused(404, ['no such vehicle']);
    await audit(req.db, req.actor.id, 'vehicle_details_changed', 'vehicle', id, b);
    return { id };
  });

  app.post('/fleet/vehicles/:id/status', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    mechanic(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ status: z.enum(['in_service', 'workshop', 'off_road']), note: z.string().trim().max(500).optional(), at: Iso }), req.body);
    if (b.status !== 'in_service' && !(b.note && b.note.length >= 5)) throw new Refused(400, ['say why the vehicle is off the road']);
    return tx(req.db, async c => {
      const v = (await c.query('UPDATE vehicles SET status = $2, status_note = $3, status_changed_at = $4 WHERE id = $1 RETURNING registration', [id, b.status, b.note ?? null, b.at])).rows[0];
      if (!v) throw new Refused(404, ['no such vehicle']);
      if (b.status !== 'in_service') await tellDriverAndManager(c, id, `${v.registration} is ${b.status === 'workshop' ? 'in the workshop' : 'off the road'}: ${b.note}`);
      await audit(c, req.actor.id, 'vehicle_status', 'vehicle', id, b);
      return { id, status: b.status };
    });
  });

  app.post('/fleet/vehicles/:id/odometer', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    mechanic(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ km: z.number().int().min(0).max(5_000_000), at: Iso }), req.body);
    return tx(req.db, async c => {
      if (!(await c.query('SELECT 1 FROM vehicles WHERE id = $1', [id])).rowCount) throw new Refused(404, ['no such vehicle']);
      await recordKm(c, id, b.km, b.at, 'mechanic', null, req.actor.id);
      return { id, km: b.km };
    });
  });

  // ---- Faults: anyone may report one, the mechanic deals with it -------------------------

  app.post('/fleet/vehicles/:id/faults', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const vehicleId = parse(Uuid, req.params.id);
    const b = parse(z.object({
      id: Uuid.optional(), description: z.string().trim().min(10, 'describe the fault (at least a short sentence)').max(1000),
      severity: z.enum(['safety', 'urgent', 'normal']).default('normal'), photoIds: z.array(Uuid).max(10).default([]), at: Iso,
    }), req.body);
    const me = req.actor.id;
    const out = await tx(req.db, async c => {
      const v = (await c.query('SELECT registration FROM vehicles WHERE id = $1', [vehicleId])).rows[0];
      if (!v) throw new Refused(404, ['no such vehicle']);
      for (const p of b.photoIds) {
        if (!(await c.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'fleet_fault' AND taken_by = $2", [p, me])).rowCount) throw new Refused(409, ['upload the photo first']);
      }
      const id = b.id ?? randomUUID();
      await c.query(
        `INSERT INTO vehicle_faults (id, vehicle_id, description, severity, source, reported_by, reported_at, photo_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, vehicleId, b.description, b.severity, can(req.actor, 'manage_fleet') ? 'mechanic' : 'driver', me, b.at, b.photoIds],
      );
      for (const m of await mechanics(c)) {
        if (m !== me) await notify(c, m, 'vehicle_fault', `${b.severity === 'safety' ? 'SAFETY: ' : ''}${v.registration}: ${b.description}`, { faultId: id, vehicleId });
      }
      return { id };
    });
    return reply.code(201).send(out);
  });

  // Every open fault across the fleet, worst first.
  app.get('/fleet/faults', async req => {
    viewer(req);
    const { rows } = await req.db.query(
      `SELECT f.id, f.vehicle_id, v.registration, f.description, f.severity, f.source, f.status, f.reported_at, f.photo_ids, f.fleet_job_id,
              u.full_name AS reported_by_name
         FROM vehicle_faults f JOIN vehicles v ON v.id = f.vehicle_id JOIN users u ON u.id = f.reported_by
        WHERE f.status IN ('open', 'in_progress')
        ORDER BY CASE f.severity WHEN 'safety' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, f.reported_at`,
    );
    return rows;
  });

  app.post('/fleet/faults/:id/defer', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    mechanic(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ note: z.string().trim().min(5, 'say why it is deferred').max(1000), at: Iso }), req.body);
    const r = await req.db.query("UPDATE vehicle_faults SET status = 'deferred', closed_at = $2, closed_note = $3 WHERE id = $1 AND status = 'open' AND severity <> 'safety' RETURNING id", [id, b.at, b.note]);
    if (!r.rowCount) throw new Refused(409, ['only an open fault that is not a safety fault can be deferred']);
    return { id, status: 'deferred' };
  });

  // ---- Mechanic job cards ----------------------------------------------------------------

  app.post('/fleet/vehicles/:id/jobs', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    mechanic(req);
    const vehicleId = parse(Uuid, req.params.id);
    const b = parse(z.object({
      id: Uuid.optional(), jobType: z.enum(F.JOB_TYPES as [F.FleetJobType, ...F.FleetJobType[]]), reason: z.string().trim().min(5).max(1000),
      odometerIn: z.number().int().min(0), faultIds: z.array(Uuid).max(50).default([]), vehicleStatus: z.enum(['workshop', 'off_road', 'in_service']).default('workshop'), at: Iso,
      bookingId: Uuid.optional(),
    }), req.body);
    const me = req.actor.id;
    const out = await tx(req.db, async c => {
      const v = (await c.query('SELECT registration FROM vehicles WHERE id = $1 FOR UPDATE', [vehicleId])).rows[0];
      if (!v) throw new Refused(404, ['no such vehicle']);
      const open = (await c.query("SELECT number FROM fleet_jobs WHERE vehicle_id = $1 AND status = 'open'", [vehicleId])).rows[0];
      if (open) throw new Refused(409, [`job card ${open.number} is still open on this vehicle`]);
      const id = b.id ?? randomUUID();
      const n = (await c.query(
        'INSERT INTO fleet_jobs (id, vehicle_id, job_type, reason, opened_by, opened_at, odometer_in) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING number',
        [id, vehicleId, b.jobType, b.reason, me, b.at, b.odometerIn])).rows[0].number;
      await recordKm(c, vehicleId, b.odometerIn, b.at, 'fleet_job', id, me);
      if (b.bookingId) {
        const r = await c.query("UPDATE fleet_bookings SET status = 'started', fleet_job_id = $2 WHERE id = $1 AND vehicle_id = $3 AND status = 'booked'", [b.bookingId, id, vehicleId]);
        if (!r.rowCount) throw new Refused(409, ['that booking is not open for this vehicle']);
      }
      for (const f of b.faultIds) {
        const r = await c.query("UPDATE vehicle_faults SET status = 'in_progress', fleet_job_id = $2 WHERE id = $1 AND vehicle_id = $3 AND status IN ('open', 'deferred') RETURNING id", [f, id, vehicleId]);
        if (!r.rowCount) throw new Refused(409, ['a chosen fault is not open on this vehicle']);
      }
      if (b.vehicleStatus !== 'in_service') {
        await c.query('UPDATE vehicles SET status = $2, status_note = $3, status_changed_at = $4 WHERE id = $1', [vehicleId, b.vehicleStatus, `Job card ${n}: ${b.reason}`, b.at]);
        await tellDriverAndManager(c, vehicleId, `${v.registration} is ${b.vehicleStatus === 'workshop' ? 'in the workshop' : 'off the road'} (job card ${n})`);
      }
      await audit(c, me, 'fleet_job_opened', 'fleet_job', id, { number: n });
      return { id, number: n };
    });
    return reply.code(201).send(out);
  });

  app.get('/fleet/jobs', async req => {
    viewer(req);
    const q = parse(z.object({ status: z.enum(['open', 'completed']).default('open') }), req.query);
    const { rows } = await req.db.query(
      `SELECT j.*, v.registration, u.full_name AS mechanic,
              (SELECT json_agg(json_build_object('id', f.id, 'description', f.description, 'severity', f.severity, 'status', f.status))
                 FROM vehicle_faults f WHERE f.fleet_job_id = j.id) AS faults,
              (SELECT json_agg(json_build_object('id', p.id, 'description', p.description, 'qty', p.qty, 'unitCostCents', p.unit_cost_cents, 'source', p.source) ORDER BY p.added_at)
                 FROM fleet_job_parts p WHERE p.job_id = j.id) AS parts
         FROM fleet_jobs j JOIN vehicles v ON v.id = j.vehicle_id JOIN users u ON u.id = j.opened_by
        WHERE j.status = $1 ORDER BY j.opened_at DESC LIMIT 200`, [q.status]);
    return rows.map(r => ({ ...r, faults: r.faults ?? [], parts: (r.parts ?? []).map((p: { qty: string }) => ({ ...p, qty: Number(p.qty) })), labour_hours: r.labour_hours == null ? null : Number(r.labour_hours) }));
  });

  app.patch('/fleet/jobs/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    mechanic(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({
      found: z.string().max(4000).optional(), did: z.string().max(4000).optional(), labourHours: z.number().min(0).max(500).optional(),
      addBeforePhotoIds: z.array(Uuid).max(20).optional(), addAfterPhotoIds: z.array(Uuid).max(20).optional(),
    }).strict(), req.body);
    return tx(req.db, async c => {
      const j = (await c.query('SELECT status FROM fleet_jobs WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!j) throw new Refused(404, ['no such job card']);
      if (j.status !== 'open') throw new Refused(409, ['this job card is completed and locked']);
      for (const [list, kind] of [[b.addBeforePhotoIds, 'fleet_before'], [b.addAfterPhotoIds, 'fleet_after']] as const) {
        for (const p of list ?? []) {
          if (!(await c.query('SELECT 1 FROM photos WHERE id = $1 AND kind = $2 AND taken_by = $3', [p, kind, req.actor.id])).rowCount) throw new Refused(409, ['upload the photo first']);
        }
      }
      await c.query(
        `UPDATE fleet_jobs SET found_text = COALESCE($2, found_text), did_text = COALESCE($3, did_text), labour_hours = COALESCE($4, labour_hours),
                before_photo_ids = before_photo_ids || $5::uuid[], after_photo_ids = after_photo_ids || $6::uuid[] WHERE id = $1`,
        [id, b.found ?? null, b.did ?? null, b.labourHours ?? null, b.addBeforePhotoIds ?? [], b.addAfterPhotoIds ?? []],
      );
      return { id };
    });
  });

  app.post('/fleet/jobs/:id/parts', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    mechanic(req);
    const jobId = parse(Uuid, req.params.id);
    const b = parse(z.object({
      id: Uuid.optional(), description: z.string().trim().min(2).max(300), qty: z.number().positive(), unitCostCents: z.number().int().min(0).nullish(),
      source: z.enum(['stockroom', 'bought', 'other']), slipPhotoId: Uuid.optional(),
    }), req.body);
    if (b.source === 'bought' && !b.slipPhotoId) throw new Refused(400, ['a photo of the slip for anything bought']);
    const out = await tx(req.db, async c => {
      const j = (await c.query('SELECT status FROM fleet_jobs WHERE id = $1', [jobId])).rows[0];
      if (!j) throw new Refused(404, ['no such job card']);
      if (j.status !== 'open') throw new Refused(409, ['this job card is completed and locked']);
      if (b.slipPhotoId && !(await c.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'fleet_slip' AND taken_by = $2", [b.slipPhotoId, req.actor.id])).rowCount) {
        throw new Refused(409, ['upload the slip photo first']);
      }
      const id = b.id ?? randomUUID();
      await c.query('INSERT INTO fleet_job_parts (id, job_id, description, qty, unit_cost_cents, source, slip_photo_id, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, jobId, b.description, b.qty, b.unitCostCents ?? null, b.source, b.slipPhotoId ?? null, req.actor.id]);
      return { id };
    });
    return reply.code(201).send(out);
  });

  app.post('/fleet/jobs/:id/complete', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    mechanic(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({
      at: Iso, odometerOut: z.number().int().min(0),
      faults: z.array(z.object({ id: Uuid, outcome: z.enum(['fixed', 'deferred']), note: z.string().trim().max(1000).optional() })).default([]),
      nextServiceKm: z.number().int().min(0).nullish(), nextServiceAt: DateOnly.nullish(),
      vehicleStatusAfter: z.enum(['in_service', 'workshop', 'off_road']), statusNote: z.string().trim().max(500).optional(),
    }), req.body);
    const me = req.actor.id;
    return tx(req.db, async c => {
      const j = (await c.query('SELECT * FROM fleet_jobs WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!j) throw new Refused(404, ['no such job card']);
      if (j.status !== 'open') throw new Refused(409, ['this job card is already completed']);
      const linked = (await c.query('SELECT id, severity FROM vehicle_faults WHERE fleet_job_id = $1', [id])).rows;
      const given = new Map(b.faults.map(f => [f.id, f]));
      if (b.faults.some(f => !linked.some(l => l.id === f.id))) throw new Refused(400, ['a fault given is not on this job card']);
      const missing = F.missingToComplete({
        jobType: j.job_type, odometerIn: j.odometer_in, found: j.found_text, did: j.did_text, labourHours: j.labour_hours == null ? null : Number(j.labour_hours),
        afterPhotos: j.after_photo_ids.length, odometerOut: b.odometerOut,
        faults: linked.map(l => ({ id: l.id, severity: l.severity, outcome: given.get(l.id)?.outcome, note: given.get(l.id)?.note })),
        nextServiceKm: b.nextServiceKm, nextServiceAt: b.nextServiceAt, vehicleStatusAfter: b.vehicleStatusAfter,
      });
      if (missing.length) throw new Refused(409, missing);
      await recordKm(c, j.vehicle_id, b.odometerOut, b.at, 'fleet_job', id, me);
      for (const l of linked) {
        const g = given.get(l.id)!;
        await c.query('UPDATE vehicle_faults SET status = $2, closed_at = $3, closed_note = $4 WHERE id = $1', [l.id, g.outcome, b.at, g.note ?? null]);
      }
      await c.query(
        `UPDATE fleet_jobs SET status = 'completed', odometer_out = $2, next_service_km = $3, next_service_at = $4, completed_by = $5, completed_at = $6 WHERE id = $1`,
        [id, b.odometerOut, b.nextServiceKm ?? null, b.nextServiceAt ?? null, me, b.at],
      );
      const vSets = ['status = $2', 'status_note = $3', 'status_changed_at = $4'];
      const vVals: unknown[] = [j.vehicle_id, b.vehicleStatusAfter, b.vehicleStatusAfter === 'in_service' ? null : (b.statusNote ?? `After job card ${j.number}`), b.at];
      if (b.nextServiceKm && b.nextServiceAt) { vVals.push(b.nextServiceKm, b.nextServiceAt); vSets.push(`next_service_km = $${vVals.length - 1}`, `next_service_at = $${vVals.length}`); }
      await c.query(`UPDATE vehicles SET ${vSets.join(', ')} WHERE id = $1`, vVals);
      if (b.vehicleStatusAfter === 'in_service') {
        const reg = (await c.query('SELECT registration FROM vehicles WHERE id = $1', [j.vehicle_id])).rows[0].registration;
        await tellDriverAndManager(c, j.vehicle_id, `${reg} is back on the road (job card ${j.number})`);
      }
      await audit(c, me, 'fleet_job_completed', 'fleet_job', id, { number: j.number });
      return { id, status: 'completed' };
    });
  });

  // ---- Daily checks: oil, water and tyres on every vehicle in service, every day ----------------

  app.get('/fleet/daily-checks', async (req: FastifyRequest<{ Querystring: { date?: string } }>) => {
    viewer(req);
    const date = req.query.date ? parse(DateOnly, req.query.date) : today();
    const { rows } = await req.db.query(
      `SELECT v.id AS vehicle_id, v.registration, v.status, d.id, d.checked_at, u.full_name AS by, d.odometer_km, d.oil, d.oil_litres::float AS oil_litres,
              d.water, d.water_litres::float AS water_litres, d.tyres, d.notes
         FROM vehicles v LEFT JOIN daily_checks d ON d.vehicle_id = v.id AND d.check_date = $1 LEFT JOIN users u ON u.id = d.checked_by
        WHERE v.active ORDER BY (d.id IS NULL AND v.status = 'in_service') DESC, v.registration`, [date]);
    const due = rows.filter(r => r.status === 'in_service');
    return { date, done: due.filter(r => r.id).length, due: due.length, vehicles: rows.map(r => ({ ...r, required: r.status === 'in_service' })) };
  });

  app.post('/fleet/vehicles/:id/daily-check', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    mechanic(req);
    const vehicleId = parse(Uuid, req.params.id);
    const Fluid = z.enum(['ok', 'topped_up', 'problem']);
    const b = parse(z.object({
      id: Uuid.optional(), odometerKm: z.number().int().min(0), oil: Fluid, oilLitres: z.number().positive().max(20).nullish(),
      water: Fluid, waterLitres: z.number().positive().max(30).nullish(), tyres: z.enum(['ok', 'pressure_adjusted', 'problem']),
      notes: z.string().trim().max(1000).nullish(), photoIds: z.array(Uuid).max(10).default([]), at: Iso,
    }), req.body);
    const me = req.actor.id;
    const date = today();
    const out = await tx(req.db, async c => {
      const v = (await c.query('SELECT registration FROM vehicles WHERE id = $1 AND active', [vehicleId])).rows[0];
      if (!v) throw new Refused(404, ['no such vehicle']);
      const missing = F.missingOnDailyCheck(b, await latestKm(c, vehicleId));
      if (missing.length) throw new Refused(409, missing);
      if ((await c.query('SELECT 1 FROM daily_checks WHERE vehicle_id = $1 AND check_date = $2', [vehicleId, date])).rowCount) {
        throw new Refused(409, [`${v.registration} was already checked today`]);
      }
      const id = b.id ?? randomUUID();
      await c.query(
        `INSERT INTO daily_checks (id, vehicle_id, check_date, checked_at, checked_by, odometer_km, oil, oil_litres, water, water_litres, tyres, notes, photo_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, vehicleId, date, b.at, me, b.odometerKm, b.oil, b.oil === 'topped_up' ? b.oilLitres : null, b.water,
         b.water === 'topped_up' ? (b.waterLitres ?? null) : null, b.tyres, b.notes?.trim() || null, b.photoIds]);
      await recordKm(c, vehicleId, b.odometerKm, b.at, 'daily_check', id, me);
      const faults: string[] = [];
      for (const f of F.faultsFromDailyCheck(b)) {
        await c.query(
          `INSERT INTO vehicle_faults (vehicle_id, description, severity, source, source_id, reported_by, reported_at, photo_ids)
           VALUES ($1, $2, $3, 'mechanic', $4, $5, $6, $7)`, [vehicleId, f.description, f.severity, id, me, b.at, b.photoIds]);
        faults.push(f.description);
      }
      // An engine that keeps needing oil: raise it once, and tell the driver's manager.
      let oilWarning: string | null = null;
      if (b.oil === 'topped_up') {
        const ups = (await c.query(
          `SELECT oil_litres::float AS litres FROM daily_checks WHERE vehicle_id = $1 AND oil = 'topped_up' AND check_date > $2::date - $3::int`,
          [vehicleId, date, F.OIL_WATCH_DAYS])).rows;
        const w = F.oilWatch(ups);
        const already = (await c.query("SELECT 1 FROM vehicle_faults WHERE vehicle_id = $1 AND status IN ('open', 'in_progress') AND description LIKE 'Using oil:%'", [vehicleId])).rowCount;
        if (w.flag && !already) {
          await c.query(
            `INSERT INTO vehicle_faults (vehicle_id, description, severity, source, source_id, reported_by, reported_at)
             VALUES ($1, $2, 'urgent', 'mechanic', $3, $4, $5)`, [vehicleId, w.text, id, me, b.at]);
          await tellDriverAndManager(c, vehicleId, `${v.registration}: ${w.text}`);
          oilWarning = w.text;
        }
      }
      await audit(c, me, 'daily_check', 'vehicle', vehicleId, { oil: b.oil, oilLitres: b.oilLitres ?? null, water: b.water, tyres: b.tyres });
      return { id, faults, oilWarning };
    });
    return reply.code(201).send(out);
  });

  // ---- Bookings: vehicles booked in for a service or repair -----------------------------

  app.get('/fleet/bookings', async req => {
    viewer(req);
    const { rows } = await req.db.query(
      `SELECT b.id, b.vehicle_id, v.registration, b.job_type, to_char(b.booked_for, 'YYYY-MM-DD') AS booked_for, b.time_slot, b.place, b.reason,
              b.status, b.booked_at, u.full_name AS booked_by, b.fleet_job_id, b.cancelled_note,
              (SELECT u2.full_name FROM vehicle_scans s JOIN users u2 ON u2.id = s.user_id
                WHERE s.vehicle_id = v.id AND s.mode = 'driving' AND s.released_at IS NULL ORDER BY s.scanned_at DESC LIMIT 1) AS driver
         FROM fleet_bookings b JOIN vehicles v ON v.id = b.vehicle_id JOIN users u ON u.id = b.booked_by
        WHERE b.status = 'booked' OR b.booked_for >= current_date - 7
        ORDER BY (b.status = 'booked') DESC, b.booked_for, b.time_slot`,
    );
    return rows;
  });

  app.post('/fleet/vehicles/:id/bookings', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    mechanic(req);
    const vehicleId = parse(Uuid, req.params.id);
    const b = parse(z.object({
      id: Uuid.optional(), jobType: z.enum(F.JOB_TYPES as [F.FleetJobType, ...F.FleetJobType[]]), bookedFor: DateOnly,
      timeSlot: z.enum(['morning', 'afternoon', 'all_day']).default('morning'), place: z.string().trim().min(2).max(200).default('Own workshop'),
      reason: z.string().trim().min(5).max(1000), at: Iso,
    }), req.body);
    if (b.bookedFor < today()) throw new Refused(409, ['a booking cannot be in the past']);
    const out = await tx(req.db, async c => {
      const v = (await c.query('SELECT registration FROM vehicles WHERE id = $1', [vehicleId])).rows[0];
      if (!v) throw new Refused(404, ['no such vehicle']);
      const clash = (await c.query("SELECT to_char(booked_for, 'YYYY-MM-DD') AS d FROM fleet_bookings WHERE vehicle_id = $1 AND status = 'booked'", [vehicleId])).rows[0];
      if (clash) throw new Refused(409, [`${v.registration} is already booked for ${clash.d}: move that booking instead`]);
      const id = b.id ?? randomUUID();
      await c.query(
        'INSERT INTO fleet_bookings (id, vehicle_id, job_type, booked_for, time_slot, place, reason, booked_by, booked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [id, vehicleId, b.jobType, b.bookedFor, b.timeSlot, b.place, b.reason, req.actor.id, b.at]);
      await tellDriverAndManager(c, vehicleId, `${v.registration} is booked in for ${b.jobType} on ${b.bookedFor} (${slotText(b.timeSlot)}) at ${b.place}: ${b.reason}`);
      await audit(c, req.actor.id, 'fleet_booking', 'vehicle', vehicleId, b);
      return { id };
    });
    return reply.code(201).send(out);
  });

  app.post('/fleet/bookings/:id/move', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    mechanic(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ bookedFor: DateOnly, timeSlot: z.enum(['morning', 'afternoon', 'all_day']).optional(), note: z.string().trim().min(5, 'say why it is moved').max(500) }), req.body);
    if (b.bookedFor < today()) throw new Refused(409, ['a booking cannot be in the past']);
    return tx(req.db, async c => {
      const bk = (await c.query("SELECT b.vehicle_id, v.registration FROM fleet_bookings b JOIN vehicles v ON v.id = b.vehicle_id WHERE b.id = $1 AND b.status = 'booked' FOR UPDATE OF b", [id])).rows[0];
      if (!bk) throw new Refused(409, ['only a booking that has not started can be moved']);
      await c.query('UPDATE fleet_bookings SET booked_for = $2, time_slot = COALESCE($3, time_slot) WHERE id = $1', [id, b.bookedFor, b.timeSlot ?? null]);
      await tellDriverAndManager(c, bk.vehicle_id, `${bk.registration}'s booking moved to ${b.bookedFor}: ${b.note}`);
      await audit(c, req.actor.id, 'fleet_booking_moved', 'fleet_booking', id, b);
      return { id, bookedFor: b.bookedFor };
    });
  });

  app.post('/fleet/bookings/:id/cancel', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    mechanic(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ note: z.string().trim().min(5, 'say why it is cancelled').max(500) }), req.body);
    return tx(req.db, async c => {
      const bk = (await c.query("UPDATE fleet_bookings SET status = 'cancelled', cancelled_note = $2 WHERE id = $1 AND status = 'booked' RETURNING vehicle_id", [id, b.note])).rows[0];
      if (!bk) throw new Refused(409, ['only a booking that has not started can be cancelled']);
      const reg = (await c.query('SELECT registration FROM vehicles WHERE id = $1', [bk.vehicle_id])).rows[0].registration;
      await tellDriverAndManager(c, bk.vehicle_id, `${reg}'s booking is cancelled: ${b.note}`);
      return { id, status: 'cancelled' };
    });
  });

  // ---- Where every vehicle is: the tracker's latest position ---------------------------------

  app.get('/fleet/positions', async req => {
    viewer(req);
    const { rows } = await req.db.query(
      `SELECT v.id, v.registration, v.status, p.lat, p.lng, p.speed_kmh, p.ignition, p.recorded_at,
              (SELECT u.full_name FROM vehicle_scans s JOIN users u ON u.id = s.user_id
                WHERE s.vehicle_id = v.id AND s.mode = 'driving' AND s.released_at IS NULL ORDER BY s.scanned_at DESC LIMIT 1) AS driver
         FROM vehicles v
         LEFT JOIN LATERAL (SELECT * FROM tracker_positions t WHERE t.vehicle_id = v.id ORDER BY t.recorded_at DESC LIMIT 1) p ON true
        WHERE v.active ORDER BY v.registration`,
    );
    return rows.map(r => ({ ...r, minutesAgo: r.recorded_at ? Math.round((Date.now() - new Date(r.recorded_at).getTime()) / 60000) : null }));
  });

  // ---- Putting technicians in a vehicle when their phone is off or broken ----------------------

  app.get('/fleet/technicians', async req => {
    mechanic(req);
    const { rows } = await req.db.query(
      `SELECT u.id, u.full_name, s.mode, v.id AS vehicle_id, v.registration
         FROM users u
         LEFT JOIN LATERAL (SELECT * FROM vehicle_scans s WHERE s.user_id = u.id AND s.released_at IS NULL ORDER BY s.scanned_at DESC LIMIT 1) s ON true
         LEFT JOIN vehicles v ON v.id = s.vehicle_id
        WHERE u.login_level = 'technician' AND u.status = 'active' ORDER BY u.full_name`,
    );
    return rows;
  });

  app.post('/fleet/vehicles/:id/assign', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    mechanic(req);
    const vehicleId = parse(Uuid, req.params.id);
    const b = parse(z.object({
      technicianId: Uuid, mode: z.enum(['driving', 'riding_along']), reason: z.string().trim().min(5, 'say why you are doing it for him (e.g. phone broken)').max(500),
      km: z.number().int().min(0).optional(), at: Iso,
    }), req.body);
    const me = req.actor.id;
    return tx(req.db, async c => {
      const v = (await c.query('SELECT registration, status, status_note FROM vehicles WHERE id = $1 AND active FOR UPDATE', [vehicleId])).rows[0];
      if (!v) throw new Refused(404, ['no such vehicle']);
      const t = (await c.query("SELECT full_name FROM users WHERE id = $1 AND login_level = 'technician' AND status = 'active'", [b.technicianId])).rows[0];
      if (!t) throw new Refused(404, ['no such technician']);
      if (b.mode === 'driving') {
        const ok = F.canDrive(v.status);
        if (!ok.ok) throw new Refused(409, [ok.reason.replace('speak to the mechanic', 'put it back in service first')]);
        if (b.km === undefined) throw new Refused(409, ['odometer reading (km), so the handover is on record']);
        await recordKm(c, vehicleId, b.km, b.at, 'mechanic', null, me);
      }
      await c.query('UPDATE vehicle_scans SET released_at = $2 WHERE user_id = $1 AND released_at IS NULL', [b.technicianId, b.at]);
      if (b.mode === 'driving') {
        const prev = await c.query("UPDATE vehicle_scans SET released_at = $2 WHERE vehicle_id = $1 AND mode = 'driving' AND released_at IS NULL RETURNING user_id", [vehicleId, b.at]);
        for (const p of prev.rows) await notify(c, p.user_id, 'vehicle_taken', `${t.full_name} was put in ${v.registration} by the mechanic`, { vehicleId });
        await c.query('INSERT INTO tracker_driver_outbox (vehicle_id, driver_id) VALUES ($1, $2)', [vehicleId, b.technicianId]);
      }
      const scan = (await c.query(
        `INSERT INTO vehicle_scans (vehicle_id, user_id, mode, reason, reason_note, scanned_at, assigned_by, assign_reason)
         VALUES ($1, $2, $3, 'other', $4, $5, $6, $4) RETURNING id`,
        [vehicleId, b.technicianId, b.mode, b.reason, b.at, me])).rows[0];
      await notify(c, b.technicianId, 'vehicle_assigned', `The mechanic put you in ${v.registration} (${b.mode === 'driving' ? 'driving' : 'riding along'}): ${b.reason}`, { vehicleId });
      await notify(c, await managerOf(c, b.technicianId), 'vehicle_assigned', `${t.full_name} was put in ${v.registration} by the mechanic: ${b.reason}`, { vehicleId });
      await audit(c, me, 'vehicle_assigned', 'vehicle', vehicleId, { technicianId: b.technicianId, mode: b.mode, reason: b.reason });
      return { scanId: scan.id, vehicle: v.registration, technician: t.full_name };
    });
  });

  app.post('/fleet/technicians/:id/release', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    mechanic(req);
    const techId = parse(Uuid, req.params.id);
    const b = parse(z.object({ reason: z.string().trim().min(5).max(500), km: z.number().int().min(0).optional(), at: Iso }), req.body);
    return tx(req.db, async c => {
      const s = (await c.query('SELECT id, vehicle_id, mode FROM vehicle_scans WHERE user_id = $1 AND released_at IS NULL ORDER BY scanned_at DESC LIMIT 1 FOR UPDATE', [techId])).rows[0];
      if (!s) throw new Refused(409, ['no vehicle is on his name']);
      if (s.mode === 'driving') {
        if (b.km === undefined) throw new Refused(409, ['odometer reading (km)']);
        await recordKm(c, s.vehicle_id, b.km, b.at, 'release', s.id, req.actor.id);
        await c.query('INSERT INTO tracker_driver_outbox (vehicle_id, driver_id) VALUES ($1, NULL)', [s.vehicle_id]);
      }
      await c.query("UPDATE vehicle_scans SET released_at = $2, release_km = $3, release_note = $4, release_place = 'other' WHERE id = $1", [s.id, b.at, b.km ?? null, `By the mechanic: ${b.reason}`]);
      await notify(c, techId, 'vehicle_released', `The mechanic took the vehicle off your name: ${b.reason}`, { vehicleId: s.vehicle_id });
      await audit(c, req.actor.id, 'vehicle_released_for', 'user', techId, { reason: b.reason });
      return { released: true };
    });
  });

}

/** The vehicle's usual driver and his manager hear when it goes off the road or comes back. */
async function tellDriverAndManager(c: Q, vehicleId: string, msg: string) {
  const drivers = (await c.query(
    `SELECT DISTINCT user_id FROM (
       SELECT user_id FROM technician_settings WHERE usual_vehicle_id = $1
       UNION SELECT user_id FROM vehicle_scans WHERE vehicle_id = $1 AND mode = 'driving' AND released_at IS NULL) x`, [vehicleId])).rows.map(r => r.user_id);
  const told = new Set<string>();
  for (const d of drivers) {
    for (const who of [d, await managerOf(c, d)]) {
      if (who && !told.has(who)) { told.add(who); await notify(c, who, 'vehicle_status', msg, { vehicleId }); }
    }
  }
}

const slotText = (s: string) => (s === 'all_day' ? 'all day' : s);

const toDate = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10));
