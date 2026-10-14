// The stockroom's stock takes and its purchase orders to suppliers. Pure functions, the same on the
// server (email), in the app (print, WhatsApp) and in the test drive.
import { rand } from './documents.ts';

// ---- Stock take ------------------------------------------------------------------------------------

export interface CountLine { expected: number; counted: number | null; costCents: number | null }
export interface TakeSummary { items: number; counted: number; left: number; differences: number; over: number; short: number; gainCents: number; lossCents: number; noCost: number }

/** How far the count is, and what the differences are worth (at each item's latest cost). */
export function takeSummary(lines: CountLine[]): TakeSummary {
  const done = lines.filter(l => l.counted !== null);
  const diff = done.filter(l => Math.abs((l.counted ?? 0) - l.expected) > 1e-9);
  const value = (l: CountLine) => ((l.counted ?? 0) - l.expected) * (l.costCents ?? 0);
  return {
    items: lines.length, counted: done.length, left: lines.length - done.length, differences: diff.length,
    over: diff.filter(l => (l.counted ?? 0) > l.expected).length, short: diff.filter(l => (l.counted ?? 0) < l.expected).length,
    gainCents: Math.round(diff.filter(l => value(l) > 0).reduce((n, l) => n + value(l), 0)),
    lossCents: Math.round(-diff.filter(l => value(l) < 0).reduce((n, l) => n + value(l), 0)),
    noCost: diff.filter(l => l.costCents == null).length,
  };
}

// ---- Purchase orders to suppliers --------------------------------------------------------------------

export interface PoLine { code: string | null; supplierCode: string | null; description: string; qty: number; unit: string | null; unitPriceCents: number | null }
export interface PoDoc {
  number: number; date: string; supplier: string; contact?: string | null; note?: string | null; lines: PoLine[];
  company: { name: string; address?: string | null; phone?: string | null; email?: string | null; vatNo?: string | null }; by: string;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
export const poTotal = (lines: PoLine[]) => lines.reduce((n, l) => n + (l.unitPriceCents ?? 0) * l.qty, 0);

/** The purchase order as an HTML body (between the letterhead's top and bottom). */
export function poHtml(p: PoDoc): string {
  const priced = p.lines.some(l => l.unitPriceCents != null);
  const rows = p.lines.map(l => `<tr><td>${esc(l.supplierCode ?? '')}</td><td>${esc(l.description)}${l.code ? ` <span style="color:#777">(${esc(l.code)})</span>` : ''}</td><td class=r>${qtyText(l.qty)} ${esc(l.unit ?? '')}</td>${priced ? `<td class=r>${l.unitPriceCents != null ? rand(l.unitPriceCents) : ''}</td>` : ''}</tr>`).join('');
  return `<div class=body>
<div class=two><div><b>To</b><br>${esc(p.supplier)}${p.contact ? `<br>Attention: ${esc(p.contact)}` : ''}</div>
<div style="text-align:right"><b style="font-size:18px;color:#E8701A">PURCHASE ORDER ${p.number}</b><br>${esc(p.date)}</div></div>
<table><tr><th>Your code</th><th>Description</th><th class=r>Quantity</th>${priced ? '<th class=r>Last price excl. VAT</th>' : ''}</tr>${rows}</table>
${priced ? `<p class=r>Estimated total excl. VAT: <b>${rand(poTotal(p.lines))}</b> (at the last prices we paid)</p>` : ''}
${p.note ? `<p><b>Note:</b> ${esc(p.note)}</p>` : ''}
<p><b>Please quote PO ${p.number} on your invoice and delivery note.</b></p>
<p>Deliver to: ${esc(p.company.name)}${p.company.address ? `, ${esc(p.company.address)}` : ''}${p.company.phone ? ` · ${esc(p.company.phone)}` : ''}${p.company.email ? ` · ${esc(p.company.email)}` : ''}${p.company.vatNo ? `<br>VAT no. ${esc(p.company.vatNo)}` : ''}</p>
<p class=sm>Ordered by ${esc(p.by)}</p></div>`;
}

/** The purchase order as a short message (WhatsApp or SMS). */
export function poText(p: PoDoc): string {
  return [`${p.company.name}: purchase order ${p.number} (${p.date})`, `To ${p.supplier}`, '',
    ...p.lines.map(l => `${qtyText(l.qty)} ${l.unit ?? ''} x ${l.description}${l.supplierCode ? ` (your code ${l.supplierCode})` : ''}`.replace(/\s+/g, ' ')),
    '', p.note ? `Note: ${p.note}` : '', `Please quote PO ${p.number} on your invoice and delivery note.`, `Ordered by ${p.by}`].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n').trim();
}

export const PO_CSS = `body{font:13px Arial,sans-serif;margin:0;color:#111}.bar{height:10px;background:#E8701A}.head{background:#111;color:#fff;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
.head h1{margin:0;font-size:22px}.body{padding:20px 24px}.two{display:flex;justify-content:space-between;gap:20px}table{width:100%;border-collapse:collapse;margin-top:14px}
th{text-align:left;border-top:2px solid #111;border-bottom:1px solid #ccc;padding:6px 4px}td{border-bottom:1px solid #eee;padding:6px 4px;vertical-align:top}.r{text-align:right}.sm{font-size:11px;color:#555}
.foot{background:#111;color:#eee;font-size:11px;padding:10px 24px}@media print{.noprint{display:none}}`;
