// Bringing in a company's customers and their sites from a spreadsheet (a CSV or Excel export from
// Servcraft or anything else). Step 1: upload; the server reads it and guesses which column is which.
// Step 2: the office checks the columns (and the preview) and imports. New sites are then found on
// the map in the background; a pin given in the file is used as it is.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import { FIELDS, guessMapping, splitHeader, toCustomers, type Mapping } from '../core/customerSheet.ts';
import { readSheet } from '../sheet.ts';
import { Refused, Uuid, parse } from '../http.ts';

const MAX_ROWS = 5000;

export function registerCustomerImportRoutes(app: FastifyInstance) {
  const may = (req: FastifyRequest) => { if (!can(req.actor, 'manage_stores_equipment')) throw new Refused(403, ['bringing in customers is for whoever looks after clients and stores']); };

  app.post('/office/customers/import', async req => {
    may(req);
    if (!req.isMultipart()) throw new Refused(400, ['send the file as a form upload']);
    const part = await req.file();
    if (!part) throw new Refused(400, ['no file']);
    const buf = await part.toBuffer();
    if (part.file.truncated) throw new Refused(400, ['the file is larger than 4 MB: save only the customer list (one sheet) and try again']);
    let all: string[][];
    try { all = readSheet(buf); } catch (e) { throw new Refused(400, [(e as Error).message]); }
    if (all.length < 2) throw new Refused(400, ['the file has no rows: export the customer list with its headings']);
    const { headers, body } = splitHeader(all);
    if (body.length > MAX_ROWS) throw new Refused(400, [`${body.length} rows: up to ${MAX_ROWS} at a time`]);
    const guess = guessMapping(headers);
    const row = (await req.db.query('INSERT INTO customer_imports (filename, headers, rows, uploaded_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [part.filename ?? null, JSON.stringify(headers), JSON.stringify(body), req.actor.id])).rows[0];
    return { id: row.id, filename: part.filename ?? null, headers, rows: body.length, guess, fields: FIELDS, samples: headers.map((_, i) => body.slice(0, 3).map(r => r[i] ?? '').filter(Boolean)) };
  });

  // Which column holds what (only some of the fields; at least the customer).
  const MappingIn = z.record(z.string(), z.number().int().min(0).max(500))
    .refine(m => Object.keys(m).every(k => k in FIELDS), 'unknown field').refine(m => m.client !== undefined, 'say which column is the customer');

  // What the import would do, before it is done: new and existing customers and sites, and the first rows.
  app.post('/office/customers/import/:id/preview', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    may(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ mapping: MappingIn }), req.body);
    const imp = (await req.db.query('SELECT rows, applied_at FROM customer_imports WHERE id = $1', [id])).rows[0];
    if (!imp) throw new Refused(404, ['no such upload']);
    const { rows, skipped } = toCustomers(imp.rows, b.mapping as Mapping);
    const known = new Set((await req.db.query('SELECT lower(c.name) || \'|\' || lower(s.name) AS k FROM stores s JOIN clients c ON c.id = s.client_id')).rows.map(r => r.k));
    const knownClients = new Set((await req.db.query('SELECT lower(name) AS n FROM clients')).rows.map(r => r.n));
    const clients = new Set(rows.map(r => r.client.toLowerCase()));
    return {
      customers: clients.size, newCustomers: [...clients].filter(c => !knownClients.has(c)).length,
      sites: rows.length, newSites: rows.filter(r => !known.has(`${r.client.toLowerCase()}|${r.store.toLowerCase()}`)).length,
      withAddress: rows.filter(r => r.address).length, withPin: rows.filter(r => r.lat !== null).length,
      skipped, preview: rows.slice(0, 8), applied: !!imp.applied_at,
    };
  });

  app.post('/office/customers/import/:id/apply', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    may(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ mapping: MappingIn }), req.body);
    return tx(req.db, async c => {
      const imp = (await c.query('SELECT rows, applied_at FROM customer_imports WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!imp) throw new Refused(404, ['no such upload']);
      if (imp.applied_at) throw new Refused(409, ['this file was already brought in']);
      const { rows, skipped } = toCustomers(imp.rows, b.mapping as Mapping);
      const r = { customersNew: 0, customersUpdated: 0, sitesNew: 0, sitesUpdated: 0, toFind: 0, pinnedFromFile: 0, skipped };
      const clientIds = new Map<string, string>();
      for (const x of rows) {
        const key = x.client.toLowerCase();
        let cid = clientIds.get(key);
        if (!cid) {
          const found = (await c.query('SELECT id FROM clients WHERE lower(name) = $1 OR ($2::text IS NOT NULL AND account_code = $2) ORDER BY (lower(name) = $1) DESC LIMIT 1', [key, x.accountCode])).rows[0];
          if (found) {
            await c.query('UPDATE clients SET account_code = COALESCE(account_code, $2), contact_name = COALESCE(contact_name, $3), email = COALESCE(email, $4), phone = COALESCE(phone, $5) WHERE id = $1',
              [found.id, x.accountCode, x.contact, x.email, x.phone]);
            cid = found.id as string; r.customersUpdated++;
          } else {
            cid = (await c.query('INSERT INTO clients (name, account_code, contact_name, email, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id',
              [x.client, x.accountCode, x.contact, x.email, x.phone])).rows[0].id as string;
            r.customersNew++;
          }
          clientIds.set(key, cid);
        }
        const s = (await c.query('SELECT id, address, pin_source FROM stores WHERE client_id = $1 AND lower(name) = lower($2)', [cid, x.store])).rows[0];
        const pin = x.lat !== null;
        if (!s) {
          await c.query(
            `INSERT INTO stores (client_id, name, branch_code, address, email, phone, lat, lng, pin_source, pin_status, pin_note, pin_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $7::float IS NULL THEN NULL ELSE now() END)`,
            [cid, x.store, x.branchCode, x.address, x.email, x.phone, x.lat, x.lng, pin ? 'import' : 'none', pin ? 'ok' : 'looking', pin ? 'From the imported file' : null]);
          r.sitesNew++;
        } else {
          // Known site: fill in what was missing; a changed address is looked up again (not a pin set by hand).
          const moved = !!x.address && x.address !== s.address;
          await c.query(
            `UPDATE stores SET branch_code = COALESCE(branch_code, $2), address = COALESCE($3, address), email = COALESCE(email, $4), phone = COALESCE(phone, $5) WHERE id = $1`,
            [s.id, x.branchCode, x.address, x.email, x.phone]);
          if (pin && s.pin_source !== 'manual') await c.query("UPDATE stores SET lat = $2, lng = $3, pin_source = 'import', pin_status = 'ok', pin_note = 'From the imported file', pin_at = now() WHERE id = $1", [s.id, x.lat, x.lng]);
          else if (moved && s.pin_source !== 'manual') await c.query("UPDATE stores SET pin_status = 'looking', lookup_tries = 0, pin_note = 'New address from the import: looking it up' WHERE id = $1", [s.id]);
          r.sitesUpdated++;
        }
        if (pin) r.pinnedFromFile++;
      }
      r.toFind = Number((await c.query("SELECT count(*) AS n FROM stores WHERE pin_status = 'looking'")).rows[0].n);
      await c.query('UPDATE customer_imports SET applied_at = now(), applied_by = $2, result = $3 WHERE id = $1', [id, req.actor.id, JSON.stringify({ ...r, skipped: skipped.length })]);
      await audit(c, req.actor.id, 'customers_imported', 'customer_import', id, { ...r, skipped: skipped.length });
      return r;
    });
  });
}
