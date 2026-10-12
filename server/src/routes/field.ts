// What a technician's phone uses outside the job card itself.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Db, Q } from '../db.ts';
import { audit, raiseFlag, tx } from '../db.ts';
import { can, departmentsFor } from '../core/permissions.ts';
import { fuelProblems } from '../core/rules.ts';
import * as H from '../core/handover.ts';
import { registrationCandidates } from '../core/vehicleCode.ts';
import { canDrive } from '../core/fleet.ts';
import { faultsFromHandover, recordKm } from './fleet.ts';
import { Iso, Point, Refused, Uuid, parse } from '../http.ts';
import { openFile, readUpload, removeFile, saveFile } from '../uploads.ts';

/** The manager of a person's department, if any. */
export async function managerOf(c: Q | Db, userId: string): Promise<string | null> {
  const { rows } = await c.query(
    'SELECT d.manager_id FROM users u JOIN departments d ON d.id = u.department_id WHERE u.id = $1',
    [userId],
  );
  return rows[0]?.manager_id ?? null;
}

export async function notify(c: Q | Db, recipientId: string | null, kind: string, message: string, details: object = {}) {
  if (!recipientId) return;
  await c.query('INSERT INTO notifications (recipient_id, kind, message, details) VALUES ($1, $2, $3, $4)',
    [recipientId, kind, message, JSON.stringify(details)]);
}

async function nameOf(c: Q, userId: string): Promise<string> {
  return (await c.query('SELECT full_name FROM users WHERE id = $1', [userId])).rows[0]?.full_name ?? 'unknown';
}

const Inspection = z.object({
  id: Uuid.optional(),
  odometerKm: z.number().int().min(0).max(5_000_000),
  fuelLevel: z.enum(H.FUEL_LEVELS),
  checks: z.record(z.string(), z.object({ ok: z.boolean(), note: z.string().max(1000).optional() })),
  sidePhotos: z.record(z.string(), Uuid),
  damagePhotos: z.array(Uuid).max(30).default([]),
  driverSignatureId: Uuid,
  handoverBy: z.enum(['previous_driver', 'supervisor', 'remote_approval']),
  handedOverByName: z.string().max(200).optional(),
  handoverSignatureId: Uuid.optional(),
  remoteReason: z.string().max(1000).optional(),
}).strict();
type InspectionIn = z.infer<typeof Inspection>;

/** The vehicle for a scanned code: our own sticker, or the licence disc / typed registration. */
async function findVehicle(c: Q, code: string): Promise<{ id: string; registration: string; active: boolean } | null> {
  const own = (await c.query('SELECT id, registration, active FROM vehicles WHERE barcode = $1', [code.trim()])).rows[0];
  if (own) return own;
  const regs = registrationCandidates(code);
  if (!regs.length) return null;
  const { rows } = await c.query(
    "SELECT id, registration, active FROM vehicles WHERE regexp_replace(upper(registration), '[^A-Z0-9]', '', 'g') = ANY($1)", [regs]);
  return rows.length === 1 ? rows[0] : null;
}

interface HandoverCtx {
  lastDriver: { id: string; name: string } | null;
  prev: H.PreviousInspection | null;
  prevAt: string | null;
  prevBy: string | null;
}

/** Who drove this vehicle last and what the last handover recorded. */
async function handoverContext(c: Q, vehicleId: string): Promise<HandoverCtx> {
  const last = (await c.query(
    `SELECT s.user_id, u.full_name FROM vehicle_scans s JOIN users u ON u.id = s.user_id
      WHERE s.vehicle_id = $1 AND s.mode = 'driving' ORDER BY s.scanned_at DESC LIMIT 1`, [vehicleId])).rows[0];
  const prev = (await c.query(
    `SELECT i.odometer_km, i.problems, i.inspected_at, u.full_name FROM vehicle_inspections i JOIN users u ON u.id = i.driver_id
      WHERE i.vehicle_id = $1 AND i.status <> 'rejected' ORDER BY i.inspected_at DESC LIMIT 1`, [vehicleId])).rows[0];
  return {
    lastDriver: last ? { id: last.user_id, name: last.full_name } : null,
    prev: prev ? { odometerKm: prev.odometer_km, problems: prev.problems } : null,
    prevAt: prev?.inspected_at ?? null,
    prevBy: prev?.full_name ?? null,
  };
}

