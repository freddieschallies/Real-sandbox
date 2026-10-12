// What a technician's phone uses outside the job card itself.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Client, Db } from '../db.ts';
import { audit, raiseFlag, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import { fuelProblems } from '../core/rules.ts';
import { Iso, Point, Refused, Uuid, parse } from '../http.ts';
import { openFile, readUpload, removeFile, saveFile } from '../uploads.ts';

/** The manager of a person's department, if any. */
export async function managerOf(c: Client | Db, userId: string): Promise<string | null> {
  const { rows } = await c.query(
    'SELECT d.manager_id FROM users u JOIN departments d ON d.id = u.department_id WHERE u.id = $1',
    [userId],
  );
  return rows[0]?.manager_id ?? null;
}

export async function notify(c: Client | Db, recipientId: string | null, kind: string, message: string, details: object = {}) {
  if (!recipientId) return;
  await c.query('INSERT INTO notifications (recipient_id, kind, message, details) VALUES ($1, $2, $3, $4)',
    [recipientId, kind, message, JSON.stringify(details)]);
}

async function nameOf(c: Client, userId: string): Promise<string> {
  return (await c.query('SELECT full_name FROM users WHERE id = $1', [userId])).rows[0]?.full_name ?? 'unknown';
}

export function registerFieldRoutes(app: FastifyInstance, db: Db) {
  // ---- Photos that aren't on a work item: slips and signatures -----------

  app.post('/photos', async (req, reply) => {
    const up = await readUpload(req);
    const f = parse(z.object({
      kind: z.enum(['signature', 'fuel_slip', 'supplier_slip', 'bought_out_slip']),
      takenAt: Iso, id: Uuid.optional(), jobId: Uuid.optional(),
    }), up.fields);
    if (f.kind === 'signature' && !f.jobId) throw new Refused(400, ['a signature belongs to a job: send jobId']);
    const id = f.id ?? randomUUID();
    const rel = await saveFile(id, up, f.takenAt);
    try {
      await db.query(
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
    const { rows } = await db.query('SELECT file_path, content_type, taken_by FROM photos WHERE id = $1', [id]);
    const p = rows[0];
    if (!p) throw new Refused(404, ['no such photo']);
    if (p.taken_by !== req.actor.id && !can(req.actor, 'view_all_job_cards')) throw new Refused(403, ['not your photo']);
    reply.header('content-type', p.content_type ?? 'image/jpeg').header('cache-control', 'private, max-age=86400');
    return reply.send(openFile(p.file_path));
  });

  // ---- My day -------------------------------------------------------------

  app.get('/me/today', async req => {
    const q = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
    const today = q.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
    const me = req.actor.id;
    const jobs = await db.query(
      `SELECT j.id, j.job_number, j.job_type, j.priority, j.status, j.scheduled_date, j.fault_reported,
              s.name AS store, s.address, s.lat, s.lng,
              (j.lead_technician_id = $1) AS i_am_lead,
              (SELECT v.planned_return_date FROM job_visits v WHERE v.job_id = j.id ORDER BY v.go_at DESC LIMIT 1) AS planned_return,
              (j.status <> 'closed' AND j.scheduled_date < $2::date) AS carried_over
         FROM jobs j JOIN stores s ON s.id = j.store_id
        WHERE (j.lead_technician_id = $1 OR EXISTS (SELECT 1 FROM job_helpers h WHERE h.job_id = j.id AND h.user_id = $1))
          AND ((j.status <> 'closed' AND j.scheduled_date <= $2::date) OR (j.status = 'closed' AND j.closed_at::date = $2::date))
        ORDER BY (j.status = 'closed'), (j.priority = 'urgent') DESC, j.scheduled_date, j.job_number`,
      [me, today],
    );
    const vehicle = await db.query(
      `SELECT v.id, v.registration, s.mode, s.scanned_at, s.dropped_off_at
         FROM vehicle_scans s JOIN vehicles v ON v.id = s.vehicle_id
        WHERE s.user_id = $1 AND s.released_at IS NULL ORDER BY s.scanned_at DESC LIMIT 1`,
      [me],
    );
    const flags = await db.query("SELECT count(*)::int AS n FROM flags WHERE technician_id = $1 AND status = 'open' AND question IS NOT NULL", [me]);
    const notes = await db.query('SELECT count(*)::int AS n FROM notifications WHERE recipient_id = $1 AND read_at IS NULL', [me]);
    return {
      date: today,
      jobs: jobs.rows,
      vehicle: vehicle.rows[0] ?? null,
      flagsToAnswer: flags.rows[0].n,
      unreadNotices: notes.rows[0].n,
    };
  });

  app.get('/me/stock', async req => {
    const { rows } = await db.query(
      `SELECT i.id, i.code, i.description, i.unit, ts.qty
         FROM technician_stock ts JOIN stock_items i ON i.id = ts.stock_item_id
        WHERE ts.technician_id = $1 AND ts.qty <> 0 ORDER BY i.code`,
      [req.actor.id],
    );
    return rows.map(r => ({ ...r, qty: Number(r.qty) }));
  });

  app.get('/me/flags', async req => {
    const { rows } = await db.query(
      `SELECT id, flag_type, severity, raised_at, question, explanation, status, details, job_id
         FROM flags WHERE technician_id = $1 AND status IN ('open', 'explained') ORDER BY raised_at DESC`,
      [req.actor.id],
    );
    return rows;
  });

  app.post('/flags/:id/explain', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ explanation: z.string().trim().min(10, 'give a proper explanation (at least a short sentence)').max(2000) }), req.body);
    const { rows } = await db.query(
      `UPDATE flags SET explanation = $3, explained_at = now(), status = 'explained'
        WHERE id = $1 AND technician_id = $2 AND status = 'open' RETURNING id, status`,
      [id, req.actor.id, b.explanation],
    );
    if (!rows[0]) throw new Refused(404, ['no open flag of yours with that id']);
    return rows[0];
  });

  app.get('/me/notifications', async req => {
    const { rows } = await db.query(
      'SELECT id, kind, message, details, created_at, read_at FROM notifications WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.actor.id],
    );
    return rows;
  });

  app.post('/notifications/:id/read', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    await db.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND recipient_id = $2 AND read_at IS NULL', [id, req.actor.id]);
    return { ok: true };
  });

  // ---- Vehicles: barcode scan-in is the master record of who is in which vehicle ----

  app.post('/vehicles/scan', async req => {
    const b = parse(z.object({
      barcode: z.string().min(3).max(100),
      mode: z.enum(['driving', 'riding_along']),
      at: Iso,
      reason: z.enum(['usual', 'breakdown', 'service', 'swapped_with_colleague', 'other']).default('usual'),
      reasonNote: z.string().max(500).optional(),
    }), req.body);
    const me = req.actor.id;
    return tx(db, async c => {
      const v = (await c.query('SELECT id, registration, active FROM vehicles WHERE barcode = $1', [b.barcode])).rows[0];
      if (!v || !v.active) throw new Refused(404, ['unknown vehicle barcode']);
      const usual = (await c.query('SELECT usual_vehicle_id FROM technician_settings WHERE user_id = $1', [me])).rows[0]?.usual_vehicle_id ?? null;
      const notUsual = usual !== null && usual !== v.id;
      if (notUsual && b.mode === 'driving' && b.reason === 'usual') throw new Refused(409, ['this is not your usual vehicle: choose a reason']);
      if (b.reason === 'other' && !b.reasonNote?.trim()) throw new Refused(409, ['say what the other reason is']);

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
        `INSERT INTO vehicle_scans (vehicle_id, user_id, mode, reason, reason_note, scanned_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [v.id, me, b.mode, b.reason, b.reasonNote ?? null, b.at],
      );

      // Someone else's usual vehicle: both supervisors get a notice.
      const owner = (await c.query('SELECT user_id FROM technician_settings WHERE usual_vehicle_id = $1 AND user_id <> $2', [v.id, me])).rows[0]?.user_id;
      if (owner) {
        const msg = `${await nameOf(c, me)} scanned into ${v.registration}, usually ${await nameOf(c, owner)}'s (${b.reason.replace(/_/g, ' ')})`;
        const mgrs = new Set([await managerOf(c, me), await managerOf(c, owner)]);
        for (const m of mgrs) await notify(c, m, 'vehicle_swap', msg, { vehicleId: v.id, scanId: rows[0].id });
      }
      await audit(c, me, 'vehicle_scan', 'vehicle', v.id, { mode: b.mode, reason: b.reason });
      // The scan only counts once the tracker shows this vehicle's ignition within 10 minutes;
      // the tracker connection fills ignition_confirmed_at or raises scan_not_confirmed.
      return { scanId: rows[0].id, vehicle: { id: v.id, registration: v.registration }, mode: b.mode, awaitingIgnition: true };
    });
  });

  app.post('/vehicles/dropped-off', async req => {
    const b = parse(z.object({ at: Iso, position: Point.optional() }), req.body);
    const { rows } = await db.query(
      `UPDATE vehicle_scans SET dropped_off_at = $2
        WHERE user_id = $1 AND released_at IS NULL AND mode = 'riding_along' AND dropped_off_at IS NULL RETURNING id`,
      [req.actor.id, b.at],
    );
    if (!rows[0]) throw new Refused(409, ['you are not riding along in a vehicle']);
    return { ok: true };
  });

  app.post('/vehicles/picked-up', async req => {
    const b = parse(z.object({ at: Iso }), req.body);
    const { rows } = await db.query(
      `UPDATE vehicle_scans SET dropped_off_at = NULL
        WHERE user_id = $1 AND released_at IS NULL AND dropped_off_at IS NOT NULL RETURNING id`,
      [req.actor.id],
    );
    if (!rows[0]) throw new Refused(409, ['you were not dropped off']);
    await audit(db, req.actor.id, 'picked_up', 'vehicle_scan', rows[0].id, { at: b.at });
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
    const out = await tx(db, async c => {
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
