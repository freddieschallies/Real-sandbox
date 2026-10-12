// Stock control: what each technician holds, booking out for a job, supplier invoices read from a photo,
// and returns that only count once the stock controller confirms them.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db, Q } from '../db.ts';
import { audit, raiseFlag, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as S from '../core/stock.ts';
import { isOnJob } from '../jobsRepo.ts';
import { holdingsOf, stockroomQty } from '../stockRepo.ts';
import { DateOnly, Iso, Refused, Uuid, parse } from '../http.ts';
import type { InvoiceReader, ReadInvoice } from '../invoiceReader.ts';
import { managerOf, notify } from './field.ts';
import { keepIfRefused } from '../tenancy.ts';

const lock = (c: Q, technicianId: string) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`stock:${technicianId}`]);

/** People who look after the stockroom, to tell them about returns and new items. */
async function stockControllers(c: Q): Promise<string[]> {
  const { rows } = await c.query("SELECT id FROM users WHERE login_level = 'stockroom' AND status <> 'left'");
  return rows.map(r => r.id);
}

export function registerStockRoutes(app: FastifyInstance, db: Db, reader: InvoiceReader | null) {
  // ---- What is on my name -------------------------------------------------

  app.get('/me/inventory', async req => {
    const { rows } = await req.db.query(
      `SELECT i.id AS stock_item_id, i.code, i.description, i.unit, i.needs_review, h.holding_job_id, h.qty,
              COALESCE(p.qty, 0) AS pending_return, j.job_number, j.status AS job_status, s.name AS store
         FROM technician_holdings h
         JOIN stock_items i ON i.id = h.stock_item_id
         LEFT JOIN pending_returns p ON p.technician_id = h.technician_id AND p.stock_item_id = h.stock_item_id
              AND p.holding_job_id IS NOT DISTINCT FROM h.holding_job_id
         LEFT JOIN jobs j ON j.id = h.holding_job_id
         LEFT JOIN stores s ON s.id = j.store_id
        WHERE h.technician_id = $1 AND h.qty > 0
        ORDER BY (h.holding_job_id IS NULL), j.job_number, i.code`,
      [req.actor.id],
    );
    return rows.map(r => ({
      stockItemId: r.stock_item_id, code: r.code, description: r.description, unit: r.unit, needsReview: r.needs_review,
      holdingJobId: r.holding_job_id, jobNumber: r.job_number, jobStatus: r.job_status, store: r.store,
      qty: Number(r.qty), pendingReturn: Number(r.pending_return),
      mustReturn: S.mustReturn(r.holding_job_id, r.job_status),
    }));
  });

  // The stockroom's items, so a technician can book out what he needs (no prices).
  app.get('/stock/catalogue', async req => {
    const { rows } = await req.db.query(
      `SELECT i.id, i.code, i.description, i.unit, COALESCE(s.qty, 0) AS in_stockroom
         FROM stock_items i LEFT JOIN stockroom_stock s ON s.stock_item_id = i.id
        WHERE i.active ORDER BY i.code`,
    );
    return rows.map(r => ({ id: r.id, code: r.code, description: r.description, unit: r.unit, inStockroom: Number(r.in_stockroom) }));
  });

  // ---- Booking out from the stockroom for a job ----------------------------

  app.post('/jobs/:id/stock-out', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const jobId = parse(Uuid, req.params.id);
    const b = parse(z.object({ at: Iso, lines: z.array(z.object({ stockItemId: Uuid, qty: z.number().positive() })).min(1).max(50) }), req.body);
    const me = req.actor.id;
    return tx(req.db, async c => {
      const job = (await c.query('SELECT status, job_number FROM jobs WHERE id = $1 FOR UPDATE', [jobId])).rows[0];
      if (!job) throw new Refused(404, ['no such job']);
      if (!(await isOnJob(c, jobId, me))) throw new Refused(403, ['you are not assigned to this job']);
      if (job.status === 'closed') throw new Refused(409, ['job is closed']);
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['stockroom']);
      const short: string[] = [];
      for (const l of b.lines) {
        const have = await stockroomQty(c, l.stockItemId);
        if (have < l.qty) {
          const it = (await c.query('SELECT code FROM stock_items WHERE id = $1', [l.stockItemId])).rows[0];
          short.push(`${it?.code ?? 'unknown item'}: only ${have} in the stockroom`);
        }
      }
      if (short.length) throw new Refused(409, short);
      for (const l of b.lines) {
        await c.query(
          `INSERT INTO stock_movements (stock_item_id, qty, kind, from_stockroom, to_technician_id, holding_job_id, job_id, created_by)
           VALUES ($1, $2, 'assign', true, $3, $4, $4, $3)`,
          [l.stockItemId, l.qty, me, jobId],
        );
      }
      await audit(c, me, 'stock_booked_out', 'job', jobId, { lines: b.lines, at: b.at });
      return jobStock(c, jobId);
    });
  });

  app.get('/jobs/:id/stock', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const jobId = parse(Uuid, req.params.id);
    if (!(await isOnJob(req.db, jobId, req.actor.id)) && !can(req.actor, 'view_all_job_cards')) throw new Refused(403, ['not your job']);
    return jobStock(req.db, jobId);
  });

  // ---- Supplier invoices ----------------------------------------------------

  app.post('/supplier-invoices', async (req, reply) => {
    const b = parse(z.object({ id: Uuid.optional(), photoId: Uuid, jobId: Uuid.optional(), at: Iso }), req.body);
    const me = req.actor.id;
    const out = await tx(req.db, async c => {
      const photo = await c.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'supplier_slip' AND taken_by = $2", [b.photoId, me]);
      if (!photo.rowCount) throw new Refused(409, ['upload the invoice photo first']);
      if (b.jobId && !(await isOnJob(c, b.jobId, me))) throw new Refused(403, ['you are not assigned to that job']);
      const id = b.id ?? randomUUID();
      await c.query(
        'INSERT INTO supplier_invoices (id, technician_id, photo_id, job_id, scanned_at, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, me, b.photoId, b.jobId ?? null, b.at, reader ? 'reading' : 'unreadable'],
      );
      if (!reader) await c.query("UPDATE supplier_invoices SET read_error = 'automatic reading is not set up: type the lines' WHERE id = $1", [id]);
      return { id, status: reader ? 'reading' : 'unreadable' };
    });
    if (reader) setTimeout(() => { readPendingInvoices(db, reader).catch(() => {}); }, 50);
    return reply.code(201).send(out);
  });

  app.get('/me/supplier-invoices', async req => {
    const { rows } = await req.db.query(
      `SELECT id, status, job_id, photo_id, supplier_name, invoice_number, invoice_date, total_cents, scanned_at, confirmed_at, read_result, read_error
         FROM supplier_invoices WHERE technician_id = $1 ORDER BY scanned_at DESC LIMIT 30`,
      [req.actor.id],
    );
    return rows;
  });

  const ConfirmLine = z.object({
    description: z.string().trim().min(2).max(300),
    supplierCode: z.string().trim().max(60).nullish(),
    qty: z.number().positive().max(100000),
    unitPriceCents: z.number().int().min(0).nullish(),
    stockItemId: Uuid.optional(),
  });

  app.post('/supplier-invoices/:id/confirm', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({
      supplierName: z.string().trim().min(2).max(200),
      invoiceNumber: z.string().trim().min(1).max(60),
      invoiceDate: DateOnly.optional(),
      totalCents: z.number().int().min(0).nullish(),
      jobId: Uuid.nullish(),
      at: Iso,
      lines: z.array(ConfirmLine).min(1).max(200),
    }), req.body);
    const me = req.actor.id;
    return tx(req.db, async c => {
      const inv = (await c.query('SELECT technician_id, status, job_id, read_result FROM supplier_invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!inv || inv.technician_id !== me) throw new Refused(404, ['no such invoice of yours']);
      if (inv.status === 'reading') throw new Refused(409, ['still reading this invoice; try again in a moment']);
      if (inv.status === 'confirmed') throw new Refused(409, ['this invoice is already confirmed']);
      const problems = S.invoiceProblems(b);
      if (problems.length) throw new Refused(409, problems);
      const jobId = b.jobId === undefined ? inv.job_id : b.jobId;
      if (jobId && !(await isOnJob(c, jobId, me))) throw new Refused(403, ['you are not assigned to that job']);

      // The same invoice can't be claimed twice, by anyone.
      const dup = (await c.query(
        `SELECT i.id, u.full_name FROM supplier_invoices i JOIN users u ON u.id = i.technician_id
          WHERE i.status = 'confirmed' AND lower(i.supplier_name) = lower($1) AND lower(i.invoice_number) = lower($2)`,
        [b.supplierName, b.invoiceNumber])).rows[0];
      if (dup) {
        keepIfRefused(req, k => raiseFlag(k, {
          type: 'duplicate_supplier_invoice', technicianId: me, severity: 'high',
          question: `You tried to book invoice ${b.invoiceNumber} from ${b.supplierName}, which ${dup.full_name} already booked. Explain.`,
          details: { invoiceId: id, firstInvoiceId: dup.id, supplier: b.supplierName, number: b.invoiceNumber },
        }));
        throw new Refused(409, [`invoice ${b.invoiceNumber} from ${b.supplierName} was already booked by ${dup.full_name}`]);
      }

      await lock(c, me);
      const supplierId = await learnSupplier(c, me, b.supplierName);
      const catalogue = (await c.query('SELECT id, code, description, supplier_code AS "supplierCode" FROM stock_items WHERE active')).rows as S.CatalogueItem[];
      const newItems: string[] = [];
      let n = 0;
      for (const l of b.lines) {
        n++;
        let itemId = l.stockItemId;
        if (itemId && !catalogue.some(x => x.id === itemId)) throw new Refused(404, [`line ${n}: unknown stock item`]);
        if (!itemId) itemId = S.matchItem(l, catalogue)?.id;
        if (!itemId) {
          // Not in our list yet: it gets a stock item now, so it is counted, and the stock controller tidies it up.
          const code = `NEW-${await nextNewCode(c)}`;
          itemId = (await c.query(
            "INSERT INTO stock_items (code, description, supplier_code, needs_review) VALUES ($1, $2, $3, true) RETURNING id",
            [code, l.description, l.supplierCode ?? null])).rows[0].id as string;
          catalogue.push({ id: itemId, code, description: l.description, supplierCode: l.supplierCode ?? null });
          newItems.push(`${code} ${l.description}`);
        }
        const lineId = randomUUID();
        await c.query(
          `INSERT INTO supplier_invoice_lines (id, invoice_id, line_no, description, supplier_code, qty, unit_price_cents, stock_item_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [lineId, id, n, l.description, l.supplierCode ?? null, l.qty, l.unitPriceCents ?? null, itemId],
        );
        await c.query(
          `INSERT INTO stock_movements (stock_item_id, qty, kind, to_technician_id, holding_job_id, job_id, supplier_invoice_line_id, unit_cost_cents, created_by)
           VALUES ($1, $2, 'supplier_invoice', $3, $4, $4, $5, $6, $3)`,
          [itemId, l.qty, me, jobId ?? null, lineId, l.unitPriceCents ?? null],
        );
      }

      const changed = changedFromRead(inv.read_result, b);
      await c.query(
        `UPDATE supplier_invoices SET status = 'confirmed', confirmed_at = $2, supplier_id = $3, supplier_name = $4, invoice_number = $5,
                invoice_date = $6, total_cents = $7, job_id = $8, changed_from_read = $9 WHERE id = $1`,
        [id, b.at, supplierId, b.supplierName, b.invoiceNumber, b.invoiceDate ?? null, b.totalCents ?? null, jobId ?? null, changed],
      );
      if (changed) {
        await raiseFlag(c, { type: 'supplier_invoice_changed', technicianId: me, severity: 'low', details: { invoiceId: id, read: inv.read_result, confirmed: { ...b, at: undefined } } });
      }
      if (newItems.length) {
        for (const u of await stockControllers(c)) await notify(c, u, 'new_stock_items', `New items from a supplier invoice need a code: ${newItems.join('; ')}`, { invoiceId: id });
      }
      await audit(c, me, 'supplier_invoice_confirmed', 'supplier_invoice', id, { lines: b.lines.length, changed });
      return { id, status: 'confirmed', newItems, changedFromRead: changed };
    });
  });

  // ---- Returns to the stockroom ----------------------------------------------

  app.post('/me/returns', async (req, reply) => {
    const b = parse(z.object({
      id: Uuid.optional(), at: Iso,
      lines: z.array(z.object({ stockItemId: Uuid, holdingJobId: Uuid.nullable(), qty: z.number().positive() })).min(1).max(100),
    }), req.body);
    const me = req.actor.id;
    const out = await tx(req.db, async c => {
      await lock(c, me);
      const problems: string[] = [];
      for (const l of b.lines) {
        const h = (await holdingsOf(c, me, l.stockItemId)).find(x => x.holdingJobId === l.holdingJobId);
        const max = h ? S.available(h) : 0;
        if (max + 1e-9 < l.qty) {
          const it = (await c.query('SELECT code FROM stock_items WHERE id = $1', [l.stockItemId])).rows[0];
          problems.push(`${it?.code ?? 'item'}: you can return at most ${max}`);
        }
      }
      if (problems.length) throw new Refused(409, problems);
      const id = b.id ?? randomUUID();
      await c.query('INSERT INTO stock_returns (id, technician_id, requested_at) VALUES ($1, $2, $3)', [id, me, b.at]);
      for (const l of b.lines) {
        await c.query('INSERT INTO stock_return_lines (return_id, stock_item_id, holding_job_id, qty) VALUES ($1, $2, $3, $4)',
          [id, l.stockItemId, l.holdingJobId, l.qty]);
      }
      for (const u of await stockControllers(c)) await notify(c, u, 'stock_return', `Stock coming back from ${await nameOf(c, me)} (${b.lines.length} lines): confirm when you have it`, { returnId: id });
      return { id, status: 'pending' };
    });
    return reply.code(201).send(out);
  });

  app.get('/me/returns', async req => returnsWhere(req.db, 'r.technician_id = $1', [req.actor.id]));

  // Stock controller: returns waiting, and confirming what physically came back.
  app.get('/stock/returns', async req => {
    if (!can(req.actor, 'manage_stockroom')) throw new Refused(403, ['stock controller only']);
    const q = parse(z.object({ status: z.enum(['pending', 'received']).default('pending') }), req.query);
    return returnsWhere(req.db, 'r.status = $1', [q.status]);
  });

  app.post('/stock/returns/:id/receive', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!can(req.actor, 'manage_stockroom')) throw new Refused(403, ['stock controller only']);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ lines: z.array(z.object({ lineId: Uuid, qtyReceived: z.number().min(0) })).min(1), note: z.string().trim().max(1000).optional() }), req.body);
    const me = req.actor.id;
    return tx(req.db, async c => {
      const r = (await c.query('SELECT technician_id, status FROM stock_returns WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw new Refused(404, ['no such return']);
      if (r.status !== 'pending') throw new Refused(409, ['this return is already received']);
      if (r.technician_id === me) throw new Refused(403, ['someone else must receive your own return']);
      await lock(c, r.technician_id);
      const lines = (await c.query(
        `SELECT l.id, l.stock_item_id, l.holding_job_id, l.qty, i.code FROM stock_return_lines l JOIN stock_items i ON i.id = l.stock_item_id
          WHERE l.return_id = $1`, [id])).rows;
      const given = new Map(b.lines.map(l => [l.lineId, l.qtyReceived]));
      if (lines.some(l => !given.has(l.id)) || b.lines.some(l => !lines.some(x => x.id === l.lineId))) {
        throw new Refused(400, ['give the received quantity for every line of this return']);
      }
      const short: { code: string; expected: number; received: number }[] = [];
      for (const l of lines) {
        const got = given.get(l.id)!;
        if (got > Number(l.qty)) throw new Refused(409, [`${l.code}: more received than was returned (${l.qty})`]);
        await c.query('UPDATE stock_return_lines SET qty_received = $2 WHERE id = $1', [l.id, got]);
        if (got > 0) {
          await c.query(
            `INSERT INTO stock_movements (stock_item_id, qty, kind, from_technician_id, holding_job_id, to_stockroom, return_line_id, created_by)
             VALUES ($1, $2, 'return', $3, $4, true, $5, $6)`,
            [l.stock_item_id, got, r.technician_id, l.holding_job_id, l.id, me],
          );
        }
        if (got < Number(l.qty)) short.push({ code: l.code, expected: Number(l.qty), received: got });
      }
      await c.query("UPDATE stock_returns SET status = 'received', received_by = $2, received_at = now(), note = $3 WHERE id = $1", [id, me, b.note ?? null]);
      if (short.length) {
        // Whatever didn't arrive stays on his name, and he is asked about it.
        await raiseFlag(c, {
          type: 'stock_return_short', technicianId: r.technician_id, severity: 'high',
          question: `The stockroom received less than you sent back: ${short.map(s => `${s.code} ${s.received} of ${s.expected}`).join(', ')}. It stays on your name. Explain.`,
          details: { returnId: id, short },
        });
        await notify(c, await managerOf(c, r.technician_id), 'stock_return_short', `Short stock return from ${await nameOf(c, r.technician_id)}`, { returnId: id });
      }
      await notify(c, r.technician_id, 'stock_return_received', short.length ? 'Your stock return was received, but some items were short' : 'Your stock return was received and taken off your name', { returnId: id });
      await audit(c, me, 'stock_return_received', 'stock_return', id, { short });
      return { id, status: 'received', short };
    });
  });
}

// ---- Helpers -------------------------------------------------------------------

async function nameOf(c: Q, userId: string): Promise<string> {
  return (await c.query('SELECT full_name FROM users WHERE id = $1', [userId])).rows[0]?.full_name ?? 'unknown';
}

async function nextNewCode(c: Q): Promise<number> {
  return Number((await c.query("SELECT next_company_number('new_stock_item', 1001) AS n")).rows[0].n);
}

async function learnSupplier(c: Q, me: string, name: string): Promise<string> {
  const existing = await c.query("SELECT id FROM suppliers WHERE lower(name) = lower($1) AND status <> 'rejected'", [name]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = (await c.query('INSERT INTO suppliers (name, first_named_by) VALUES ($1, $2) RETURNING id', [name, me])).rows[0].id;
  await raiseFlag(c, { type: 'new_supplier', technicianId: me, severity: 'low', details: { supplierId: id, name, source: 'supplier_invoice' } });
  await notify(c, await managerOf(c, me), 'new_supplier', `New supplier from an invoice: ${name}`, { supplierId: id });
  return id;
}

/** Whether the technician changed anything the reader saw (supplier, number, total, or any line). */
function changedFromRead(read: ReadInvoice | null, b: { supplierName: string; invoiceNumber: string; totalCents?: number | null; lines: { description: string; qty: number; unitPriceCents?: number | null }[] }): boolean {
  if (!read) return false;   // typed by hand: nothing to compare with
  const t = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
  if (t(read.supplierName) !== t(b.supplierName) || t(read.invoiceNumber) !== t(b.invoiceNumber)) return true;
  if ((read.totalCents ?? null) !== (b.totalCents ?? null)) return true;
  if (read.lines.length !== b.lines.length) return true;
  return read.lines.some((l, i) => t(l.description) !== t(b.lines[i].description) || l.qty !== b.lines[i].qty || (l.unitPriceCents ?? null) !== (b.lines[i].unitPriceCents ?? null));
}

async function jobStock(c: Q, jobId: string) {
  const { rows } = await c.query(
    `SELECT i.id AS stock_item_id, i.code, i.description, i.unit,
            SUM(CASE WHEN m.kind IN ('assign', 'supplier_invoice', 'supply_run') AND m.holding_job_id = $1 THEN m.qty ELSE 0 END) AS booked,
            SUM(CASE WHEN m.kind = 'use_on_job' AND m.job_id = $1 THEN m.qty ELSE 0 END) AS used,
            SUM(CASE WHEN m.kind = 'return' AND m.holding_job_id = $1 THEN m.qty ELSE 0 END) AS returned
       FROM stock_movements m JOIN stock_items i ON i.id = m.stock_item_id
      WHERE m.holding_job_id = $1 OR m.job_id = $1
      GROUP BY i.id ORDER BY i.code`,
    [jobId],
  );
  const held = await c.query('SELECT stock_item_id, SUM(qty) AS qty FROM technician_holdings WHERE holding_job_id = $1 GROUP BY stock_item_id', [jobId]);
  const left = new Map(held.rows.map(r => [r.stock_item_id, Number(r.qty)]));
  return rows.map(r => ({
    stockItemId: r.stock_item_id, code: r.code, description: r.description, unit: r.unit,
    booked: Number(r.booked), used: Number(r.used), returned: Number(r.returned), onTechnician: left.get(r.stock_item_id) ?? 0,
  }));
}

async function returnsWhere(c: Q, where: string, params: unknown[]) {
  const { rows } = await c.query(
    `SELECT r.id, r.technician_id, u.full_name AS technician, r.status, r.requested_at, r.received_at, r.note,
            json_agg(json_build_object('lineId', l.id, 'stockItemId', l.stock_item_id, 'code', i.code, 'description', i.description,
                     'holdingJobId', l.holding_job_id, 'jobNumber', j.job_number, 'qty', l.qty, 'qtyReceived', l.qty_received) ORDER BY i.code) AS lines
       FROM stock_returns r JOIN users u ON u.id = r.technician_id
       JOIN stock_return_lines l ON l.return_id = r.id JOIN stock_items i ON i.id = l.stock_item_id
       LEFT JOIN jobs j ON j.id = l.holding_job_id
      WHERE ${where} GROUP BY r.id, u.full_name ORDER BY r.requested_at DESC LIMIT 100`,
    params,
  );
  return rows;
}

/**
 * Reads invoices waiting to be read, company by company. Runs shortly after each upload and every
 * minute, so an invoice uploaded while the reader was busy or the server restarted still gets read.
 */
export async function readPendingInvoices(db: Db, reader: InvoiceReader, uploadRoot = process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads')) {
  const companies = (await db.query('SELECT id FROM companies WHERE active')).rows;
  for (const co of companies) {
    const client = await db.connect();
    try {
      await client.query("SELECT set_config('app.company_id', $1, false)", [co.id]);
      for (;;) {
        await client.query('BEGIN');
        const inv = (await client.query(
          `SELECT i.id, i.technician_id, i.read_attempts, p.file_path, p.content_type
             FROM supplier_invoices i JOIN photos p ON p.id = i.photo_id
            WHERE i.status = 'reading' ORDER BY i.created_at LIMIT 1 FOR UPDATE OF i SKIP LOCKED`)).rows[0];
        if (!inv) { await client.query('COMMIT'); break; }
        try {
          const image = await readFile(join(uploadRoot, inv.file_path));
          const read = await reader(image, inv.content_type ?? 'image/jpeg');
          await client.query(
            `UPDATE supplier_invoices SET status = 'to_confirm', read_by = 'ai', read_result = $2, read_attempts = read_attempts + 1,
                    supplier_name = $3, invoice_number = $4, invoice_date = $5, total_cents = $6 WHERE id = $1`,
            [inv.id, JSON.stringify(read), read.supplierName, read.invoiceNumber, validDate(read.invoiceDate), read.totalCents],
          );
          await notify(client, inv.technician_id, 'invoice_read', `Supplier invoice read: ${read.lines.length} lines. Check and confirm.`, { invoiceId: inv.id });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const giveUp = inv.read_attempts + 1 >= 3 || /not a readable invoice/.test(msg);
          await client.query(
            `UPDATE supplier_invoices SET read_attempts = read_attempts + 1, read_error = $2, status = $3 WHERE id = $1`,
            [inv.id, msg.slice(0, 500), giveUp ? 'unreadable' : 'reading'],
          );
          if (giveUp) await notify(client, inv.technician_id, 'invoice_unreadable', 'A supplier invoice could not be read: type the lines from the photo', { invoiceId: inv.id });
          await client.query('COMMIT');
          if (!giveUp) break;   // try again on the next round
          continue;
        }
        await client.query('COMMIT');
      }
    } catch {
      await client.query('ROLLBACK').catch(() => {});
    } finally {
      await client.query('RESET app.company_id').catch(() => {});
      client.release();
    }
  }
}

const validDate = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : null);
