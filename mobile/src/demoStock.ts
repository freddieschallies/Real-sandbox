// The demo's pretend stockroom: what's on the technician's name, booking out, supplier invoices and returns,
// following the same rules as the server (shared from server/src/core/stock.ts).
import * as S from '../../server/src/core/stock.ts';
import type { CatalogueLine, InventoryLine, JobStockLine, ReadLine, StockRequest, StockReturn, SupplierInvoice } from './types.ts';

export interface Activity { id: string; at: string; kind: string; what: string; qty: number; code: string; description: string; unit: string; technician: string | null; by: string; byStandIn?: string | null; jobNumber: number | null; store: string | null; unitCostCents: number | null; reference: string | null }
export interface Holding { technicianId: string; technician: string; stockItemId: string; code: string; description: string; unit: string; holdingJobId: string | null; jobNumber: number | null; jobStatus: string | null; store: string | null; qty: number; pendingReturn: number; mustReturn: boolean }

const ME = 'Thabo Mkhize';
const WHAT: Record<string, string> = {
  assign: 'Issued from stockroom', use_on_job: 'Used on job card', return: 'Returned to stockroom', supplier_invoice: 'Bought on supplier invoice', receive: 'Delivery into stockroom',
  issue_kit: 'Issued by name (tool / PPE)', return_kit: 'Tool / PPE returned',
};

export interface DemoKit {
  id: string; userId: string; kind: 'tool' | 'ppe'; name: string; detail: string | null; qty: number; stockItemId: string | null; replaceBy: string | null;
  issuedAt: string; issuedBy: string; status: 'issued' | 'returned' | 'lost' | 'damaged'; closedAt: string | null; closedBy: string | null; closeNote: string | null;
}
const KIT_ITEMS: DemoStockState['items'] = [
  { id: 'st-8', code: 'PPE-BOOT', description: 'Safety boots', unit: 'pair', category: 'ppe', minQty: 3 },
  { id: 'st-9', code: 'PPE-GLOVE', description: 'Work gloves', unit: 'pair', category: 'ppe', minQty: 10 },
  { id: 'st-10', code: 'PPE-GLASS', description: 'Safety glasses', unit: 'each', category: 'ppe' },
  { id: 'st-11', code: 'PPE-OVR', description: 'Overall (2-piece)', unit: 'each', category: 'ppe' },
  { id: 'st-12', code: 'TL-METER', description: 'Clamp multimeter', unit: 'each', category: 'tool' },
  { id: 'st-13', code: 'TL-GAUGE', description: 'Manifold gauge set R404A', unit: 'set', category: 'tool' },
  { id: 'st-14', code: 'TL-DRILL', description: 'Cordless drill 18V', unit: 'each', category: 'tool' },
];
const KIT_STOCK: Record<string, number> = { 'st-8': 4, 'st-9': 24, 'st-10': 10, 'st-11': 6, 'st-12': 2, 'st-13': 1, 'st-14': 3 };
function seedKit(): DemoKit[] {
  const d = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const k = (id: string, userId: string, kind: 'tool' | 'ppe', name: string, detail: string | null, stockItemId: string | null, days: number, replaceBy: string | null = null): DemoKit =>
    ({ id, userId, kind, name, detail, qty: 1, stockItemId, replaceBy, issuedAt: d(days), issuedBy: 'Lindiwe Zulu', status: 'issued', closedAt: null, closedBy: null, closeNote: null });
  return [
    k('kit-1', 'me', 'ppe', 'Safety boots', 'Size 9', 'st-8', 300, '2027-04-01'),
    k('kit-2', 'me', 'ppe', 'Overall (2-piece)', 'Size L', 'st-11', 120),
    k('kit-3', 'me', 'tool', 'Clamp multimeter', 'Serial FL-44718', 'st-12', 400),
    k('kit-4', 'me', 'tool', 'Manifold gauge set R404A', null, 'st-13', 200),
    k('kit-5', 'tech-2', 'ppe', 'Safety boots', 'Size 10', 'st-8', 420, new Date(Date.now() - 5 * 86_400_000).toLocaleDateString('en-CA')),
    k('kit-6', 'tech-2', 'tool', 'Cordless drill 18V', 'Makita, serial 8812', 'st-14', 90),
    k('kit-7', 'tech-3', 'ppe', 'Safety glasses', null, 'st-10', 30),
  ];
}

