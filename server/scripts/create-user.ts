// Creates a login. The first one on a new server should be the Creator.
// Usage (on the server):
//   docker compose exec api node --experimental-strip-types scripts/create-user.ts \
//     --name "Fred Schallies" --email fred@example.co.za --level creator [--department "Refrigeration"]
// The password is asked for and never shown, or read from NEW_USER_PASSWORD when set.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import pg from 'pg';
import { hashPassword } from '../src/auth.ts';
import { migrate } from '../src/migrate.ts';

const LEVELS = ['technician', 'admin', 'stockroom', 'management', 'director', 'creator'];
const { values: a } = parseArgs({ options: { name: { type: 'string' }, email: { type: 'string' }, level: { type: 'string' }, department: { type: 'string' } } });
if (!a.name || !a.email || !a.level || !LEVELS.includes(a.level)) {
  console.error(`usage: --name "Full Name" --email a@b.co.za --level ${LEVELS.join('|')} [--department "Name"]`);
  process.exit(1);
}

async function askHidden(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  out._writeToOutput = (s: string) => { if (s.startsWith(q)) out.output.write(q); };
  const ans = await new Promise<string>(r => rl.question(q, r));
  rl.close();
  process.stdout.write('\n');
  return ans;
}

const password = process.env.NEW_USER_PASSWORD ?? await askHidden('Password (min 10 characters): ');
if (password.length < 10) { console.error('password must be at least 10 characters'); process.exit(1); }

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(db);
let deptId: string | null = null;
if (a.department) {
  deptId = (await db.query('INSERT INTO departments (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id', [a.department])).rows[0].id;
}
const { rows } = await db.query(
  'INSERT INTO users (full_name, email, login_level, department_id, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id',
  [a.name, a.email, a.level, deptId, await hashPassword(password)],
);
await db.query("INSERT INTO audit_log (action, entity, entity_id, details) VALUES ('user_created_by_script', 'user', $1, $2)", [rows[0].id, JSON.stringify({ level: a.level })]);
console.log(`created ${a.level} login for ${a.name} (${a.email})`);
await db.end();
