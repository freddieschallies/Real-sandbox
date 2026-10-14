// The demo's pretend quotes, invoices, company details, rates and Sage Pastel export, following the
// same rules as the server (core/documents.ts and core/pastel.ts).
import * as D from '../../server/src/core/documents.ts';
import * as P from '../../server/src/core/pastel.ts';
import * as R from '../../server/src/core/clientRates.ts';
import * as DB from '../../server/src/core/debtors.ts';
import * as PF from '../../server/src/core/profit.ts';
import { REAL } from './demoReal.ts';

type Line = D.DocLine & { id: string };
export interface DemoQuote {
  id: string; quote_number: number; status: 'draft' | 'sent' | 'accepted' | 'declined' | 'cancelled'; title: string; notes: string | null; client_ref: string | null;
  job_id: string | null; store_id: string | null; created_at: string; sent_at: string | null; valid_until: string | null; accepted_at: string | null; declined_at: string | null;
  decision_note: string | null; resulting_job_id: string | null; created_by: string; vat_pct: number; lines: Line[]; pastel_batch_id: string | null;
  /** Submitted by a technician (for the office to check, price and send); a job card linked for reference. */
  from_technician?: boolean; reference_job_id?: string | null; created_by_id?: string;
}
export interface DemoInvoice {
  id: string; invoice_number: number; status: 'draft' | 'sent' | 'paid' | 'cancelled'; job_id: string; notes: string | null; client_ref: string | null; created_at: string;
  sent_at: string | null; due_date: string | null; paid_at: string | null; paid_ref: string | null; cancel_note: string | null; created_by: string; vat_pct: number; lines: Line[]; pastel_batch_id: string | null;
}
export interface DemoDocsState {
  quotes: DemoQuote[]; invoices: DemoInvoice[]; nextQuote: number; nextInvoice: number;
  /** Credit notes against sent or paid invoices (kept as issued). */
  credits?: { id: string; credit_number: number; invoice_id: string; job_id: string; amount_cents: number; vat_pct: number; reason: string; created_at: string; created_by: string; pastel_batch_id?: string | null }[];
  /** Each client's own rates and parts mark-up (by client name in the demo). */
  clientRates?: Record<string, R.ClientRates>;
  /** Accounts on hold (by client name in the demo), and the record of every change. */
  holds?: Record<string, { reason: string; by: string; at: string }>;
  holdLog?: { client: string; on_hold: boolean; reason: string | null; job_number: number | null; by: string; at: string }[];
  /** Two older unpaid invoices seeded for the debtors list. */
  agedSeeded?: boolean;
  nextCredit?: number;
  /** Closed at no charge (warranty, callback, ...): the office's billing decision, beside the locked job card. */
  noCharge?: Record<string, { reason: string; note: string | null; by: string; at: string }>;
  profile: Record<string, unknown> | null; rates: Record<string, number>;
  pastel: P.PastelSettings; clientCodes: Record<string, string | null>; batches: { id: string; kind: P.PastelKind; numbers: (number | string)[]; file: string; created_at: string; created_by: string }[];
}

/** What the documents need from the rest of the demo. */
export interface DocsSources {
  jobs: { meta: { id: string; job_number: number; job_type: string; store_id: string; store: string; store_address: string | null; fault_reported: string; client_order_ref: string | null; lead_technician: string; helper_ids?: string[] };
    card: { status: string; visits: { startedAt?: string; endedAt?: string }[] }; closedAt?: string }[];
  stores: { id: string; client: string; name: string; address: string | null }[];
  minutesOf: (jobId: string) => number;
  stockUsed: (jobNumber: number) => { stockItemId: string; description: string; qty: number; sellingPriceCents: number | null; costCents?: number | null; code: string; unit: string }[];
  /** Driving there and back for a job (km estimated from the workshop until the tracker gives trips). */
  travelOf?: (jobId: string) => { km: number; minutes: number; kmEstimated: boolean } | null;
  stockCode: (stockItemId: string) => { code: string; unit: string } | null;
  name: string;
  /** Opens a follow-up job when a quote is accepted. */
  openJob: (storeId: string, fault: string, leadId: string, date: string, priority: string, ref: string | null) => { id: string; job_number: number };
}

