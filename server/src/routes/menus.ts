// The phone menus: which tabs each position has pinned to the bottom of the phone screen; the rest
// go under More. The CEO or an admin chooses; everyone reads their own position's choice.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, tx } from '../db.ts';
import { can, type LoginLevel } from '../core/permissions.ts';
import { APP_OF, MAX_PINNED, MENU_LABEL, MENU_LEVELS, MENU_TABS, cleanPinned, usualTabs } from '../core/phoneMenu.ts';
import { Refused, parse } from '../http.ts';

export function registerMenuRoutes(app: FastifyInstance) {
  app.get('/me/phone-menu', async req => {
    const row = (await req.db.query('SELECT pinned FROM phone_menus WHERE level = $1', [req.actor.level])).rows[0];
    return { pinned: (row?.pinned as string[] | undefined) ?? null, canEdit: can(req.actor, 'set_phone_menu') };
  });

  app.get('/phone-menus', async req => {
    if (!can(req.actor, 'set_phone_menu')) throw new Refused(403, ['only the CEO or an admin arranges the phone menus']);
    const rows = (await req.db.query('SELECT level, pinned, updated_at FROM phone_menus')).rows as { level: LoginLevel; pinned: string[]; updated_at: string }[];
    return {
      maxPinned: MAX_PINNED,
      positions: MENU_LEVELS.map(level => {
        const app = APP_OF[level]!;
        const row = rows.find(r => r.level === level);
        return { level, label: MENU_LABEL[level], app, tabs: MENU_TABS[app], usual: usualTabs(level), pinned: row?.pinned ?? null, updatedAt: row?.updated_at ?? null };
      }),
    };
  });

  // pinned: null puts the position back on the automatic choice.
  app.put('/phone-menus/:level', async (req: import('fastify').FastifyRequest<{ Params: { level: string } }>) => {
    if (!can(req.actor, 'set_phone_menu')) throw new Refused(403, ['only the CEO or an admin arranges the phone menus']);
    const level = req.params.level as LoginLevel;
    const app = APP_OF[level];
    if (!app) throw new Refused(400, ['that position has no tab bar']);
    const b = parse(z.object({ pinned: z.array(z.string()).max(MAX_PINNED).nullable() }), req.body);
    const pinned = b.pinned === null ? null : cleanPinned(app, b.pinned);
    if (pinned && pinned.length !== b.pinned!.length) throw new Refused(400, ['each tab once, and only tabs that position can have']);
    if (pinned && !pinned.length) throw new Refused(400, ['pin at least one tab, or go back to automatic']);
    return tx(req.db, async c => {
      if (pinned) {
        await c.query(`INSERT INTO phone_menus (level, pinned, updated_by) VALUES ($1, $2, $3)
                       ON CONFLICT (company_id, level) DO UPDATE SET pinned = EXCLUDED.pinned, updated_by = EXCLUDED.updated_by, updated_at = now()`, [level, pinned, req.actor.id]);
      } else {
        await c.query('DELETE FROM phone_menus WHERE level = $1', [level]);
      }
      await audit(c, req.actor.id, 'phone_menu', 'position', null, { level, pinned });
      return { level, pinned };
    });
  });
}
