// The stockroom's tool store: shared tools and ladders, each with a serial number and a barcode
// sticker. The stock controller books one out to someone (for a job) who signs for it on the
// screen; when the job is done it is signed back in with its condition. A tool still out the
// morning after its job closed (or after the day it went out, without a job) is flagged.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, raiseFlag, tx, type Q } from '../db.ts';
import { can } from '../core/permissions.ts';
import { newCode, validCode } from '../core/qr.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { notify } from './field.ts';

type P = { Params: { id: string } };
const KINDS = ['tool', 'ladder', 'equipment'] as const;
const sast = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

/** When a booked-out tool is due back, and whether it is late: the morning (10:00) after its job closed, or after the day it went out. */
export function toolDue(o: { outAt: Date; jobId: string | null; jobClosedAt: Date | null; jobOpen: boolean }, now: Date = new Date()) {
  if (o.jobId && o.jobOpen) return { due: 'when the job is done', overdue: false };
  const from = o.jobId ? o.jobClosedAt ?? o.outAt : o.outAt;
  const next = new Date(`${sast(from)}T10:00:00+02:00`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { due: o.jobId ? 'now: the job is done' : 'today', overdue: now >= next, dueBy: next.toISOString() };
}

async function tools(c: Q, where = 'TRUE', args: unknown[] = []) {
  const { rows } = await c.query(
    `SELECT t.id, t.name, t.kind, t.serial, t.barcode, t.notes, t.condition, t.active,
            b.id AS booking_id, b.user_id, u.full_name AS user_name, b.job_id, j.job_number, j.status::text AS job_status, j.closed_at AS job_closed_at,
            b.out_at, ob.full_name AS out_by_name, b.out_note
       FROM store_tools t
       LEFT JOIN tool_bookings b ON b.tool_id = t.id AND b.returned_at IS NULL
       LEFT JOIN users u ON u.id = b.user_id LEFT JOIN users ob ON ob.id = b.out_by LEFT JOIN jobs j ON j.id = b.job_id
      WHERE ${where} ORDER BY t.active DESC, t.kind, t.name`, args);
  const now = new Date();
  return rows.map(r => ({
    id: r.id, name: r.name, kind: r.kind, serial: r.serial, barcode: r.barcode, notes: r.notes, condition: r.condition, active: r.active,
    out: r.booking_id ? {
      bookingId: r.booking_id, userId: r.user_id, userName: r.user_name, jobId: r.job_id, jobNumber: r.job_number, jobStatus: r.job_status,
      outAt: new Date(r.out_at).toISOString(), outBy: r.out_by_name, note: r.out_note,
      ...toolDue({ outAt: new Date(r.out_at), jobId: r.job_id, jobClosedAt: r.job_closed_at ? new Date(r.job_closed_at) : null, jobOpen: !!r.job_id && !['closed', 'cancelled'].includes(r.job_status) }, now),
    } : null,
  }));
}

/** Raises the not-returned flag once per late booking, for the person who has it. */
async function flagLate(c: Q, list: Awaited<ReturnType<typeof tools>>) {
  for (const t of list) {
    if (!t.out?.overdue) continue;
    const has = await c.query("SELECT 1 FROM flags WHERE flag_type = 'tool_not_returned' AND details->>'bookingId' = $1", [t.out.bookingId]);
    if (has.rowCount) continue;
    await raiseFlag(c, { type: 'tool_not_returned', technicianId: t.out.userId, jobId: t.out.jobId, question: `${t.name} (${t.serial ?? t.barcode}) from the stockroom was not signed back${t.out.jobNumber ? ` after job ${t.out.jobNumber}` : ''}. Bring it back to the stockroom.`, details: { bookingId: t.out.bookingId, toolId: t.id } });
  }
}

export function registerToolStoreRoutes(app: FastifyInstance) {
  const keeper = (req: FastifyRequest) => { if (!can(req.actor, 'assign_stock')) throw new Refused(403, ['the stockroom keeps the tool store']); };

  app.get('/tool-store', async req => {
    keeper(req);
    return tx(req.db, async c => {
      const list = await tools(c);
      await flagLate(c, list);
      const people = (await c.query("SELECT id, full_name, login_level FROM users WHERE status = 'active' AND login_level NOT IN ('director', 'creator') ORDER BY full_name")).rows;
      // Each person's open jobs, to book a tool out for one.
      const jobs = (await c.query(
        `SELECT j.id, j.job_number, s.name AS store, j.fault_reported, array_remove(array_append(array_agg(h.user_id), j.lead_technician_id), NULL) AS people
           FROM jobs j JOIN stores s ON s.id = j.store_id LEFT JOIN job_helpers h ON h.job_id = j.id
          WHERE j.status NOT IN ('closed', 'cancelled') GROUP BY j.id, s.name ORDER BY j.job_number`)).rows;
      return { tools: list, people, jobs };
    });
  });

  // Scanning a sticker (or typing the serial number) finds the tool.
  app.get('/tool-store/find', async (req: FastifyRequest<{ Querystring: { code?: string } }>) => {
    keeper(req);
    const code = String(req.query.code ?? '').trim();
    if (code.length < 2) throw new Refused(400, ['scan or type the code']);
    const hit = (await tools(req.db, 't.barcode = upper($1) OR upper(t.serial) = upper($1)', [code]))[0];
    if (!hit) throw new Refused(404, [`no tool with the code or serial number ${code}`]);
    return hit;
  });

  app.get('/tool-store/:id/history', async (req: FastifyRequest<P>) => {
    keeper(req);
    const id = parse(Uuid, req.params.id);
    const { rows } = await req.db.query(
      `SELECT b.id, b.out_at, b.returned_at, b.return_condition, b.return_note, b.out_note, u.full_name AS user_name, j.job_number,
              ob.full_name AS out_by, rb.full_name AS returned_by, b.out_signature_photo_id, b.return_signature_photo_id
         FROM tool_bookings b JOIN users u ON u.id = b.user_id JOIN users ob ON ob.id = b.out_by LEFT JOIN users rb ON rb.id = b.returned_by LEFT JOIN jobs j ON j.id = b.job_id
        WHERE b.tool_id = $1 ORDER BY b.out_at DESC LIMIT 100`, [id]);
    return rows;
  });

  const ToolIn = z.object({
    name: z.string().trim().min(2).max(120), kind: z.enum(KINDS).default('tool'), serial: z.string().trim().max(80).optional(),
    barcode: z.string().trim().toUpperCase().optional(), notes: z.string().trim().max(1000).optional(),
  });

  app.post('/tool-store', async (req, reply) => {
    keeper(req);
    const b = parse(ToolIn, req.body);
    if (b.barcode && !validCode(b.barcode)) throw new Refused(400, ['a code of 3 to 24 letters, digits or dashes']);
    return tx(req.db, async c => {
      let code = b.barcode ?? newCode('T');
      for (let i = 0; !b.barcode && i < 5 && (await c.query('SELECT 1 FROM store_tools WHERE barcode = $1', [code])).rowCount; i++) code = newCode('T');
      if ((await c.query('SELECT 1 FROM store_tools WHERE barcode = $1', [code])).rowCount) throw new Refused(409, ['that code is already on another tool']);
      if (b.serial && (await c.query('SELECT 1 FROM store_tools WHERE upper(serial) = upper($1)', [b.serial])).rowCount) throw new Refused(409, ['a tool with that serial number is already in the tool store']);
      const id = (await c.query('INSERT INTO store_tools (name, kind, serial, barcode, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [b.name, b.kind, b.serial || null, code, b.notes || null, req.actor.id])).rows[0].id;
      await audit(c, req.actor.id, 'tool_added', 'store_tool', id, { name: b.name, serial: b.serial ?? null, barcode: code });
      return reply.code(201).send((await tools(c, 't.id = $1', [id]))[0]);
    });
  });

  app.put('/tool-store/:id', async (req: FastifyRequest<P>) => {
    keeper(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(ToolIn.partial().extend({ active: z.boolean().optional(), newBarcode: z.boolean().optional(), condition: z.enum(['good', 'damaged']).optional() }), req.body);
    return tx(req.db, async c => {
      const t = (await tools(c, 't.id = $1', [id]))[0];
      if (!t) throw new Refused(404, ['no such tool']);
      if (b.active === false && t.out) throw new Refused(409, [`${t.name} is out with ${t.out.userName}: sign it back first`]);
      let code = t.barcode;
      if (b.newBarcode) code = newCode('T');
      else if (b.barcode) {
        if (!validCode(b.barcode)) throw new Refused(400, ['a code of 3 to 24 letters, digits or dashes']);
        code = b.barcode;
      }
      if (code !== t.barcode && (await c.query('SELECT 1 FROM store_tools WHERE barcode = $1', [code])).rowCount) throw new Refused(409, ['that code is already on another tool']);
      await c.query('UPDATE store_tools SET name = $2, kind = $3, serial = $4, barcode = $5, notes = $6, active = $7, condition = $8 WHERE id = $1',
        [id, b.name ?? t.name, b.kind ?? t.kind, b.serial !== undefined ? b.serial || null : t.serial, code, b.notes !== undefined ? b.notes || null : t.notes, b.active ?? t.active, b.condition ?? t.condition]);
      await audit(c, req.actor.id, 'tool_changed', 'store_tool', id, { ...b, barcode: code });
      return (await tools(c, 't.id = $1', [id]))[0];
    });
  });

  // Book out: to someone (and the job it is for); they sign for it on the stock controller's screen.
  app.post('/tool-store/:id/book-out', async (req: FastifyRequest<P>) => {
    keeper(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ userId: Uuid, jobId: Uuid.optional(), signaturePhotoId: Uuid, note: z.string().trim().max(1000).optional() }), req.body);
    return tx(req.db, async c => {
      const t = (await tools(c, 't.id = $1', [id]))[0];
      if (!t || !t.active) throw new Refused(404, ['no such tool in the tool store']);
      if (t.condition === 'lost') throw new Refused(409, [`${t.name} is written off as lost`]);
      if (t.out) throw new Refused(409, [`${t.name} is already out with ${t.out.userName}${t.out.jobNumber ? ` (job ${t.out.jobNumber})` : ''}`]);
      const u = (await c.query("SELECT full_name FROM users WHERE id = $1 AND status = 'active'", [b.userId])).rows[0];
      if (!u) throw new Refused(400, ['book it out to someone on the staff']);
      if (b.jobId) {
        const j = (await c.query(
          `SELECT job_number FROM jobs j WHERE j.id = $1 AND j.status NOT IN ('closed', 'cancelled')
              AND (j.lead_technician_id = $2 OR EXISTS (SELECT 1 FROM job_helpers h WHERE h.job_id = j.id AND h.user_id = $2))`, [b.jobId, b.userId])).rows[0];
        if (!j) throw new Refused(400, [`that job is not one of ${u.full_name}'s open jobs`]);
      }
      if (!(await c.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'tool_signature' AND taken_by = $2", [b.signaturePhotoId, req.actor.id])).rowCount) {
        throw new Refused(409, [`${u.full_name} signs for it first`]);
      }
      await c.query('INSERT INTO tool_bookings (tool_id, user_id, job_id, out_by, out_signature_photo_id, out_note) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, b.userId, b.jobId ?? null, req.actor.id, b.signaturePhotoId, b.note || null]);
      await audit(c, req.actor.id, 'tool_booked_out', 'store_tool', id, { userId: b.userId, jobId: b.jobId ?? null });
      await notify(c, b.userId, 'tool_booked_out', `${t.name}${t.serial ? ` (${t.serial})` : ''} is booked out to you from the stockroom. Sign it back when the job is done.`, { toolId: id });
      return (await tools(c, 't.id = $1', [id]))[0];
    });
  });

  // Sign back in: its condition, and the person returning it signs.
  app.post('/tool-store/:id/return', async (req: FastifyRequest<P>) => {
    keeper(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ condition: z.enum(['good', 'damaged', 'lost']), note: z.string().trim().max(1000).optional(), signaturePhotoId: Uuid }), req.body);
    if (b.condition !== 'good' && (!b.note || b.note.length < 5)) throw new Refused(400, [`say what happened (${b.condition})`]);
    return tx(req.db, async c => {
      const t = (await tools(c, 't.id = $1', [id]))[0];
      if (!t?.out) throw new Refused(409, ['this tool is not booked out']);
      if (!(await c.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'tool_signature' AND taken_by = $2", [b.signaturePhotoId, req.actor.id])).rowCount) {
        throw new Refused(409, ['the signature first']);
      }
      await c.query('UPDATE tool_bookings SET returned_at = now(), returned_by = $2, return_signature_photo_id = $3, return_condition = $4, return_note = $5 WHERE id = $1',
        [t.out.bookingId, req.actor.id, b.signaturePhotoId, b.condition, b.note || null]);
      await c.query('UPDATE store_tools SET condition = $2 WHERE id = $1', [id, b.condition]);
      await c.query(`UPDATE flags SET status = 'resolved', resolved_by = $1, resolved_at = now(), resolution_note = $2
                      WHERE flag_type = 'tool_not_returned' AND details->>'bookingId' = $3 AND status <> 'resolved'`, [req.actor.id, `Signed back (${b.condition})`, t.out.bookingId]);
      await audit(c, req.actor.id, 'tool_signed_back', 'store_tool', id, { bookingId: t.out.bookingId, condition: b.condition });
      if (b.condition !== 'good') {
        for (const o of (await c.query("SELECT id FROM users WHERE login_level IN ('admin', 'director', 'creator') AND status <> 'left'")).rows) {
          await notify(c, o.id, 'tool_damaged', `${t.name}${t.serial ? ` (${t.serial})` : ''} came back ${b.condition} from ${t.out.userName}: ${b.note}`, { toolId: id });
        }
      }
      return (await tools(c, 't.id = $1', [id]))[0];
    });
  });

  // Every sticker in the company, for printing: vehicles and the tool store. The office (admin and up),
  // the mechanic and the stock controller; codes are only changed by the mechanic and the stockroom.
  app.get('/barcodes', async req => {
    const a = req.actor;
    if (!(can(a, 'assign_jobs') || can(a, 'manage_fleet') || can(a, 'assign_stock') || ['director', 'creator'].includes(a.level))) {
      throw new Refused(403, ['printing stickers is for the office, the mechanic and the stockroom']);
    }
    const vehicles = (await req.db.query('SELECT id, registration, description, make, model, barcode FROM vehicles WHERE active ORDER BY registration')).rows;
    const tools = (await req.db.query('SELECT id, name, kind, serial, barcode, condition FROM store_tools WHERE active ORDER BY kind, name')).rows;
    return { vehicles, tools };
  });

  // The person's own: what they have from the tool store, and when it is due back.
  app.get('/me/tools', async req => {
    return tx(req.db, async c => {
      const list = await tools(c, 'b.user_id = $1', [req.actor.id]);
      await flagLate(c, list);
      return list.map(t => ({ id: t.id, name: t.name, kind: t.kind, serial: t.serial, barcode: t.barcode, ...t.out }));
    });
  });
}

/** Tools booked out for a job: when it closes, the person and the stockroom are told to sign them back. */
export async function toolsOnJob(c: Q, jobId: string) {
  return (await c.query(
    `SELECT t.name, t.serial, b.user_id, u.full_name FROM tool_bookings b JOIN store_tools t ON t.id = b.tool_id JOIN users u ON u.id = b.user_id
      WHERE b.job_id = $1 AND b.returned_at IS NULL`, [jobId])).rows as { name: string; serial: string | null; user_id: string; full_name: string }[];
}
