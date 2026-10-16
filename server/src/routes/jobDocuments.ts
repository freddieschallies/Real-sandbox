// Documents on a job card. The office adds what the technician needs on site, e.g. another company's
// own service form to fill in; the technician opens it, prints it on site through the client (a link on
// WhatsApp, an email with the file, or download), and brings back the filled-in form as a file or photo.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { audit, tx, type Db, type Q } from '../db.ts';
import { can } from '../core/permissions.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { disposition } from './exports.ts';
import type { Mailer } from '../mailer.ts';
import { openFile, removeFile, uploadRoot } from '../uploads.ts';
import { mkdir, writeFile } from 'node:fs/promises';

/** The kinds of file a document may be (what offices and other companies send). */
export const DOC_TYPES: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'text/plain': 'txt',
};
const BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(DOC_TYPES).map(([m, e]) => [e, m]));
export const LINK_DAYS = 7;

const office = (req: FastifyRequest) => can(req.actor, 'view_all_job_cards') || can(req.actor, 'assign_jobs');
async function onJob(c: Q, jobId: string, userId: string) {
  return !!(await c.query('SELECT 1 FROM jobs j WHERE j.id = $1 AND (j.lead_technician_id = $2 OR EXISTS (SELECT 1 FROM job_helpers h WHERE h.job_id = j.id AND h.user_id = $2))', [jobId, userId])).rowCount;
}
async function mayOpen(req: FastifyRequest, jobId: string) {
  if (office(req) || await onJob(req.db, jobId, req.actor.id)) return;
  throw new Refused(403, ['not your job card']);
}
async function docOf(c: Q, id: string) {
  const d = (await c.query(
    `SELECT d.*, j.job_number, s.name AS store, s.email AS store_email FROM job_documents d JOIN jobs j ON j.id = d.job_id JOIN stores s ON s.id = j.store_id
      WHERE d.id = $1 AND d.removed_at IS NULL`, [id])).rows[0];
  if (!d) throw new Refused(404, ['no such document (or it was taken off the job)']);
  return d;
}
const fileName = (d: { name: string; content_type: string | null }) => {
  const ext = DOC_TYPES[d.content_type ?? ''] ?? 'jpg';
  return d.name.toLowerCase().endsWith(`.${ext}`) ? d.name : `${d.name}.${ext}`;
};
/** Where the documents' files are read from: a file of its own, or the photo of a filled-in form. */
async function fileOf(c: Q, d: { file_path: string | null; photo_id: string | null; content_type: string | null }) {
  if (d.file_path) return { path: d.file_path, type: d.content_type ?? 'application/octet-stream' };
  const p = (await c.query('SELECT file_path, content_type FROM photos WHERE id = $1', [d.photo_id])).rows[0];
  return { path: p.file_path as string, type: (p.content_type as string) ?? 'image/jpeg' };
}
const publicBase = (req: FastifyRequest) => (process.env.PUBLIC_URL ?? `${(req.headers['x-forwarded-proto'] as string) ?? req.protocol}://${req.headers['x-forwarded-host'] ?? req.headers.host}`).replace(/\/+$/, '');

