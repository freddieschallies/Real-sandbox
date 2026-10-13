// Photo files: job photos, signatures and slips. Stored on the office server's disk,
// outside the database; the database keeps the record and the path.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export interface Upload { fields: Record<string, string>; buffer: Buffer; mimetype: string }

export async function registerUploads(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 10 } });
}

export class UploadError extends Error {}

/** Reads one multipart form: its text fields and exactly one image file. */
export async function readUpload(req: FastifyRequest): Promise<Upload> {
  if (!req.isMultipart()) throw new UploadError('send the photo as multipart/form-data');
  const fields: Record<string, string> = {};
  let file: { buffer: Buffer; mimetype: string } | null = null;
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (part.file.truncated) throw new UploadError('photo is larger than 8 MB');
      file = { buffer, mimetype: part.mimetype };
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  if (!file) throw new UploadError('no photo attached');
  if (!TYPES[file.mimetype]) throw new UploadError('photo must be JPEG, PNG or WebP');
  if (file.buffer.length === 0) throw new UploadError('photo is empty');
  return { fields, ...file };
}

const root = () => process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads');
/** Where photo files are kept (for reading them into emails). */
export const uploadRoot = root;

/** Saves the file in the company's own folder and returns its path relative to the upload folder. */
export async function saveFile(companyId: string, id: string, up: Upload, takenAt: string): Promise<string> {
  const rel = join(companyId, takenAt.slice(0, 4), takenAt.slice(5, 7), `${id}.${TYPES[up.mimetype]}`);
  const full = join(root(), rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, up.buffer, { flag: 'wx' });
  return rel;
}

export async function removeFile(rel: string) {
  await unlink(join(root(), rel)).catch(() => {});
}

export function openFile(rel: string) {
  if (rel.includes('..')) throw new UploadError('bad path');
  return createReadStream(join(root(), rel));
}

export const newId = () => randomUUID();
