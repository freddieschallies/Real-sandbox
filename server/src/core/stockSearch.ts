// Finding stock the way people type it: part codes with or without the dash ("valve01", "VALVE-01"),
// supplier and Pastel codes, the start of a word ("cont 25"), plurals ("valves"), small typos
// ("contacter", "gaskit"), sizes and ratings ("24v", "2.5 mm", "R404"), and the other words the trade
// uses for the same part ("gasket" finds the door seal). Best match first. Pure: the same on the
// server, on the phone and in the test drive.

export interface Findable {
  code: string; description: string;
  supplierCode?: string | null; supplierName?: string | null; pastelCode?: string | null;
  /** Anything else worth finding it by (the category, a note). */
  also?: string | null;
}

/** The trade's other words for the same thing (each group finds the others). */
const SYNONYMS: string[][] = [
  ['seal', 'gasket', 'rubber'], ['element', 'heater', 'heating'], ['thermostat', 'stat'], ['capacitor', 'cap'],
  ['refrigerant', 'gas'], ['bulb', 'globe', 'lamp'], ['pcb', 'board'], ['sensor', 'probe', 'thermistor'],
  ['breaker', 'mcb'], ['hose', 'pipe', 'tube'], ['fridge', 'refrigerator', 'chiller'], ['tie', 'zip'],
  ['cable', 'wire', 'flex'], ['switch', 'microswitch'], ['contactor', 'relay'], ['motor', 'fan'],
  ['valve', 'solenoid'], ['lugs', 'lug', 'terminal'], ['tape', 'insulation'],
];
const SYN = new Map<string, Set<string>>();
for (const g of SYNONYMS) for (const w of g) { const s = SYN.get(w) ?? new Set<string>(); g.forEach(x => x !== w && s.add(x)); SYN.set(w, s); }

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'x', 'with', 'to', 'in', 'on']);

/** Lower case, decimals with a point, "×" as x. */
const clean = (s: string) => s.toLowerCase().replace(/×/g, 'x').replace(/(\d),(\d)/g, '$1.$2');
/** The words of a text, letters and numbers apart ("R404A" → r, 404, a; "2.5mm" → 2.5, mm). */
export const tokens = (s: string) => clean(s).match(/\d+(?:\.\d+)?|\p{L}+/gu) ?? [];
/** Only letters and numbers: "VALVE-01" → "valve01". */
export const compact = (s: string) => clean(s).replace(/[^\p{L}\p{N}.]/gu, '').replace(/\./g, '');

/** "valves" → "valve", "boxes" → "box", "lamps" → "lamp". */
export function stem(w: string) {
  if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Edit distance, giving up past `max` (letters swapped count once). */
export function near(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const prev2: number[] = []; let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v); best = Math.min(best, v);
    }
    if (best > max) return false;
    prev2.splice(0, prev2.length, ...prev); prev = cur;
  }
  return prev[b.length] <= max;
}

interface Prepared { codes: string[]; codeCompact: string[]; words: string[]; stems: string[]; supplier: string[]; desc: string }
function prepare(i: Findable): Prepared {
  const codeTexts = [i.code, i.supplierCode, i.pastelCode].filter((x): x is string => !!x);
  const words = [...tokens(i.description), ...tokens(i.also ?? '')];
  return {
    codes: codeTexts.flatMap(tokens), codeCompact: codeTexts.map(compact), words, stems: words.map(stem),
    supplier: tokens(i.supplierName ?? ''), desc: clean(i.description),
  };
}

/** How well one word of the search fits the item (0: not at all). */
function wordScore(t: string, p: Prepared): number {
  const num = /^\d/.test(t);
  const st = stem(t);
  let best = 0;
  const take = (n: number) => { if (n > best) best = n; };
  for (const c of p.codes) { if (c === t) take(60); else if (t.length >= 2 && c.startsWith(t)) take(45); }
  for (let k = 0; k < p.words.length; k++) {
    const w = p.words[k];
    if (w === t) take(42);
    else if (p.stems[k] === st) take(38);
    else if (num) { if (w.startsWith(t) && t.length >= 2) take(20); }
    else if (t.length >= 2 && w.startsWith(t)) take(t.length >= 3 ? 30 : 22);
    else if (SYN.get(st)?.has(p.stems[k]) || SYN.get(t)?.has(w)) take(26);
    else if (t.length >= 4 && w.length >= 4 && near(st, p.stems[k], t.length >= 7 ? 2 : 1)) take(18);
    else if (t.length >= 3 && w.includes(t)) take(12);
  }
  for (const s of p.supplier) { if (s === t) take(10); else if (t.length >= 3 && s.startsWith(t)) take(8); }
  return best;
}

/** How well the item fits the search: 0 when any word of it is not found. */
export function stockScore(i: Findable, q: string, p: Prepared = prepare(i)): number {
  const qc = compact(q);
  let score = 0;
  // The whole search is a code (with or without its dashes and spaces).
  if (qc.length >= 2) {
    if (p.codeCompact.some(c => c === qc)) score += 1000;
    else if (qc.length >= 3 && p.codeCompact.some(c => c.startsWith(qc))) score += 400;
    else if (qc.length >= 4 && p.codeCompact.some(c => c.includes(qc))) score += 200;
  }
  const ts = tokens(q).filter(t => !STOP.has(t));
  if (!ts.length) return score;
  let all = 0;
  for (const t of ts) {
    const s = wordScore(t, p);
    if (!s) return score >= 200 ? score : 0;
    all += s;
  }
  score += all;
  // In the same order as written, and the item's name starting with the first word.
  const plain = ts.join(' ');
  if (ts.length > 1 && p.desc.includes(plain)) score += 15;
  if (p.words[0] === ts[0] || p.stems[0] === stem(ts[0])) score += 8;
  return score - Math.min(10, p.desc.length / 25);
}

/**
 * The items that fit the search, best first (all of them, in the list's own order, for an empty search).
 * `bonus` lifts items a little (e.g. ones there are some of).
 */
export function findStock<T extends Findable>(items: readonly T[], q: string, opts: { limit?: number; bonus?: (i: T) => number } = {}): T[] {
  const lim = opts.limit ?? Infinity;
  if (!q.trim()) return items.slice(0, lim);
  const scored: { i: T; s: number }[] = [];
  for (const i of items) {
    const s = stockScore(i, q);
    if (s > 0) scored.push({ i, s: s + (opts.bonus?.(i) ?? 0) });
  }
  scored.sort((a, b) => b.s - a.s || a.i.code.localeCompare(b.i.code));
  return scored.slice(0, lim).map(x => x.i);
}

/** For lists that are not stock items (holdings, request lines): the text to search, as one item. */
export const matches = (text: string, q: string) => !q.trim() || stockScore({ code: '', description: text }, q) > 0;
