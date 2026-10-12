// The demo's pretend stockroom: what's on the technician's name, booking out, supplier invoices and returns,
// following the same rules as the server (shared from server/src/core/stock.ts).
import * as S from '../../server/src/core/stock.ts';
import type { CatalogueLine, InventoryLine, JobStockLine, ReadLine, StockRequest, StockReturn, SupplierInvoice } from './types.ts';

export interface DemoStockState {
  items: { id: string; code: string; description: string; unit: string; supplierCode?: string | null; needsReview?: boolean }[];
  stockroom: Record<string, number>;
  holdings: { stockItemId: string; holdingJobId: string | null; qty: number }[];
  /** Per job: booked, used, returned per item. */
  jobLog: { jobId: string; stockItemId: string; booked: number; used: number; returned: number }[];
  invoices: SupplierInvoice[];
  returns: StockReturn[];
  requests?: StockRequest[];
  deliveries?: { supplierName: string; reference: string }[];
  nextNew: number;
}

export function seedStock(): DemoStockState {
  return {
    items: [
      { id: 'st-1', code: 'VALVE-01', description: 'Water inlet valve 24V', unit: 'each', supplierCode: 'WV-24' },
      { id: 'st-2', code: 'SEAL-04', description: 'Oven door seal 1/1', unit: 'each' },
      { id: 'st-3', code: 'GAS-R404', description: 'Refrigerant R404A', unit: 'kg' },
      { id: 'st-4', code: 'FUSE-10A', description: 'Fuse 10A', unit: 'each' },
      { id: 'st-5', code: 'CONT-25A', description: 'Contactor 25A 230V coil', unit: 'each' },
      { id: 'st-6', code: 'CAP-35UF', description: 'Run capacitor 35uF', unit: 'each' },
      { id: 'st-7', code: 'FAN-MTR', description: 'Condenser fan motor 10W', unit: 'each' },
    ],
    stockroom: { 'st-1': 12, 'st-2': 6, 'st-3': 20, 'st-4': 50, 'st-5': 8, 'st-6': 10, 'st-7': 4 },
    holdings: [
      { stockItemId: 'st-1', holdingJobId: null, qty: 2 },
      { stockItemId: 'st-2', holdingJobId: null, qty: 3 },
      { stockItemId: 'st-3', holdingJobId: null, qty: 4 },
      { stockItemId: 'st-4', holdingJobId: null, qty: 10 },
      // Left over from a job closed last week: must go back.
      { stockItemId: 'st-5', holdingJobId: 'job-10190', qty: 1 },
    ],
    jobLog: [{ jobId: 'job-10190', stockItemId: 'st-5', booked: 2, used: 1, returned: 0 }],
    invoices: [],
    returns: [],
    nextNew: 1001,
  };
}

/** What the pretend reader "sees" on any invoice photo in the demo. */
const DEMO_READ = {
  supplierName: 'Voltex Richards Bay', invoiceNumber: '', invoiceDate: null as string | null, totalCents: 66700, vatCents: 8700,
  lines: [
    { description: 'Run capacitor 35uF', supplierCode: 'RC35', qty: 2, unitPriceCents: 14500 },
    { description: 'Cable ties 300mm (pack of 100)', supplierCode: 'CT300', qty: 1, unitPriceCents: 9000 },
    { description: 'Insulation tape black', supplierCode: 'IT-BLK', qty: 4, unitPriceCents: 4500 },
  ] as ReadLine[],
};

type Res = { ok: true; body: unknown } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown): Res => ({ ok: true, body });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });

export class DemoStock {
  constructor(public s: DemoStockState, private jobInfo: (jobId: string) => { number: number; status: string; store: string } | null) {}

