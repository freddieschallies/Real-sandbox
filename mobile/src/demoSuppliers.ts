// The demo's supplier invoices for Accounts, following the same rules as the server
// (routes/supplierInvoices.ts): the technicians' till slips (from the demo stockroom) and the office's
// own scans (a photo or a PDF), checked, approved or queried, and sent to Pastel in a batch.
import * as P from '../../server/src/core/pastel.ts';
import * as S from '../../server/src/core/stock.ts';
import type { DemoStockState } from './demoStock.ts';

type Res = { ok: true; status: number; body: unknown } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown, status = 200): Res => ({ ok: true, status, body });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const ymd = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

interface Line { description: string; supplierCode?: string | null; qty: number; unitPriceCents: number | null; stockItemId?: string | null }
interface Check { check_status: 'to_check' | 'queried' | 'approved'; check_note: string | null; checked_by: string | null; checked_at: string | null; pastel_batch_id: string | null }
export interface OfficeScan extends Check {
  id: string; status: 'reading' | 'to_confirm' | 'confirmed' | 'unreadable'; photo_id: string; content_type: string; scanned_at: string; confirmed_at: string | null; added_by: string;
  supplier_name: string | null; invoice_number: string | null; invoice_date: string | null; total_cents: number | null; vat_cents: number | null; delivery_id: string | null;
  read: { supplierName: string; invoiceNumber: string; invoiceDate: string; totalCents: number; vatCents: number; lines: Line[] } | null; lines: Line[]; changed_from_read: boolean;
}
/** A technician's slip as Accounts sees it (seeded ones, and ones confirmed in the demo stockroom). */
interface Slip extends Check {
  id: string; technician: string; supplier_name: string; invoice_number: string; invoice_date: string | null; total_cents: number | null; vat_cents: number | null;
  confirmed_at: string; job_number: number | null; lines: Line[];
}
export interface DemoSupplierState {
  scans: OfficeScan[];
  slips: Slip[];
  /** Checks of slips confirmed in the demo stockroom (by the stockroom invoice id). */
  checks: Record<string, Check>;
  codes: Record<string, string | null>;
  deliveries: { id: string; supplier: string; reference: string; date: string; received_by: string; lines: { code: string; description: string; qty: number }[] }[];
}

const fresh = (): Check => ({ check_status: 'to_check', check_note: null, checked_by: null, checked_at: null, pastel_batch_id: null });

export function seedSuppliers(): DemoSupplierState {
  return {
    scans: [],
    slips: [
      { ...fresh(), id: 'slip-1', technician: 'Thabo Mkhize', supplier_name: 'Voltex Richards Bay', invoice_number: 'INV-71204', invoice_date: ymd(ago(30)), total_cents: 49450, vat_cents: 6450,
        confirmed_at: ago(29), job_number: 10219, lines: [{ description: 'Fuse 10A', supplierCode: 'F10A', qty: 10, unitPriceCents: 450 }, { description: 'Contactor 25A 230V coil', supplierCode: 'C25', qty: 1, unitPriceCents: 38500 }] },
      { ...fresh(), id: 'slip-2', technician: 'Sipho Ndlovu', supplier_name: 'Cool Parts Wholesale', invoice_number: 'CP-55871', invoice_date: ymd(ago(20)), total_cents: 73600, vat_cents: 9600,
        confirmed_at: ago(19), job_number: 10212, lines: [{ description: 'Refrigerant R404A', supplierCode: 'R404A', qty: 2, unitPriceCents: 32000 }] },
    ],
    checks: {},
    codes: {},
    deliveries: [
      { id: 'del-rw-1', supplier: 'Cool Parts Wholesale', reference: 'DN-88120', date: ymd(ago(50)), received_by: 'Lindiwe Zulu',
        lines: [{ code: 'FAN-MTR', description: 'Condenser fan motor 10W', qty: 4 }] },
    ],
  };
}

/** What the pretend reader "sees" on any invoice the office scans in the demo (the fan motors that came in on DN-88120). */
const PRETEND = (): OfficeScan['read'] => ({
  supplierName: 'Cool Parts Wholesale', invoiceNumber: `CP-${Math.floor(88000 + Math.random() * 900)}`, invoiceDate: ymd(ago(48)), totalCents: 190900, vatCents: 24900,
  lines: [{ description: 'Condenser fan motor 10W', supplierCode: 'FM10', qty: 4, unitPriceCents: 41500 }],
});

export class DemoSuppliers {
  constructor(private s: DemoSupplierState, private stock: DemoStockState, private me: string) {}

