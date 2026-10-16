import pg from 'pg';
import { buildApp } from './app.ts';
import { createPool } from './db.ts';
import { ensureAppRole, migrate } from './migrate.ts';
import { readerFromEnv } from './invoiceReader.ts';
import { readPendingInvoices } from './routes/stock.ts';
import { purgeOldPhotos } from './retention.ts';
import { escalate, pollInboxes } from './intake.ts';
import { breakdownReaderFromEnv } from './breakdownReader.ts';
import { geocoderFromEnv } from './geocoder.ts';
import { locateStores } from './storePins.ts';
import { sealAll } from './routes/history.ts';

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

// Breakdowns: new emails in the connected Gmail inboxes every minute; breakdowns nobody has logged
// within the set time go to the CEO. One round at a time.
const reader = breakdownReaderFromEnv();
let reading = false;
setInterval(() => {
  if (reading) return;
  reading = true;
  pollInboxes(pool, reader).then(n => { if (n) app.log.info(`${n} new email(s) in the breakdowns queue`); })
    .catch(e => app.log.error(e)).finally(() => { reading = false; });
  escalate(pool).catch(e => app.log.error(e));
}, 60_000);

// Stores waiting for a map pin (new customers, changed addresses): looked up every minute, a few at a time.
const geocoder = geocoderFromEnv();
let locating = false;
if (geocoder) setInterval(() => {
  if (locating) return;
  locating = true;
  locateStores(pool, geocoder).then(n => { if (n) app.log.info(`${n} store(s) pinned on the map`); })
    .catch(e => app.log.error(e)).finally(() => { locating = false; });
}, 60_000);

// Old vehicle photos past their keeping time: once at start, then every 6 hours.
const purge = () => purgeOldPhotos(pool).then(n => { if (n) app.log.info(`removed ${n} old vehicle photos`); }).catch(e => app.log.error(e));
purge();
setInterval(purge, 6 * 3600_000);

// The history: what has settled is sealed every 5 minutes, so nothing can later be taken out unseen.
setInterval(() => { sealAll(pool).catch(e => app.log.error(e)); }, 5 * 60_000);
