// Publishes a new version of a company's monitoring policy. Its users acknowledge it at next login.
// Usage: node --experimental-strip-types scripts/publish-policy.ts --company "ZSP" --version 1.0 --file policy.md
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const { values: a } = parseArgs({ options: { company: { type: 'string' }, version: { type: 'string' }, file: { type: 'string' } } });
if (!a.company || !a.version || !a.file) { console.error('usage: --company "Name" --version 1.0 --file policy.md'); process.exit(1); }
const body = readFileSync(a.file, 'utf8').trim();
if (body.length < 200) { console.error('that file looks too short to be the policy'); process.exit(1); }

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const c = (await db.query('SELECT id FROM companies WHERE lower(name) = lower($1)', [a.company])).rows[0];
if (!c) { console.error('no such company'); process.exit(1); }
await db.query("SELECT set_config('app.company_id', $1, false)", [c.id]);
await db.query('INSERT INTO policy_versions (version, body) VALUES ($1, $2)', [a.version, body]);
console.log(`published "${a.company}" monitoring policy version ${a.version}; its users acknowledge it at next login`);
await db.end();
