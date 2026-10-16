// Turns a printable page (HTML on the letterhead) into a PDF with a headless Chromium on the server
// (the office server's Docker image installs it; CHROMIUM_PATH points elsewhere if needed). Without
// one, documents still go out as a printable web page. The page never runs scripts and never reaches
// the network: pictures are put in the page itself before it is sent.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function findChromium(): string | null {
  const env = process.env.CHROMIUM_PATH;
  if (env) return existsSync(env) ? env : null;
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (existsSync(p)) return p;
  // Playwright's headless shell (development machines).
  try {
    for (const d of readdirSync('/opt/pw-browsers')) {
      if (!d.startsWith('chromium_headless_shell')) continue;
      for (const sub of readdirSync(join('/opt/pw-browsers', d))) {
        const p = join('/opt/pw-browsers', d, sub, 'headless_shell');
        if (existsSync(p)) return p;
      }
    }
  } catch { /* none */ }
  return null;
}
let found: string | null | undefined;
export const chromium = () => (found === undefined ? (found = findChromium()) : found);

/** The page made safe to open anywhere: no scripts, no event handlers, nothing loaded from elsewhere. */
export function safePage(html: string): string {
  let h = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/<(iframe|object|embed|link|base|meta\s+http-equiv)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(src|href|action)\s*=\s*("|')\s*(javascript|vbscript):[^"']*\2/gi, '$1=$2#$2')
    // Pictures must be in the page (data:); anything else is dropped.
    .replace(/(<img\b[^>]*?\ssrc\s*=\s*)("|')(?!data:)[^"']*\2/gi, '$1$2$2')
    .replace(/url\(\s*(['"]?)(?!data:)[^)'"]*\1\s*\)/gi, 'none')
    // The browser's own print button is not needed on a saved document.
    .replace(/<p class=noprint[\s\S]*?<\/p>/gi, '');
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;
  h = /<head[^>]*>/i.test(h) ? h.replace(/<head[^>]*>/i, m => `${m}${csp}`) : `<!doctype html><html><head><meta charset="utf-8">${csp}</head><body>${h}</body></html>`;
  return h;
}

/** A PDF of the page, or null when there is no Chromium (or it failed). */
export async function htmlToPdf(html: string, timeoutMs = 30_000): Promise<Buffer | null> {
  const bin = chromium();
  if (!bin) return null;
  const dir = await mkdtemp(join(tmpdir(), 'rs-pdf-'));
  try {
    const page = join(dir, 'page.html'), out = join(dir, 'page.pdf');
    await writeFile(page, safePage(html));
    await new Promise<void>((res, rej) => {
      execFile(bin, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-pdf-header-footer', '--hide-scrollbars',
        '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', `--user-data-dir=${join(dir, 'profile')}`, `--print-to-pdf=${out}`, `file://${page}`],
      { timeout: timeoutMs }, err => (err && !existsSync(out) ? rej(err) : res()));
    });
    const pdf = await readFile(out);
    return pdf.subarray(0, 5).toString() === '%PDF-' ? pdf : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
