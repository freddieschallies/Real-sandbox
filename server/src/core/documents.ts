// Quotes and invoices: the money is worked out here, the same on the server and in the app.
// Amounts are in cents. VAT is worked out on the total, rounded to the cent.

export type LineKind = 'labour' | 'call_out' | 'travel' | 'stock' | 'bought_out' | 'other';
export interface DocLine { kind: LineKind; description: string; qty: number; unitPriceCents: number; stockItemId?: string | null; workItemId?: string | null }

export const KIND_LABEL: Record<LineKind, string> = { labour: 'Labour', call_out: 'Call-out', travel: 'Travel', stock: 'Parts', bought_out: 'Bought out', other: 'Other' };

export const lineTotal = (l: Pick<DocLine, 'qty' | 'unitPriceCents'>) => Math.round(l.qty * l.unitPriceCents);

export function totals(lines: Pick<DocLine, 'qty' | 'unitPriceCents'>[], vatPct: number) {
  const exVat = lines.reduce((n, l) => n + lineTotal(l), 0);
  const vat = Math.round((exVat * vatPct) / 100);
  return { exVatCents: exVat, vatCents: vat, totalCents: exVat + vat };
}

/** R 1 234.50 */
export const rand = (cents: number) => `R ${(cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What is wrong with a document before it can be sent. */
export function missingToSend(d: { lines: DocLine[]; to?: string | null }): string[] {
  const out: string[] = [];
  if (!d.lines.length) out.push('at least one line');
  d.lines.forEach((l, i) => {
    if (!l.description || l.description.trim().length < 2) out.push(`line ${i + 1}: a description`);
    if (!(l.qty > 0)) out.push(`line ${i + 1}: a quantity`);
    if (!(l.unitPriceCents > 0)) out.push(`line ${i + 1} (${l.description || 'no description'}): a price`);
  });
  return out;
}

/** Labour is charged per started quarter hour. */
export const quarterHours = (minutes: number) => Math.ceil(minutes / 15) / 4;

import { markedUp, type PriceRules } from './clientRates.ts';

export interface JobForInvoice {
  jobType: string;
  jobNumber: number;
  minutesOnSite: number;
  technicians: number;
  visits: number;
  stockUsed: { stockItemId: string; description: string; qty: number; sellingPriceCents: number | null; costCents?: number | null }[];
  boughtOut: { description: string; qty: number; costCents: number }[];
  /** Driving to the job and back, all visits: km (from the tracker, or estimated) and minutes. */
  travel?: { km: number; minutes: number; kmEstimated: boolean } | null;
}

/**
 * The draft invoice for a closed job: labour from the job timers, call-outs, travel, parts used and
 * items bought, priced with the client's own rates and mark-up (or the company's). A rate switched
 * off for the client is not charged at all. Everything can still be changed before it is sent.
 */
export function invoiceDraft(j: JobForInvoice, p: PriceRules): DocLine[] {
  const lines: DocLine[] = [];
  const hours = quarterHours(j.minutesOnSite);
  if (hours > 0 && p.labour !== null) {
    lines.push({ kind: 'labour', description: `Labour, job ${j.jobNumber}${j.technicians > 1 ? ` (${j.technicians} technicians)` : ''}`, qty: Math.round(hours * j.technicians * 100) / 100, unitPriceCents: p.labour });
  }
  if (j.jobType === 'breakdown' && j.visits > 0 && p.callOut !== null) {
    lines.push({ kind: 'call_out', description: j.visits > 1 ? `Call-out (${j.visits} visits)` : 'Call-out', qty: j.visits, unitPriceCents: p.callOut });
  }
  if (j.travel && j.travel.km > 0 && p.travelKm !== null) {
    lines.push({ kind: 'travel', description: `Travel, there and back${j.visits > 1 ? ` (${j.visits} visits)` : ''}${j.travel.kmEstimated ? ' (estimated km)' : ''}`, qty: Math.round(j.travel.km), unitPriceCents: p.travelKm });
  }
  if (j.travel && j.travel.minutes > 0 && p.travelHour !== null) {
    lines.push({ kind: 'travel', description: `Travel time, there and back${j.visits > 1 ? ` (${j.visits} visits)` : ''}`, qty: quarterHours(j.travel.minutes), unitPriceCents: p.travelHour });
  }
  for (const s of j.stockUsed) {
    const price = p.markup && s.costCents ? markedUp(s.costCents, p.markup) : s.sellingPriceCents ?? 0;
    lines.push({ kind: 'stock', description: s.description, qty: s.qty, unitPriceCents: price, stockItemId: s.stockItemId });
  }
  for (const b of j.boughtOut) {
    const price = p.markup ? markedUp(b.costCents, p.markup) : Math.round(b.costCents * (1 + p.boughtOutPct / 100));
    lines.push({ kind: 'bought_out', description: b.description, qty: b.qty, unitPriceCents: price });
  }
  return lines;
}

/** Rates the CEO sets. */
export const RATE_KEYS = ['labour_per_hour', 'call_out', 'travel_per_km', 'travel_per_hour', 'bought_out_markup_pct', 'labour_cost_per_hour', 'vehicle_cost_per_km'] as const;
export const RATE_LABEL: Record<(typeof RATE_KEYS)[number], string> = {
  labour_per_hour: 'Labour per hour (excl. VAT)', call_out: 'Call-out fee (excl. VAT)', travel_per_km: 'Travel per km (excl. VAT)', travel_per_hour: 'Travel time per hour (excl. VAT)', bought_out_markup_pct: 'Mark-up on bought-out items (%)',
  labour_cost_per_hour: 'What an hour of a technician costs us (wages and all), for profit per job', vehicle_cost_per_km: 'What a km costs us (fuel, tyres, services), for profit per job',
};
