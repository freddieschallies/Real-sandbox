// Sage Pastel Partner / Xpress document import file. One "Header" row per document, then its
// "Detail" rows (Sage KB: "Import/Export file layout for Customer and Supplier documents"). Customer
// invoices, quotations and credit notes, and supplier invoices, share the layout; which kind a batch
// is gets chosen in Pastel when importing, so each file holds one kind only. Pure functions, used on
// the server and in the app.
import type { DocLine, LineKind } from './documents.ts';

export interface PastelLineCode { code: string; lineType: 4 | 6 }
export interface PastelSettings {
  /** The month the financial year starts (1 = January, 3 = March): Pastel period 1. */
  yearStartMonth: number;
  /** Pastel tax type for standard-rated VAT (usually 01) and for no VAT. */
  taxType: string;
  /** What Pastel codes the non-stock lines go to: an inventory item (4) or a GL account (6). */
  codes: Partial<Record<Exclude<LineKind, 'stock'> | 'credit' | 'purchases', PastelLineCode>>;
  /** Pastel store code for inventory lines, if Pastel uses multi-store (max 3 characters). */
  store?: string | null;
}

export type PastelKind = 'invoice' | 'quote' | 'credit' | 'supplier_invoice';
export const PASTEL_KIND_LABEL: Record<PastelKind, string> = { invoice: 'Invoices', quote: 'Quotations', credit: 'Credit notes', supplier_invoice: 'Supplier invoices' };
/** Where each kind is imported in Pastel. */
export const PASTEL_WHERE: Record<PastelKind, string> = {
  invoice: 'Process → Customers → Invoices → Import', quote: 'Process → Customers → Quotations → Import',
  credit: 'Process → Customers → Credit Notes → Import', supplier_invoice: 'Process → Suppliers → Invoices → Import',
};

export interface PastelDoc {
  kind: PastelKind;
  /** Our number (invoice, quote, credit note); for a supplier invoice, the supplier's number goes in orderNumber. */
  number: number | string;
  /** The Pastel account: the customer's code, or the supplier's for a supplier invoice. */
  customerCode: string | null;
  date: string;          // YYYY-MM-DD
  dueDate: string | null; // invoice due date or quote valid until
  orderNumber: string | null;
  message: string | null;
  deliverTo: string[];   // store name and address lines
  contact: string | null;
  lines: (DocLine & { stockCode?: string | null; unit?: string | null })[];
  /** Credit notes and supplier invoices: every line goes to this code (Accounts, Pastel codes), not per line kind. */
  codeFor?: 'credit' | 'purchases';
  /** A supplier invoice without VAT (the supplier is not registered): Pastel tax type 00. */
  noVat?: boolean;
}

const CODE_NAME = { credit: 'credit notes', purchases: 'supplier invoices (the purchases account)' } as const;

export const LINE_TYPE_LABEL = { 4: 'Inventory item', 6: 'GL account' } as const;

const ddmmyyyy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
/** Pastel period 1–12 for a date, counting from the financial year's first month. */
export function period(date: string, yearStartMonth: number) {
  const m = Number(date.slice(5, 7));
  return ((m - yearStartMonth + 12) % 12) + 1;
}
const money = (cents: number) => (cents / 100).toFixed(2);
const cut = (s: string | null | undefined, n: number) => (s ?? '').replace(/[\r\n,"]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const csv = (cells: (string | number)[]) => cells.map(String).join(',');

/** What stops a document going into Pastel. */
export function missingForPastel(d: PastelDoc, s: PastelSettings): string[] {
  const out: string[] = [];
  const who = d.kind === 'supplier_invoice' ? 'supplier' : 'customer';
  if (!d.customerCode) out.push(d.kind === 'supplier_invoice' ? "the supplier's Pastel code" : "the client's Pastel customer code");
  else if (d.customerCode.length > 6) out.push(`the Pastel ${who} code is longer than 6 characters`);
  if (!d.lines.length) out.push('no lines');
  const noCode = new Set<string>();
  if (d.codeFor) {
    if (!s.codes[d.codeFor]?.code) noCode.add(`a Pastel code for ${CODE_NAME[d.codeFor]} (Accounts, Pastel codes)`);
    return [...out, ...noCode];
  }
  for (const l of d.lines) {
    if (l.kind === 'stock') {
      if (!l.stockCode) noCode.add(`a Pastel item code for "${l.description}"`);
      else if (l.stockCode.length > 15) noCode.add(`item code ${l.stockCode} is longer than 15 characters`);
    } else if (!s.codes[l.kind]?.code) noCode.add(`a Pastel code for ${l.kind.replace('_', '-')} lines (Accounts, Pastel codes)`);
  }
  return [...out, ...noCode];
}

/** The import file for one batch of documents of the same kind (CSV, Windows line ends). */
export function pastelFile(docs: PastelDoc[], s: PastelSettings, vatPct: number): string {
  const rows: string[] = [];
  for (const d of docs) {
    const msg = cut(d.message, 90);
    const addr = [...d.deliverTo.map(a => cut(a, 30)).filter(Boolean), '', '', '', '', ''].slice(0, 5);
    rows.push(csv([
      'Header', '', '', '', cut(d.customerCode, 6), period(d.date, s.yearStartMonth), ddmmyyyy(d.date), cut(d.orderNumber, 25), 'N', 0,
      msg.slice(0, 30), msg.slice(30, 60), msg.slice(60, 90), ...addr, '', 0, d.dueDate ? ddmmyyyy(d.dueDate) : '', '', '', cut(d.contact, 16), '', '', '', 'N', '',
    ]));
    for (const l of d.lines) {
      const code = d.codeFor ? s.codes[d.codeFor]! : l.kind === 'stock' ? { code: l.stockCode ?? '', lineType: 4 as const } : s.codes[l.kind as Exclude<LineKind, 'stock'>]!;
      const incl = d.noVat ? l.unitPriceCents : Math.round(l.unitPriceCents * (1 + vatPct / 100));
      rows.push(csv([
        'Detail', 0, l.qty, money(l.unitPriceCents), money(incl), cut(l.unit ?? '', 4), d.noVat ? '00' : s.taxType, 0, 0, cut(code.code, 15), cut(l.description, 40), code.lineType,
        '', code.lineType === 4 ? cut(s.store ?? '', 3) : '',
      ]));
    }
  }
  return rows.join('\r\n') + '\r\n';
}

/**
 * A supplier invoice's lines for Pastel, all to the purchases account: every line when the lines add
 * up to the invoice (within R1), otherwise one line for the whole invoice, so Pastel always gets what
 * the supplier billed. Amounts excluding VAT.
 */
export function supplierLines(inv: { number: string; supplier: string; totalCents: number; vatCents: number | null; vatPct: number; lines: { description: string; qty: number; unitPriceCents: number | null }[] }): DocLine[] {
  const exVat = inv.vatCents !== null ? inv.totalCents - inv.vatCents : Math.round(inv.totalCents / (1 + inv.vatPct / 100));
  const priced = inv.lines.length > 0 && inv.lines.every(l => l.unitPriceCents !== null && l.qty > 0);
  const sum = priced ? inv.lines.reduce((n, l) => n + Math.round(l.qty * (l.unitPriceCents ?? 0)), 0) : -1;
  if (priced && Math.abs(sum - exVat) <= 100) {
    return inv.lines.map(l => ({ kind: 'other' as const, description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents ?? 0 }));
  }
  return [{ kind: 'other', description: `${inv.supplier} invoice ${inv.number}`, qty: 1, unitPriceCents: exVat }];
}
