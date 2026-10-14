// A customer's statement: every invoice (owed), credit note and payment in the period with the running
// balance, the balance brought forward, and the age analysis of what is still owed (current, 30, 60,
// 90, 120 days and more). The same on the server (emailed) and in the app (printed). Amounts incl. VAT.
import { AGE_BANDS, AGE_LABEL, ageAnalysis, type AgeBand, type OpenInvoice } from './debtors.ts';
import { rand } from './documents.ts';

export interface StatementEntry { date: string; kind: 'invoice' | 'credit' | 'payment'; ref: string; description: string; debitCents: number; creditCents: number }
export interface StatementLine extends StatementEntry { balanceCents: number }
export interface Statement {
  from: string | null; to: string; opening: number; lines: StatementLine[]; closing: number;
  debits: number; credits: number; ages: Record<AgeBand, number>; overdue: number;
}
/** An invoice sent to the client (incl. VAT); date = when it was sent; paid = the day it was marked paid. */
export interface StInvoice { id: string; number: number; date: string; due: string | null; totalCents: number; paid: string | null; paidRef?: string | null; jobNumber?: number | null; store?: string | null; clientRef?: string | null }
/** A credit note against one of the invoices (incl. VAT). */
export interface StCredit { number: number; date: string; invoiceId: string; totalCents: number; reason?: string | null }

const order = { invoice: 0, credit: 1, payment: 2 } as const;

/** The statement for a period (from null: from the start) to a day. A payment is the invoice's balance
 *  after its credit notes, on the day it was marked paid. The age analysis is of what was owed on `to`. */
export function buildStatement(invoices: StInvoice[], credits: StCredit[], from: string | null, to: string): Statement {
  const entries: StatementEntry[] = [];
  const creditedBy = (id: string, upTo: string) => credits.filter(c => c.invoiceId === id && c.date <= upTo).reduce((n, c) => n + c.totalCents, 0);
  const num = new Map(invoices.map(i => [i.id, i.number]));
  for (const i of invoices) {
    entries.push({ date: i.date, kind: 'invoice', ref: `INV ${i.number}`, description: [i.jobNumber ? `Job ${i.jobNumber}` : '', i.store ?? '', i.clientRef ? `your ref ${i.clientRef}` : ''].filter(Boolean).join(', ') || 'Invoice', debitCents: i.totalCents, creditCents: 0 });
    if (i.paid) {
      const left = Math.max(0, i.totalCents - creditedBy(i.id, i.paid));
      if (left) entries.push({ date: i.paid, kind: 'payment', ref: i.paidRef ? String(i.paidRef) : 'Payment', description: `Payment, invoice ${i.number}`, debitCents: 0, creditCents: left });
    }
  }
  for (const c of credits) entries.push({ date: c.date, kind: 'credit', ref: `CN ${c.number}`, description: `Credit note, invoice ${num.get(c.invoiceId) ?? ''}${c.reason ? `: ${c.reason}` : ''}`, debitCents: 0, creditCents: c.totalCents });
  entries.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || a.ref.localeCompare(b.ref));
  const opening = entries.filter(e => from && e.date < from).reduce((n, e) => n + e.debitCents - e.creditCents, 0);
  let bal = opening;
  const lines = entries.filter(e => (!from || e.date >= from) && e.date <= to).map(e => { bal += e.debitCents - e.creditCents; return { ...e, balanceCents: bal }; });
  const open: OpenInvoice[] = invoices.filter(i => i.date <= to && (!i.paid || i.paid > to))
    .map(i => ({ id: i.id, number: i.number, clientId: 'c', client: 'c', date: i.date, due: i.due, totalCents: i.totalCents, creditedCents: creditedBy(i.id, to) }));
  const a = ageAnalysis(open, to);
  return {
    from, to, opening, lines, closing: bal,
    debits: lines.reduce((n, l) => n + l.debitCents, 0), credits: lines.reduce((n, l) => n + l.creditCents, 0),
    ages: Object.fromEntries(AGE_BANDS.map(b => [b, a.totals[b]])) as Record<AgeBand, number>, overdue: a.totals.overdue,
  };
}

