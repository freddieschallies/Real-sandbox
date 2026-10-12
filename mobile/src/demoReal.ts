// The test drive normally shows made-up people and clients. For a demo to the company itself, a build
// can show its real staff, customers and company details instead: scripts/real-demo-seed.mjs makes
// the list from the Servcraft import folder and it goes in at build time (EXPO_PUBLIC_REAL_DEMO), so
// the real details are never kept in git. The demo's jobs, stock, vehicles and prices stay examples,
// and every warning and flag about someone's conduct goes on one made-up person, the Example Tech, so
// nothing reads as a real incident about a real person.

export interface RealPerson { name: string; email: string | null; phone: string | null }
export interface RealSeed {
  company: { name: string; legal_name: string; reg_no: string | null; vat_no: string | null; address: string | null; phone: string | null; email: string | null };
  /** The demo's people (by their demo id) → the real person shown instead. */
  people: Record<string, RealPerson>;
  /** The rest of the staff, shown as technicians. */
  others: (RealPerson & { id: string })[];
  /** The demo's stores (by id) → a real customer's store. */
  stores: Record<string, { name: string; client: string; address?: string }>;
  /** The real customers, for the client lists. */
  clients: { name: string; code: string | null; contact: string | null; email: string | null; phone: string | null }[];
  /** Made-up words in the demo (names of people and stores) → the real ones. */
  swaps: [string, string][];
}

let seed: RealSeed | null = null;
try {
  // Written out in full so the build puts the list in (only this exact form is replaced).
  const raw = process.env.EXPO_PUBLIC_REAL_DEMO;
  seed = raw ? JSON.parse(raw) as RealSeed : null;
} catch { seed = null; }
export const REAL: RealSeed | null = seed;

/** The made-up technician who carries the example warnings, flags and unaccounted hours. */
export const EXAMPLE_TECH = 'tech-3';
/** In the real-data demo: does this person get example incidents? Everyone in the made-up demo does. */
export const mayHaveIncidents = (techId: string) => !REAL || techId === EXAMPLE_TECH;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let pattern: RegExp | null = null;
const table = new Map<string, string>();
if (REAL?.swaps.length) {
  const pairs = [...REAL.swaps].filter(([a, b]) => a && a !== b).sort((x, y) => y[0].length - x[0].length);
  for (const [a, b] of pairs) if (!table.has(a)) table.set(a, b);
  pattern = new RegExp(`(^|[^A-Za-z])(${[...table.keys()].map(esc).join('|')})(?![A-Za-z])`, 'g');
}

/** A piece of text with the made-up names replaced by the real ones (unchanged in the made-up demo). */
export function realText(s: string): string {
  if (!pattern || !s) return s;
  return s.replace(pattern, (_m, pre: string, w: string) => pre + (table.get(w) ?? w));
}

/** The same for everything in an answer from the demo server. */
export function realDeep<T>(x: T): T {
  if (!pattern) return x;
  if (typeof x === 'string') return realText(x) as T;
  if (Array.isArray(x)) return x.map(realDeep) as T;
  if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) out[k] = realDeep(v);
    return out as T;
  }
  return x;
}
