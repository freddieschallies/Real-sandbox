// (Server only: not under core/, which the app shares.)
// Reads an email as it comes off the mail server (RFC 5322 / MIME) into what the breakdown queue
// needs: who sent it, the subject, the text, and the attachments. No outside package: headers,
// encoded words, multipart, base64, quoted-printable and the usual character sets.

export interface MailAttachment { filename: string; mime: string; data: Buffer; inline: boolean }
export interface ParsedMail {
  messageId: string | null; from: { name: string | null; address: string | null }; subject: string; date: Date | null;
  text: string; attachments: MailAttachment[];
}

type Headers = Map<string, string>;

function decodeCharset(buf: Buffer, charset: string | undefined): string {
  const cs = (charset ?? 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(cs === 'us-ascii' ? 'utf-8' : cs, { fatal: false }).decode(buf); } catch { return buf.toString('latin1'); }
}

function qpBytes(s: string, header = false): Buffer {
  const src = header ? s.replace(/_/g, ' ') : s.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) { out.push(parseInt(src.slice(i + 1, i + 3), 16)); i += 2; }
    else { const b = Buffer.from(ch, 'latin1'); out.push(...b); }
  }
  return Buffer.from(out);
}

/** =?utf-8?B?...?= and =?iso-8859-1?Q?...?= in headers. */
export function decodeWords(s: string): string {
  return s.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, cs: string, enc: string, txt: string) =>
      decodeCharset(enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : qpBytes(txt, true), cs.split('*')[0]));
}

function parseHeaders(raw: string): Headers {
  const h: Headers = new Map();
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!h.has(k)) h.set(k, line.slice(i + 1).trim());
  }
  return h;
}

/** "text/plain; charset=utf-8; name="a.jpg"" → value and parameters (also RFC 2231 name*=). */
function params(v: string | undefined): { value: string; p: Record<string, string> } {
  if (!v) return { value: '', p: {} };
  const parts = v.match(/(?:[^;"]+|"(?:\\.|[^"])*")+/g) ?? [];
  const value = (parts.shift() ?? '').trim().toLowerCase();
  const p: Record<string, string> = {};
  const star: Record<string, string[]> = {};
  for (const part of parts) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    let val = part.slice(i + 1).trim().replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');
    const m = k.match(/^([^*]+)\*(\d+)?\*?$/);
    if (m) {
      const pct = (x: string) => Buffer.from(x.replace(/%([0-9A-Fa-f]{2})/g, (_q, hx: string) => String.fromCharCode(parseInt(hx, 16))), 'latin1');
      if (/^[^']*'[^']*'/.test(val)) { const [cs, , ...rest] = val.split("'"); val = decodeCharset(pct(rest.join("'")), cs || 'utf-8'); }
      else if (k.endsWith('*')) val = decodeCharset(pct(val), 'utf-8');
      (star[m[1]] ??= [])[Number(m[2] ?? 0)] = val;
    } else p[k] = decodeWords(val);
  }
  for (const [k, list] of Object.entries(star)) p[k] = list.join('');
  return { value, p };
}

function bodyBytes(raw: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding ?? '7bit').toLowerCase().trim();
  if (enc === 'base64') return Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return qpBytes(raw.toString('latin1'));
  return raw;
}

/** Headers are ASCII, but many mail programs now send UTF-8 in them as it is. */
function headText(b: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return b.toString('latin1'); }
}

function splitHead(buf: Buffer): { head: string; body: Buffer } {
  let i = buf.indexOf('\r\n\r\n');
  let skip = 4;
  const j = buf.indexOf('\n\n');
  if (i < 0 || (j >= 0 && j < i)) { i = j; skip = 2; }
  if (i < 0) return { head: headText(buf), body: Buffer.alloc(0) };
  return { head: headText(buf.slice(0, i)), body: buf.slice(i + skip) };
}

/** Plain text from HTML: paragraphs and line breaks kept, tags and styles dropped. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n').replace(/<td[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

interface Walk { plain: string[]; html: string[]; attachments: MailAttachment[] }

function walk(buf: Buffer, out: Walk, depth = 0) {
  if (depth > 10) return;
  const { head, body } = splitHead(buf);
  const h = parseHeaders(head);
  const ct = params(h.get('content-type') ?? 'text/plain');
  const cd = params(h.get('content-disposition'));
  if (ct.value.startsWith('multipart/') && ct.p.boundary) {
    const b = Buffer.from(`--${ct.p.boundary}`);
    let pos = body.indexOf(b);
    while (pos >= 0) {
      const start = pos + b.length;
      if (body.slice(start, start + 2).toString() === '--') break;
      const next = body.indexOf(b, start);
      let part = body.slice(start, next < 0 ? body.length : next);
      part = part.slice(part[0] === 13 ? 2 : part[0] === 10 ? 1 : 0);
      if (part.length >= 2 && part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);
      else if (part.length && part[part.length - 1] === 10) part = part.slice(0, -1);
      walk(part, out, depth + 1);
      pos = next;
    }
    return;
  }
  if (ct.value === 'message/rfc822') { walk(bodyBytes(body, h.get('content-transfer-encoding')), out, depth + 1); return; }
  const data = bodyBytes(body, h.get('content-transfer-encoding'));
  const filename = cd.p.filename ?? ct.p.name ?? '';
  const isAttachment = cd.value === 'attachment' || (!!filename && !ct.value.startsWith('text/'));
  if (!isAttachment && ct.value === 'text/plain') out.plain.push(decodeCharset(data, ct.p.charset));
  else if (!isAttachment && ct.value === 'text/html') out.html.push(decodeCharset(data, ct.p.charset));
  else if (data.length) out.attachments.push({ filename: filename || `attachment.${ct.value.split('/')[1] ?? 'bin'}`, mime: ct.value || 'application/octet-stream', data, inline: cd.value === 'inline' || !!h.get('content-id') });
}

/** "Jane Smith <jane@x.co.za>" → name and address. */
export function parseAddress(v: string | undefined): { name: string | null; address: string | null } {
  if (!v) return { name: null, address: null };
  const s = decodeWords(v);
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim() || null, address: m[2].trim().toLowerCase() };
  const a = s.match(/[^\s<>"]+@[^\s<>"]+/);
  return { name: null, address: a ? a[0].toLowerCase() : null };
}

/** The new part of an email: earlier messages quoted under "On … wrote:" and "> " lines dropped. */
export function newPart(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*(On .{5,200} wrote:|-----\s*Original Message\s*-----|From:\s.+@.+|_{10,})\s*$/i.test(l) && out.join('').trim()) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseMail(raw: Buffer): ParsedMail {
  const { head } = splitHead(raw);
  const h = parseHeaders(head);
  const w: Walk = { plain: [], html: [], attachments: [] };
  walk(raw, w);
  const text = w.plain.length ? w.plain.join('\n\n') : htmlToText(w.html.join('\n\n'));
  const d = h.get('date') ? new Date(h.get('date')!) : null;
  return {
    messageId: h.get('message-id')?.replace(/[<>\s]/g, '') || null,
    from: parseAddress(h.get('from')),
    subject: decodeWords(h.get('subject') ?? '').trim(),
    date: d && !Number.isNaN(d.getTime()) ? d : null,
    text: text.trim(),
    attachments: w.attachments,
  };
}
