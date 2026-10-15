// The WhatsApp link: for every company on this server that chose "our own phone", that phone's number
// linked like WhatsApp Web. Nobody types anything on the server: the CEO presses "Show the code" in the
// app, this service puts a QR code on their screen, they scan it with the phone, done. From then on it
// hands every message (all chats, for the app's WhatsApp tab; the breakdowns group also becomes
// breakdowns) to Real Sandbox, and sends what the app has to send: its lines in the breakdowns group
// and the office's replies.
//
// This is not WhatsApp's official business system (that one cannot join an existing group), so
// WhatsApp may block a number. Keep it to the company's own chats and low volumes. If it ever stops,
// nothing else stops: the group works as before and the email side keeps working.
//
// Settings (environment):
//   API_URL        the Real Sandbox server, e.g. http://api:8080
//   WA_BRIDGE_KEY  the same long random key as the server's WA_BRIDGE_KEY
//   AUTH_DIR       where the links are remembered, one folder per company (keep it on a volume)
//   COMPANY_ID     (old set-ups only) one company that is always linked
import * as B from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const makeWASocket = B.makeWASocket ?? B.default?.default ?? B.default;
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, Browsers } = B;

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const KEY = process.env.WA_BRIDGE_KEY ?? '';
const LEGACY = /^[0-9a-f-]{36}$/i.test(process.env.COMPANY_ID ?? '') ? process.env.COMPANY_ID : null;
const AUTH_DIR = process.env.AUTH_DIR ?? './auth';
if (KEY.length < 24) {
  console.error('Set WA_BRIDGE_KEY (24+ characters, the same as the server).');
  process.exit(1);
}
const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });
/** Old messages that WhatsApp syncs when a phone is linked are not news: only the last few minutes. */
const FRESH_MS = 10 * 60_000;

/** companyId → { sock, connected, groupJid, poGroupJid, requestedAt, lastQr, names, sent, stopped, expired } */
const sessions = new Map();

async function api(companyId, method, path, body) {
  const url = `${API}${path}${method === 'GET' && companyId ? `${path.includes('?') ? '&' : '?'}companyId=${companyId}` : ''}`;
  const res = await fetch(url, {
    method, headers: { 'content-type': 'application/json', 'x-bridge-key': KEY },
    body: body ? JSON.stringify({ companyId, ...body }) : undefined, signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function report(s, state, extra = {}) {
  try {
    const r = await api(s.companyId, 'POST', '/internal/whatsapp/status', { state, ...extra });
    s.groupJid = r?.groupJid ?? null;
    s.poGroupJid = r?.poGroupJid ?? null;
  } catch (e) { logger.warn({ err: String(e), company: s.companyId }, 'could not reach the server'); }
}

async function groups(s) {
  try {
    const all = await s.sock.groupFetchAllParticipating();
    const list = Object.values(all).map(g => ({ jid: g.id, name: g.subject ?? g.id })).sort((a, b) => a.name.localeCompare(b.name));
    for (const g of list) s.names.set(g.jid, g.name);
    return list;
  } catch { return undefined; }
}

const inner = m => m.message?.ephemeralMessage?.message ?? m.message?.viewOnceMessage?.message ?? m.message?.documentWithCaptionMessage?.message ?? m.message;
const textOf = m => {
  const x = inner(m) ?? {};
  return x.conversation ?? x.extendedTextMessage?.text ?? x.imageMessage?.caption ?? x.documentMessage?.caption ?? x.videoMessage?.caption ?? '';
};
const otherOf = m => {
  const x = inner(m) ?? {};
  if (x.audioMessage) return 'a voice note';
  if (x.videoMessage) return 'a video';
  if (x.locationMessage || x.liveLocationMessage) return 'a location';
  if (x.contactMessage || x.contactsArrayMessage) return 'a contact';
  if (x.documentMessage && !(x.documentMessage.mimetype ?? '').startsWith('application/pdf')) return `a document${x.documentMessage.fileName ? ` (${x.documentMessage.fileName})` : ''}`;
  return null;
};

async function start(companyId, requestedAt) {
  const dir = join(AUTH_DIR, companyId);
  const s = sessions.get(companyId) ?? { companyId, names: new Map(), sent: new Set() };
  Object.assign(s, { connected: false, requestedAt, lastQr: null, qrs: 0, stopped: false, expired: false });
  sessions.set(companyId, s);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use the package's own */ }
  const sock = makeWASocket({ ...(version ? { version } : {}), auth: state, logger, browser: Browsers.ubuntu('Real Sandbox'), markOnlineOnConnect: false, syncFullHistory: false });
  s.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async u => {
    if (s.stopped || s.sock !== sock) return;
    if (u.qr && u.qr !== s.lastQr) {
      s.lastQr = u.qr; s.qrs += 1;
      // Shown on the CEO's screen: scan it with the company's phone (WhatsApp → Linked devices).
      await report(s, 'waiting_for_scan', { qrSvg: await QRCode.toString(u.qr, { type: 'svg', margin: 2 }) });
    }
    if (u.connection === 'open') {
      s.connected = true; s.lastQr = null; s.everConnected = true;
      const number = sock.user?.id?.split(':')[0]?.split('@')[0] ?? null;
      await report(s, 'connected', { number, groups: await groups(s) });
      logger.warn(`company ${companyId} linked as ${number}`);
    }
    if (u.connection === 'close') {
      s.connected = false;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        // Unlinked on the phone: forget it; the CEO links again from the app when they want to.
        await report(s, 'logged_out');
        await rm(dir, { recursive: true, force: true });
        sessions.delete(companyId);
        return;
      }
      // Nobody scanned the code in time: wait for "Show the code" again (no endless codes).
      if (!s.everConnected && (code === DisconnectReason.timedOut || s.qrs >= 5)) {
        s.expired = true;
        await report(s, 'qr_expired');
        return;
      }
      setTimeout(() => { if (!s.stopped && sessions.get(companyId) === s) start(companyId, s.requestedAt).catch(e => logger.error(e)); }, 5_000);
    }
  });

  // Every new message, in every chat (the app's own sends are already known).
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages) {
      try {
        const jid = m.key.remoteJid ?? '';
        if (!m.message || !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) continue;
        if (m.key.fromMe && s.sent.has(m.key.id)) continue;
        const at = new Date(Number(m.messageTimestamp ?? Date.now() / 1000) * 1000);
        if (Date.now() - at.getTime() > FRESH_MS) continue;
        const x = inner(m) ?? {};
        const images = [];
        if (x.imageMessage) {
          const buf = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          if (buf?.length && buf.length < 4 * 1024 * 1024) images.push({ mime: x.imageMessage.mimetype?.split(';')[0] ?? 'image/jpeg', base64: buf.toString('base64') });
        }
        // A PDF (a purchase order or invoice printed from Pastel).
        const documents = [];
        if (x.documentMessage && (x.documentMessage.mimetype ?? '').startsWith('application/pdf')) {
          const buf = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          if (buf?.length && buf.length < 10 * 1024 * 1024) documents.push({ mime: 'application/pdf', base64: buf.toString('base64'), name: x.documentMessage.fileName ?? null });
        }
        const text = textOf(m);
        const other = otherOf(m);
        if (!text.trim() && !images.length && !documents.length && !other) continue;
        const isGroup = jid.endsWith('@g.us');
        if (isGroup && !s.names.has(jid)) await groups(s);
        const sender = m.key.fromMe ? null : (m.key.participant ?? m.participant ?? jid).split('@')[0].split(':')[0] || null;
        await api(companyId, 'POST', '/internal/whatsapp/message', {
          id: m.key.id, chatJid: jid, chatName: isGroup ? s.names.get(jid) ?? null : m.key.fromMe ? null : m.pushName ?? null, isGroup, fromMe: !!m.key.fromMe,
          at: at.toISOString(), senderName: m.key.fromMe ? null : m.pushName ?? null, sender, text, images, documents, other,
        });
      } catch (e) { logger.warn({ err: String(e), company: companyId }, 'could not pass a message on'); }
    }
  });

  // Groups added or renamed: the list in the app follows.
  const refresh = async () => { if (s.connected && s.sock === sock) await report(s, 'connected', { groups: await groups(s) }); };
  sock.ev.on('groups.upsert', refresh);
  sock.ev.on('groups.update', refresh);
}

