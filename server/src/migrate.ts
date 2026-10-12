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
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(db, s => console.log(s));
  await db.end();
  console.log('database up to date');
}
