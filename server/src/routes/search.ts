// Search from anyone's front page. Only what that person may already see elsewhere in the app:
// a technician his own job cards and purchase orders and the stock list (no prices); the office
// every job card, stores, customers, quotes, invoices and stock prices as their work allows; the
// stockroom stock with prices; the fleet vehicles. Every word must match (in any order).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, seesPeople } from '../core/permissions.ts';
import * as D from '../core/documents.ts';
import { jobOutcome } from '../core/jobOutcome.ts';
import * as S from '../core/search.ts';
import { parse } from '../http.ts';
import { seesPOs } from './purchaseOrders.ts';

const day = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Johannesburg' }) : '');
const incl = (ex: number, vat: number) => D.totals([{ qty: 1, unitPriceCents: ex }], vat).totalCents;
const DOC_TONE: Record<string, S.Tone> = { draft: 'quiet', sent: 'info', accepted: 'good', declined: 'bad', paid: 'good', cancelled: 'quiet' };
const PO_TONE: Record<string, S.Tone> = { requested: 'warn', approved: 'good', rejected: 'bad', collected: 'info', cancelled: 'quiet' };

export function registerSearchRoutes(app: FastifyInstance) {
  app.get('/search', async (req: FastifyRequest<{ Querystring: { q?: string } }>) => {
    const q = parse(z.string().trim().max(100).default(''), req.query.q);
    const out: S.SearchResult = { q, groups: [] };
    if (q.length < S.MIN_CHARS || !S.wordsOf(q).length) return out;
    const p = S.likePatterns(q);
    const a = req.actor;
    const db = req.db;
    const N = S.PER_KIND;
    const add = (kind: S.SearchKind, hits: S.SearchHit[]) => { if (hits.length) out.groups.push({ kind, label: S.KIND_LABEL[kind], hits }); };
    const allJobs = can(a, 'view_all_job_cards');
    const office = allJobs || can(a, 'assign_jobs');
    const docs = can(a, 'view_quotes_invoices_stock');

    // Job cards: everyone (a technician his own, as on his phone).
    const jobs = (await db.query(
      `SELECT j.id, j.job_number, j.status, j.fault_reported, j.scheduled_date, s.name AS store, c.name AS client, u.full_name AS tech, j.cancelled_by_party,
              nc.reason AS no_charge_reason, inv.invoice_number, inv.status::text AS invoice_status,
              (SELECT coalesce(sum(cn.amount_cents), 0)::bigint FROM credit_notes cn WHERE cn.job_id = j.id) AS credited_cents
         FROM jobs j JOIN stores s ON s.id = j.store_id JOIN clients c ON c.id = s.client_id JOIN users u ON u.id = j.lead_technician_id
         LEFT JOIN job_no_charge nc ON nc.job_id = j.id
         LEFT JOIN LATERAL (SELECT i.invoice_number, i.status FROM invoices i WHERE i.job_id = j.id AND i.status <> 'cancelled' ORDER BY i.created_at DESC LIMIT 1) inv ON true
        WHERE ($2::boolean OR j.lead_technician_id = $3 OR EXISTS (SELECT 1 FROM job_helpers h WHERE h.job_id = j.id AND h.user_id = $3))
          AND concat_ws(' ', j.job_number, s.name, s.branch_code, c.name, j.fault_reported, j.client_order_ref, u.full_name, j.job_type) ILIKE ALL ($1)
        ORDER BY (j.status IN ('closed', 'cancelled')), j.scheduled_date DESC LIMIT $4`, [p, allJobs, a.id, N])).rows;
    add('job', jobs.map(j => {
      const o = jobOutcome({ ...j, credited_cents: Number(j.credited_cents) });
      return { kind: 'job', id: j.id, title: `Job ${j.job_number} · ${j.store}`, sub: [j.fault_reported, office ? j.tech : '', day(j.scheduled_date)].filter(Boolean).join(' · '), badge: { text: o.label, tone: o.tone } };
    }));

    // Stores and customers: the office.
    if (office) {
      const stores = (await db.query(
        `SELECT s.id, s.name, s.address, s.branch_code, c.name AS client, c.on_hold FROM stores s JOIN clients c ON c.id = s.client_id
          WHERE concat_ws(' ', s.name, s.branch_code, s.address, c.name, s.email, s.phone) ILIKE ALL ($1) ORDER BY s.name LIMIT $2`, [p, N])).rows;
      add('store', stores.map(s => ({ kind: 'store', id: s.id, title: s.name, sub: [s.client, s.branch_code, s.address].filter(Boolean).join(' · '), badge: s.on_hold ? { text: 'Account on hold', tone: 'bad' } : null })));
    }
    if (docs || allJobs) {
      const clients = (await db.query(
        `SELECT c.id, c.name, c.pastel_code, c.contact_name, c.on_hold, (SELECT count(*)::int FROM stores s WHERE s.client_id = c.id) AS stores FROM clients c
          WHERE concat_ws(' ', c.name, c.pastel_code, c.contact_name, c.email, c.phone) ILIKE ALL ($1) ORDER BY c.name LIMIT $2`, [p, N])).rows;
      add('client', clients.map(c => ({ kind: 'client', id: c.id, title: c.name, sub: [c.pastel_code ? `Pastel ${c.pastel_code}` : '', c.contact_name, `${c.stores} store${c.stores === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
        badge: c.on_hold ? { text: 'Account on hold', tone: 'bad' } : null })));
    }

    // Stock: everyone may find an item (a technician sees no prices, as on his stock list).
    const stockAll = can(a, 'manage_stockroom') || can(a, 'assign_stock') || docs;
    const prices = docs || can(a, 'set_prices') || can(a, 'manage_stockroom');
    const costs = can(a, 'set_prices') || can(a, 'process_supplier_invoices');
    const stock = (await db.query(
      `SELECT i.id, i.code, i.description, i.unit, i.selling_price_cents, i.cost_cents, i.category, coalesce(s.qty, 0)::float AS qty
         FROM stock_items i LEFT JOIN stockroom_stock s ON s.stock_item_id = i.id
        WHERE i.active AND ($2::boolean OR i.category = 'stock') AND concat_ws(' ', i.code, i.description, i.supplier_code, i.supplier_name) ILIKE ALL ($1)
        ORDER BY (lower(i.code) = lower($3)) DESC, i.code LIMIT $4`, [p, stockAll, q, N])).rows;
    add('stock', stock.map(i => ({
      kind: 'stock', id: i.id, title: `${i.code} · ${i.description}`, sub: `${i.qty} ${i.unit} in the stockroom${costs && i.cost_cents != null ? ` · cost ${D.rand(i.cost_cents)}` : ''}`,
      price: prices ? (i.selling_price_cents != null ? `${D.rand(i.selling_price_cents)} excl. VAT` : 'No selling price set') : null,
    })));

    // Quotes and invoices: whoever sees them.
    if (docs) {
      const quotes = (await db.query(
        `SELECT q.id, q.quote_number, q.status::text AS status, q.title, q.created_at, q.vat_pct::float AS vat, s.name AS store, c.name AS client, j.job_number,
                (SELECT coalesce(sum(round(l.qty * l.unit_price_cents)), 0) FROM document_lines l WHERE l.quote_id = q.id)::bigint AS ex
           FROM quotes q LEFT JOIN jobs j ON j.id = q.job_id JOIN stores s ON s.id = coalesce(q.store_id, j.store_id) JOIN clients c ON c.id = s.client_id
          WHERE concat_ws(' ', 'quote', q.quote_number, q.title, s.name, c.name, q.client_ref, j.job_number) ILIKE ALL ($1) ORDER BY q.quote_number DESC LIMIT $2`, [p, N])).rows;
      add('quote', quotes.map(x => ({ kind: 'quote', id: x.id, title: `Quote ${x.quote_number} · ${x.store}`, sub: [x.title, x.job_number ? `job ${x.job_number}` : '', day(x.created_at)].filter(Boolean).join(' · '),
        price: D.rand(incl(Number(x.ex), x.vat)), badge: { text: x.status, tone: DOC_TONE[x.status] ?? 'quiet' } })));
      const invoices = (await db.query(
        `SELECT i.id, i.invoice_number, i.status::text AS status, i.created_at, i.sent_at, i.vat_pct::float AS vat, s.name AS store, c.name AS client, j.job_number,
                (SELECT coalesce(sum(round(l.qty * l.unit_price_cents)), 0) FROM document_lines l WHERE l.invoice_id = i.id)::bigint AS ex
           FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN stores s ON s.id = j.store_id JOIN clients c ON c.id = s.client_id
          WHERE concat_ws(' ', 'invoice', i.invoice_number, s.name, c.name, i.client_ref, j.job_number) ILIKE ALL ($1) ORDER BY i.invoice_number DESC LIMIT $2`, [p, N])).rows;
      add('invoice', invoices.map(x => ({ kind: 'invoice', id: x.id, title: `Invoice ${x.invoice_number} · ${x.store}`, sub: [x.client, `job ${x.job_number}`, day(x.sent_at ?? x.created_at)].filter(Boolean).join(' · '),
        price: D.rand(incl(Number(x.ex), x.vat)), badge: { text: x.status === 'sent' ? 'unpaid' : x.status, tone: x.status === 'sent' ? 'warn' : DOC_TONE[x.status] ?? 'quiet' } })));
    }

    // Purchase orders: the stockroom and the office all; a technician his own.
    const allPOs = seesPOs(a);
    const pos = (await db.query(
      `SELECT p.id, p.po_number, p.external_number, p.status, p.supplier_name, p.requested_at, j.job_number, u.full_name AS tech
         FROM purchase_orders p LEFT JOIN jobs j ON j.id = p.job_id LEFT JOIN users u ON u.id = p.technician_id
        WHERE ($2::boolean OR p.technician_id = $3) AND concat_ws(' ', 'po', p.po_number, p.external_number, p.supplier_name, j.job_number, u.full_name) ILIKE ALL ($1)
        ORDER BY p.requested_at DESC LIMIT $4`, [p, allPOs, a.id, N])).rows;
    add('po', pos.map(x => ({ kind: 'po', id: x.id, title: `PO ${x.external_number ?? x.po_number} · ${x.supplier_name}`, sub: [allPOs ? x.tech : '', x.job_number ? `job ${x.job_number}` : 'van stock', day(x.requested_at)].filter(Boolean).join(' · '),
      badge: { text: x.status, tone: PO_TONE[x.status] ?? 'quiet' } })));

    // Supplier invoices: Accounts.
    if (can(a, 'process_supplier_invoices')) {
      const sup = (await db.query(
        `SELECT si.id, si.invoice_number, si.supplier_name, si.total_cents, si.invoice_date, si.status::text AS status, j.job_number
           FROM supplier_invoices si LEFT JOIN jobs j ON j.id = si.job_id
          WHERE concat_ws(' ', si.invoice_number, si.supplier_name, j.job_number) ILIKE ALL ($1) ORDER BY si.created_at DESC LIMIT $2`, [p, N])).rows;
      add('supplier_invoice', sup.map(x => ({ kind: 'supplier_invoice', id: x.id, title: `${x.supplier_name ?? 'Supplier'} · ${x.invoice_number ?? 'no number yet'}`,
        sub: [x.job_number ? `job ${x.job_number}` : '', day(x.invoice_date)].filter(Boolean).join(' · '), price: x.total_cents != null ? D.rand(x.total_cents) : null, badge: { text: x.status.replace(/_/g, ' '), tone: 'quiet' } })));
    }

    // People: whoever sees the people list.
    if (seesPeople(a)) {
      const people = (await db.query(
        `SELECT u.id, u.full_name, u.login_level, u.trade, d.name AS department FROM users u LEFT JOIN departments d ON d.id = u.department_id
          WHERE u.status <> 'left' AND concat_ws(' ', u.full_name, u.trade, d.name, u.login_level) ILIKE ALL ($1) ORDER BY u.full_name LIMIT $2`, [p, N])).rows;
      add('person', people.map(x => ({ kind: 'person', id: x.id, title: x.full_name, sub: [x.login_level === 'management' ? 'department manager' : x.login_level, x.trade, x.department].filter(Boolean).join(' · ') })));
    }

    // Vehicles: whoever sees the fleet.
    if (can(a, 'view_fleet')) {
      const vehicles = (await db.query(
        `SELECT v.id, v.registration, v.description, v.make, v.model, v.status::text AS status FROM vehicles v
          WHERE v.active AND concat_ws(' ', v.registration, replace(v.registration, ' ', ''), v.description, v.make, v.model) ILIKE ALL ($1) ORDER BY v.registration LIMIT $2`, [p, N])).rows;
      add('vehicle', vehicles.map(x => ({ kind: 'vehicle', id: x.id, title: x.registration, sub: [x.make, x.model, x.description].filter(Boolean).join(' · '),
        badge: x.status && x.status !== 'in_service' ? { text: x.status.replace(/_/g, ' '), tone: 'warn' } : null })));
    }
    return out;
  });
}