async function stop(companyId) {
  const s = sessions.get(companyId);
  if (!s) return;
  s.stopped = true;
  sessions.delete(companyId);
  // Disconnected in the app: unlink the phone too (it shows under Linked devices no more).
  try { await s.sock?.logout(); } catch { try { s.sock?.end(undefined); } catch { /* gone */ } }
  await rm(join(AUTH_DIR, companyId), { recursive: true, force: true });
  logger.warn(`company ${companyId} unlinked`);
}

// Which companies want their phone linked; start, restart (a new "Show the code") and stop as asked.
async function sync() {
  let list;
  try { list = (await api(null, 'GET', '/internal/whatsapp/companies'))?.companies ?? []; } catch (e) { logger.warn({ err: String(e) }, 'companies'); return; }
  if (LEGACY && !list.some(c => c.companyId === LEGACY)) list.push({ companyId: LEGACY, requestedAt: null });
  const wanted = new Map(list.map(c => [c.companyId, c]));
  for (const [id, c] of wanted) {
    const s = sessions.get(id);
    if (!s) { await start(id, c.requestedAt).catch(e => logger.error(e)); continue; }
    const newer = c.requestedAt && (!s.requestedAt || c.requestedAt > s.requestedAt);
    if (newer && !s.connected) {
      s.stopped = true;
      try { s.sock?.end(undefined); } catch { /* restarting */ }
      await start(id, c.requestedAt).catch(e => logger.error(e));
    }
  }
  for (const id of [...sessions.keys()]) if (!wanted.has(id)) await stop(id);
}

// Send what the app has: its lines in the breakdowns group, and the office's replies, a few seconds apart.
async function postWaiting(s) {
  if (!s.connected || !s.sock) return;
  let out;
  try { out = await api(s.companyId, 'GET', '/internal/whatsapp/outbox'); } catch (e) { logger.warn({ err: String(e) }, 'outbox'); return; }
  s.groupJid = out?.groupJid ?? s.groupJid;
  s.poGroupJid = out ? out.poGroupJid ?? null : s.poGroupJid;
  const send = async (kind, id, jid, text) => {
    try {
      const sent = await s.sock.sendMessage(jid, { text });
      if (sent?.key?.id) { s.sent.add(sent.key.id); if (s.sent.size > 500) s.sent.delete(s.sent.values().next().value); }
      await api(s.companyId, 'POST', '/internal/whatsapp/sent', { id, kind, waId: sent?.key?.id ?? null });
    } catch (e) {
      await api(s.companyId, 'POST', '/internal/whatsapp/sent', { id, kind, error: String(e?.message ?? e).slice(0, 400) }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 2_500));
  };
  for (const p of out?.posts ?? []) await send('post', p.id, out.groupJid, p.text);
  for (const r of out?.replies ?? []) await send('reply', r.id, r.jid, r.text);
}

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try { for (const s of sessions.values()) await postWaiting(s); } finally { busy = false; }
}, 4_000);
setInterval(() => { for (const s of sessions.values()) if (s.connected) report(s, 'connected'); }, 30_000);
setInterval(() => { sync().catch(e => logger.error(e)); }, 5_000);
await sync();
