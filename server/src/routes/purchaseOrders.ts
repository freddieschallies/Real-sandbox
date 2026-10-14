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
  SELECT p.id, p.po_number, p.status, p.supplier_id, p.supplier_name, p.job_id, j.job_number, s.name AS store, p.note,
         p.technician_id, t.full_name AS technician, p.requested_at, p.decided_at, d.full_name AS decided_by, p.decision_note, p.collected_at,
         p.pastel_sent_at, p.pastel_ref,
         (SELECT coalesce(json_agg(json_build_object('lineNo', l.line_no, 'description', l.description, 'qty', l.qty::float, 'code', si.code, 'stockItemId', l.stock_item_id) ORDER BY l.line_no), '[]')
            FROM purchase_order_lines l LEFT JOIN stock_items si ON si.id = l.stock_item_id WHERE l.po_id = p.id) AS lines,
         (SELECT json_build_object('id', i.id, 'invoiceNumber', i.invoice_number, 'totalCents', i.total_cents, 'status', i.status) FROM supplier_invoices i WHERE i.purchase_order_id = p.id ORDER BY i.created_at DESC LIMIT 1) AS invoice
    FROM purchase_orders p JOIN users t ON t.id = p.technician_id LEFT JOIN users d ON d.id = p.decided_by
    LEFT JOIN jobs j ON j.id = p.job_id LEFT JOIN stores s ON s.id = j.store_id`;

export function registerPurchaseOrderRoutes(app: FastifyInstance) {
  // ---- The technician ---------------------------------------------------------------------------
  app.post('/purchase-orders', async (req, reply) => {
    const b = parse(z.object({
      supplierId: Uuid.optional(), supplierName: z.string().trim().min(2).max(200).optional(),
      jobId: Uuid.nullish(), note: z.string().trim().max(500).optional(),
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
      const po = (await c.query('INSERT INTO purchase_orders (technician_id, supplier_id, supplier_name, job_id, note) VALUES ($1, $2, $3, $4, $5) RETURNING id, po_number',
        [me, supplierId, name, b.jobId ?? null, b.note || null])).rows[0];
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
