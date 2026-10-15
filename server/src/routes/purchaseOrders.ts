// Purchase orders for stock runs. The technician asks on his phone: the supplier, the parts, and the
// job they are for (or his van). The stock controller, admin, his department manager or the CEO
// approves it (or says no, with why), and the PO number is on his phone at once to show at the
// counter. He scans the supplier's slip against the PO: the parts are booked to the job, where he
// marks them used or sends them back to the stockroom. Accounts sees the PO next to the invoice.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Q } from '../db.ts';
import { audit, tx } from '../db.ts';
import { can, type Actor } from '../core/permissions.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { isOnJob } from '../jobsRepo.ts';
import { managerOf, notify } from './field.ts';
import { randomUUID } from 'node:crypto';
import * as S from '../core/stock.ts';
import { poReaderFromEnv, type POReader } from '../poReader.ts';
import { nameScore } from '../core/pastelSetup.ts';
import { openFile, saveDocument } from '../uploads.ts';

const APPROVERS = ['stockroom', 'admin', 'management', 'director', 'creator'];
/** Who sees the purchase orders in the office: the approvers and Accounts. */
export const seesPOs = (a: Actor) => APPROVERS.includes(a.level) || can(a, 'process_supplier_invoices');

/** Whether this person may approve this technician's PO (a department manager: his own team only). */
async function mayApprove(c: Q, a: Actor, technicianId: string): Promise<boolean> {
  if (a.id === technicianId) return false;
  if (a.level === 'management') return (await managerOf(c, technicianId)) === a.id;
  return APPROVERS.includes(a.level);
}

const PO_SQL = `
  SELECT p.id, p.po_number, p.status, p.source, p.external_number, p.posted_by, p.photo_id, (SELECT ph.content_type FROM photos ph WHERE ph.id = p.photo_id) AS photo_mime, p.supplier_id, p.supplier_name, p.job_id, j.job_number, s.name AS store, p.note,
         p.technician_id, t.full_name AS technician, p.requested_at, p.decided_at, d.full_name AS decided_by, p.decision_note, p.collected_at,
         p.pastel_sent_at, p.pastel_ref,
         (SELECT coalesce(json_agg(json_build_object('lineNo', l.line_no, 'description', l.description, 'qty', l.qty::float, 'code', si.code, 'stockItemId', l.stock_item_id) ORDER BY l.line_no), '[]')
            FROM purchase_order_lines l LEFT JOIN stock_items si ON si.id = l.stock_item_id WHERE l.po_id = p.id) AS lines,
         (SELECT json_build_object('id', i.id, 'invoiceNumber', i.invoice_number, 'totalCents', i.total_cents, 'status', i.status) FROM supplier_invoices i WHERE i.purchase_order_id = p.id ORDER BY i.created_at DESC LIMIT 1) AS invoice
    FROM purchase_orders p LEFT JOIN users t ON t.id = p.technician_id LEFT JOIN users d ON d.id = p.decided_by
    LEFT JOIN jobs j ON j.id = p.job_id LEFT JOIN stores s ON s.id = j.store_id`;

/** A line read from a photo, matched to a stock item: the same code, or a clear match by its description. */
async function matchStock(c: Q, lines: { description: string; code: string | null; qty: number; unitPriceCents: number | null }[]) {
  const items = (await c.query('SELECT id, code, description, pastel_code FROM stock_items WHERE active')).rows as { id: string; code: string; description: string; pastel_code: string | null }[];
  return lines.map(l => {
    const code = (l.code ?? '').trim().toUpperCase();
    let hit = code ? items.find(i => i.code.toUpperCase() === code || (i.pastel_code ?? '').toUpperCase() === code) : undefined;
    if (!hit) {
      const ranked = items.map(i => ({ i, s: nameScore(l.description, i.description) })).sort((a, b) => b.s - a.s);
      if (ranked[0] && ranked[0].s >= 0.85 && (!ranked[1] || ranked[1].s < ranked[0].s - 0.1)) hit = ranked[0].i;
    }
    return { description: hit ? hit.description : l.description, qty: l.qty > 0 ? l.qty : 1, code: hit?.code ?? l.code, stockItemId: hit?.id ?? null, unitPriceCents: l.unitPriceCents };
  });
}

