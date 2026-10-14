// The WhatsApp link: the company's own WhatsApp number (a phone with its own SIM, used for nothing
// else) linked like WhatsApp Web. It reads the breakdowns group and hands each message to Real
// Sandbox, and posts the app's lines (new breakdowns from email, jobs logged) in the group.
//
// This is not WhatsApp's official business system (that one cannot join an existing group), so
// WhatsApp may block the number. Keep it to the company's own groups and low volumes. If it ever
// stops, nothing else stops: the group works as before and the email side keeps working.
//
// Settings (environment):
//   API_URL        the Real Sandbox server, e.g. http://api:8080
//   WA_BRIDGE_KEY  the same long random key as the server's WA_BRIDGE_KEY
//   COMPANY_ID     the company this number belongs to (shown under Settings → Breakdowns)
//   AUTH_DIR       where the link is remembered (keep it on a volume), default ./auth
import * as B from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { rm } from 'node:fs/promises';

const makeWASocket = B.makeWASocket ?? B.default?.default ?? B.default;
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, Browsers } = B;

const API = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const KEY = process.env.WA_BRIDGE_KEY ?? '';
const COMPANY = process.env.COMPANY_ID ?? '';
const AUTH_DIR = process.env.AUTH_DIR ?? './auth';
if (KEY.length < 24 || !/^[0-9a-f-]{36}$/i.test(COMPANY)) {
  console.error('Set WA_BRIDGE_KEY (24+ characters, the same as the server) and COMPANY_ID (from Settings → Breakdowns).');
  process.exit(1);
}
const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });

let sock = null;
let groupJid = null;
let poGroupJid = null;   // the purchase orders group (POs made outside the app)
let connected = false;
let lastQr = null;

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-bridge-key': KEY },
    body: body ? JSON.stringify({ companyId: COMPANY, ...body }) : undefined, signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function report(state, extra = {}) {
  try {
    const r = await api('POST', '/internal/whatsapp/status', { state, ...extra });
    groupJid = r?.groupJid ?? null;
    poGroupJid = r?.poGroupJid ?? null;
  } catch (e) { logger.warn({ err: String(e) }, 'could not reach the server'); }
}

async function groups() {
  try {
    const all = await sock.groupFetchAllParticipating();
    return Object.values(all).map(g => ({ jid: g.id, name: g.subject ?? g.id })).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return undefined; }
}

const textOf = m => m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? m.message?.imageMessage?.caption
  ?? m.message?.documentMessage?.caption ?? m.message?.ephemeralMessage?.message?.conversation ?? m.message?.ephemeralMessage?.message?.extendedTextMessage?.text ?? '';

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use the package's own */ }
  sock = makeWASocket({ ...(version ? { version } : {}), auth: state, logger, browser: Browsers.ubuntu('Real Sandbox'), markOnlineOnConnect: false, syncFullHistory: false });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async u => {
    if (u.qr && u.qr !== lastQr) {
      lastQr = u.qr;
      // Shown under Settings → Breakdowns: scan it with the ZSP phone (WhatsApp → Linked devices).
      await report('waiting_for_scan', { qrSvg: await QRCode.toString(u.qr, { type: 'svg', margin: 2 }) });
    }
    if (u.connection === 'open') {
      connected = true; lastQr = null;
      const number = sock.user?.id?.split(':')[0]?.split('@')[0] ?? null;
      await report('connected', { number, groups: await groups() });
      logger.warn(`linked as ${number}`);
    }
    if (u.connection === 'close') {
      connected = false;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        // Unlinked on the phone: forget the old link and show a new QR code.
        await report('logged_out');
        await rm(AUTH_DIR, { recursive: true, force: true });
      }
      setTimeout(() => start().catch(e => logger.error(e)), code === DisconnectReason.loggedOut ? 2_000 : 5_000);
    }
  });

  // New messages in the breakdowns group and the purchase orders group (only those; the app's own posts are skipped).
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe || ![groupJid, poGroupJid].filter(Boolean).includes(m.key.remoteJid)) continue;
        const images = [];
        const img = m.message.imageMessage ?? m.message.ephemeralMessage?.message?.imageMessage;
        if (img) {
          const buf = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          if (buf?.length && buf.length < 4 * 1024 * 1024) images.push({ mime: img.mimetype?.split(';')[0] ?? 'image/jpeg', base64: buf.toString('base64') });
        }
        // A PDF (a purchase order or invoice printed from Pastel).
        const documents = [];
        const doc = m.message.documentMessage ?? m.message.documentWithCaptionMessage?.message?.documentMessage ?? m.message.ephemeralMessage?.message?.documentMessage;
        if (doc && (doc.mimetype ?? '').startsWith('application/pdf')) {
          const buf = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          if (buf?.length && buf.length < 10 * 1024 * 1024) documents.push({ mime: 'application/pdf', base64: buf.toString('base64'), name: doc.fileName ?? null });
        }
        const text = textOf(m) || (m.message.documentWithCaptionMessage?.message?.documentMessage?.caption ?? '');
        if (!text.trim() && !images.length && !documents.length) continue;
        const sender = (m.key.participant ?? m.participant ?? '').split('@')[0].split(':')[0] || null;
        await api('POST', '/internal/whatsapp/message', {
          id: m.key.id, groupJid: m.key.remoteJid, at: new Date(Number(m.messageTimestamp ?? Date.now() / 1000) * 1000).toISOString(),
          senderName: m.pushName ?? null, sender, text, images, documents,
        });
      } catch (e) { logger.warn({ err: String(e) }, 'could not pass a message on'); }
    }
  });

  // Groups added or renamed: the list in Settings follows.
  sock.ev.on('groups.upsert', async () => { if (connected) await report('connected', { groups: await groups() }); });
  sock.ev.on('groups.update', async () => { if (connected) await report('connected', { groups: await groups() }); });
}

// Post what the app has for the group, a few seconds apart; report in every 30 seconds.
async function postWaiting() {
  if (!connected || !sock) return;
  let out;
  try { out = await api('GET', `/internal/whatsapp/outbox?companyId=${COMPANY}`); } catch (e) { logger.warn({ err: String(e) }, 'outbox'); return; }
  groupJid = out?.groupJid ?? groupJid;
  poGroupJid = out ? out.poGroupJid ?? null : poGroupJid;
  for (const p of out?.posts ?? []) {
    try {
      const sent = await sock.sendMessage(out.groupJid, { text: p.text });
      await api('POST', '/internal/whatsapp/sent', { id: p.id, waId: sent?.key?.id ?? null });
    } catch (e) {
      await api('POST', '/internal/whatsapp/sent', { id: p.id, error: String(e?.message ?? e).slice(0, 400) }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 2_500));
  }
}

let busy = false;
setInterval(async () => { if (busy) return; busy = true; try { await postWaiting(); } finally { busy = false; } }, 5_000);
setInterval(() => { if (connected) report('connected'); }, 30_000);
await start();