  private item(id: string) { return this.s.items.find(i => i.id === id); }
  private pending(stockItemId: string, holdingJobId: string | null) {
    return this.s.returns.filter(r => r.status === 'pending').flatMap(r => r.lines)
      .filter(l => l.stockItemId === stockItemId && l.holdingJobId === holdingJobId).reduce((n, l) => n + l.qty, 0);
  }
  private holdingsOf(stockItemId: string): S.Holding[] {
    return this.s.holdings.filter(h => h.stockItemId === stockItemId && h.qty > 0)
      .map(h => ({ holdingJobId: h.holdingJobId, qty: h.qty, pendingReturn: this.pending(stockItemId, h.holdingJobId) }));
  }
  private add(stockItemId: string, holdingJobId: string | null, qty: number) {
    const h = this.s.holdings.find(x => x.stockItemId === stockItemId && x.holdingJobId === holdingJobId);
    if (h) h.qty = S.round(h.qty + qty); else this.s.holdings.push({ stockItemId, holdingJobId, qty });
    this.s.holdings = this.s.holdings.filter(x => x.qty > 0);
  }
  private log(jobId: string, stockItemId: string, k: 'booked' | 'used' | 'returned', qty: number) {
    let l = this.s.jobLog.find(x => x.jobId === jobId && x.stockItemId === stockItemId);
    if (!l) { l = { jobId, stockItemId, booked: 0, used: 0, returned: 0 }; this.s.jobLog.push(l); }
    l[k] = S.round(l[k] + qty);
  }

  /** In the demo a scanned invoice is "read" 4 seconds after it arrives. */
  tick() {
    for (const i of this.s.invoices) {
      if (i.status === 'reading' && Date.now() - Date.parse(i.scanned_at) > 4_000) {
        const n = `INV-${Math.floor(70000 + Math.random() * 9999)}`;
        i.status = 'to_confirm';
        i.read_result = { ...DEMO_READ, invoiceNumber: n, invoiceDate: new Date().toLocaleDateString('en-CA') };
        i.supplier_name = DEMO_READ.supplierName; i.invoice_number = n; i.total_cents = DEMO_READ.totalCents;
      }
    }
  }

  inventory(): InventoryLine[] {
    return this.s.holdings.filter(h => h.qty > 0).map(h => {
      const it = this.item(h.stockItemId)!;
      const job = h.holdingJobId ? this.jobInfo(h.holdingJobId) : null;
      return {
        stockItemId: it.id, code: it.code, description: it.description, unit: it.unit, needsReview: !!it.needsReview,
        holdingJobId: h.holdingJobId, jobNumber: job?.number ?? null, jobStatus: job?.status ?? null, store: job?.store ?? null,
        qty: h.qty, pendingReturn: this.pending(h.stockItemId, h.holdingJobId), mustReturn: S.mustReturn(h.holdingJobId, job?.status ?? null),
      };
    }).sort((a, b) => Number(a.holdingJobId === null) - Number(b.holdingJobId === null) || (a.jobNumber ?? 0) - (b.jobNumber ?? 0) || a.code.localeCompare(b.code));
  }

  /** Same as the server's /me/stock: everything on my name, less what is on its way back. */
  totals() {
    const by = new Map<string, number>();
    for (const l of this.inventory()) by.set(l.stockItemId, (by.get(l.stockItemId) ?? 0) + l.qty - l.pendingReturn);
    return [...by].filter(([, q]) => q > 0).map(([id, qty]) => { const it = this.item(id)!; return { id, code: it.code, description: it.description, unit: it.unit, qty }; });
  }

  catalogue(): CatalogueLine[] {
    return this.s.items.filter(i => !i.needsReview).map(i => ({ id: i.id, code: i.code, description: i.description, unit: i.unit, inStockroom: this.s.stockroom[i.id] ?? 0 }));
  }

  jobStock(jobId: string): JobStockLine[] {
    return this.s.jobLog.filter(l => l.jobId === jobId).map(l => {
      const it = this.item(l.stockItemId)!;
      const on = this.s.holdings.find(h => h.stockItemId === l.stockItemId && h.holdingJobId === jobId)?.qty ?? 0;
      return { stockItemId: it.id, code: it.code, description: it.description, unit: it.unit, booked: l.booked, used: l.used, returned: l.returned, onTechnician: on, requested: this.asked(jobId, l.stockItemId) };
    }).concat(this.pendingOnly(jobId));
  }

