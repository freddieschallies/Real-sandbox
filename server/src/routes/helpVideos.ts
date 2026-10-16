// The instruction videos ("How to use the app"), one per position. Made with a made-up company, so
// they hold no company's data and need no sign-in. Played in the app, so they support seeking (Range).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../../help-videos/', import.meta.url));
export const VIDEO_FILES = ['technician', 'stock-controller', 'mechanic', 'department-manager', 'hr', 'admin', 'accounts', 'ceo'];

export function registerHelpVideoRoutes(app: FastifyInstance) {
  app.get('/help/videos/:file', async (req: FastifyRequest<{ Params: { file: string } }>, reply) => {
    const name = req.params.file.replace(/\.mp4$/, '');
    if (!VIDEO_FILES.includes(name)) return reply.code(404).send({ error: 'no such video' });
    const path = `${DIR}${name}.mp4`;
    const size = (await stat(path).catch(() => null))?.size;
    if (!size) return reply.code(404).send({ error: 'the video is not on this server yet' });
    reply.header('content-type', 'video/mp4').header('accept-ranges', 'bytes').header('cache-control', 'public, max-age=86400');
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) return reply.code(416).header('content-range', `bytes */${size}`).send();
      return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1).send(createReadStream(path, { start, end }));
    }
    return reply.header('content-length', size).send(createReadStream(path));
  });
}
