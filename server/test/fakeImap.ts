// A pretend Gmail IMAP server for tests: one inbox, a user and password, and the emails in it.
import net from 'node:net';

export interface FakeInbox { user: string; pass: string; uidValidity: number; mails: { uid: number; date: Date; raw: string }[]; logins: number; fetched: number[] }

export async function fakeImap(box: FakeInbox): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer(sock => {
    sock.write('* OK fake Gimap ready\r\n');
    let buf = '';
    sock.on('data', d => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, cmd, ...rest] = line.split(' ');
        const C = (cmd ?? '').toUpperCase();
        if (C === 'LOGIN') {
          const m = line.match(/LOGIN "((?:\\.|[^"])*)" "((?:\\.|[^"])*)"/);
          const u = m?.[1].replace(/\\(.)/g, '$1'), p = m?.[2].replace(/\\(.)/g, '$1');
          if (u === box.user && p === box.pass) { box.logins++; sock.write(`${tag} OK LOGIN completed\r\n`); }
          else sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
        } else if (C === 'EXAMINE') {
          const next = Math.max(0, ...box.mails.map(m => m.uid)) + 1;
          sock.write(`* ${box.mails.length} EXISTS\r\n* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid\r\n* OK [UIDNEXT ${next}] Predicted next UID\r\n${tag} OK [READ-ONLY] INBOX selected\r\n`);
        } else if (C === 'UID' && rest[0]?.toUpperCase() === 'SEARCH') {
          let uids: number[];
          if (rest[1]?.toUpperCase() === 'UID') {
            const from = Number(rest[2].split(':')[0]);
            uids = box.mails.filter(m => m.uid >= from).map(m => m.uid);
            if (!uids.length && box.mails.length) uids = [box.mails[box.mails.length - 1].uid];   // like real IMAP: n:* includes the last
          } else {
            const since = new Date(`${rest[2]} 00:00 UTC`);
            uids = box.mails.filter(m => m.date >= since).map(m => m.uid);
          }
          sock.write(`* SEARCH${uids.map(u => ` ${u}`).join('')}\r\n${tag} OK SEARCH completed\r\n`);
        } else if (C === 'UID' && rest[0]?.toUpperCase() === 'FETCH') {
          const uid = Number(rest[1]);
          const m = box.mails.find(x => x.uid === uid);
          if (m) {
            box.fetched.push(uid);
            const bytes = Buffer.from(m.raw, 'utf8');
            sock.write(`* 1 FETCH (UID ${uid} BODY[] {${bytes.length}}\r\n`);
            sock.write(bytes);
            sock.write(')\r\n');
          }
          sock.write(`${tag} OK FETCH completed\r\n`);
        } else if (C === 'LOGOUT') {
          sock.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`); sock.end();
        } else sock.write(`${tag} BAD unknown\r\n`);
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise(r => server.close(() => r())) };
}

/** A call centre's email as Gmail would give it: text and HTML, a picture, an encoded subject. */
export function callCentreMail(o: { id: string; from: string; subject: string; text: string; date?: Date; picture?: boolean }): string {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');
  const b = 'BOUNDARY-1', a = 'ALT-1';
  const qp = o.text.replace(/=/g, '=3D').replace(/é/g, '=C3=A9');
  return [
    `Message-ID: <${o.id}>`, `From: ${o.from}`, 'To: breakdowns@zsp.test', `Subject: =?UTF-8?B?${Buffer.from(o.subject).toString('base64')}?=`,
    `Date: ${(o.date ?? new Date()).toUTCString()}`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b}"`, '',
    `--${b}`, `Content-Type: multipart/alternative; boundary="${a}"`, '',
    `--${a}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', qp, '',
    `--${a}`, 'Content-Type: text/html; charset=utf-8', '', `<p>${o.text.replace(/\n/g, '<br>')}</p>`, '',
    `--${a}--`, '',
    ...(o.picture ? [`--${b}`, 'Content-Type: image/jpeg; name="fault.jpg"', 'Content-Disposition: attachment; filename="fault.jpg"', 'Content-Transfer-Encoding: base64', '', jpeg, ''] : []),
    `--${b}--`, '',
  ].join('\r\n');
}
