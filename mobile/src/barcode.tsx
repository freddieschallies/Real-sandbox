// Code 128 barcodes on screen and on printed stickers: vehicle stickers (the mechanic) and tool and
// ladder stickers (the stockroom). Every phone camera and handheld scanner reads them.
import React from 'react';
import { Platform, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { code128Widths } from '../../server/src/core/code128.ts';

const QUIET = 10; // blank modules each side, so scanners find the start

/** The barcode for a code, drawn black on white. */
export function Barcode({ value, height = 64, module = 2 }: { value: string; height?: number; module?: number }) {
  let w: number[];
  try { w = code128Widths(value); } catch { return null; }
  const total = (w.reduce((a, b) => a + b, 0) + QUIET * 2) * module;
  let x = QUIET * module;
  const bars: React.ReactElement[] = [];
  w.forEach((n, i) => { if (i % 2 === 0) bars.push(<Rect key={i} x={x} y={0} width={n * module} height={height} fill="#000" />); x += n * module; });
  return (
    <View style={{ backgroundColor: '#FFF', alignSelf: 'flex-start', borderRadius: 4 }} accessibilityLabel={`Barcode ${value}`}>
      <Svg width={total} height={height}><Rect x={0} y={0} width={total} height={height} fill="#FFF" />{bars}</Svg>
    </View>
  );
}

/** The same barcode as SVG text, for printing. */
export function barcodeSvg(value: string, module = 2, height = 60): string {
  const w = code128Widths(value);
  const total = (w.reduce((a, b) => a + b, 0) + QUIET * 2) * module;
  let x = QUIET * module, rects = '';
  w.forEach((n, i) => { if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${n * module}" height="${height}"/>`; x += n * module; });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${height}" viewBox="0 0 ${total} ${height}" style="max-width:100%;height:auto"><rect width="${total}" height="${height}" fill="#fff"/>${rects}</svg>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

/** Opens a sheet of stickers to print (3 across, A4): company, title, barcode, code, and a line under it. */
export function printStickers(heading: string, company: string, items: { title: string; sub?: string | null; code: string; foot?: string }[]): boolean {
  if (Platform.OS !== 'web') return false;
  const w = window.open('', '_blank');
  if (!w) return false;
  const cards = items.map(i => `<div class="s"><div class="c">${esc(company)}</div><div class="t">${esc(i.title)}</div>${i.sub ? `<div class="u">${esc(i.sub)}</div>` : ''}
    <div class="b">${barcodeSvg(i.code, 2, 46)}</div><div class="k">${esc(i.code)}</div>${i.foot ? `<div class="f">${esc(i.foot)}</div>` : ''}</div>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(heading)}</title><style>
    @page { size: A4; margin: 10mm } body { font-family: Arial, sans-serif; margin: 0 }
    .g { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm }
    .s { border: 1px dashed #999; border-radius: 3mm; padding: 3mm; text-align: center; break-inside: avoid; height: 42mm; box-sizing: border-box; overflow: hidden }
    .c { font-size: 8pt; color: #555 } .t { font-size: 12pt; font-weight: bold; margin-top: 1mm } .u { font-size: 8pt; color: #333 }
    .b { margin: 1.5mm 0 0.5mm } .k { font-family: monospace; font-size: 10pt; letter-spacing: 1px } .f { font-size: 7pt; color: #555 }
    .bar { margin-bottom: 6mm } @media print { .bar { display: none } }
  </style></head><body><div class="bar"><b>${esc(heading)}</b> · ${items.length} sticker${items.length === 1 ? '' : 's'} · <button onclick="print()">Print</button>
  <span style="color:#666"> Print at 100% (no fit to page) on sticker paper or plain paper and cover with clear tape.</span></div><div class="g">${cards}</div></body></html>`);
  w.document.close();
  return true;
}
