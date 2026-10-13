// One status for a job card that also says where the money stands: still being worked on, done and
// waiting for its invoice, invoiced (paid, or credited), closed at no charge (and why), or cancelled
// (by the client, or by us). Used by the office's job list and job card, and by reports.

export const NO_CHARGE_REASONS = {
  warranty: 'Warranty', callback: 'Callback (our own work again)', goodwill: 'Goodwill', contract: 'Covered by a contract',
  no_fault: 'No fault found', other: 'Other',
} as const;
export type NoChargeReason = keyof typeof NO_CHARGE_REASONS;

export interface OutcomeInput {
  status: string; invoice_number?: number | null; invoice_status?: string | null; credited_cents?: number | null;
  no_charge_reason?: string | null; cancelled_by_party?: string | null;
}
export type Outcome = { key: string; label: string; tone: 'quiet' | 'info' | 'warn' | 'good' | 'bad' };

export function jobOutcome(j: OutcomeInput): Outcome {
  if (j.status === 'cancelled') {
    return j.cancelled_by_party === 'client' ? { key: 'cancelled_client', label: 'Cancelled by client', tone: 'quiet' }
      : j.cancelled_by_party === 'us' ? { key: 'cancelled_us', label: 'Cancelled by us', tone: 'quiet' } : { key: 'cancelled', label: 'Cancelled', tone: 'quiet' };
  }
  if (j.status !== 'closed') {
    const map: Record<string, Outcome> = {
      assigned: { key: 'assigned', label: 'Assigned', tone: 'quiet' }, in_progress: { key: 'in_progress', label: 'In progress', tone: 'info' },
      continue_later: { key: 'continue_later', label: 'Continue later', tone: 'warn' },
    };
    return map[j.status] ?? { key: j.status, label: j.status, tone: 'quiet' };
  }
  const inv = j.invoice_number ? ` · INV ${j.invoice_number}` : '';
  if (j.no_charge_reason) return { key: 'no_charge', label: `Closed · no charge (${NO_CHARGE_REASONS[j.no_charge_reason as NoChargeReason] ?? j.no_charge_reason})`, tone: 'good' };
  if (Number(j.credited_cents ?? 0) > 0) return { key: 'credited', label: `Credited${inv}`, tone: 'bad' };
  if (j.invoice_status === 'paid') return { key: 'paid', label: `Paid${inv}`, tone: 'good' };
  if (j.invoice_status && j.invoice_status !== 'draft') return { key: 'invoiced', label: `Invoiced${inv}`, tone: 'good' };
  if (j.invoice_status === 'draft') return { key: 'draft_invoice', label: `Done · invoice draft${inv}`, tone: 'warn' };
  return { key: 'to_invoice', label: 'Done · to invoice', tone: 'warn' };
}
