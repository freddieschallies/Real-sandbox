// The office's Breakdowns queue: every breakdown email and WhatsApp group message, read for the
// store, fault and call log number. The office logs one as a job (one tap, then check and assign),
// adds it to a job already open (the same call log number, or the same store), or marks it "not a
// job". The CEO connects the Gmail inboxes and the app's WhatsApp number, and chooses what the app
// posts in the group. The WhatsApp link (a separate service) talks to /internal/whatsapp/*.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.ts';
import { audit, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import { groupLine } from '../core/breakdownRead.ts';
import type { BreakdownReader } from '../breakdownReader.ts';
import { ingest, queuePost, sameJob, sealSecret, settingsOf, storesOf, testInbox } from '../intake.ts';
import { gmailOptions, type ImapOptions } from '../imap.ts';
import { companyActive } from '../auth.ts';
import { openCompanyConnection } from '../tenancy.ts';
import { createJob, NewJob } from './jobs.ts';
import { ingestPO } from './purchaseOrders.ts';
import { poReaderFromEnv, type POReader } from '../poReader.ts';
import { Iso, Refused, Uuid, parse } from '../http.ts';

export interface IntakeOptions { reader: BreakdownReader; connect?: (user: string, pass: string) => ImapOptions; bridgeKey?: string; poReader?: POReader }

const LIST = `SELECT b.id, b.channel, b.received_at, b.sender_name, b.sender, b.subject, b.body, b.photo_ids, b.attachments, b.kind, b.read_by,
       b.store_id, s.name AS store, cl.name AS client, b.store_text, b.fault, b.call_ref, b.urgent, b.status, b.job_id, j.job_number,
       hb.full_name AS handled_by, b.handled_at, b.note, b.escalated_at
  FROM breakdowns b LEFT JOIN stores s ON s.id = b.store_id LEFT JOIN clients cl ON cl.id = s.client_id
  LEFT JOIN jobs j ON j.id = b.job_id LEFT JOIN users hb ON hb.id = b.handled_by`;

export function registerBreakdownRoutes(app: FastifyInstance, db: Db, o: IntakeOptions) {
  const office = (req: FastifyRequest) => { if (!can(req.actor, 'assign_jobs')) throw new Refused(403, ['the breakdowns queue is for whoever opens jobs']); };
  const ceo = (req: FastifyRequest) => { if (!can(req.actor, 'manage_access')) throw new Refused(403, ['only the CEO connects the inboxes and WhatsApp']); };

  // What the pop-up needs: how many breakdowns are waiting, and the newest one.
  app.get('/breakdowns/count', async req => {
    office(req);
    const r = (await req.db.query(
      `SELECT count(*) FILTER (WHERE kind = 'breakdown')::int AS breakdowns, count(*) FILTER (WHERE kind <> 'breakdown')::int AS other
         FROM breakdowns WHERE status = 'new'`)).rows[0];
    const latest = (await req.db.query(`${LIST} WHERE b.status = 'new' AND b.kind = 'breakdown' ORDER BY b.received_at DESC LIMIT 1`)).rows[0] ?? null;
    return { ...r, latest: latest ? { id: latest.id, at: latest.received_at, store: latest.store ?? latest.store_text, fault: latest.fault, urgent: latest.urgent, channel: latest.channel } : null };
  });

  app.get('/breakdowns', async req => {
    office(req);
    const q = parse(z.object({ view: z.enum(['open', 'done']).default('open') }), req.query);
    const rows = q.view === 'open'
      ? (await req.db.query(`${LIST} WHERE b.status = 'new' ORDER BY (b.kind = 'breakdown') DESC, b.urgent DESC, b.received_at`)).rows
      : (await req.db.query(`${LIST} WHERE b.status <> 'new' AND b.handled_at > now() - interval '14 days' ORDER BY b.handled_at DESC LIMIT 200`)).rows;
    const items = [];
    for (const r of rows) items.push({ ...r, same: r.status === 'new' ? await sameJob(req.db, r) : null });
    const link = (await req.db.query('SELECT state, group_name FROM whatsapp_link')).rows[0] ?? null;
    const inboxes = (await req.db.query("SELECT address, last_checked_at, last_error FROM intake_sources WHERE active ORDER BY address")).rows;
    // What the app's number posted in the group lately (what everyone in the group sees).
    const posts = (await req.db.query('SELECT text, reason, created_at, sent_at, error FROM group_posts ORDER BY created_at DESC LIMIT 10')).rows;
    return { items, canSettings: can(req.actor, 'manage_access'), whatsapp: link, inboxes, posts };
  });

  // Log it: the job the office checked (store, fault, technician...), from this breakdown.
  app.post('/breakdowns/:id/log', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    office(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(NewJob, req.body);
    const out = await tx(req.db, async c => {
      const bd = (await c.query('SELECT * FROM breakdowns WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!bd) throw new Refused(404, ['no such breakdown']);
      if (bd.status !== 'new') throw new Refused(409, [`this one was already ${bd.status === 'ignored' ? 'marked not a job' : 'logged'}`]);
      const jobId = await createJob(c, req.actor.id, b);
      // The pictures that came with it go onto the job.
      if (bd.photo_ids.length) await c.query('UPDATE photos SET job_id = $2 WHERE id = ANY($1) AND job_id IS NULL', [bd.photo_ids, jobId]);
      await c.query("UPDATE breakdowns SET status = 'logged', job_id = $2, handled_by = $3, handled_at = now(), store_id = COALESCE(store_id, $4) WHERE id = $1", [id, jobId, req.actor.id, b.storeId]);
      // The same call (by its log number) waiting in the queue from the other channel is the same job.
      const ref = b.clientOrderRef ?? bd.call_ref;
      let merged = 0;
      if (ref) merged = (await c.query(
        "UPDATE breakdowns SET status = 'merged', job_id = $2, handled_by = $3, handled_at = now(), note = 'Same call log number' WHERE status = 'new' AND upper(call_ref) = upper($1) AND id <> $4",
        [ref, jobId, req.actor.id, id])).rowCount ?? 0;
      const j = (await c.query('SELECT j.job_number, s.name AS store, u.full_name AS tech FROM jobs j JOIN stores s ON s.id = j.store_id JOIN users u ON u.id = j.lead_technician_id WHERE j.id = $1', [jobId])).rows[0];
      if ((await settingsOf(c)).post_logged) await queuePost(c, 'logged', groupLine({ kind: 'logged', jobNumber: j.job_number, store: j.store, callRef: ref, tech: j.tech }), { breakdownId: id, jobId });
      await audit(c, req.actor.id, 'breakdown_logged', 'breakdown', id, { jobId, merged });
      return { jobId, jobNumber: j.job_number, merged };
    });
    return reply.code(201).send(out);
  });

  // Already a job: this message is added to it (a reminder, a second email about the same call).
  app.post('/breakdowns/:id/merge', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    office(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ jobId: Uuid }), req.body);
    return tx(req.db, async c => {
      const bd = (await c.query('SELECT status, photo_ids, call_ref FROM breakdowns WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!bd) throw new Refused(404, ['no such breakdown']);
      if (bd.status !== 'new') throw new Refused(409, ['this one was already handled']);
      const j = (await c.query("SELECT j.job_number, j.status, s.name AS store FROM jobs j JOIN stores s ON s.id = j.store_id WHERE j.id = $1", [b.jobId])).rows[0];
      if (!j) throw new Refused(404, ['no such job']);
      if (j.status === 'cancelled') throw new Refused(409, [`job #${j.job_number} was cancelled: log a new job instead`]);
      if (bd.photo_ids.length) await c.query('UPDATE photos SET job_id = $2 WHERE id = ANY($1) AND job_id IS NULL', [bd.photo_ids, b.jobId]);
      await c.query("UPDATE breakdowns SET status = 'merged', job_id = $2, handled_by = $3, handled_at = now() WHERE id = $1", [id, b.jobId, req.actor.id]);
      if ((await settingsOf(c)).post_logged) await queuePost(c, 'merged', groupLine({ kind: 'merged', jobNumber: j.job_number, store: j.store, callRef: bd.call_ref }), { breakdownId: id, jobId: b.jobId });
      await audit(c, req.actor.id, 'breakdown_merged', 'breakdown', id, { jobId: b.jobId });
      return { id, jobId: b.jobId, jobNumber: j.job_number };
    });
  });

  app.post('/breakdowns/:id/ignore', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    office(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ note: z.string().trim().max(500).optional(), alwaysIgnoreSender: z.boolean().optional() }), req.body ?? {});
    return tx(req.db, async c => {
      const bd = (await c.query('SELECT status, sender, kind FROM breakdowns WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!bd) throw new Refused(404, ['no such breakdown']);
      if (bd.status !== 'new') throw new Refused(409, ['this one was already handled']);
      if (bd.kind === 'breakdown' && (!b.note || b.note.length < 3)) throw new Refused(400, ['it reads like a breakdown: say why it is not a job (e.g. "already fixed", "not our client")']);
      await c.query("UPDATE breakdowns SET status = 'ignored', handled_by = $2, handled_at = now(), note = $3 WHERE id = $1", [id, req.actor.id, b.note || null]);
      if (b.alwaysIgnoreSender && bd.sender) {
        await c.query(`INSERT INTO breakdown_settings (ignore_senders, updated_by) VALUES (ARRAY[$1], $2)
                       ON CONFLICT (company_id) DO UPDATE SET ignore_senders = array(SELECT DISTINCT unnest(breakdown_settings.ignore_senders || ARRAY[$1])), updated_by = $2, updated_at = now()`,
          [bd.sender.toLowerCase(), req.actor.id]);
      }
      await audit(c, req.actor.id, 'breakdown_ignored', 'breakdown', id, { note: b.note ?? null, sender: b.alwaysIgnoreSender ? bd.sender : undefined });
      return { id, status: 'ignored' };
    });
  });

  // Marked "not a job" by mistake: back in the queue.
  app.post('/breakdowns/:id/reopen', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    office(req);
    const id = parse(Uuid, req.params.id);
    const r = await req.db.query("UPDATE breakdowns SET status = 'new', handled_by = NULL, handled_at = NULL, note = NULL WHERE id = $1 AND status = 'ignored'", [id]);
    if (!r.rowCount) throw new Refused(409, ['only a message marked "not a job" goes back in the queue']);
    await audit(req.db, req.actor.id, 'breakdown_reopened', 'breakdown', id);
    return { id, status: 'new' };
  });

  // ---- The CEO's settings -----------------------------------------------------------------------

  app.get('/breakdowns/settings', async req => {
    ceo(req);
    const st = await settingsOf(req.db);
    const inboxes = (await req.db.query('SELECT id, address, active, last_checked_at, last_error, created_at FROM intake_sources ORDER BY address')).rows;
    const link = (await req.db.query('SELECT state, qr_svg, number, groups, group_jid, group_name, po_group_jid, po_group_name, seen_at FROM whatsapp_link')).rows[0] ?? { state: 'not_linked', groups: [] };
    const posts = (await req.db.query('SELECT text, reason, created_at, sent_at, error FROM group_posts ORDER BY created_at DESC LIMIT 20')).rows;
    // The link reports in every few seconds; quiet for two minutes means it is not running.
    const running = !!link.seen_at && Date.now() - new Date(link.seen_at).getTime() < 120_000;
    return { settings: st, inboxes, whatsapp: { ...link, running }, posts, ai: !!process.env.ANTHROPIC_API_KEY, companyId: req.companyId };
  });

  app.put('/breakdowns/settings', async req => {
    ceo(req);
    const b = parse(z.object({
      postNew: z.boolean(), postLogged: z.boolean(), postOnSite: z.boolean(), postDone: z.boolean(),
      escalateAfterMin: z.number().int().min(5).max(240), ignoreSenders: z.array(z.string().trim().toLowerCase().min(3).max(200)).max(200),
    }), req.body);
    await req.db.query(
      `INSERT INTO breakdown_settings (post_new, post_logged, post_on_site, post_done, escalate_after_min, ignore_senders, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id) DO UPDATE SET post_new = $1, post_logged = $2, post_on_site = $3, post_done = $4, escalate_after_min = $5, ignore_senders = $6, updated_by = $7, updated_at = now()`,
      [b.postNew, b.postLogged, b.postOnSite, b.postDone, b.escalateAfterMin, [...new Set(b.ignoreSenders)], req.actor.id]);
    await audit(req.db, req.actor.id, 'breakdown_settings', 'company', req.companyId, b);
    return settingsOf(req.db);
  });

  // A Gmail inbox: its address and an app password (Google account → Security → App passwords).
  // The password is checked by signing in, then kept scrambled; it is never shown again.
  app.post('/breakdowns/inboxes', async req => {
    ceo(req);
    const b = parse(z.object({ address: z.string().trim().toLowerCase().email('a Gmail address'), appPassword: z.string().max(100) }), req.body);
    const pass = b.appPassword.replace(/\s+/g, '');
    if (pass.length < 8) throw new Refused(400, ['the 16-letter app password from Google (not the normal Gmail password)']);
    if ((await req.db.query('SELECT 1 FROM intake_sources WHERE address = $1', [b.address])).rowCount) throw new Refused(409, [`${b.address} is already connected`]);
    try { await testInbox((o.connect ?? gmailOptions)(b.address, pass)); } catch (e) {
      throw new Refused(400, [`could not sign in to ${b.address}: ${(e as Error).message}`, 'Use an app password: Google account → Security → 2-Step Verification → App passwords.']);
    }
    const id = (await req.db.query("INSERT INTO intake_sources (kind, address, secret_enc, created_by) VALUES ('gmail', $1, $2, $3) RETURNING id", [b.address, sealSecret(pass), req.actor.id])).rows[0].id;
    await audit(req.db, req.actor.id, 'inbox_connected', 'intake_source', id, { address: b.address });
    return { id, address: b.address };
  });

  app.delete('/breakdowns/inboxes/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    ceo(req);
    const id = parse(Uuid, req.params.id);
    const r = await req.db.query('UPDATE intake_sources SET active = false WHERE id = $1 RETURNING address', [id]);
    if (!r.rowCount) throw new Refused(404, ['no such inbox']);
    await audit(req.db, req.actor.id, 'inbox_disconnected', 'intake_source', id, { address: r.rows[0].address });
    return { id, active: false };
  });

  app.put('/breakdowns/whatsapp/group', async req => {
    ceo(req);
    const b = parse(z.object({ jid: z.string().min(5).max(100).nullable(), kind: z.enum(['breakdowns', 'pos']).default('breakdowns') }), req.body);
    const link = (await req.db.query('SELECT groups, group_jid, po_group_jid FROM whatsapp_link')).rows[0];
    if (b.kind === 'pos' && b.jid === null) {
      await req.db.query('UPDATE whatsapp_link SET po_group_jid = NULL, po_group_name = NULL, updated_at = now()');
      return { poGroupJid: null };
    }
    const g = ((link?.groups ?? []) as { jid: string; name: string }[]).find(x => x.jid === b.jid);
    if (!g) throw new Refused(400, ['the app\'s number is not in that group: add it to the group on a phone first']);
    if (b.kind === 'pos') {
      if (link?.group_jid === g.jid) throw new Refused(409, ['that is the breakdowns group: choose a group for purchase orders only']);
      await req.db.query('UPDATE whatsapp_link SET po_group_jid = $1, po_group_name = $2, updated_at = now()', [g.jid, g.name]);
      await audit(req.db, req.actor.id, 'whatsapp_po_group_chosen', 'company', req.companyId, { group: g.name });
      return { poGroupJid: g.jid, poGroupName: g.name };
    }
    if (link?.po_group_jid === g.jid) throw new Refused(409, ['that is the purchase orders group']);
    await req.db.query('UPDATE whatsapp_link SET group_jid = $1, group_name = $2, updated_at = now()', [g.jid, g.name]);
    await audit(req.db, req.actor.id, 'whatsapp_group_chosen', 'company', req.companyId, { group: g.name });
    return { groupJid: g.jid, groupName: g.name };
  });

  // ---- The WhatsApp link (a separate service on the same server) ------------------------------------

  const bridge = async (req: FastifyRequest) => {
    const want = o.bridgeKey ?? process.env.WA_BRIDGE_KEY ?? '';
    const got = String(req.headers['x-bridge-key'] ?? '');
    if (want.length < 24 || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw new Refused(401, ['not the WhatsApp link']);
    const companyId = parse(Uuid, (req.body as { companyId?: string })?.companyId ?? (req.query as { companyId?: string })?.companyId);
    if (!(await companyActive(db, companyId))) throw new Refused(403, ['company not active']);
    await openCompanyConnection(db, req, companyId);
    return companyId;
  };

  app.post('/internal/whatsapp/status', async req => {
    await bridge(req);
    const b = parse(z.object({
      companyId: Uuid, state: z.enum(['waiting_for_scan', 'connected', 'logged_out']), qrSvg: z.string().max(200_000).nullish(), number: z.string().max(40).nullish(),
      groups: z.array(z.object({ jid: z.string(), name: z.string() })).max(500).optional(),
    }), req.body);
    await req.db.query(
      `INSERT INTO whatsapp_link (state, qr_svg, number, groups, seen_at) VALUES ($1, $2, $3, COALESCE($4::jsonb, '[]'), now())
       ON CONFLICT (company_id) DO UPDATE SET state = $1, qr_svg = $2, number = COALESCE($3, whatsapp_link.number),
         groups = COALESCE($4::jsonb, whatsapp_link.groups), seen_at = now(), updated_at = now()`,
      [b.state, b.state === 'waiting_for_scan' ? b.qrSvg ?? null : null, b.number ?? null, b.groups ? JSON.stringify(b.groups) : null]);
    const link = (await req.db.query('SELECT group_jid, po_group_jid FROM whatsapp_link')).rows[0];
    return { groupJid: link?.group_jid ?? null, poGroupJid: link?.po_group_jid ?? null };
  });

  app.post('/internal/whatsapp/message', { bodyLimit: 40_000_000 }, async req => {
    const companyId = await bridge(req);
    const b = parse(z.object({
      companyId: Uuid, id: z.string().min(3).max(200), groupJid: z.string(), at: Iso, senderName: z.string().max(200).nullish(), sender: z.string().max(60).nullish(),
      text: z.string().max(20_000).default(''), images: z.array(z.object({ mime: z.string(), base64: z.string().max(6_000_000) })).max(6).default([]),
      documents: z.array(z.object({ mime: z.string(), base64: z.string().max(14_000_000), name: z.string().max(300).nullish() })).max(3).default([]),
    }), req.body);
    const link = (await req.db.query('SELECT group_jid, po_group_jid FROM whatsapp_link')).rows[0];
    // The purchase orders group: a PO made outside the app is added like the app's own.
    if (link?.po_group_jid && link.po_group_jid === b.groupJid) {
      const files = [...b.documents.filter(d => d.mime === 'application/pdf'), ...b.images].map(f => ({ mime: f.mime, data: Buffer.from(f.base64, 'base64') }));
      const poId = await tx(req.db, c => ingestPO(c, companyId, { messageId: b.id, at: new Date(b.at), senderName: b.senderName ?? null, text: b.text, files }, o.poReader ?? poReaderFromEnv()));
      return { ok: true, purchaseOrderId: poId, skipped: poId ? undefined : 'not a purchase order' };
    }
    if (!link?.group_jid || link.group_jid !== b.groupJid) return { ok: true, skipped: 'not the breakdowns group' };
    if (!b.text.trim() && !b.images.length) return { ok: true, skipped: 'empty' };
    const id = await ingest(req.db, companyId, {
      channel: 'whatsapp', externalId: b.id, receivedAt: new Date(b.at), senderName: b.senderName ?? null, sender: b.sender ?? null, subject: null,
      body: b.text, images: b.images.map(i => ({ mime: i.mime, data: Buffer.from(i.base64, 'base64') })), otherAttachments: [],
    }, o.reader);
    return { ok: true, breakdownId: id };
  });

  app.get('/internal/whatsapp/outbox', async req => {
    await bridge(req);
    const link = (await req.db.query('SELECT group_jid, po_group_jid FROM whatsapp_link')).rows[0];
    if (!link?.group_jid) return { groupJid: null, poGroupJid: link?.po_group_jid ?? null, posts: [] };
    const posts = (await req.db.query('SELECT id, text FROM group_posts WHERE sent_at IS NULL AND tries < 5 ORDER BY created_at LIMIT 10')).rows;
    return { groupJid: link.group_jid, poGroupJid: link.po_group_jid ?? null, posts };
  });

  app.post('/internal/whatsapp/sent', async req => {
    await bridge(req);
    const b = parse(z.object({ companyId: Uuid, id: Uuid, waId: z.string().max(200).nullish(), error: z.string().max(500).nullish() }), req.body);
    if (b.error) await req.db.query('UPDATE group_posts SET tries = tries + 1, error = $2 WHERE id = $1', [b.id, b.error]);
    else await req.db.query('UPDATE group_posts SET sent_at = now(), wa_id = $2, error = NULL WHERE id = $1', [b.id, b.waId ?? null]);
    return { ok: true };
  });

  // For tests and the stores list in Settings: the stores the reader matches against.
  app.get('/breakdowns/stores', async req => { office(req); return storesOf(req.db); });
}