export function registerPurchaseOrderRoutes(app: FastifyInstance, reader: POReader = poReaderFromEnv()) {
  // ---- The technician: a photo of what he needs, read into the request ----------------------------
  app.post('/purchase-orders/read', async req => {
    const b = parse(z.object({ photoId: Uuid, note: z.string().max(1000).optional() }), req.body);
    const p = (await req.db.query("SELECT file_path, content_type, kind::text AS kind, taken_by FROM photos WHERE id = $1", [b.photoId])).rows[0];
    if (!p || p.taken_by !== req.actor.id || p.kind !== 'po_request') throw new Refused(404, ['no such photo']);
    const chunks: Buffer[] = [];
    for await (const ch of openFile(p.file_path)) chunks.push(ch as Buffer);
    const read = await reader({ text: b.note ?? '', files: [{ mime: p.content_type ?? 'image/jpeg', data: Buffer.concat(chunks) }], purpose: 'request' }).catch(() => null);
    if (!read) return { photoId: b.photoId, supplierName: null, lines: [], readBy: 'none' };
    let supplierName = read.supplierName;
    if (supplierName) {
      const known = (await req.db.query("SELECT name FROM suppliers WHERE status <> 'rejected'")).rows.map(r => r.name as string);
      supplierName = known.find(n => nameScore(n, supplierName!) >= 0.85) ?? supplierName;
    }
    return { photoId: b.photoId, supplierName, lines: await matchStock(req.db, read.lines.slice(0, 60)), readBy: read.readBy };
  });

  // ---- The technician ---------------------------------------------------------------------------
  app.post('/purchase-orders', async (req, reply) => {
    const b = parse(z.object({
      supplierId: Uuid.optional(), supplierName: z.string().trim().min(2).max(200).optional(),
      jobId: Uuid.nullish(), note: z.string().trim().max(500).optional(), photoId: Uuid.nullish(),
      lines: z.array(z.object({ stockItemId: Uuid.nullish(), description: z.string().trim().min(2).max(300), qty: z.number().positive().max(100000) })).min(1).max(100),
    }).refine(x => !!x.supplierId || !!x.supplierName, 'which supplier'), req.body);
    const me = req.actor.id;
    const out = await tx(req.db, async c => {
      if (b.jobId && !(await isOnJob(c, b.jobId, me))) throw new Refused(403, ['you are not on that job']);
      let supplierId = b.supplierId ?? null, name = b.supplierName ?? '';
      if (supplierId) {
        const sp = (await c.query("SELECT name, status FROM suppliers WHERE id = $1", [supplierId])).rows[0];
        if (!sp) throw new Refused(404, ['unknown supplier']);
        if (sp.status === 'rejected') throw new Refused(409, ['management rejected this supplier']);
        name = sp.name;
      } else {
        const found = (await c.query("SELECT id, name FROM suppliers WHERE lower(name) = lower($1) AND status <> 'rejected'", [name])).rows[0];
        supplierId = found?.id ?? (await c.query('INSERT INTO suppliers (name, first_named_by) VALUES ($1, $2) RETURNING id', [name, me])).rows[0].id;
        if (found) name = found.name;
      }
      for (const l of b.lines) {
        if (l.stockItemId && !(await c.query('SELECT 1 FROM stock_items WHERE id = $1', [l.stockItemId])).rowCount) throw new Refused(404, ['unknown stock item']);
      }
      // The photo it was read from goes with it, for whoever approves it.
      if (b.photoId && !(await c.query("SELECT 1 FROM photos WHERE id = $1 AND taken_by = $2 AND kind = 'po_request'", [b.photoId, me])).rowCount) throw new Refused(404, ['no such photo']);
      if (b.photoId && b.jobId) await c.query('UPDATE photos SET job_id = $2 WHERE id = $1', [b.photoId, b.jobId]);
      const po = (await c.query('INSERT INTO purchase_orders (technician_id, supplier_id, supplier_name, job_id, note, photo_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, po_number',
        [me, supplierId, name, b.jobId ?? null, b.note || null, b.photoId ?? null])).rows[0];
      let n = 0;
      for (const l of b.lines) await c.query('INSERT INTO purchase_order_lines (po_id, line_no, stock_item_id, description, qty) VALUES ($1, $2, $3, $4, $5)', [po.id, ++n, l.stockItemId ?? null, l.description, l.qty]);
      const who = (await c.query('SELECT full_name FROM users WHERE id = $1', [me])).rows[0].full_name;
      const job = b.jobId ? (await c.query('SELECT job_number FROM jobs WHERE id = $1', [b.jobId])).rows[0]?.job_number : null;
      // The stock controllers, admin, his manager and the CEO are told.
      const mgr = await managerOf(c, me);
      const to = (await c.query("SELECT id FROM users WHERE status = 'active' AND (login_level IN ('stockroom', 'admin', 'director', 'creator') OR id = $1)", [mgr])).rows;
      for (const u of to) await notify(c, u.id, 'po_requested', `${who} asks for PO ${po.po_number}: ${name}, ${b.lines.length} line${b.lines.length === 1 ? '' : 's'}${job ? ` for job ${job}` : ' for his van'}. Approve it?`, { poId: po.id });
      await audit(c, me, 'po_requested', 'purchase_order', po.id, { number: po.po_number, lines: b.lines.length });
      return { id: po.id, poNumber: po.po_number, status: 'requested' };
    });
    return reply.code(201).send(out);
  });

  // The suppliers to choose from (names only).
  app.get('/suppliers', async req => (await req.db.query("SELECT id, name FROM suppliers WHERE status <> 'rejected' ORDER BY name")).rows);

  app.get('/me/purchase-orders', async req => (await req.db.query(`${PO_SQL} WHERE p.technician_id = $1 ORDER BY p.requested_at DESC LIMIT 50`, [req.actor.id])).rows);

  app.post('/me/purchase-orders/:id/cancel', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const p = (await c.query('SELECT technician_id, status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p || p.technician_id !== req.actor.id) throw new Refused(404, ['no such PO of yours']);
      if (!['requested', 'approved'].includes(p.status)) throw new Refused(409, [`this PO is ${p.status}`]);
      await c.query("UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1", [id]);
      await audit(c, req.actor.id, 'po_cancelled', 'purchase_order', id);
      return { id, status: 'cancelled' };
    });
  });

  // ---- The office and the stockroom ------------------------------------------------------------
  app.get('/purchase-orders', async (req: FastifyRequest<{ Querystring: { view?: string } }>) => {
    if (!seesPOs(req.actor)) throw new Refused(403, ['purchase orders are for the stockroom and the office']);
    const view = parse(z.enum(['requested', 'approved', 'collected', 'all']).default('requested'), req.query.view);
    const where = view === 'all' ? 'true' : view === 'approved' ? "p.status = 'approved'" : view === 'collected' ? "p.status = 'collected'" : "p.status = 'requested'";
    const rows = (await req.db.query(`${PO_SQL} WHERE ${where} ORDER BY p.requested_at DESC LIMIT 200`)).rows;
    const counts = (await req.db.query("SELECT status, count(*)::int AS n FROM purchase_orders GROUP BY status")).rows;
    const mine = await Promise.all(rows.map(async r => ({ ...r, canDecide: r.status === 'requested' && (await mayApprove(req.db, req.actor, r.technician_id)) })));
    return { view, counts: Object.fromEntries(counts.map(r => [r.status, r.n])), orders: mine };
  });

  // A PO from the group without its job or technician: the office links it (the technician is told).
  app.put('/purchase-orders/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!APPROVERS.includes(req.actor.level)) throw new Refused(403, ['the stock controller, admin, a manager or the CEO links a PO']);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ jobId: Uuid.nullish(), technicianId: Uuid.nullish() }), req.body);
    return tx(req.db, async c => {
      const p = (await c.query('SELECT status, po_number, external_number, supplier_name FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) throw new Refused(404, ['no such PO']);
      if (!['requested', 'approved'].includes(p.status)) throw new Refused(409, [`this PO is ${p.status}`]);
      const job = b.jobId ? (await c.query('SELECT id, job_number, lead_technician_id FROM jobs WHERE id = $1', [b.jobId])).rows[0] : null;
      if (b.jobId && !job) throw new Refused(404, ['no such job']);
      const tech = b.technicianId ?? job?.lead_technician_id ?? null;
      if (tech && !(await c.query("SELECT 1 FROM users WHERE id = $1 AND login_level = 'technician' AND status = 'active'", [tech])).rowCount) throw new Refused(400, ['an active technician']);
      await c.query('UPDATE purchase_orders SET job_id = COALESCE($2, job_id), technician_id = COALESCE($3, technician_id) WHERE id = $1', [id, job?.id ?? null, tech]);
      if (tech && p.status === 'approved') await notify(c, tech, 'po_approved', `PO ${p.external_number ?? p.po_number}${job ? ` for job ${job.job_number}` : ''} is on your phone: show it at ${p.supplier_name}, then scan their slip against it.`, { poId: id });
      await audit(c, req.actor.id, 'po_linked', 'purchase_order', id, { jobId: job?.id ?? null, technicianId: tech });
      return { id, jobId: job?.id ?? null, technicianId: tech };
    });
  });

  app.post('/purchase-orders/:id/decide', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }), req.body);
    return tx(req.db, async c => {
      const p = (await c.query('SELECT technician_id, status, po_number, supplier_name FROM purchase_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) throw new Refused(404, ['no such PO']);
      if (!(await mayApprove(c, req.actor, p.technician_id))) {
        throw new Refused(403, [req.actor.id === p.technician_id ? 'someone else approves your own PO' : req.actor.level === 'management' ? 'a department manager approves his own team\'s POs' : 'POs are approved by the stock controller, admin, the department manager or the CEO']);
      }
      if (p.status !== 'requested') throw new Refused(409, [`PO ${p.po_number} is ${p.status} already`]);
      if (!b.approve && (!b.note || b.note.length < 3)) throw new Refused(400, ['say why not (the technician is told)']);
      await c.query('UPDATE purchase_orders SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1', [id, b.approve ? 'approved' : 'rejected', req.actor.id, b.note || null]);
      await notify(c, p.technician_id, b.approve ? 'po_approved' : 'po_rejected',
        b.approve ? `PO ${p.po_number} approved: show it at ${p.supplier_name}, then scan their slip against it.` : `PO ${p.po_number} not approved: ${b.note}`, { poId: id });
      await audit(c, req.actor.id, b.approve ? 'po_approved' : 'po_rejected', 'purchase_order', id, { note: b.note ?? null });
      return { id, status: b.approve ? 'approved' : 'rejected' };
    });
  });
}