type Res = { ok: true; body: unknown; status?: number } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown, status = 200): Res => ({ ok: true, body, status });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
let seq = 0;
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function seedDocs(): DemoDocsState {
  const l = (kind: D.LineKind, description: string, qty: number, unitPriceCents: number): Line => ({ id: nid('dl'), kind, description, qty, unitPriceCents });
  return {
    quotes: [
      { id: 'quote-5001', quote_number: 5001, status: 'sent', title: 'Replace both combi oven door seals', notes: 'Seals are torn on both ovens; steam escapes during cooking.', client_ref: null,
        job_id: null, store_id: 'arboretum', created_at: ago(50), sent_at: ago(48), valid_until: addDays(today(), 28), accepted_at: null, declined_at: null, decision_note: null,
        resulting_job_id: null, created_by: 'Zanele Khoza', vat_pct: 15, pastel_batch_id: null,
        lines: [{ ...l('stock', 'Oven door seal 1/1 Rational', 2, 185000), stockItemId: 'st-2' }, l('labour', 'Labour', 2, 65000), l('call_out', 'Call-out', 1, 45000)] },
      { id: 'quote-5002', quote_number: 5002, status: 'draft', title: 'New condenser fan motor, bakery display', notes: null, client_ref: null,
        job_id: 'job-10220', store_id: null, created_at: ago(3), sent_at: null, valid_until: null, accepted_at: null, declined_at: null, decision_note: null,
        resulting_job_id: null, created_by: 'Zanele Khoza', vat_pct: 15, pastel_batch_id: null,
        lines: [{ ...l('stock', 'Condenser fan motor 10W', 1, 0), stockItemId: 'st-7' }, l('labour', 'Labour', 1, 65000)] },
    ],
    invoices: [
      { id: 'inv-7001', invoice_number: 7001, status: 'sent', job_id: 'job-10219', notes: 'Thank you for your business.', client_ref: 'PO-14190', created_at: ago(70), sent_at: ago(70),
        due_date: addDays(today(), 27), paid_at: null, paid_ref: null, cancel_note: null, created_by: 'Zanele Khoza', vat_pct: 15, pastel_batch_id: null,
        lines: [l('labour', 'Labour, job 10219', 1.5, 65000), l('call_out', 'Call-out', 1, 45000), { ...l('stock', 'Water inlet valve 24V', 1, 32000), stockItemId: 'st-1' }] },
    ],
    nextQuote: 5003, nextInvoice: 7002,
    profile: {
      legal_name: REAL?.company.legal_name ?? 'Zululand Service Providers', trading_name: REAL?.company.name ?? 'ZSP', reg_no: REAL?.company.reg_no ?? null, vat_no: REAL?.company.vat_no ?? null,
      address: REAL?.company.address ?? 'Alton, Richards Bay, KwaZulu-Natal', phone: REAL?.company.phone ?? null, email: REAL?.company.email ?? null, bank_details: null, quote_terms: 'Quote valid for 30 days. Prices exclude VAT unless shown.', invoice_terms: 'Payment within 30 days of invoice.',
      vat_pct: 15, quote_valid_days: 30, invoice_due_days: 30,
    },
    rates: { labour_per_hour: 65000, call_out: 45000, travel_per_km: 900, bought_out_markup_pct: 20 },
    pastel: { yearStartMonth: 3, taxType: '01', codes: {}, store: null },
    // Real-data demo: the customers' account codes from Servcraft.
    clientCodes: REAL ? Object.fromEntries(REAL.clients.map(c => [c.name, c.code])) : { FreshMart: null, 'Harbour Deli': null, Boxer: null, Spar: null },
    batches: [],
  };
}

export class DemoDocs {
  constructor(public d: DemoDocsState, private src: DocsSources) {}

  private job(id: string | null) { return id ? this.src.jobs.find(j => j.meta.id === id) : undefined; }
  private storeOf(q: { job_id: string | null; store_id?: string | null }) {
    const j = this.job(q.job_id);
    const sid = j?.meta.store_id ?? q.store_id;
    return this.src.stores.find(s => s.id === sid);
  }
  private who(q: { job_id: string | null; store_id?: string | null }) {
    const s = this.storeOf(q);
    return { store: s?.name ?? '', store_address: s?.address ?? null, client: s?.client ?? '', store_email: null };
  }
  private exVat(lines: Line[]) { return lines.reduce((n, l) => n + D.lineTotal(l), 0); }

  // ---- Company and rates -------------------------------------------------------------------
  company() { return { profile: this.d.profile, rates: this.d.rates, rateKeys: D.RATE_KEYS.map(k => ({ key: k, label: D.RATE_LABEL[k] })) }; }
  setCompany(b: Record<string, unknown>): Res {
    if (!b.legalName || String(b.legalName).trim().length < 2) return bad(400, "the company's legal name");
    this.d.profile = {
      legal_name: b.legalName, trading_name: b.tradingName ?? null, reg_no: b.regNo ?? null, vat_no: b.vatNo ?? null, address: b.address ?? null, phone: b.phone ?? null,
      email: b.email || null, bank_details: b.bankDetails ?? null, quote_terms: b.quoteTerms ?? null, invoice_terms: b.invoiceTerms ?? null,
      vat_pct: b.vatPct ?? 15, quote_valid_days: b.quoteValidDays ?? 30, invoice_due_days: b.invoiceDueDays ?? 30,
    };
    return good({ profile: this.d.profile });
  }
  setRates(b: Record<string, number>) { for (const [k, v] of Object.entries(b)) if (typeof v === 'number') this.d.rates[k] = v; return good({ rates: this.d.rates }); }

