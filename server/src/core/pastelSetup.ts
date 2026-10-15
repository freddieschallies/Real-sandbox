// Pastel's guided set-up: the company gives the app Pastel's own lists (customers, suppliers, GL accounts,
// inventory items: File → Import/Export in Pastel, or a listing report saved to Excel) and the app matches
// them to its own customers, suppliers and stock, so nobody types account codes. Pure functions, used on the
// server and in the test drive.

export type ListKind = 'customers' | 'suppliers' | 'accounts' | 'items';
export interface Entry { code: string; name: string }

const looksLikeCode = (v: string) => /^[A-Za-z0-9][A-Za-z0-9/._-]{0,19}$/.test(v) && /\d|^[A-Z0-9/._-]+$/.test(v);
const HEAD_CODE = /^((customer|supplier|account|acc|debtor|creditor|item|stock|inventory|gl)\s*(code|no|nr|number|#)?|code|no|nr|number|#|acc(ount)?\s*no)\.?$/i;
const HEAD_NAME = /^(customer|supplier|account|item|stock)?\s*(name|description|desc)\.?$/i;

/** A Pastel list (with or without headings) as codes and names. */
export function readPastelList(rows: string[][]): Entry[] {
  const clean = rows.map(r => r.map(c => String(c ?? '').trim())).filter(r => r.some(Boolean));
  if (!clean.length) return [];
  let codeCol = -1, nameCol = -1, start = 0;
  // Headings in the first few rows?
  for (let i = 0; i < Math.min(5, clean.length); i++) {
    const c = clean[i].findIndex(h => HEAD_CODE.test(h)), n = clean[i].findIndex(h => HEAD_NAME.test(h));
    if (c >= 0 && n >= 0 && c !== n) { codeCol = c; nameCol = n; start = i + 1; break; }
  }
  if (codeCol < 0) {
    // No headings (Pastel's own export): the code column is the one that looks most like unique codes;
    // the name is the column with the longest words.
    const width = Math.max(...clean.map(r => r.length));
    const sample = clean.slice(0, 200);
    let best = -1, bestScore = 0;
    for (let c = 0; c < width; c++) {
      const vals = sample.map(r => r[c] ?? '').filter(Boolean);
      if (vals.length < sample.length * 0.6) continue;
      const score = (vals.filter(looksLikeCode).length / vals.length) * (new Set(vals).size / vals.length);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best < 0 || bestScore < 0.6) return [];
    codeCol = best;
    let longest = -1, len = 0;
    for (let c = 0; c < width; c++) {
      if (c === codeCol) continue;
      const vals = sample.map(r => r[c] ?? '').filter(Boolean);
      if (vals.length < sample.length * 0.5) continue;
      const avg = vals.reduce((n, v) => n + (/[A-Za-z]{2}/.test(v) ? v.length : 0), 0) / vals.length;
      if (avg > len) { len = avg; longest = c; }
    }
    nameCol = longest;
    if (nameCol < 0) return [];
  }
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const r of clean.slice(start)) {
    const code = (r[codeCol] ?? '').trim(), name = (r[nameCol] ?? '').replace(/\s+/g, ' ').trim();
    if (!code || !name || !looksLikeCode(code) || seen.has(code.toUpperCase())) continue;
    seen.add(code.toUpperCase());
    out.push({ code, name });
  }
  return out;
}

/** A name without what differs between systems: (Pty) Ltd, CC, punctuation, "the". */
export function normName(s: string) {
  return ` ${s.toLowerCase().replace(/&/g, ' and ').replace(/\(pty\)|\bpty\b|\bltd\b|\blimited\b|\bcc\b|\binc\b|\bt\/a\b|\btrading as\b|\bthe\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `.trim();
}
/** How alike two names are, 0 to 1. */
export function nameScore(a: string, b: string) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ta = new Set(x.split(' ')), tb = new Set(y.split(' '));
  const both = [...ta].filter(t => tb.has(t)).length;
  const jac = both / new Set([...ta, ...tb]).size;
  const inside = both === Math.min(ta.size, tb.size) ? 0.85 : 0;
  const glued = x.replace(/ /g, '') === y.replace(/ /g, '') ? 0.95 : 0;
  return Math.max(jac, inside, glued);
}

export interface Match { id: string; name: string; current: string | null; code: string | null; codeName: string | null; how: 'has' | 'sure' | 'check' | 'none' | 'unknown'; score: number }
/**
 * For each of ours, its Pastel account. "has": its code is already there and in Pastel's list; "sure":
 * one clear name match; "check": a likely match to confirm; "none": no match; "unknown": it has a code
 * that is not in Pastel's list.
 */
