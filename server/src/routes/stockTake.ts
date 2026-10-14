// Stock takes of the stockroom. The stock controller starts one (everything, or stock, tools or PPE),
// counts each item (the app does not show what it expects until he has counted it), and signs it off:
// each difference corrects the stockroom (a stock take correction, kept with the count), and Accounts
// and the CEO are told what the differences are worth. One open stock take at a time.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, tx, type Q } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as R from '../core/stockroom.ts';
import { rand } from '../core/documents.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { notify } from './field.ts';

const CATEGORY_LABEL: Record<string, string> = { stock: 'Stock (parts)', tool: 'Tools', ppe: 'PPE' };

async function takeOf(c: Q, id: string) {
  const t = (await c.query(
    `SELECT t.id, t.category, t.note, t.started_at, t.signed_off_at, t.signoff_note, t.cancelled_at, s.full_name AS started_by, o.full_name AS signed_off_by
       FROM stocktakes t JOIN users s ON s.id = t.started_by LEFT JOIN users o ON o.id = t.signed_off_by WHERE t.id = $1 AND t.scope = 'stockroom'`, [id])).rows[0];
  if (!t) throw new Refused(404, ['no such stock take']);
  return t;
}

/** Every item the stock take covers, with its count so far (expected only once counted, or once signed off). */
async function linesOf(c: Q, t: { id: string; category: string | null; signed_off_at: Date | null }) {
  const { rows } = await c.query(
    `SELECT i.id, i.code, i.description, i.unit, i.category, i.photo_id, i.cost_cents, coalesce(s.qty, 0)::float AS live,
            l.expected_qty::float AS expected, l.counted_qty::float AS counted, l.note, l.counted_at, u.full_name AS counted_by
       FROM stock_items i LEFT JOIN stockroom_stock s ON s.stock_item_id = i.id
       LEFT JOIN stocktake_lines l ON l.stocktake_id = $1 AND l.stock_item_id = i.id LEFT JOIN users u ON u.id = l.counted_by
      WHERE (l.stock_item_id IS NOT NULL OR ($3::boolean AND i.active AND NOT i.needs_review AND ($2::text IS NULL OR i.category = $2)))
      ORDER BY i.category, i.code`, [t.id, t.category, !t.signed_off_at]);
  return rows.map(r => ({
    id: r.id, code: r.code, description: r.description, unit: r.unit, category: r.category, photoId: r.photo_id, costCents: r.cost_cents,
    counted: r.counted, expected: r.counted !== null ? r.expected : null, live: r.live, note: r.note, countedAt: r.counted_at, countedBy: r.counted_by,
    diff: r.counted !== null ? Math.round((r.counted - r.expected) * 100) / 100 : null,
  }));
}

