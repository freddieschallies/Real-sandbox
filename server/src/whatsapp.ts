// WhatsApp for the app, two ways (the company chooses when it sets up):
//   phone:    its own cheap phone and SIM, linked once with a QR code; the link service (whatsapp-bridge)
//             is that phone's "WhatsApp Web" for every company on the server.
//   official: an official WhatsApp Business number through Meta's Cloud API (no phone). Real Sandbox signs
//             up with Meta once as a tech provider (META_APP_ID, META_APP_SECRET, META_CONFIG_ID,
//             WA_VERIFY_TOKEN); each company then connects its number with Meta's own sign-up window.
// Either way every message is kept per chat for the WhatsApp tab (read and reply in the app).
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Q } from './db.ts';
import { MAX_PHOTO_BYTES, MAX_PHOTO_EDGE, imageSize, saveFile } from './uploads.ts';

export type Fetch = typeof fetch;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// ---- Chats ------------------------------------------------------------------------------------------

export interface ChatIn {
  chatJid: string; chatName: string | null; isGroup: boolean; waId: string; fromMe: boolean; sender: string | null; senderName: string | null;
  at: Date; text: string; images: { mime: string; data: Buffer }[]; attachments: string[];
}

/** Keeps one message in its chat (once: the same WhatsApp message twice is ignored). Returns its id and the chat's, or null. */
export async function keepChatMessage(c: Q, companyId: string, m: ChatIn): Promise<{ id: string; chatId: string } | null> {
  if ((await c.query('SELECT 1 FROM wa_messages WHERE wa_id = $1', [m.waId])).rowCount) return null;
  const name = (m.chatName ?? '').trim() || (m.isGroup ? 'Group' : m.fromMe ? `+${m.chatJid.split('@')[0]}` : m.senderName?.trim() || `+${m.chatJid.split('@')[0]}`);
  const preview = (m.text.trim() || (m.images.length ? '📷 Photo' : m.attachments[0] ?? '')).slice(0, 160);
  const chat = (await c.query(
    `INSERT INTO wa_chats (jid, name, is_group, last_at, last_text, unread, last_in_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (company_id, jid) DO UPDATE SET
       name = CASE WHEN wa_chats.is_group OR $8 THEN EXCLUDED.name ELSE wa_chats.name END,
       last_at = GREATEST(coalesce(wa_chats.last_at, EXCLUDED.last_at), EXCLUDED.last_at),
       last_text = CASE WHEN wa_chats.last_at IS NULL OR EXCLUDED.last_at >= wa_chats.last_at THEN EXCLUDED.last_text ELSE wa_chats.last_text END,
       unread = wa_chats.unread + EXCLUDED.unread,
       last_in_at = GREATEST(wa_chats.last_in_at, EXCLUDED.last_in_at)
     RETURNING id`,
    [m.chatJid, name, m.isGroup, m.at, preview, m.fromMe ? 0 : 1, m.fromMe ? null : m.at, !!m.chatName?.trim()])).rows[0];
  const photoIds: string[] = [];
  const others = [...m.attachments];
  for (const img of m.images.slice(0, 6)) {
    const size = imageSize(img.data);
    if (!IMAGE_TYPES.includes(img.mime) || img.data.length > MAX_PHOTO_BYTES || (size && Math.max(size.width, size.height) > MAX_PHOTO_EDGE)) { others.push('a photo (too large to keep)'); continue; }
    const id = randomUUID();
    const rel = await saveFile(companyId, id, { fields: {}, buffer: img.data, mimetype: img.mime }, m.at.toISOString());
    await c.query("INSERT INTO photos (id, kind, file_path, taken_at, taken_by, content_type, bytes) VALUES ($1, 'whatsapp', $2, $3, NULL, $4, $5)", [id, rel, m.at, img.mime, img.data.length]);
    photoIds.push(id);
  }
  const row = (await c.query(
    `INSERT INTO wa_messages (chat_id, wa_id, from_me, sender, sender_name, at, text, photo_ids, attachments, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (company_id, wa_id) DO NOTHING RETURNING id`,
    [chat.id, m.waId, m.fromMe, m.sender, m.senderName, m.at, m.text.slice(0, 20000), photoIds, JSON.stringify(others), m.fromMe ? 'sent' : 'received'])).rows[0];
  return row ? { id: row.id, chatId: chat.id } : null;
}

/** The app's own line in a chat (a group post it made, or a reply), once WhatsApp has sent it. */
export async function keepOwnLine(c: Q, chatJid: string, chatName: string | null, isGroup: boolean, text: string, waId: string | null, by: string | null) {
  const chat = (await c.query(
    `INSERT INTO wa_chats (jid, name, is_group, last_at, last_text) VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (company_id, jid) DO UPDATE SET last_at = now(), last_text = EXCLUDED.last_text RETURNING id`,
    [chatJid, chatName ?? (isGroup ? 'Group' : `+${chatJid.split('@')[0]}`), isGroup, text.slice(0, 160)])).rows[0];
  await c.query(`INSERT INTO wa_messages (chat_id, wa_id, from_me, at, text, status, sent_by) VALUES ($1, $2, true, now(), $3, 'sent', $4) ON CONFLICT (company_id, wa_id) DO NOTHING`,
    [chat.id, waId, text, by]);
}

/** WhatsApp's 24-hour rule for an official number: free text only within a day of the person's last message. */
export const OFFICIAL_WINDOW_MS = 24 * 3600_000;
export function officialMayWrite(lastInAt: Date | string | null, now = Date.now()) {
  return !!lastInAt && now - new Date(lastInAt).getTime() < OFFICIAL_WINDOW_MS;
}

// ---- The official number (Meta's Cloud API) ------------------------------------------------------