  // ---- Quotes --------------------------------------------------------------------------------
  quotes(status?: string | null) {
    return this.d.quotes.filter(q => !status || q.status === status).map(q => {
      const ex = this.exVat(q.lines);
      return { id: q.id, quote_number: q.quote_number, status: q.status, title: q.title, created_at: q.created_at, sent_at: q.sent_at, valid_until: q.valid_until,
        accepted_at: q.accepted_at, declined_at: q.declined_at, vat_pct: q.vat_pct, job_number: this.job(q.job_id)?.meta.job_number ?? null, job_id: q.job_id, ...this.who(q),
        created_by: q.created_by, from_technician: !!q.from_technician, reference_job_number: this.job(q.reference_job_id ?? null)?.meta.job_number ?? null, ex_vat_cents: ex, total_cents: D.totals([{ qty: 1, unitPriceCents: ex }], q.vat_pct).totalCents };
    }).sort((a, b) => Number(b.status === 'draft') - Number(a.status === 'draft') || b.quote_number - a.quote_number);
  }
  quote(id: string): Res {
    const q = this.d.quotes.find(x => x.id === id);
    if (!q) return bad(404, 'no such quote');
    return good({ quote: { ...q, lines: undefined, job_number: this.job(q.job_id)?.meta.job_number ?? null, ...this.who(q), created_by_name: q.created_by,
      resulting_job_number: this.job(q.resulting_job_id)?.meta.job_number ?? null, reference_job_number: this.job(q.reference_job_id ?? null)?.meta.job_number ?? null, from_technician: !!q.from_technician }, lines: q.lines, totals: D.totals(q.lines, q.vat_pct), company: this.d.profile });
  }
  newQuote(b: { jobId?: string; storeId?: string; title: string; clientRef?: string; notes?: string; lines?: D.DocLine[] }): Res {
    if (!b.jobId && !b.storeId) return bad(400, 'a job or a store');
    if (!b.title || b.title.trim().length < 3) return bad(400, 'what the quote is for');
    const id = nid('quote');
    const number = this.d.nextQuote++;
    this.d.quotes.unshift({ id, quote_number: number, status: 'draft', title: b.title.trim(), notes: b.notes ?? null, client_ref: b.clientRef ?? null, job_id: b.jobId ?? null,
      store_id: b.jobId ? null : b.storeId ?? null, created_at: new Date().toISOString(), sent_at: null, valid_until: null, accepted_at: null, declined_at: null, decision_note: null,
      resulting_job_id: null, created_by: this.src.name, vat_pct: Number(this.d.profile?.vat_pct ?? 15), pastel_batch_id: null,
      lines: (b.lines ?? []).filter(l => l.qty > 0).map(l => ({ ...l, id: nid('dl') })) });
    return good({ id, quoteNumber: number }, 201);
  }
  /** A technician's quote: on one of his jobs not finished, or new for a store with a job card for reference. */
  techQuote(b: { jobId?: string; storeId?: string; referenceJobId?: string; title?: string; notes?: string; labourHours?: number; stockLines?: { stockItemId: string; qty: number }[]; boughtOutLines?: { description: string; qty: number; estimatedPriceCents?: number }[] },
    tech: { id: string; name: string }, mine: { id: string; status: string }[], part: (id: string) => { description: string; sellingPriceCents: number | null } | null): Res {
    if (!b.jobId && !b.storeId) return bad(400, 'the job, or the store it is for');
    if (!b.title || b.title.trim().length < 3) return bad(400, 'what the quote is for');
    const hours = Number(b.labourHours ?? 0), stock = b.stockLines ?? [], bought = (b.boughtOutLines ?? []).filter(l => l.description?.trim().length >= 2 && l.qty > 0);
    if (!hours && !stock.length && !bought.length) return bad(400, 'add the work: labour hours, parts or items to buy');
    if (b.jobId) {
      const j = mine.find(x => x.id === b.jobId);
      if (!j) return bad(403, 'you are not on that job');
      if (j.status === 'closed') return bad(409, 'that job is finished: start a new quote and link the job card for reference');
    } else if (!this.src.stores.some(x => x.id === b.storeId)) return bad(400, 'unknown store');
    if (b.referenceJobId && !mine.some(x => x.id === b.referenceJobId)) return bad(403, 'link one of your own job cards');
    const lines: D.DocLine[] = [];
    if (hours) lines.push({ kind: 'labour', description: 'Labour', qty: hours, unitPriceCents: this.d.rates.labour_per_hour ?? 0 });
    for (const l of stock) { const it = part(l.stockItemId); if (!it) return bad(400, 'unknown part'); lines.push({ kind: 'stock', description: it.description, qty: l.qty, unitPriceCents: it.sellingPriceCents ?? 0, stockItemId: l.stockItemId }); }
    for (const l of bought) lines.push({ kind: 'bought_out', description: l.description.trim(), qty: l.qty, unitPriceCents: Math.max(0, Math.round(l.estimatedPriceCents ?? 0)) });
    const id = nid('quote');
    const number = this.d.nextQuote++;
    this.d.quotes.unshift({ id, quote_number: number, status: 'draft', title: b.title.trim(), notes: b.notes?.trim() || null, client_ref: null, job_id: b.jobId ?? null,
      store_id: b.jobId ? null : b.storeId ?? null, created_at: new Date().toISOString(), sent_at: null, valid_until: null, accepted_at: null, declined_at: null, decision_note: null,
      resulting_job_id: null, created_by: tech.name, created_by_id: tech.id, vat_pct: Number(this.d.profile?.vat_pct ?? 15), pastel_batch_id: null,
      from_technician: true, reference_job_id: b.jobId ? null : b.referenceJobId ?? null, lines: lines.map(l => ({ ...l, id: nid('dl') })) });
    return good({ id, quoteNumber: number, unpriced: lines.filter(l => !l.unitPriceCents).map(l => l.description) }, 201);
  }
  myQuotes(techId: string) {
    return this.d.quotes.filter(q => q.from_technician && q.created_by_id === techId).map(q => ({
      id: q.id, quote_number: q.quote_number, status: q.status, title: q.title, created_at: q.created_at, job_number: this.job(q.job_id)?.meta.job_number ?? null,
      reference_job_number: this.job(q.reference_job_id ?? null)?.meta.job_number ?? null, store: this.who(q).store, ex_vat_cents: this.exVat(q.lines) }));
  }
  editQuote(id: string, b: { title: string; clientRef?: string | null; notes?: string | null; lines: D.DocLine[] }): Res {
    const q = this.d.quotes.find(x => x.id === id);
    if (!q) return bad(404, 'no such quote');
    if (q.status !== 'draft') return bad(409, 'a sent quote cannot be changed: make a new one');
    Object.assign(q, { title: b.title, client_ref: b.clientRef ?? null, notes: b.notes ?? null, lines: b.lines.filter(l => l.qty > 0).map(l => ({ ...l, id: nid('dl') })) });
    return good({ id });
  }
  sendQuote(id: string): Res {
    const q = this.d.quotes.find(x => x.id === id);
    if (!q) return bad(404, 'no such quote');
    if (q.status !== 'draft') return bad(409, 'already sent');
    const missing = D.missingToSend({ lines: q.lines });
    if (missing.length) return bad(409, ...missing);
    Object.assign(q, { status: 'sent', sent_at: new Date().toISOString(), valid_until: addDays(today(), Number(this.d.profile?.quote_valid_days ?? 30)) });
    return good({ id, status: 'sent' });
  }
  acceptQuote(id: string, b: { note?: string; clientRef?: string; newJob?: { scheduledDate: string; leadTechnicianId: string; priority?: string } }): Res {
    const q = this.d.quotes.find(x => x.id === id);
    if (!q) return bad(404, 'no such quote');
    if (q.status !== 'sent') return bad(409, 'only a sent quote can be accepted');
    let job: { id: string; job_number: number } | null = null;
    if (b.newJob) {
      const st = this.storeOf(q);
      job = this.src.openJob(st!.id, `Quote ${q.quote_number} accepted: ${q.title}`, b.newJob.leadTechnicianId, b.newJob.scheduledDate, b.newJob.priority ?? 'scheduled', b.clientRef ?? q.client_ref);
    }
    Object.assign(q, { status: 'accepted', accepted_at: new Date().toISOString(), decision_note: b.note ?? null, resulting_job_id: job?.id ?? null, client_ref: b.clientRef ?? q.client_ref });
    return good({ id, status: 'accepted', jobId: job?.id ?? null, jobNumber: job?.job_number ?? null });
  }
  declineQuote(id: string, note: string): Res {
    const q = this.d.quotes.find(x => x.id === id && x.status === 'sent');
    if (!q) return bad(409, 'only a sent quote can be declined');
    if (!note || note.trim().length < 3) return bad(400, 'what the client said');
    Object.assign(q, { status: 'declined', declined_at: new Date().toISOString(), decision_note: note.trim() });
    return good({ id, status: 'declined' });
  }
  cancelQuote(id: string, note: string): Res {
    const q = this.d.quotes.find(x => x.id === id);
    if (!q) return bad(404, 'no such quote');
    if (q.status === 'draft') { this.d.quotes = this.d.quotes.filter(x => x.id !== id); return good({ id, status: 'deleted' }); }
    if (q.status !== 'sent') return bad(409, `the quote is ${q.status}`);
    Object.assign(q, { status: 'cancelled', decision_note: note });
    return good({ id, status: 'cancelled' });
  }

