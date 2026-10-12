import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import cors from '@fastify/cors';
import type { Db } from './db.ts';
import { registerAuth } from './auth.ts';
import { registerJobRoutes } from './routes/jobs.ts';

export async function buildApp(db: Db, opts: { jwtSecret: string; logger?: boolean; corsOrigins?: string[] }) {
  if (!opts.jwtSecret || opts.jwtSecret.length < 32) throw new Error('JWT secret must be at least 32 characters');
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000 });
  await app.register(cors, { origin: opts.corsOrigins ?? false });
  await app.register(jwt, { secret: opts.jwtSecret });
  app.get('/health', async () => ({ ok: true }));
  registerAuth(app, db);
  registerJobRoutes(app, db);
  return app;
}
