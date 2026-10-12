// The mechanic's workshop stock. Poured stock (oil, coolant) is never measured exactly, so a count
// may be a little short: that is allowed, up to a small allowance, but always recorded as a loss.
// More than the allowance goes to the office to explain. Pure functions, used on the phone and server.

/** Allowed handling loss on poured stock: 5 % of what was used since the last count, at least 0.25. */
export const LOSS_PCT = 5;
export const LOSS_MIN = 0.25;

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function allowance(usedSince: number, measured: boolean): number {
  if (!measured) return 0;
  return round2(Math.max(LOSS_MIN, (usedSince * LOSS_PCT) / 100));
}

export type CountResult = 'ok' | 'within_allowance' | 'short' | 'over';

/** Compares a count with what the system expects. `loss` is positive when stock is missing. */
export function countResult(expected: number, counted: number, usedSince: number, measured: boolean) {
  const loss = round2(expected - counted);
  const allow = allowance(usedSince, measured);
  const result: CountResult = loss === 0 ? 'ok' : loss < 0 ? 'over' : loss <= allow ? 'within_allowance' : 'short';
  return { loss, allowance: allow, result };
}

export function countText(r: { loss: number; allowance: number; result: CountResult }, unit: string) {
  if (r.result === 'ok') return 'Matches the system.';
  if (r.result === 'over') return `${-r.loss} ${unit} more than the system shows: say where it came from.`;
  if (r.result === 'within_allowance') return `${r.loss} ${unit} short: within the ${r.allowance} ${unit} allowance for pouring. Recorded as a small loss.`;
  return `${r.loss} ${unit} short: more than the ${r.allowance} ${unit} allowance. Say what happened; the office is asked to look at it.`;
}

/** What is missing before a count can be saved. */
export function missingOnCount(counted: number | null | undefined, note: string | null | undefined, r: { result: CountResult } | null): string[] {
  const out: string[] = [];
  if (counted == null || Number.isNaN(counted) || counted < 0) out.push('how much is there');
  if (r && (r.result === 'short' || r.result === 'over') && !(note && note.trim().length >= 5)) out.push('what happened (a short note)');
  return out;
}

export interface WorkshopLine { qty: number; min_qty: number }
export const belowMin = (l: WorkshopLine) => l.min_qty > 0 && l.qty < l.min_qty;