  private asked(jobId: string, stockItemId: string) {
    return (this.s.requests ?? []).filter(r => r.job_id === jobId && r.status === 'pending').flatMap(r => r.lines)
      .filter(l => l.stockItemId === stockItemId).reduce((n, l) => n + l.qtyRequested, 0);
  }

  private pendingOnly(jobId: string): JobStockLine[] {
    const ids = new Set((this.s.requests ?? []).filter(r => r.job_id === jobId && r.status === 'pending').flatMap(r => r.lines.map(l => l.stockItemId)));
    return [...ids].filter(id => !this.s.jobLog.some(l => l.jobId === jobId && l.stockItemId === id)).map(id => {
      const it = this.item(id)!;
      return { stockItemId: id, code: it.code, description: it.description, unit: it.unit, booked: 0, used: 0, returned: 0, onTechnician: 0, requested: this.asked(jobId, id) };
    });
  }

  /** The technician asks; nothing moves until the stock controller issues it. */
  request(jobId: string, b: { id?: string; at: string; lines: { stockItemId: string; qty: number }[] }, job: { number: number; store: string }): Res {
    const short = b.lines.filter(l => (this.s.stockroom[l.stockItemId] ?? 0) < l.qty).map(l => `${this.item(l.stockItemId)?.code}: only ${this.s.stockroom[l.stockItemId] ?? 0} in the stockroom`);
    if (short.length) return bad(409, ...short);
    const id = b.id ?? `req-${Date.now()}`;
    (this.s.requests ??= []).push({
      id, technician_id: 'me', technician: 'Thabo Mkhize', job_id: jobId, job_number: job.number, store: job.store, status: 'pending',
      requested_at: new Date().toISOString(), decided_at: null, note: null,
      lines: b.lines.map((l, i) => { const it = this.item(l.stockItemId)!; return { lineId: `${id}-${i}`, stockItemId: it.id, code: it.code, description: it.description, unit: it.unit, qtyRequested: l.qty, qtyIssued: null, inStockroom: this.s.stockroom[it.id] ?? 0 }; }),
    });
    return good({ id, status: 'pending' });
  }

  requests(status?: string): StockRequest[] {
    return (this.s.requests ?? []).filter(r => !status || r.status === status)
      .map(r => ({ ...r, lines: r.lines.map(l => ({ ...l, inStockroom: this.s.stockroom[l.stockItemId] ?? 0 })) }));
  }

  issue(id: string, b: { lines: { lineId: string; qtyIssued: number }[]; note?: string }): Res {
    const r = (this.s.requests ?? []).find(x => x.id === id);
    if (!r) return bad(404, 'no such request');
    if (r.status !== 'pending') return bad(409, 'this request is already handled');
    const given = new Map(b.lines.map(l => [l.lineId, l.qtyIssued]));
    if (r.lines.some(l => !given.has(l.lineId))) return bad(400, 'tick every line: give the quantity issued (0 if none)');
    const problems: string[] = [];
    for (const l of r.lines) {
      const g = given.get(l.lineId)!;
      if (g > l.qtyRequested) problems.push(`${l.code}: more than was asked for (${l.qtyRequested})`);
      else if (g > (this.s.stockroom[l.stockItemId] ?? 0)) problems.push(`${l.code}: only ${this.s.stockroom[l.stockItemId] ?? 0} in the stockroom`);
    }
    if (problems.length) return bad(409, ...problems);
    if ([...given.values()].every(q => q === 0)) return bad(409, 'nothing issued: reject the request instead, with a reason');
    for (const l of r.lines) {
      const g = given.get(l.lineId)!;
      l.qtyIssued = g;
      if (g > 0) {
        this.s.stockroom[l.stockItemId] -= g;
        this.add(l.stockItemId, r.job_id, g);
        if (r.job_id) this.log(r.job_id, l.stockItemId, 'booked', g);
      }
    }
    Object.assign(r, { status: 'issued', decided_at: new Date().toISOString(), note: b.note ?? null });
    return good({ id, status: 'issued', short: r.lines.filter(l => (l.qtyIssued ?? 0) < l.qtyRequested).map(l => l.code) });
  }

