// The price list: every part the company sells, with its selling price only (never what it cost),
// for answering a client who asks "what does that part cost?". Everyone in the company sees it,
// the technicians too. The stock controller, Admin and the CEO put up a picture of the part, so the
// next person knows it by sight.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, tx } from '../db.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { can, type Actor } from '../core/permissions.ts';

/** Who puts up the pictures of parts: the stockroom, Admin and the CEO (not the technicians). */
export const takesPartPictures = (a: Actor) => ['stockroom', 'admin', 'director', 'creator'].includes(a.level) || can(a, 'manage_stockroom');

export function registerPriceListRoutes(app: FastifyInstance) {
  app.get('/price-list', async req => {
    const vatPct = Number((await req.db.query('SELECT vat_pct FROM company_profile')).rows[0]?.vat_pct ?? 15);
    const { rows } = await req.db.query(
      `SELECT i.id, i.code, i.description, i.unit, i.selling_price_cents, i.supplier_code, i.pastel_code, i.photo_id, i.photo_set_at, u.full_name AS photo_by
         FROM stock_items i LEFT JOIN users u ON u.id = i.photo_set_by
        WHERE i.active AND NOT i.needs_review AND i.category = 'stock' ORDER BY i.description`);
    return {
      vatPct, canPicture: takesPartPictures(req.actor),
      items: rows.map(r => ({
        id: r.id, code: r.code, description: r.description, unit: r.unit, priceCents: r.selling_price_cents,
        supplierCode: r.supplier_code, pastelCode: r.pastel_code, photoId: r.photo_id, photoBy: r.photo_by, photoAt: r.photo_set_at,
      })),
    };
  });

  // A reference picture of the part (taken with the phone, or chosen on a computer).
  app.put('/price-list/:id/photo', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = parse(Uuid, req.params.id);
    if (!takesPartPictures(req.actor)) throw new Refused(403, ['the stock controller, Admin or the CEO puts up the pictures of parts']);
    const b = parse(z.object({ photoId: Uuid }), req.body);
    return tx(req.db, async c => {
      const it = (await c.query("SELECT code FROM stock_items WHERE id = $1 AND active AND category = 'stock'", [id])).rows[0];
      if (!it) throw new Refused(404, ['no such part on the price list']);
      if (!(await c.query("SELECT 1 FROM photos WHERE id = $1 AND kind = 'stock_item' AND taken_by = $2", [b.photoId, req.actor.id])).rowCount) throw new Refused(409, ['send the picture first']);
      await c.query('UPDATE stock_items SET photo_id = $2, photo_set_by = $3, photo_set_at = now() WHERE id = $1', [id, b.photoId, req.actor.id]);
      await audit(c, req.actor.id, 'part_picture', 'stock_item', id, { code: it.code });
      return { id, photoId: b.photoId };
    });
  });
}