/** The slip scanned against a PO: it must be his, approved and not used; it gives the job. */
export async function poForSlip(c: Q, poId: string, technicianId: string): Promise<{ jobId: string | null; number: number }> {
  const p = (await c.query('SELECT technician_id, status, job_id, po_number FROM purchase_orders WHERE id = $1 FOR UPDATE', [poId])).rows[0];
  if (!p || p.technician_id !== technicianId) throw new Refused(404, ['no such PO of yours']);
  if (p.status === 'requested') throw new Refused(409, [`PO ${p.po_number} is not approved yet`]);
  if (p.status !== 'approved') throw new Refused(409, [`PO ${p.po_number} is ${p.status}`]);
  return { jobId: p.job_id, number: p.po_number };
}

// ---- Purchase orders posted in the WhatsApp group ------------------------------------------------

export interface PostedPO { messageId: string; at: Date; senderName: string | null; text: string; files: { mime: string; data: Buffer }[] }

/**
 * A purchase order made outside the app (admin, in Pastel) and posted in the purchase orders group:
 * read, and added like the app's own: the job (by its number), the job's technician, the stock items,
 * already issued. The technician has it on his phone at once and scans the slip against it. Returns
 * the PO's id, or null when the message is not a purchase order.
 */
export async function ingestPO(c: Q, companyId: string, m: PostedPO, reader: POReader): Promise<string | null> {
  const seen = (await c.query('SELECT id FROM purchase_orders WHERE message_id = $1', [m.messageId])).rows[0];
  if (seen) return seen.id;
  const r = await reader({ text: m.text, files: m.files });
  if (!r.poNumber && !r.lines.length) return null;
  const supplierName = (r.supplierName ?? '').trim() || 'Supplier (see the PO)';
  // The same PO posted twice: kept once.
  if (r.poNumber) {
    const same = (await c.query("SELECT id FROM purchase_orders WHERE lower(external_number) = lower($1) AND lower(supplier_name) = lower($2) AND status <> 'cancelled'", [r.poNumber, supplierName])).rows[0];
    if (same) return same.id;
  }
  const job = r.jobNumber ? (await c.query('SELECT id, job_number, lead_technician_id FROM jobs WHERE job_number = $1', [r.jobNumber])).rows[0] : null;
  let techId: string | null = job?.lead_technician_id ?? null;
  if (!techId && r.technicianName) {
    const t = (await c.query("SELECT id FROM users WHERE login_level = 'technician' AND status = 'active' AND (lower(full_name) = lower($1) OR lower(split_part(full_name, ' ', 1)) = lower($1)) LIMIT 2", [r.technicianName.trim()])).rows;
    if (t.length === 1) techId = t[0].id;
  }
  let supplierId = (await c.query("SELECT id FROM suppliers WHERE lower(name) = lower($1) AND status <> 'rejected'", [supplierName])).rows[0]?.id ?? null;
  if (!supplierId && r.supplierName) supplierId = (await c.query('INSERT INTO suppliers (name) VALUES ($1) RETURNING id', [supplierName])).rows[0].id;
  let photoId: string | null = null;
  const f = m.files[0];
  if (f) {
    photoId = randomUUID();
    const rel = await saveDocument(companyId, photoId, f.data, f.mime, m.at.toISOString());
    await c.query("INSERT INTO photos (id, kind, file_path, taken_at, taken_by, content_type, bytes) VALUES ($1, 'supplier_doc', $2, $3, NULL, $4, $5)", [photoId, rel, m.at.toISOString(), f.mime, f.data.length]);
  }
  const po = (await c.query(
    `INSERT INTO purchase_orders (technician_id, supplier_id, supplier_name, job_id, note, status, decided_at, decision_note, source, external_number, posted_by, message_id, photo_id, read_by, requested_at)
     VALUES ($1, $2, $3, $4, $5, 'approved', now(), 'Issued outside the app and posted in the group', 'group', $6, $7, $8, $9, $10, $11) RETURNING id, po_number`,
    [techId, supplierId, supplierName, job?.id ?? null, m.text.trim().slice(0, 500) || null, r.poNumber, m.senderName, m.messageId, photoId, r.readBy, m.at.toISOString()])).rows[0];
  const catalogue = (await c.query('SELECT id, code, description, supplier_code AS "supplierCode" FROM stock_items WHERE active')).rows as S.CatalogueItem[];
  let n = 0;
  for (const l of r.lines) {
    const item = S.matchItem({ description: l.description, supplierCode: l.code, qty: l.qty }, catalogue);
    await c.query('INSERT INTO purchase_order_lines (po_id, line_no, stock_item_id, description, qty) VALUES ($1, $2, $3, $4, $5)', [po.id, ++n, item?.id ?? null, l.description, l.qty]);
  }
  const label = r.poNumber ? `PO ${r.poNumber}` : `PO ${po.po_number}`;
  if (techId) await notify(c, techId, 'po_approved', `${label} for ${job ? `job ${job.job_number}` : 'you'} is on your phone: show it at ${supplierName}, then scan their slip against it.`, { poId: po.id });
  const office = (await c.query("SELECT id FROM users WHERE status = 'active' AND login_level IN ('stockroom', 'accounts', 'admin')")).rows;
  for (const u of office) {
    await notify(c, u.id, 'po_posted', techId ? `${label} (${supplierName}) from the group is in the app${job ? `, on job ${job.job_number}` : ''}.`
      : `${label} (${supplierName}) from the group has no job or technician yet: link it under Purchase orders.`, { poId: po.id });
  }
  await audit(c, null, 'po_from_group', 'purchase_order', po.id, { external: r.poNumber, job: job?.job_number ?? null, readBy: r.readBy });
  return po.id;
}