  /** Scans are "read" 4 seconds after they arrive. */
  tick() {
    for (const x of this.s.scans) {
      if (x.status === 'reading' && Date.now() - Date.parse(x.scanned_at) > 4_000) {
        const r = PRETEND()!;
        Object.assign(x, { status: 'to_confirm', read: r, supplier_name: r.supplierName, invoice_number: r.invoiceNumber, invoice_date: r.invoiceDate, total_cents: r.totalCents, vat_cents: r.vatCents });
      }
    }
  }

  /** Slips the demo technician confirmed in the stockroom, with their check. */
  private stockSlips(): Slip[] {
    return this.stock.invoices.filter(i => i.status === 'confirmed').map(i => {
      const x = i as typeof i & { lines?: Line[] };
      return { ...(this.s.checks[i.id] ??= fresh()), id: i.id, technician: 'Thabo Mkhize', supplier_name: i.supplier_name ?? '', invoice_number: i.invoice_number ?? '', invoice_date: i.invoice_date,
        total_cents: i.total_cents, vat_cents: (i.read_result as { vatCents?: number | null } | null)?.vatCents ?? null, confirmed_at: i.confirmed_at ?? i.scanned_at, job_number: null, lines: x.lines ?? [] };
    });
  }
  private allSlips(): Slip[] { return [...this.s.slips, ...this.stockSlips()]; }
  private slip(id: string): (Slip & { stored: Check }) | null {
    const seeded = this.s.slips.find(x => x.id === id);
    if (seeded) return { ...seeded, stored: seeded };
    const st = this.stockSlips().find(x => x.id === id);
    return st ? { ...st, stored: this.s.checks[id] } : null;
  }

  private row(x: OfficeScan | Slip) {
    const office = 'photo_id' in x;
    const del = office ? this.s.deliveries.find(d => d.id === (x as OfficeScan).delivery_id) : null;
    return {
      id: x.id, source: office ? 'office' : 'counter', status: office ? (x as OfficeScan).status : 'confirmed', check_status: x.check_status, check_note: x.check_note,
      supplier_id: x.supplier_name, supplier_name: x.supplier_name, supplier_code: x.supplier_name ? this.s.codes[x.supplier_name] ?? null : null,
      invoice_number: x.invoice_number, invoice_date: x.invoice_date, total_cents: x.total_cents, vat_cents: x.vat_cents,
      photo_id: office ? (x as OfficeScan).photo_id : null, content_type: office ? (x as OfficeScan).content_type : null,
      scanned_at: office ? (x as OfficeScan).scanned_at : x.confirmed_at, confirmed_at: x.confirmed_at, checked_at: x.checked_at, checked_by: x.checked_by,
      changed_from_read: office ? (x as OfficeScan).changed_from_read : false, read_error: null,
      technician: office ? null : (x as Slip).technician, added_by: office ? (x as OfficeScan).added_by : null, job_number: office ? null : (x as Slip).job_number,
      delivery_id: del?.id ?? null, delivery_ref: del?.reference ?? null, delivery_date: del?.date ?? null, pastel_batch_id: x.pastel_batch_id,
    };
  }

  list(view: string) {
    this.tick();
    const all = [...this.s.scans, ...this.allSlips()].map(x => this.row(x));
    const is = (v: string, r: ReturnType<DemoSuppliers['row']>) =>
      v === 'scanned' ? r.source === 'office' && r.status !== 'confirmed'
        : v === 'to_check' ? r.status === 'confirmed' && r.check_status === 'to_check'
        : v === 'queried' ? r.status === 'confirmed' && r.check_status === 'queried'
        : v === 'approved' ? r.check_status === 'approved' && !r.pastel_batch_id
        : v === 'in_pastel' ? !!r.pastel_batch_id : true;
    const counts = Object.fromEntries(['scanned', 'to_check', 'queried', 'approved', 'in_pastel'].map(v => [v, all.filter(r => is(v, r)).length]));
    const list = all.filter(r => is(view, r)).sort((a, b) => (b.confirmed_at ?? b.scanned_at ?? '').localeCompare(a.confirmed_at ?? a.scanned_at ?? ''));
    return { view, counts, invoices: list };
  }

