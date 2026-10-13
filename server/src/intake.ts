// Breakdowns coming in. Every email in the company's Gmail inboxes and every message in the WhatsApp
// breakdowns group goes into one queue, read for the store, the fault and the call log number. A
// breakdown from email is posted in the group by the app's own WhatsApp number. The office logs it as
// a job with one tap; if nobody does within the set time, the CEO is told.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db, Q } from './db.ts';
import { groupLine, type StoreRef } from './core/breakdownRead.ts';
import type { BreakdownReader } from './breakdownReader.ts';
import { parseMail, newPart } from './mime.ts';
import { Imap, gmailOptions, type ImapOptions } from './imap.ts';
import { MAX_PHOTO_BYTES, imageSize, MAX_PHOTO_EDGE, saveFile } from './uploads.ts';
import { notify } from './routes/field.ts';

// ---- App passwords, kept scrambled in the database ------------------------------------------------

const key = () => createHash('sha256').update(`intake-secret:${process.env.JWT_SECRET ?? ''}`).digest();
export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
export function openSecret(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(':');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ---- Settings ---------------------------------------------------------------------------------------

export interface IntakeSettings { post_new: boolean; post_logged: boolean; post_on_site: boolean; post_done: boolean; escalate_after_min: number; ignore_senders: string[] }
export async function settingsOf(c: Q): Promise<IntakeSettings> {
  const r = (await c.query('SELECT post_new, post_logged, post_on_site, post_done, escalate_after_min, ignore_senders FROM breakdown_settings')).rows[0];
  return r ?? { post_new: true, post_logged: true, post_on_site: false, post_done: false, escalate_after_min: 15, ignore_senders: [] };
}

export async function storesOf(c: Q): Promise<StoreRef[]> {
  return (await c.query('SELECT s.id, s.name, c.name AS client, s.address FROM stores s JOIN clients c ON c.id = s.client_id ORDER BY c.name, s.name')).rows;
}

/** Queues a line for the app's WhatsApp number to post in the breakdowns group (only once a group is chosen). */
export async function queuePost(c: Q, reason: 'new' | 'logged' | 'merged' | 'on_site' | 'done', text: string, ids: { breakdownId?: string | null; jobId?: string | null } = {}) {
  const link = (await c.query('SELECT group_jid FROM whatsapp_link')).rows[0];
  if (!link?.group_jid) return false;
  await c.query('INSERT INTO group_posts (text, reason, breakdown_id, job_id) VALUES ($1, $2, $3, $4)', [text, reason, ids.breakdownId ?? null, ids.jobId ?? null]);
  return true;
}

// ---- One message in ---------------------------------------------------------------------------------

export interface Incoming {
  channel: 'email' | 'whatsapp'; sourceId?: string | null; externalId: string; receivedAt: Date;
  senderName: string | null; sender: string | null; subject: string | null; body: string;
  images: { mime: string; data: Buffer; filename?: string }[]; pdfs?: Buffer[]; otherAttachments: string[];
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Puts a message in the queue (once: the same email or WhatsApp message twice is ignored). Returns its id, or null. */
export async function ingest(c: Q, companyId: string, m: Incoming, reader: BreakdownReader): Promise<string | null> {
  if ((await c.query('SELECT 1 FROM breakdowns WHERE channel = $1 AND external_id = $2', [m.channel, m.externalId])).rowCount) return null;
  // The app's own posts in the group are not breakdowns coming in.
  if (m.channel === 'whatsapp' && (await c.query('SELECT 1 FROM group_posts WHERE wa_id = $1', [m.externalId])).rowCount) return null;
  const st = await settingsOf(c);
  const ignored = !!m.sender && st.ignore_senders.some(s => s.toLowerCase() === m.sender!.toLowerCase());
  const stores = await storesOf(c);
  const read = ignored ? { kind: 'other' as const, storeId: null, storeText: null, fault: null, callRef: null, urgent: false, readBy: 'rules' as const }
    : await reader({ subject: m.subject ?? '', body: m.body, sender: m.senderName ? `${m.senderName} <${m.sender}>` : m.sender, pdfs: m.pdfs }, stores);
  // Pictures that came with it (what the server's storage allows; others are only named).
  const photoIds: string[] = [];
  const others = [...m.otherAttachments];
  for (const img of m.images.slice(0, 8)) {
    const size = imageSize(img.data);
    if (!IMAGE_TYPES.includes(img.mime) || img.data.length > MAX_PHOTO_BYTES || (size && Math.max(size.width, size.height) > MAX_PHOTO_EDGE)) { others.push(`${img.filename ?? 'picture'} (too large to keep)`); continue; }
    const id = randomUUID();
    const at = m.receivedAt.toISOString();
    const rel = await saveFile(companyId, id, { fields: {}, buffer: img.data, mimetype: img.mime }, at);
    await c.query("INSERT INTO photos (id, kind, file_path, taken_at, taken_by, content_type, bytes) VALUES ($1, 'breakdown', $2, $3, NULL, $4, $5)", [id, rel, at, img.mime, img.data.length]);
    photoIds.push(id);
  }
  const row = (await c.query(
    `INSERT INTO breakdowns (channel, source_id, external_id, received_at, sender_name, sender, subject, body, photo_ids, attachments,
                             kind, read_by, store_id, store_text, fault, call_ref, urgent, status, handled_at, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     ON CONFLICT (company_id, channel, external_id) DO NOTHING RETURNING id`,
    [m.channel, m.sourceId ?? null, m.externalId, m.receivedAt, m.senderName, m.sender, m.subject, m.body.slice(0, 20000), photoIds, JSON.stringify(others),
     read.kind, read.readBy, read.storeId, read.storeText, read.fault, read.callRef, read.urgent,
     ignored ? 'ignored' : 'new', ignored ? new Date() : null, ignored ? 'Sender on the ignore list' : null])).rows[0];
  if (!row) return null;
  // A breakdown that came by email is posted in the group, so everyone sees it as before.
  if (!ignored && read.kind === 'breakdown' && m.channel === 'email' && st.post_new) {
    const store = read.storeId ? stores.find(s => s.id === read.storeId) : null;
    await queuePost(c, 'new', groupLine({ kind: 'new', via: 'email', store: store ? store.name : read.storeText, fault: read.fault ?? m.subject, callRef: read.callRef, urgent: read.urgent }), { breakdownId: row.id });
  }
  return row.id;
}

/** An open job this breakdown may already be: the same call log number, or the same store in the last two days. */
export async function sameJob(c: Q, b: { call_ref: string | null; store_id: string | null }) {
  if (b.call_ref) {
    const j = (await c.query(
      `SELECT j.id, j.job_number, j.status, s.name AS store, 'call_ref' AS why FROM jobs j JOIN stores s ON s.id = j.store_id
        WHERE upper(j.client_order_ref) = upper($1) AND j.status NOT IN ('cancelled') ORDER BY j.created_at DESC LIMIT 1`, [b.call_ref])).rows[0];
    if (j) return j;
  }
  if (b.store_id) {
    return (await c.query(
      `SELECT j.id, j.job_number, j.status, s.name AS store, 'store' AS why FROM jobs j JOIN stores s ON s.id = j.store_id
        WHERE j.store_id = $1 AND j.status NOT IN ('closed', 'cancelled') AND j.created_at > now() - interval '2 days'
        ORDER BY j.created_at DESC LIMIT 1`, [b.store_id])).rows[0] ?? null;
  }
  return null;
}

/** A job update for the group, when the job came from the breakdown queue and that update is switched on. */
export async function postJobUpdate(c: Q, jobId: string, kind: 'on_site' | 'done') {
  const st = await settingsOf(c);
  if (kind === 'on_site' ? !st.post_on_site : !st.post_done) return;
  if (!(await c.query("SELECT 1 FROM breakdowns WHERE job_id = $1 AND status IN ('logged', 'merged')", [jobId])).rowCount) return;
  if ((await c.query('SELECT 1 FROM group_posts WHERE job_id = $1 AND reason = $2 AND created_at > now() - interval \'12 hours\'', [jobId, kind])).rowCount) return;
  const j = (await c.query('SELECT j.job_number, s.name AS store, u.full_name AS tech FROM jobs j JOIN stores s ON s.id = j.store_id JOIN users u ON u.id = j.lead_technician_id WHERE j.id = $1', [jobId])).rows[0];
  if (j) await queuePost(c, kind, groupLine({ kind, jobNumber: j.job_number, store: j.store, tech: j.tech }), { jobId });
}

// ---- Across companies: each company's own connection ------------------------------------------------

export async function eachCompany(db: Db, fn: (c: Q, companyId: string) => Promise<void>) {
  const companies = (await db.query('SELECT id FROM companies WHERE active')).rows.map(r => r.id as string);
  for (const id of companies) {
    const c = await db.connect();
    try {
      await c.query("SELECT set_config('app.company_id', $1, false)", [id]);
      await fn(c, id);
    } finally {
      await c.query('RESET app.company_id').catch(() => {});
      c.release();
    }
  }
}

/** Breakdowns nobody has logged within the set time: the CEO (and director) are told, once. */
export async function escalate(db: Db) {
  await eachCompany(db, async c => {
    const st = await settingsOf(c);
    const late = (await c.query(
      `SELECT b.id, b.fault, b.store_text, s.name AS store, b.received_at FROM breakdowns b LEFT JOIN stores s ON s.id = b.store_id
        WHERE b.status = 'new' AND b.kind = 'breakdown' AND b.escalated_at IS NULL AND b.received_at < now() - make_interval(mins => $1)`, [st.escalate_after_min])).rows;
    if (!late.length) return;
    const bosses = (await c.query("SELECT id FROM users WHERE login_level IN ('creator', 'director') AND status = 'active'")).rows;
    for (const b of late) {
      await c.query('UPDATE breakdowns SET escalated_at = now() WHERE id = $1', [b.id]);
      for (const u of bosses) await notify(c, u.id, 'breakdown_waiting', `A breakdown has waited over ${st.escalate_after_min} minutes without a job: ${b.store ?? b.store_text ?? 'store not known'}, ${b.fault ?? ''}`.trim(), { breakdownId: b.id });
    }
  });
}

// ---- Reading the Gmail inboxes -----------------------------------------------------------------------

/** Signs in to check an inbox before it is saved. Throws with a plain reason when it cannot. */
export async function testInbox(o: ImapOptions) {
  const imap = new Imap(o);
  try { await imap.connect(); await imap.openInbox(); } finally { await imap.logout(); }
}

/** Reads new emails from every company's Gmail inboxes into the queue. `opts` lets tests use a local mail server. */
export async function pollInboxes(db: Db, reader: BreakdownReader, opts: { connect?: (user: string, pass: string) => ImapOptions; firstDays?: number; max?: number } = {}) {
  let read = 0;
  await eachCompany(db, async (c, companyId) => {
    const sources = (await c.query("SELECT id, address, secret_enc, uid_validity, last_uid FROM intake_sources WHERE kind = 'gmail' AND active")).rows;
    for (const s of sources) {
      const imap = new Imap((opts.connect ?? gmailOptions)(s.address, openSecret(s.secret_enc)));
      try {
        await imap.connect();
        const box = await imap.openInbox();
        let last: number | null = Number(s.uid_validity) === box.uidValidity && s.last_uid != null ? Number(s.last_uid) : null;
        // The first time (or if Gmail renumbered the inbox), only the last day's emails: not years of history.
        const uids = (await imap.newUids(last, new Date(Date.now() - (opts.firstDays ?? 1) * 86_400_000))).slice(0, opts.max ?? 50);
        for (const uid of uids) {
          const raw = await imap.fetch(uid);
          if (raw) {
            const mail = parseMail(raw);
            await c.query('BEGIN');
            try {
              const id = await ingest(c, companyId, {
                channel: 'email', sourceId: s.id, externalId: mail.messageId ?? `${s.address}:${box.uidValidity}:${uid}`, receivedAt: mail.date ?? new Date(),
                senderName: mail.from.name, sender: mail.from.address, subject: mail.subject, body: newPart(mail.text),
                images: mail.attachments.filter(a => a.mime.startsWith('image/')).map(a => ({ mime: a.mime === 'image/jpg' ? 'image/jpeg' : a.mime, data: a.data, filename: a.filename })),
                pdfs: mail.attachments.filter(a => a.mime === 'application/pdf').map(a => a.data),
                otherAttachments: mail.attachments.filter(a => !a.mime.startsWith('image/')).map(a => a.filename),
              }, reader);
              await c.query('COMMIT');
              if (id) read++;
            } catch (e) { await c.query('ROLLBACK'); throw e; }
          }
          last = uid;
          await c.query('UPDATE intake_sources SET last_uid = $2, uid_validity = $3 WHERE id = $1', [s.id, uid, box.uidValidity]);
        }
        if (last == null && box.uidNext) await c.query('UPDATE intake_sources SET last_uid = $2, uid_validity = $3 WHERE id = $1', [s.id, box.uidNext - 1, box.uidValidity]);
        await c.query('UPDATE intake_sources SET last_checked_at = now(), last_error = NULL WHERE id = $1', [s.id]);
      } catch (e) {
        await c.query('UPDATE intake_sources SET last_checked_at = now(), last_error = $2 WHERE id = $1', [s.id, (e as Error).message.slice(0, 300)]).catch(() => {});
      } finally {
        await imap.logout();
      }
    }
  });
  return read;
}