export function registerJobDocumentRoutes(app: FastifyInstance, db: Db, mailer: Mailer | null) {
  const view = (r: Record<string, unknown>, mine: string) => ({
    id: r.id, name: r.name, kind: r.kind, contentType: r.content_type ?? 'image/jpeg', bytes: r.bytes, photoId: r.photo_id, note: r.note,
    addedBy: r.added_by_name, addedAt: r.added_at, canRemove: r.added_by === mine, sent: r.sent ?? [],
  });

  app.get('/jobs/:id/documents', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const jobId = parse(Uuid, req.params.id);
    await mayOpen(req, jobId);
    const { rows } = await req.db.query(
      `SELECT d.*, u.full_name AS added_by_name,
              (SELECT coalesce(json_agg(json_build_object('how', x.how, 'to', x.sent_to, 'at', x.sent_at, 'by', b.full_name, 'ok', x.ok) ORDER BY x.sent_at DESC), '[]')
                 FROM job_document_sends x JOIN users b ON b.id = x.sent_by WHERE x.document_id = d.id) AS sent
         FROM job_documents d JOIN users u ON u.id = d.added_by WHERE d.job_id = $1 AND d.removed_at IS NULL ORDER BY d.kind, d.added_at`, [jobId]);
    const store = (await req.db.query('SELECT s.email FROM jobs j JOIN stores s ON s.id = j.store_id WHERE j.id = $1', [jobId])).rows[0];
    return { documents: rows.map(r => ({ ...view(r, req.actor.id), canRemove: r.added_by === req.actor.id || office(req) })), canAdd: office(req), canEmail: !!mailer, storeEmail: store?.email ?? null, linkDays: LINK_DAYS };
  });

  // A file: the office adds forms for site; the technician a filled-in form.
  app.post('/jobs/:id/documents', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const jobId = parse(Uuid, req.params.id);
    await mayOpen(req, jobId);
    if (!req.isMultipart()) throw new Refused(400, ['send the document as multipart/form-data']);
    const fields: Record<string, string> = {};
    let file: { buffer: Buffer; mime: string; name: string } | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (part.file.truncated) throw new Refused(413, ['the document is larger than 4 MB: save it smaller (e.g. as PDF) and try again']);
        const ext = (part.filename ?? '').split('.').pop()?.toLowerCase() ?? '';
        const mime = DOC_TYPES[part.mimetype] ? part.mimetype : BY_EXT[ext] ?? part.mimetype;
        file = { buffer, mime, name: part.filename ?? 'document' };
      } else fields[part.fieldname] = String(part.value);
    }
    if (!file || !file.buffer.length) throw new Refused(400, ['no document attached']);
    if (!DOC_TYPES[file.mime]) throw new Refused(415, ['a PDF, Word, Excel or a picture']);
    const f = parse(z.object({ name: z.string().trim().max(200).optional(), kind: z.enum(['for_site', 'filled_in']).optional(), note: z.string().trim().max(500).optional() }), fields);
    const kind = f.kind ?? (office(req) ? 'for_site' : 'filled_in');
    if (kind === 'for_site' && !office(req)) throw new Refused(403, ['the office adds the forms for site; you add the filled-in form']);
    const id = randomUUID();
    const at = new Date().toISOString();
    const rel = join(req.companyId, 'documents', at.slice(0, 7), `${id}.${DOC_TYPES[file.mime]}`);
    await mkdir(join(uploadRoot(), rel, '..'), { recursive: true });
    await writeFile(join(uploadRoot(), rel), file.buffer, { flag: 'wx' });
    const name = (f.name || file.name.replace(/\.[a-z0-9]+$/i, '') || 'Document').slice(0, 200);
    try {
      await req.db.query(
        `INSERT INTO job_documents (id, job_id, name, kind, file_path, content_type, bytes, note, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, jobId, name, kind, rel, file.mime, file.buffer.length, f.note || null, req.actor.id]);
      await audit(req.db, req.actor.id, 'job_document_added', 'job', jobId, { name, kind });
    } catch (e) { await removeFile(rel); throw e; }
    return reply.code(201).send({ id, name });
  });

  // The technician's photo of the filled-in, signed form.
  app.post('/jobs/:id/documents/photo', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const jobId = parse(Uuid, req.params.id);
    await mayOpen(req, jobId);
    const b = parse(z.object({ photoId: Uuid, name: z.string().trim().min(1).max(200), note: z.string().trim().max(500).optional() }), req.body);
    if (!(await req.db.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'job_form' AND taken_by = $2", [b.photoId, req.actor.id])).rowCount) throw new Refused(409, ['send the photo first']);
    const id = (await req.db.query(
      `INSERT INTO job_documents (job_id, name, kind, photo_id, content_type, note, added_by) VALUES ($1, $2, 'filled_in', $3, 'image/jpeg', $4, $5) RETURNING id`,
      [jobId, b.name, b.photoId, b.note || null, req.actor.id])).rows[0].id;
    await audit(req.db, req.actor.id, 'job_document_added', 'job', jobId, { name: b.name, kind: 'filled_in' });
    return reply.code(201).send({ id });
  });

  app.get('/job-documents/:id/file', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const d = await docOf(req.db, parse(Uuid, req.params.id));
    await mayOpen(req, d.job_id);
    const f = await fileOf(req.db, d);
    reply.header('content-type', f.type).header('content-disposition', disposition('inline', fileName(d)));
    return reply.send(openFile(f.path));
  });

  // A link for the client (WhatsApp, a message): opens and prints the document, for a week, without signing in.
  app.post('/job-documents/:id/link', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const d = await docOf(req.db, parse(Uuid, req.params.id));
    await mayOpen(req, d.job_id);
    const token = app.jwt.sign({ sub: `doc:${d.id}`, cid: req.companyId }, { expiresIn: `${LINK_DAYS}d` });
    await req.db.query("INSERT INTO job_document_sends (document_id, how, sent_by) VALUES ($1, 'link', $2)", [d.id, req.actor.id]);
    const url = `${publicBase(req)}/d/${token}`;
    return { url, expiresAt: new Date(Date.now() + LINK_DAYS * 86_400_000).toISOString(), name: fileName(d),
      message: `${d.name} for job ${d.job_number} (${d.store}). Open it to print: ${url}\n(The link works for ${LINK_DAYS} days.)` };
  });

  // (A wildcard: the token is longer than a route parameter may be.)
  app.get('/d/*', async (req: FastifyRequest<{ Params: { '*': string } }>, reply) => {
    let p: { sub?: string; cid?: string };
    try { p = app.jwt.verify(req.params['*']); } catch { return reply.code(410).type('text/plain').send('This link has expired. Ask for the document again.'); }
    if (!p.sub?.startsWith('doc:') || !p.cid) return reply.code(404).type('text/plain').send('No such document.');
    const c = await db.connect();
    try {
      await c.query("SELECT set_config('app.company_id', $1, false)", [p.cid]);
      const d = (await c.query('SELECT * FROM job_documents WHERE id = $1 AND removed_at IS NULL', [p.sub.slice(4)])).rows[0];
      if (!d) return reply.code(404).type('text/plain').send('This document was taken off the job.');
      const f = await fileOf(c, d);
      const buf = await readFile(join(uploadRoot(), f.path));
      return reply.header('content-type', f.type).header('content-disposition', disposition('inline', fileName(d))).send(buf);
    } finally {
      await c.query('RESET app.company_id').catch(() => {});
      c.release();
    }
  });

  // Emailed with the file attached, from the company's email (MAIL_URL), e.g. to the store to print.
  app.post('/job-documents/:id/email', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const b = parse(z.object({ to: z.array(z.string().trim().email()).min(1).max(5), message: z.string().trim().max(1000).optional() }), req.body);
    return tx(req.db, async c => {
      const d = await docOf(c, parse(Uuid, req.params.id));
      await mayOpen(req, d.job_id);
      if (!mailer) throw new Refused(503, ['email is not set up on the server yet: use the WhatsApp link or Download instead']);
      const f = await fileOf(c, d);
      const data = await readFile(join(uploadRoot(), f.path));
      const prof = (await c.query('SELECT trading_name, legal_name, email FROM company_profile')).rows[0] ?? {};
      const me = (await c.query('SELECT full_name FROM users WHERE id = $1', [req.actor.id])).rows[0]?.full_name ?? '';
      const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
      const text = `${b.message ? `${b.message}\n\n` : ''}Please find ${d.name} for job ${d.job_number} (${d.store}) attached.\n\n${me}\n${prof.trading_name || prof.legal_name || ''}`;
      let ok = true, error: string | null = null;
      try {
        await mailer({ to: b.to, replyTo: prof.email || null, fromName: prof.trading_name || prof.legal_name || null, subject: `${d.name}: job ${d.job_number}, ${d.store}`,
          text, html: `<p>${esc(text).replace(/\n/g, '<br>')}</p>`, pictures: [], files: [{ filename: fileName(d), mime: f.type, data }] });
      } catch (e) { ok = false; error = (e as Error).message; }
      await c.query("INSERT INTO job_document_sends (document_id, how, sent_to, sent_by, ok, error) VALUES ($1, 'email', $2, $3, $4, $5)", [d.id, b.to.join(', '), req.actor.id, ok, error]);
      if (!ok) throw new Refused(502, [`the email did not go: ${error}`]);
      return { sent: true, to: b.to };
    });
  });

  // Taken off the job (kept in the history; the file stays on the server).
  app.post('/job-documents/:id/remove', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const b = parse(z.object({ reason: z.string().trim().max(300).optional() }), req.body ?? {});
    const d = await docOf(req.db, parse(Uuid, req.params.id));
    if (!office(req) && d.added_by !== req.actor.id) throw new Refused(403, ['only the office, or whoever added it, takes a document off the job']);
    await req.db.query('UPDATE job_documents SET removed_at = now(), removed_by = $2, remove_reason = $3 WHERE id = $1', [d.id, req.actor.id, b.reason || null]);
    await audit(req.db, req.actor.id, 'job_document_removed', 'job', d.job_id, { name: d.name });
    return { id: d.id };
  });
}

