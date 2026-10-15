// Pastel's guided set-up, for someone who is not a bookkeeper: give the app Pastel's lists (customers,
// suppliers, GL accounts, inventory items) and it matches the codes itself; confirm the few it is not sure
// of; check where labour, call-outs and travel go; the financial year and VAT; then a practice import
// that changes nothing. Done once; after that "Make Pastel batch" just works.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Q } from '../db.ts';
import { audit, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as P from '../core/pastel.ts';
import * as PS from '../core/pastelSetup.ts';
import { readSheet } from '../sheet.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { pastelSettings, waiting } from './pastel.ts';

const NEEDED = (books: boolean): PS.LineKey[] => ['labour', 'call_out', 'travel', 'bought_out', 'other', 'credit', ...(books ? ['purchases' as const] : [])];

export async function pastelSetupOf(c: Q, books: boolean) {
  const lists = new Map((await c.query('SELECT kind, entries, filename, uploaded_at FROM pastel_lists')).rows.map(r => [r.kind as PS.ListKind, r]));
  const entries = (k: PS.ListKind): PS.Entry[] => lists.get(k)?.entries ?? [];
  const row = (await c.query('SELECT setup_done_at, practice_note FROM pastel_settings')).rows[0] ?? null;
  const settings = await pastelSettings(c);
  const clients = (await c.query('SELECT c.id, c.name, c.pastel_code AS code FROM clients c ORDER BY c.name')).rows;
  const suppliers = books ? (await c.query("SELECT id, name, pastel_code AS code FROM suppliers WHERE status <> 'rejected' ORDER BY name")).rows : [];
  const items = (await c.query('SELECT id, code, description, pastel_code AS "pastelCode" FROM stock_items WHERE active ORDER BY code')).rows;
  const unchecked = (xs: { id: string; name: string; code: string | null }[]): PS.Match[] => xs.map(x => ({ id: x.id, name: x.name, current: x.code, code: x.code, codeName: null, how: x.code ? 'has' : 'none', score: 0 }));
  const customers = lists.has('customers') ? PS.matchNames(clients, entries('customers')) : unchecked(clients);
  const supp = lists.has('suppliers') ? PS.matchNames(suppliers, entries('suppliers')) : unchecked(suppliers);
  const stock = lists.has('items') ? PS.matchItems(items, entries('items')) : [];
  const need = NEEDED(books);
  const missingLines = need.filter(k => !settings.codes[k]?.code);
  const steps = [
    { key: 'customers', done: clients.length > 0 && clients.every(x => x.code) },
    ...(books ? [{ key: 'suppliers', done: suppliers.every(x => x.code) }] : []),
    { key: 'lines', done: !missingLines.length },
    { key: 'year', done: !!row },
    { key: 'items', done: !items.length || (lists.has('items') && !stock.some(m => m.how === 'sure' || m.how === 'check')) },
    { key: 'practice', done: !!row?.setup_done_at },
  ];
  const info = (k: PS.ListKind) => (lists.has(k) ? { count: entries(k).length, filename: lists.get(k).filename, uploadedAt: lists.get(k).uploaded_at } : null);
  return {
    steps, done: steps.every(s => s.done), books,
    lists: { customers: info('customers'), suppliers: books ? info('suppliers') : null, accounts: info('accounts'), items: info('items') },
    customers, suppliers: supp, items: stock, itemsTotal: items.length,
    pastel: { customers: entries('customers'), suppliers: books ? entries('suppliers') : [], accounts: entries('accounts'), items: entries('items') },
    lineNeed: need, lineNames: PS.LINE_NAME, suggest: PS.suggestLineCodes(entries('accounts'), entries('items')), missingLines,
    settings, vatNo: (await c.query('SELECT vat_no FROM company_profile')).rows[0]?.vat_no ?? null,
    setupDoneAt: row?.setup_done_at ?? null, practiceNote: row?.practice_note ?? null,
  };
}

export function registerPastelSetupRoutes(app: FastifyInstance) {
  const may = (req: FastifyRequest) => { if (!can(req.actor, 'prepare_quotes_invoices')) throw new Refused(403, ['Pastel is set up by Accounts or the CEO']); };
  const booksOf = (req: FastifyRequest) => can(req.actor, 'process_supplier_invoices');

  app.get('/pastel/setup', async req => { may(req); return pastelSetupOf(req.db, booksOf(req)); });

  // One of Pastel's lists (File → Import/Export in Pastel, or a listing report saved to Excel).
  app.post('/pastel/lists', async (req: FastifyRequest<{ Querystring: { kind?: string } }>) => {
    may(req);
    const kind = parse(z.enum(['customers', 'suppliers', 'accounts', 'items']), req.query.kind);
    if (kind === 'suppliers' && !booksOf(req)) throw new Refused(403, ['suppliers are for Accounts']);
    if (!req.isMultipart()) throw new Refused(400, ['send the file as a form upload']);
    const part = await req.file();
    if (!part) throw new Refused(400, ['no file']);
    const buf = await part.toBuffer();
    if (part.file.truncated) throw new Refused(400, ['the file is too large: export only that one list']);
    let rows: string[][];
    try { rows = readSheet(buf); } catch (e) { throw new Refused(400, [(e as Error).message]); }
    const entries = PS.readPastelList(rows);
    if (entries.length < 1) throw new Refused(400, ['no codes and names found in that file: in Pastel use File → Import/Export (or save the listing report to Excel), then try again']);
    if (entries.length > 20000) throw new Refused(400, ['more than 20 000 lines: is this the right file?']);
    await req.db.query(
      `INSERT INTO pastel_lists (kind, entries, filename, uploaded_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, kind) DO UPDATE SET entries = EXCLUDED.entries, filename = EXCLUDED.filename, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
      [kind, JSON.stringify(entries), part.filename ?? null, req.actor.id]);
    await audit(req.db, req.actor.id, 'pastel_list', 'company', null, { kind, count: entries.length });
    return pastelSetupOf(req.db, booksOf(req));
  });

  // The matches confirmed: many codes at once.
  app.post('/pastel/codes', async req => {
    may(req);
    const Pair = (max: number) => z.object({ id: Uuid, code: z.string().trim().max(max).nullable() });
    const b = parse(z.object({ clients: z.array(Pair(6)).max(5000).default([]), suppliers: z.array(Pair(6)).max(5000).default([]), items: z.array(Pair(15)).max(20000).default([]) }), req.body);
    if (b.suppliers.length && !booksOf(req)) throw new Refused(403, ['suppliers are for Accounts']);
    return tx(req.db, async c => {
      const clash = (xs: { id: string; code: string | null }[], what: string) => {
        const seen = new Map<string, string>();
        for (const x of xs) if (x.code) { const k = x.code.toUpperCase(); if (seen.has(k) && seen.get(k) !== x.id) throw new Refused(409, [`${x.code} is chosen for two ${what}`]); seen.set(k, x.id); }
      };
      clash(b.clients, 'customers'); clash(b.suppliers, 'suppliers');
      for (const x of b.clients) await c.query('UPDATE clients SET pastel_code = $2 WHERE id = $1', [x.id, x.code ? x.code.toUpperCase() : null]);
      for (const x of b.suppliers) await c.query('UPDATE suppliers SET pastel_code = $2 WHERE id = $1', [x.id, x.code ? x.code.toUpperCase() : null]);
      // An item's Pastel code: only kept when it differs from the stockroom code.
      for (const x of b.items) await c.query('UPDATE stock_items SET pastel_code = CASE WHEN upper($2) = upper(code) THEN NULL ELSE $2 END WHERE id = $1', [x.id, x.code]);
      // Two customers may not end up with one code (a code already used elsewhere).
      const dup = (await c.query('SELECT upper(pastel_code) AS code, string_agg(name, \' and \') AS names FROM clients WHERE pastel_code IS NOT NULL GROUP BY upper(pastel_code) HAVING count(*) > 1 LIMIT 1')).rows[0];
      if (dup) throw new Refused(409, [`${dup.code} would be ${dup.names}: each customer has its own Pastel code`]);
      await audit(c, req.actor.id, 'pastel_codes', 'company', null, { clients: b.clients.length, suppliers: b.suppliers.length, items: b.items.length });
      return pastelSetupOf(c, booksOf(req));
    });
  });

  // A practice file: one invoice, to import in Pastel and look at (then delete it there). Nothing changes here.
  app.post('/pastel/practice', async req => {
    may(req);
    const s = await pastelSettings(req.db);
    const vatPct = Number((await req.db.query('SELECT vat_pct FROM company_profile')).rows[0]?.vat_pct ?? 15);
    const ready = (await waiting(req.db, 'invoice')).filter(d => !P.missingForPastel(d, s).length);
    let doc: P.PastelDoc | undefined = ready.at(-1);
    if (!doc) {
      const cl = (await req.db.query('SELECT name, pastel_code FROM clients WHERE pastel_code IS NOT NULL ORDER BY name LIMIT 1')).rows[0];
      if (!cl) throw new Refused(409, ['match your customers to Pastel first (step 1)']);
      if (!s.codes.labour?.code) throw new Refused(409, ['say where labour goes in Pastel first']);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
      doc = { kind: 'invoice', number: 'TEST', customerCode: cl.pastel_code, date: today, dueDate: today, orderNumber: 'PRACTICE', message: 'Practice from Real Sandbox: delete this invoice',
        deliverTo: [cl.name], contact: null, lines: [{ kind: 'labour', description: 'Practice line: delete this invoice', qty: 1, unitPriceCents: 100 }] };
    }
    const problems = P.missingForPastel(doc, s);
    if (problems.length) throw new Refused(409, problems);
    return { filename: 'pastel-practice-invoice.csv', file: P.pastelFile([doc], s, vatPct), where: P.PASTEL_WHERE.invoice, customer: doc.customerCode, number: doc.number, real: doc.number !== 'TEST' };
  });

  // How the practice went: done, or what Pastel said (kept, so whoever helps can see it).
  app.post('/pastel/setup/done', async req => {
    may(req);
    const b = parse(z.object({ worked: z.boolean(), note: z.string().trim().max(1000).optional() }), req.body);
    await req.db.query(
      `INSERT INTO pastel_settings (updated_by, setup_done_at, practice_note) VALUES ($1, $2, $3)
       ON CONFLICT (company_id) DO UPDATE SET setup_done_at = EXCLUDED.setup_done_at, practice_note = EXCLUDED.practice_note`,
      [req.actor.id, b.worked ? new Date() : null, b.worked ? null : b.note ?? 'did not work']);
    await audit(req.db, req.actor.id, b.worked ? 'pastel_setup_done' : 'pastel_practice_failed', 'company', null, b);
    return pastelSetupOf(req.db, booksOf(req));
  });
}