export function matchNames(ours: { id: string; name: string; code: string | null }[], theirs: Entry[]): Match[] {
  const byCode = new Map(theirs.map(t => [t.code.toUpperCase(), t]));
  return ours.map(o => {
    if (o.code) {
      const t = byCode.get(o.code.toUpperCase());
      if (t) return { id: o.id, name: o.name, current: o.code, code: t.code, codeName: t.name, how: 'has' as const, score: 1 };
    }
    const ranked = theirs.map(t => ({ t, s: nameScore(o.name, t.name) })).sort((a, b) => b.s - a.s);
    const [first, second] = ranked;
    if (first && first.s >= 0.85 && (!second || second.s < first.s - 0.15)) return { id: o.id, name: o.name, current: o.code, code: first.t.code, codeName: first.t.name, how: 'sure' as const, score: first.s };
    if (first && first.s >= 0.5) return { id: o.id, name: o.name, current: o.code, code: first.t.code, codeName: first.t.name, how: 'check' as const, score: first.s };
    return { id: o.id, name: o.name, current: o.code, code: null, codeName: null, how: o.code ? 'unknown' as const : 'none' as const, score: 0 };
  });
}

/** Stock: the stockroom code is Pastel's item code, or a matching item by description. */
export function matchItems(ours: { id: string; code: string; description: string; pastelCode: string | null }[], theirs: Entry[]): Match[] {
  const byCode = new Map(theirs.map(t => [t.code.toUpperCase().replace(/\s+/g, ''), t]));
  return ours.map(o => {
    const mine = (o.pastelCode ?? o.code).toUpperCase().replace(/\s+/g, '');
    const t = byCode.get(mine);
    if (t) return { id: o.id, name: `${o.code} · ${o.description}`, current: o.pastelCode ?? o.code, code: t.code, codeName: t.name, how: 'has' as const, score: 1 };
    const ranked = theirs.map(x => ({ x, s: nameScore(o.description, x.name) })).sort((a, b) => b.s - a.s);
    const [first, second] = ranked;
    if (first && first.s >= 0.85 && (!second || second.s < first.s - 0.15)) return { id: o.id, name: `${o.code} · ${o.description}`, current: o.pastelCode, code: first.x.code, codeName: first.x.name, how: 'sure' as const, score: first.s };
    if (first && first.s >= 0.5) return { id: o.id, name: `${o.code} · ${o.description}`, current: o.pastelCode, code: first.x.code, codeName: first.x.name, how: 'check' as const, score: first.s };
    return { id: o.id, name: `${o.code} · ${o.description}`, current: o.pastelCode, code: null, codeName: null, how: 'none' as const, score: 0 };
  });
}

export const LINE_KEYS = ['labour', 'call_out', 'travel', 'bought_out', 'other', 'credit', 'purchases'] as const;
export type LineKey = (typeof LINE_KEYS)[number];
export const LINE_NAME: Record<LineKey, string> = {
  labour: 'Labour', call_out: 'Call-out fees', travel: 'Travel (time and km)', bought_out: 'Parts bought out for a job', other: 'Other lines',
  credit: 'Credit notes', purchases: 'Supplier invoices (purchases)',
};
const WORDS: Record<LineKey, RegExp[]> = {
  labour: [/labou?r/, /workmanship/, /service (fee|income|charge)/, /repairs? (income|sales)/],
  call_out: [/call ?-? ?outs?/, /callout/, /attendance/],
  travel: [/travel/, /transport/, /mileage/, /\bkm\b|kilomet/],
  bought_out: [/materials?/, /parts|spares/, /sales/],
  other: [/sundry|sundries/, /other income/, /sales/],
  credit: [/returns?|credit|allowance/, /sales/],
  purchases: [/purchases?/, /cost of sales/, /materials? purchased/],
};
/** Where each kind of line most likely goes, from Pastel's GL accounts and items (the CEO or Accounts confirms). */
export function suggestLineCodes(accounts: Entry[], items: Entry[]): Partial<Record<LineKey, { code: string; lineType: 4 | 6; name: string }>> {
  const out: Partial<Record<LineKey, { code: string; lineType: 4 | 6; name: string }>> = {};
  for (const k of LINE_KEYS) {
    // Labour, call-out and travel are often service items in Pastel; the rest GL accounts.
    const pools: [Entry[], 4 | 6][] = ['labour', 'call_out', 'travel'].includes(k) ? [[items, 4], [accounts, 6]] : [[accounts, 6]];
    found: for (const re of WORDS[k]) {
      for (const [pool, lineType] of pools) {
        const hit = pool.find(e => re.test(e.name.toLowerCase()) && !(k !== 'credit' && /return|credit/.test(e.name.toLowerCase())) && !(k !== 'purchases' && /purchase|cost of sales/.test(e.name.toLowerCase())));
        if (hit) { out[k] = { code: hit.code, lineType, name: hit.name }; break found; }
      }
    }
  }
  return out;
}
