// Creates a company and its first Creator login (the same as the platform owner's screen does).
// Usage: node --experimental-strip-types scripts/create-company.ts --company "ZSP" --name "Fred Schallies" --email fred@zsp.co.za
// Password is asked for (hidden), or read from NEW_USER_PASSWORD.
import { parseArgs } from 'node:util';
import pg from 'pg';
import { ensureAppRole, migrate } from '../src/migrate.ts';
import { createCompany } from '../src/routes/platform.ts';
import { askHidden } from './prompt.ts';

const { values: a } = parseArgs({ options: { company: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } } });
if (!a.company || !a.name || !a.email) { console.error('usage: --company "Name" --name "Creator Name" --email a@b.co.za'); process.exit(1); }
const password = process.env.NEW_USER_PASSWORD ?? await askHidden('Creator password (min 10 characters): ');
if (password.length < 10) { console.error('password must be at least 10 characters'); process.exit(1); }

const owner = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
await migrate(owner);
await ensureAppRole(owner, process.env.DATABASE_URL ?? '');
await owner.end();
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const r = await createCompany(app, a.company, { name: a.name, email: a.email, password });
console.log(`created company "${a.company}" (${r.companyId}) with Creator ${a.name}`);
await app.end();