async function saveInspection(c: Q, me: string, v: { id: string; registration: string }, i: InspectionIn, h: HandoverCtx, at: string): Promise<string> {
  const insp: H.Inspection = {
    odometerKm: i.odometerKm, fuelLevel: i.fuelLevel, checks: i.checks, sidePhotos: i.sidePhotos, damagePhotos: i.damagePhotos,
    driverSignatureId: i.driverSignatureId, handoverBy: i.handoverBy, handedOverByName: i.handedOverByName,
    handoverSignatureId: i.handoverSignatureId, remoteReason: i.remoteReason,
  };
  const missing = H.missingOnInspection(insp, h.prev);
  if (missing.length) throw new Refused(409, missing);
  if (i.handoverBy === 'previous_driver' && !h.lastDriver) throw new Refused(409, ['nobody has driven this vehicle before: a supervisor must sign the handover']);

  // Every photo must be one this driver uploaded, of the right kind.
  const want: [string, string][] = [
    ...H.SIDES.map(s => [i.sidePhotos[s], `vehicle_${s}`] as [string, string]),
    ...i.damagePhotos.map(p => [p, 'vehicle_damage'] as [string, string]),
    [i.driverSignatureId, 'handover_signature'],
    ...(i.handoverSignatureId ? [[i.handoverSignatureId, 'handover_signature'] as [string, string]] : []),
  ];
  for (const [pid, kind] of want) {
    const ok = await c.query('SELECT 1 FROM photos WHERE id = $1 AND kind = $2 AND taken_by = $3', [pid, kind, me]);
    if (!ok.rowCount) throw new Refused(409, [`upload the ${kind.replace(/_/g, ' ')} photo first`]);
  }
  if (i.handoverSignatureId && i.handoverSignatureId === i.driverSignatureId) throw new Refused(409, ['the handover needs a second signature, not yours']);

  const problems = H.problemsOf(insp);
  const fresh = H.newProblems(insp, h.prev);
  const status = i.handoverBy === 'remote_approval' ? 'awaiting_approval' : 'signed';
  const id = i.id ?? randomUUID();
  await c.query(
    `INSERT INTO vehicle_inspections (id, vehicle_id, driver_id, previous_driver_id, inspected_at, odometer_km, fuel_level, checks,
       problems, new_problems, photo_ids, driver_signature_id, acceptance_text, handover_by, handed_over_by_name,
       handover_signature_id, remote_reason, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [id, v.id, me, h.lastDriver && h.lastDriver.id !== me ? h.lastDriver.id : null, at, i.odometerKm, i.fuelLevel, JSON.stringify(i.checks),
      problems, fresh, [...H.SIDES.map(s => i.sidePhotos[s]), ...i.damagePhotos], i.driverSignatureId, H.ACCEPTANCE_TEXT,
      i.handoverBy, i.handedOverByName?.trim() ?? null, i.handoverSignatureId ?? null, i.remoteReason?.trim() ?? null, status],
  );

  // The km go into the vehicle's history; new problems become faults for the mechanic.
  await recordKm(c, v.id, i.odometerKm, at, 'handover', id, me);
  if (fresh.length) {
    await faultsFromHandover(c, v.id, id, me, at, fresh.map(k => ({ key: k, label: H.CHECKS.find(x => x[0] === k)![1], note: (i.checks as Record<string, { note?: string }>)[k]?.note })), i.damagePhotos);
  }
  const myName = await nameOf(c, me);
  const mgr = await managerOf(c, me);
  if (fresh.length) {
    const labels = fresh.map(k => H.CHECKS.find(x => x[0] === k)![1]);
    const prevId = h.lastDriver && h.lastDriver.id !== me ? h.lastDriver.id : null;
    await raiseFlag(c, {
      type: 'vehicle_new_damage', technicianId: prevId, vehicleId: v.id, severity: 'high',
      question: prevId ? `${myName} found problems on ${v.registration} that were not there when you took it over. Explain what happened.` : undefined,
      details: { inspectionId: id, problems: fresh, labels },
    });
    const prevMgr = prevId ? await managerOf(c, prevId) : null;
    for (const m of new Set([mgr, prevMgr])) await notify(c, m, 'vehicle_new_damage', `${v.registration}: new problems found at handover – ${labels.join('; ')}`, { inspectionId: id });
  }
  if (status === 'awaiting_approval') {
    await notify(c, mgr, 'handover_approval', `${myName} took over ${v.registration} with nobody to sign the handover: approve or reject`, { inspectionId: id });
  }
  return id;
}

export function registerFieldRoutes(app: FastifyInstance, db: Db) {
  // ---- Photos that aren't on a work item: slips and signatures -----------

  app.post('/photos', async (req, reply) => {
    const up = await readUpload(req);
    const f = parse(z.object({
      kind: z.enum(['signature', 'fuel_slip', 'supplier_slip', 'bought_out_slip', 'vehicle_front', 'vehicle_back', 'vehicle_left',
        'vehicle_right', 'vehicle_dashboard', 'vehicle_damage', 'handover_signature', 'stock_item', 'delivery_note', 'profile',
        'fleet_before', 'fleet_after', 'fleet_fault', 'fleet_slip', 'logo']),
      takenAt: Iso, id: Uuid.optional(), jobId: Uuid.optional(),
    }), up.fields);
    if (f.kind === 'signature' && !f.jobId) throw new Refused(400, ['a signature belongs to a job: send jobId']);
    const id = f.id ?? randomUUID();
    const rel = await saveFile(req.companyId, id, up, f.takenAt);
    try {
      await req.db.query(
        'INSERT INTO photos (id, kind, job_id, file_path, taken_at, taken_by, content_type, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, f.kind, f.jobId ?? null, rel, f.takenAt, req.actor.id, up.mimetype, up.buffer.length],
      );
    } catch (e) {
      await removeFile(rel);
      throw e;
    }
    return reply.code(201).send({ id });
  });

  app.get('/photos/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const id = parse(Uuid, req.params.id);
    const { rows } = await req.db.query('SELECT file_path, content_type, taken_by, purged_at, purge_reason, kind FROM photos WHERE id = $1', [id]);
    const p = rows[0];
    if (!p) throw new Refused(404, ['no such photo']);
    if (p.purged_at) throw new Refused(410, [`this photo is no longer kept: ${p.purge_reason}`]);
    // The company logo is for everyone in the company; other photos for whoever took them, or the office.
    if (p.kind !== 'logo' && p.taken_by !== req.actor.id && !can(req.actor, 'view_all_job_cards')) throw new Refused(403, ['not your photo']);
    reply.header('content-type', p.content_type ?? 'image/jpeg').header('cache-control', 'private, max-age=86400');
    return reply.send(openFile(p.file_path));
  });

  // ---- My day -------------------------------------------------------------

  app.get('/me/today', async req => {
    const q = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
    const today = q.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
    const me = req.actor.id;
    const jobs = await req.db.query(
      `SELECT j.id, j.job_number, j.job_type, j.priority, j.status, j.scheduled_date, j.fault_reported,
              s.name AS store, s.address, s.lat, s.lng,
              (j.lead_technician_id = $1) AS i_am_lead,
              (SELECT v.planned_return_date FROM job_visits v WHERE v.job_id = j.id ORDER BY v.go_at DESC LIMIT 1) AS planned_return,
              (j.status NOT IN ('closed', 'cancelled') AND j.scheduled_date < $2::date) AS carried_over
         FROM jobs j JOIN stores s ON s.id = j.store_id
        WHERE (j.lead_technician_id = $1 OR EXISTS (SELECT 1 FROM job_helpers h WHERE h.job_id = j.id AND h.user_id = $1))
          AND ((j.status NOT IN ('closed', 'cancelled') AND j.scheduled_date <= $2::date) OR (j.status = 'closed' AND j.closed_at::date = $2::date))
        ORDER BY (j.status = 'closed'), (j.priority = 'urgent') DESC, j.scheduled_date, j.job_number`,
      [me, today],
    );
    const vehicle = await req.db.query(
      `SELECT v.id, v.registration, s.mode, s.scanned_at, s.dropped_off_at, i.status AS handover_status, s.assigned_by IS NOT NULL AS assigned_by_mechanic,
              (SELECT json_build_object('bookedFor', to_char(b.booked_for, 'YYYY-MM-DD'), 'timeSlot', b.time_slot, 'place', b.place, 'jobType', b.job_type, 'reason', b.reason)
                 FROM fleet_bookings b WHERE b.vehicle_id = v.id AND b.status = 'booked' ORDER BY b.booked_for LIMIT 1) AS booking
         FROM vehicle_scans s JOIN vehicles v ON v.id = s.vehicle_id
         LEFT JOIN vehicle_inspections i ON i.id = s.inspection_id
        WHERE s.user_id = $1 AND s.released_at IS NULL ORDER BY s.scanned_at DESC LIMIT 1`,
      [me],
    );
    const flags = await req.db.query("SELECT count(*)::int AS n FROM flags WHERE technician_id = $1 AND status = 'open' AND question IS NOT NULL", [me]);
    const notes = await req.db.query('SELECT count(*)::int AS n FROM notifications WHERE recipient_id = $1 AND read_at IS NULL', [me]);
    return {
      date: today,
      jobs: jobs.rows,
      vehicle: vehicle.rows[0] ?? null,
      flagsToAnswer: flags.rows[0].n,
      unreadNotices: notes.rows[0].n,
    };
  });

  app.get('/me/stock', async req => {
    const { rows } = await req.db.query(
      `SELECT i.id, i.code, i.description, i.unit,
              SUM(h.qty) - COALESCE((SELECT SUM(p.qty) FROM pending_returns p WHERE p.technician_id = $1 AND p.stock_item_id = i.id), 0) AS qty
         FROM technician_holdings h JOIN stock_items i ON i.id = h.stock_item_id
        WHERE h.technician_id = $1 GROUP BY i.id HAVING SUM(h.qty) > 0 ORDER BY i.code`,
      [req.actor.id],
    );
    return rows.map(r => ({ ...r, qty: Number(r.qty) }));
  });

  app.get('/me/flags', async req => {
    const { rows } = await req.db.query(
      `SELECT id, flag_type, severity, raised_at, question, explanation, status, details, job_id
         FROM flags WHERE technician_id = $1 AND status IN ('open', 'explained') ORDER BY raised_at DESC`,
      [req.actor.id],
    );
    return rows;
  });

  app.post('/flags/:id/explain', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ explanation: z.string().trim().min(10, 'give a proper explanation (at least a short sentence)').max(2000) }), req.body);
    const { rows } = await req.db.query(
      `UPDATE flags SET explanation = $3, explained_at = now(), status = 'explained'
        WHERE id = $1 AND technician_id = $2 AND status = 'open' RETURNING id, status`,
      [id, req.actor.id, b.explanation],
    );
    if (!rows[0]) throw new Refused(404, ['no open flag of yours with that id']);
    return rows[0];
  });

  app.get('/me/notifications', async req => {
    const { rows } = await req.db.query(
      'SELECT id, kind, message, details, created_at, read_at FROM notifications WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.actor.id],
    );
    return rows;
  });

  app.post('/notifications/:id/read', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    await req.db.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND recipient_id = $2 AND read_at IS NULL', [id, req.actor.id]);
    return { ok: true };
  });

  // ---- Vehicles: barcode scan-in is the master record of who is in which vehicle ----

  // What the phone needs to know before the scan: who drove it last and whether an inspection is needed.
  app.get('/vehicles/lookup', async req => {
    const q = parse(z.object({ barcode: z.string().min(3).max(600), mode: z.enum(['driving', 'riding_along']).default('driving') }), req.query);
    const v = await findVehicle(req.db, q.barcode);
    if (!v || !v.active) throw new Refused(404, ['unknown vehicle barcode']);
    const h = await handoverContext(req.db, v.id);
    return {
      vehicle: { id: v.id, registration: v.registration },
      lastDriver: h.lastDriver,
      lastInspection: h.prev ? { odometerKm: h.prev.odometerKm, problems: h.prev.problems, at: h.prevAt, by: h.prevBy } : null,
      needsInspection: H.needsInspection(q.mode, h.lastDriver?.id ?? null, req.actor.id, !!h.prev),
    };
  });


  app.post('/vehicles/scan', async req => {
    const b = parse(z.object({
      barcode: z.string().min(3).max(600),
      mode: z.enum(['driving', 'riding_along']),
      at: Iso,
      reason: z.enum(['usual', 'breakdown', 'service', 'swapped_with_colleague', 'other']).default('usual'),
      reasonNote: z.string().max(500).optional(),
      inspection: Inspection.optional(),
    }), req.body);
    const me = req.actor.id;
    return tx(req.db, async c => {
      const found = await findVehicle(c, b.barcode);
      const v = found ? (await c.query('SELECT id, registration, active FROM vehicles WHERE id = $1 FOR UPDATE', [found.id])).rows[0] : null;
      if (!v || !v.active) throw new Refused(404, ['unknown vehicle barcode']);
      if (b.mode === 'driving') {
        const st = (await c.query('SELECT status, status_note FROM vehicles WHERE id = $1', [v.id])).rows[0];
        const ok = canDrive(st.status);
        if (!ok.ok) throw new Refused(409, [ok.reason + (st.status_note ? ` (${st.status_note})` : '')]);
      }
      const usual = (await c.query('SELECT usual_vehicle_id FROM technician_settings WHERE user_id = $1', [me])).rows[0]?.usual_vehicle_id ?? null;
      const notUsual = usual !== null && usual !== v.id;
      if (notUsual && b.mode === 'driving' && b.reason === 'usual') throw new Refused(409, ['this is not your usual vehicle: choose a reason']);
      if (b.reason === 'other' && !b.reasonNote?.trim()) throw new Refused(409, ['say what the other reason is']);

      // Handover inspection: taking over a vehicle as its driver means signing for its condition.
      const h = await handoverContext(c, v.id);
      const needed = H.needsInspection(b.mode, h.lastDriver?.id ?? null, me, !!h.prev);
      let inspectionId: string | null = null;
      if (needed && !b.inspection) throw new Refused(409, ['inspect the vehicle and sign for it before you drive it']);
      if (b.inspection && b.mode === 'driving') {
        inspectionId = await saveInspection(c, me, v, b.inspection, h, b.at);
      }

      // Release whatever I was in before.
      await c.query('UPDATE vehicle_scans SET released_at = $2 WHERE user_id = $1 AND released_at IS NULL', [me, b.at]);
      if (b.mode === 'driving') {
        // Only one driver: whoever was driving this vehicle is no longer its driver.
        const prev = await c.query(
          "UPDATE vehicle_scans SET released_at = $2 WHERE vehicle_id = $1 AND mode = 'driving' AND released_at IS NULL RETURNING user_id",
          [v.id, b.at],
        );
        for (const p of prev.rows) await notify(c, p.user_id, 'vehicle_taken', `${await nameOf(c, me)} is now driving ${v.registration}`, { vehicleId: v.id });
        await c.query('INSERT INTO tracker_driver_outbox (vehicle_id, driver_id) VALUES ($1, $2)', [v.id, me]);
      }
      const { rows } = await c.query(
        `INSERT INTO vehicle_scans (vehicle_id, user_id, mode, reason, reason_note, scanned_at, inspection_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [v.id, me, b.mode, b.reason, b.reasonNote ?? null, b.at, inspectionId],
      );

      // Someone else's usual vehicle: both supervisors get a notice.
      const owner = (await c.query('SELECT user_id FROM technician_settings WHERE usual_vehicle_id = $1 AND user_id <> $2', [v.id, me])).rows[0]?.user_id;
      if (owner) {
        const msg = `${await nameOf(c, me)} scanned into ${v.registration}, usually ${await nameOf(c, owner)}'s (${b.reason.replace(/_/g, ' ')})`;
        const mgrs = new Set([await managerOf(c, me), await managerOf(c, owner)]);
        for (const m of mgrs) await notify(c, m, 'vehicle_swap', msg, { vehicleId: v.id, scanId: rows[0].id });
      }
      await audit(c, me, 'vehicle_scan', 'vehicle', v.id, { mode: b.mode, reason: b.reason, inspectionId });
      // The scan only counts once the tracker shows this vehicle's ignition within 10 minutes;
      // the tracker connection fills ignition_confirmed_at or raises scan_not_confirmed.
      const status = inspectionId ? (await c.query('SELECT status FROM vehicle_inspections WHERE id = $1', [inspectionId])).rows[0].status : null;
      return { scanId: rows[0].id, vehicle: { id: v.id, registration: v.registration }, mode: b.mode, awaitingIgnition: true, inspectionId, handoverStatus: status };
    });
  });

  // Supervisor: remote handovers waiting for a decision, and the decision itself.
  app.get('/vehicles/inspections', async req => {
    const q = parse(z.object({ status: z.enum(['signed', 'awaiting_approval', 'approved', 'rejected']).optional(), vehicleId: Uuid.optional() }), req.query);
    const depts = departmentsFor(req.actor, 'resolve_flags');
    if (!depts) throw new Refused(403, ['you cannot see vehicle handovers']);
    const { rows } = await req.db.query(
      `SELECT i.id, i.vehicle_id, v.registration, i.driver_id, d.full_name AS driver, i.previous_driver_id, p.full_name AS previous_driver,
              i.inspected_at, i.odometer_km, i.fuel_level, i.checks, i.problems, i.new_problems, i.photo_ids,
              i.driver_signature_id, i.handover_by, i.handed_over_by_name, i.handover_signature_id, i.remote_reason,
              i.status, i.decided_at, i.decision_note
         FROM vehicle_inspections i JOIN vehicles v ON v.id = i.vehicle_id JOIN users d ON d.id = i.driver_id
         LEFT JOIN users p ON p.id = i.previous_driver_id
        WHERE ($1::handover_status IS NULL OR i.status = $1) AND ($2::uuid IS NULL OR i.vehicle_id = $2)
          AND ($3::uuid[] IS NULL OR d.department_id = ANY($3))
        ORDER BY i.inspected_at DESC LIMIT 200`,
      [q.status ?? null, q.vehicleId ?? null, depts === 'all' ? null : depts],
    );
    return rows;
  });

  app.post('/vehicles/inspections/:id/decide', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().max(2000).optional() }), req.body);
    if (!b.approve && (b.note ?? '').length < 5) throw new Refused(400, ['say why the handover is rejected']);
    return tx(req.db, async c => {
      const i = (await c.query(
        `SELECT i.status, i.driver_id, u.department_id, v.registration FROM vehicle_inspections i
           JOIN users u ON u.id = i.driver_id JOIN vehicles v ON v.id = i.vehicle_id WHERE i.id = $1 FOR UPDATE OF i`, [id])).rows[0];
      if (!i) throw new Refused(404, ['no such inspection']);
      if (!can(req.actor, 'resolve_flags', { employeeId: i.driver_id, employeeDepartmentId: i.department_id })) throw new Refused(403, ['not your department']);
      if (i.driver_id === req.actor.id) throw new Refused(403, ['you cannot approve your own handover']);
      if (i.status !== 'awaiting_approval') throw new Refused(409, ['this handover is not waiting for approval']);
      const status = b.approve ? 'approved' : 'rejected';
      await c.query('UPDATE vehicle_inspections SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1',
        [id, status, req.actor.id, b.note ?? null]);
      await notify(c, i.driver_id, `handover_${status}`, `Your handover of ${i.registration} was ${status}${b.note ? `: ${b.note}` : ''}`, { inspectionId: id });
      await audit(c, req.actor.id, `handover_${status}`, 'vehicle_inspection', id);
      return { id, status };
    });
  });

  // Taking a vehicle off his name: the driver records the km and where he left it.
  app.post('/vehicles/release', async req => {
    const b = parse(z.object({
      at: Iso, km: z.number().int().min(0).max(5_000_000).optional(),
      place: z.enum(['office_yard', 'home', 'workshop', 'other']).optional(), note: z.string().trim().max(500).optional(),
    }), req.body);
    const me = req.actor.id;
    return tx(req.db, async c => {
      const s = (await c.query(
        `SELECT s.id, s.vehicle_id, s.mode, v.registration FROM vehicle_scans s JOIN vehicles v ON v.id = s.vehicle_id
          WHERE s.user_id = $1 AND s.released_at IS NULL ORDER BY s.scanned_at DESC LIMIT 1 FOR UPDATE OF s`, [me])).rows[0];
      if (!s) throw new Refused(409, ['no vehicle is on your name']);
      if (s.mode === 'driving') {
        const missing: string[] = [];
        if (b.km === undefined) missing.push('odometer reading (km)');
        if (!b.place) missing.push('where you left the vehicle');
        if (b.place === 'other' && !(b.note && b.note.length >= 5)) missing.push('say where the vehicle is');
        if (missing.length) throw new Refused(409, missing);
        if (b.place === 'home') {
          const ok = (await c.query('SELECT may_take_vehicle_home FROM technician_settings WHERE user_id = $1', [me])).rows[0]?.may_take_vehicle_home;
          if (!ok) throw new Refused(409, ['you are not approved to take a vehicle home: leave it at the office yard']);
        }
        await recordKm(c, s.vehicle_id, b.km!, b.at, 'release', s.id, me);
        await c.query('INSERT INTO tracker_driver_outbox (vehicle_id, driver_id) VALUES ($1, NULL)', [s.vehicle_id]);
      }
      await c.query('UPDATE vehicle_scans SET released_at = $2, release_km = $3, release_place = $4, release_note = $5 WHERE id = $1',
        [s.id, b.at, b.km ?? null, b.place ?? null, b.note ?? null]);
      await audit(c, me, 'vehicle_released', 'vehicle', s.vehicle_id, { km: b.km, place: b.place });
      return { released: s.registration };
    });
  });

  app.post('/vehicles/dropped-off', async req => {
    const b = parse(z.object({ at: Iso, position: Point.optional() }), req.body);
    const { rows } = await req.db.query(
      `UPDATE vehicle_scans SET dropped_off_at = $2
        WHERE user_id = $1 AND released_at IS NULL AND mode = 'riding_along' AND dropped_off_at IS NULL RETURNING id`,
      [req.actor.id, b.at],
    );
    if (!rows[0]) throw new Refused(409, ['you are not riding along in a vehicle']);
    return { ok: true };
  });

  app.post('/vehicles/picked-up', async req => {
    const b = parse(z.object({ at: Iso }), req.body);
    const { rows } = await req.db.query(
      `UPDATE vehicle_scans SET dropped_off_at = NULL
        WHERE user_id = $1 AND released_at IS NULL AND dropped_off_at IS NOT NULL RETURNING id`,
      [req.actor.id],
    );
    if (!rows[0]) throw new Refused(409, ['you were not dropped off']);
    await audit(req.db, req.actor.id, 'picked_up', 'vehicle_scan', rows[0].id, { at: b.at });
    return { ok: true };
  });

  // ---- Fuel: logged against the vehicle, litres required ----

  app.post('/fuel', async (req, reply) => {
    const b = parse(z.object({
      id: Uuid.optional(),
      vehicleId: Uuid.optional(),
      litres: z.number().positive().max(400),
      amountCents: z.number().int().positive(),
      slipPhotoId: Uuid,
      at: Iso,
      position: Point.optional(),
    }), req.body);
    const me = req.actor.id;
    const out = await tx(req.db, async c => {
      let vehicleId = b.vehicleId;
      if (!vehicleId) {
        vehicleId = (await c.query('SELECT vehicle_id FROM vehicle_scans WHERE user_id = $1 AND released_at IS NULL ORDER BY scanned_at DESC LIMIT 1', [me])).rows[0]?.vehicle_id;
        if (!vehicleId) throw new Refused(409, ['scan into a vehicle first, or choose the vehicle']);
      }
      const v = (await c.query('SELECT registration, tank_litres FROM vehicles WHERE id = $1', [vehicleId])).rows[0];
      if (!v) throw new Refused(404, ['unknown vehicle']);
      const slip = await c.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'fuel_slip' AND taken_by = $2", [b.slipPhotoId, me]);
      if (!slip.rowCount) throw new Refused(409, ['upload the fuel slip photo first']);
      const id = b.id ?? randomUUID();
      await c.query(
        `INSERT INTO fuel_logs (id, vehicle_id, user_id, litres, amount_cents, slip_photo_id, logged_at, lat, lng)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, vehicleId, me, b.litres, b.amountCents, b.slipPhotoId, b.at, b.position?.lat ?? null, b.position?.lng ?? null],
      );
      // Checks that need no tracker data run now; "was the vehicle stopped" and fuel use per 100 km
      // are checked by the tracker connection once it has the trip data.
      const problems = fuelProblems({ litres: b.litres, tankLitres: Number(v.tank_litres), vehicleStoppedAtLogTime: true });
      if (problems.length) {
        await raiseFlag(c, { type: 'fuel_mismatch', technicianId: me, vehicleId, question: 'Explain this fuel entry', details: { fuelLogId: id, problems } });
      }
      return { id, vehicle: v.registration, problems };
    });
    return reply.code(201).send(out);
  });
}
