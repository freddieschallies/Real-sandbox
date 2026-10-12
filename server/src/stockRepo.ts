// Stock held by technicians, per holding (van stock or a job), and using it on a job.
import type { Q } from './db.ts';
import * as S from './core/stock.ts';
import { Refused } from './http.ts';

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
}

export async function stockroomQty(c: Q, stockItemId: string): Promise<number> {
  const { rows } = await c.query('SELECT qty FROM stockroom_stock WHERE stock_item_id = $1', [stockItemId]);
  return Number(rows[0]?.qty ?? 0);
}