export function registerStockTakeRoutes(app: FastifyInstance) {
  const counter = (req: FastifyRequest) => { if (!can(req.actor, 'run_stocktake')) throw new Refused(403, ['stock takes are for the stock controller']); };

  app.get('/stock/stocktakes', async req => {
    counter(req);
    const { rows } = await req.db.query(
      `SELECT t.id, t.category, t.started_at, t.signed_off_at, t.cancelled_at, s.full_name AS started_by, o.full_name AS signed_off_by,
              (SELECT count(*)::int FROM stocktake_lines l WHERE l.stocktake_id = t.id) AS counted,
              (SELECT count(*)::int FROM stocktake_lines l WHERE l.stocktake_id = t.id AND l.counted_qty <> l.expected_qty) AS differences,
              (SELECT coalesce(sum(CASE WHEN m.from_stockroom THEN -m.qty ELSE m.qty END * coalesce(m.unit_cost_cents, 0)), 0)::bigint FROM stock_movements m WHERE m.stocktake_id = t.id) AS net_cents
         FROM stocktakes t JOIN users s ON s.id = t.started_by LEFT JOIN users o ON o.id = t.signed_off_by
        WHERE t.scope = 'stockroom' ORDER BY t.started_at DESC LIMIT 30`);
    const list = rows.map(r => ({ ...r, net_cents: Number(r.net_cents), label: r.category ? CATEGORY_LABEL[r.category] : 'Everything' }));
    return { open: list.find(r => !r.signed_off_at && !r.cancelled_at) ?? null, past: list.filter(r => r.signed_off_at || r.cancelled_at) };
  });

  app.post('/stock/stocktakes', async (req, reply) => {
    counter(req);
    const b = parse(z.object({ category: z.enum(['stock', 'tool', 'ppe']).nullish(), note: z.string().trim().max(300).optional() }), req.body ?? {});
    const out = await tx(req.db, async c => {
      if ((await c.query("SELECT 1 FROM stocktakes WHERE scope = 'stockroom' AND signed_off_at IS NULL AND cancelled_at IS NULL")).rowCount) throw new Refused(409, ['a stock take is already open: finish or cancel it first']);
      const id = (await c.query("INSERT INTO stocktakes (scope, started_by, category, note) VALUES ('stockroom', $1, $2, $3) RETURNING id", [req.actor.id, b.category ?? null, b.note || null])).rows[0].id as string;
      await audit(c, req.actor.id, 'stocktake_started', 'stocktake', id, { category: b.category ?? null });
      return { id };
    });
    return reply.code(201).send(out);
  });

  app.get('/stock/stocktakes/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    counter(req);
    const t = await takeOf(req.db, parse(Uuid, req.params.id));
    const items = await linesOf(req.db, t);
    return { take: { ...t, label: t.category ? CATEGORY_LABEL[t.category] : 'Everything' }, items,
      summary: R.takeSummary(items.map(i => ({ expected: i.expected ?? i.live, counted: i.counted, costCents: i.costCents }))) };
  });

  // A count: what is on the shelf now. Counted again, the new count replaces it. The expected is what
  // the stockroom had at that moment, so stock issued while counting does not make a false difference.
  app.put('/stock/stocktakes/:id/count', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    counter(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ stockItemId: Uuid, counted: z.number().min(0).max(10_000_000), note: z.string().trim().max(300).optional() }), req.body);
    return tx(req.db, async c => {
      const t = await takeOf(c, id);
      if (t.signed_off_at || t.cancelled_at) throw new Refused(409, ['this stock take is finished']);
      const it = (await c.query('SELECT i.category, coalesce(s.qty, 0)::float AS live FROM stock_items i LEFT JOIN stockroom_stock s ON s.stock_item_id = i.id WHERE i.id = $1', [b.stockItemId])).rows[0];
      if (!it) throw new Refused(404, ['no such item']);
      if (t.category && it.category !== t.category) throw new Refused(400, [`this stock take is for ${CATEGORY_LABEL[t.category]} only`]);
      await c.query(
        `INSERT INTO stocktake_lines (stocktake_id, stock_item_id, expected_qty, counted_qty, counted_by, counted_at, note) VALUES ($1, $2, $3, $4, $5, now(), $6)
         ON CONFLICT (stocktake_id, stock_item_id) DO UPDATE SET expected_qty = EXCLUDED.expected_qty, counted_qty = EXCLUDED.counted_qty, counted_by = EXCLUDED.counted_by, counted_at = now(), note = EXCLUDED.note`,
        [id, b.stockItemId, it.live, b.counted, req.actor.id, b.note || null]);
      return { stockItemId: b.stockItemId, counted: b.counted, expected: it.live, diff: Math.round((b.counted - it.live) * 100) / 100 };
    });
  });

  // Signed off: every difference corrects the stockroom. Items not counted stay as they are (only when
  // the stock controller says so). Differences need a word.
  app.post('/stock/stocktakes/:id/sign-off', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    counter(req);
    const id = parse(Uuid, req.params.id);
    const b = parse(z.object({ note: z.string().trim().max(1000).optional(), partial: z.boolean().optional() }), req.body ?? {});
    return tx(req.db, async c => {
      const t = await takeOf(c, id);
      if (t.signed_off_at || t.cancelled_at) throw new Refused(409, ['this stock take is finished']);
      const items = await linesOf(c, t);
      const s = R.takeSummary(items.map(i => ({ expected: i.expected ?? i.live, counted: i.counted, costCents: i.costCents })));
      if (!s.counted) throw new Refused(409, ['nothing has been counted yet']);
      if (s.left && !b.partial) throw new Refused(409, [`${s.left} item${s.left === 1 ? '' : 's'} not counted yet: count them, or sign off only what was counted`]);
      if (s.differences && (!b.note || b.note.length < 5)) throw new Refused(400, ['say why the counts differ (e.g. used on jobs and not booked, damaged, miscounted before)']);
      for (const i of items.filter(x => x.diff)) {
        const d = i.diff!;
        await c.query(
          `INSERT INTO stock_movements (stock_item_id, qty, kind, ${d > 0 ? 'to_stockroom' : 'from_stockroom'}, stocktake_id, unit_cost_cents, note, created_by)
           VALUES ($1, $2, 'stocktake_adjustment', true, $3, $4, $5, $6)`,
          [i.id, Math.abs(d), id, i.costCents, `Stock take: counted ${i.counted}, expected ${i.expected}${i.note ? `. ${i.note}` : ''}`, req.actor.id]);
      }
      await c.query('UPDATE stocktakes SET signed_off_by = $2, signed_off_at = now(), signoff_note = $3 WHERE id = $1', [id, req.actor.id, b.note || null]);
      await audit(c, req.actor.id, 'stocktake_signed_off', 'stocktake', id, { counted: s.counted, differences: s.differences, lossCents: s.lossCents, gainCents: s.gainCents, partial: !!s.left });
      if (s.differences) {
        const who = (await c.query("SELECT id FROM users WHERE login_level IN ('accounts', 'director', 'creator') AND status = 'active' AND id <> $1", [req.actor.id])).rows;
        for (const u of who) await notify(c, u.id, 'stocktake', `Stock take signed off: ${s.differences} item${s.differences === 1 ? '' : 's'} differ${s.lossCents ? `, ${rand(s.lossCents)} short` : ''}${s.gainCents ? `, ${rand(s.gainCents)} over` : ''}. ${b.note ?? ''}`.trim(), { stocktakeId: id });
      }
      return { id, ...s };
    });
  });

  app.post('/stock/stocktakes/:id/cancel', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    counter(req);
    const id = parse(Uuid, req.params.id);
    return tx(req.db, async c => {
      const t = await takeOf(c, id);
      if (t.signed_off_at || t.cancelled_at) throw new Refused(409, ['this stock take is finished']);
      await c.query('UPDATE stocktakes SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1', [id, req.actor.id]);
      await audit(c, req.actor.id, 'stocktake_cancelled', 'stocktake', id, {});
      return { id, cancelled: true };
    });
  });
}
