// WhatsApp, set up the easy way, and the WhatsApp tab.
//   The CEO chooses how the app gets its number (Start-up or Settings): the company's own phone (scan a QR
//   code once) or an official WhatsApp Business number (Meta's sign-up window). Then: choose the group,
//   send a test, done.
//   The office (whoever opens jobs) reads every chat live and replies from the app.
//   The link service asks which companies want a linked phone; WhatsApp's webhook brings the official
//   number's messages.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import type { Db, Q } from '../db.ts';
import { audit } from '../db.ts';
import { can } from '../core/permissions.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { eachCompany, ingest, openSecret, queuePost, sealSecret } from '../intake.ts';
import { keepChatMessage, metaConfig, officialConnect, officialMayWrite, officialMedia, officialSend, readWebhook, signatureOk, type Fetch, type MetaConfig } from '../whatsapp.ts';
import type { BreakdownReader } from '../breakdownReader.ts';

export interface WhatsAppOptions { reader: BreakdownReader; bridgeKey?: string; fetch?: Fetch; meta?: MetaConfig | null }

const LINK = `SELECT mode, state, qr_svg, number, groups, group_jid, group_name, po_group_jid, po_group_name, seen_at, wanted, link_requested_at, test_sent_at, test_ok_at,
                     official_number_id, official_name, breakdowns_from_chats FROM whatsapp_link`;
const TEST_LINE = '✅ Real Sandbox is connected to this group. Breakdowns posted here now come into the app by themselves.';

async function linkOf(c: Q) {
  return (await c.query(LINK)).rows[0] ?? null;
}
async function ensureLink(c: Q) {
  await c.query('INSERT INTO whatsapp_link DEFAULT VALUES ON CONFLICT (company_id) DO NOTHING');
}

