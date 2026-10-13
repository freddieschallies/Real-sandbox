// A small IMAP client, enough to read new emails from a Gmail inbox (imap.gmail.com, port 993) with
// an app password. It never deletes or moves anything and does not even mark emails as read
// (BODY.PEEK): the office's inbox stays exactly as it was. No outside package.
import net from 'node:net';
import tls from 'node:tls';

export interface ImapOptions { host: string; port: number; secure: boolean; user: string; pass: string; timeoutMs?: number }
interface Reply { status: 'OK' | 'NO' | 'BAD'; text: string; untagged: { line: string; literals: Buffer[] }[] }

export class ImapError extends Error {}

const quote = (s: string) => `"${s.replace(/[\\"]/g, m => `\\${m}`)}"`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const imapDate = (d: Date) => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

export class Imap {
  private sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private tag = 0;
  private pending: { line: string; literals: Buffer[] } | null = null;
  private untagged: { line: string; literals: Buffer[] }[] = [];
  private waiting: { tag: string; resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private greeting: ((ok: boolean) => void) | null = null;
  private failed: Error | null = null;

  private o: ImapOptions;
  constructor(o: ImapOptions) { this.o = o; }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new ImapError(`no answer from ${this.o.host}`)), this.o.timeoutMs ?? 20_000);
      this.greeting = ok => { clearTimeout(t); ok ? resolve() : reject(new ImapError('the mail server refused the connection')); };
      this.sock = this.o.secure ? tls.connect({ host: this.o.host, port: this.o.port, servername: this.o.host }) : net.connect({ host: this.o.host, port: this.o.port });
      this.sock.on('data', (d: Buffer) => this.onData(d));
      this.sock.on('error', e => { clearTimeout(t); this.fail(e); reject(new ImapError(`cannot reach ${this.o.host}: ${e.message}`)); });
      this.sock.on('close', () => this.fail(new ImapError('the mail server closed the connection')));
    });
    const r = await this.cmd(`LOGIN ${quote(this.o.user)} ${quote(this.o.pass)}`);
    if (r.status !== 'OK') throw new ImapError(/AUTHENTICATIONFAILED|Invalid credentials/i.test(r.text)
      ? 'Gmail refused the email address or app password'
      : `sign-in refused: ${r.text}`);
  }

  private fail(e: Error) {
    this.failed ??= e;
    this.waiting?.reject(e);
    this.waiting = null;
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const i = this.buf.indexOf('\r\n');
      if (i < 0) return;
      const line = this.buf.slice(0, i).toString('latin1');
      const lit = line.match(/\{(\d+)\}$/);
      if (lit) {
        const n = Number(lit[1]);
        if (this.buf.length < i + 2 + n) return;          // wait for the whole literal
        const data = this.buf.slice(i + 2, i + 2 + n);
        this.pending ??= { line: '', literals: [] };
        this.pending.line += line;
        this.pending.literals.push(Buffer.from(data));
        this.buf = this.buf.slice(i + 2 + n);
        continue;
      }
      this.buf = this.buf.slice(i + 2);
      const full = (this.pending?.line ?? '') + line;
      const literals = this.pending?.literals ?? [];
      this.pending = null;
      this.handleLine(full, literals);
    }
  }

  private handleLine(line: string, literals: Buffer[]) {
    if (this.greeting) { const g = this.greeting; this.greeting = null; g(/^\* (OK|PREAUTH)/i.test(line)); return; }
    if (line.startsWith('* ')) { this.untagged.push({ line: line.slice(2), literals }); return; }
    if (line.startsWith('+')) return;
    const w = this.waiting;
    if (w && line.startsWith(`${w.tag} `)) {
      const rest = line.slice(w.tag.length + 1);
      const status = (rest.split(' ')[0].toUpperCase() as Reply['status']);
      this.waiting = null;
      const untagged = this.untagged; this.untagged = [];
      w.resolve({ status, text: rest.slice(status.length + 1), untagged });
    }
  }

  cmd(c: string): Promise<Reply> {
    if (this.failed) return Promise.reject(this.failed);
    const tag = `a${++this.tag}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting = null; reject(new ImapError('the mail server stopped answering')); }, this.o.timeoutMs ?? 60_000);
      this.waiting = { tag, resolve: r => { clearTimeout(t); resolve(r); }, reject: e => { clearTimeout(t); reject(e); } };
      this.sock.write(`${tag} ${c}\r\n`);
    });
  }

  /** Opens the inbox read-only: its UIDVALIDITY and the next UID. */
  async openInbox(): Promise<{ uidValidity: number; uidNext: number | null }> {
    const r = await this.cmd('EXAMINE INBOX');
    if (r.status !== 'OK') throw new ImapError(`cannot open the inbox: ${r.text}`);
    const all = [...r.untagged.map(u => u.line), r.text].join('\n');
    const v = all.match(/UIDVALIDITY (\d+)/i);
    const n = all.match(/UIDNEXT (\d+)/i);
    return { uidValidity: v ? Number(v[1]) : 0, uidNext: n ? Number(n[1]) : null };
  }

  /** UIDs of emails after `afterUid`, or (first time) received since `since`. */
  async newUids(afterUid: number | null, since: Date): Promise<number[]> {
    const r = await this.cmd(afterUid != null ? `UID SEARCH UID ${afterUid + 1}:*` : `UID SEARCH SINCE ${imapDate(since)}`);
    if (r.status !== 'OK') throw new ImapError(`search failed: ${r.text}`);
    const uids = r.untagged.filter(u => /^SEARCH/i.test(u.line)).flatMap(u => u.line.slice(6).trim().split(/\s+/).filter(Boolean).map(Number));
    // "n:*" always includes the newest email even when it is older than n.
    return uids.filter(u => afterUid == null || u > afterUid).sort((a, b) => a - b);
  }

  /** The whole email, without marking it read. */
  async fetch(uid: number): Promise<Buffer | null> {
    const r = await this.cmd(`UID FETCH ${uid} (UID BODY.PEEK[])`);
    if (r.status !== 'OK') throw new ImapError(`could not fetch email ${uid}: ${r.text}`);
    const hit = r.untagged.find(u => /FETCH/i.test(u.line) && u.literals.length);
    return hit ? hit.literals[0] : null;
  }

  async logout() {
    try { await this.cmd('LOGOUT'); } catch { /* closing anyway */ }
    this.sock?.destroy();
  }
}

export const gmailOptions = (user: string, pass: string): ImapOptions => ({ host: 'imap.gmail.com', port: 993, secure: true, user, pass });
