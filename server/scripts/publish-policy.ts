// Publishes a new version of the monitoring policy. Everyone must acknowledge it at their next login.
// Usage: node --experimental-strip-types scripts/publish-policy.ts --version 1.0 --file policy.md
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { migrate } from '../src/migrate.ts';

const { values: a } = parseArgs({ options: { version: { type: 'string' }, file: { type: 'string' } } });
if (!a.version || !a.file) { console.error('usage: --version 1.0 --file policy.md'); process.exit(1); }
const body = readFileSync(a.file, 'utf8').trim();
if (body.length < 200) { console.error('that file looks too short to be the policy'); process.exit(1); }

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(db);
await db.query('INSERT INTO policy_versions (version, body) VALUES ($1, $2)', [a.version, body]);
console.log(`published monitoring policy version ${a.version}; every user acknowledges it at next login`);
await db.end();
