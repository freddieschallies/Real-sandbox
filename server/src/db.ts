import pg from 'pg';

export type Db = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString, max: 10 });
}

/** Run fn inside one transaction; rolls back on any error. */
export async function tx<T>(db: Db, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function audit(c: Client | Db, actorId: string | null, action: string, entity: string, entityId: string | null, details: object = {}) {
  await c.query(
    'INSERT INTO audit_log (actor_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
    [actorId, action, entity, entityId, JSON.stringify(details)],
  );
}

export async function raiseFlag(c: Client, f: {
  type: string; technicianId?: string | null; jobId?: string | null; vehicleId?: string | null;
  severity?: 'low' | 'normal' | 'high'; question?: string; details?: object;
}) {
  await c.query(
    `INSERT INTO flags (flag_type, severity, technician_id, job_id, vehicle_id, question, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [f.type, f.severity ?? 'normal', f.technicianId ?? null, f.jobId ?? null, f.vehicleId ?? null, f.question ?? null, JSON.stringify(f.details ?? {})],
  );
}