  // ---- Invoices ------------------------------------------------------------------------------
  toInvoice() {
    return this.src.jobs.filter(j => j.card.status === 'closed' && !this.d.noCharge?.[j.meta.id] && !this.d.invoices.some(i => i.job_id === j.meta.id && i.status !== 'cancelled')).map(j => {
      const s = this.src.stores.find(x => x.id === j.meta.store_id);
      return { id: j.meta.id, job_number: j.meta.job_number, job_type: j.meta.job_type, closed_at: j.closedAt ?? j.card.visits.at(-1)?.endedAt ?? new Date().toISOString(),
        fault_reported: j.meta.fault_reported, client_order_ref: j.meta.client_order_ref, store: j.meta.store, client: s?.client ?? '', store_address: j.meta.store_address, lead_technician: j.meta.lead_technician };
    });
  }
  invoices(status?: string | null) {
    return this.d.invoices.filter(i => !status || i.status === status).map(i => {
      const ex = this.exVat(i.lines);
      const j = this.job(i.job_id);
      return { id: i.id, invoice_number: i.invoice_number, status: i.status, created_at: i.created_at, sent_at: i.sent_at, due_date: i.due_date, paid_at: i.paid_at, vat_pct: i.vat_pct,
        job_number: j?.meta.job_number ?? null, job_id: i.job_id, ...this.who({ job_id: i.job_id }), created_by: i.created_by, ex_vat_cents: ex,
        credited_cents: this.creditedOn(i.id), total_cents: D.totals([{ qty: 1, unitPriceCents: ex }], i.vat_pct).totalCents, overdue: i.status === 'sent' && !!i.due_date && i.due_date < today() };
    }).sort((a, b) => Number(b.status === 'draft') - Number(a.status === 'draft') || b.invoice_number - a.invoice_number);
  }
  invoice(id: string): Res {
    const i = this.d.invoices.find(x => x.id === id);
    if (!i) return bad(404, 'no such invoice');
    const j = this.job(i.job_id);
    return good({ invoice: { ...i, lines: undefined, job_number: j?.meta.job_number ?? null, job_order_ref: j?.meta.client_order_ref ?? null, fault_reported: j?.meta.fault_reported ?? '',
      job_closed: (j?.closedAt ?? '').slice(0, 10) || null, ...this.who({ job_id: i.job_id }), created_by_name: i.created_by }, lines: i.lines, totals: D.totals(i.lines, i.vat_pct),
      credits: (this.d.credits ?? []).filter(c => c.invoice_id === id).map(c => ({ ...c, total_cents: D.totals([{ qty: 1, unitPriceCents: c.amount_cents }], c.vat_pct).totalCents })), company: this.d.profile });
  }
  private creditedOn(invoiceId: string) { return (this.d.credits ?? []).filter(c => c.invoice_id === invoiceId).reduce((n, c) => n + c.amount_cents, 0); }
  /** A credit note against a sent or paid invoice: in full, or part (excl. VAT), with the reason. */
  credit(id: string, b: { amountCents?: number; reason?: string }, by: string): Res {
    const i = this.d.invoices.find(x => x.id === id);
    if (!i) return bad(404, 'no such invoice');
    if (!b.reason || b.reason.trim().length < 5) return bad(400, 'say why it is credited');
    if (!['sent', 'paid'].includes(i.status)) return bad(409, i.status === 'draft' ? 'a draft invoice is changed or deleted, not credited' : `the invoice is ${i.status}`);
    const left = this.exVat(i.lines) - this.creditedOn(id);
    if (left <= 0) return bad(409, `invoice ${i.invoice_number} is already credited in full`);
    const amount = b.amountCents ? Math.round(b.amountCents) : left;
    if (amount <= 0) return bad(400, 'the amount to credit');
    if (amount > left) return bad(409, `at most R ${(left / 100).toFixed(2)} (excl. VAT) is left to credit on invoice ${i.invoice_number}`);
    const n = this.d.nextCredit ?? 9001;
    this.d.nextCredit = n + 1;
    (this.d.credits ??= []).push({ id: nid('cn'), credit_number: n, invoice_id: id, job_id: i.job_id, amount_cents: amount, vat_pct: i.vat_pct, reason: b.reason.trim(), created_at: new Date().toISOString(), created_by: by });
    return good({ creditNumber: n, amountCents: amount }, 201);
  }
  /** A job's billing, for the office's filters. */
  billingOf(jobId: string) {
    const inv = this.d.invoices.filter(i => i.job_id === jobId && i.status !== 'cancelled').sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const credited = (this.d.credits ?? []).filter(c => c.job_id === jobId).reduce((n, c) => n + c.amount_cents, 0);
    const nc = this.d.noCharge?.[jobId];
    return { invoice_number: inv?.invoice_number ?? null, invoice_status: inv?.status ?? null, credited_cents: credited, no_charge_reason: nc?.reason ?? null, no_charge_note: nc?.note ?? null,
      billing: nc ? 'no_charge' : credited > 0 ? 'credited' : inv?.status === 'draft' ? 'draft_invoice' : inv ? 'invoiced' : 'not_invoiced' };
  }

