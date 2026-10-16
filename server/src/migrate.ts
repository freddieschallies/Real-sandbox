// Applies db/NNN_*.sql files that have not run yet, in order. Safe to run on every start.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DIR = fileURLToPath(new URL('../db/', import.meta.url));

export async function migrate(db: pg.Pool, log: (s: string) => void = () => {}) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  const files = readdirSync(DIR).filter(f => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    log(`applying ${f}`);
    await db.query(readFileSync(DIR + f, 'utf8'));
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
  }
  // Every table of company records is in the history, including ones added by later migrations.
  if ((await db.query("SELECT 1 FROM pg_proc WHERE proname = 'history_watch_all'")).rowCount) await db.query('SELECT history_watch_all()');
}

/**
 * The app itself connects as its own role, which can read and write data but is not a superuser
 * and cannot bypass row-level security. That is what makes company separation hold even if a
 * query in the app were wrong. Run with the owner connection; appUrl names the role and password.
 */
export async function ensureAppRole(owner: pg.Pool, appUrl: string) {
  const u = new URL(appUrl);
  const role = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  if (!/^[a-z_][a-z0-9_]{2,40}$/.test(role)) throw new Error('app database user must be a simple lower-case name');
  const ownerRole = (await owner.query('SELECT current_user AS r')).rows[0].r;
  if (role === ownerRole) throw new Error('the app must connect as its own database user, not the owner');
  const exists = (await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount;
  const pw = password ? (await owner.query('SELECT format(\'PASSWORD %L\', $1::text) AS p', [password])).rows[0].p : '';
  await owner.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE ${pw}`);
  const dbName = (await owner.query('SELECT current_database() AS d')).rows[0].d;
  await owner.query(`GRANT CONNECT ON DATABASE "${dbName}" TO ${role}`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await owner.query(`REVOKE ALL ON schema_migrations FROM ${role}`);
  // The history and the activity log: the app adds to them (the history only through the database's
  // own trigger) and reads them, but can never change or delete them.
  const has = async (t: string) => !!(await owner.query('SELECT to_regclass($1) AS r', [t])).rows[0].r;
  if (await has('public.history')) await owner.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON history, history_seals FROM ${role}`);
  await owner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${role}`);
  await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await owner.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
  if (await has('public.history')) await owner.query(`REVOKE ALL ON SEQUENCE history_id_seq FROM ${role}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const owner = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await migrate(owner, s => console.log(s));
  if (process.env.DATABASE_URL) await ensureAppRole(owner, process.env.DATABASE_URL);
  await owner.end();
  console.log('database up to date');
}
