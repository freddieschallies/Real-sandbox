// Sending email (reports to clients). A small SMTP client so the server needs no extra package: TLS
// from the start (port 465) or STARTTLS (587), AUTH LOGIN, and one HTML message with pictures inside it.
// Set MAIL_URL, e.g. smtps://user:password@smtp.example.com:465 or smtp://user:password@host:587, and
// MAIL_FROM ("ZSP <reports@zsp.co.za>"). Without them the server says email is not set up yet.
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

export interface MailPicture { cid: string; mime: string; data: Buffer }
export interface MailFile { filename: string; mime: string; data: Buffer }
export interface Mail { to: string[]; replyTo?: string | null; subject: string; html: string; text: string; pictures: MailPicture[]; fromName?: string | null; files?: MailFile[] }
export type Mailer = (m: Mail) => Promise<void>;

const b64 = (b: Buffer) => b.toString('base64').replace(/.{1,76}/g, l => `${l}\r\n`);
const header = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

/** The message as SMTP sends it: HTML with a plain-text part, and the pictures it shows. */
export function buildMime(from: string, m: Mail): string {
  const outer = `rs-${randomUUID()}`, alt = `rs-${randomUUID()}`;
  const lines = [
    `From: ${from}`, `To: ${m.to.join(', ')}`, ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Subject: ${header(m.subject)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomUUID()}@real-sandbox>`, 'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${outer}"`, '',
    `--${outer}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(m.text)),
    `--${alt}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(Buffer.from(m.html)),
    `--${alt}--`, '',
  ];
  for (const p of m.pictures) {
    lines.push(`--${outer}`, `Content-Type: ${p.mime}`, 'Content-Transfer-Encoding: base64', `Content-ID: <${p.cid}>`, `Content-Disposition: inline; filename="${p.cid}"`, '', b64(p.data));
  }
  for (const f of m.files ?? []) {
    lines.push(`--${outer}`, `Content-Type: ${f.mime}; name="${header(f.filename)}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${header(f.filename)}"`, '', b64(f.data));
  }
  lines.push(`--${outer}--`, '');
  // A line starting with a dot is doubled, as SMTP requires.
  return lines.join('\r\n').replace(/\r\n\./g, '\r\n..');
}

/** The mailer from MAIL_URL and MAIL_FROM, or null when email is not set up. */
export function mailerFromEnv(): Mailer | null {
  const raw = process.env.MAIL_URL;
  if (!raw) return null;
  const u = new URL(raw);
  const secure = u.protocol === 'smtps:';
  const host = u.hostname, port = Number(u.port || (secure ? 465 : 587));
  const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
  const from = process.env.MAIL_FROM || user;
  const addr = (s: string) => /<([^>]+)>/.exec(s)?.[1] ?? s;
  return async (m: Mail) => {
    let sock: net.Socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buf = '';
    const waiters: ((line: string) => void)[] = [];
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^\d{3} /.test(line)) waiters.shift()?.(line);
      }
    };
    sock.on('data', onData);
    const reply = () => new Promise<string>((res, rej) => { waiters.push(res); sock.once('error', rej); setTimeout(() => rej(new Error('the mail server did not answer')), 20_000); });
    const cmd = async (c: string, ok: number[]) => {
      sock.write(`${c}\r\n`);
      const r = await reply();
      if (!ok.includes(Number(r.slice(0, 3)))) throw new Error(`mail server: ${r}`);
      return r;
    };
    try {
      if (secure) await new Promise<void>((res, rej) => { (sock as tls.TLSSocket).once('secureConnect', () => res()); sock.once('error', rej); });
      await reply();
      await cmd('EHLO real-sandbox', [250]);
      if (!secure) {
        await cmd('STARTTLS', [220]);
        sock.off('data', onData);
        sock = tls.connect({ socket: sock, servername: host });
        await new Promise<void>((res, rej) => { (sock as tls.TLSSocket).once('secureConnect', () => res()); sock.once('error', rej); });
        sock.on('data', onData);
        await cmd('EHLO real-sandbox', [250]);
      }
      if (user) {
        await cmd('AUTH LOGIN', [334]);
        await cmd(Buffer.from(user).toString('base64'), [334]);
        await cmd(Buffer.from(pass).toString('base64'), [235]);
      }
      await cmd(`MAIL FROM:<${addr(from)}>`, [250]);
      for (const to of m.to) await cmd(`RCPT TO:<${addr(to)}>`, [250, 251]);
      await cmd('DATA', [354]);
      const fromLine = m.fromName ? `${header(m.fromName)} <${addr(from)}>` : from;
      await cmd(`${buildMime(fromLine, m)}\r\n.`, [250]);
      await cmd('QUIT', [221]).catch(() => {});
    } finally {
      sock.end();
    }
  };
}
