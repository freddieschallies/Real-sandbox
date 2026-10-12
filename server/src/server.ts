import { buildApp } from './app.ts';
import { createPool } from './db.ts';

const secret = process.env.JWT_SECRET ?? '';
const app = await buildApp(createPool(), {
  jwtSecret: secret,
  logger: true,
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
});
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
