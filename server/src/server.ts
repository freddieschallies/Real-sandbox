import pg from 'pg';
import { buildApp } from './app.ts';
import { createPool } from './db.ts';
import { ensureAppRole, migrate } from './migrate.ts';

// Migrations run as the database owner; the app then runs as its own restricted user.
const appUrl = process.env.DATABASE_URL ?? '';
const owner = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
await migrate(owner, s => console.log(s));
await ensureAppRole(owner, appUrl);
await owner.end();

const app = await buildApp(createPool(appUrl), {
  jwtSecret: process.env.JWT_SECRET ?? '',
  logger: true,
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
});
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
