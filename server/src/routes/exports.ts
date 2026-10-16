// Export any document the app makes: the job card, a quote, invoice or credit note, a statement, a
// purchase order, timesheets, reports, the price list. The phone or computer sends the page as it is
// printed (on the letterhead, pictures inside it); the server keeps it as it went out, makes the PDF,
// and sends it on: download, a link for WhatsApp (opens without signing in, for a week), or email.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { audit, type Db, type Q } from '../db.ts';
import { can } from '../core/permissions.ts';
import { escHtml, jobReportHtml, type JobReportData } from '../core/jobReport.ts';
import { Refused, Uuid, parse } from '../http.ts';
import type { Mailer } from '../mailer.ts';
import { chromium, htmlToPdf, safePage } from '../pdf.ts';
import { saveDocument, uploadRoot } from '../uploads.ts';

export const EXPORT_KINDS = ['job_card', 'quote', 'invoice', 'credit_note', 'statement', 'purchase_order', 'timesheet', 'site_report', 'stock_take',
  'price_list', 'profit', 'debtors', 'crew', 'report', 'other'] as const;
export const EXPORT_LINK_DAYS = 7;
const MAX_HTML = 15 * 1024 * 1024;

const fileBase = (title: string) => title.replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Document';
const publicBase = (req: FastifyRequest) => (process.env.PUBLIC_URL ?? `${(req.headers['x-forwarded-proto'] as string) ?? req.protocol}://${req.headers['x-forwarded-host'] ?? req.headers.host}`).replace(/\/+$/, '');
/** A content-disposition header that any file name fits in (accents, dashes). */
export const disposition = (how: 'inline' | 'attachment', name: string) =>
  `${how}; filename="${name.normalize('NFKD').replace(/[^\x20-\x7e]/g, c => (c === '–' || c === '—' ? '-' : '')).replace(/["\\]/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
const PAGE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox allow-modals";

async function exportOf(c: Q, id: string) {
  const x = (await c.query('SELECT e.*, u.full_name AS made_by_name FROM doc_exports e JOIN users u ON u.id = e.made_by WHERE e.id = $1', [id])).rows[0];
  if (!x) throw new Refused(404, ['no such document']);
  return x;
}
/** Whoever made it, and the CEO (who sees everything that went out). */
function mayOpen(req: FastifyRequest, x: { made_by: string }) {
  if (x.made_by === req.actor.id || req.actor.level === 'creator') return;
  throw new Refused(403, ['not your document']);
}

/** The PDF, made once and filed; null when the server has no PDF maker (then the page itself goes). */
async function pdfOf(c: Q, companyId: string, x: { id: string; html: string; pdf_path: string | null; made_at: Date | string }): Promise<Buffer | null> {
  if (x.pdf_path) return readFile(join(uploadRoot(), x.pdf_path)).catch(() => null);
  const pdf = await htmlToPdf(x.html);
  if (!pdf) return null;
  const at = new Date(x.made_at).toISOString();
  const rel = await saveDocument(companyId, `export-${x.id}`, pdf, 'application/pdf', at).catch(() => null);
  if (rel) await c.query('UPDATE doc_exports SET pdf_path = $2 WHERE id = $1 AND pdf_path IS NULL', [x.id, rel]);
  return pdf;
}

/** A photo as a data address for the page (none if missing or purged). */
async function photoData(c: Q, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const p = (await c.query('SELECT file_path, content_type FROM photos WHERE id = $1 AND purged_at IS NULL', [id])).rows[0];
  if (!p || String(p.file_path).includes('..')) return null;
  try { return `data:${p.content_type ?? 'image/jpeg'};base64,${(await readFile(join(uploadRoot(), p.file_path))).toString('base64')}`; } catch { return null; }
}

/** The letterhead for a printed page: the CEO's top and bottom pictures, or the logo on the black and orange bar. */
export async function pageLetterhead(c: Q, label: string) {
  const prof = (await c.query('SELECT legal_name, trading_name, logo_photo_id FROM company_profile')).rows[0] ?? {};
  const lh = (await c.query('SELECT header_photo_id, footer_photo_id FROM company_letterhead')).rows[0];
  const company = prof.trading_name || prof.legal_name || (await c.query('SELECT name FROM companies WHERE id = current_company()')).rows[0]?.name || '';
  const top = await photoData(c, lh?.header_photo_id), bottom = await photoData(c, lh?.footer_photo_id), logo = top ? null : await photoData(c, prof.logo_photo_id);
  return {
    company,
    top: top ? `<img src="${top}" style="width:100%;display:block">` : `<div class=bar></div><div class=head>${logo ? `<img src="${logo}" style="height:52px;background:#fff;padding:4px;border-radius:4px;margin-right:14px">` : ''}<h1 style="flex:1">${escHtml(company)}</h1><div class=t>${escHtml(label)}</div></div>`,
    bottom: bottom ? `<img src="${bottom}" style="width:100%;display:block;margin-top:16px">` : '<div class=bar></div>',
  };
}

const MAX_ITEM_PHOTOS = 4;

/** Everything for the client's copy of a job card. */
export async function jobReportData(c: Q, jobId: string, company: string): Promise<JobReportData | null> {
  const j = (await c.query(
    `SELECT j.*, to_char(j.scheduled_date, 'YYYY-MM-DD') AS sched, s.name AS store, s.address AS store_address, cl.name AS client, u.full_name AS lead
       FROM jobs j JOIN stores s ON s.id = j.store_id JOIN clients cl ON cl.id = s.client_id JOIN users u ON u.id = j.lead_technician_id WHERE j.id = $1`, [jobId])).rows[0];
  if (!j) return null;
  const helpers = (await c.query('SELECT u.full_name AS name, u.trade FROM job_helpers h JOIN users u ON u.id = h.user_id WHERE h.job_id = $1 ORDER BY u.full_name', [jobId])).rows;
  const crew = (await c.query(
    `SELECT m.full_name AS name, m.kind, count(DISTINCT jc.work_date)::int AS days FROM job_crew jc JOIN crew_members m ON m.id = jc.member_id
      WHERE jc.job_id = $1 AND jc.removed_at IS NULL GROUP BY m.full_name, m.kind ORDER BY m.full_name`, [jobId])).rows;
  const visits = (await c.query(
    `SELECT v.arrived_at, v.ended_at, v.place, v.checked_in_manager, u.full_name AS technician FROM job_visits v JOIN users u ON u.id = v.technician_id WHERE v.job_id = $1 ORDER BY v.go_at`, [jobId])).rows;
  const items = (await c.query(
    `SELECT w.id, w.title, w.fault_type, w.found_text, w.did_text, w.tested, w.outcome, w.still_needed,
            nullif(concat_ws(' ', e.description, nullif(concat_ws(' ', e.brand, e.model), ''), CASE WHEN e.serial IS NOT NULL THEN '· serial ' || e.serial END), '') AS equipment
       FROM work_items w LEFT JOIN equipment e ON e.id = w.equipment_id WHERE w.job_id = $1 ORDER BY w.created_at`, [jobId])).rows;
  const photos = (await c.query(
    `SELECT id, work_item_id, kind FROM photos WHERE work_item_id = ANY($1::uuid[]) AND kind IN ('before', 'after') AND purged_at IS NULL ORDER BY taken_at`, [items.map(i => i.id)])).rows;
  const parts = [
    ...(await c.query(
      `SELECT i.code, i.description, i.unit, sum(m.qty)::float AS qty FROM stock_movements m JOIN stock_items i ON i.id = m.stock_item_id
        WHERE m.job_id = $1 AND m.kind = 'use_on_job' GROUP BY i.code, i.description, i.unit ORDER BY i.description`, [jobId])).rows,
    ...(await c.query('SELECT NULL AS code, description, NULL AS unit, qty::float AS qty FROM bought_out_items WHERE job_id = $1 ORDER BY description', [jobId])).rows,
  ].filter(p => Number(p.qty) > 0);
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  const photosOf = async (itemId: string, kind: string) => {
    const out: string[] = [];
    for (const p of photos.filter(x => x.work_item_id === itemId && x.kind === kind).slice(0, MAX_ITEM_PHOTOS)) { const u = await photoData(c, p.id); if (u) out.push(u); }
    return out;
  };
  return {
    company,
    job: { number: j.job_number, type: j.job_type, status: j.status, fault: j.fault_reported, scheduledDate: j.sched, clientRef: j.client_order_ref, closedAt: iso(j.closed_at),
      managerName: j.manager_name, unavailableReason: j.manager_unavailable_reason, unavailableSpokeTo: j.manager_unavailable_spoke_to, cancelNote: j.cancel_note },
    client: j.client, store: j.store, storeAddress: j.store_address, lead: j.lead, helpers, crew,
    visits: visits.map(v => ({ arrivedAt: iso(v.arrived_at), endedAt: iso(v.ended_at), place: v.place, checkedInWith: v.checked_in_manager, technician: v.technician })),
    items: await Promise.all(items.map(async i => ({ title: i.title, equipment: i.equipment, faultType: i.fault_type, found: i.found_text, did: i.did_text, tested: i.tested, outcome: i.outcome,
      stillNeeded: i.still_needed, before: await photosOf(i.id, 'before'), after: await photosOf(i.id, 'after') }))),
    parts: parts.map(p => ({ code: p.code, description: p.description, qty: Number(p.qty), unit: p.unit })),
    signature: await photoData(c, j.signature_photo_id),
  };
}

export function registerExportRoutes(app: FastifyInstance, db: Db, mailer: Mailer | null) {
  app.get('/exports/setup', async () => ({ pdf: !!chromium(), email: !!mailer, linkDays: EXPORT_LINK_DAYS }));

  app.post('/exports', { bodyLimit: MAX_HTML + 100_000 }, async (req, reply) => {
    const b = parse(z.object({ kind: z.enum(EXPORT_KINDS), title: z.string().trim().min(1).max(200), ref: z.string().trim().max(120).optional(), html: z.string().min(20).max(MAX_HTML) }), req.body);
    const id = (await req.db.query('INSERT INTO doc_exports (kind, title, ref, html, made_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [b.kind, b.title, b.ref || null, b.html, req.actor.id])).rows[0].id;
    await audit(req.db, req.actor.id, 'document_exported', 'doc_export', id, { kind: b.kind, title: b.title });
    return reply.code(201).send({ id, fileName: `${fileBase(b.title)}.${chromium() ? 'pdf' : 'html'}`, pdf: !!chromium(), email: !!mailer, linkDays: EXPORT_LINK_DAYS });
  });

  // The job card for the client: made here from the job (photos and signature in it), kept, then sent like any export.
  app.post('/jobs/:id/export', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const jobId = parse(Uuid, req.params.id);
    const office = can(req.actor, 'view_all_job_cards') || can(req.actor, 'assign_jobs') || can(req.actor, 'prepare_quotes_invoices');
    if (!office && !(await req.db.query('SELECT 1 FROM jobs j WHERE j.id = $1 AND (j.lead_technician_id = $2 OR EXISTS (SELECT 1 FROM job_helpers h WHERE h.job_id = j.id AND h.user_id = $2))', [jobId, req.actor.id])).rowCount) {
      throw new Refused(403, ['not your job card']);
    }
    const lh = await pageLetterhead(req.db, 'JOB CARD');
    const d = await jobReportData(req.db, jobId, lh.company);
    if (!d) throw new Refused(404, ['no such job']);
    const html = jobReportHtml(d, lh.top.replace('JOB CARD', `JOB CARD ${d.job.number}`), lh.bottom);
    const title = `Job card ${d.job.number} – ${d.client}, ${d.store}`;
    const id = (await req.db.query("INSERT INTO doc_exports (kind, title, ref, html, made_by) VALUES ('job_card', $1, $2, $3, $4) RETURNING id", [title, `job ${d.job.number}`, html, req.actor.id])).rows[0].id;
    await audit(req.db, req.actor.id, 'document_exported', 'doc_export', id, { kind: 'job_card', job: d.job.number });
    const store = (await req.db.query('SELECT s.email, cl.email AS client_email, cl.phone FROM jobs j JOIN stores s ON s.id = j.store_id JOIN clients cl ON cl.id = s.client_id WHERE j.id = $1', [jobId])).rows[0];
    return reply.code(201).send({ id, title, fileName: `${fileBase(title)}.${chromium() ? 'pdf' : 'html'}`, pdf: !!chromium(), email: !!mailer, linkDays: EXPORT_LINK_DAYS,
      storeEmail: store?.email ?? store?.client_email ?? null, phone: store?.phone ?? null });
  });

  // Download: the PDF (or the printable page when the server cannot make PDFs).
  app.get('/exports/:id/file', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const x = await exportOf(req.db, parse(Uuid, req.params.id));
    mayOpen(req, x);
    const pdf = await pdfOf(req.db, req.companyId, x);
    await req.db.query("INSERT INTO doc_export_sends (export_id, how, sent_by) VALUES ($1, 'download', $2)", [x.id, req.actor.id]);
    const name = `${fileBase(x.title)}.${pdf ? 'pdf' : 'html'}`;
    reply.header('content-disposition', disposition('attachment', name));
    if (pdf) return reply.type('application/pdf').send(pdf);
    return reply.header('content-security-policy', PAGE_CSP).type('text/html; charset=utf-8').send(safePage(x.html));
  });

  // A link for WhatsApp or a message: the client opens it on a phone or computer and prints it.
  app.post('/exports/:id/link', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const x = await exportOf(req.db, parse(Uuid, req.params.id));
    mayOpen(req, x);
    const token = app.jwt.sign({ sub: `exp:${x.id}`, cid: req.companyId }, { expiresIn: `${EXPORT_LINK_DAYS}d` });
    await req.db.query("INSERT INTO doc_export_sends (export_id, how, sent_by) VALUES ($1, 'link', $2)", [x.id, req.actor.id]);
    const url = `${publicBase(req)}/x/${token}`;
    const prof = (await req.db.query('SELECT trading_name, legal_name FROM company_profile')).rows[0] ?? {};
    return { url, expiresAt: new Date(Date.now() + EXPORT_LINK_DAYS * 86_400_000).toISOString(),
      message: `${x.title}${prof.trading_name || prof.legal_name ? ` from ${prof.trading_name || prof.legal_name}` : ''}. Open it to view, save or print: ${url}\n(The link works for ${EXPORT_LINK_DAYS} days.)` };
  });

  // (A wildcard: the token is longer than a route parameter may be.)
  app.get('/x/*', async (req: FastifyRequest<{ Params: { '*': string } }>, reply) => {
    let p: { sub?: string; cid?: string };
    try { p = app.jwt.verify(req.params['*']); } catch { return reply.code(410).type('text/plain').send('This link has expired. Ask for the document again.'); }
    if (!p.sub?.startsWith('exp:') || !p.cid) return reply.code(404).type('text/plain').send('No such document.');
    const c = await db.connect();
    try {
      await c.query("SELECT set_config('app.company_id', $1, false)", [p.cid]);
      const x = (await c.query('SELECT * FROM doc_exports WHERE id = $1', [p.sub.slice(4)])).rows[0];
      if (!x) return reply.code(404).type('text/plain').send('No such document.');
      const pdf = await pdfOf(c, p.cid, x);
      const name = `${fileBase(x.title)}.${pdf ? 'pdf' : 'html'}`;
      reply.header('content-disposition', disposition('inline', name)).header('cache-control', 'private, no-store');
      if (pdf) return reply.type('application/pdf').send(pdf);
      return reply.header('content-security-policy', PAGE_CSP).type('text/html; charset=utf-8').send(safePage(x.html));
    } finally {
      await c.query('RESET app.company_id').catch(() => {});
      c.release();
    }
  });

  // Emailed from the company's email (MAIL_URL) with the PDF attached.
  app.post('/exports/:id/email', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const b = parse(z.object({ to: z.array(z.string().trim().email()).min(1).max(5), message: z.string().trim().max(1000).optional() }), req.body);
    const x = await exportOf(req.db, parse(Uuid, req.params.id));
    mayOpen(req, x);
    if (!mailer) throw new Refused(503, ['email is not set up on the server yet: use WhatsApp or Download instead']);
    const pdf = await pdfOf(req.db, req.companyId, x);
    const prof = (await req.db.query('SELECT trading_name, legal_name, email FROM company_profile')).rows[0] ?? {};
    const me = (await req.db.query('SELECT full_name FROM users WHERE id = $1', [req.actor.id])).rows[0]?.full_name ?? '';
    const company = prof.trading_name || prof.legal_name || '';
    const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
    const text = `${b.message ? `${b.message}\n\n` : ''}Please find ${x.title} attached.\n\n${me}\n${company}`;
    let ok = true, error: string | null = null;
    try {
      await mailer({ to: b.to, replyTo: prof.email || null, fromName: company || null, subject: `${x.title}${company ? ` – ${company}` : ''}`, text,
        // Without a PDF maker the document itself is the email (and attached as a page to print).
        html: pdf ? `<p>${esc(text).replace(/\n/g, '<br>')}</p>` : safePage(x.html), pictures: [],
        files: [pdf ? { filename: `${fileBase(x.title)}.pdf`, mime: 'application/pdf', data: pdf } : { filename: `${fileBase(x.title)}.html`, mime: 'text/html', data: Buffer.from(safePage(x.html)) }] });
    } catch (e) { ok = false; error = (e as Error).message; }
    await req.db.query("INSERT INTO doc_export_sends (export_id, how, sent_to, sent_by, ok, error) VALUES ($1, 'email', $2, $3, $4, $5)", [x.id, b.to.join(', '), req.actor.id, ok, error]);
    if (!ok) throw new Refused(502, [`the email did not go: ${error}`]);
    return { sent: true, to: b.to, pdf: !!pdf };
  });

  // What went out: the CEO sees every document exported, who made it and where it went.
  app.get('/exports', async (req: FastifyRequest<{ Querystring: { all?: string } }>) => {
    const all = req.query.all === '1' && req.actor.level === 'creator';
    const { rows } = await req.db.query(
      `SELECT e.id, e.kind, e.title, e.ref, e.made_at, u.full_name AS made_by,
              (SELECT coalesce(json_agg(json_build_object('how', s.how, 'to', s.sent_to, 'at', s.sent_at, 'ok', s.ok) ORDER BY s.sent_at), '[]') FROM doc_export_sends s WHERE s.export_id = e.id) AS sends
         FROM doc_exports e JOIN users u ON u.id = e.made_by WHERE ($1::boolean OR e.made_by = $2) ORDER BY e.made_at DESC LIMIT 200`, [all, req.actor.id]);
    return { exports: rows };
  });
}
