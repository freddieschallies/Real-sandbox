import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Db, Q } from '../db.ts';
import { audit, raiseFlag, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as J from '../core/jobCard.ts';
import { isOnJob, loadCard, type JobRow } from '../jobsRepo.ts';
import { useOnJob } from '../stockRepo.ts';
import { Iso, Point, Refused, Uuid, DateOnly, parse } from '../http.ts';
import { readUpload, saveFile, removeFile } from '../uploads.ts';

interface Ctx { c: Q; row: JobRow; card: J.JobCard; visitId?: string; actorId: string }

export function registerJobRoutes(app: FastifyInstance, db: Db) {
  /**
   * Runs one job card action: lock the card, check the person is on the job, ask the rules engine,
   * and only if it agrees, write the change. Returns the card as it now stands.
   */
  async function act(
    req: FastifyRequest<{ Params: { id: string } }>,
    rule: (card: J.JobCard) => J.Result,
    persist: (ctx: Ctx, result: Extract<J.Result, { ok: true }>) => Promise<void>,
  ) {
    const jobId = parse(Uuid, req.params.id);
    await tx(req.db, async c => {
      const loaded = await loadCard(c, jobId, true);
      if (!loaded) throw new Refused(404, ['no such job']);
      if ((loaded.row as { status?: string }).status === 'cancelled') throw new Refused(409, ['the office cancelled this job']);
      if (!(await isOnJob(c, jobId, req.actor.id))) throw new Refused(403, ['you are not assigned to this job']);
      const result = rule(loaded.card);
      if (!result.ok) throw new Refused(409, result.reasons);
      await persist({ c, row: loaded.row, card: loaded.card, visitId: loaded.visitIds.at(-1), actorId: req.actor.id }, result);
    });
    return cardView(req.db, jobId);
  }

  // ---- Create, list, view ------------------------------------------------

  const NewJob = z.object({
    jobType: z.enum(['breakdown', 'planned_maintenance', 'installation', 'quote_visit', 'follow_up']),
    priority: z.enum(['urgent', 'normal', 'scheduled']).default('normal'),
    storeId: Uuid,
    clientOrderRef: z.string().max(100).optional(),
    faultReported: z.string().min(3).max(2000),
    scheduledDate: DateOnly,
    leadTechnicianId: Uuid,
    helperIds: z.array(Uuid).default([]),
    maintenanceSteps: z.array(z.string().min(1)).default([]),
  });

  app.post('/jobs', async (req, reply) => {
    if (!can(req.actor, 'assign_jobs')) throw new Refused(403, ['you do not have access to create jobs']);
    const b = parse(NewJob, req.body);
    if (b.jobType === 'planned_maintenance' && b.maintenanceSteps.length === 0) throw new Refused(400, ['planned maintenance needs its checklist steps']);
    const id = await tx(req.db, async c => {
      // Every id the phone or browser sends is checked through this company's own rows,
      // so nothing can be linked to another company's records.
      const store = await c.query('SELECT 1 FROM stores WHERE id = $1', [b.storeId]);
      if (!store.rowCount) throw new Refused(400, ['unknown store']);
      const techs = await c.query("SELECT id FROM users WHERE id = ANY($1) AND login_level = 'technician' AND status = 'active'", [[b.leadTechnicianId, ...b.helperIds]]);
      const ok = new Set(techs.rows.map(r => r.id));
      if (!ok.has(b.leadTechnicianId)) throw new Refused(400, ['lead technician must be an active technician']);
      if (b.helperIds.some(h => !ok.has(h))) throw new Refused(400, ['every helper must be an active technician']);
      const { rows } = await c.query(
        `INSERT INTO jobs (job_type, priority, store_id, client_order_ref, fault_reported, scheduled_date, lead_technician_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, job_number`,
        [b.jobType, b.priority, b.storeId, b.clientOrderRef ?? null, b.faultReported, b.scheduledDate, b.leadTechnicianId, req.actor.id],
      );
      const jobId = rows[0].id;
      // The first work item is the reported fault.
      await c.query("INSERT INTO work_items (job_id, title, origin) VALUES ($1, $2, 'reported')", [jobId, b.faultReported.slice(0, 200)]);
      for (const h of b.helperIds) await c.query('INSERT INTO job_helpers (job_id, user_id) VALUES ($1, $2)', [jobId, h]);
      for (const s of b.maintenanceSteps) await c.query('INSERT INTO planned_maintenance_checks (job_id, step) VALUES ($1, $2)', [jobId, s]);
      await audit(c, req.actor.id, 'job_created', 'job', jobId, { jobNumber: rows[0].job_number });
      return jobId;
    });
    return reply.code(201).send(await cardView(req.db, id));
  });

  app.get('/jobs', async req => {
    const q = req.query as { status?: string };
    const mine = !can(req.actor, 'view_all_job_cards');
    const { rows } = await req.db.query(
      `SELECT j.id, j.job_number, j.job_type, j.priority, j.status, j.scheduled_date, j.fault_reported,
              s.name AS store, u.full_name AS lead_technician, j.lead_technician_id,
              -- Billing, for the office's filters: its invoice (not cancelled) and anything credited.
              inv.invoice_number, inv.status::text AS invoice_status,
              (SELECT coalesce(sum(cn.amount_cents), 0)::bigint FROM credit_notes cn WHERE cn.job_id = j.id) AS credited_cents
         FROM jobs j
         LEFT JOIN LATERAL (SELECT i.invoice_number, i.status FROM invoices i WHERE i.job_id = j.id AND i.status <> 'cancelled' ORDER BY i.created_at DESC LIMIT 1) inv ON true JOIN stores s ON s.id = j.store_id JOIN users u ON u.id = j.lead_technician_id
        WHERE ($1::boolean = false OR j.lead_technician_id = $2
               OR EXISTS (SELECT 1 FROM job_helpers h WHERE h.job_id = j.id AND h.user_id = $2))
          AND ($3::text IS NULL OR j.status::text = $3)
        ORDER BY (j.status IN ('closed', 'cancelled')), j.scheduled_date, j.priority, j.job_number`,
      [mine, req.actor.id, q.status ?? null],
    );
    return rows.map(r => ({ ...r, credited_cents: Number(r.credited_cents),
      billing: Number(r.credited_cents) > 0 ? 'credited' : r.invoice_status === 'draft' ? 'draft_invoice' : r.invoice_status ? 'invoiced' : 'not_invoiced' }));
  });

  app.get('/jobs/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const jobId = parse(Uuid, req.params.id);
    if (!can(req.actor, 'view_all_job_cards') && !(await isOnJob(req.db, jobId, req.actor.id))) throw new Refused(403, ['not your job']);
    return cardView(req.db, jobId);
  });

  // ---- The forced path ----------------------------------------------------

  type P = { Params: { id: string } };

  app.post('/jobs/:id/go', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({ at: Iso }), req.body);
    return act(req, card => J.go(card, b.at), async ({ c, row, actorId }) => {
      await c.query("INSERT INTO job_visits (job_id, technician_id, state, go_at) VALUES ($1, $2, 'on_the_way', $3)", [row.id, actorId, b.at]);
      await c.query("UPDATE jobs SET status = 'in_progress' WHERE id = $1", [row.id]);
    });
  });

  app.post('/jobs/:id/arrive', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({
      at: Iso,
      // Until the tracker connection is built, the phone sends its position; afterwards the server
      // uses the vehicle tracker's position for this moment and this field is only used for passengers.
      position: Point.optional(),
      managerName: z.string(),
      safety: z.object({ areaSafe: z.boolean(), isolated: z.boolean(), publicClear: z.boolean() }),
      outsideReason: z.string().optional(),
    }), req.body);
    return act(req, card => J.arrive(card, { at: b.at, vehiclePosition: b.position, managerName: b.managerName, safety: b.safety, outsideReason: b.outsideReason }),
      async ({ c, row, visitId, actorId }, res) => {
        await c.query(
          `UPDATE job_visits SET state = 'arrived', arrived_at = $2, checked_in_manager = $3, safety_check = $4,
                  arrived_outside_geofence_reason = $5 WHERE id = $1`,
          [visitId, b.at, b.managerName.trim(), JSON.stringify(b.safety), res.flags?.includes('arrived_outside_geofence') ? b.outsideReason : null],
        );
        await c.query('INSERT INTO store_managers (store_id, full_name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.store_id, b.managerName.trim()]);
        if (res.flags?.includes('arrived_outside_geofence')) {
          await raiseFlag(c, { type: 'arrived_outside_geofence', technicianId: actorId, jobId: row.id, details: { position: b.position, reason: b.outsideReason } });
        }
      });
  });

  app.post('/jobs/:id/start', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({ at: Iso }), req.body);
    return act(req, card => J.start(card, b.at), async ({ c, visitId }) => {
      await c.query("UPDATE job_visits SET state = 'working', started_at = $2 WHERE id = $1", [visitId, b.at]);
    });
  });

  app.post('/jobs/:id/pause', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({ at: Iso, reason: z.enum(['waiting_for_parts', 'store_asked_to_stop', 'collecting_parts', 'break']) }), req.body);
    return act(req, card => J.pause(card, b.reason, b.at), async ({ c, visitId }) => {
      await c.query("UPDATE job_visits SET state = 'paused' WHERE id = $1", [visitId]);
      await c.query('INSERT INTO visit_pauses (visit_id, reason, paused_at) VALUES ($1, $2, $3)', [visitId, b.reason, b.at]);
    });
  });

  app.post('/jobs/:id/resume', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({ at: Iso }), req.body);
    return act(req, card => J.resume(card, b.at), async ({ c, visitId }) => {
      await c.query("UPDATE job_visits SET state = 'working' WHERE id = $1", [visitId]);
      await c.query(
        'UPDATE visit_pauses SET resumed_at = $2 WHERE id = (SELECT id FROM visit_pauses WHERE visit_id = $1 AND resumed_at IS NULL ORDER BY paused_at DESC LIMIT 1)',
        [visitId, b.at],
      );
    });
  });

  // ---- Work items ---------------------------------------------------------

  app.post('/jobs/:id/items', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({ title: z.string().min(3).max(200), id: Uuid.optional() }), req.body);
    const id = b.id ?? randomUUID();
    return act(req,
      card => J.addItem(card, { id, title: b.title, origin: 'found_on_site', beforePhotos: 0, afterPhotos: 0, vanStockLines: 0, boughtOutLines: 0, noMaterials: false }),
      async ({ c, row }) => { await c.query("INSERT INTO work_items (id, job_id, title, origin) VALUES ($1, $2, $3, 'found_on_site')", [id, row.id, b.title]); });
  });

  const ItemPatch = z.object({
    equipmentId: Uuid.optional(),
    faultType: z.enum(['electrical', 'refrigeration', 'mechanical', 'water', 'wear_and_tear', 'user_damage', 'no_fault_found', 'other']).optional(),
    found: z.string().max(4000).optional(),
    did: z.string().max(4000).optional(),
    noMaterials: z.boolean().optional(),
    tested: z.enum(['yes', 'partly', 'no']).optional(),
    outcome: z.enum(['complete', 'needs_follow_up', 'needs_quote', 'waiting_for_parts']).optional(),
    stillNeeded: z.string().max(2000).optional(),
  }).strict();

  app.patch('/jobs/:id/items/:itemId', async (req: FastifyRequest<{ Params: { id: string; itemId: string } }>) => {
    const itemId = parse(Uuid, req.params.itemId);
    const b = parse(ItemPatch, req.body);
    return act(req, card => J.updateItem(card, itemId, b), async ({ c, row, card }) => {
      if (b.equipmentId) {
        const eq = await c.query('SELECT 1 FROM equipment WHERE id = $1 AND store_id = $2', [b.equipmentId, row.store_id]);
        if (!eq.rowCount) throw new Refused(400, ['that equipment is not registered at this store']);
      }
      const merged = { ...card.items.find(i => i.id === itemId)!, ...b };
      await c.query(
        `UPDATE work_items SET equipment_id = $2, fault_type = $3, found_text = $4, did_text = $5, no_materials = $6,
                tested = $7, outcome = $8, still_needed = $9, status = $10 WHERE id = $1`,
        [itemId, merged.equipmentId ?? null, merged.faultType ?? null, merged.found ?? null, merged.did ?? null, merged.noMaterials,
         merged.tested ?? null, merged.outcome ?? null, merged.stillNeeded ?? null, J.itemStatus(merged, card.jobType)],
      );
    });
  });

  // Work item photo: the image itself, sent as multipart/form-data with fields kind, takenAt and optional id.
  app.post('/jobs/:id/items/:itemId/photos', async (req: FastifyRequest<{ Params: { id: string; itemId: string } }>) => {
    const itemId = parse(Uuid, req.params.itemId);
    const up = await readUpload(req);
    const f = parse(z.object({ kind: z.enum(['before', 'after', 'rating_plate']), takenAt: Iso, id: Uuid.optional() }), up.fields);
    const photoId = f.id ?? randomUUID();
    const rel = await saveFile(req.companyId, photoId, up, f.takenAt);
    try {
      return await act(req, card => (card.status === 'closed' ? { ok: false, reasons: ['job is closed'] } : card.items.some(i => i.id === itemId) ? { ok: true, card } : { ok: false, reasons: ['no such item'] }),
        async ({ c, row, actorId }) => {
          await c.query(
            'INSERT INTO photos (id, kind, job_id, work_item_id, file_path, taken_at, taken_by, content_type, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [photoId, f.kind, row.id, itemId, rel, f.takenAt, actorId, up.mimetype, up.buffer.length],
          );
        });
    } catch (e) {
      await removeFile(rel);
      throw e;
    }
  });

  // Materials from stock on the technician's name (booked for this job, van stock, or other jobs).
  app.post('/jobs/:id/items/:itemId/materials', async (req: FastifyRequest<{ Params: { id: string; itemId: string } }>) => {
    const itemId = parse(Uuid, req.params.itemId);
    const b = parse(z.object({ stockItemId: Uuid, qty: z.number().positive() }), req.body);
    return act(req, card => (card.status === 'closed' ? { ok: false, reasons: ['job is closed'] } : card.items.some(i => i.id === itemId) ? { ok: true, card } : { ok: false, reasons: ['no such item'] }),
      async ({ c, row, actorId }) => {
        await useOnJob(c, actorId, b.stockItemId, b.qty, row.id, itemId);
      });
  });

  app.post('/jobs/:id/checklist/:checkId', async (req: FastifyRequest<{ Params: { id: string; checkId: string } }>) => {
    const checkId = parse(Uuid, req.params.checkId);
    const b = parse(z.object({ at: Iso }), req.body);
    return act(req, card => (card.status === 'closed' ? { ok: false, reasons: ['job is closed'] } : { ok: true, card }), async ({ c, row }) => {
      const r = await c.query('UPDATE planned_maintenance_checks SET done = true, done_at = $3 WHERE id = $1 AND job_id = $2', [checkId, row.id, b.at]);
      if (!r.rowCount) throw new Refused(404, ['no such checklist step']);
    });
  });

  // Bought out: a part bought for this job that is not on the system. Never goes into van stock.
  app.post('/jobs/:id/items/:itemId/bought-out', async (req: FastifyRequest<{ Params: { id: string; itemId: string } }>) => {
    const itemId = parse(Uuid, req.params.itemId);
    const b = parse(z.object({
      id: Uuid.optional(), description: z.string().min(2).max(300), qty: z.number().positive(),
      priceCents: z.number().int().min(0), supplierId: Uuid.optional(), slipPhotoId: Uuid,
    }), req.body);
    return act(req, card => (card.status === 'closed' ? { ok: false, reasons: ['job is closed'] } : card.items.some(i => i.id === itemId) ? { ok: true, card } : { ok: false, reasons: ['no such item'] }),
      async ({ c, row, actorId }) => {
        const slip = await c.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'bought_out_slip' AND taken_by = $2", [b.slipPhotoId, actorId]);
        if (!slip.rowCount) throw new Refused(409, ['upload the slip photo first']);
        await c.query(
          `INSERT INTO bought_out_items (id, job_id, work_item_id, description, qty, price_cents, supplier_id, slip_photo_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [b.id ?? randomUUID(), row.id, itemId, b.description, b.qty, b.priceCents, b.supplierId ?? null, b.slipPhotoId, actorId],
        );
      });
  });

  // On-site estimate. Prices come from the Director's price list; the technician only picks items and quantities.
  app.post('/jobs/:id/items/:itemId/estimate', async (req: FastifyRequest<{ Params: { id: string; itemId: string } }>) => {
    const jobId = parse(Uuid, req.params.id);
    const itemId = parse(Uuid, req.params.itemId);
    const b = parse(z.object({
      at: Iso,
      labourHours: z.number().min(0).max(500),
      stockLines: z.array(z.object({ stockItemId: Uuid, qty: z.number().positive() })).default([]),
      boughtOutLines: z.array(z.object({ description: z.string().min(2), qty: z.number().positive(), estimatedPriceCents: z.number().int().min(0) })).default([]),
      emailTo: z.string().email().optional(),
    }), req.body);
    return tx(req.db, async c => {
      if (!(await isOnJob(c, jobId, req.actor.id))) throw new Refused(403, ['you are not assigned to this job']);
      const item = await c.query('SELECT 1 FROM work_items WHERE id = $1 AND job_id = $2', [itemId, jobId]);
      if (!item.rowCount) throw new Refused(404, ['no such item']);
      const rate = await c.query("SELECT amount_cents FROM rates WHERE key = 'labour_per_hour'");
      const missing: string[] = [];
      if (b.labourHours > 0 && !rate.rowCount) missing.push('labour rate');
      const lines: object[] = [];
      let total = Math.round(b.labourHours * (rate.rows[0]?.amount_cents ?? 0));
      for (const l of b.stockLines) {
        const p = await c.query('SELECT code, description, selling_price_cents FROM stock_items WHERE id = $1', [l.stockItemId]);
        const s = p.rows[0];
        if (!s) throw new Refused(400, ['unknown stock item']);
        if (s.selling_price_cents == null) { missing.push(`price for ${s.code}`); continue; }
        total += Math.round(l.qty * s.selling_price_cents);
        lines.push({ stockItemId: l.stockItemId, description: s.description, qty: l.qty, unitPriceCents: s.selling_price_cents });
      }
      for (const l of b.boughtOutLines) {
        total += Math.round(l.qty * l.estimatedPriceCents);
        lines.push({ description: l.description, qty: l.qty, unitPriceCents: l.estimatedPriceCents, boughtOut: true });
      }
      if (missing.length) throw new Refused(409, [`no price set yet for: ${missing.join(', ')}. Ask a Director to set it.`]);
      const { rows } = await c.query(
        `INSERT INTO estimates (job_id, work_item_id, created_by, created_at, labour_hours, lines, total_cents, emailed_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, label, total_cents, lines, labour_hours`,
        [jobId, itemId, req.actor.id, b.at, b.labourHours, JSON.stringify(lines), total, b.emailTo ?? null],
      );
      return rows[0];
    });
  });

  // ---- Finishing ----------------------------------------------------------

  app.post('/jobs/:id/done', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({ at: Iso }), req.body);
    return act(req, card => J.done(card, b.at), async ({ c, visitId }) => {
      await c.query("UPDATE job_visits SET state = 'done', ended_at = $2 WHERE id = $1", [visitId, b.at]);
    });
  });

  app.post('/jobs/:id/continue-later', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({
      at: Iso, progress: z.string(), plannedReturn: DateOnly, managerInformed: z.string(),
      reason: z.enum(['more_work_needed', 'waiting_for_parts', 'store_access', 'waiting_for_quote_approval', 'other']),
    }), req.body);
    return act(req, card => J.continueLater(card, b), async ({ c, row, visitId }) => {
      // Close any open pause at the moment he leaves site.
      await c.query('UPDATE visit_pauses SET resumed_at = $2 WHERE visit_id = $1 AND resumed_at IS NULL', [visitId, b.at]);
      await c.query(
        `UPDATE job_visits SET state = 'continue_later', ended_at = $2, progress_note = $3, unfinished_reason = $4,
                planned_return_date = $5, store_manager_informed = $6 WHERE id = $1`,
        [visitId, b.at, b.progress, b.reason, b.plannedReturn, b.managerInformed],
      );
      await c.query("UPDATE jobs SET status = 'continue_later' WHERE id = $1", [row.id]);
    });
  });

  const SignOff = z.discriminatedUnion('signature', [
    z.object({ signature: z.literal(true), managerName: z.string(), signaturePhotoId: Uuid }),
    z.object({ signature: z.literal(false), reason: z.string(), spokeTo: z.string() }),
  ]);

  app.post('/jobs/:id/close', async (req: FastifyRequest<P>) => {
    const b = parse(z.object({ at: Iso, signOff: SignOff }), req.body);
    return act(req, card => J.close(card, b.signOff, b.at), async ({ c, row, actorId }, res) => {
      if (b.signOff.signature) {
        const sig = await c.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'signature' AND job_id = $2", [b.signOff.signaturePhotoId, row.id]);
        if (!sig.rowCount) throw new Refused(409, ['upload the store manager signature first']);
        await c.query(
          "UPDATE jobs SET status = 'closed', closed_at = $2, manager_name = $3, signature_photo_id = $4 WHERE id = $1",
          [row.id, b.at, b.signOff.managerName.trim(), b.signOff.signaturePhotoId],
        );
      } else {
        await c.query(
          "UPDATE jobs SET status = 'closed', closed_at = $2, manager_unavailable_reason = $3, manager_unavailable_spoke_to = $4 WHERE id = $1",
          [row.id, b.at, b.signOff.reason.trim(), b.signOff.spokeTo.trim()],
        );
      }
      if (res.flags?.includes('manager_unavailable')) {
        await raiseFlag(c, { type: 'manager_unavailable', technicianId: actorId, jobId: row.id, severity: 'low', details: { reason: (b.signOff as { reason: string }).reason } });
      }
      await audit(c, actorId, 'job_closed', 'job', row.id, { jobNumber: row.job_number, signed: b.signOff.signature });
    });
  });
}

/** The job card as the app shows it: header, visits, items with what is still missing. */
export async function cardView(c: Q, jobId: string) {
  {
    const loaded = await loadCard(c, jobId);
    if (!loaded) throw new Refused(404, ['no such job']);
    const head = await c.query(
      `SELECT j.job_number, j.job_type, j.priority, j.status, j.fault_reported, j.scheduled_date, j.client_order_ref,
              j.manager_name, j.manager_unavailable_reason, s.id AS store_id, s.name AS store, s.address AS store_address,
              s.lat AS store_lat, s.lng AS store_lng, s.geofence_m, u.full_name AS lead_technician
         FROM jobs j JOIN stores s ON s.id = j.store_id JOIN users u ON u.id = j.lead_technician_id WHERE j.id = $1`,
      [jobId],
    );
    const checks = await c.query('SELECT id, step, done FROM planned_maintenance_checks WHERE job_id = $1 ORDER BY step', [jobId]);
    const equipment = await c.query('SELECT id, brand, model, serial, description FROM equipment WHERE store_id = $1 ORDER BY description', [head.rows[0].store_id]);
    const managers = await c.query('SELECT full_name FROM store_managers WHERE store_id = $1 ORDER BY full_name', [head.rows[0].store_id]);
    const { card } = loaded;
    return {
      id: jobId,
      ...head.rows[0],
      visits: card.visits,
      currentState: card.visits.at(-1)?.state ?? 'not_started',
      jobMinutes: J.jobMinutes(card),
      checklist: checks.rows,
      equipment: equipment.rows,
      storeManagers: managers.rows.map(m => m.full_name),
      items: card.items.map(it => ({ ...it, status: J.itemStatus(it, card.jobType), missing: J.missingOnItem(it, card.jobType) })),
    };
  }
}
