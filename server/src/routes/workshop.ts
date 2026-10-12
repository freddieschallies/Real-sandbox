// The mechanic's workshop stock. The stock controller (or office) decides what it keeps and issues
// stock to it from the stockroom; the mechanic uses it on job cards and daily checks, notes any
// spill straight away, and counts (dips) it. Every loss is recorded; a count short by more than
// the pouring allowance goes to the office as a flag.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Q } from '../db.ts';
import { audit, raiseFlag, tx } from '../db.ts';
import { can } from '../core/permissions.ts';
import * as W from '../core/workshop.ts';
import { stockroomQty, workshopQty } from '../stockRepo.ts';
import { Iso, Refused, Uuid, parse } from '../http.ts';
import { notify } from './field.ts';
import { mechanics } from './fleet.ts';

const Qty = z.number().positive().max(100000);

async function item(c: Q, id: string) {
  const it = (await c.query('SELECT id, code, description, unit, measured FROM stock_items WHERE id = $1 AND active', [id])).rows[0];
  if (!it) throw new Refused(404, ['no such stock item']);
  return it as { id: string; code: string; description: string; unit: string; measured: boolean };
}

/** Poured into vehicles since the last count: what the loss allowance is worked out on. */
async function usedSinceCount(c: Q, stockItemId: string): Promise<number> {
  const { rows } = await c.query(
    `SELECT coalesce(sum(qty), 0)::float AS used FROM stock_movements
      WHERE stock_item_id = $1 AND from_workshop AND kind = 'use_on_fleet'
        AND created_at > coalesce((SELECT max(counted_at) FROM workshop_counts WHERE stock_item_id = $1), '-infinity')`, [stockItemId]);
  return Number(rows[0].used);
}

