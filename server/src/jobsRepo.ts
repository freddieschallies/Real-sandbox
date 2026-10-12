// Loads a job card from the database into the rules engine's shape.
import type { Client } from './db.ts';
import type { JobCard, Visit, WorkItem } from './core/jobCard.ts';

export interface JobRow {
  id: string;
  job_number: number;
  status: JobCard['status'];
  job_type: JobCard['jobType'];
  lead_technician_id: string;
  store_id: string;
}

export async function loadCard(c: Client, jobId: string, forUpdate = false): Promise<{ row: JobRow; card: JobCard; visitIds: string[] } | null> {
  const j = await c.query(
    `SELECT j.id, j.job_number, j.status, j.job_type, j.lead_technician_id, j.store_id, j.closed_at,
            s.lat, s.lng, s.geofence_m
       FROM jobs j JOIN stores s ON s.id = j.store_id
      WHERE j.id = $1 ${forUpdate ? 'FOR UPDATE OF j' : ''}`,
    [jobId],
  );
  const r = j.rows[0];
  if (!r) return null;

  const v = await c.query(
    `SELECT id, state, go_at, arrived_at, checked_in_manager, safety_check, started_at, ended_at
       FROM job_visits WHERE job_id = $1 ORDER BY go_at`,
    [jobId],
  );
  const p = await c.query(
    `SELECT p.visit_id, p.reason, p.paused_at, p.resumed_at
       FROM visit_pauses p JOIN job_visits v ON v.id = p.visit_id
      WHERE v.job_id = $1 ORDER BY p.paused_at`,
    [jobId],
  );
  const iso = (d: Date | null) => (d ? d.toISOString() : undefined);
  const visits: Visit[] = v.rows.map(x => ({
    state: x.state,
    goAt: iso(x.go_at),
    arrivedAt: iso(x.arrived_at),
    checkedInManager: x.checked_in_manager ?? undefined,
    safetyCheck: x.safety_check ?? undefined,
    startedAt: iso(x.started_at),
    endedAt: iso(x.ended_at),
    pauses: p.rows.filter(q => q.visit_id === x.id).map(q => ({ reason: q.reason, at: q.paused_at.toISOString(), resumedAt: iso(q.resumed_at) })),
  }));

  const i = await c.query(
    `SELECT w.id, w.title, w.origin, w.equipment_id, w.fault_type, w.found_text, w.did_text, w.no_materials,
            w.tested, w.outcome, w.still_needed,
            (SELECT count(*) FROM photos ph WHERE ph.work_item_id = w.id AND ph.kind = 'before')::int AS before_photos,
            (SELECT count(*) FROM photos ph WHERE ph.work_item_id = w.id AND ph.kind = 'after')::int AS after_photos,
            (SELECT count(*) FROM stock_movements m WHERE m.work_item_id = w.id AND m.kind = 'use_on_job')::int AS van_lines,
            (SELECT count(*) FROM bought_out_items b WHERE b.work_item_id = w.id)::int AS bought_lines
       FROM work_items w WHERE w.job_id = $1 ORDER BY w.created_at`,
    [jobId],
  );
  const items: WorkItem[] = i.rows.map(x => ({
    id: x.id,
    title: x.title,
    origin: x.origin,
    equipmentId: x.equipment_id ?? undefined,
    faultType: x.fault_type ?? undefined,
    found: x.found_text ?? undefined,
    did: x.did_text ?? undefined,
    noMaterials: x.no_materials,
    tested: x.tested ?? undefined,
    outcome: x.outcome ?? undefined,
    stillNeeded: x.still_needed ?? undefined,
    beforePhotos: x.before_photos,
    afterPhotos: x.after_photos,
    vanStockLines: x.van_lines,
    boughtOutLines: x.bought_lines,
  }));

  const chk = await c.query(
    'SELECT count(*)::int AS n, count(*) FILTER (WHERE done)::int AS d FROM planned_maintenance_checks WHERE job_id = $1',
    [jobId],
  );

  const card: JobCard = {
    jobType: r.job_type,
    status: r.status,
    store: { lat: r.lat, lng: r.lng, geofenceM: r.geofence_m },
    items,
    visits,
    maintenanceChecklistDone: chk.rows[0].n > 0 && chk.rows[0].n === chk.rows[0].d,
    closedAt: iso(r.closed_at),
  };
  return { row: r, card, visitIds: v.rows.map(x => x.id) };
}

/** Lead technician or a helper on the job. */
export async function isOnJob(c: Client, jobId: string, userId: string): Promise<boolean> {
  const { rows } = await c.query(
    `SELECT EXISTS (SELECT 1 FROM jobs WHERE id = $1 AND lead_technician_id = $2)
         OR EXISTS (SELECT 1 FROM job_helpers WHERE job_id = $1 AND user_id = $2) AS ok`,
    [jobId, userId],
  );
  return rows[0].ok;
}