  reject(id: string, reason: string): Res {
    const r = (this.s.requests ?? []).find(x => x.id === id);
    if (!r) return bad(404, 'no such request');
    if (r.status !== 'pending') return bad(409, 'this request is already handled');
    if (!reason || reason.trim().length < 5) return bad(400, 'say why the request is rejected');
    Object.assign(r, { status: 'rejected', decided_at: new Date().toISOString(), note: reason.trim() });
    return good({ id, status: 'rejected' });
  }

  receive(id: string, b: { lines: { lineId: string; qtyReceived: number }[] }): Res {
    const r = this.s.returns.find(x => x.id === id);
    if (!r) return bad(404, 'no such return');
    if (r.status !== 'pending') return bad(409, 'this return is already received');
    const given = new Map(b.lines.map(l => [l.lineId, l.qtyReceived]));
    if (r.lines.some(l => !given.has(l.lineId))) return bad(400, 'give the received quantity for every line of this return');
    const short: { code: string; expected: number; received: number }[] = [];
    for (const l of r.lines) {
      const got = given.get(l.lineId)!;
      if (got > l.qty) return bad(409, `${l.code}: more received than was returned (${l.qty})`);
    }
    for (const l of r.lines) {
      const got = given.get(l.lineId)!;
      l.qtyReceived = got;
      if (got > 0) {
        this.add(l.stockItemId, l.holdingJobId, -got);
        this.s.stockroom[l.stockItemId] = (this.s.stockroom[l.stockItemId] ?? 0) + got;
        if (l.holdingJobId) this.log(l.holdingJobId, l.stockItemId, 'returned', got);
      }
      if (got < l.qty) short.push({ code: l.code, expected: l.qty, received: got });
    }
    Object.assign(r, { status: 'received', received_at: new Date().toISOString() });
    return good({ id, status: 'received', short });
  }

  stockroomList() {
    return this.s.items.map(i => ({
      id: i.id, code: i.code, description: i.description, unit: i.unit, needsReview: !!i.needsReview, supplierCode: i.supplierCode ?? null,
      inStockroom: this.s.stockroom[i.id] ?? 0,
      withTechnicians: this.s.holdings.filter(h => h.stockItemId === i.id).reduce((n, h) => n + h.qty, 0),
    })).sort((a, b) => Number(b.needsReview) - Number(a.needsReview) || a.code.localeCompare(b.code));
  }

  nameItem(id: string, b: { code: string; description: string; unit: string }): Res {
    const it = this.item(id);
    if (!it) return bad(404, 'no such item');
    if (this.s.items.some(x => x.id !== id && x.code.toLowerCase() === b.code.trim().toLowerCase())) return bad(409, `code ${b.code} is already used`);
    Object.assign(it, { code: b.code.trim(), description: b.description.trim(), unit: b.unit.trim(), needsReview: false });
    return good({ id, ...b, needsReview: false });
  }

  delivery(b: { supplierName: string; reference: string; lines: { stockItemId: string; qty: number }[] }): Res {
    const d = (this.s.deliveries ??= []);
    if (d.some(x => x.supplierName.toLowerCase() === b.supplierName.toLowerCase() && x.reference.toLowerCase() === b.reference.toLowerCase())) {
      return bad(409, `delivery ${b.reference} from ${b.supplierName} was already received`);
    }
    d.push({ supplierName: b.supplierName, reference: b.reference });
    for (const l of b.lines) this.s.stockroom[l.stockItemId] = (this.s.stockroom[l.stockItemId] ?? 0) + l.qty;
    return good({ id: `del-${Date.now()}` });
  }

  overview() {
    return {
      toIssue: (this.s.requests ?? []).filter(r => r.status === 'pending').length,
      toReceive: this.s.returns.filter(r => r.status === 'pending').length,
      newItems: this.s.items.filter(i => i.needsReview).length,
      invoicesToday: this.s.invoices.filter(i => i.status === 'confirmed').length,
    };
  }