/** The periods to choose from, to today. */
export const STATEMENT_PERIODS = ['month', 'last', 'three', 'year', 'all'] as const;
export type StatementPeriod = (typeof STATEMENT_PERIODS)[number];
export const PERIOD_LABEL: Record<StatementPeriod, string> = { month: 'This month', last: 'Last month', three: 'Last 3 months', year: 'Last 12 months', all: 'Everything' };
export function periodDates(p: StatementPeriod, today: string): { from: string | null; to: string } {
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const first = (yy: number, mm: number) => { const d = new Date(Date.UTC(yy, mm - 1, 1)); return d.toISOString().slice(0, 10); };
  if (p === 'month') return { from: first(y, m), to: today };
  if (p === 'last') { const f = first(y, m - 1); return { from: f, to: new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10) }; }
  if (p === 'three') return { from: first(y, m - 2), to: today };
  if (p === 'year') return { from: first(y, m - 11), to: today };
  return { from: null, to: today };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const day = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00+02:00`).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Johannesburg' });

/** The statement as an HTML page body (between the letterhead's top and bottom). */
export function statementHtml(s: Statement, client: { name: string; pastel_code?: string | null; contact_name?: string | null; email?: string | null }, co: { bank_details?: string | null; invoice_terms?: string | null }): string {
  const rows = s.lines.map(l => `<tr><td>${day(l.date)}</td><td>${esc(l.ref)}</td><td>${esc(l.description)}</td><td class=r>${l.debitCents ? rand(l.debitCents) : ''}</td><td class=r>${l.creditCents ? rand(l.creditCents) : ''}</td><td class=r>${rand(l.balanceCents)}</td></tr>`).join('');
  const ages = AGE_BANDS.map(b => `<td class=r><div class=sm>${AGE_LABEL[b]}</div><b>${rand(s.ages[b])}</b></td>`).join('');
  return `<div class=body>
<div class=two><div><b>Statement for</b><br>${esc(client.name)}${client.contact_name ? `<br>Attention: ${esc(client.contact_name)}` : ''}${client.pastel_code ? `<br>Account ${esc(client.pastel_code)}` : ''}</div>
<div style="text-align:right"><b style="font-size:18px;color:#E8701A">STATEMENT</b><br>${s.from ? `${day(s.from)} to ${day(s.to)}` : `All transactions to ${day(s.to)}`}</div></div>
<table><tr><th>Date</th><th>Reference</th><th>Description</th><th class=r>Debit</th><th class=r>Credit</th><th class=r>Balance</th></tr>
${s.from ? `<tr><td>${day(s.from)}</td><td></td><td>Balance brought forward</td><td></td><td></td><td class=r>${rand(s.opening)}</td></tr>` : ''}${rows}
<tr><td colspan=3><b>Totals for the period · balance due</b></td><td class=r>${rand(s.debits)}</td><td class=r>${rand(s.credits)}</td><td class=r><b>${rand(s.closing)}</b></td></tr></table>
<table class=ages><tr>${ages}<td class=r><div class=sm>Total due</div><b>${rand(s.closing)}</b></td></tr></table>
${s.overdue ? `<p><b>${rand(s.overdue)} is past its due date.</b> Please pay at your earliest convenience.</p>` : ''}
${co.bank_details ? `<p><b>Banking details:</b> ${esc(co.bank_details)}</p>` : ''}${co.invoice_terms ? `<p class=sm>${esc(co.invoice_terms)}</p>` : ''}</div>`;
}

export const STATEMENT_CSS = `body{font:13px Arial,sans-serif;margin:0;color:#111}.bar{height:10px;background:#E8701A}.head{background:#111;color:#fff;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
.head h1{margin:0;font-size:22px}.body{padding:20px 24px}.two{display:flex;justify-content:space-between;gap:20px}table{width:100%;border-collapse:collapse;margin-top:14px}
th{text-align:left;border-top:2px solid #111;border-bottom:1px solid #ccc;padding:6px 4px}td{border-bottom:1px solid #eee;padding:6px 4px;vertical-align:top}.r{text-align:right}.sm{font-size:11px;color:#555}
table.ages{table-layout:fixed}table.ages td{border:1px solid #ddd;padding:6px}.foot{background:#111;color:#eee;font-size:11px;padding:10px 24px}@media print{.noprint{display:none}}`;
