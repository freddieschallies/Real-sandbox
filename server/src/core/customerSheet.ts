// A company's customer list (exported from Servcraft, Excel, anything): which column is which, and
// each row as a customer with a site and its address. Every company's export looks different, so the
// columns are guessed from their headings and the office checks the guess before anything is saved.

export const FIELDS = {
  client: 'Customer', store: 'Site / store', address: 'Address', address2: 'Address line 2', suburb: 'Suburb', city: 'Town / city',
  province: 'Province', postal: 'Postal code', branchCode: 'Branch / store code', accountCode: 'Account code', contact: 'Contact person',
  phone: 'Phone', email: 'Email', lat: 'Latitude', lng: 'Longitude',
} as const;
export type Field = keyof typeof FIELDS;
export type Mapping = Partial<Record<Field, number>>;

const GUESS: [Field, RegExp][] = [
  ['lat', /^(lat|latitude|gps ?lat|y)$/i],
  ['lng', /^(lng|lon|long|longitude|gps ?(lng|lon|long)|x)$/i],
  ['accountCode', /^(code|account ?(code|no|number|#)|acc ?(code|no)|debtor ?(code|no)|customer ?(code|no|number))$/i],
  ['branchCode', /^(branch ?(code|no|number)|store ?(code|no|number|#)|site ?(code|no|number))$/i],
  ['store', /^(site|site ?name|store|store ?name|branch|branch ?name|location|location ?name|premises|outlet)$/i],
  ['client', /^(customer|customer ?name|client|client ?name|company|company ?name|account ?name|debtor|name)$/i],
  ['address2', /^(address ?(line)? ?2|street ?2|addr ?2|physical ?address ?2)$/i],
  ['address', /^(address|address ?(line)? ?1|street|street ?address|physical ?address|site ?address|addr ?1?|street ?1)$/i],
  ['suburb', /^(suburb|area|district)$/i],
  ['city', /^(city|town|city ?\/ ?town|town ?\/ ?city)$/i],
  ['province', /^(province|state|region)$/i],
  ['postal', /^(post(al)? ?code|zip|zip ?code)$/i],
  ['contact', /^(contact|contact ?(person|name)|attention)$/i],
  ['phone', /^(phone|tel|telephone|cell|mobile|contact ?(no|number)|phone ?(no|number))$/i],
  ['email', /^(e-?mail|email ?address)$/i],
];

/** The office's best guess of which column holds what, from the headings. */
export function guessMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  const used = new Set<number>();
  for (const [field, re] of GUESS) {
    const i = headers.findIndex((h, j) => !used.has(j) && re.test(h.trim().replace(/[_.:]+/g, ' ').replace(/\s+/g, ' ')));
    if (i >= 0) { m[field] = i; used.add(i); }
  }
  // Loose second pass for the important ones ("Customer Name (Trading)", "Delivery Address").
  const loose: [Field, RegExp][] = [['client', /customer|client|company/i], ['store', /site|store|branch/i], ['address', /address|street/i], ['city', /city|town/i]];
  for (const [field, re] of loose) {
    if (m[field] !== undefined) continue;
    const i = headers.findIndex((h, j) => !used.has(j) && re.test(h));
    if (i >= 0) { m[field] = i; used.add(i); }
  }
  return m;
}

/** CSV (commas or semicolons, quotes, a byte-order mark) into rows of cells. */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  // The separator: whichever of , ; or tab the first lines have most of (a title line may have none).
  const head = t.split(/\r?\n/, 6).join('\n');
  const count = (c: string) => head.split(c).length - 1;
  const sep = [';', '\t', ','].reduce((best, c) => (count(c) > count(best) ? c : best), ',');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c));
}

/** The table's heading row: the first row where most cells look like headings (exports often start with a title). */
export function splitHeader(rows: string[][]): { headers: string[]; body: string[][] } {
  // The row (of the first ten) whose cells look most like known headings.
  let i = 0, best = 0;
  rows.slice(0, 10).forEach((r, j) => {
    if (r.filter(Boolean).length < 2) return;
    const score = Object.keys(guessMapping(r)).length;
    if (score > best) { best = score; i = j; }
  });
  const width = Math.max(...rows.map(r => r.length));
  const headers = Array.from({ length: width }, (_, j) => rows[i]?.[j]?.trim() || `Column ${j + 1}`);
  return { headers, body: rows.slice(i + 1) };
}

export interface CustomerRow {
  line: number; client: string; store: string; address: string | null; branchCode: string | null; accountCode: string | null;
  contact: string | null; phone: string | null; email: string | null; lat: number | null; lng: number | null;
}

const num = (s: string | undefined) => { const n = Number(String(s ?? '').replace(',', '.').trim()); return s && String(s).trim() && Number.isFinite(n) ? n : null; };

/** Joins address parts without repeating ("Alton, Richards Bay, Richards Bay" → once). */
export function joinAddress(parts: (string | null | undefined)[]): string | null {
  const out: string[] = [];
  for (const p of parts) {
    for (const piece of String(p ?? '').split(/\s*[\n,]\s*/)) {
      const v = piece.trim();
      if (v && !out.some(o => o.toLowerCase() === v.toLowerCase())) out.push(v);
    }
  }
  return out.length ? out.join(', ') : null;
}

/** Rows as customers and sites. A row without a customer is skipped (with the reason). */
export function toCustomers(body: string[][], m: Mapping): { rows: CustomerRow[]; skipped: { line: number; reason: string }[] } {
  const rows: CustomerRow[] = [];
  const skipped: { line: number; reason: string }[] = [];
  const get = (r: string[], f: Field) => (m[f] === undefined ? '' : (r[m[f]!] ?? '').trim());
  body.forEach((r, i) => {
    const line = i + 2;
    const client = get(r, 'client');
    if (!client) { if (r.some(c => c.trim())) skipped.push({ line, reason: 'no customer name' }); return; }
    let lat = num(get(r, 'lat')), lng = num(get(r, 'lng'));
    // Only a point in South Africa counts (a 0,0 or a swapped pair is not a pin).
    if (lat === null || lng === null || lat < -35 || lat > -22 || lng < 16 || lng > 33) { lat = null; lng = null; }
    rows.push({
      line, client, store: get(r, 'store') || client,
      address: joinAddress([get(r, 'address'), get(r, 'address2'), get(r, 'suburb'), get(r, 'city'), get(r, 'province'), get(r, 'postal')]),
      branchCode: get(r, 'branchCode') || null, accountCode: get(r, 'accountCode') || null, contact: get(r, 'contact') || null,
      phone: get(r, 'phone') || null, email: (get(r, 'email').split(/[;,\s]+/)[0] || null), lat, lng,
    });
  });
  return { rows, skipped };
}

/** How sure a found pin is: the building / shop itself, or only the street, suburb or town. */
export type PinPrecision = 'exact' | 'street' | 'area';
