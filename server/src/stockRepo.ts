// Stock held by technicians, per holding (van stock or a job), and using it on a job.
import type { Q } from './db.ts';
import * as S from './core/stock.ts';
import { Refused } from './http.ts';
import { checkVan } from './vanRepo.ts';

/** His holdings of one item, with what is already on its way back to the stockroom. */
export async function holdingsOf(c: Q, technicianId: string, stockItemId: string): Promise<S.Holding[]> {
  const { rows } = await c.query(
    `SELECT h.holding_job_id, h.qty, COALESCE(p.qty, 0) AS pending
       FROM technician_holdings h
       LEFT JOIN pending_returns p ON p.technician_id = h.technician_id AND p.stock_item_id = h.stock_item_id
            AND p.holding_job_id IS NOT DISTINCT FROM h.holding_job_id
      WHERE h.technician_id = $1 AND h.stock_item_id = $2`,
    [technicianId, stockItemId],
  );
  return rows.map(r => ({ holdingJobId: r.holding_job_id, qty: Number(r.qty), pendingReturn: Number(r.pending) }));
}

/** Uses stock on a job card: booked-for-this-job first, then van stock, then his other jobs' stock. */
export async function useOnJob(c: Q, technicianId: string, stockItemId: string, qty: number, jobId: string, workItemId: string) {
  // One technician's stock is changed by one request at a time.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`stock:${technicianId}`]);
  const plan = S.drawPlan(await holdingsOf(c, technicianId, stockItemId), qty, jobId);
  if (!plan.ok) throw new Refused(409, [`only ${plan.have} on your name; book it out from the stockroom, or add it under Bought out if you bought it`]);
  for (const t of plan.take) {
    await c.query(
      `INSERT INTO stock_movements (stock_item_id, qty, kind, from_technician_id, holding_job_id, job_id, work_item_id, created_by)
       VALUES ($1, $2, 'use_on_job', $3, $4, $5, $6, $3)`,
      [stockItemId, t.qty, technicianId, t.holdingJobId, jobId, workItemId],
    );
  }
  // Van stock used: is his van still complete against his department's list?
  if (plan.take.some(t => t.holdingJobId === null)) await checkVan(c, technicianId, technicianId);
}

export async function stockroomQty(c: Q, stockItemId: string): Promise<number> {
  const { rows } = await c.query('SELECT qty FROM stockroom_stock WHERE stock_item_id = $1', [stockItemId]);
  return Number(rows[0]?.qty ?? 0);
}

/** How much of an item is in the mechanic's workshop. */
export async function workshopQty(c: Q, stockItemId: string): Promise<number> {
  const { rows } = await c.query('SELECT qty FROM workshop_stock WHERE stock_item_id = $1', [stockItemId]);
  return Number(rows[0]?.qty ?? 0);
}

/**
 * Takes stock out of the workshop for a mechanic job card or a daily check. Counted items must be
 * there; poured items (oil) are taken even if the system shows less, since the top-up was needed,
 * and the shortfall is returned so the mechanic is told to count the drum.
 */
export async function useFromWorkshop(c: Q, o: { stockItemId: string; qty: number; by: string; fleetJobPartId?: string; dailyCheckId?: string; note?: string }) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['workshop']);
  const item = (await c.query('SELECT description, unit, measured FROM stock_items WHERE id = $1', [o.stockItemId])).rows[0];
  if (!item) throw new Refused(404, ['no such stock item']);
  const have = await workshopQty(c, o.stockItemId);
  if (!item.measured && have < o.qty) throw new Refused(409, [`only ${have} ${item.unit} of ${item.description} in the workshop`]);
  await c.query(
    `INSERT INTO stock_movements (stock_item_id, qty, kind, from_workshop, fleet_job_part_id, daily_check_id, note, created_by)
     VALUES ($1, $2, 'use_on_fleet', true, $3, $4, $5, $6)`,
    [o.stockItemId, o.qty, o.fleetJobPartId ?? null, o.dailyCheckId ?? null, o.note ?? null, o.by]);
  return { left: Math.round((have - o.qty) * 100) / 100, short: have < o.qty, item };
}
