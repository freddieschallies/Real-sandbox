// Ordering stock from suppliers. Every item shows who it was last bought from, when and at what price
// (from deliveries received and supplier invoices). From the order list the stock controller makes a
// purchase order per supplier (approved as he makes it), sends it (email on the letterhead, WhatsApp,
// or printed), and receives the delivery against it. Suppliers' contact details are kept for next time.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, tx, type Q } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as R from '../core/stockroom.ts';
import { Refused, Uuid, parse } from '../http.ts';
import type { Mailer } from '../mailer.ts';
import { learnSupplier } from './stock.ts';
import { letterheadForMail } from './reports.ts';

export interface LastBought { supplier: string; at: string; unitPriceCents: number | null; ref: string | null; how: 'delivery' | 'invoice' }

/** Who each item was last bought from (the latest delivery or supplier invoice), and the last price paid. */
export async function lastBought(c: Q, itemIds?: string[]): Promise<Map<string, LastBought & { lastPriceCents: number | null }>> {
  const only = itemIds ? 'AND m.stock_item_id = ANY($1)' : '';
  const onlyL = itemIds ? 'AND l.stock_item_id = ANY($1)' : '';
  const args = itemIds ? [itemIds] : [];
  const d = (await c.query(
    `SELECT DISTINCT ON (m.stock_item_id) m.stock_item_id AS id, sd.supplier_name AS supplier, sd.received_at AS at, sd.reference AS ref
       FROM stock_movements m JOIN stock_deliveries sd ON sd.id = m.delivery_id WHERE m.kind = 'receive' ${only}
      ORDER BY m.stock_item_id, sd.received_at DESC`, args)).rows;
  const i = (await c.query(
    `SELECT DISTINCT ON (l.stock_item_id) l.stock_item_id AS id, si.supplier_name AS supplier, coalesce(si.invoice_date::timestamptz, si.confirmed_at, si.created_at) AS at,
            l.unit_price_cents AS price, si.invoice_number AS ref
       FROM supplier_invoice_lines l JOIN supplier_invoices si ON si.id = l.invoice_id
      WHERE si.status = 'confirmed' AND si.supplier_name IS NOT NULL ${onlyL}
      ORDER BY l.stock_item_id, coalesce(si.invoice_date::timestamptz, si.confirmed_at, si.created_at) DESC`, args)).rows;
  const out = new Map<string, LastBought & { lastPriceCents: number | null }>();
  for (const r of d) out.set(r.id, { supplier: r.supplier, at: new Date(r.at).toISOString(), unitPriceCents: null, ref: r.ref, how: 'delivery', lastPriceCents: null });
  for (const r of i) {
    const cur = out.get(r.id);
    const at = new Date(r.at).toISOString();
    const price = r.price ?? null;
    if (!cur || at >= cur.at) out.set(r.id, { supplier: r.supplier, at, unitPriceCents: price, ref: r.ref, how: 'invoice', lastPriceCents: price ?? cur?.lastPriceCents ?? null });
    else cur.lastPriceCents = cur.lastPriceCents ?? price;
  }
  return out;
}

const PO_SELECT = `SELECT p.id, p.po_number, p.status, p.supplier_name, p.supplier_id, p.note, p.requested_at, p.sent_at, p.sent_to, p.sent_how, p.collected_at,
       u.full_name AS made_by, sb.full_name AS sent_by, su.email AS supplier_email, su.phone AS supplier_phone, su.contact_name AS supplier_contact,
       (SELECT json_agg(json_build_object('lineNo', l.line_no, 'stockItemId', l.stock_item_id, 'code', i.code, 'unit', i.unit, 'description', l.description, 'qty', l.qty::float,
                                          'supplierCode', l.supplier_code, 'unitPriceCents', l.unit_price_cents) ORDER BY l.line_no)
          FROM purchase_order_lines l LEFT JOIN stock_items i ON i.id = l.stock_item_id WHERE l.po_id = p.id) AS lines,
       (SELECT d.reference FROM stock_deliveries d WHERE d.purchase_order_id = p.id ORDER BY d.received_at DESC LIMIT 1) AS delivery_ref
  FROM purchase_orders p LEFT JOIN users u ON u.id = p.decided_by LEFT JOIN users sb ON sb.id = p.sent_by LEFT JOIN suppliers su ON su.id = p.supplier_id`;

