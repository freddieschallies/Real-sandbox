// One person's profile: picture, where they are and what they are busy with right now, contact
// details, and personal details (only for whoever manages access: the CEO or someone given it).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, tx, type Q } from '../db.ts';
import { POSITION_LABEL, TRADES, can, departmentsFor, editsProfiles, type LoginLevel, type Trade, seesPeople } from '../core/permissions.ts';
import { vanOf } from '../vanRepo.ts';
import { notify } from './field.ts';
import { DateOnly, Refused, Uuid, parse } from '../http.ts';
import { kitAllowed, recordsAllowed } from './staff.ts';

export function registerPeopleRoutes(app: FastifyInstance) {
  const office = (req: FastifyRequest) => {
    if (!seesPeople(req.actor)) throw new Refused(403, ['people are not part of your work']);
  };

  app.get('/people/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    office(req);
    const id = parse(Uuid, req.params.id);
    const db = req.db;
    const u = (await db.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.login_level, u.trade, u.status, u.department_id, d.name AS department, d.logo_photo_id AS department_logo, p.photo_id, p.emergency_name, p.emergency_phone,
              p.id_number, to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, p.home_address, to_char(p.start_date, 'YYYY-MM-DD') AS start_date, p.notes
         FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = $1`, [id])).rows[0];
    if (u) {
      u.manager = (await db.query('SELECT m.full_name FROM departments d JOIN users m ON m.id = d.manager_id WHERE d.id = $1', [u.department_id])).rows[0]?.full_name ?? null;
      // A department manager: the technicians who work under him.
      u.team = (await db.query(
        `SELECT t.id, t.full_name, d.name AS department FROM departments d JOIN users t ON t.department_id = d.id
          WHERE d.manager_id = $1 AND t.login_level = 'technician' AND t.status <> 'left' ORDER BY d.name, t.full_name`, [id])).rows;
    }
    if (!u) throw new Refused(404, ['no such person']);

    const now = await nowOf(db, id);
    // The CEO and HR see and edit personal details; HR keeps the record of someone who has left.
    const personal = editsProfiles(req.actor);
    const termination = u.status === 'left' ? (await db.query(
      `SELECT to_char(t.terminated_on, 'YYYY-MM-DD') AS date, t.reason, t.note, t.position, t.department, t.on_name, b.full_name AS by
         FROM terminations t JOIN users b ON b.id = t.terminated_by WHERE t.user_id = $1`, [id])).rows[0] ?? null : null;
    return {
      id: u.id, full_name: u.full_name, position: POSITION_LABEL[u.login_level as LoginLevel], login_level: u.login_level, trade: u.trade,
      tradeLabel: u.trade ? TRADES[u.trade as Trade] : null, department: u.department, departmentId: u.department_id, departmentLogo: u.department_logo ?? null, manager: u.manager, team: u.team, status: u.status, photo_id: u.photo_id,
      now,
      contact: { phone: u.phone, email: u.email, emergency_name: u.emergency_name, emergency_phone: u.emergency_phone },
      personal: personal ? { id_number: u.id_number, date_of_birth: u.date_of_birth, home_address: u.home_address, start_date: u.start_date, notes: u.notes } : null,
      canEdit: personal && u.status !== 'left',
      canTerminate: personal && u.status !== 'left' && !['director', 'creator'].includes(u.login_level) && u.id !== req.actor.id,
      termination: termination && (personal || can(req.actor, 'manage_access')) ? termination : termination ? { date: termination.date } : null,
      record: recordsAllowed(req.actor, { id: u.id, department_id: u.department_id }),
      kit: kitAllowed(req.actor, u.id),
    };
  });

  // A department manager's map: where each technician in his team is, in which vehicle, on which
  // job and with whom. The CEO (all departments) sees every technician.
  app.get('/team/map', async req => {
    if (!can(req.actor, 'view_live_map_positions')) throw new Refused(403, ['the map is not part of your work']);
    const scope = departmentsFor(req.actor, 'view_flags');
    const managed = (await req.db.query('SELECT id FROM departments WHERE manager_id = $1', [req.actor.id])).rows.map(r => r.id as string);
    const all = scope === 'all';
    const depts = all ? [] : [...new Set([...(scope ?? []), ...managed])];
    // Only whoever watches over technicians (a department manager, the CEO, or someone given flags).
    if (!all && !depts.length) throw new Refused(403, ['you have no team on the map']);
    const techs = (await req.db.query(
      `SELECT u.id, u.full_name, u.trade, d.name AS department, p.photo_id FROM users u LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE u.login_level = 'technician' AND u.status = 'active' AND ($1::boolean OR u.department_id = ANY($2))
        ORDER BY d.name NULLS LAST, u.full_name`, [all, depts])).rows;
    const technicians = [];
    for (const t of techs) technicians.push({ id: t.id, full_name: t.full_name, tradeLabel: t.trade ? TRADES[t.trade as Trade] : null, department: t.department, photo_id: t.photo_id, now: await nowOf(req.db, t.id) });
    const departments = all ? [...new Set(techs.map(t => t.department).filter(Boolean))] : (await req.db.query('SELECT name FROM departments WHERE id = ANY($1) ORDER BY name', [depts])).rows.map(r => r.name);
    return { all, departments, technicians };
  });

  app.put('/people/:id/profile', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!editsProfiles(req.actor)) throw new Refused(403, ['only HR or the CEO edits profiles']);
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

const REASONS = { resigned: 'Resigned', dismissed: 'Dismissed', retrenched: 'Retrenched', contract_ended: 'Contract ended', retired: 'Retired', other: 'Other' } as const;

export function registerTerminationRoutes(app: FastifyInstance) {
  // HR (or the CEO) ends someone's employment. They come off every list and their login stops; what
  // was on their name is kept with the record and the stockroom is told to collect it.
  app.post('/people/:id/terminate', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!editsProfiles(req.actor)) throw new Refused(403, ['only HR or the CEO ends someone\'s employment']);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ date: DateOnly, reason: z.enum(Object.keys(REASONS) as [keyof typeof REASONS, ...(keyof typeof REASONS)[]]), note: z.string().trim().max(2000).optional() }), req.body);
    if (id === req.actor.id) throw new Refused(409, ['you cannot end your own employment here']);
    if (b.reason === 'other' && (!b.note || b.note.length < 3)) throw new Refused(400, ['say what the reason is']);
    return tx(req.db, async c => {
      const u = (await c.query(`SELECT u.full_name, u.login_level, u.status, d.name AS department FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = $1 FOR UPDATE OF u`, [id])).rows[0];
      if (!u) throw new Refused(404, ['no such person']);
      if (u.status === 'left') throw new Refused(409, [`${u.full_name} is already with the terminated staff`]);
      if (['director', 'creator'].includes(u.login_level)) throw new Refused(403, ['the CEO\'s position is not ended here']);
      const open = (await c.query("SELECT job_number FROM jobs WHERE lead_technician_id = $1 AND status NOT IN ('closed', 'cancelled') ORDER BY job_number", [id])).rows.map(r => r.job_number);
      if (open.length) throw new Refused(409, [`give ${u.full_name.split(' ')[0]}'s open jobs to someone else first: ${open.map(n => `#${n}`).join(', ')}`]);
      // Tools and ladders from the tool store come back (signed) before employment ends.
      const tools = (await c.query('SELECT t.name, t.serial FROM tool_bookings b JOIN store_tools t ON t.id = b.tool_id WHERE b.user_id = $1 AND b.returned_at IS NULL', [id])).rows;
      if (tools.length) throw new Refused(409, [`the stockroom signs back the tools ${u.full_name.split(' ')[0]} has from the tool store first: ${tools.map(t => `${t.name}${t.serial ? ` (${t.serial})` : ''}`).join(', ')}`]);
      // What is still on his name, for the stockroom to collect.
      const kit = (await c.query("SELECT kind, name, detail, qty::float AS qty FROM person_kit WHERE user_id = $1 AND status = 'issued' ORDER BY kind, name", [id])).rows;
      const van = [...(await vanOf(c, id)).entries()].filter(([, q]) => q > 0);
      const items = van.length ? (await c.query('SELECT id, code, description FROM stock_items WHERE id = ANY($1)', [van.map(([k]) => k)])).rows : [];
      const stock = van.map(([k, q]) => ({ code: items.find(i => i.id === k)?.code ?? '', description: items.find(i => i.id === k)?.description ?? '', qty: q }));
      await c.query(`INSERT INTO terminations (user_id, terminated_on, reason, note, position, department, on_name, terminated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, b.date, b.reason, b.note || null, POSITION_LABEL[u.login_level as LoginLevel], u.department, JSON.stringify({ kit, stock }), req.actor.id]);
      await c.query("UPDATE departments SET manager_id = NULL WHERE manager_id = $1", [id]);
      await c.query("UPDATE users SET status = 'left', login_enabled = false, department_id = NULL WHERE id = $1", [id]);
      await c.query('INSERT INTO access_changes (changed_by, user_id, action, change) VALUES ($1, $2, $3, $4)', [req.actor.id, id, 'terminated', `Employment ended ${b.date}: ${REASONS[b.reason]}`]);
      await audit(c, req.actor.id, 'employment_ended', 'user', id, { date: b.date, reason: b.reason });
      if (kit.length || stock.length) {
        const what = [...kit.map(k => `${k.name}${k.qty !== 1 ? ` ×${k.qty}` : ''}`), ...stock.map(s => `${s.description} ×${s.qty}`)].join(', ');
        for (const s of (await c.query("SELECT id FROM users WHERE login_level = 'stockroom' AND status <> 'left'")).rows) {
          await notify(c, s.id, 'terminated', `${u.full_name} has left the company. Collect what is still on his name: ${what}.`, { userId: id });
        }
      }
      return { id, status: 'left', onName: { kit, stock } };
    });
  });

  // HR's Terminated staff: everyone whose employment ended, with the record.
  app.get('/people/terminated', async req => {
    if (!editsProfiles(req.actor)) throw new Refused(403, ['terminated staff are kept by HR']);
    return (await req.db.query(
      `SELECT u.id, u.full_name, p.photo_id, to_char(t.terminated_on, 'YYYY-MM-DD') AS date, t.reason, t.note, t.position, t.department, b.full_name AS by,
              (jsonb_array_length(COALESCE(t.on_name->'kit', '[]')) + jsonb_array_length(COALESCE(t.on_name->'stock', '[]')))::int AS items_on_name
         FROM terminations t JOIN users u ON u.id = t.user_id JOIN users b ON b.id = t.terminated_by LEFT JOIN user_profiles p ON p.user_id = u.id
        ORDER BY t.terminated_on DESC, u.full_name`)).rows.map(r => ({ ...r, reasonLabel: REASONS[r.reason as keyof typeof REASONS] }));
  });
}

/** Right now: the vehicle on his name, who else is in it, the job he is busy with, where he is. */
export async function nowOf(db: Q, id: string) {
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
  return {
    vehicle: scan ? { id: scan.vehicle_id, registration: scan.registration, mode: scan.mode, since: scan.scanned_at } : null,
    job: job ? { id: job.id, number: job.job_number, status: job.status, store: job.store, fault: job.fault_reported, lead: job.lead, startedAt: job.started_at } : null,
    with: withNames,
    location,
  };
}
