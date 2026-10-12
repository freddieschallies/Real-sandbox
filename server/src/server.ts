import { buildApp } from './app.ts';
import { createPool } from './db.ts';
import { migrate } from './migrate.ts';

const db = createPool();
await migrate(db, s => console.log(s));
const app = await buildApp(db, {
  jwtSecret: process.env.JWT_SECRET ?? '',
  logger: true,
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
});
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