  /** Closed at no charge, with the reason (or taken off again). */
  setNoCharge(jobId: string, reason: string, note: string | undefined, by: string): Res {
    const j = this.job(jobId);
    if (!j) return bad(404, 'no such job');
    if (!['warranty', 'callback', 'goodwill', 'contract', 'no_fault', 'other'].includes(reason)) return bad(400, 'why there is no charge');
    if (reason === 'other' && (!note || note.trim().length < 3)) return bad(400, 'say why there is no charge');
    if (j.card.status !== 'closed') return bad(409, (j.card.status as string) === 'cancelled' ? 'the job is cancelled' : 'close the job first (the technician signs it off)');
    const inv = this.d.invoices.find(i => i.job_id === jobId && i.status !== 'cancelled');
    if (inv) return bad(409, inv.status === 'draft' ? `cancel draft invoice ${inv.invoice_number} first` : `invoice ${inv.invoice_number} was sent: credit it instead`);
    (this.d.noCharge ??= {})[jobId] = { reason, note: note?.trim() || null, by, at: new Date().toISOString() };
    return good({ id: jobId, noChargeReason: reason });
  }
  clearNoCharge(jobId: string): Res {
    if (!this.d.noCharge?.[jobId]) return bad(409, 'this job is not marked no charge');
    delete this.d.noCharge[jobId];
    return good({ id: jobId, noChargeReason: null });
  }
  newInvoice(jobId: string): Res {
    const j = this.job(jobId);
    if (!j) return bad(404, 'no such job');
    if (this.d.noCharge?.[jobId]) return bad(409, `job ${j.meta.job_number} was closed at no charge: take that off the job first if it must be invoiced`);
    if (j.card.status !== 'closed') return bad(409, 'only a closed job can be invoiced');
    if (this.d.invoices.some(i => i.job_id === jobId && i.status !== 'cancelled')) return bad(409, 'this job already has an invoice');
    const lines = D.invoiceDraft({
      jobType: j.meta.job_type, jobNumber: j.meta.job_number, minutesOnSite: this.src.minutesOf(jobId), technicians: 1 + (j.meta.helper_ids ?? []).length,
      visits: j.card.visits.length, stockUsed: this.src.stockUsed(j.meta.job_number), boughtOut: [], travel: this.src.travelOf?.(jobId) ?? null,
    }, this.rulesFor(j.meta.store_id));
    const id = nid('inv');
    const number = this.d.nextInvoice++;
    this.d.invoices.unshift({ id, invoice_number: number, status: 'draft', job_id: jobId, notes: null, client_ref: j.meta.client_order_ref, created_at: new Date().toISOString(), sent_at: null,
      due_date: null, paid_at: null, paid_ref: null, cancel_note: null, created_by: this.src.name, vat_pct: Number(this.d.profile?.vat_pct ?? 15), pastel_batch_id: null,
      lines: lines.map(l => ({ ...l, id: nid('dl') })) });
    return good({ id, invoiceNumber: number, missing: D.missingToSend({ lines }) }, 201);
  }
  editInvoice(id: string, b: { clientRef?: string | null; notes?: string | null; lines: D.DocLine[] }): Res {
    const i = this.d.invoices.find(x => x.id === id);
    if (!i) return bad(404, 'no such invoice');
    if (i.status !== 'draft') return bad(409, 'a sent invoice cannot be changed: cancel it and make a new one');
    Object.assign(i, { client_ref: b.clientRef ?? null, notes: b.notes ?? null, lines: b.lines.filter(l => l.qty > 0).map(l => ({ ...l, id: nid('dl') })) });
    return good({ id });
  }
  sendInvoice(id: string): Res {
    const i = this.d.invoices.find(x => x.id === id);
    if (!i) return bad(404, 'no such invoice');
    if (i.status !== 'draft') return bad(409, 'already sent');
    const missing = D.missingToSend({ lines: i.lines });
    if (missing.length) return bad(409, ...missing);
    Object.assign(i, { status: 'sent', sent_at: new Date().toISOString(), due_date: addDays(today(), Number(this.d.profile?.invoice_due_days ?? 30)) });
    return good({ id, status: 'sent' });
  }
  paid(id: string, ref: string): Res {
    const i = this.d.invoices.find(x => x.id === id && x.status === 'sent');
    if (!i) return bad(409, 'only a sent invoice can be marked paid');
    if (!ref || ref.trim().length < 2) return bad(400, 'the payment reference');
    Object.assign(i, { status: 'paid', paid_at: today(), paid_ref: ref.trim() });
    return good({ id, status: 'paid' });
  }
  cancelInvoice(id: string, note: string): Res {
    const i = this.d.invoices.find(x => x.id === id);
    if (!i) return bad(404, 'no such invoice');
    if (!note || note.trim().length < 5) return bad(400, 'say why it is cancelled');
    if (i.status === 'draft') { this.d.invoices = this.d.invoices.filter(x => x.id !== id); return good({ id, status: 'deleted' }); }
    if (i.status !== 'sent') return bad(409, `the invoice is ${i.status}`);
    Object.assign(i, { status: 'cancelled', cancel_note: note.trim() });
    return good({ id, status: 'cancelled' });
  }

