// Stock on a technician: held as van stock (holdingJobId null) or for a specific job.
// It stays on his name until used on a job card or the stock controller confirms it came back.

export interface Holding { holdingJobId: string | null; qty: number; pendingReturn?: number }

/** What can still be used or returned from a holding: what he holds minus what is already on its way back. */
export const available = (h: Holding) => Math.max(0, round(h.qty - (h.pendingReturn ?? 0)));

/**
 * Which holdings to draw from when he uses stock on a job: what was booked for this job first,
 * then his van stock, then stock booked for his other jobs.
 */
export function drawPlan(holdings: Holding[], qty: number, onJobId: string): { ok: true; take: { holdingJobId: string | null; qty: number }[] } | { ok: false; have: number } {
  const order = [
    ...holdings.filter(h => h.holdingJobId === onJobId),
    ...holdings.filter(h => h.holdingJobId === null),
    ...holdings.filter(h => h.holdingJobId !== null && h.holdingJobId !== onJobId),
  ];
  const have = round(order.reduce((n, h) => n + available(h), 0));
  if (have + 1e-9 < qty) return { ok: false, have };
  const take: { holdingJobId: string | null; qty: number }[] = [];
  let left = qty;
  for (const h of order) {
    if (left <= 1e-9) break;
    const n = Math.min(available(h), left);
    if (n > 0) { take.push({ holdingJobId: h.holdingJobId, qty: round(n) }); left = round(left - n); }
  }
  return { ok: true, take };
}

/** Stock booked for a job that is closed must go back; van stock stays. */
export function mustReturn(holdingJobId: string | null, jobStatus: string | null): boolean {
  return holdingJobId !== null && jobStatus === 'closed';
}

export interface CatalogueItem { id: string; code: string; description: string; supplierCode?: string | null }
export interface InvoiceLine { description: string; supplierCode?: string | null; qty: number; unitPriceCents?: number | null }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Finds the stock item an invoice line is, by supplier code, our code, or the same description. */
export function matchItem(line: InvoiceLine, items: CatalogueItem[]): CatalogueItem | null {
  const code = line.supplierCode?.trim().toLowerCase();
  if (code) {
    const byCode = items.find(i => i.supplierCode?.toLowerCase() === code || i.code.toLowerCase() === code);
    if (byCode) return byCode;
  }
  const d = norm(line.description);
  return items.find(i => norm(i.description) === d) ?? null;
}

/** Problems with an invoice before it can be confirmed. */
export function invoiceProblems(inv: { supplierName?: string; invoiceNumber?: string; totalCents?: number | null; lines: InvoiceLine[] }): string[] {
  const p: string[] = [];
  if (!inv.supplierName?.trim()) p.push('supplier name');
  if (!inv.invoiceNumber?.trim()) p.push('invoice number');
  if (inv.lines.length === 0) p.push('at least one line');
  inv.lines.forEach((l, i) => {
    if (!l.description?.trim()) p.push(`line ${i + 1}: description`);
    if (!(l.qty > 0)) p.push(`line ${i + 1}: quantity`);
  });
  return p;
}

/** Sum of the lines, for comparing with the invoice total. Null when a price is missing. */
export function linesTotalCents(lines: InvoiceLine[]): number | null {
  let t = 0;
  for (const l of lines) {
    if (l.unitPriceCents == null) return null;
    t += Math.round(l.qty * l.unitPriceCents);
  }
  return t;
}

export const round = (n: number) => Math.round(n * 100) / 100;
