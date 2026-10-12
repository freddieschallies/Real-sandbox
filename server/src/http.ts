import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UploadError } from './uploads.ts';

/** An action the rules or permissions refuse. Sent back with the reasons the app shows. */
export class Refused extends Error {
  status: number;
  reasons: string[];
  constructor(status: number, reasons: string[]) {
    super(reasons.join('; '));
    this.status = status;
    this.reasons = reasons;
  }
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new Refused(400, r.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`));
  return r.data;
}

export const Iso = z.string().datetime({ offset: true });
export const Uuid = z.string().uuid();
export const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const Point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export function registerErrors(app: FastifyInstance) {
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (err instanceof Refused) return reply.code(err.status).send({ error: 'refused', reasons: err.reasons });
    if (err instanceof UploadError) return reply.code(400).send({ error: 'refused', reasons: [err.message] });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'refused', reasons: ['photo is larger than 8 MB'] });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err); if (process.env.DEBUG_500) console.error('ERR500', err);
    return reply.code(500).send({ error: 'server error' });
  });
}