  // ---- Debtors and accounts on hold ----------------------------------------------------------
  private openInvoices(): (DB.OpenInvoice & { store: string | null; jobNumber: number | null })[] {
    return this.d.invoices.filter(i => i.status === 'sent').map(i => {
      const s = this.storeOf(i);
      const ex = this.exVat(i.lines);
      return {
        id: i.id, number: i.invoice_number, clientId: s?.client ?? '?', client: s?.client ?? '?', store: s?.name ?? null, jobNumber: this.job(i.job_id)?.meta.job_number ?? null,
        date: (i.sent_at ?? i.created_at).slice(0, 10), due: i.due_date, totalCents: D.totals([{ qty: 1, unitPriceCents: ex }], i.vat_pct).totalCents,
        creditedCents: D.totals([{ qty: 1, unitPriceCents: this.creditedOn(i.id) }], i.vat_pct).totalCents,
      };
    });
  }
  holdOf(client: string | null | undefined) { return client ? this.d.holds?.[client] ?? null : null; }
  debtors(canHold: boolean) {
    const t = today();
    const a = DB.ageAnalysis(this.openInvoices(), t);
    const clients: Record<string, unknown>[] = a.clients.map(c => ({ ...c, pastelCode: this.d.clientCodes[c.client] ?? null, onHold: !!this.holdOf(c.client), holdReason: this.holdOf(c.client)?.reason ?? null }));
    for (const [n, h] of Object.entries(this.d.holds ?? {})) {
      if (!a.clients.some(c => c.client === n)) clients.push({ clientId: n, client: n, bands: Object.fromEntries(DB.AGE_BANDS.map(b => [b, 0])), total: 0, overdue: 0, invoices: 0, oldestDays: 0, pastelCode: this.d.clientCodes[n] ?? null, onHold: true, holdReason: h.reason });
    }
    return { today: t, totals: a.totals, clients, canHold };
  }
  debtor(id: string, canHold: boolean) {
    const t = today();
    const invoices = this.openInvoices().filter(i => i.client === id && DB.owing(i) > 0).map(i => ({
      ...i, owing: DB.owing(i), band: DB.ageBand(i.date, t), days: DB.daysBetween(i.date, t), overdueDays: i.due && i.due < t ? DB.daysBetween(i.due, t) : 0,
    }));
    const h = this.holdOf(id);
    return {
      client: { id, name: id, pastel_code: this.d.clientCodes[id] ?? null, email: null, phone: null, contact_name: null, on_hold: !!h, hold_reason: h?.reason ?? null, hold_at: h?.at ?? null, hold_by: h?.by ?? null },
      invoices, summary: DB.ageAnalysis(invoices, t).clients[0] ?? null, history: (this.d.holdLog ?? []).filter(x => x.client === id).slice().reverse(), canHold,
    };
  }
  setHold(client: string, on: boolean, reason: string | undefined, by: string): Res {
    if (on && (!reason || reason.trim().length < 3)) return bad(400, 'why the account is on hold (the office sees it when opening a job)');
    if (!on && !this.d.holds?.[client]) return bad(409, `${client} is not on hold`);
    if (on) (this.d.holds ??= {})[client] = { reason: reason!.trim(), by, at: new Date().toISOString() };
    else delete this.d.holds![client];
    (this.d.holdLog ??= []).push({ client, on_hold: on, reason: on ? reason!.trim() : null, job_number: null, by, at: new Date().toISOString() });
    return good({ id: client, onHold: on, reason: on ? reason!.trim() : null });
  }
  /** A job opened anyway while the client is on hold: on the record. */
  openedOnHold(client: string, jobNumber: number, by: string) {
    (this.d.holdLog ??= []).push({ client, on_hold: true, reason: `Job ${jobNumber} opened while on hold`, job_number: jobNumber, by, at: new Date().toISOString() });
  }
  /** Seeds two older unpaid invoices (for jobs made for it) so the debtors list shows its ages. */
  seedAged(make: (n: number, storeId: string, daysAgo: number) => string | null) {
    if (this.d.agedSeeded) return;
    this.d.agedSeeded = true;
    const add = (n: number, num: number, storeId: string, daysAgo: number, lines: D.DocLine[], ref: string) => {
      const jobId = make(n, storeId, daysAgo);
      if (!jobId) return;
      const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
      this.d.invoices.push({ id: nid('inv'), invoice_number: num, status: 'sent', job_id: jobId, notes: null, client_ref: ref, created_at: at, sent_at: at,
        due_date: addDays(at.slice(0, 10), 30), paid_at: null, paid_ref: null, cancel_note: null, created_by: 'Zanele Khoza', vat_pct: 15, pastel_batch_id: null,
        lines: lines.map(l => ({ ...l, id: nid('dl') })) });
    };
    add(10150, 6980, 'harbour', 47, [{ kind: 'labour', description: 'Labour, job 10150', qty: 2.5, unitPriceCents: 65000 }, { kind: 'call_out', description: 'Call-out', qty: 1, unitPriceCents: 45000 }], 'HD-2231');
    add(10131, 6955, 'esikhawini', 104, [{ kind: 'labour', description: 'Labour, job 10131', qty: 4, unitPriceCents: 65000 }, { kind: 'stock', description: 'Condenser fan motor 10W', qty: 1, unitPriceCents: 89000 }], 'BX-21980');
  }

