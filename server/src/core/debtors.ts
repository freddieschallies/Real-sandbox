// Debtors: who owes what, and for how long (an age analysis, by invoice date, the way Pastel shows it:
// current, 30, 60, 90 and 120 days and more). An invoice counts until it is marked paid; credit notes
// against it come off. Pure functions, the same on the server and in the app.

export const AGE_BANDS = ['current', 'd30', 'd60', 'd90', 'd120'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];
export const AGE_LABEL: Record<AgeBand, string> = { current: 'Current', d30: '30 days', d60: '60 days', d90: '90 days', d120: '120 days +' };

const dayMs = 86_400_000;
/** Whole days from one YYYY-MM-DD to another. */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to.slice(0, 10)}T12:00:00Z`) - Date.parse(`${from.slice(0, 10)}T12:00:00Z`)) / dayMs);

export function ageBand(invoiceDate: string, today: string): AgeBand {
  const d = daysBetween(invoiceDate, today);
  return d < 30 ? 'current' : d < 60 ? 'd30' : d < 90 ? 'd60' : d < 120 ? 'd90' : 'd120';
}

export interface OpenInvoice {
  id: string; number: number; clientId: string; client: string; date: string; due: string | null;
  /** Including VAT. */
  totalCents: number; creditedCents: number; jobNumber?: number | null; store?: string | null;
}
export const owing = (i: OpenInvoice) => Math.max(0, i.totalCents - i.creditedCents);

export interface ClientDebt {
  clientId: string; client: string; bands: Record<AgeBand, number>; total: number; overdue: number; invoices: number; oldestDays: number;
}

/** Each client's debt by age, biggest first; and the totals. */
export function ageAnalysis(list: OpenInvoice[], today: string): { clients: ClientDebt[]; totals: Record<AgeBand, number> & { total: number; overdue: number } } {
  const by = new Map<string, ClientDebt>();
  const zero = () => Object.fromEntries(AGE_BANDS.map(b => [b, 0])) as Record<AgeBand, number>;
  const totals = { ...zero(), total: 0, overdue: 0 };
  for (const i of list) {
    const left = owing(i);
    if (left <= 0) continue;
    const c = by.get(i.clientId) ?? { clientId: i.clientId, client: i.client, bands: zero(), total: 0, overdue: 0, invoices: 0, oldestDays: 0 };
    const band = ageBand(i.date, today);
    c.bands[band] += left; totals[band] += left;
    c.total += left; totals.total += left;
    if (i.due && i.due < today) { c.overdue += left; totals.overdue += left; }
    c.invoices++;
    c.oldestDays = Math.max(c.oldestDays, daysBetween(i.date, today));
    by.set(i.clientId, c);
  }
  return { clients: [...by.values()].sort((a, b) => b.total - a.total), totals };
}
