// Each client's own rates and parts mark-up (set by the CEO and Accounts, beside the client's Pastel
// code), and what a job's invoice is priced with: the client's, or the company's when it has none.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Q } from '../db.ts';
import { audit, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as R from '../core/clientRates.ts';
import type { Visit } from '../core/jobCard.ts';
import { Refused, Uuid, parse } from '../http.ts';

export async function companyRates(c: Q): Promise<Record<string, number>> {
  const { rows } = await c.query('SELECT key, amount_cents FROM rates');
  return Object.fromEntries(rows.map(r => [r.key, Number(r.amount_cents)]));
}

export async function clientRatesOf(c: Q, clientId: string): Promise<R.ClientRates | null> {
  const r = (await c.query('SELECT rates, markup FROM client_rates WHERE client_id = $1', [clientId])).rows[0];
  return r ? { rates: r.rates, markup: r.markup } : null;
}

/** How a job's invoice is priced: its client's own rates, or the company's. */
export async function priceRulesForJob(c: Q, jobId: string): Promise<R.PriceRules> {
  const client = (await c.query('SELECT s.client_id FROM jobs j JOIN stores s ON s.id = j.store_id WHERE j.id = $1', [jobId])).rows[0]?.client_id;
  return R.priceRules(await companyRates(c), client ? await clientRatesOf(c, client) : null);
}

/**
 * Driving for a job, there and back, every visit to the site: minutes from Go to Arrived (twice),
 * and km from the tracker's trips; until the tracker gives trips, estimated from the workshop to the
 * store by road (about a quarter more than a straight line), twice.
 */
export async function travelForJob(c: Q, jobId: string, card: { visits: Visit[] }): Promise<{ km: number; minutes: number; kmEstimated: boolean } | null> {
  const visits = card.visits.filter(v => v.place !== 'workshop' && v.goAt && v.arrivedAt);
  if (!visits.length) return null;
  const minutes = visits.reduce((n, v) => n + Math.max(0, (Date.parse(v.arrivedAt!) - Date.parse(v.goAt!)) / 60_000), 0) * 2;
  const tracked = Number((await c.query(
    'SELECT coalesce(sum(t.distance_km), 0) AS km FROM trips t JOIN job_visits v ON v.id = t.job_visit_id WHERE v.job_id = $1', [jobId])).rows[0].km);
  if (tracked > 0) return { km: tracked * 2, minutes: Math.round(minutes), kmEstimated: false };
  const w = (await c.query('SELECT lat, lng FROM company_workshop')).rows[0];
  const s = (await c.query('SELECT s.lat, s.lng FROM jobs j JOIN stores s ON s.id = j.store_id WHERE j.id = $1', [jobId])).rows[0];
  const km = w?.lat != null && s?.lat != null ? R.kmBetween({ lat: w.lat, lng: w.lng }, { lat: s.lat, lng: s.lng }) * R.ROAD_FACTOR * 2 * visits.length : 0;
  return { km: Math.round(km), minutes: Math.round(minutes), kmEstimated: true };
}

const Setting = z.object({ on: z.boolean(), cents: z.number().int().min(0).max(100_000_000) });
const Band = z.object({ upToCents: z.number().int().min(1).max(1_000_000_000).nullable(), pct: z.number().min(0).max(1000) });
const RatesIn = z.object({
  rates: z.object({ labour_per_hour: Setting, call_out: Setting, travel_per_km: Setting, travel_per_hour: Setting }),
  markup: z.object({ on: z.boolean(), bands: z.array(Band).length(3) }),
});

export function registerClientRateRoutes(app: FastifyInstance) {
  const sees = (req: FastifyRequest) => {
    if (!can(req.actor, 'set_client_rates') && !can(req.actor, 'prepare_quotes_invoices')) throw new Refused(403, ["clients' rates are for the CEO and Accounts"]);
  };
  const sets = (req: FastifyRequest) => {
    if (!can(req.actor, 'set_client_rates')) throw new Refused(403, ["only the CEO and Accounts set a client's rates and mark-up"]);
  };

  app.get('/office/clients/:id/rates', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    sees(req);
    const id = parse(Uuid, req.params.id);
    const cl = (await req.db.query('SELECT id, name, pastel_code FROM clients WHERE id = $1', [id])).rows[0];
    if (!cl) throw new Refused(404, ['no such client']);
    const company = await companyRates(req.db);
    const own = await clientRatesOf(req.db, id);
    const by = own ? (await req.db.query('SELECT u.full_name, r.updated_at FROM client_rates r JOIN users u ON u.id = r.updated_by WHERE r.client_id = $1', [id])).rows[0] : null;
    return {
      client: cl, own: !!own, rates: own ?? R.startingRates(company), company, canEdit: can(req.actor, 'set_client_rates'),
      labels: R.CLIENT_RATE_LABEL, updatedBy: by?.full_name ?? null, updatedAt: by?.updated_at ?? null,
    };
  });

  app.put('/office/clients/:id/rates', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    sets(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(RatesIn, req.body) as R.ClientRates;
    const problems = R.ratesProblems(b);
    if (problems.length) throw new Refused(400, problems);
    return tx(req.db, async c => {
      if (!(await c.query('SELECT 1 FROM clients WHERE id = $1', [id])).rowCount) throw new Refused(404, ['no such client']);
      const before = await clientRatesOf(c, id);
      await c.query(
        `INSERT INTO client_rates (client_id, rates, markup, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (client_id) DO UPDATE SET rates = EXCLUDED.rates, markup = EXCLUDED.markup, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [id, JSON.stringify(b.rates), JSON.stringify(b.markup), req.actor.id]);
      await audit(c, req.actor.id, 'client_rates_set', 'client', id, { before, after: b });
      return { id, own: true, rates: b };
    });
  });

  // Back to the company's rates.
  app.delete('/office/clients/:id/rates', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    sets(req);
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const before = await clientRatesOf(c, id);
      if (!before) throw new Refused(409, ['this client already uses the company rates']);
      await c.query('DELETE FROM client_rates WHERE client_id = $1', [id]);
      await audit(c, req.actor.id, 'client_rates_removed', 'client', id, { before });
      return { id, own: false };
    });
  });
}