  // ---- Profit per job -------------------------------------------------------------------------
  profit(from: string, to: string) {
    // The test drive starts with example cost figures (the CEO changes them under Company details and rates).
    if (this.d.rates.labour_cost_per_hour === undefined) this.d.rates.labour_cost_per_hour = 18_000;
    if (this.d.rates.vehicle_cost_per_km === undefined) this.d.rates.vehicle_cost_per_km = 450;
    const cr: PF.CostRates = { labourCostPerHourCents: this.d.rates.labour_cost_per_hour ?? 0, vehicleCostPerKmCents: this.d.rates.vehicle_cost_per_km ?? 0 };
    const jobs: PF.JobProfit[] = [];
    for (const j of this.src.jobs) {
      const closed = (j.closedAt ?? j.card.visits.at(-1)?.endedAt)?.slice(0, 10);
      if (j.card.status !== 'closed' || !closed || closed < from || closed > to) continue;
      const s = this.src.stores.find(x => x.id === j.meta.store_id);
      const invs = this.d.invoices.filter(i => i.job_id === j.meta.id && (i.status === 'sent' || i.status === 'paid'));
      const credited = (this.d.credits ?? []).filter(c => c.job_id === j.meta.id).reduce((n, c) => n + c.amount_cents, 0);
      const used = this.src.stockUsed(j.meta.job_number);
      const travel = this.src.travelOf?.(j.meta.id) ?? null;
      const people = 1 + (j.meta.helper_ids ?? []).length;
      jobs.push(PF.jobProfit({
        jobId: j.meta.id, jobNumber: j.meta.job_number, client: s?.client ?? '?', store: j.meta.store, technician: j.meta.lead_technician, month: closed.slice(0, 7), closed,
        revenueCents: invs.length ? invs.reduce((n, i) => n + this.exVat(i.lines), 0) - credited : null, noCharge: !!this.d.noCharge?.[j.meta.id],
        labourMinutes: (this.src.minutesOf(j.meta.id) + (travel?.minutes ?? 0)) * people, km: travel?.km ?? 0, kmEstimated: travel?.kmEstimated ?? false,
        partsCostCents: used.reduce((n, u) => n + Math.round(u.qty * (u.costCents ?? 0)), 0), partsWithoutCost: used.filter(u => u.costCents == null).length, boughtOutCents: 0,
      }, cr));
    }
    const counted = jobs.filter(x => x.profitCents !== null);
    const revenue = counted.reduce((n, x) => n + (x.noCharge ? 0 : x.revenueCents ?? 0), 0), cost = counted.reduce((n, x) => n + x.costCents, 0);
    return {
      from, to, rates: cr, ratesSet: !!(cr.labourCostPerHourCents && cr.vehicleCostPerKmCents),
      totals: { jobs: counted.length, notInvoiced: jobs.length - counted.length, revenueCents: revenue, costCents: cost, profitCents: revenue - cost, marginPct: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null },
      jobs, byClient: PF.groupProfit(jobs, 'client'), byTechnician: PF.groupProfit(jobs, 'technician'), byMonth: PF.groupProfit(jobs, 'month'),
    };
  }

  // ---- Each client's rates and mark-up -------------------------------------------------------
  private clientOf(storeId: string) { return this.src.stores.find(s => s.id === storeId)?.client ?? null; }
  /** How a job at this store is priced: its client's own rates, or the company's. */
  rulesFor(storeId: string): R.PriceRules {
    const c = this.clientOf(storeId);
    return R.priceRules(this.d.rates, c ? this.d.clientRates?.[c] ?? null : null);
  }
  clientRates(id: string, canEdit: boolean) {
    const own = this.d.clientRates?.[id] ?? null;
    return { client: { id, name: id, pastel_code: this.d.clientCodes[id] ?? null }, own: !!own, rates: own ?? R.startingRates(this.d.rates), company: this.d.rates, canEdit,
      labels: R.CLIENT_RATE_LABEL, updatedBy: null, updatedAt: null };
  }
  setClientRates(id: string, b: R.ClientRates): Res {
    if (!b?.rates || !b?.markup) return bad(400, 'the rates and the mark-up');
    const problems = R.ratesProblems(b);
    if (problems.length) return bad(400, ...problems);
    (this.d.clientRates ??= {})[id] = { rates: b.rates, markup: b.markup };
    return good({ id, own: true, rates: b });
  }
  clearClientRates(id: string): Res {
    if (!this.d.clientRates?.[id]) return bad(409, 'this client already uses the company rates');
    delete this.d.clientRates[id];
    return good({ id, own: false });
  }