export interface MetaConfig { appId: string; appSecret: string; configId: string; verifyToken: string; graph: string }
/** Real Sandbox's own sign-up with Meta (once, by whoever runs the server). Null until that is done. */
export function metaConfig(env: NodeJS.ProcessEnv = process.env): MetaConfig | null {
  const { META_APP_ID: appId, META_APP_SECRET: appSecret, META_CONFIG_ID: configId, WA_VERIFY_TOKEN: verifyToken } = env;
  if (!appId || !appSecret || !configId || !verifyToken) return null;
  return { appId, appSecret, configId, verifyToken, graph: (env.META_GRAPH_URL ?? 'https://graph.facebook.com/v21.0').replace(/\/+$/, '') };
}

async function graph(f: Fetch, url: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init;
  const res = await f(url, { ...rest, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(rest.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  const body = await res.json().catch(() => ({})) as { error?: { message?: string } } & Record<string, unknown>;
  if (!res.ok) throw new Error(body?.error?.message ?? `WhatsApp said ${res.status}`);
  return body;
}

/**
 * After the company finished Meta's sign-up window: the code it gave becomes this company's key,
 * the app is subscribed to its WhatsApp account and the number is switched on for the Cloud API.
 */
export async function officialConnect(cfg: MetaConfig, f: Fetch, a: { code: string; phoneNumberId: string; wabaId: string }) {
  const tok = await graph(f, `${cfg.graph}/oauth/access_token?client_id=${encodeURIComponent(cfg.appId)}&client_secret=${encodeURIComponent(cfg.appSecret)}&code=${encodeURIComponent(a.code)}`);
  const token = String(tok.access_token ?? '');
  if (!token) throw new Error('WhatsApp gave no key: try the sign-up again');
  await graph(f, `${cfg.graph}/${a.wabaId}/subscribed_apps`, { method: 'POST', token });
  const pin = String(randomInt(100000, 999999));
  await graph(f, `${cfg.graph}/${a.phoneNumberId}/register`, { method: 'POST', token, body: JSON.stringify({ messaging_product: 'whatsapp', pin }) });
  const info = await graph(f, `${cfg.graph}/${a.phoneNumberId}?fields=display_phone_number,verified_name`, { token });
  return { token, pin, number: String(info.display_phone_number ?? '').replace(/[^\d]/g, ''), name: (info.verified_name as string | undefined) ?? null };
}

/** Sends a text from the official number. Returns WhatsApp's id of the message. */
export async function officialSend(cfg: MetaConfig, f: Fetch, token: string, phoneNumberId: string, to: string, text: string) {
  const r = await graph(f, `${cfg.graph}/${phoneNumberId}/messages`, { method: 'POST', token, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/[^\d]/g, ''), type: 'text', text: { preview_url: false, body: text } }) });
  return ((r.messages as { id: string }[] | undefined)?.[0]?.id) ?? null;
}

/** A photo someone sent the official number. */
export async function officialMedia(cfg: MetaConfig, f: Fetch, token: string, mediaId: string): Promise<{ mime: string; data: Buffer } | null> {
  const meta = await graph(f, `${cfg.graph}/${mediaId}`, { token });
  if (!meta.url) return null;
  const res = await f(String(meta.url), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  return { mime: String(meta.mime_type ?? 'image/jpeg').split(';')[0], data: Buffer.from(await res.arrayBuffer()) };
}

/** WhatsApp signs each webhook with the app secret: anything else is not from WhatsApp. */
export function signatureOk(raw: Buffer, header: string | undefined, secret: string) {
  if (!header?.startsWith('sha256=')) return false;
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const got = Buffer.from(header);
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface WebhookMessage { phoneNumberId: string; from: string; name: string | null; waId: string; at: Date; text: string; imageId: string | null; other: string | null }
export interface WebhookStatus { phoneNumberId: string; waId: string; status: string; error: string | null }
/** What one webhook call says: messages that came in, and how sent ones went. */
export function readWebhook(body: unknown): { messages: WebhookMessage[]; statuses: WebhookStatus[] } {
  const messages: WebhookMessage[] = [], statuses: WebhookStatus[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const e of entries as { changes?: { field?: string; value?: Record<string, any> }[] }[]) {
    for (const ch of e.changes ?? []) {
      const v = ch.value ?? {};
      const pid = String(v.metadata?.phone_number_id ?? '');
      if (!pid) continue;
      const names = new Map<string, string>((v.contacts ?? []).map((x: any) => [String(x.wa_id), String(x.profile?.name ?? '')]));
      for (const m of v.messages ?? []) {
        const type = String(m.type ?? '');
        const text = type === 'text' ? String(m.text?.body ?? '') : type === 'image' ? String(m.image?.caption ?? '') : type === 'button' ? String(m.button?.text ?? '')
          : type === 'interactive' ? String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '') : type === 'document' ? String(m.document?.caption ?? '') : '';
        const other = ['text', 'image', 'button', 'interactive'].includes(type) ? null : type === 'document' ? `a document${m.document?.filename ? ` (${m.document.filename})` : ''}` : type === 'audio' ? 'a voice note' : type === 'location' ? 'a location' : `a ${type || 'message'}`;
        messages.push({ phoneNumberId: pid, from: String(m.from ?? ''), name: names.get(String(m.from)) || null, waId: String(m.id ?? ''), at: new Date(Number(m.timestamp ?? Date.now() / 1000) * 1000),
          text, imageId: type === 'image' ? String(m.image?.id ?? '') || null : null, other });
      }
      for (const s of v.statuses ?? []) statuses.push({ phoneNumberId: pid, waId: String(s.id ?? ''), status: String(s.status ?? ''), error: s.errors?.[0] ? String(s.errors[0].title ?? s.errors[0].message ?? 'failed') : null });
    }
  }
  return { messages, statuses };
}
