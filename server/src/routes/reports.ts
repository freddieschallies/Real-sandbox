// The parts report: when a technician cannot finish because a part is needed and another quote is
// needed, he documents it step by step before leaving site (the machine or site, the serial tag, the
// part, more photos if he wants). It becomes a draft quote for the office and can be printed or
// emailed to the client on the company's letterhead. Also the letterhead itself, set by the CEO.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { audit, tx, type Q } from '../db.ts';
import { can } from '../core/permissions.ts';
import { Iso, Refused, Uuid, parse } from '../http.ts';
import { isOnJob, loadCard } from '../jobsRepo.ts';
import { notify } from './field.ts';
import type { Mailer, MailPicture } from '../mailer.ts';
import { uploadRoot } from '../uploads.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const CEO = ['director', 'creator'];

/** Whether this job's department asks for the parts report (by its lead technician's department). */
export async function partsReportRequired(c: Q, jobId: string): Promise<boolean> {
  const r = (await c.query(
    `SELECT coalesce(d.parts_report, false) AS on FROM jobs j JOIN users u ON u.id = j.lead_technician_id LEFT JOIN departments d ON d.id = u.department_id WHERE j.id = $1`, [jobId])).rows[0];
  return !!r?.on;
}

/** The reports on a job, newest first; `since` = only those made on or after that time (this visit). */
export async function reportsOn(c: Q, jobId: string) {
  return (await c.query(
    `SELECT r.id, r.report_number, r.created_at, r.part_description, r.part_qty::float AS part_qty, r.visit_id, q.quote_number, u.full_name AS created_by
       FROM job_reports r JOIN users u ON u.id = r.created_by LEFT JOIN quotes q ON q.id = r.quote_id WHERE r.job_id = $1 ORDER BY r.created_at DESC`, [jobId])).rows;
}

async function loadReport(c: Q, id: string) {
  const r = (await c.query(
    `SELECT r.*, r.part_qty::float AS part_qty, j.job_number, j.fault_reported, j.id AS job_id, s.name AS store, s.address AS store_address, s.email AS store_email,
            cl.name AS client, u.full_name AS technician, q.quote_number, q.id AS quote_id
       FROM job_reports r JOIN jobs j ON j.id = r.job_id JOIN stores s ON s.id = j.store_id JOIN clients cl ON cl.id = s.client_id
       JOIN users u ON u.id = r.created_by LEFT JOIN quotes q ON q.id = r.quote_id WHERE r.id = $1`, [id])).rows[0];
  if (!r) throw new Refused(404, ['no such report']);
  return r;
}

async function picture(c: Q, photoId: string | null | undefined, cid: string): Promise<MailPicture | null> {
  if (!photoId) return null;
  const p = (await c.query('SELECT file_path, content_type FROM photos WHERE id = $1 AND purged_at IS NULL', [photoId])).rows[0];
  if (!p) return null;
  if (String(p.file_path).includes('..')) return null;
  try { return { cid, mime: p.content_type ?? 'image/jpeg', data: await readFile(join(uploadRoot(), p.file_path)) }; } catch { return null; }
}

/** The letterhead for an email: the CEO's top and bottom pictures (or the logo and company details), as cid pictures. */
export async function letterheadForMail(c: Q) {
  const prof = (await c.query('SELECT legal_name, trading_name, email, phone, address, reg_no, vat_no, logo_photo_id, bank_details, invoice_terms FROM company_profile')).rows[0] ?? {};
  const lh = (await c.query('SELECT header_photo_id, footer_photo_id FROM company_letterhead')).rows[0];
  const pics: MailPicture[] = [];
  const add = async (photoId: string | null | undefined, cid: string) => { const p = await picture(c, photoId, cid); if (p) pics.push(p); return !!p; };
  const head = (await add(lh?.header_photo_id, 'letterhead-top')) ? '<img src="cid:letterhead-top" style="width:100%;max-width:700px;display:block">'
    : `${(await add(prof.logo_photo_id, 'logo')) ? '<img src="cid:logo" style="height:56px">' : ''}<div style="font:bold 18px Arial">${esc(prof.trading_name || prof.legal_name)}</div><div style="font:12px Arial;color:#555">${esc([prof.address, prof.phone, prof.email].filter(Boolean).join(' · '))}</div>`;
  const foot = (await add(lh?.footer_photo_id, 'letterhead-bottom')) ? '<img src="cid:letterhead-bottom" style="width:100%;max-width:700px;display:block">'
    : `<div style="font:11px Arial;color:#777">${esc([prof.legal_name, prof.reg_no ? `Reg ${prof.reg_no}` : '', prof.vat_no ? `VAT ${prof.vat_no}` : ''].filter(Boolean).join(' · '))}</div>`;
  return { prof, head, foot, pics, add };
}