  detail(id: string): Res {
    this.tick();
    const scan = this.s.scans.find(x => x.id === id);
    const slip = scan ? null : this.slip(id);
    if (!scan && !slip) return bad(404, 'no such supplier invoice');
    const x = (scan ?? slip)!;
    const used = new Set(this.s.scans.filter(o => o.id !== id && o.delivery_id).map(o => o.delivery_id));
    const name = (x.supplier_name ?? '').toLowerCase();
    const deliveries = name ? this.s.deliveries.filter(d => d.supplier.toLowerCase() === name && !used.has(d.id)).map(d => ({ id: d.id, reference: d.reference, date: d.date, received_by: d.received_by, lines: d.lines })) : [];
    return good({ ...this.row(x), read: scan?.read ?? null, lines: x.lines.map((l, i) => ({ line_no: i + 1, description: l.description, supplier_code: l.supplierCode ?? null, qty: l.qty, unit_price_cents: l.unitPriceCents, stock_code: this.itemFor(l)?.code ?? null })), deliveries });
  }

  private itemFor(l: Line) { return S.matchItem({ description: l.description, supplierCode: l.supplierCode ?? null, qty: l.qty }, this.stock.items as S.CatalogueItem[]); }

  scan(photoId: string, mime: string): Res {
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(mime)) return bad(400, 'the invoice must be a photo (JPEG, PNG or WebP) or a PDF');
    const id = `sinv-${Date.now()}`;
    this.s.scans.unshift({ ...fresh(), id, status: 'reading', photo_id: photoId, content_type: mime, scanned_at: new Date().toISOString(), confirmed_at: null, added_by: this.me,
      supplier_name: null, invoice_number: null, invoice_date: null, total_cents: null, vat_cents: null, delivery_id: null, read: null, lines: [], changed_from_read: false });
    return good({ id, status: 'reading', photoId }, 201);
  }

  private booked(supplier: string, number: string, notId: string) {
    const same = (a: string | null, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
    const scan = this.s.scans.find(x => x.id !== notId && x.status === 'confirmed' && same(x.supplier_name, supplier) && same(x.invoice_number, number));
    if (scan) return scan.added_by;
    return this.allSlips().find(x => x.id !== notId && same(x.supplier_name, supplier) && same(x.invoice_number, number))?.technician ?? null;
  }

  /** Approved: the stock items on it now cost what it says. */
  private keepCosts(lines: Line[]) {
    for (const l of lines) {
      const it = this.itemFor(l) as (DemoStockState['items'][number] & { costCents?: number | null }) | null;
      if (it && l.unitPriceCents != null) it.costCents = l.unitPriceCents;
    }
  }

  save(id: string, b: { supplierName: string; invoiceNumber: string; invoiceDate?: string | null; totalCents: number; vatCents?: number | null; deliveryId?: string | null; lines: Line[]; approve?: boolean }): Res {
    const x = this.s.scans.find(o => o.id === id);
    if (!x) return this.slip(id) ? bad(409, "a technician's slip is changed by him: query it instead") : bad(404, 'no such supplier invoice');
    if (x.status === 'reading') return bad(409, 'still reading this invoice: try again in a moment');
    if (x.pastel_batch_id) return bad(409, 'this invoice is already in Pastel');
    if (x.check_status === 'approved') return bad(409, 'this invoice is approved: take the approval off first to change it');
    const problems = S.invoiceProblems({ ...b, lines: b.lines ?? [] });
    if (!(b.totalCents > 0)) problems.push('the invoice total');
    if (b.vatCents != null && b.vatCents >= b.totalCents) problems.push('the VAT is more than the total');
    if (problems.length) return bad(409, ...problems);
    const who = this.booked(b.supplierName, b.invoiceNumber, id);
    if (who) return bad(409, `invoice ${b.invoiceNumber} from ${b.supplierName} was already booked by ${who}`);
    if (b.deliveryId && this.s.scans.some(o => o.id !== id && o.delivery_id === b.deliveryId)) return bad(409, 'that delivery is already on another invoice');
    const r = x.read;
    const t = (v: unknown) => String(v ?? '').trim().toLowerCase();
    const changed = !!r && (t(r.supplierName) !== t(b.supplierName) || t(r.invoiceNumber) !== t(b.invoiceNumber) || r.totalCents !== b.totalCents || r.lines.length !== b.lines.length);
    Object.assign(x, {
      status: 'confirmed', confirmed_at: x.confirmed_at ?? new Date().toISOString(), supplier_name: b.supplierName.trim(), invoice_number: b.invoiceNumber.trim(), invoice_date: b.invoiceDate ?? null,
      total_cents: b.totalCents, vat_cents: b.vatCents ?? null, delivery_id: b.deliveryId ?? null, lines: b.lines, changed_from_read: changed,
      check_status: b.approve ? 'approved' : 'to_check', checked_by: b.approve ? this.me : null, checked_at: b.approve ? new Date().toISOString() : null, check_note: null,
    });
    if (b.approve) this.keepCosts(b.lines);
    const sum = S.linesTotalCents(b.lines);
    const exVat = b.vatCents != null ? b.totalCents - b.vatCents : null;
    return good({ id, checkStatus: x.check_status, changedFromRead: changed,
      warning: sum !== null && exVat !== null && Math.abs(sum - exVat) > 100 ? 'the lines do not add up to the total excluding VAT: Pastel gets one line for the whole invoice' : null });
  }

  check(id: string, action: string, note: string | undefined): Res {
    const scan = this.s.scans.find(o => o.id === id);
    const slip = scan ? null : this.slip(id);
    const c: Check | undefined = scan ?? slip?.stored;
    if (!c) return bad(404, 'no such supplier invoice');
    if (scan && scan.status !== 'confirmed') return bad(409, 'save what the invoice says first');
    if (c.pastel_batch_id) return bad(409, 'this invoice is already in Pastel');
    if (action === 'approve') {
      if (c.check_status === 'approved') return bad(409, 'already approved');
      Object.assign(c, { check_status: 'approved', checked_by: this.me, checked_at: new Date().toISOString() });
      this.keepCosts((scan ?? slip)!.lines);
    } else if (action === 'query') {
      if (!note || note.trim().length < 5) return bad(400, 'say what is wrong (at least a few words)');
      Object.assign(c, { check_status: 'queried', check_note: note.trim(), checked_by: this.me, checked_at: new Date().toISOString() });
    } else if (action === 'reopen') {
      if (c.check_status === 'to_check') return bad(409, 'it is waiting to be checked already');
      Object.assign(c, { check_status: 'to_check', check_note: null, checked_by: null, checked_at: null });
    } else return bad(400, 'approve, query or reopen');
    return good({ id, checkStatus: c.check_status });
  }

  remove(id: string): Res {
    const x = this.s.scans.find(o => o.id === id);
    if (!x || x.status === 'confirmed') return bad(409, 'only a scan that was not saved yet can be taken off');
    this.s.scans = this.s.scans.filter(o => o.id !== id);
    return good({ id, removed: true });
  }

  suppliers() {
    const names = [...new Set([...this.allSlips().map(x => x.supplier_name), ...this.s.scans.map(x => x.supplier_name).filter((n): n is string => !!n), ...this.s.deliveries.map(d => d.supplier)])].sort();
    return names.map(n => ({ id: n, name: n, pastel_code: this.s.codes[n] ?? null, invoices: this.allSlips().filter(x => x.supplier_name === n).length + this.s.scans.filter(x => x.supplier_name === n && x.status === 'confirmed').length }));
  }
  setCode(id: string, code: string | null): Res {
    const c = (code ?? '').trim().toUpperCase();
    if (c.length > 6) return bad(400, 'Pastel supplier codes are at most 6 characters');
    const clash = Object.entries(this.s.codes).find(([n, v]) => n !== id && v && v.toUpperCase() === c);
    if (c && clash) return bad(409, `${c} is already ${clash[0]}`);
    this.s.codes[id] = c || null;
    return good({ id, code: c || null });
  }

  /** For the Pastel batch: approved and not yet in Pastel. */
  pastel(vatPct: number) {
    return {
      docs: (): (P.PastelDoc & { id: string })[] => [...this.s.scans, ...this.allSlips()].filter(x => x.check_status === 'approved' && !x.pastel_batch_id).map(x => ({
        id: x.id, kind: 'supplier_invoice' as const, number: x.invoice_number ?? '', customerCode: x.supplier_name ? this.s.codes[x.supplier_name] ?? null : null,
        date: x.invoice_date ?? ymd(x.confirmed_at ?? new Date().toISOString()), dueDate: null, orderNumber: x.invoice_number,
        message: 'technician' in x ? `Bought by ${x.technician}` : null, deliverTo: [], contact: null, codeFor: 'purchases' as const, noVat: x.vat_cents === 0,
        lines: P.supplierLines({ number: x.invoice_number ?? '', supplier: x.supplier_name ?? '', totalCents: x.total_cents ?? 0, vatCents: x.vat_cents, vatPct, lines: x.lines }),
      })),
      mark: (ids: string[], batchId: string) => {
        for (const id of ids) {
          const scan = this.s.scans.find(o => o.id === id);
          if (scan) { scan.pastel_batch_id = batchId; continue; }
          const sl = this.slip(id);
          if (sl) sl.stored.pastel_batch_id = batchId;
        }
      },
    };
  }
}
