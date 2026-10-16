// The CEO's view of the backups (Settings): when the last one ran, whether the cloud copy is set up, and
// the space the company takes. The backup itself runs on the office server (deploy/backup).
import type { FastifyInstance } from 'fastify';
import { Refused } from '../http.ts';
import { backupStatus, storageOf } from '../storage.ts';

export function registerBackupRoutes(app: FastifyInstance) {
  app.get('/company/backup', async req => {
    if (!['creator', 'director'].includes(req.actor.level)) throw new Refused(403, ['for the CEO']);
    const b = await backupStatus();
    return {
      backup: { state: b.state, at: b.at, ageHours: b.ageHours, dumps: b.dumps, cloud: { configured: b.cloud.configured, ok: b.cloud.ok, lastOkAt: b.cloud.lastOkAt, photos: b.cloud.photos }, errors: b.errors },
      storage: await storageOf(req.db, req.companyId),
    };
  });
}
