// An employee's pay, on his profile: wage per hour (or a monthly salary), the overtime and Sunday /
// public holiday multiples, and (for a technician) what an hour of him costs the company, for profit.
// Only Accounts and the CEO, and whoever the CEO switches "Employees' pay" on for. Nobody else, not even
// the person himself through the app.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, tx, type Q } from '../db.ts';
import { can } from '../core/permissions.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { companyRates } from './clientRates.ts';

export async function payOf(c: Q, userId: string) {
  const p = (await c.query('SELECT wage_per_hour_cents, salary_cents, overtime_x::float, double_x::float, note, updated_at, (SELECT full_name FROM users WHERE id = updated_by) AS updated_by FROM employee_pay WHERE user_id = $1', [userId])).rows[0];
  const t = (await c.query('SELECT cost_per_hour_cents FROM technician_settings WHERE user_id = $1', [userId])).rows[0];
  return {
    wagePerHourCents: p?.wage_per_hour_cents ?? null, salaryCents: p?.salary_cents ?? null, overtimeX: p?.overtime_x ?? 1.5, doubleX: p?.double_x ?? 2, note: p?.note ?? null,
    costPerHourCents: t?.cost_per_hour_cents ?? null, updatedBy: p?.updated_by ?? null, updatedAt: p?.updated_at ?? null,
  };
}

export function registerPayRoutes(app: FastifyInstance) {
  const may = (req: FastifyRequest) => { if (!can(req.actor, 'set_pay')) throw new Refused(403, ['pay is for Accounts and the CEO']); };

  app.get('/people/:id/pay', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    may(req);
    const id = parse(Uuid, req.params.id);
    const u = (await req.db.query('SELECT id, full_name, login_level FROM users WHERE id = $1', [id])).rows[0];
    if (!u) throw new Refused(404, ['no such person']);
    return { person: u, pay: await payOf(req.db, id), companyCostPerHourCents: (await companyRates(req.db)).labour_cost_per_hour ?? null };
  });

  app.put('/people/:id/pay', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    may(req);
    const id = parse(Uuid, req.params.id);
    const Cents = z.number().int().min(0).max(100_000_000).nullable();
    const b = parse(z.object({ wagePerHourCents: Cents, salaryCents: Cents, overtimeX: z.number().min(1).max(5), doubleX: z.number().min(1).max(5), costPerHourCents: Cents.optional(), note: z.string().trim().max(500).nullish() }), req.body);
    if (b.wagePerHourCents != null && b.salaryCents != null) throw new Refused(400, ['an hourly wage or a monthly salary, not both']);
    return tx(req.db, async c => {
      const u = (await c.query('SELECT login_level FROM users WHERE id = $1', [id])).rows[0];
      if (!u) throw new Refused(404, ['no such person']);
      const before = await payOf(c, id);
      await c.query(
        `INSERT INTO employee_pay (user_id, wage_per_hour_cents, salary_cents, overtime_x, double_x, note, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE SET wage_per_hour_cents = EXCLUDED.wage_per_hour_cents, salary_cents = EXCLUDED.salary_cents, overtime_x = EXCLUDED.overtime_x,
           double_x = EXCLUDED.double_x, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [id, b.wagePerHourCents, b.salaryCents, b.overtimeX, b.doubleX, b.note ?? null, req.actor.id]);
      if (b.costPerHourCents !== undefined && u.login_level === 'technician') {
        await c.query(`INSERT INTO technician_settings (user_id, cost_per_hour_cents, updated_by) VALUES ($1, $2, $3)
                       ON CONFLICT (user_id) DO UPDATE SET cost_per_hour_cents = EXCLUDED.cost_per_hour_cents, updated_by = EXCLUDED.updated_by, updated_at = now()`, [id, b.costPerHourCents, req.actor.id]);
      }
      // The audit log says it changed, not the amounts (the log is read by more people than pay is).
      await audit(c, req.actor.id, 'pay_set', 'user', id, { hadPay: before.wagePerHourCents != null || before.salaryCents != null });
      return { pay: await payOf(c, id) };
    });
  });
}
