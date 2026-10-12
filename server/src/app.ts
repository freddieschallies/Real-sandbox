import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import cors from '@fastify/cors';
import type { Db } from './db.ts';
import { registerAuth } from './auth.ts';
import { registerErrors } from './http.ts';
import { registerSync } from './sync.ts';
import { registerTenancy } from './tenancy.ts';
import { registerUploads } from './uploads.ts';
import { registerJobRoutes } from './routes/jobs.ts';
import { registerFieldRoutes } from './routes/field.ts';
import { registerOfficeRoutes } from './routes/office.ts';
import { registerAccessRoutes } from './routes/access.ts';
import { registerPlatformRoutes } from './routes/platform.ts';
import { registerStockRoutes } from './routes/stock.ts';
import { registerFleetRoutes } from './routes/fleet.ts';
import type { InvoiceReader } from './invoiceReader.ts';

/** db must connect as the app's own database role (no superuser, no row-level-security bypass). */
export async function buildApp(db: Db, opts: { jwtSecret: string; logger?: boolean; corsOrigins?: string[]; invoiceReader?: InvoiceReader | null }) {
  if (!opts.jwtSecret || opts.jwtSecret.length < 32) throw new Error('JWT secret must be at least 32 characters');
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000, trustProxy: true });
  registerErrors(app);
  await app.register(cors, { origin: opts.corsOrigins ?? false });
  await app.register(jwt, { secret: opts.jwtSecret });
  await registerUploads(app);
  app.get('/health', async () => ({ ok: true }));
  registerTenancy(app);
  registerAuth(app, db);
  registerSync(app);
  registerJobRoutes(app, db);
  registerFieldRoutes(app, db);
  registerOfficeRoutes(app, db);
  registerAccessRoutes(app, db);
  registerPlatformRoutes(app, db);
  registerStockRoutes(app, db, opts.invoiceReader ?? null);
  registerFleetRoutes(app, db);
  return app;
}
