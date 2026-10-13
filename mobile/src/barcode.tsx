// QR codes on screen and on printed stickers: vehicle stickers (the mechanic) and tool and ladder
// stickers (the stockroom). Phones read QR codes from any angle; the phone's own camera app too.
import React, { useMemo } from 'react';
import { Platform, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { qrMatrix, qrSvg } from '../../server/src/core/qr.ts';

/** The QR code for a sticker code, black on white with its quiet zone. */
export function Barcode({ value, size = 128 }: { value: string; size?: number; height?: number }) {
  const m = useMemo(() => { try { return qrMatrix(value); } catch { return null; } }, [value]);
  if (!m) return null;
  const n = m.length + 8;
  let d = '';
  m.forEach((row, y) => row.forEach((c, x) => { if (c) d += `M${x + 4},${y + 4}h1v1h-1z`; }));
  return (
    <View style={{ backgroundColor: '#FFF', alignSelf: 'flex-start', borderRadius: 4 }} accessibilityLabel={`QR code ${value}`}>
      <Svg width={size} height={size} viewBox={`0 0 ${n} ${n}`}><Rect x={0} y={0} width={n} height={n} fill="#FFF" /><Path d={d} fill="#000" /></Svg>
    </View>
  );
}

const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

/** Opens a sheet of stickers to print (3 across, A4): the QR code, and beside it the company, title, code and a line. */
export function printStickers(heading: string, company: string, items: { title: string; sub?: string | null; code: string; foot?: string }[]): boolean {
  if (Platform.OS !== 'web') return false;
  const w = window.open('', '_blank');
  if (!w) return false;
  const cards = items.map(i => `<div class="s"><div class="q">${qrSvg(i.code)}</div><div class="x"><div class="c">${esc(company)}</div><div class="t">${esc(i.title)}</div>${i.sub ? `<div class="u">${esc(i.sub)}</div>` : ''}
    <div class="k">${esc(i.code)}</div>${i.foot ? `<div class="f">${esc(i.foot)}</div>` : ''}</div></div>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(heading)}</title><style>
    @page { size: A4; margin: 10mm } body { font-family: Arial, sans-serif; margin: 0 }
    .g { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm }
    .s { border: 1px dashed #999; border-radius: 3mm; padding: 2.5mm; display: flex; gap: 2.5mm; align-items: center; break-inside: avoid; height: 34mm; box-sizing: border-box; overflow: hidden }
    .q svg { width: 28mm; height: 28mm; display: block } .x { min-width: 0 }
    .c { font-size: 7pt; color: #555 } .t { font-size: 11pt; font-weight: bold; margin-top: 0.5mm; line-height: 1.15 } .u { font-size: 8pt; color: #333 }
    .k { font-family: monospace; font-size: 10pt; letter-spacing: 1px; margin-top: 1mm } .f { font-size: 6.5pt; color: #555; margin-top: 0.5mm }
    .bar { margin-bottom: 6mm } @media print { .bar { display: none } }
  </style></head><body><div class="bar"><b>${esc(heading)}</b> · ${items.length} sticker${items.length === 1 ? '' : 's'} · <button onclick="print()">Print</button>
  <span style="color:#666"> Print at 100% (no fit to page) on sticker paper or plain paper and cover with clear tape.</span></div><div class="g">${cards}</div></body></html>`);
  w.document.close();
  return true;
}
