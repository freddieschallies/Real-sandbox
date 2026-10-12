// Sage Pastel Partner / Xpress customer document import file. One "Header" row per document, then
// its "Detail" rows (Sage KB: "Import/Export file layout for Customer and Supplier documents").
// Whether the batch is invoices or quotations is chosen in Pastel when importing, so each file
// holds one kind only. Pure functions, used on the server and in the app.
import type { DocLine, LineKind } from './documents.ts';

export interface PastelLineCode { code: string; lineType: 4 | 6 }
export interface PastelSettings {
  /** The month the financial year starts (1 = January, 3 = March): Pastel period 1. */
  yearStartMonth: number;
  /** Pastel tax type for standard-rated VAT (usually 01) and for no VAT. */
  taxType: string;
  /** What Pastel codes the non-stock lines go to: an inventory item (4) or a GL account (6). */
  codes: Partial<Record<Exclude<LineKind, 'stock'>, PastelLineCode>>;
  /** Pastel store code for inventory lines, if Pastel uses multi-store (max 3 characters). */
  store?: string | null;
}

export interface PastelDoc {
  kind: 'invoice' | 'quote';
  number: number;
  customerCode: string | null;
  date: string;          // YYYY-MM-DD
  dueDate: string | null; // invoice due date or quote valid until
  orderNumber: string | null;
  message: string | null;
  deliverTo: string[];   // store name and address lines
  contact: string | null;
  lines: (DocLine & { stockCode?: string | null; unit?: string | null })[];
}

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
  if (!d.customerCode) out.push("the client's Pastel customer code");
  else if (d.customerCode.length > 6) out.push('the Pastel customer code is longer than 6 characters');
  if (!d.lines.length) out.push('no lines');
  const noCode = new Set<string>();
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
      const code = l.kind === 'stock' ? { code: l.stockCode ?? '', lineType: 4 as const } : s.codes[l.kind]!;
      const incl = Math.round(l.unitPriceCents * (1 + vatPct / 100));
      rows.push(csv([
        'Detail', 0, l.qty, money(l.unitPriceCents), money(incl), cut(l.unit ?? '', 4), s.taxType, 0, 0, cut(code.code, 15), cut(l.description, 40), code.lineType,
        '', code.lineType === 4 ? cut(s.store ?? '', 3) : '',
      ]));
    }
  }
  return rows.join('\r\n') + '\r\n';
}
