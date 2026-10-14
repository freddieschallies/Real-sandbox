// Who did what, for reference: each invoice with who made it and the technician whose job it came
// from, and the technicians ranked by the invoices their jobs brought in; each supplier invoice with
// who handed it in. For Accounts and the office.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can } from '../core/permissions.ts';
import { DateOnly, Refused, parse } from '../http.ts';

const back = (days: number) => new Date(Date.now() - days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const today = () => back(0);

export function registerWhoRoutes(app: FastifyInstance) {
  app.get('/office/who', async (req: FastifyRequest<{ Querystring: { from?: string; to?: string } }>) => {
    if (!can(req.actor, 'view_quotes_invoices_stock') && !can(req.actor, 'process_supplier_invoices')) throw new Refused(403, ['this is for Accounts and the office']);
    const q = parse(z.object({ from: DateOnly.optional(), to: DateOnly.optional() }), req.query);
    const from = q.from ?? back(90), to = q.to ?? today();
    const moneyIn = (await req.db.query(
      `SELECT i.id, i.invoice_number AS number, i.status, to_char(coalesce(i.sent_at, i.created_at) AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS date,
              c.name AS client, s.name AS store, j.job_number, mk.full_name AS made_by, t.full_name AS technician,
              ((SELECT coalesce(sum(round(l.qty * l.unit_price_cents)), 0) FROM document_lines l WHERE l.invoice_id = i.id)
                - (SELECT coalesce(sum(cn.amount_cents), 0) FROM credit_notes cn WHERE cn.invoice_id = i.id))::bigint AS ex_vat
         FROM invoices i JOIN jobs j ON j.id = i.job_id JOIN stores s ON s.id = j.store_id JOIN clients c ON c.id = s.client_id
         JOIN users mk ON mk.id = i.created_by JOIN users t ON t.id = j.lead_technician_id
        WHERE i.status IN ('sent', 'paid') AND (coalesce(i.sent_at, i.created_at) AT TIME ZONE 'Africa/Johannesburg')::date BETWEEN $1 AND $2
        ORDER BY i.invoice_number DESC`, [from, to])).rows.map(r => ({ ...r, ex_vat: Number(r.ex_vat) }));
    const moneyOut = (await req.db.query(
      `SELECT i.id, i.invoice_number AS number, i.supplier_name AS supplier, i.total_cents, i.source, coalesce(t.full_name, a.full_name) AS handed_in_by,
              to_char(coalesce(i.invoice_date, (i.confirmed_at AT TIME ZONE 'Africa/Johannesburg')::date), 'YYYY-MM-DD') AS date, j.job_number, po.po_number, i.check_status
         FROM supplier_invoices i LEFT JOIN users t ON t.id = i.technician_id LEFT JOIN users a ON a.id = i.added_by
         LEFT JOIN jobs j ON j.id = i.job_id LEFT JOIN purchase_orders po ON po.id = i.purchase_order_id
        WHERE i.status = 'confirmed' AND (i.confirmed_at AT TIME ZONE 'Africa/Johannesburg')::date BETWEEN $1 AND $2
        ORDER BY i.confirmed_at DESC`, [from, to])).rows;
    const rank = <T,>(list: T[], key: (x: T) => string, value: (x: T) => number) => {
      const m = new Map<string, { name: string; count: number; valueCents: number }>();
      for (const x of list) { const k = key(x); const g = m.get(k) ?? { name: k, count: 0, valueCents: 0 }; g.count++; g.valueCents += value(x); m.set(k, g); }
      return [...m.values()].sort((a, b) => b.count - a.count || b.valueCents - a.valueCents);
    };
    return {
      from, to, moneyIn, moneyOut,
      byTechnician: rank(moneyIn, x => x.technician, x => x.ex_vat),
      byMaker: rank(moneyIn, x => x.made_by, x => x.ex_vat),
      byHandedIn: rank(moneyOut, x => x.handed_in_by ?? '?', x => x.total_cents ?? 0),
    };
  });
}
