// Removes vehicle photos that are past their keeping time (core/retention.ts). Company by company,
// once a day. Only the file goes; the photo row stays, marked as removed and why.
import type { Db } from './db.ts';
import { removeFile } from './uploads.ts';
import * as R from './core/retention.ts';

export async function purgeOldPhotos(db: Db, now = new Date()): Promise<number> {
  let total = 0;
  const companies = (await db.query('SELECT id FROM companies WHERE active')).rows;
  for (const co of companies) {
    const client = await db.connect();
    try {
      await client.query("SELECT set_config('app.company_id', $1, false)", [co.id]);
      await client.query('BEGIN');
      const { rows } = await client.query(
        `WITH latest AS (
           SELECT DISTINCT ON (vehicle_id) photo_ids, driver_signature_id, handover_signature_id
             FROM vehicle_inspections ORDER BY vehicle_id, inspected_at DESC),
         keep_now AS (
           SELECT unnest(photo_ids) AS id FROM latest UNION SELECT driver_signature_id FROM latest UNION SELECT handover_signature_id FROM latest),
         evidence AS (
           SELECT unnest(photo_ids) AS id FROM vehicle_faults
           UNION SELECT unnest(photo_ids) FROM vehicle_inspections WHERE cardinality(new_problems) > 0
           UNION SELECT driver_signature_id FROM vehicle_inspections
           UNION SELECT handover_signature_id FROM vehicle_inspections
           UNION SELECT unnest(photo_ids) FROM daily_checks WHERE 'problem' IN (oil, water, tyres))
         SELECT p.id, p.file_path,
                CASE WHEN p.kind::text = ANY($3) OR p.id IN (SELECT id FROM evidence WHERE id IS NOT NULL) THEN 'evidence' ELSE 'routine' END AS rule
           FROM photos p
          WHERE p.purged_at IS NULL
            AND p.id NOT IN (SELECT id FROM keep_now WHERE id IS NOT NULL)
            AND (
              ((p.kind::text = ANY($3) OR p.id IN (SELECT id FROM evidence WHERE id IS NOT NULL)) AND p.taken_at < $1::timestamptz - make_interval(years => $4))
              OR (p.kind::text = ANY($2) AND p.id NOT IN (SELECT id FROM evidence WHERE id IS NOT NULL) AND p.taken_at < $1::timestamptz - make_interval(days => $5))
            )
          FOR UPDATE OF p`,
        [now.toISOString(), [...R.ROUTINE_KINDS], [...R.EVIDENCE_KINDS], R.FAULT_PHOTO_YEARS, R.ROUTINE_INSPECTION_DAYS]);
      for (const p of rows) {
        const reason = p.rule === 'evidence' ? `kept ${R.FAULT_PHOTO_YEARS} years (fault or damage evidence), then removed`
          : `routine inspection photo, removed after ${R.ROUTINE_INSPECTION_DAYS} days`;
        await client.query('UPDATE photos SET purged_at = $2, purge_reason = $3 WHERE id = $1', [p.id, now.toISOString(), reason]);
      }
      await client.query('COMMIT');
      // Files go only once the database says so; a file left behind is harmless, a missing one is not.
      for (const p of rows) await removeFile(p.file_path);
      total += rows.length;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      await client.query("SELECT set_config('app.company_id', '', false)").catch(() => {});
      client.release();
    }
  }
  return total;
}