export function registerReportRoutes(app: FastifyInstance, mailer: Mailer | null) {
  const sees = (req: FastifyRequest, createdBy: string) => {
    if (createdBy !== req.actor.id && !can(req.actor, 'view_all_job_cards')) throw new Refused(403, ['not your report']);
  };

  // The technician on the job writes it, on site (the job not finished). Sent again (no signal), it is kept once.
  app.post('/jobs/:id/parts-report', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const jobId = parse(Uuid, req.params.id);
    const b = parse(z.object({
      id: Uuid.optional(), at: Iso,
      machinePhotoId: Uuid, serialPhotoId: Uuid, serialText: z.string().trim().max(120).optional(),
      partPhotoId: Uuid, partDescription: z.string().trim().min(2, 'what part is needed').max(300), partQty: z.number().positive().max(10000).default(1),
      extraPhotoIds: z.array(Uuid).max(20).default([]), notes: z.string().trim().max(2000).optional(),
    }), req.body);
    const out = await tx(req.db, async c => {
      if (b.id) { const had = (await c.query('SELECT id, report_number, quote_id FROM job_reports WHERE id = $1', [b.id])).rows[0]; if (had) return { id: had.id, reportNumber: had.report_number, again: true }; }
      if (!(await isOnJob(c, jobId, req.actor.id))) throw new Refused(403, ['you are not on this job']);
      const j = (await c.query('SELECT j.status, j.job_number, j.store_id, s.name AS store FROM jobs j JOIN stores s ON s.id = j.store_id WHERE j.id = $1', [jobId])).rows[0];
      if (['closed', 'cancelled'].includes(j.status)) throw new Refused(409, ['the job is finished: start a new quote and link the job card for reference']);
      // Each picture: the right kind, taken by him for this job.
      const need: [string | undefined, string, string][] = [[b.machinePhotoId, 'report_machine', 'the photo of the whole machine or site'], [b.serialPhotoId, 'report_serial', 'the photo of the serial tag'], [b.partPhotoId, 'report_part', 'the photo of the part needed']];
      for (const id of b.extraPhotoIds) need.push([id, 'report_extra', 'an extra photo']);
      for (const [id, kind, what] of need) {
        const ok = (await c.query('SELECT 1 FROM photos WHERE id = $1 AND kind = $2 AND taken_by = $3', [id, kind, req.actor.id])).rowCount;
        if (!ok) throw new Refused(400, [`${what} was not received: take it again with signal`]);
      }
      // The visit he is on now (the same one Continue later checks).
      const visit = { id: (await loadCard(c, jobId))?.visitIds.at(-1) ?? null };
      const me = (await c.query('SELECT full_name FROM users WHERE id = $1', [req.actor.id])).rows[0].full_name;
      // The office's draft quote: the part, with the report for the details. They price it and send it.
      const p = (await c.query('SELECT vat_pct FROM company_profile')).rows[0];
      const q = (await c.query(
        `INSERT INTO quotes (job_id, title, notes, created_by, vat_pct, from_technician) VALUES ($1, $2, $3, $4, $5, true) RETURNING id, quote_number`,
        [jobId, `Parts needed: ${b.partDescription}`, [b.serialText ? `Serial: ${b.serialText}` : null, b.notes ?? null, 'See the parts report for photos.'].filter(Boolean).join('\n'), req.actor.id, p?.vat_pct ?? 15])).rows[0];
      await c.query("INSERT INTO document_lines (quote_id, kind, description, qty, unit_price_cents, position) VALUES ($1, 'bought_out', $2, $3, 0, 0)", [q.id, b.partDescription, b.partQty]);
      const r = (await c.query(
        `INSERT INTO job_reports (id, job_id, visit_id, created_by, created_at, machine_photo_id, serial_photo_id, serial_text, part_photo_id, part_description, part_qty, extra_photo_ids, notes, quote_id)
         VALUES (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id, report_number`,
        [b.id ?? null, jobId, visit?.id ?? null, req.actor.id, b.at, b.machinePhotoId, b.serialPhotoId, b.serialText || null, b.partPhotoId, b.partDescription, b.partQty, b.extraPhotoIds, b.notes || null, q.id])).rows[0];
      await audit(c, req.actor.id, 'parts_report', 'job_report', r.id, { jobId, quoteNumber: q.quote_number });
      for (const o of (await c.query("SELECT id FROM users WHERE login_level IN ('admin', 'director', 'creator') AND status <> 'left'")).rows) {
        await notify(c, o.id, 'parts_report', `${me} needs parts at ${j.store} (job ${j.job_number}): ${b.partDescription}. Report ${r.report_number}, quote ${q.quote_number} to price and send.`, { reportId: r.id, quoteId: q.id });
      }
      return { id: r.id, reportNumber: r.report_number, quoteId: q.id, quoteNumber: q.quote_number };
    });
    return reply.code(201).send(out);
  });

  app.get('/jobs/:id/parts-reports', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const jobId = parse(Uuid, req.params.id);
    if (!can(req.actor, 'view_all_job_cards') && !(await isOnJob(req.db, jobId, req.actor.id))) throw new Refused(403, ['not your job']);
    return reportsOn(req.db, jobId);
  });

  app.get('/parts-reports/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const r = await loadReport(req.db, parse(Uuid, req.params.id));
    sees(req, r.created_by);
    const emails = (await req.db.query(
      'SELECT e.sent_to, e.sent_at, e.ok, e.error, u.full_name AS sent_by FROM report_emails e JOIN users u ON u.id = e.sent_by WHERE e.report_id = $1 ORDER BY e.sent_at DESC', [r.id])).rows;
    return { report: r, emails, canEmail: !!mailer };
  });

  // Emails the report on the letterhead, the photos in the message. Every attempt is kept.
  app.post('/parts-reports/:id/email', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ to: z.array(z.string().trim().email('a valid email address')).min(1).max(10), message: z.string().trim().max(2000).optional() }), req.body);
    const r = await loadReport(req.db, id);
    sees(req, r.created_by);
    if (!mailer) throw new Refused(503, ['email is not set up on the server yet (MAIL_URL): print or save the report as PDF instead']);
    const c = req.db;
    const { prof, head, foot, pics, add } = await letterheadForMail(c);
    const photo = async (pid: string | null, cid: string, title: string, note?: string | null) => (await add(pid, cid))
      ? `<div style="margin:12px 0"><div style="font:bold 13px Arial">${esc(title)}</div>${note ? `<div style="font:13px Arial">${esc(note)}</div>` : ''}<img src="cid:${cid}" style="max-width:100%;width:520px;border:1px solid #ccc;margin-top:4px"></div>` : '';
    const body = [
      await photo(r.machine_photo_id, 'machine', 'The machine / site'),
      await photo(r.serial_photo_id, 'serial', 'Serial tag', r.serial_text ? `Serial number: ${r.serial_text}` : null),
      await photo(r.part_photo_id, 'part', 'Part needed', `${r.part_description}${r.part_qty !== 1 ? ` ×${r.part_qty}` : ''}`),
      ...(await Promise.all((r.extra_photo_ids as string[]).map((p, i) => photo(p, `extra${i + 1}`, `More (${i + 1})`)))),
    ].join('');
    const html = `<div style="max-width:700px;font:14px Arial;color:#111">${head}
<h2 style="font:bold 20px Arial;margin:16px 0 4px">Site report ${r.report_number}</h2>
<div style="font:13px Arial;color:#444">${esc(r.client)} · ${esc(r.store)} · job ${r.job_number} · ${esc(new Date(r.created_at).toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' }))} · ${esc(r.technician)}</div>
${b.message ? `<p>${esc(b.message).replace(/\n/g, '<br>')}</p>` : ''}
<p><b>Fault reported:</b> ${esc(r.fault_reported)}</p>${r.notes ? `<p><b>What we found:</b> ${esc(r.notes)}</p>` : ''}
<p>A quote for the part follows${r.quote_number ? ` (quote ${r.quote_number})` : ''}.</p>${body}<hr style="border:0;border-top:1px solid #ddd;margin:16px 0">${foot}</div>`;
    const text = [`Site report ${r.report_number}`, `${r.client} · ${r.store} · job ${r.job_number}`, b.message ?? '', `Fault: ${r.fault_reported}`, r.notes ? `Found: ${r.notes}` : '',
      r.serial_text ? `Serial: ${r.serial_text}` : '', `Part needed: ${r.part_description}${r.part_qty !== 1 ? ` x${r.part_qty}` : ''}`, 'Photos are in the HTML version of this email.'].filter(Boolean).join('\n');
    let ok = true, error: string | null = null;
    try {
      await mailer({ to: b.to, replyTo: prof.email || null, fromName: prof.trading_name || prof.legal_name || null, subject: `Site report ${r.report_number}: ${r.store}, job ${r.job_number}`, html, text, pictures: pics });
    } catch (e) { ok = false; error = (e as Error).message.slice(0, 300); }
    await c.query('INSERT INTO report_emails (report_id, sent_to, sent_by, ok, error) VALUES ($1, $2, $3, $4, $5)', [id, b.to, req.actor.id, ok, error]);
    await audit(c, req.actor.id, 'report_emailed', 'job_report', id, { to: b.to, ok });
    if (!ok) throw new Refused(502, [`the email did not go: ${error}`]);
    return { ok: true, to: b.to };
  });

  // ---- The letterhead -------------------------------------------------------------------------
  app.get('/company/letterhead', async req => {
    const r = (await req.db.query('SELECT header_photo_id, footer_photo_id FROM company_letterhead')).rows[0];
    return { headerPhotoId: r?.header_photo_id ?? null, footerPhotoId: r?.footer_photo_id ?? null, canEdit: CEO.includes(req.actor.level) };
  });
  app.put('/company/letterhead', async req => {
    if (!CEO.includes(req.actor.level)) throw new Refused(403, ['only the CEO sets the letterhead']);
    const b = parse(z.object({ headerPhotoId: Uuid.nullable().optional(), footerPhotoId: Uuid.nullable().optional() }), req.body);
    return tx(req.db, async c => {
      for (const id of [b.headerPhotoId, b.footerPhotoId]) {
        if (id && !(await c.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'letterhead'", [id])).rowCount) throw new Refused(400, ['upload the picture as the letterhead first']);
      }
      const cur = (await c.query('SELECT header_photo_id, footer_photo_id FROM company_letterhead')).rows[0];
      const head = b.headerPhotoId === undefined ? cur?.header_photo_id ?? null : b.headerPhotoId;
      const foot = b.footerPhotoId === undefined ? cur?.footer_photo_id ?? null : b.footerPhotoId;
      await c.query(`INSERT INTO company_letterhead (header_photo_id, footer_photo_id, updated_by) VALUES ($1, $2, $3)
                     ON CONFLICT (company_id) DO UPDATE SET header_photo_id = EXCLUDED.header_photo_id, footer_photo_id = EXCLUDED.footer_photo_id, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [head, foot, req.actor.id]);
      await audit(c, req.actor.id, 'letterhead_set', 'company', null, { head: !!head, foot: !!foot });
      return { headerPhotoId: head, footerPhotoId: foot };
    });
  });
}