export function registerWorkshopRoutes(app: FastifyInstance) {
  const looks = (req: FastifyRequest) => { if (!can(req.actor, 'view_fleet') && !can(req.actor, 'assign_stock')) throw new Refused(403, ['fleet or stock controller only']); };
  const stocks = (req: FastifyRequest) => { if (!can(req.actor, 'assign_stock')) throw new Refused(403, ['stock controller or office only']); };
  const mech = (req: FastifyRequest) => { if (!can(req.actor, 'manage_fleet')) throw new Refused(403, ['mechanic only']); };

  app.get('/fleet/workshop', async req => {
    looks(req);
    const { rows } = await req.db.query(
      `SELECT i.id, i.code, i.description, i.unit, i.measured, coalesce(w.qty, 0)::float AS qty, coalesce(wi.min_qty, 0)::float AS min_qty, wi.daily_check_use,
              wi.id IS NOT NULL AS kept,
              (SELECT coalesce(sum(m.qty), 0)::float FROM stock_movements m WHERE m.stock_item_id = i.id AND m.from_workshop AND m.kind = 'use_on_fleet' AND m.created_at > now() - interval '30 days') AS used_30d,
              (SELECT coalesce(sum(m.qty), 0)::float FROM stock_movements m WHERE m.stock_item_id = i.id AND m.from_workshop AND m.kind = 'workshop_loss' AND m.created_at > now() - interval '30 days') AS lost_30d,
              (SELECT json_build_object('at', k.counted_at, 'result', k.result, 'expected', k.expected_qty::float, 'counted', k.counted_qty::float, 'by', u.full_name)
                 FROM workshop_counts k JOIN users u ON u.id = k.counted_by WHERE k.stock_item_id = i.id ORDER BY k.counted_at DESC LIMIT 1) AS last_count,
              coalesce(s.qty, 0)::float AS in_stockroom
         FROM stock_items i
         LEFT JOIN workshop_items wi ON wi.stock_item_id = i.id
         LEFT JOIN workshop_stock w ON w.stock_item_id = i.id
         LEFT JOIN stockroom_stock s ON s.stock_item_id = i.id
        WHERE i.active AND (wi.id IS NOT NULL OR coalesce(w.qty, 0) <> 0)
        ORDER BY (wi.min_qty > 0 AND coalesce(w.qty, 0) < wi.min_qty) DESC, i.description`);
    const lines = rows.map(r => ({ ...r, belowMin: W.belowMin(r), usedSince: 0 }));
    for (const l of lines) l.usedSince = await usedSinceCount(req.db, l.id);
    return { lines, belowMin: lines.filter(l => l.belowMin).length, lossPct: W.LOSS_PCT, lossMin: W.LOSS_MIN };
  });

  /** What the workshop keeps and its minimum, and which oil and coolant the daily checks use. */
  app.put('/fleet/workshop/items/:itemId', async (req: FastifyRequest<{ Params: { itemId: string } }>) => {
    stocks(req);
    const itemId = parse(Uuid, req.params.itemId);
    const b = parse(z.object({ minQty: z.number().min(0).max(100000), dailyCheckUse: z.enum(['oil', 'water']).nullish(), measured: z.boolean().optional() }), req.body);
    return tx(req.db, async c => {
      const it = await item(c, itemId);
      if (b.dailyCheckUse) await c.query('UPDATE workshop_items SET daily_check_use = NULL WHERE daily_check_use = $1 AND stock_item_id <> $2', [b.dailyCheckUse, itemId]);
      await c.query(
        `INSERT INTO workshop_items (stock_item_id, min_qty, daily_check_use, set_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, stock_item_id) DO UPDATE SET min_qty = EXCLUDED.min_qty, daily_check_use = EXCLUDED.daily_check_use, set_by = EXCLUDED.set_by, set_at = now()`,
        [itemId, b.minQty, b.dailyCheckUse ?? null, req.actor.id]);
      if (b.measured !== undefined) await c.query('UPDATE stock_items SET measured = $2 WHERE id = $1', [itemId, b.measured]);
      await audit(c, req.actor.id, 'workshop_item_set', 'stock_item', itemId, b);
      return { itemId, description: it.description, minQty: b.minQty, dailyCheckUse: b.dailyCheckUse ?? null };
    });
  });

  /** The stock controller sends stock from the stockroom to the workshop. */
  app.post('/fleet/workshop/issue', async req => {
    stocks(req);
    const b = parse(z.object({ lines: z.array(z.object({ itemId: Uuid, qty: Qty })).min(1).max(100), note: z.string().trim().max(500).optional(), at: Iso }), req.body);
    return tx(req.db, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['workshop']);
      const short: string[] = [];
      const done: string[] = [];
      for (const l of b.lines) {
        const it = await item(c, l.itemId);
        const have = await stockroomQty(c, l.itemId);
        if (have < l.qty) { short.push(`${it.description}: only ${have} ${it.unit} in the stockroom`); continue; }
        await c.query(
          `INSERT INTO stock_movements (stock_item_id, qty, kind, from_stockroom, to_workshop, note, created_by) VALUES ($1, $2, 'assign', true, true, $3, $4)`,
          [l.itemId, l.qty, b.note ?? null, req.actor.id]);
        done.push(`${l.qty} ${it.unit} ${it.description}`);
      }
      if (short.length) throw new Refused(409, short);
      for (const m of await mechanics(c)) await notify(c, m, 'workshop_stock', `Stock issued to the workshop: ${done.join(', ')}`, {});
      await audit(c, req.actor.id, 'workshop_issue', 'workshop', null, b);
      return { issued: done };
    });
  });

  /** Back to the stockroom (stock controller), e.g. too much was sent. */
  app.post('/fleet/workshop/return', async req => {
    stocks(req);
    const b = parse(z.object({ itemId: Uuid, qty: Qty, note: z.string().trim().min(5).max(500), at: Iso }), req.body);
    return tx(req.db, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['workshop']);
      const it = await item(c, b.itemId);
      const have = await workshopQty(c, b.itemId);
      if (have < b.qty) throw new Refused(409, [`only ${have} ${it.unit} in the workshop`]);
      await c.query(`INSERT INTO stock_movements (stock_item_id, qty, kind, from_workshop, to_stockroom, note, created_by) VALUES ($1, $2, 'return', true, true, $3, $4)`,
        [b.itemId, b.qty, b.note, req.actor.id]);
      return { returned: b.qty };
    });
  });

  /** Spilt, leaked, contaminated: the mechanic notes it straight away. */
  app.post('/fleet/workshop/loss', async (req, reply) => {
    mech(req);
    const b = parse(z.object({ itemId: Uuid, qty: Qty, reason: z.string().trim().min(5, 'say what happened (e.g. spilt while pouring)').max(500), at: Iso }), req.body);
    const out = await tx(req.db, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['workshop']);
      const it = await item(c, b.itemId);
      const have = await workshopQty(c, b.itemId);
      if (have < b.qty) throw new Refused(409, [`only ${have} ${it.unit} in the workshop: count it instead`]);
      const id = randomUUID();
      await c.query(`INSERT INTO stock_movements (id, stock_item_id, qty, kind, from_workshop, note, created_by) VALUES ($1, $2, $3, 'workshop_loss', true, $4, $5)`,
        [id, b.itemId, b.qty, `Noted by the mechanic: ${b.reason}`, req.actor.id]);
      await audit(c, req.actor.id, 'workshop_loss', 'stock_item', b.itemId, b);
      return { id, left: Math.round((have - b.qty) * 100) / 100 };
    });
    return reply.code(201).send(out);
  });

  /** A count or dip. Small shortfalls on poured stock are allowed but recorded; bigger ones are flagged. */
  app.post('/fleet/workshop/count', async (req, reply) => {
    if (!can(req.actor, 'manage_fleet') && !can(req.actor, 'run_stocktake')) throw new Refused(403, ['mechanic or stock controller only']);
    const b = parse(z.object({ itemId: Uuid, counted: z.number().min(0).max(100000), note: z.string().trim().max(500).nullish(), at: Iso }), req.body);
    const out = await tx(req.db, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['workshop']);
      const it = await item(c, b.itemId);
      const expected = await workshopQty(c, b.itemId);
      const used = await usedSinceCount(c, b.itemId);
      const r = W.countResult(expected, b.counted, used, it.measured);
      const missing = W.missingOnCount(b.counted, b.note, r);
      if (missing.length) throw new Refused(409, missing);
      const id = randomUUID();
      await c.query(
        `INSERT INTO workshop_counts (id, stock_item_id, expected_qty, counted_qty, used_since, allowance, result, note, counted_by, counted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, b.itemId, expected, b.counted, used, r.allowance, r.result, b.note?.trim() || null, req.actor.id, b.at]);
      if (r.loss > 0) {
        const note = r.result === 'within_allowance' ? `Count: pouring loss within the ${r.allowance} ${it.unit} allowance` : `Count: short, ${b.note!.trim()}`;
        await c.query(`INSERT INTO stock_movements (stock_item_id, qty, kind, from_workshop, workshop_count_id, note, created_by) VALUES ($1, $2, 'workshop_loss', true, $3, $4, $5)`,
          [b.itemId, r.loss, id, note, req.actor.id]);
      } else if (r.loss < 0) {
        await c.query(`INSERT INTO stock_movements (stock_item_id, qty, kind, to_workshop, workshop_count_id, note, created_by) VALUES ($1, $2, 'stocktake_adjustment', true, $3, $4, $5)`,
          [b.itemId, -r.loss, id, `Count: more than expected, ${b.note!.trim()}`, req.actor.id]);
      }
      if (r.result === 'short') {
        await raiseFlag(c, {
          type: 'workshop_stock_short', severity: 'normal', technicianId: req.actor.id,
          question: `Workshop ${it.description} counted ${r.loss} ${it.unit} short (allowance ${r.allowance} ${it.unit}). What happened?`,
          details: { stockItemId: b.itemId, expected, counted: b.counted, loss: r.loss, allowance: r.allowance, usedSince: used, note: b.note },
        });
      }
      await audit(c, req.actor.id, 'workshop_count', 'stock_item', b.itemId, { expected, counted: b.counted, result: r.result });
      return { id, expected, counted: b.counted, usedSince: used, ...r, text: W.countText(r, it.unit) };
    });
    return reply.code(201).send(out);
  });

  /** Everything that went in and out of the workshop, newest first. */
  app.get('/fleet/workshop/movements', async (req: FastifyRequest<{ Querystring: { itemId?: string } }>) => {
    looks(req);
    const itemId = req.query.itemId ? parse(Uuid, req.query.itemId) : null;
    const { rows } = await req.db.query(
      `SELECT m.id, m.created_at, m.kind, m.qty::float AS qty, m.to_workshop, i.description, i.unit, m.note, u.full_name AS by,
              v.registration, fj.number AS job_number
         FROM stock_movements m JOIN stock_items i ON i.id = m.stock_item_id JOIN users u ON u.id = m.created_by
         LEFT JOIN daily_checks d ON d.id = m.daily_check_id
         LEFT JOIN fleet_job_parts p ON p.id = m.fleet_job_part_id LEFT JOIN fleet_jobs fj ON fj.id = p.job_id
         LEFT JOIN vehicles v ON v.id = coalesce(d.vehicle_id, fj.vehicle_id)
        WHERE (m.to_workshop OR m.from_workshop) AND ($1::uuid IS NULL OR m.stock_item_id = $1)
        ORDER BY m.created_at DESC LIMIT 300`, [itemId]);
    return rows;
  });
}
