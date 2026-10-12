// Brings ZSP's details over from Servcraft into a company in Real Sandbox: the company details and
// logo, the customers (name, account code, main contact, email, phone) and the staff (name, email,
// phone). Staff come in as technicians with their login switched off; HR or the CEO then sets each
// person's position and switches their login on. Running it again updates, it does not duplicate.
//
// Usage (on the server, with DATABASE_URL and UPLOAD_DIR set as for the app):
//   node --experimental-strip-types scripts/import-servcraft.ts --folder "C:\Real sandbox\servcraft-import" --creator fred@zsp.co.za [--dry-run]
// The folder holds company.json, customers.json, staff.json and zsp-logo.jpg.
import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { saveFile } from '../src/uploads.ts';

const { values: a } = parseArgs({ options: { folder: { type: 'string' }, creator: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
if (!a.folder || !a.creator) { console.error('usage: --folder <path> --creator <email of the company\'s Creator login> [--dry-run]'); process.exit(1); }
const read = (f: string) => JSON.parse(readFileSync(join(a.folder!, f), 'utf8'));
const company = read('company.json') as Record<string, string | number>;
const customers = read('customers.json') as { servcraftId: string; code: string; name: string; contact: string; email: string; phone: string }[];
const staff = read('staff.json') as { servcraftId: string; full_name: string; email: string; phone: string | null }[];

const clean = (s: string | null | undefined) => { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t && t !== '.' && t !== '. .' ? t.replace(/\s+\.$/, '') : null; };
const phone = (s: string | null | undefined) => { const d = (s ?? '').replace(/[^\d+]/g, ''); return d.length >= 9 ? d : null; };

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const c = await db.connect();
try {
  const login = (await c.query('SELECT user_id, company_id FROM logins WHERE email = lower($1)', [a.creator])).rows[0];
  if (!login) throw new Error(`no login ${a.creator}: create the company first (scripts/create-company.ts)`);
  await c.query("SELECT set_config('app.company_id', $1, false)", [login.company_id]);
  await c.query('BEGIN');

  // Company details and logo.
  let logoId: string | null = null;
  const logoFile = join(a.folder!, 'zsp-logo.jpg');
  const hasLogo = (await c.query('SELECT 1 FROM company_profile WHERE logo_photo_id IS NOT NULL')).rowCount;
  if (existsSync(logoFile) && !hasLogo) {
    logoId = randomUUID();
    const at = new Date().toISOString();
    const buffer = readFileSync(logoFile);
    const rel = a['dry-run'] ? 'dry-run' : await saveFile(login.company_id, logoId, { buffer, mimetype: 'image/jpeg' } as never, at);
    await c.query('INSERT INTO photos (id, kind, file_path, taken_at, taken_by, content_type, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [logoId, 'logo', rel, at, login.user_id, 'image/jpeg', buffer.length]);
  }
  await c.query(
    `INSERT INTO company_profile (legal_name, reg_no, vat_no, address, phone, email, vat_pct, logo_photo_id, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (company_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, reg_no = EXCLUDED.reg_no, vat_no = EXCLUDED.vat_no, address = EXCLUDED.address,
       phone = EXCLUDED.phone, email = EXCLUDED.email, vat_pct = EXCLUDED.vat_pct, logo_photo_id = COALESCE(EXCLUDED.logo_photo_id, company_profile.logo_photo_id),
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [company.legal_name, company.reg_no ?? null, company.vat_no ?? null, company.address ?? null, company.phone ?? null, company.email ?? null, company.vat_pct ?? 15, logoId, login.user_id]);

  // Customers.
  let newClients = 0, updatedClients = 0;
  for (const x of customers) {
    const name = clean(x.name);
    if (!name) continue;
    const r = await c.query(
      `INSERT INTO clients (name, account_code, contact_name, email, phone, imported_from) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, name) DO UPDATE SET account_code = EXCLUDED.account_code, contact_name = COALESCE(EXCLUDED.contact_name, clients.contact_name),
         email = COALESCE(EXCLUDED.email, clients.email), phone = COALESCE(EXCLUDED.phone, clients.phone), imported_from = EXCLUDED.imported_from
       RETURNING (xmax = 0) AS inserted`,
      [name, clean(x.code), clean(x.contact), clean(x.email)?.split(/[;,]\s*/)[0] ?? null, phone(x.phone), `servcraft:${x.servcraftId}`]);
    if (r.rows[0].inserted) newClients++; else updatedClients++;
  }

  // Staff: technicians with the login off, until HR or the CEO sets their position and switches it on.
  let newStaff = 0, knownStaff = 0;
  for (const x of staff) {
    const email = x.email?.trim().toLowerCase() || null;
    const known = email ? (await c.query('SELECT id FROM users WHERE lower(email) = $1', [email])).rows[0] : null;
    if (known) { knownStaff++; await c.query('UPDATE users SET phone = COALESCE(phone, $2) WHERE id = $1', [known.id, phone(x.phone)]); continue; }
    await c.query(`INSERT INTO users (full_name, email, phone, login_level, password_hash, login_enabled) VALUES ($1, $2, $3, 'technician', '!', false)`,
      [clean(x.full_name), email, phone(x.phone)]);
    newStaff++;
  }

  if (a['dry-run']) { await c.query('ROLLBACK'); console.log('dry run: nothing saved'); } else await c.query('COMMIT');
  console.log(`company details${logoId ? ' and logo' : ''} set; customers: ${newClients} new, ${updatedClients} updated; staff: ${newStaff} new, ${knownStaff} already there`);
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
