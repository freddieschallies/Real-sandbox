// How much space each company takes (its records in the database, its photos, documents and the PDFs the
// app made) and how the daily backup went, for the owner's dashboard (to work out what each company
// costs to keep) and the CEO's settings. Worked out at most once an hour.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Q } from './db.ts';
import { uploadRoot } from './uploads.ts';

export interface CompanyStorage { dbBytes: number; photoBytes: number; documentBytes: number; pdfBytes: number; files: number; totalBytes: number; measuredAt: string }
export interface BackupStatus {
  state: 'ok' | 'late' | 'failed' | 'none'; at: string | null; ageHours: number | null; dbBytes: number; localBytes: number; freeBytes: number; dumps: number;
  cloud: { configured: boolean; ok: boolean; bytes: number; lastOkAt: string | null; photos: boolean }; errors: string[];
}

const HOUR = 3_600_000;
const cache = new Map<string, CompanyStorage>();
let tables: string[] | null = null;

/** Every table of company records (those with a company_id), but the history's own copies are counted too. */
async function companyTables(c: Q): Promise<string[]> {
  if (tables) return tables;
  tables = (await c.query(
    `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND c.column_name = 'company_id' AND t.table_type = 'BASE TABLE'
        AND has_table_privilege('public.' || quote_ident(c.table_name), 'SELECT') ORDER BY 1`)).rows.map(r => r.table_name);
  return tables;
}

/** The company's records in the database (row-level security keeps it to the company set on the connection). */
async function dbBytes(c: Q): Promise<number> {
  let n = 0;
  for (const t of await companyTables(c)) {
    n += Number((await c.query(`SELECT coalesce(sum(pg_column_size(x.*)), 0)::bigint AS n FROM public."${t.replace(/"/g, '')}" x`)).rows[0].n);
  }
  return n;
}

const PHOTO = /\.(jpe?g|png|webp)$/i;
/** The company's files on the office server (its own folder of the uploads). */
async function filesOf(companyId: string) {
  const out = { photoBytes: 0, documentBytes: 0, pdfBytes: 0, files: 0 };
  const walk = async (dir: string): Promise<void> => {
    let list: import('node:fs').Dirent[];
    try { list = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.isFile()) continue;
      const size = (await stat(p).catch(() => null))?.size ?? 0;
      out.files++;
      if (/^export-.*\.pdf$/i.test(e.name)) out.pdfBytes += size;
      else if (PHOTO.test(e.name)) out.photoBytes += size;
      else out.documentBytes += size;
    }
  };
  if (/^[0-9a-f-]{36}$/i.test(companyId)) await walk(join(uploadRoot(), companyId));
  return out;
}

/** What a company takes now (worked out again after an hour, or when asked to). */
export async function storageOf(c: Q, companyId: string, fresh = false): Promise<CompanyStorage> {
  const had = cache.get(companyId);
  if (had && !fresh && Date.now() - Date.parse(had.measuredAt) < HOUR) return had;
  const db = await dbBytes(c);
  const f = await filesOf(companyId);
  const s = { dbBytes: db, ...f, totalBytes: db + f.photoBytes + f.documentBytes + f.pdfBytes, measuredAt: new Date().toISOString() };
  cache.set(companyId, s);
  return s;
}

/** How the last daily backup went (written by the backup service: deploy/backup/backup.sh). */
export async function backupStatus(file = process.env.BACKUP_STATUS): Promise<BackupStatus> {
  const none: BackupStatus = { state: 'none', at: null, ageHours: null, dbBytes: 0, localBytes: 0, freeBytes: 0, dumps: 0,
    cloud: { configured: false, ok: false, bytes: 0, lastOkAt: null, photos: true }, errors: [] };
  if (!file) return none;
  let j: any;
  try { j = JSON.parse(await readFile(file, 'utf8')); } catch { return none; }
  const at = j.finishedAt ?? j.startedAt ?? null;
  const ageHours = at ? Math.round(((Date.now() - Date.parse(at)) / HOUR) * 10) / 10 : null;
  const state = !j.ok ? 'failed' : ageHours !== null && ageHours > 30 ? 'late' : 'ok';
  return {
    state, at, ageHours, dbBytes: Number(j.database?.bytes ?? 0), localBytes: Number(j.local?.bytes ?? 0), freeBytes: Number(j.local?.freeBytes ?? 0), dumps: Number(j.local?.dumps ?? 0),
    cloud: { configured: !!j.cloud?.configured, ok: !!j.cloud?.ok, bytes: Number(j.cloud?.bytes ?? 0), lastOkAt: j.cloud?.lastOkAt ?? null, photos: j.cloud?.photos !== false },
    errors: Array.isArray(j.errors) ? j.errors.map(String) : [],
  };
}

/** A company's share of what the cloud copy takes: in proportion to what of it is sent (its records, documents and, if sent, photos). */
export function cloudShare(s: CompanyStorage, all: CompanyStorage[], b: BackupStatus): number {
  if (!b.cloud.configured || !b.cloud.bytes) return 0;
  const sent = (x: CompanyStorage) => x.dbBytes + x.documentBytes + (b.cloud.photos ? x.photoBytes : 0);
  const total = all.reduce((n, x) => n + sent(x), 0);
  return total ? Math.round(b.cloud.bytes * (sent(s) / total)) : 0;
}
