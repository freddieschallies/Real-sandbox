// One person's profile: picture, where they are and what they are busy with right now, contact
// details, and personal details (only for whoever manages access: the CEO or someone given it).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, tx } from '../db.ts';
import { POSITION_LABEL, TRADES, can, type LoginLevel, type Trade } from '../core/permissions.ts';
import { DateOnly, Refused, Uuid, parse } from '../http.ts';
import { kitAllowed, recordsAllowed } from './staff.ts';

export function registerPeopleRoutes(app: FastifyInstance) {
  const office = (req: FastifyRequest) => {
    if (!can(req.actor, 'manage_access') && !can(req.actor, 'view_all_job_cards') && !can(req.actor, 'assign_jobs')) throw new Refused(403, ['people are not part of your work']);
  };

  app.get('/people/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    office(req);
    const id = parse(Uuid, req.params.id);
    const db = req.db;
    const u = (await db.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.login_level, u.trade, u.status, u.department_id, d.name AS department, p.photo_id, p.emergency_name, p.emergency_phone,
              p.id_number, to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, p.home_address, to_char(p.start_date, 'YYYY-MM-DD') AS start_date, p.notes
         FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = $1`, [id])).rows[0];
    if (!u) throw new Refused(404, ['no such person']);

    // Right now: the vehicle on their name, who else is in it, the job they are busy with, where they are.
    const scan = (await db.query(
      `SELECT s.vehicle_id, s.mode, s.scanned_at, v.registration FROM vehicle_scans s JOIN vehicles v ON v.id = s.vehicle_id
        WHERE s.user_id = $1 AND s.released_at IS NULL ORDER BY s.scanned_at DESC LIMIT 1`, [id])).rows[0] ?? null;
    const inVehicle = scan ? (await db.query(
      `SELECT u.id, u.full_name, s.mode FROM vehicle_scans s JOIN users u ON u.id = s.user_id
        WHERE s.vehicle_id = $1 AND s.released_at IS NULL AND s.user_id <> $2 ORDER BY u.full_name`, [scan.vehicle_id, id])).rows : [];
    const job = (await db.query(
      `SELECT j.id, j.job_number, j.status, j.fault_reported, s.name AS store, s.lat, s.lng, (j.lead_technician_id = $1) AS lead,
              (SELECT max(v.started_at) FROM job_visits v WHERE v.job_id = j.id) AS started_at
         FROM jobs j JOIN stores s ON s.id = j.store_id
        WHERE (j.lead_technician_id = $1 OR EXISTS (SELECT 1 FROM job_helpers h WHERE h.job_id = j.id AND h.user_id = $1))
          AND j.status IN ('in_progress', 'assigned', 'continue_later') AND j.scheduled_date <= current_date
        ORDER BY (j.status = 'in_progress') DESC, j.scheduled_date, j.job_number LIMIT 1`, [id])).rows[0] ?? null;
    const onJob = job ? (await db.query(
      `SELECT u.id, u.full_name FROM users u WHERE u.id <> $2 AND (u.id = (SELECT lead_technician_id FROM jobs WHERE id = $1)
         OR u.id IN (SELECT user_id FROM job_helpers WHERE job_id = $1)) ORDER BY u.full_name`, [job.id, id])).rows : [];
    const pos = scan ? (await db.query(
      `SELECT lat, lng, speed_kmh, ignition, recorded_at FROM tracker_positions WHERE vehicle_id = $1 ORDER BY recorded_at DESC LIMIT 1`, [scan.vehicle_id])).rows[0] : null;
    const location = pos ? { source: 'vehicle tracker', lat: pos.lat, lng: pos.lng, moving: !!pos.ignition, speedKmh: pos.speed_kmh, minutesAgo: Math.round((Date.now() - new Date(pos.recorded_at).getTime()) / 60000) }
      : job?.status === 'in_progress' ? { source: 'on site', lat: job.lat, lng: job.lng, moving: false, speedKmh: 0, minutesAgo: null } : null;

    const withNames = [...new Map([...inVehicle, ...onJob].map(p => [p.id, p.full_name])).values()];
    const personal = can(req.actor, 'manage_access');
    return {
      id: u.id, full_name: u.full_name, position: POSITION_LABEL[u.login_level as LoginLevel], login_level: u.login_level, trade: u.trade,
      tradeLabel: u.trade ? TRADES[u.trade as Trade] : null, department: u.department, status: u.status, photo_id: u.photo_id,
      now: {
        vehicle: scan ? { id: scan.vehicle_id, registration: scan.registration, mode: scan.mode, since: scan.scanned_at } : null,
        job: job ? { id: job.id, number: job.job_number, status: job.status, store: job.store, fault: job.fault_reported, lead: job.lead, startedAt: job.started_at } : null,
        with: withNames,
        location,
      },
      contact: { phone: u.phone, email: u.email, emergency_name: u.emergency_name, emergency_phone: u.emergency_phone },
      personal: personal ? { id_number: u.id_number, date_of_birth: u.date_of_birth, home_address: u.home_address, start_date: u.start_date, notes: u.notes } : null,
      canEdit: personal,
      record: recordsAllowed(req.actor, { id: u.id, department_id: u.department_id }),
      kit: kitAllowed(req.actor, u.id),
    };
  });

  app.put('/people/:id/profile', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!can(req.actor, 'manage_access')) throw new Refused(403, ['only whoever manages access edits profiles']);
    const id = parse(Uuid, req.params.id);
    const t = (n: number) => z.string().trim().max(n).nullish();
    const b = parse(z.object({
      phone: t(30), email: z.string().trim().email('a valid email').max(200).nullish().or(z.literal('')), emergencyName: t(100), emergencyPhone: t(30),
      idNumber: t(20), dateOfBirth: DateOnly.nullish(), homeAddress: t(300), startDate: DateOnly.nullish(), notes: t(2000), photoId: Uuid.nullish(),
    }), req.body);
    return tx(req.db, async c => {
      if (!(await c.query("SELECT 1 FROM users WHERE id = $1 AND status <> 'left'", [id])).rowCount) throw new Refused(404, ['no such person']);
      if (b.photoId && !(await c.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'profile'", [b.photoId])).rowCount) throw new Refused(409, ['upload the picture first']);
      if (b.email && (await c.query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [b.email, id])).rowCount) throw new Refused(409, ['that email is already someone else\'s login']);
      if (b.phone !== undefined || b.email !== undefined) {
        await c.query('UPDATE users SET phone = COALESCE($2, phone), email = CASE WHEN $3::text IS NULL THEN email ELSE NULLIF($3, \'\') END WHERE id = $1',
          [id, b.phone === undefined ? null : (b.phone || null), b.email === undefined ? null : b.email]);
      }
      await c.query(
        `INSERT INTO user_profiles (user_id, photo_id, emergency_name, emergency_phone, id_number, date_of_birth, home_address, start_date, notes, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_id) DO UPDATE SET photo_id = COALESCE(EXCLUDED.photo_id, user_profiles.photo_id),
           emergency_name = EXCLUDED.emergency_name, emergency_phone = EXCLUDED.emergency_phone, id_number = EXCLUDED.id_number,
           date_of_birth = EXCLUDED.date_of_birth, home_address = EXCLUDED.home_address, start_date = EXCLUDED.start_date, notes = EXCLUDED.notes,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [id, b.photoId ?? null, b.emergencyName || null, b.emergencyPhone || null, b.idNumber || null, b.dateOfBirth ?? null, b.homeAddress || null, b.startDate ?? null, b.notes || null, req.actor.id]);
      // The audit log notes that the profile changed, not the personal details themselves.
      await audit(c, req.actor.id, 'profile_edited', 'user', id, { fields: Object.keys(b).filter(k => (b as Record<string, unknown>)[k] !== undefined) });
      return { id };
    });
  });
}