export function registerWhatsAppRoutes(app: FastifyInstance, db: Db, o: WhatsAppOptions) {
  const ceo = (req: FastifyRequest) => { if (!can(req.actor, 'manage_access')) throw new Refused(403, ['only the CEO sets up WhatsApp']); };
  const office = (req: FastifyRequest) => { if (!can(req.actor, 'assign_jobs')) throw new Refused(403, ['WhatsApp in the app is for whoever opens jobs']); };
  const meta = () => (o.meta === undefined ? metaConfig() : o.meta);
  const f = () => o.fetch ?? fetch;

  // ---- Setting it up ---------------------------------------------------------------------------------

  /** Where the set-up is: which way, each step done or not, and what the screen needs for the next step. */
  const setupOf = async (c: Q) => {
    const l = await linkOf(c);
    const cfg = meta();
    const mode: 'phone' | 'official' = l?.mode ?? 'phone';
    const running = !!l?.seen_at && Date.now() - new Date(l.seen_at).getTime() < 120_000;
    const connected = l?.state === 'connected' && (mode === 'official' ? !!l?.official_number_id : true);
    const steps = mode === 'phone'
      ? [
        { key: 'phone', done: connected || !!l?.wanted },
        { key: 'link', done: connected },
        { key: 'group', done: connected && !!l?.group_jid },
        { key: 'test', done: !!l?.test_ok_at },
      ]
      : [
        { key: 'number', done: connected },
        { key: 'test', done: !!l?.test_ok_at },
      ];
    return {
      chosen: !!l, mode, state: l?.state ?? 'not_linked', connected, wanted: !!l?.wanted, running, qrSvg: l?.state === 'waiting_for_scan' ? l.qr_svg : null,
      linkRequestedAt: l?.link_requested_at ?? null, number: l?.number ?? null, groups: l?.groups ?? [], groupJid: l?.group_jid ?? null, groupName: l?.group_name ?? null,
      poGroupJid: l?.po_group_jid ?? null, poGroupName: l?.po_group_name ?? null, testSentAt: l?.test_sent_at ?? null, testOkAt: l?.test_ok_at ?? null,
      breakdownsFromChats: l?.breakdowns_from_chats ?? true,
      official: { available: !!cfg, appId: cfg?.appId ?? null, configId: cfg?.configId ?? null, name: l?.official_name ?? null },
      steps, done: steps.every(s => s.done),
    };
  };

  app.get('/whatsapp/setup', async req => { ceo(req); return setupOf(req.db); });

  // Which way: only while nothing is linked (disconnect first to change).
  app.post('/whatsapp/mode', async req => {
    ceo(req);
    const b = parse(z.object({ mode: z.enum(['phone', 'official']) }), req.body);
    await ensureLink(req.db);
    const l = await linkOf(req.db);
    if (l.mode !== b.mode && (l.state === 'connected' || l.wanted)) throw new Refused(409, ['disconnect the number you have first, then choose the other way']);
    if (b.mode === 'official' && !meta()) throw new Refused(409, ['the official WhatsApp number is not available yet: use your own phone for now']);
    await req.db.query('UPDATE whatsapp_link SET mode = $1, updated_at = now()', [b.mode]);
    await audit(req.db, req.actor.id, 'whatsapp_mode', 'company', req.companyId, { mode: b.mode });
    return setupOf(req.db);
  });

  // The phone way: "Show the code". The link service starts this company's link and puts a QR code here.
  app.post('/whatsapp/link', async req => {
    ceo(req);
    await ensureLink(req.db);
    const l = await linkOf(req.db);
    if (l.mode !== 'phone') throw new Refused(409, ['this company uses the official number']);
    if (l.state === 'connected') return setupOf(req.db);
    await req.db.query("UPDATE whatsapp_link SET wanted = true, link_requested_at = now(), state = 'starting', qr_svg = NULL, updated_at = now()");
    await audit(req.db, req.actor.id, 'whatsapp_link_requested', 'company', req.companyId);
    return setupOf(req.db);
  });

  // Disconnect: the phone way unlinks the phone (the link service logs out); the official way forgets the number.
  app.post('/whatsapp/disconnect', async req => {
    ceo(req);
    const l = await linkOf(req.db);
    if (!l) return setupOf(req.db);
    await req.db.query(
      `UPDATE whatsapp_link SET wanted = false, state = 'not_linked', qr_svg = NULL, number = NULL, groups = '[]', group_jid = NULL, group_name = NULL,
         po_group_jid = NULL, po_group_name = NULL, test_sent_at = NULL, test_ok_at = NULL, official_number_id = NULL, official_waba_id = NULL,
         official_name = NULL, official_token_enc = NULL, updated_at = now()`);
    if (l.official_number_id) await db.query('DELETE FROM wa_official_numbers WHERE phone_number_id = $1', [l.official_number_id]);
    await audit(req.db, req.actor.id, 'whatsapp_disconnected', 'company', req.companyId, { mode: l.mode });
    return setupOf(req.db);
  });

  // The official way: Meta's sign-up window gave a code and the number; the server does the rest.
  app.post('/whatsapp/official', async req => {
    ceo(req);
    const cfg = meta();
    if (!cfg) throw new Refused(409, ['the official WhatsApp number is not available yet']);
    const b = parse(z.object({ code: z.string().min(10).max(2000), phoneNumberId: z.string().regex(/^\d{5,30}$/), wabaId: z.string().regex(/^\d{5,30}$/) }), req.body);
    const taken = (await db.query('SELECT company_id FROM wa_official_numbers WHERE phone_number_id = $1', [b.phoneNumberId])).rows[0];
    if (taken && taken.company_id !== req.companyId) throw new Refused(409, ['that WhatsApp number is already connected to another company']);
    let got;
    try { got = await officialConnect(cfg, f(), b); } catch (e) { throw new Refused(400, [`WhatsApp did not accept it: ${(e as Error).message}`, 'Try "Connect with WhatsApp" again.']); }
    await ensureLink(req.db);
    await req.db.query(
      `UPDATE whatsapp_link SET mode = 'official', state = 'connected', wanted = false, number = $1, official_number_id = $2, official_waba_id = $3, official_name = $4,
         official_token_enc = $5, seen_at = now(), updated_at = now()`, [got.number, b.phoneNumberId, b.wabaId, got.name, sealSecret(got.token)]);
    await db.query('INSERT INTO wa_official_numbers (phone_number_id, company_id) VALUES ($1, $2) ON CONFLICT (phone_number_id) DO NOTHING', [b.phoneNumberId, req.companyId]);
    await audit(req.db, req.actor.id, 'whatsapp_official_connected', 'company', req.companyId, { number: got.number });
    return setupOf(req.db);
  });

  // Send a test. The phone way: a line in the breakdowns group. The official way: someone sends the number a message.
  app.post('/whatsapp/test', async req => {
    ceo(req);
    const l = await linkOf(req.db);
    if (!l || l.state !== 'connected') throw new Refused(409, ['link the number first']);
    if (l.mode === 'official') throw new Refused(409, ['with the official number: send it a WhatsApp from your own phone; it shows here when it arrives']);
    if (!l.group_jid) throw new Refused(409, ['choose the breakdowns group first']);
    await queuePost(req.db, 'test', TEST_LINE);
    await req.db.query('UPDATE whatsapp_link SET test_sent_at = now()');
    return setupOf(req.db);
  });
  app.post('/whatsapp/test/ok', async req => {
    ceo(req);
    await req.db.query('UPDATE whatsapp_link SET test_ok_at = now()');
    await audit(req.db, req.actor.id, 'whatsapp_tested', 'company', req.companyId);
    return setupOf(req.db);
  });

  app.put('/whatsapp/settings', async req => {
    ceo(req);
    const b = parse(z.object({ breakdownsFromChats: z.boolean() }), req.body);
    await ensureLink(req.db);
    await req.db.query('UPDATE whatsapp_link SET breakdowns_from_chats = $1', [b.breakdownsFromChats]);
    return setupOf(req.db);
  });

  // ---- The WhatsApp tab ------------------------------------------------------------------------------

  app.get('/whatsapp/chats', async req => {
    office(req);
    const l = await linkOf(req.db);
    const chats = (await req.db.query(
      `SELECT c.id, c.jid, c.name, c.is_group, c.last_at, c.last_text, c.unread, c.last_in_at,
              (c.jid = (SELECT group_jid FROM whatsapp_link)) AS breakdowns_group, (c.jid = (SELECT po_group_jid FROM whatsapp_link)) AS po_group
         FROM wa_chats c ORDER BY c.last_at DESC NULLS LAST LIMIT 300`)).rows;
    return {
      link: { mode: l?.mode ?? 'phone', connected: l?.state === 'connected', number: l?.number ?? null, running: !!l?.seen_at && Date.now() - new Date(l.seen_at).getTime() < 120_000 },
      canSetup: can(req.actor, 'manage_access'),
      chats: chats.map(c => ({ ...c, mayWrite: l?.mode !== 'official' || c.is_group ? true : officialMayWrite(c.last_in_at) })),
      unread: chats.reduce((n, c) => n + c.unread, 0),
    };
  });

  app.get('/whatsapp/chats/:id/messages', async (req: FastifyRequest<{ Params: { id: string }; Querystring: { before?: string } }>) => {
    office(req);
    const id = parse(Uuid, req.params.id);
    const chat = (await req.db.query('SELECT id, jid, name, is_group, last_in_at FROM wa_chats WHERE id = $1', [id])).rows[0];
    if (!chat) throw new Refused(404, ['no such chat']);
    const before = req.query.before ? new Date(req.query.before) : null;
    const rows = (await req.db.query(
      `SELECT m.id, m.from_me, m.sender, m.sender_name, m.at, m.text, m.photo_ids, m.attachments, m.status, m.error, u.full_name AS sent_by, m.breakdown_id
         FROM wa_messages m LEFT JOIN users u ON u.id = m.sent_by WHERE m.chat_id = $1 AND ($2::timestamptz IS NULL OR m.at < $2) ORDER BY m.at DESC LIMIT 60`, [id, before])).rows;
    await req.db.query('UPDATE wa_chats SET unread = 0 WHERE id = $1', [id]);
    const l = await linkOf(req.db);
    return { chat: { ...chat, mayWrite: l?.mode !== 'official' || chat.is_group ? true : officialMayWrite(chat.last_in_at) }, messages: rows.reverse(), more: rows.length === 60 };
  });

  app.post('/whatsapp/chats/:id/messages', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    office(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ text: z.string().trim().min(1, 'type the message').max(4000) }), req.body);
    const chat = (await req.db.query('SELECT id, jid, name, is_group, last_in_at FROM wa_chats WHERE id = $1', [id])).rows[0];
    if (!chat) throw new Refused(404, ['no such chat']);
    const l = await linkOf(req.db);
    if (!l || l.state !== 'connected') throw new Refused(409, ['WhatsApp is not connected: the CEO links it under Settings']);
    // A name on it, so the group knows who in the office wrote.
    const who = (await req.db.query('SELECT full_name FROM users WHERE id = $1', [req.actor.id])).rows[0]?.full_name ?? 'Office';
    const text = `${b.text}\n— ${who}`;
    if (l.mode === 'official') {
      if (!officialMayWrite(chat.last_in_at)) throw new Refused(409, ['WhatsApp only lets the official number write within 24 hours of their last message: ask them to send a message first, or phone them']);
      const cfg = meta();
      if (!cfg || !l.official_number_id) throw new Refused(409, ['the official number is not set up']);
      const row = (await req.db.query("INSERT INTO wa_messages (chat_id, from_me, at, text, status, sent_by) VALUES ($1, true, now(), $2, 'queued', $3) RETURNING id", [id, text, req.actor.id])).rows[0];
      try {
        const token = openSecret((await req.db.query('SELECT official_token_enc FROM whatsapp_link')).rows[0].official_token_enc);
        const waId = await officialSend(cfg, f(), token, l.official_number_id, chat.jid, text);
        await req.db.query("UPDATE wa_messages SET status = 'sent', wa_id = $2 WHERE id = $1", [row.id, waId]);
      } catch (e) {
        await req.db.query("UPDATE wa_messages SET status = 'failed', error = $2 WHERE id = $1", [row.id, (e as Error).message.slice(0, 400)]);
      }
      await req.db.query('UPDATE wa_chats SET last_at = now(), last_text = $2 WHERE id = $1', [id, b.text.slice(0, 160)]);
      return { id: row.id };
    }
    // The phone way: the link service sends it within a few seconds.
    const row = (await req.db.query("INSERT INTO wa_messages (chat_id, from_me, at, text, status, sent_by) VALUES ($1, true, now(), $2, 'queued', $3) RETURNING id", [id, text, req.actor.id])).rows[0];
    await req.db.query('UPDATE wa_chats SET last_at = now(), last_text = $2 WHERE id = $1', [id, b.text.slice(0, 160)]);
    return { id: row.id };
  });

  // A message in any chat (not the breakdowns group) that is a breakdown: into the Breakdowns queue.
  app.post('/whatsapp/messages/:id/breakdown', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    office(req);
    const id = parse(Uuid, req.params.id);
    const m = (await req.db.query('SELECT id, wa_id, at, text, sender, sender_name, photo_ids, breakdown_id, from_me FROM wa_messages WHERE id = $1', [id])).rows[0];
    if (!m) throw new Refused(404, ['no such message']);
    if (m.breakdown_id) return { breakdownId: m.breakdown_id };
    if (m.from_me) throw new Refused(400, ['that is the office\'s own message']);
    const bid = await ingest(req.db, req.companyId, {
      channel: 'whatsapp', externalId: m.wa_id ?? m.id, receivedAt: new Date(m.at), senderName: m.sender_name, sender: m.sender, subject: null, body: m.text, images: [], otherAttachments: [],
    }, o.reader);
    const got = bid ?? (await req.db.query("SELECT id FROM breakdowns WHERE channel = 'whatsapp' AND external_id = $1", [m.wa_id ?? m.id])).rows[0]?.id ?? null;
    if (got) {
      await req.db.query('UPDATE wa_messages SET breakdown_id = $1 WHERE id = $2', [got, id]);
      if (m.photo_ids?.length) await req.db.query('UPDATE breakdowns SET photo_ids = $2 WHERE id = $1 AND cardinality(photo_ids) = 0', [got, m.photo_ids]);
    }
    return { breakdownId: got };
  });

  // ---- The link service: which companies want their phone linked ---------------------------------------

  app.get('/internal/whatsapp/companies', async req => {
    const want = o.bridgeKey ?? process.env.WA_BRIDGE_KEY ?? '';
    const got = String(req.headers['x-bridge-key'] ?? '');
    if (want.length < 24 || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw new Refused(401, ['not the WhatsApp link']);
    const out: { companyId: string; requestedAt: string | null; connected: boolean }[] = [];
    await eachCompany(db, async (c, companyId) => {
      const l = (await c.query("SELECT wanted, link_requested_at, state FROM whatsapp_link WHERE mode = 'phone'")).rows[0];
      if (l?.wanted) out.push({ companyId, requestedAt: l.link_requested_at ? new Date(l.link_requested_at).toISOString() : null, connected: l.state === 'connected' });
    });
    return { companies: out };
  });

  // ---- WhatsApp's webhook for official numbers ----------------------------------------------------------

  app.register(async inst => {
    // The signature is over the exact bytes WhatsApp sent.
    inst.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    inst.get('/webhooks/whatsapp', async (req: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
      const cfg = meta();
      if (!cfg || req.query['hub.mode'] !== 'subscribe' || req.query['hub.verify_token'] !== cfg.verifyToken) return reply.code(403).send('no');
      return reply.type('text/plain').send(req.query['hub.challenge'] ?? '');
    });
    inst.post('/webhooks/whatsapp', async (req, reply) => {
      const cfg = meta();
      const raw = req.body as Buffer;
      if (!cfg || !Buffer.isBuffer(raw) || !signatureOk(raw, req.headers['x-hub-signature-256'] as string | undefined, cfg.appSecret)) return reply.code(401).send({ error: 'not from WhatsApp' });
      let body: unknown;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ error: 'bad json' }); }
      const { messages, statuses } = readWebhook(body);
      const numbers = [...new Set([...messages, ...statuses].map(x => x.phoneNumberId))];
      for (const pid of numbers) {
        const owner = (await db.query('SELECT company_id FROM wa_official_numbers WHERE phone_number_id = $1', [pid])).rows[0];
        if (!owner) continue;
        const c = await db.connect();
        try {
          await c.query("SELECT set_config('app.company_id', $1, false)", [owner.company_id]);
          await c.query('BEGIN');
          const l = (await c.query('SELECT official_token_enc, breakdowns_from_chats FROM whatsapp_link')).rows[0];
          const token = l?.official_token_enc ? openSecret(l.official_token_enc) : null;
          for (const m of messages.filter(x => x.phoneNumberId === pid)) {
            const img = m.imageId && token ? await officialMedia(cfg, f(), token, m.imageId).catch(() => null) : null;
            const kept = await keepChatMessage(c, owner.company_id, {
              chatJid: m.from, chatName: m.name, isGroup: false, waId: m.waId, fromMe: false, sender: m.from, senderName: m.name, at: m.at, text: m.text,
              images: img ? [img] : [], attachments: m.other ? [m.other] : [],
            });
            // The first message after "send a test" passes the test.
            await c.query('UPDATE whatsapp_link SET test_ok_at = coalesce(test_ok_at, now()), seen_at = now()');
            if (kept && l?.breakdowns_from_chats && (m.text.trim() || img)) {
              const bid = await ingest(c, owner.company_id, { channel: 'whatsapp', externalId: m.waId, receivedAt: m.at, senderName: m.name, sender: m.from, subject: null, body: m.text, images: img ? [img] : [], otherAttachments: [] }, o.reader);
              if (bid) await c.query('UPDATE wa_messages SET breakdown_id = $1 WHERE id = $2', [bid, kept.id]);
            }
          }
          for (const s of statuses.filter(x => x.phoneNumberId === pid)) {
            if (s.status === 'failed') await c.query("UPDATE wa_messages SET status = 'failed', error = $2 WHERE wa_id = $1", [s.waId, s.error ?? 'not delivered']);
          }
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          req.log.error(e);
        } finally {
          await c.query('RESET app.company_id').catch(() => {});
          c.release();
        }
      }
      return { ok: true };
    });
  });

}
