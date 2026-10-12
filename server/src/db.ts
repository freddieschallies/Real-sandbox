import pg from 'pg';

export type Db = pg.Pool;
export type Client = pg.PoolClient;
/** Anything that can run a query: the pool, or one request's company-scoped connection. */
export type Q = Pick<pg.PoolClient, 'query'>;

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString, max: 20 });
}

/**
 * Each signed-in request runs on its own connection, inside one transaction, with the company
 * set for row-level security. tx() therefore just runs the work on that connection: the whole
 * request commits or rolls back together (see tenancy.ts).
 */
export async function tx<T>(c: Q, fn: (c: Q) => Promise<T>): Promise<T> {
  return fn(c);
}

export async function audit(c: Q, actorId: string | null, action: string, entity: string, entityId: string | null, details: object = {}) {
  await c.query(
    'INSERT INTO audit_log (actor_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
    [actorId, action, entity, entityId, JSON.stringify(details)],
  );
}

export async function raiseFlag(c: Q, f: {
  type: string; technicianId?: string | null; jobId?: string | null; vehicleId?: string | null;
  severity?: 'low' | 'normal' | 'high'; question?: string; details?: object;
}) {
  await c.query(
    `INSERT INTO flags (flag_type, severity, technician_id, job_id, vehicle_id, question, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [f.type, f.severity ?? 'normal', f.technicianId ?? null, f.jobId ?? null, f.vehicleId ?? null, f.question ?? null, JSON.stringify(f.details ?? {})],
  );
}
