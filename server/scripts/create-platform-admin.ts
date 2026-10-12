// Creates a platform owner login (the business that sells the app). Platform owners create and
// suspend companies; they cannot see any company's data.
// Usage: node --experimental-strip-types scripts/create-platform-admin.ts --name "Fred Schallies" --email fred@example.co.za
// Password is asked for (hidden), or read from NEW_USER_PASSWORD.
import { parseArgs } from 'node:util';
import pg from 'pg';
import { hashPassword } from '../src/auth.ts';
import { migrate } from '../src/migrate.ts';
import { askHidden } from './prompt.ts';

const { values: a } = parseArgs({ options: { name: { type: 'string' }, email: { type: 'string' } } });
if (!a.name || !a.email) { console.error('usage: --name "Full Name" --email a@b.co.za'); process.exit(1); }
const password = process.env.NEW_USER_PASSWORD ?? await askHidden('Password (min 12 characters): ');
if (password.length < 12) { console.error('platform passwords must be at least 12 characters'); process.exit(1); }

const db = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
await migrate(db);
await db.query('INSERT INTO platform_admins (full_name, email, password_hash) VALUES ($1, lower($2), $3)', [a.name, a.email, await hashPassword(password)]);
console.log(`created platform owner login for ${a.name}`);
await db.end();
