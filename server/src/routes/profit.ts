// What each closed job made (invoiced less credit notes, against its labour, travel, parts and
// bought-out costs), and the same per client, technician and month. For the CEO and Accounts.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can } from '../core/permissions.ts';
import * as Jc from '../core/jobCard.ts';
import * as P from '../core/profit.ts';
import { DateOnly, Refused, parse } from '../http.ts';
import { loadCard } from '../jobsRepo.ts';
import { companyRates, travelForJob } from './clientRates.ts';
import { crewCostCents } from './crew.ts';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const back = (days: number) => new Date(Date.now() - days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

export function registerProfitRoutes(app: FastifyInstance) {
  app.get('/office/profit', async (req: FastifyRequest<{ Querystring: { from?: string; to?: string } }>) => {
    if (!can(req.actor, 'view_company_reports')) throw new Refused(403, ['profit is for the CEO and Accounts']);
    const q = parse(z.object({ from: DateOnly.optional(), to: DateOnly.optional() }), req.query);
    const from = q.from ?? back(90), to = q.to ?? today();
    const rates = await companyRates(req.db);
    const cr: P.CostRates = { labourCostPerHourCents: rates.labour_cost_per_hour ?? 0, vehicleCostPerKmCents: rates.vehicle_cost_per_km ?? 0 };
    const { rows } = await req.db.query(
      `SELECT j.id, j.job_number, c.name AS client, s.name AS store, u.full_name AS technician, (SELECT count(*)::int FROM job_helpers h WHERE h.job_id = j.id) AS helpers,
              to_char(j.closed_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS closed, EXISTS (SELECT 1 FROM job_no_charge n WHERE n.job_id = j.id) AS no_charge,
              (SELECT sum((SELECT coalesce(sum(round(l.qty * l.unit_price_cents)), 0) FROM document_lines l WHERE l.invoice_id = i.id)) FROM invoices i WHERE i.job_id = j.id AND i.status IN ('sent', 'paid'))::bigint AS invoiced,
              (SELECT coalesce(sum(cn.amount_cents), 0) FROM credit_notes cn WHERE cn.job_id = j.id)::bigint AS credited,
              (SELECT coalesce(sum(m.qty * coalesce(si.cost_cents, 0)), 0) FROM stock_movements m JOIN stock_items si ON si.id = m.stock_item_id WHERE m.job_id = j.id AND m.kind = 'use_on_job')::bigint AS parts,
              (SELECT count(*) FROM stock_movements m JOIN stock_items si ON si.id = m.stock_item_id WHERE m.job_id = j.id AND m.kind = 'use_on_job' AND si.cost_cents IS NULL)::int AS parts_no_cost,
              (SELECT coalesce(sum(round(b.qty * b.price_cents)), 0) FROM bought_out_items b WHERE b.job_id = j.id)::bigint AS bought
         FROM jobs j JOIN stores s ON s.id = j.store_id JOIN clients c ON c.id = s.client_id JOIN users u ON u.id = j.lead_technician_id
        WHERE j.status = 'closed' AND (j.closed_at AT TIME ZONE 'Africa/Johannesburg')::date BETWEEN $1 AND $2
        ORDER BY j.closed_at DESC LIMIT 1000`, [from, to]);
    const jobs: P.JobProfit[] = [];
    for (const r of rows) {
      const loaded = await loadCard(req.db, r.id);
      if (!loaded) continue;
      const people = 1 + r.helpers;
      const travel = await travelForJob(req.db, r.id, loaded.card);
      jobs.push(P.jobProfit({
        jobId: r.id, jobNumber: r.job_number, client: r.client, store: r.store, technician: r.technician, month: r.closed.slice(0, 7), closed: r.closed,
        revenueCents: r.invoiced === null ? null : Number(r.invoiced) - Number(r.credited), noCharge: r.no_charge,
        labourMinutes: (Jc.jobMinutes(loaded.card) + (travel?.minutes ?? 0)) * people, km: travel?.km ?? 0, kmEstimated: travel?.kmEstimated ?? false,
        partsCostCents: Number(r.parts), partsWithoutCost: r.parts_no_cost, boughtOutCents: Number(r.bought), crewCostCents: await crewCostCents(req.db, r.id),
      }, cr));
    }
    const counted = jobs.filter(j => j.profitCents !== null);
    const sum = (f: (j: P.JobProfit) => number) => counted.reduce((n, j) => n + f(j), 0);
    const revenue = sum(j => (j.noCharge ? 0 : j.revenueCents ?? 0)), cost = sum(j => j.costCents);
    return {
      from, to, rates: cr, ratesSet: !!(cr.labourCostPerHourCents && cr.vehicleCostPerKmCents),
      totals: { jobs: counted.length, notInvoiced: jobs.length - counted.length, revenueCents: revenue, costCents: cost, profitCents: revenue - cost, marginPct: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null },
      jobs, byClient: P.groupProfit(jobs, 'client'), byTechnician: P.groupProfit(jobs, 'technician'), byMonth: P.groupProfit(jobs, 'month'),
    };
  });
}
