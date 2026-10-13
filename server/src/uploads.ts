// Photo files: job photos, signatures and slips. Stored on the office server's disk,
// outside the database; the database keeps the record and the path.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// The app makes photos smaller before sending them (usually 150–450 KB, documents under 1 MB), so
// anything much bigger did not come through the app's compressor and is refused, to keep the
// server's storage small.
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
export const MAX_PHOTO_EDGE = 5000;
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
      if (part.file.truncated) throw new UploadError('photo is larger than 4 MB: update the app (it makes photos smaller before sending)');
      file = { buffer, mimetype: part.mimetype };
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  if (!file) throw new UploadError('no photo attached');
  if (!TYPES[file.mimetype]) throw new UploadError('photo must be JPEG, PNG or WebP');
  if (file.buffer.length === 0) throw new UploadError('photo is empty');
  const size = imageSize(file.buffer);
  if (size && Math.max(size.width, size.height) > MAX_PHOTO_EDGE) throw new UploadError(`photo is ${size.width} × ${size.height}: update the app (it makes photos smaller before sending)`);
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

/** Width and height from a JPEG or PNG header (null for anything it cannot read). */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      // Start of frame (baseline, progressive, …): height then width.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}