export interface DemoStockState {
  items: {
    id: string; code: string; description: string; unit: string; supplierCode?: string | null; needsReview?: boolean;
    minQty?: number; reorderQty?: number | null; photoId?: string | null; supplierName?: string | null;
    ordered?: { at: string; qty: number; note: string | null; by: string } | null; sellingPriceCents?: number | null; category?: 'stock' | 'tool' | 'ppe';
    /** What it last cost (excl. VAT), from an approved supplier invoice: the clients' mark-up is on this. */
    costCents?: number | null;
  }[];
  /** Tools and PPE on each person's name. */
  kit?: DemoKit[];
  vanSeeded?: boolean;
  stockroom: Record<string, number>;
  /** tech: 'me' (Thabo, the demo technician) or another technician's name. */
  holdings: { stockItemId: string; holdingJobId: string | null; qty: number; tech?: string }[];
  activity?: Activity[];
  /** Per job: booked, used, returned per item. */
  jobLog: { jobId: string; stockItemId: string; booked: number; used: number; returned: number }[];
  invoices: SupplierInvoice[];
  returns: StockReturn[];
  requests?: StockRequest[];
  deliveries?: { supplierName: string; reference: string }[];
  nextNew: number;
}

/** Selling prices (excl. VAT) for the seeded items; filled in on older test drives too. */
const SEED_PRICES: Record<string, number> = { 'st-1': 32_000, 'st-2': 185_000, 'st-3': 42_000, 'st-4': 1_500, 'st-5': 38_500, 'st-6': 26_000, 'st-7': 89_000 };

