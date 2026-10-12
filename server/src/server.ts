import pg from 'pg';
import { buildApp } from './app.ts';
import { createPool } from './db.ts';
import { ensureAppRole, migrate } from './migrate.ts';
import { readerFromEnv } from './invoiceReader.ts';
import { readPendingInvoices } from './routes/stock.ts';

// Migrations run as the database owner; the app then runs as its own restricted user.
const appUrl = process.env.DATABASE_URL ?? '';
const owner = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
await migrate(owner, s => console.log(s));
await ensureAppRole(owner, appUrl);
await owner.end();

const pool = createPool(appUrl);
const invoiceReader = readerFromEnv();
const app = await buildApp(pool, {
  invoiceReader,
  jwtSecret: process.env.JWT_SECRET ?? '',
  logger: true,
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
});
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });

// Supplier invoices that are still waiting to be read (e.g. after a restart) are picked up every minute.
if (invoiceReader) setInterval(() => { readPendingInvoices(pool, invoiceReader).catch(e => app.log.error(e)); }, 60_000);
