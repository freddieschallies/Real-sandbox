// Accounts: every supplier invoice in one list, checked and approved before it goes to Pastel.
// Two ways in: a technician's till slip (photographed and confirmed on his phone), or one the office
// scans: a photo from the phone's camera, or a picture or PDF file (an invoice that came by email).
// The office's scans are read automatically, like the slips; Accounts checks what was read next to
// the picture, then approves it, or queries it with a note to whoever booked it. The same invoice is
// never booked twice. Approving keeps each stock item's latest cost price (the clients' mark-up is on it).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Db, Q } from '../db.ts';
import { audit, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as S from '../core/stock.ts';
import { DateOnly, Refused, Uuid, parse } from '../http.ts';
import type { InvoiceReader } from '../invoiceReader.ts';
import { readPendingInvoices } from './stock.ts';
import { notify } from './field.ts';
import { removeFile, saveDocument } from '../uploads.ts';

/** A scan (photo or PDF) may be bigger than a phone photo: up to 10 MB. */
export const MAX_SCAN_BYTES = 10 * 1024 * 1024;
const SCAN_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export const VIEWS = ['scanned', 'to_check', 'queried', 'approved', 'in_pastel', 'all'] as const;
type View = (typeof VIEWS)[number];
const WHERE: Record<View, string> = {
  // Scanned by the office and not finished yet (being read, or read and waiting to be checked and saved).
  scanned: "i.source = 'office' AND i.status <> 'confirmed'",
  to_check: "i.status = 'confirmed' AND i.check_status = 'to_check'",
  queried: "i.status = 'confirmed' AND i.check_status = 'queried'",
  approved: "i.check_status = 'approved' AND i.pastel_batch_id IS NULL",
  in_pastel: 'i.pastel_batch_id IS NOT NULL',
  all: "(i.status = 'confirmed' OR i.source = 'office')",
};

const LIST_SQL = `
  SELECT i.id, i.source, i.status, i.check_status, i.check_note, i.supplier_id, i.supplier_name, sp.pastel_code AS supplier_code,
         i.invoice_number, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, i.total_cents, i.vat_cents, i.photo_id, ph.content_type,
         i.scanned_at, i.confirmed_at, i.checked_at, ck.full_name AS checked_by, i.changed_from_read, i.read_error,
         t.full_name AS technician, ab.full_name AS added_by, j.job_number, i.job_id, i.delivery_id, d.reference AS delivery_ref,
         to_char(d.received_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS delivery_date, i.pastel_batch_id
    FROM supplier_invoices i
    LEFT JOIN suppliers sp ON sp.id = i.supplier_id LEFT JOIN photos ph ON ph.id = i.photo_id
    LEFT JOIN users t ON t.id = i.technician_id LEFT JOIN users ab ON ab.id = i.added_by LEFT JOIN users ck ON ck.id = i.checked_by
    LEFT JOIN jobs j ON j.id = i.job_id LEFT JOIN stock_deliveries d ON d.id = i.delivery_id`;

async function lines(c: Q, id: string) {
  return (await c.query(
    `SELECT l.line_no, l.description, l.supplier_code, l.qty::float AS qty, l.unit_price_cents, s.code AS stock_code
       FROM supplier_invoice_lines l LEFT JOIN stock_items s ON s.id = l.stock_item_id WHERE l.invoice_id = $1 ORDER BY l.line_no`, [id])).rows;
}

/** The supplier, known or new (the office naming a supplier is not a technician's surprise: no flag). */
async function supplierFor(c: Q, me: string, name: string): Promise<string> {
  const found = (await c.query("SELECT id FROM suppliers WHERE lower(name) = lower($1) AND status <> 'rejected'", [name])).rows[0];
  if (found) return found.id;
  return (await c.query('INSERT INTO suppliers (name, first_named_by) VALUES ($1, $2) RETURNING id', [name, me])).rows[0].id;
}

/** Approved: each stock item on it now costs what this invoice says (excluding VAT). */
async function keepCosts(c: Q, id: string) {
  await c.query(
    `UPDATE stock_items s SET cost_cents = l.unit_price_cents, cost_at = now()
       FROM supplier_invoice_lines l WHERE l.invoice_id = $1 AND l.stock_item_id = s.id AND l.unit_price_cents IS NOT NULL`, [id]);
}

export function registerSupplierInvoiceRoutes(app: FastifyInstance, db: Db, reader: InvoiceReader | null) {
  const accounts = (req: FastifyRequest) => {
    if (!can(req.actor, 'process_supplier_invoices')) throw new Refused(403, ['supplier invoices are for Accounts']);
  };

  app.get('/office/supplier-invoices', async (req: FastifyRequest<{ Querystring: { view?: string } }>) => {
    accounts(req);
    const view = parse(z.enum(VIEWS).default('to_check'), req.query.view);
    const counts = Object.fromEntries(await Promise.all(VIEWS.filter(v => v !== 'all').map(async v =>
      [v, Number((await req.db.query(`SELECT count(*) AS n FROM supplier_invoices i WHERE ${WHERE[v]}`)).rows[0].n)] as const)));
    const { rows } = await req.db.query(`${LIST_SQL} WHERE ${WHERE[view]} ORDER BY coalesce(i.confirmed_at, i.scanned_at) DESC LIMIT 200`);
    return { view, counts, invoices: rows };
  });

  app.get('/office/supplier-invoices/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    accounts(req);
    const id = parse(Uuid, req.params.id);
    const inv = (await req.db.query(`${LIST_SQL} WHERE i.id = $1`, [id])).rows[0];
    if (!inv) throw new Refused(404, ['no such supplier invoice']);
    const read = (await req.db.query('SELECT read_result FROM supplier_invoices WHERE id = $1', [id])).rows[0].read_result;
    // Stockroom deliveries from this supplier that no other invoice covers: to tick off "the goods came in".
    const deliveries = (await req.db.query(
      `SELECT d.id, d.reference, to_char(d.received_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS date, u.full_name AS received_by,
              (SELECT json_agg(json_build_object('code', s.code, 'description', s.description, 'qty', m.qty::float) ORDER BY s.code)
                 FROM stock_movements m JOIN stock_items s ON s.id = m.stock_item_id WHERE m.delivery_id = d.id) AS lines
         FROM stock_deliveries d JOIN users u ON u.id = d.received_by
        WHERE ($1::text IS NOT NULL AND (d.supplier_id = $2 OR lower(d.supplier_name) = lower($1)))
          AND NOT EXISTS (SELECT 1 FROM supplier_invoices x WHERE x.delivery_id = d.id AND x.id <> $3)
          AND d.received_at > now() - interval '180 days'
        ORDER BY d.received_at DESC LIMIT 10`, [inv.supplier_name, inv.supplier_id, id])).rows;
    return { ...inv, read, lines: await lines(req.db, id), deliveries };
  });

  // Scan: a photo from the camera, or a picture or PDF file. Read automatically when reading is set up.
  app.post('/office/supplier-invoices/scan', async (req, reply) => {
    accounts(req);
    if (!req.isMultipart()) throw new Refused(400, ['send the invoice as a form upload']);
    const part = await req.file({ limits: { fileSize: MAX_SCAN_BYTES } });
    if (!part) throw new Refused(400, ['no file']);
    const buffer = await part.toBuffer();
    if (part.file.truncated) throw new Refused(400, ['the file is larger than 10 MB: scan it again at a lower quality, or save only the invoice pages']);
    const mime = part.mimetype === 'image/jpg' ? 'image/jpeg' : part.mimetype;
    if (!SCAN_TYPES.includes(mime)) throw new Refused(400, ['the invoice must be a photo (JPEG, PNG or WebP) or a PDF']);
    if (!buffer.length) throw new Refused(400, ['the file is empty']);
    if (mime === 'application/pdf' && buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Refused(400, ['this is not a PDF file']);
    const now = new Date().toISOString();
    const photoId = randomUUID();
    const rel = await saveDocument(req.companyId, photoId, buffer, mime, now);
    const id = randomUUID();
    try {
      await tx(req.db, async c => {
        await c.query('INSERT INTO photos (id, kind, file_path, taken_at, taken_by, content_type, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [photoId, 'supplier_doc', rel, now, req.actor.id, mime, buffer.length]);
        await c.query(
          `INSERT INTO supplier_invoices (id, technician_id, photo_id, scanned_at, status, source, added_by, read_error)
           VALUES ($1, NULL, $2, $3, $4, 'office', $5, $6)`,
          [id, photoId, now, reader ? 'reading' : 'unreadable', req.actor.id, reader ? null : 'automatic reading is not set up: type it in from the picture']);
        await audit(c, req.actor.id, 'supplier_invoice_scanned', 'supplier_invoice', id, { file: part.filename ?? null, mime });
      });
    } catch (e) {
      await removeFile(rel);
      throw e;
    }
    if (reader) setTimeout(() => { readPendingInvoices(db, reader).catch(() => {}); }, 50);
    return reply.code(201).send({ id, status: reader ? 'reading' : 'unreadable', photoId });
  });

  const Line = z.object({
    description: z.string().trim().min(2).max(300),
    supplierCode: z.string().trim().max(60).nullish(),
    qty: z.number().positive().max(100000),
    unitPriceCents: z.number().int().min(0).nullish(),
  });

  // The office's own scan: what it says (checked against the picture), saved, and approved at once if asked.
  app.put('/office/supplier-invoices/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    accounts(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({
      supplierName: z.string().trim().min(2).max(200),
      invoiceNumber: z.string().trim().min(1).max(60),
      invoiceDate: DateOnly.nullish(),
      totalCents: z.number().int().min(1, 'the invoice total'),
      vatCents: z.number().int().min(0).nullish(),
      jobId: Uuid.nullish(),
      deliveryId: Uuid.nullish(),
      lines: z.array(Line).min(1).max(200),
      approve: z.boolean().default(false),
    }), req.body);
    const me = req.actor.id;
    return tx(req.db, async c => {
      const inv = (await c.query('SELECT source, status, check_status, pastel_batch_id, read_result FROM supplier_invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!inv) throw new Refused(404, ['no such supplier invoice']);
      if (inv.source !== 'office') throw new Refused(409, ["a technician's slip is changed by him: query it instead"]);
      if (inv.status === 'reading') throw new Refused(409, ['still reading this invoice: try again in a moment']);
      if (inv.pastel_batch_id) throw new Refused(409, ['this invoice is already in Pastel']);
      if (inv.check_status === 'approved') throw new Refused(409, ['this invoice is approved: take the approval off first to change it']);
      const problems = S.invoiceProblems(b);
      if (b.vatCents != null && b.vatCents >= b.totalCents) problems.push('the VAT is more than the total');
      if (problems.length) throw new Refused(409, problems);
      if (b.jobId && !(await c.query('SELECT 1 FROM jobs WHERE id = $1', [b.jobId])).rowCount) throw new Refused(404, ['no such job']);
      if (b.deliveryId) {
        if (!(await c.query('SELECT 1 FROM stock_deliveries WHERE id = $1', [b.deliveryId])).rowCount) throw new Refused(404, ['no such delivery']);
        const other = (await c.query('SELECT invoice_number FROM supplier_invoices WHERE delivery_id = $1 AND id <> $2', [b.deliveryId, id])).rows[0];
        if (other) throw new Refused(409, [`that delivery is already on invoice ${other.invoice_number}`]);
      }
      // The same invoice is booked once, by anyone (a technician's slip, or another scan).
      const dup = (await c.query(
        `SELECT i.id, coalesce(t.full_name, a.full_name) AS who, to_char(i.confirmed_at AT TIME ZONE 'Africa/Johannesburg', 'DD Mon YYYY') AS day
           FROM supplier_invoices i LEFT JOIN users t ON t.id = i.technician_id LEFT JOIN users a ON a.id = i.added_by
          WHERE i.status = 'confirmed' AND i.id <> $3 AND lower(i.supplier_name) = lower($1) AND lower(i.invoice_number) = lower($2)`,
        [b.supplierName, b.invoiceNumber, id])).rows[0];
      if (dup) throw new Refused(409, [`invoice ${b.invoiceNumber} from ${b.supplierName} was already booked by ${dup.who} on ${dup.day}`]);

      const supplierId = await supplierFor(c, me, b.supplierName);
      const catalogue = (await c.query('SELECT id, code, description, supplier_code AS "supplierCode" FROM stock_items WHERE active')).rows as S.CatalogueItem[];
      await c.query('DELETE FROM supplier_invoice_lines WHERE invoice_id = $1', [id]);
      let n = 0;
      for (const l of b.lines) {
        n++;
        // A line that is one of our stock items (by the supplier's code or the description) is linked to it.
        const item = S.matchItem(l, catalogue);
        await c.query(
          `INSERT INTO supplier_invoice_lines (invoice_id, line_no, description, supplier_code, qty, unit_price_cents, stock_item_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, n, l.description, l.supplierCode ?? null, l.qty, l.unitPriceCents ?? null, item?.id ?? null]);
      }
      const read = inv.read_result as { supplierName?: string; invoiceNumber?: string; totalCents?: number | null; lines?: unknown[] } | null;
      const t = (s: unknown) => String(s ?? '').trim().toLowerCase();
      const changed = !!read && (t(read.supplierName) !== t(b.supplierName) || t(read.invoiceNumber) !== t(b.invoiceNumber) || (read.totalCents ?? null) !== b.totalCents || (read.lines?.length ?? 0) !== b.lines.length);
      await c.query(
        `UPDATE supplier_invoices SET status = 'confirmed', confirmed_at = coalesce(confirmed_at, now()), supplier_id = $2, supplier_name = $3, invoice_number = $4,
                invoice_date = $5, total_cents = $6, vat_cents = $7, job_id = $8, delivery_id = $9, changed_from_read = $10,
                check_status = $11, checked_by = CASE WHEN $11 = 'approved' THEN $12::uuid ELSE NULL END, checked_at = CASE WHEN $11 = 'approved' THEN now() ELSE NULL END,
                check_note = NULL
          WHERE id = $1`,
        [id, supplierId, b.supplierName, b.invoiceNumber, b.invoiceDate ?? null, b.totalCents, b.vatCents ?? null, b.jobId ?? null, b.deliveryId ?? null, changed,
          b.approve ? 'approved' : 'to_check', me]);
      if (b.approve) await keepCosts(c, id);
      await audit(c, me, b.approve ? 'supplier_invoice_approved' : 'supplier_invoice_saved', 'supplier_invoice', id, { lines: b.lines.length, changed });
      const linesTotal = S.linesTotalCents(b.lines);
      const exVat = b.vatCents != null ? b.totalCents - b.vatCents : null;
      return {
        id, checkStatus: b.approve ? 'approved' : 'to_check', changedFromRead: changed,
        // A warning, not a stop: the lines don't add up to the invoice (Pastel then gets one line for the whole invoice).
        warning: linesTotal !== null && exVat !== null && Math.abs(linesTotal - exVat) > 100 ? 'the lines do not add up to the total excluding VAT: Pastel gets one line for the whole invoice' : null,
      };
    });
  });

  // Approve, query (a note to whoever booked it), or take the approval off again (not once it is in Pastel).
  app.post('/office/supplier-invoices/:id/check', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    accounts(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ action: z.enum(['approve', 'query', 'reopen']), note: z.string().trim().max(500).optional() }), req.body);
    const me = req.actor.id;
    return tx(req.db, async c => {
      const inv = (await c.query('SELECT status, check_status, pastel_batch_id, technician_id, added_by, supplier_name, invoice_number, total_cents FROM supplier_invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!inv) throw new Refused(404, ['no such supplier invoice']);
      if (inv.status !== 'confirmed') throw new Refused(409, ['save what the invoice says first']);
      if (inv.pastel_batch_id) throw new Refused(409, ['this invoice is already in Pastel']);
      if (b.action === 'approve') {
        if (inv.check_status === 'approved') throw new Refused(409, ['already approved']);
        if (!inv.total_cents) throw new Refused(409, ['the invoice total is missing: query it so it is added']);
        await c.query("UPDATE supplier_invoices SET check_status = 'approved', checked_by = $2, checked_at = now() WHERE id = $1", [id, me]);
        await keepCosts(c, id);
      } else if (b.action === 'query') {
        if (!b.note || b.note.length < 5) throw new Refused(400, ['say what is wrong (at least a few words)']);
        await c.query("UPDATE supplier_invoices SET check_status = 'queried', check_note = $3, checked_by = $2, checked_at = now() WHERE id = $1", [id, me, b.note]);
        const who = inv.technician_id ?? inv.added_by;
        if (who && who !== me) await notify(c, who, 'supplier_invoice_queried', `Accounts queried invoice ${inv.invoice_number} from ${inv.supplier_name}: ${b.note}`, { invoiceId: id });
      } else {
        if (inv.check_status === 'to_check') throw new Refused(409, ['it is waiting to be checked already']);
        await c.query("UPDATE supplier_invoices SET check_status = 'to_check', check_note = NULL, checked_by = NULL, checked_at = NULL WHERE id = $1", [id]);
      }
      await audit(c, me, `supplier_invoice_${b.action}`, 'supplier_invoice', id, { note: b.note ?? null });
      return { id, checkStatus: b.action === 'approve' ? 'approved' : b.action === 'query' ? 'queried' : 'to_check' };
    });
  });

  // A scan that was the wrong file, or not an invoice: taken off (only before it is saved).
  app.delete('/office/supplier-invoices/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    accounts(req);
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const inv = (await c.query('SELECT source, status FROM supplier_invoices WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!inv) throw new Refused(404, ['no such supplier invoice']);
      if (inv.source !== 'office' || inv.status === 'confirmed') throw new Refused(409, ['only a scan that was not saved yet can be taken off']);
      await c.query('DELETE FROM supplier_invoice_lines WHERE invoice_id = $1', [id]);
      await c.query('DELETE FROM supplier_invoices WHERE id = $1', [id]);
      await audit(c, req.actor.id, 'supplier_invoice_scan_removed', 'supplier_invoice', id);
      return { id, removed: true };
    });
  });
}
