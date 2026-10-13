// Reading an uploaded spreadsheet: CSV, or Excel (.xlsx: a zip of XML files). No outside package:
// the zip's directory, inflate from Node, and the first worksheet's cells.
import { inflateRawSync } from 'node:zlib';
import { parseCsv } from './core/customerSheet.ts';

/** The files inside a zip, by name. */
function unzip(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // The end-of-central-directory record is in the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a valid Excel file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (want(name)) {
      const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = buf.slice(start, start + size);
      out.set(name, method === 8 ? inflateRawSync(data) : data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const xmlText = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');

const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/** The first worksheet of an .xlsx file as rows of cells (text as shown, numbers as plain numbers). */
export function readXlsx(buf: Buffer): string[][] {
  const files = unzip(buf, n => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => xmlText(t[1])).join(''));
  // The first sheet in the workbook's order (not always sheet1.xml).
  let sheetPath = [...files.keys()].filter(k => k.startsWith('xl/worksheets/')).sort()[0];
  const wb = files.get('xl/workbook.xml')?.toString('utf8');
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  const rid = wb?.match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
  const target = rid && rels ? rels.match(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`))?.[1] : null;
  if (target) { const p = target.startsWith('/') ? target.slice(1) : `xl/${target}`; if (files.has(p)) sheetPath = p; }
  const xml = sheetPath ? files.get(sheetPath)!.toString('utf8') : '';
  if (!xml) throw new Error('the Excel file has no worksheet');
  const rows: string[][] = [];
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const inner = c[2] ?? '';
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let text = '';
      if (type === 's' && v !== undefined) text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') text = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => xmlText(t[1])).join('');
      else if (v !== undefined) text = xmlText(v);
      const i = ref ? colIndex(ref) : row.length;
      while (row.length < i) row.push('');
      row[i] = text.trim();
    }
    rows.push(row);
  }
  return rows.filter(r => r.some(c => c));
}

/** A CSV or an Excel file into rows. */
export function readSheet(buf: Buffer): string[][] {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return readXlsx(buf);
  if (buf.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) throw new Error('this is an old Excel file (.xls): open it in Excel and save it as .xlsx or CSV');
  const text = buf.toString('utf8');
  return parseCsv(text.includes('�') ? buf.toString('latin1') : text);
}