export function seedStock(): DemoStockState {
  return {
    items: [
      { id: 'st-1', code: 'VALVE-01', description: 'Water inlet valve 24V', unit: 'each', supplierCode: 'WV-24', minQty: 6, reorderQty: 10, supplierName: 'Scotsman Parts SA' },
      { id: 'st-2', code: 'SEAL-04', description: 'Oven door seal 1/1', unit: 'each' },
      { id: 'st-3', code: 'GAS-R404', description: 'Refrigerant R404A', unit: 'kg', minQty: 10, supplierName: 'Refrigeration Wholesalers' },
      { id: 'st-4', code: 'FUSE-10A', description: 'Fuse 10A', unit: 'each', minQty: 60, reorderQty: 100, supplierName: 'Voltex Richards Bay' },
      { id: 'st-5', code: 'CONT-25A', description: 'Contactor 25A 230V coil', unit: 'each', minQty: 10, reorderQty: 10, supplierName: 'Voltex Richards Bay' },
      { id: 'st-6', code: 'CAP-35UF', description: 'Run capacitor 35uF', unit: 'each' },
      { id: 'st-7', code: 'FAN-MTR', description: 'Condenser fan motor 10W', unit: 'each', minQty: 5, supplierName: 'Refrigeration Wholesalers', ordered: { at: new Date(Date.now() - 26 * 3600_000).toISOString(), qty: 4, note: 'RW order 88120', by: 'Lindiwe Zulu' } },
    ],
    stockroom: { 'st-1': 12, 'st-2': 6, 'st-3': 20, 'st-4': 50, 'st-5': 8, 'st-6': 10, 'st-7': 4 },
    holdings: [
      { stockItemId: 'st-1', holdingJobId: null, qty: 2 },
      { stockItemId: 'st-2', holdingJobId: null, qty: 3 },
      { stockItemId: 'st-3', holdingJobId: null, qty: 4 },
      { stockItemId: 'st-4', holdingJobId: null, qty: 10 },
      // Left over from a job closed last week: must go back.
      { stockItemId: 'st-5', holdingJobId: 'job-10190', qty: 1 },
      // Another technician, so the stock controller sees more than one person.
      { stockItemId: 'st-3', holdingJobId: null, qty: 6, tech: 'Sipho Ndlovu' },
      { stockItemId: 'st-4', holdingJobId: null, qty: 8, tech: 'Sipho Ndlovu' },
      { stockItemId: 'st-7', holdingJobId: 'job-10220', qty: 1, tech: 'Sipho Ndlovu' },
      { stockItemId: 'st-6', holdingJobId: 'job-10220', qty: 2, tech: 'Sipho Ndlovu' },
    ],
    activity: [
      { id: 'a-1', at: new Date(Date.now() - 3 * 3600_000).toISOString(), kind: 'assign', what: WHAT.assign, qty: 2, code: 'CAP-35UF', description: 'Run capacitor 35uF', unit: 'each', technician: 'Sipho Ndlovu', by: 'Lindiwe Zulu', jobNumber: 10220, store: 'Boxer Esikhawini', unitCostCents: null, reference: null },
      { id: 'a-2', at: new Date(Date.now() - 2 * 3600_000).toISOString(), kind: 'use_on_job', what: WHAT.use_on_job, qty: 1, code: 'FAN-MTR', description: 'Condenser fan motor 10W', unit: 'each', technician: 'Sipho Ndlovu', by: 'Sipho Ndlovu', jobNumber: 10220, store: 'Boxer Esikhawini', unitCostCents: null, reference: null },
    ],
    jobLog: [{ jobId: 'job-10190', stockItemId: 'st-5', booked: 2, used: 1, returned: 0 }],
    invoices: [],
    returns: [],
    requests: [{
      id: 'req-seed-1', technician_id: 'sipho', technician: 'Sipho Ndlovu', job_id: 'job-10220', job_number: 10220, store: 'Boxer Esikhawini',
      status: 'issued', requested_at: new Date(Date.now() - 3.2 * 3600_000).toISOString(), decided_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      decided_by: 'Lindiwe Zulu', note: null,
      lines: [
        { lineId: 'req-seed-1-0', stockItemId: 'st-6', code: 'CAP-35UF', description: 'Run capacitor 35uF', unit: 'each', qtyRequested: 2, qtyIssued: 2, inStockroom: 10 },
        { lineId: 'req-seed-1-1', stockItemId: 'st-7', code: 'FAN-MTR', description: 'Condenser fan motor 10W', unit: 'each', qtyRequested: 2, qtyIssued: 1, inStockroom: 4 },
      ],
    }],
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
  constructor(public s: DemoStockState, private jobInfo: (jobId: string) => { number: number; status: string; store: string } | null) {
    for (const i of s.items) if (i.sellingPriceCents === undefined && SEED_PRICES[i.id] !== undefined) i.sellingPriceCents = SEED_PRICES[i.id];
    // Older saved demos: add the tools and PPE.
    if (!s.items.some(i => i.category === 'ppe')) { s.items.push(...KIT_ITEMS.filter(k => !s.items.some(i => i.id === k.id))); Object.assign(s.stockroom, KIT_STOCK); }
    s.kit ??= seedKit();
    // Sipho's van is complete against the Foodservice van stock list.
    if (!s.vanSeeded) {
      s.holdings.push(...[['st-1', 2], ['st-2', 2], ['st-5', 1], ['st-6', 2]].map(([id, qty]) => ({ stockItemId: id as string, holdingJobId: null, qty: qty as number, tech: 'Sipho Ndlovu' })));
      s.vanSeeded = true;
    }
  }

  // ---- Tools and PPE ------------------------------------------------------------------------
  kitFor(userId: string, canWrite: boolean) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
    const view = (k: DemoKit) => ({ id: k.id, kind: k.kind, name: k.name, detail: k.detail, qty: k.qty, stock_item_id: k.stockItemId, stock_code: k.stockItemId ? this.item(k.stockItemId)?.code ?? null : null,
      replace_by: k.replaceBy, issued_at: k.issuedAt, issued_by: k.issuedBy, status: k.status, closed_at: k.closedAt, closed_by: k.closedBy, close_note: k.closeNote, due: !!k.replaceBy && k.replaceBy <= today });
    const mine = (this.s.kit ?? []).filter(k => k.userId === userId);
    const held = mine.filter(k => k.status === 'issued').map(view).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    return { held, history: mine.filter(k => k.status !== 'issued').map(view).sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? '')), dueForReplacement: held.filter(k => k.due).length, canWrite };
  }
  kitPeople(people: { id: string; full_name: string; login_level: string; position: string; tradeLabel: string | null; photo_id: string | null }[]) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
    return people.map(p => {
      const h = (this.s.kit ?? []).filter(k => k.userId === p.id && k.status === 'issued');
      const stock = this.s.holdings.filter(x => x.qty > 0 && ((x.tech ?? 'me') === p.id || x.tech === p.full_name)).reduce((n, x) => n + x.qty, 0);
      return { id: p.id, full_name: p.full_name, login_level: p.login_level, position: p.position, tradeLabel: p.tradeLabel, photo_id: p.photo_id,
        tools: h.filter(k => k.kind === 'tool').length, ppe: h.filter(k => k.kind === 'ppe').length, stock, due: h.filter(k => k.replaceBy && k.replaceBy <= today).length };
    }).sort((a, b) => Number(b.login_level === 'technician') - Number(a.login_level === 'technician') || a.full_name.localeCompare(b.full_name));
  }
  issueKit(userId: string, who: string, by: string, b: { kind: 'tool' | 'ppe'; name?: string; detail?: string; qty?: number; stockItemId?: string; replaceBy?: string }): Res {
    const qty = b.qty ?? 1;
    let name = b.name?.trim();
    if (b.stockItemId) {
      const it = this.item(b.stockItemId);
      if (!it) return bad(404, 'no such stock item');
      const cat = it.category ?? 'stock';
      if (cat !== b.kind) return bad(409, `${it.description} is ${cat === 'stock' ? 'stock (parts for jobs)' : cat === 'ppe' ? 'PPE' : 'a tool'}, not ${b.kind === 'ppe' ? 'PPE' : 'a tool'}`);
      const have = this.s.stockroom[it.id] ?? 0;
      if (have < qty) return bad(409, `only ${have} in the stockroom`);
      this.s.stockroom[it.id] = have - qty;
      name ??= it.description;
      this.record('issue_kit', it.id, qty, who, by, null);
    }
    if (!name || name.length < 2) return bad(400, 'what the item is');
    if (b.replaceBy && !/^\d{4}-\d{2}-\d{2}$/.test(b.replaceBy)) return bad(400, 'replace-by date must look like 2027-03-31');
    const id = `kit-${Date.now()}`;
    (this.s.kit ??= []).push({ id, userId, kind: b.kind, name, detail: b.detail?.trim() || null, qty, stockItemId: b.stockItemId ?? null, replaceBy: b.replaceBy ?? null,
      issuedAt: new Date().toISOString(), issuedBy: by, status: 'issued', closedAt: null, closedBy: null, closeNote: null });
    return good({ id });
  }
  closeKit(kitId: string, by: string, who: string, b: { status: 'returned' | 'lost' | 'damaged'; note?: string }): Res {
    const k = (this.s.kit ?? []).find(x => x.id === kitId);
    if (!k) return bad(404, 'no such item');
    if (k.status !== 'issued') return bad(409, `this item is already ${k.status}`);
    if (b.status !== 'returned' && (!b.note || b.note.trim().length < 5)) return bad(400, `say how it was ${b.status}`);
    Object.assign(k, { status: b.status, closedAt: new Date().toISOString(), closedBy: by, closeNote: b.note?.trim() || null });
    if (b.status === 'returned' && k.stockItemId) { this.s.stockroom[k.stockItemId] = (this.s.stockroom[k.stockItemId] ?? 0) + k.qty; this.record('return_kit', k.stockItemId, k.qty, who, by, null); }
    return good({ id: kitId, status: b.status });
  }
  userOfKit(kitId: string) { return (this.s.kit ?? []).find(x => x.id === kitId)?.userId ?? null; }

  private item(id: string) { return this.s.items.find(i => i.id === id); }
  private pending(stockItemId: string, holdingJobId: string | null) {
    return this.s.returns.filter(r => r.status === 'pending').flatMap(r => r.lines)
      .filter(l => l.stockItemId === stockItemId && l.holdingJobId === holdingJobId).reduce((n, l) => n + l.qty, 0);
  }
  private mine() { return this.s.holdings.filter(h => (h.tech ?? 'me') === 'me'); }

  private record(kind: string, stockItemId: string, qty: number, technician: string | null, by: string, jobId: string | null, reference: string | null = null, unitCostCents: number | null = null) {
    const it = this.item(stockItemId)!;
    const job = jobId ? this.jobInfo(jobId) : null;
    (this.s.activity ??= []).unshift({ id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), kind, what: WHAT[kind] ?? kind,
      qty, code: it.code, description: it.description, unit: it.unit, technician, by, jobNumber: job?.number ?? null, store: job?.store ?? null, unitCostCents, reference });
    this.s.activity = this.s.activity.slice(0, 300);
  }

  activity(): Activity[] { return [...(this.s.activity ?? [])].sort((a, b) => b.at.localeCompare(a.at)); }

  /** Everything that is out with technicians, for the stock controller. */
  allHoldings(): Holding[] {
    return this.s.holdings.filter(h => h.qty > 0).map(h => {
      const it = this.item(h.stockItemId)!;
      const job = h.holdingJobId ? this.jobInfo(h.holdingJobId) : null;
      const tech = h.tech ?? 'me';
      return {
        technicianId: tech, technician: tech === 'me' ? ME : tech, stockItemId: it.id, code: it.code, description: it.description, unit: it.unit,
        holdingJobId: h.holdingJobId, jobNumber: job?.number ?? null, jobStatus: job?.status ?? null, store: job?.store ?? null, qty: h.qty,
        pendingReturn: tech === 'me' ? this.pending(h.stockItemId, h.holdingJobId) : 0, mustReturn: S.mustReturn(h.holdingJobId, job?.status ?? null),
      };
    }).sort((a, b) => a.technician.localeCompare(b.technician) || (a.jobNumber ?? 1e9) - (b.jobNumber ?? 1e9) || a.code.localeCompare(b.code));
  }

  private holdingsOf(stockItemId: string): S.Holding[] {
    return this.mine().filter(h => h.stockItemId === stockItemId && h.qty > 0)
      .map(h => ({ holdingJobId: h.holdingJobId, qty: h.qty, pendingReturn: this.pending(stockItemId, h.holdingJobId) }));
  }
  private add(stockItemId: string, holdingJobId: string | null, qty: number) {
    const h = this.mine().find(x => x.stockItemId === stockItemId && x.holdingJobId === holdingJobId);
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
    return this.mine().filter(h => h.qty > 0).map(h => {
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
    return this.s.items.filter(i => !i.needsReview && (i.category ?? 'stock') === 'stock').map(i => ({ id: i.id, code: i.code, description: i.description, unit: i.unit, inStockroom: this.s.stockroom[i.id] ?? 0 }));
  }

  jobStock(jobId: string): JobStockLine[] {
    return this.s.jobLog.filter(l => l.jobId === jobId).map(l => {
      const it = this.item(l.stockItemId)!;
      const on = this.mine().find(h => h.stockItemId === l.stockItemId && h.holdingJobId === jobId)?.qty ?? 0;
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
    const kit = b.lines.map(l => this.item(l.stockItemId)).filter(i => i && (i.category ?? 'stock') !== 'stock');
    if (kit.length) return bad(409, ...kit.map(i => `${i!.code} is a tool or PPE: the stockroom issues it to you by name, not to a job`));
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
      .sort((a, b) => (status && status !== 'pending' ? (b.decided_at ?? '').localeCompare(a.decided_at ?? '') : a.requested_at.localeCompare(b.requested_at)))
      .map(r => ({ ...r, lines: r.lines.map(l => ({ ...l, inStockroom: this.s.stockroom[l.stockItemId] ?? 0 })) }));
  }

  /** `by` issues it; `standIn` is their position when they stand in for the stock controller (e.g. "Admin"). */
  issue(id: string, b: { lines: { lineId: string; qtyIssued: number }[]; note?: string }, by = 'Lindiwe Zulu', standIn: string | null = null): Res {
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
        this.record('assign', l.stockItemId, g, r.technician ?? ME, by, r.job_id);
        if (standIn) this.s.activity![0].byStandIn = standIn;
      }
    }
    Object.assign(r, { status: 'issued', decided_at: new Date().toISOString(), decided_by: by, decidedByStandIn: standIn, note: b.note ?? null });
    return good({ id, status: 'issued', short: r.lines.filter(l => (l.qtyIssued ?? 0) < l.qtyRequested).map(l => l.code) });
  }

  reject(id: string, reason: string, by = 'Lindiwe Zulu', standIn: string | null = null): Res {
    const r = (this.s.requests ?? []).find(x => x.id === id);
    if (!r) return bad(404, 'no such request');
    if (r.status !== 'pending') return bad(409, 'this request is already handled');
    if (!reason || reason.trim().length < 5) return bad(400, 'say why the request is rejected');
    Object.assign(r, { status: 'rejected', decided_at: new Date().toISOString(), decided_by: by, decidedByStandIn: standIn, note: reason.trim() });
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
        this.record('return', l.stockItemId, got, ME, 'Lindiwe Zulu', l.holdingJobId);
      }
      if (got < l.qty) short.push({ code: l.code, expected: l.qty, received: got });
    }
    Object.assign(r, { status: 'received', received_at: new Date().toISOString() });
    return good({ id, status: 'received', short });
  }

  stockroomList() {
    return this.s.items.map(i => ({
      id: i.id, code: i.code, description: i.description, unit: i.unit, needsReview: !!i.needsReview, supplierCode: i.supplierCode ?? null, category: i.category ?? 'stock',
      onNames: (this.s.kit ?? []).filter(k => k.stockItemId === i.id && k.status === 'issued').reduce((n, k) => n + k.qty, 0),
      inStockroom: this.s.stockroom[i.id] ?? 0,
      withTechnicians: this.s.holdings.filter(h => h.stockItemId === i.id).reduce((n, h) => n + h.qty, 0),
      minQty: i.minQty ?? 0, reorderQty: i.reorderQty ?? null, photoId: i.photoId ?? null, supplierName: i.supplierName ?? null,
      belowMin: (i.minQty ?? 0) > 0 && (this.s.stockroom[i.id] ?? 0) < (i.minQty ?? 0), ordered: i.ordered ?? null,
      lastUsed: (() => { const a = (this.s.activity ?? []).filter(x => x.code === i.code && x.kind === 'use_on_job').sort((x, y) => y.at.localeCompare(x.at))[0];
        return a ? { at: a.at, kind: a.kind, qty: a.qty, jobNumber: a.jobNumber, store: a.store, technician: a.technician, vehicle: null } : null; })(),
    })).sort((a, b) => Number(b.needsReview) - Number(a.needsReview) || a.code.localeCompare(b.code));
  }

  nameItem(id: string, b: { code: string; description: string; unit: string; category?: 'stock' | 'tool' | 'ppe' }): Res {
    const it = this.item(id);
    if (!it) return bad(404, 'no such item');
    if (this.s.items.some(x => x.id !== id && x.code.toLowerCase() === b.code.trim().toLowerCase())) return bad(409, `code ${b.code} is already used`);
    Object.assign(it, { code: b.code.trim(), description: b.description.trim(), unit: b.unit.trim(), needsReview: false, ...(b.category ? { category: b.category } : {}) });
    return good({ id, ...b, needsReview: false });
  }

  delivery(b: { supplierName: string; reference: string; lines: { stockItemId: string; qty: number }[] }): Res {
    const d = (this.s.deliveries ??= []);
    if (d.some(x => x.supplierName.toLowerCase() === b.supplierName.toLowerCase() && x.reference.toLowerCase() === b.reference.toLowerCase())) {
      return bad(409, `delivery ${b.reference} from ${b.supplierName} was already received`);
    }
    d.push({ supplierName: b.supplierName, reference: b.reference });
    for (const l of b.lines) {
      this.s.stockroom[l.stockItemId] = (this.s.stockroom[l.stockItemId] ?? 0) + l.qty;
      this.record('receive', l.stockItemId, l.qty, null, 'Lindiwe Zulu', null, `${b.supplierName} ${b.reference}`);
      const it = this.item(l.stockItemId);
      if (it) it.ordered = null;
    }
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
    this.record('use_on_job', stockItemId, qty, ME, ME, jobId);
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
      this.record('supplier_invoice', itemId, l.qty, ME, ME, jobId ?? null, `${b.supplierName} ${b.invoiceNumber}`, l.unitPriceCents ?? null);
    }
    Object.assign(inv, { status: 'confirmed', confirmed_at: new Date().toISOString(), supplier_name: b.supplierName, invoice_number: b.invoiceNumber, total_cents: b.totalCents ?? null, job_id: jobId, lines: b.lines });
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

  // ---- The order list ------------------------------------------------------------------------

  orderList() {
    const lines = this.s.items.filter(i => (i.minQty ?? 0) > 0 && (this.s.stockroom[i.id] ?? 0) < (i.minQty ?? 0)).map(i => {
      const inStock = this.s.stockroom[i.id] ?? 0;
      const short = (i.minQty ?? 0) - inStock;
      return {
        id: i.id, code: i.code, description: i.description, unit: i.unit, min_qty: i.minQty ?? 0, reorder_qty: i.reorderQty ?? null, photo_id: i.photoId ?? null,
        supplier_name: i.supplierName ?? null, supplier_code: i.supplierCode ?? null, in_stockroom: inStock,
        suggested: i.reorderQty && i.reorderQty >= short ? i.reorderQty : Math.ceil(short),
        ordered_at: i.ordered?.at ?? null, ordered_qty: i.ordered?.qty ?? null, ordered_note: i.ordered?.note ?? null, ordered_by: i.ordered?.by ?? null,
      };
    }).sort((a, b) => a.in_stockroom / a.min_qty - b.in_stockroom / b.min_qty);
    return { toOrder: lines.filter(l => !l.ordered_at), ordered: lines.filter(l => l.ordered_at) };
  }

  settings(id: string, b: { minQty: number; reorderQty?: number | null; photoId?: string | null; supplierName?: string | null }): Res {
    const it = this.item(id);
    if (!it) return bad(404, 'no such item');
    if (!(b.minQty >= 0)) return bad(400, 'the minimum must be 0 or more');
    Object.assign(it, { minQty: b.minQty, reorderQty: b.reorderQty ?? null, supplierName: b.supplierName || null, photoId: b.photoId ?? it.photoId ?? null });
    return good({ id });
  }

  markOrdered(id: string, b: { qty: number; note?: string; cancel?: boolean }): Res {
    const it = this.item(id);
    if (!it) return bad(404, 'no such item');
    it.ordered = b.cancel ? null : { at: new Date().toISOString(), qty: b.qty, note: b.note ?? null, by: 'Lindiwe Zulu' };
    return good({ id, ordered: !b.cancel });
  }

  history(id: string) {
    const it = this.item(id);
    if (!it) return [];
    return (this.s.activity ?? []).filter(a => a.code === it.code).sort((a, b) => b.at.localeCompare(a.at)).map(a => ({
      id: a.id, at: a.at, kind: a.kind, qty: a.qty, note: a.reference, job_number: a.jobNumber, store: a.store, technician: a.technician, by: a.by, vehicle: null, fleet_job_number: null,
    }));
  }
}
