// Workshop repairs. A machine is uplifted from the client's site to our workshop (photos and the store
// manager's signature), repaired in the workshop (visits checked against the workshop's location), and
// delivered back, or collected by the client at the workshop. A loan machine from the company's list
// can stand in meanwhile. The job card stays open until the machine is back and the loan machine is in.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, raiseFlag, tx, type Q } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as J from '../core/jobCard.ts';
import { Iso, Point, Refused, Uuid, parse } from '../http.ts';
import { notify } from './field.ts';
import { actOnJob, createJob } from './jobs.ts';


type P = { Params: { id: string } };

/** What the job card shows about workshop repairs. */
export async function repairView(c: Q, jobId: string, card: J.JobCard) {
  const moves = (await c.query(
    `SELECT m.id, m.kind, m.place, m.at, m.note, m.person_name, m.photo_ids, m.signature_photo_id, m.loan_machine_id,
            lm.name AS loan_machine, lm.serial AS loan_serial, u.full_name AS by_name
       FROM machine_moves m JOIN users u ON u.id = m.by_user LEFT JOIN loan_machines lm ON lm.id = m.loan_machine_id
      WHERE m.job_id = $1 ORDER BY m.at, m.created_at`, [jobId])).rows;
  // Loan machines still at the client on this job: their last move is a loan_out on this job.
  const out = (await c.query(
    `SELECT lm.id, lm.name, lm.serial, last.at AS since
       FROM loan_machines lm
       JOIN LATERAL (SELECT m.kind, m.job_id, m.at FROM machine_moves m WHERE m.loan_machine_id = lm.id ORDER BY m.at DESC, m.created_at DESC LIMIT 1) last ON true
      WHERE last.kind = 'loan_out' AND last.job_id = $1 ORDER BY lm.name`, [jobId])).rows;
  const ws = (await c.query('SELECT name, address, lat, lng, geofence_m FROM company_workshop')).rows[0] ?? null;
  const last = card.visits.at(-1);
  const at = J.machineAt(card);
  return {
    machine_at: at,
    loans_out: card.loansOut ?? 0,
    loans_out_list: out,
    moves,
    workshop: ws,
    ready_to_deliver: at === 'workshop' && last?.place === 'workshop' && last.state === 'done',
  };
}

/** The company's loan machines and where each one is. */
async function loanList(c: Q) {
  const { rows } = await c.query(
    `SELECT lm.id, lm.name, lm.serial, lm.asset_number, lm.notes, lm.active,
            last.kind AS last_kind, last.at AS last_at, j.id AS job_id, j.job_number, s.name AS store, u.full_name AS by_name
       FROM loan_machines lm
       LEFT JOIN LATERAL (SELECT m.kind, m.at, m.job_id, m.by_user FROM machine_moves m WHERE m.loan_machine_id = lm.id ORDER BY m.at DESC, m.created_at DESC LIMIT 1) last ON true
       LEFT JOIN jobs j ON j.id = last.job_id LEFT JOIN stores s ON s.id = j.store_id LEFT JOIN users u ON u.id = last.by_user
      ORDER BY lm.active DESC, lm.name`);
  return rows.map(r => ({
    id: r.id, name: r.name, serial: r.serial, asset_number: r.asset_number, notes: r.notes, active: r.active,
    out: r.last_kind === 'loan_out',
    ...(r.last_kind === 'loan_out' ? { job_id: r.job_id, job_number: r.job_number, store: r.store, since: r.last_at, by_name: r.by_name } : {}),
  }));
}

/** Every photo must be one this person took for this job, of the right kind. */
async function checkPhotos(c: Q, ids: string[], kind: string, jobId: string, me: string) {
  const ok = await c.query('SELECT count(*)::int AS n FROM photos WHERE id = ANY($1) AND kind = $2 AND job_id = $3 AND taken_by = $4', [ids, kind, jobId, me]);
  if (ok.rows[0].n !== new Set(ids).size) throw new Refused(409, ['send the photos first (they need signal once)']);
}
async function checkSignature(c: Q, id: string, jobId: string) {
  const sig = await c.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'signature' AND job_id = $2", [id, jobId]);
  if (!sig.rowCount) throw new Refused(409, ['send the store manager signature first']);
}
async function tellOffice(c: Q, kind: string, message: string, details: object) {
  for (const o of (await c.query("SELECT id FROM users WHERE login_level IN ('admin', 'management', 'director', 'creator') AND status <> 'left'")).rows) {
    await notify(c, o.id, kind, message, details);
  }
}
const nameOf = async (c: Q, id: string) => (await c.query('SELECT full_name FROM users WHERE id = $1', [id])).rows[0]?.full_name ?? 'The technician';
const storeOf = async (c: Q, jobId: string) => (await c.query('SELECT s.name, j.job_number FROM jobs j JOIN stores s ON s.id = j.store_id WHERE j.id = $1', [jobId])).rows[0];