  use(jobId: string, stockItemId: string, qty: number): Res {
    const plan = S.drawPlan(this.holdingsOf(stockItemId), qty, jobId);
    if (!plan.ok) return bad(409, `only ${plan.have} on your name; book it out from the stockroom, or add it under Bought out if you bought it`);
    for (const t of plan.take) this.add(stockItemId, t.holdingJobId, -t.qty);
    this.log(jobId, stockItemId, 'used', qty);
    return good({});
  }

  scanInvoice(b: { id?: string; photoId: string; jobId?: string; at: string }): Res {
    const inv: SupplierInvoice = {
      id: b.id ?? `inv-${Date.now()}`, status: 'reading', job_id: b.jobId ?? null, supplier_name: null, invoice_number: null, invoice_date: null,
      total_cents: null, scanned_at: new Date().toISOString(), confirmed_at: null, read_result: null, read_error: null,
    };
    this.s.invoices.unshift(inv);
    return good({ id: inv.id, status: 'reading' });
  }

  confirmInvoice(id: string, b: { supplierName: string; invoiceNumber: string; invoiceDate?: string; totalCents?: number | null; jobId?: string | null; lines: (S.InvoiceLine & { stockItemId?: string })[] }): Res {
    const inv = this.s.invoices.find(i => i.id === id);
    if (!inv) return bad(404, 'no such invoice of yours');
    if (inv.status === 'reading') return bad(409, 'still reading this invoice; try again in a moment');
    if (inv.status === 'confirmed') return bad(409, 'this invoice is already confirmed');
    const problems = S.invoiceProblems(b);
    if (problems.length) return bad(409, ...problems);
    const dup = this.s.invoices.find(i => i.status === 'confirmed' && i.supplier_name?.toLowerCase() === b.supplierName.toLowerCase() && i.invoice_number?.toLowerCase() === b.invoiceNumber.toLowerCase());
    if (dup) return bad(409, `invoice ${b.invoiceNumber} from ${b.supplierName} was already booked by you`);
    const jobId = b.jobId === undefined ? inv.job_id : b.jobId;
    const newItems: string[] = [];
    for (const l of b.lines) {
      let itemId = l.stockItemId ?? S.matchItem(l, this.s.items)?.id;
      if (!itemId) {
        const code = `NEW-${this.s.nextNew++}`;
        itemId = `st-new-${code}`;
        this.s.items.push({ id: itemId, code, description: l.description, unit: 'each', supplierCode: l.supplierCode ?? null, needsReview: true });
        newItems.push(`${code} ${l.description}`);
      }
      this.add(itemId, jobId, l.qty);
      if (jobId) this.log(jobId, itemId, 'booked', l.qty);
    }
    Object.assign(inv, { status: 'confirmed', confirmed_at: new Date().toISOString(), supplier_name: b.supplierName, invoice_number: b.invoiceNumber, total_cents: b.totalCents ?? null, job_id: jobId });
    return good({ id, status: 'confirmed', newItems });
  }

  sendReturn(b: { id?: string; at: string; lines: { stockItemId: string; holdingJobId: string | null; qty: number }[] }): Res {
    const problems: string[] = [];
    for (const l of b.lines) {
      const h = this.holdingsOf(l.stockItemId).find(x => x.holdingJobId === l.holdingJobId);
      const max = h ? S.available(h) : 0;
      if (max + 1e-9 < l.qty) problems.push(`${this.item(l.stockItemId)?.code}: you can return at most ${max}`);
    }
    if (problems.length) return bad(409, ...problems);
    const r: StockReturn = {
      id: b.id ?? `ret-${Date.now()}`, technician: 'Thabo Mkhize', status: 'pending', requested_at: new Date().toISOString(), received_at: null, note: null,
      lines: b.lines.map((l, i) => {
        const it = this.item(l.stockItemId)!;
        return { lineId: `rl-${Date.now()}-${i}`, stockItemId: it.id, code: it.code, description: it.description, holdingJobId: l.holdingJobId,
          jobNumber: l.holdingJobId ? this.jobInfo(l.holdingJobId)?.number ?? null : null, qty: l.qty, qtyReceived: null };
      }),
    };
    this.s.returns.unshift(r);
    return good({ id: r.id, status: 'pending' });
  }
}