async function poOf(c: Q, id: string) {
  const p = (await c.query(`${PO_SELECT} WHERE p.id = $1 AND p.source = 'stockroom'`, [id])).rows[0];
  if (!p) throw new Refused(404, ['no such purchase order']);
  return p;
}
async function docOf(c: Q, p: Awaited<ReturnType<typeof poOf>>): Promise<R.PoDoc> {
  const prof = (await c.query('SELECT legal_name, trading_name, address, phone, email, vat_no FROM company_profile')).rows[0] ?? {};
  const co = (await c.query('SELECT name FROM companies WHERE id = current_company()')).rows[0]?.name ?? '';
  return {
    number: p.po_number, date: new Date(p.requested_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' }),
    supplier: p.supplier_name, contact: p.supplier_contact, note: p.note, by: p.made_by ?? '',
    lines: (p.lines ?? []).map((l: { code: string | null; supplierCode: string | null; description: string; qty: number; unit: string | null; unitPriceCents: number | null }) =>
      ({ code: l.code, supplierCode: l.supplierCode, description: l.description, qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents })),
    company: { name: prof.trading_name || prof.legal_name || co, address: prof.address, phone: prof.phone, email: prof.email, vatNo: prof.vat_no },
  };
}

export function registerStockOrderRoutes(app: FastifyInstance, mailer: Mailer | null) {
  const buyer = (req: FastifyRequest) => { if (!can(req.actor, 'manage_stockroom')) throw new Refused(403, ['ordering stock is for the stock controller']); };

  // The stockroom's own purchase orders: waiting to be sent, sent and waiting for delivery, received.
  app.get('/stock/orders', async req => {
    buyer(req);
    const rows = (await req.db.query(`${PO_SELECT} WHERE p.source = 'stockroom' AND p.status <> 'cancelled' ORDER BY p.requested_at DESC LIMIT 100`)).rows;
    return { orders: rows.map(p => ({ ...p, doc: null })), canEmail: !!mailer };
  });

  // A purchase order for one supplier from lines of the order list. The items are marked as ordered.
  app.post('/stock/orders', async (req, reply) => {
    buyer(req);
    const b = parse(z.object({ supplierName: z.string().trim().min(2, 'the supplier').max(200), note: z.string().trim().max(500).optional(),
      lines: z.array(z.object({ stockItemId: Uuid, qty: z.number().positive().max(1_000_000) })).min(1, 'at least one item').max(100) }), req.body);
    const out = await tx(req.db, async c => {
      const supplierId = await learnSupplier(c, req.actor.id, b.supplierName);
      const last = await lastBought(c, b.lines.map(l => l.stockItemId));
      const po = (await c.query(
        `INSERT INTO purchase_orders (supplier_id, supplier_name, note, status, source, decided_by, decided_at) VALUES ($1, $2, $3, 'approved', 'stockroom', $4, now()) RETURNING id, po_number`,
        [supplierId, b.supplierName, b.note || null, req.actor.id])).rows[0];
      let n = 1;
      for (const l of b.lines) {
        const it = (await c.query('SELECT description, supplier_code, cost_cents FROM stock_items WHERE id = $1', [l.stockItemId])).rows[0];
        if (!it) throw new Refused(404, ['an item is no longer there']);
        const lb = last.get(l.stockItemId);
        const price = lb?.supplier?.toLowerCase() === b.supplierName.toLowerCase() ? lb.lastPriceCents ?? it.cost_cents : it.cost_cents;
        await c.query('INSERT INTO purchase_order_lines (po_id, line_no, stock_item_id, description, qty, supplier_code, unit_price_cents) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [po.id, n++, l.stockItemId, it.description, l.qty, it.supplier_code, price ?? null]);
        await c.query('UPDATE stock_items SET ordered_at = now(), ordered_qty = $2, ordered_by = $3, ordered_note = $4 WHERE id = $1', [l.stockItemId, l.qty, req.actor.id, `PO ${po.po_number}, ${b.supplierName}`]);
      }
      await audit(c, req.actor.id, 'stock_po_made', 'purchase_order', po.id, { supplier: b.supplierName, lines: b.lines.length });
      return { id: po.id, poNumber: po.po_number };
    });
    return reply.code(201).send(out);
  });

  // The purchase order, ready to print or send (the same everywhere).
  app.get('/stock/orders/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    buyer(req);
    const p = await poOf(req.db, parse(Uuid, req.params.id));
    const doc = await docOf(req.db, p);
    return { order: p, doc, text: R.poText(doc), canEmail: !!mailer };
  });

  // Emailed to the supplier on the letterhead. The email is kept on the supplier for next time.
  app.post('/stock/orders/:id/email', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    buyer(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ to: z.array(z.string().trim().email('a valid email address')).min(1, 'the supplier\'s email').max(5), message: z.string().trim().max(1000).optional() }), req.body);
    if (!mailer) throw new Refused(503, ['email is not set up on the server yet (MAIL_URL): send it by WhatsApp or print it instead']);
    return tx(req.db, async c => {
      const p = await poOf(c, id);
      if (p.status === 'cancelled') throw new Refused(409, ['this purchase order is cancelled']);
      const doc = await docOf(c, p);
      const { prof, head, foot, pics } = await letterheadForMail(c);
      const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
      const html = `<div style="max-width:700px;font:14px Arial;color:#111"><style>${R.PO_CSS}</style>${head}${b.message ? `<p style="padding:0 24px">${esc(b.message).replace(/\n/g, '<br>')}</p>` : ''}${R.poHtml(doc)}<hr style="border:0;border-top:1px solid #ddd;margin:16px 0">${foot}</div>`;
      await mailer({ to: b.to, replyTo: prof.email || null, fromName: prof.trading_name || prof.legal_name || null, subject: `Purchase order ${p.po_number} from ${doc.company.name}`, html, text: `${b.message ? `${b.message}\n\n` : ''}${R.poText(doc)}`, pictures: pics });
      await c.query("UPDATE purchase_orders SET sent_at = now(), sent_to = $2, sent_by = $3, sent_how = 'email' WHERE id = $1", [id, b.to, req.actor.id]);
      if (p.supplier_id) await c.query("UPDATE suppliers SET email = coalesce(nullif(email, ''), $2) WHERE id = $1", [p.supplier_id, b.to[0]]);
      await audit(c, req.actor.id, 'stock_po_emailed', 'purchase_order', id, { to: b.to });
      return { id, sent: true, to: b.to };
    });
  });

  // Sent another way (WhatsApp from the phone, printed, phoned through).
  app.post('/stock/orders/:id/sent', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    buyer(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ how: z.enum(['whatsapp', 'printed', 'phone']), to: z.string().trim().max(100).optional() }), req.body);
    return tx(req.db, async c => {
      await poOf(c, id);
      await c.query('UPDATE purchase_orders SET sent_at = now(), sent_to = $2, sent_by = $3, sent_how = $4 WHERE id = $1', [id, b.to ? [b.to] : null, req.actor.id, b.how]);
      await audit(c, req.actor.id, 'stock_po_sent', 'purchase_order', id, b);
      return { id, sent: true, how: b.how };
    });
  });

  app.post('/stock/orders/:id/cancel', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    buyer(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ note: z.string().trim().min(3, 'why it is cancelled').max(300) }), req.body);
    return tx(req.db, async c => {
      const p = await poOf(c, id);
      if (p.status === 'collected') throw new Refused(409, ['it was already received']);
      await c.query("UPDATE purchase_orders SET status = 'cancelled', decision_note = $2 WHERE id = $1", [id, b.note]);
      // Back on the order list (unless something else is on order for it).
      await c.query("UPDATE stock_items SET ordered_at = NULL, ordered_qty = NULL, ordered_by = NULL, ordered_note = NULL WHERE ordered_note LIKE $1", [`PO ${p.po_number},%`]);
      await audit(c, req.actor.id, 'stock_po_cancelled', 'purchase_order', id, { note: b.note });
      return { id, cancelled: true };
    });
  });

  // Suppliers and their contact details.
  app.get('/stock/suppliers', async req => {
    buyer(req);
    const { rows } = await req.db.query(
      `SELECT s.id, s.name, s.email, s.phone, s.contact_name, s.pastel_code,
              (SELECT max(p.requested_at) FROM purchase_orders p WHERE p.supplier_id = s.id) AS last_order,
              (SELECT count(*)::int FROM stock_items i WHERE lower(i.supplier_name) = lower(s.name) AND i.active) AS usual_items
         FROM suppliers s WHERE s.status <> 'rejected' ORDER BY s.name`);
    return rows;
  });
  app.put('/stock/suppliers/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    buyer(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ email: z.string().trim().email('a valid email').max(200).or(z.literal('')).optional(), phone: z.string().trim().max(30).optional(), contactName: z.string().trim().max(100).optional() }), req.body);
    const r = await req.db.query('UPDATE suppliers SET email = $2, phone = $3, contact_name = $4 WHERE id = $1 RETURNING id', [id, b.email || null, b.phone || null, b.contactName || null]);
    if (!r.rowCount) throw new Refused(404, ['no such supplier']);
    await audit(req.db, req.actor.id, 'supplier_contact', 'supplier', id, {});
    return { id };
  });
}