const Photos = z.array(Uuid).min(1).max(12);

export function registerRepairRoutes(app: FastifyInstance) {
  // ---- The technician -------------------------------------------------------

  app.post('/jobs/:id/workshop-start', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({
      at: Iso, position: Point.optional(), outsideReason: z.string().max(500).optional(),
      safety: z.object({ areaSafe: z.boolean(), isolated: z.boolean() }),
    }), req.body);
    return actOnJob(req, card => J.startAtWorkshop(card, { at: b.at, position: b.position, safety: b.safety, outsideReason: b.outsideReason }),
      async ({ c, row, actorId }, res) => {
        const outside = res.flags?.includes('arrived_outside_geofence');
        await c.query(
          `INSERT INTO job_visits (job_id, technician_id, state, place, go_at, arrived_at, safety_check, arrived_outside_geofence_reason)
           VALUES ($1, $2, 'arrived', 'workshop', $3, $3, $4, $5)`,
          [row.id, actorId, b.at, JSON.stringify({ ...b.safety, publicClear: true }), outside ? b.outsideReason : null]);
        await c.query("UPDATE jobs SET status = 'in_progress' WHERE id = $1", [row.id]);
        if (outside) await raiseFlag(c, { type: 'arrived_outside_geofence', technicianId: actorId, jobId: row.id, details: { position: b.position, reason: b.outsideReason, workshop: true } });
      });
  });

  app.post('/jobs/:id/uplift', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({
      at: Iso, reason: z.string().max(2000), managerName: z.string().max(200), signaturePhotoId: Uuid,
      photoIds: Photos, equipmentId: Uuid.optional(),
    }), req.body);
    return actOnJob(req, card => J.uplift(card, { at: b.at, reason: b.reason, managerName: b.managerName, photos: b.photoIds.length, signed: true }),
      async ({ c, row, visitId, actorId }) => {
        await checkPhotos(c, b.photoIds, 'uplift', row.id, actorId);
        await checkSignature(c, b.signaturePhotoId, row.id);
        if (b.equipmentId && !(await c.query('SELECT 1 FROM equipment WHERE id = $1 AND store_id = $2', [b.equipmentId, row.store_id])).rowCount) {
          throw new Refused(400, ['that equipment is not registered at this store']);
        }
        await c.query(
          `INSERT INTO machine_moves (job_id, visit_id, kind, place, equipment_id, note, person_name, signature_photo_id, photo_ids, at, by_user)
           VALUES ($1, $2, 'uplifted', 'site', $3, $4, $5, $6, $7, $8, $9)`,
          [row.id, visitId, b.equipmentId ?? null, b.reason.trim(), b.managerName.trim(), b.signaturePhotoId, b.photoIds, b.at, actorId]);
        await c.query('UPDATE visit_pauses SET resumed_at = $2 WHERE visit_id = $1 AND resumed_at IS NULL', [visitId, b.at]);
        await c.query("UPDATE job_visits SET state = 'uplifted', ended_at = $2, progress_note = $3 WHERE id = $1", [visitId, b.at, b.reason.trim()]);
        await c.query("UPDATE jobs SET status = 'continue_later' WHERE id = $1", [row.id]);
        await audit(c, actorId, 'machine_uplifted', 'job', row.id, { jobNumber: row.job_number });
        const j = await storeOf(c, row.id);
        await tellOffice(c, 'machine_uplifted', `${await nameOf(c, actorId)} uplifted the machine at ${j.name} (job ${j.job_number}) to the workshop. Signed for by ${b.managerName.trim()}.`, { jobId: row.id });
      });
  });

  // The office books a machine into the workshop: the client brought it in, or we collected it (not
  // every unit can be repaired on site: bakery equipment, water pumps, ...). It becomes a workshop
  // repair job card for the technician who repairs it, with the machine and who handed it over.
  // The machines registered at a store, to choose the one being booked in.
  app.get('/stores/:id/equipment', async (req: FastifyRequest<P>) => {
    if (!can(req.actor, 'assign_jobs') && !can(req.actor, 'manage_stores_equipment')) throw new Refused(403, ['for the office']);
    return (await req.db.query('SELECT id, description, brand, model, serial FROM equipment WHERE store_id = $1 ORDER BY description', [parse(Uuid, req.params.id)])).rows;
  });

  app.post('/workshop/book-in', async (req, reply) => {
    if (!can(req.actor, 'assign_jobs')) throw new Refused(403, ['the office books machines into the workshop']);
    const b = parse(z.object({
      storeId: Uuid,
      equipmentId: Uuid.optional(),
      machine: z.object({ description: z.string().trim().min(2, 'what the machine is').max(200), brand: z.string().trim().max(100).optional(), model: z.string().trim().max(100).optional(), serial: z.string().trim().max(100).optional() }).optional(),
      faultReported: z.string().trim().min(3, 'what is wrong with it').max(2000),
      cameIn: z.enum(['client_brought', 'we_collected']),
      handedOverBy: z.string().trim().max(200).optional(),
      leadTechnicianId: Uuid,
      clientOrderRef: z.string().trim().max(100).optional(),
      priority: z.enum(['urgent', 'normal', 'scheduled']).default('normal'),
      note: z.string().trim().max(1000).optional(),
      holdOk: z.boolean().optional(),
    }), req.body);
    if (!b.equipmentId && !b.machine) throw new Refused(400, ['which machine: choose it, or type what it is']);
    const out = await tx(req.db, async c => {
      let equipmentId = b.equipmentId ?? null;
      if (equipmentId) {
        if (!(await c.query('SELECT 1 FROM equipment WHERE id = $1 AND store_id = $2', [equipmentId, b.storeId])).rowCount) throw new Refused(400, ['that machine is not registered at this store']);
      } else {
        equipmentId = (await c.query('INSERT INTO equipment (store_id, description, brand, model, serial) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [b.storeId, b.machine!.description, b.machine!.brand || null, b.machine!.model || null, b.machine!.serial || null])).rows[0].id;
      }
      const eq = (await c.query('SELECT description, brand, model, serial FROM equipment WHERE id = $1', [equipmentId])).rows[0];
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
      const jobId = await createJob(c, req.actor.id, { jobType: 'workshop_repair', priority: b.priority, storeId: b.storeId, clientOrderRef: b.clientOrderRef,
        faultReported: b.faultReported, scheduledDate: today, leadTechnicianId: b.leadTechnicianId, helperIds: [], maintenanceSteps: [], holdOk: b.holdOk });
      await c.query('UPDATE work_items SET equipment_id = $2 WHERE job_id = $1', [jobId, equipmentId]);
      const how = b.cameIn === 'client_brought' ? 'Brought in by the client' : 'Collected by us';
      await c.query(
        `INSERT INTO machine_moves (job_id, kind, place, equipment_id, note, person_name, at, by_user) VALUES ($1, 'booked_in', 'workshop', $2, $3, $4, now(), $5)`,
        [jobId, equipmentId, [how, b.note].filter(Boolean).join(': '), b.handedOverBy || null, req.actor.id]);
      const j = await storeOf(c, jobId);
      const machine = [eq.description, [eq.brand, eq.model].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      await audit(c, req.actor.id, 'machine_booked_in', 'job', jobId, { jobNumber: j.job_number, how: b.cameIn });
      await notify(c, b.leadTechnicianId, 'workshop_booked_in', `Job ${j.job_number}: ${machine} from ${j.name} is in the workshop for you to repair. ${b.faultReported}`, { jobId });
      return { id: jobId, jobNumber: j.job_number, equipmentId };
    });
    return reply.code(201).send(out);
  });

  app.post('/jobs/:id/loan-out', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({ at: Iso, loanMachineId: Uuid, photoIds: Photos, managerName: z.string().max(200), signaturePhotoId: Uuid }), req.body);
    return actOnJob(req, card => J.loanOut(card, { photos: b.photoIds.length, managerName: b.managerName, signed: true }),
      async ({ c, row, visitId, actorId }) => {
        const lm = (await loanList(c)).find(x => x.id === b.loanMachineId);
        if (!lm || !lm.active) throw new Refused(400, ['unknown loan machine']);
        if (lm.out) throw new Refused(409, [`${lm.name} is already out at ${lm.store} (job ${lm.job_number})`]);
        await checkPhotos(c, b.photoIds, 'loan', row.id, actorId);
        await checkSignature(c, b.signaturePhotoId, row.id);
        await c.query(
          `INSERT INTO machine_moves (job_id, visit_id, kind, loan_machine_id, person_name, signature_photo_id, photo_ids, at, by_user)
           VALUES ($1, $2, 'loan_out', $3, $4, $5, $6, $7, $8)`,
          [row.id, visitId, b.loanMachineId, b.managerName.trim(), b.signaturePhotoId, b.photoIds, b.at, actorId]);
        const j = await storeOf(c, row.id);
        await tellOffice(c, 'loan_out', `Loan machine ${lm.name} left at ${j.name} (job ${j.job_number}). Signed for by ${b.managerName.trim()}.`, { jobId: row.id, loanMachineId: lm.id });
      });
  });

  app.post('/jobs/:id/loan-back', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({ at: Iso, loanMachineId: Uuid, photoIds: Photos, note: z.string().max(1000).optional() }), req.body);
    return actOnJob(req, card => J.loanBack(card, { photos: b.photoIds.length }),
      async ({ c, row, visitId, actorId }) => {
        const lm = (await loanList(c)).find(x => x.id === b.loanMachineId);
        if (!lm || !lm.out || lm.job_id !== row.id) throw new Refused(409, ['that loan machine is not out on this job']);
        await checkPhotos(c, b.photoIds, 'loan', row.id, actorId);
        await c.query(
          `INSERT INTO machine_moves (job_id, visit_id, kind, loan_machine_id, note, photo_ids, at, by_user)
           VALUES ($1, $2, 'loan_back', $3, $4, $5, $6, $7)`,
          [row.id, visitId, b.loanMachineId, b.note?.trim() || null, b.photoIds, b.at, actorId]);
      });
  });

  app.post('/jobs/:id/deliver', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({ at: Iso, photoIds: Photos, receivedBy: z.string().max(200), note: z.string().max(1000).optional() }), req.body);
    return actOnJob(req, card => J.deliver(card, { photos: b.photoIds.length, receivedBy: b.receivedBy }),
      async ({ c, row, card, visitId, actorId }) => {
        await checkPhotos(c, b.photoIds, 'delivery', row.id, actorId);
        const place = J.placeOf(card.visits.at(-1));
        await c.query(
          `INSERT INTO machine_moves (job_id, visit_id, kind, place, note, person_name, photo_ids, at, by_user)
           VALUES ($1, $2, 'delivered', $3, $4, $5, $6, $7, $8)`,
          [row.id, visitId, place, b.note?.trim() || null, b.receivedBy.trim(), b.photoIds, b.at, actorId]);
      });
  });

  // ---- Loan machines (everyone reads; the office keeps the list) ---------------

  app.get('/loan-machines', async req => loanList(req.db));

  const Loan = z.object({
    name: z.string().trim().min(2).max(120), serial: z.string().max(120).optional(), assetNumber: z.string().max(60).optional(),
    notes: z.string().max(1000).optional(), active: z.boolean().optional(),
  });
  const office = (req: FastifyRequest) => {
    if (!can(req.actor, 'manage_stores_equipment')) throw new Refused(403, ['only the office keeps the loan machines and the workshop']);
  };

  app.post('/loan-machines', async (req, reply) => {
    office(req);
    const b = parse(Loan, req.body);
    const { rows } = await req.db.query(
      'INSERT INTO loan_machines (name, serial, asset_number, notes, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [b.name, b.serial?.trim() || null, b.assetNumber?.trim() || null, b.notes?.trim() || null, req.actor.id]);
    return reply.code(201).send((await loanList(req.db)).find(x => x.id === rows[0].id));
  });

  app.put('/loan-machines/:id', async (req: FastifyRequest<P>) => {
    office(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(Loan.partial(), req.body);
    const now = (await loanList(req.db)).find(x => x.id === id);
    if (!now) throw new Refused(404, ['no such loan machine']);
    if (b.active === false && now.out) throw new Refused(409, [`${now.name} is out at ${now.store}: collect it first`]);
    await req.db.query(
      'UPDATE loan_machines SET name = $2, serial = $3, asset_number = $4, notes = $5, active = $6 WHERE id = $1',
      [id, b.name ?? now.name, b.serial !== undefined ? b.serial.trim() || null : now.serial, b.assetNumber !== undefined ? b.assetNumber.trim() || null : now.asset_number,
       b.notes !== undefined ? b.notes.trim() || null : now.notes, b.active ?? now.active]);
    return (await loanList(req.db)).find(x => x.id === id);
  });

  // ---- The workshop's location ------------------------------------------------

  app.get('/company/workshop', async req => ({
    workshop: (await req.db.query('SELECT name, address, lat, lng, geofence_m FROM company_workshop')).rows[0] ?? null,
    canEdit: can(req.actor, 'manage_stores_equipment'),
  }));

  app.put('/company/workshop', async req => {
    office(req);
    const b = parse(z.object({ name: z.string().trim().min(2).max(120), address: z.string().max(300).optional(), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), geofenceM: z.number().int().min(30).max(2000).default(150) }), req.body);
    await req.db.query(
      `INSERT INTO company_workshop (name, address, lat, lng, geofence_m, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id) DO UPDATE SET name = $1, address = $2, lat = $3, lng = $4, geofence_m = $5, updated_by = $6, updated_at = now()`,
      [b.name, b.address?.trim() || null, b.lat, b.lng, b.geofenceM, req.actor.id]);
    return { workshop: (await req.db.query('SELECT name, address, lat, lng, geofence_m FROM company_workshop')).rows[0], canEdit: true };
  });
}