  // ---- Sage Pastel --------------------------------------------------------------------------
  private creditDocs(): (P.PastelDoc & { id: string })[] {
    return (this.d.credits ?? []).filter(c => !c.pastel_batch_id).map(c => {
      const inv = this.d.invoices.find(i => i.id === c.invoice_id);
      const j = this.job(c.job_id);
      const s = j ? this.src.stores.find(x => x.id === j.meta.store_id) : null;
      return {
        id: c.id, kind: 'credit' as const, number: c.credit_number, customerCode: s ? this.d.clientCodes[s.client] ?? null : null, date: c.created_at.slice(0, 10), dueDate: null,
        orderNumber: `INV ${inv?.invoice_number ?? ''}`, message: `Credit on invoice ${inv?.invoice_number ?? ''}, job ${j?.meta.job_number ?? ''}. ${c.reason}`,
        deliverTo: [s?.name ?? '', ...(s?.address ?? '').split(/,\s*/)], contact: null, codeFor: 'credit' as const,
        lines: [{ kind: 'other' as const, description: `Credit inv ${inv?.invoice_number ?? ''}: ${c.reason}`, qty: 1, unitPriceCents: c.amount_cents }],
      };
    });
  }
  private pastelDocs(kind: 'invoice' | 'quote'): (P.PastelDoc & { id: string })[] {
    const list = kind === 'invoice'
      ? this.d.invoices.filter(i => (i.status === 'sent' || i.status === 'paid') && !i.pastel_batch_id).map(i => ({ id: i.id, number: i.invoice_number, date: (i.sent_at ?? i.created_at).slice(0, 10), due: i.due_date, ref: i.client_ref, notes: i.notes, job_id: i.job_id, store_id: null as string | null, lines: i.lines }))
      : this.d.quotes.filter(q => (q.status === 'sent' || q.status === 'accepted') && !q.pastel_batch_id).map(q => ({ id: q.id, number: q.quote_number, date: (q.sent_at ?? q.created_at).slice(0, 10), due: q.valid_until, ref: q.client_ref, notes: q.notes, job_id: q.job_id, store_id: q.store_id, lines: q.lines }));
    return list.map(x => {
      const s = this.storeOf(x);
      const jn = this.job(x.job_id)?.meta.job_number;
      return {
        id: x.id, kind, number: x.number, customerCode: s ? this.d.clientCodes[s.client] ?? null : null, date: x.date, dueDate: x.due, orderNumber: x.ref,
        message: [jn ? `Job ${jn}` : null, x.notes].filter(Boolean).join('. ') || null, deliverTo: [s?.name ?? '', ...(s?.address ?? '').split(/,\s*/)], contact: null,
        lines: x.lines.map(l => ({ ...l, stockCode: l.stockItemId ? this.src.stockCode(l.stockItemId)?.code ?? null : l.kind === 'stock' ? null : undefined, unit: l.stockItemId ? this.src.stockCode(l.stockItemId)?.unit ?? null : null })),
      };
    });
  }
  pastelSettings() { return { settings: this.d.pastel, lineTypes: P.LINE_TYPE_LABEL }; }
  setPastel(b: P.PastelSettings): Res {
    if (!(b.yearStartMonth >= 1 && b.yearStartMonth <= 12)) return bad(400, 'the month the financial year starts');
    if (!/^[0-9]{2}$/.test(b.taxType ?? '')) return bad(400, 'tax type is two digits, e.g. 01');
    this.d.pastel = { yearStartMonth: b.yearStartMonth, taxType: b.taxType, codes: b.codes ?? {}, store: b.store || null };
    return good({ settings: this.d.pastel });
  }
  clients() {
    // Real-data demo: every real customer, with or without stores in the demo.
    const names = [...new Set([...this.src.stores.map(s => s.client), ...(REAL?.clients.map(c => c.name) ?? [])])].sort((a, b) => a.localeCompare(b));
    return names.map(n => ({ id: n, name: n, pastel_code: this.d.clientCodes[n] ?? null, stores: this.src.stores.filter(s => s.client === n).length, own_rates: !!this.d.clientRates?.[n] }));
  }
  setClientCode(id: string, code: string | null): Res {
    const c = (code ?? '').trim().toUpperCase();
    if (c.length > 6) return bad(400, 'Pastel customer codes are at most 6 characters');
    const clash = Object.entries(this.d.clientCodes).find(([n, v]) => n !== id && v && v.toUpperCase() === c);
    if (c && clash) return bad(409, `${c} is already ${clash[0]}`);
    this.d.clientCodes[id] = c || null;
    return good({ id, code: c || null });
  }
  /** Supplier invoices come from the supplier invoice module (approved, not yet in Pastel). */
  private waiting(kind: P.PastelKind, suppliers?: { docs: () => (P.PastelDoc & { id: string })[] }) {
    return kind === 'credit' ? this.creditDocs() : kind === 'supplier_invoice' ? suppliers?.docs() ?? [] : this.pastelDocs(kind);
  }
  ready(kind: P.PastelKind, suppliers?: { docs: () => (P.PastelDoc & { id: string })[] }) {
    return this.waiting(kind, suppliers).map(d => ({ id: d.id, number: d.number, date: d.date, customerCode: d.customerCode, store: d.deliverTo[0] ?? null, reference: d.orderNumber, lines: d.lines.length, problems: P.missingForPastel(d, this.d.pastel) }));
  }
  batch(kind: P.PastelKind, by: string, suppliers?: { docs: () => (P.PastelDoc & { id: string })[]; mark: (ids: string[], batchId: string) => void }): Res {
    if (!['invoice', 'quote', 'credit', 'supplier_invoice'].includes(kind)) return bad(400, 'which kind of batch');
    const all = this.waiting(kind, suppliers);
    const ok = all.filter(d => !P.missingForPastel(d, this.d.pastel).length);
    const skipped = all.filter(d => !ok.includes(d)).map(d => ({ number: d.number, reasons: P.missingForPastel(d, this.d.pastel) }));
    if (!ok.length) return bad(409, ...(skipped.length ? skipped.map(x => `${x.number}: ${x.reasons.join('; ')}`) : [`no ${P.PASTEL_KIND_LABEL[kind].toLowerCase()} waiting to go to Pastel`]));
    const file = P.pastelFile(ok, this.d.pastel, Number(this.d.profile?.vat_pct ?? 15));
    const id = nid('pb');
    this.d.batches.unshift({ id, kind, numbers: ok.map(d => d.number), file, created_at: new Date().toISOString(), created_by: by });
    if (kind === 'supplier_invoice') suppliers?.mark(ok.map(d => d.id), id);
    for (const d of ok) {
      const doc = kind === 'invoice' ? this.d.invoices.find(i => i.id === d.id) : kind === 'quote' ? this.d.quotes.find(q => q.id === d.id) : kind === 'credit' ? (this.d.credits ?? []).find(c => c.id === d.id) : null;
      if (doc) doc.pastel_batch_id = id;
    }
    return good({ id, kind, numbers: ok.map(d => d.number), skipped, where: P.PASTEL_WHERE[kind], filename: `pastel-${kind.replace('_', '-')}s-${today()}-${id.slice(-6)}.csv`, file }, 201);
  }
  batches() { return this.d.batches.map(({ file: _f, ...b }) => b); }
  batchFile(id: string) { return this.d.batches.find(b => b.id === id)?.file ?? null; }
}
