// The CEO's start-up page for a new company: the checklist (what is done, what is left), and the
// quick ways through it: tick the departments as right, skip the stock list or vehicles, add many
// employees at once with their roles, and make setup codes for everyone who has no login yet.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, tx, type Q } from '../db.ts';
import { HR_POSITIONS, LEVELS, POSITION_LABEL, TRADES, can } from '../core/permissions.ts';
import * as SU from '../core/setup.ts';
import { Refused, Uuid, parse } from '../http.ts';
import { LOGIN_STATE_SQL, NewPerson, addPerson, issueCode } from './logins.ts';
import { companyRates } from './clientRates.ts';

async function stateOf(c: Q) {
  return (await c.query('SELECT departments_checked, skipped, dismissed_at FROM company_setup')).rows[0] ?? { departments_checked: false, skipped: [], dismissed_at: null };
}
async function saveState(c: Q, by: string, change: { departmentsChecked?: boolean; skipped?: string[]; dismissed?: boolean }) {
  const cur = await stateOf(c);
  await c.query(
    `INSERT INTO company_setup (departments_checked, skipped, dismissed_at, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id) DO UPDATE SET departments_checked = EXCLUDED.departments_checked, skipped = EXCLUDED.skipped, dismissed_at = EXCLUDED.dismissed_at, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [change.departmentsChecked ?? cur.departments_checked, change.skipped ?? cur.skipped,
      change.dismissed === undefined ? cur.dismissed_at : change.dismissed ? new Date() : null, by]);
}

/** The checklist, with what there is so far. */
export async function setupOf(c: Q, companyId: string) {
  const st = await stateOf(c);
  const one = async (sql: string) => Number((await c.query(sql)).rows[0]?.n ?? 0);
  const people = (await c.query(
    `SELECT u.id, u.full_name, u.login_level, u.email, u.phone, d.name AS department, ${LOGIN_STATE_SQL} AS login
       FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.status <> 'left' AND u.login_level <> 'creator' ORDER BY u.full_name`)).rows;
  const byRole: Record<string, number> = {};
  for (const p of people) { const k = (POSITION_LABEL as Record<string, string>)[p.login_level]?.toLowerCase() ?? p.login_level; byRole[k] = (byRole[k] ?? 0) + 1; }
  const prof = (await c.query('SELECT legal_name, address, phone, email, vat_no, logo_photo_id FROM company_profile')).rows[0] ?? null;
  const lh = (await c.query('SELECT header_photo_id FROM company_letterhead')).rows[0];
  const steps = SU.setupSteps({
    policy: (await one('SELECT count(*)::int AS n FROM policy_versions')) > 0,
    company: prof, logo: !!prof?.logo_photo_id, letterhead: !!lh?.header_photo_id,
    departments: await one('SELECT count(*)::int AS n FROM departments WHERE active'), departmentsChecked: st.departments_checked,
    people: people.length, byRole,
    withEmail: people.filter(p => p.email).length, withLogin: people.filter(p => ['on', 'code', 'locked'].includes(p.login)).length, noEmail: people.filter(p => !p.email).length,
    rates: await companyRates(c), clients: await one('SELECT count(*)::int AS n FROM clients'), stores: await one('SELECT count(*)::int AS n FROM stores'),
    stock: await one('SELECT count(*)::int AS n FROM stock_items WHERE active'), vehicles: await one('SELECT count(*)::int AS n FROM vehicles WHERE active'), skipped: st.skipped ?? [],
  });
  const company = (await c.query('SELECT name FROM companies WHERE id = $1', [companyId])).rows[0]?.name ?? '';
  return { company, steps, done: steps.filter(s => s.done).length, total: steps.length, dismissed: !!st.dismissed_at, people };
}

export function registerSetupRoutes(app: FastifyInstance) {
  const ceo = (req: FastifyRequest) => { if (!can(req.actor, 'manage_access')) throw new Refused(403, ['the start-up page is the CEO\'s']); };

  app.get('/setup', async req => {
    ceo(req);
    const s = await setupOf(req.db, req.companyId);
    const departments = (await req.db.query('SELECT id, name FROM departments WHERE active ORDER BY name')).rows;
    const roles = LEVELS.filter(l => l !== 'creator').map(l => ({ level: l, label: POSITION_LABEL[l], help: SU.ROLE_HELP[l] ?? '', hr: HR_POSITIONS.includes(l) }));
    return { ...s, departments, roles, trades: Object.entries(TRADES).map(([key, label]) => ({ key, label })) };
  });

  // Tick the departments as right; skip (or un-skip) the stock list or the vehicles; put the page away.
  app.put('/setup', async req => {
    ceo(req);
    const b = parse(z.object({ departmentsChecked: z.boolean().optional(), skip: z.enum(['stock', 'vehicles']).optional(), unskip: z.enum(['stock', 'vehicles']).optional(), dismissed: z.boolean().optional() }), req.body);
    return tx(req.db, async c => {
      const cur = await stateOf(c);
      const skipped = new Set<string>(cur.skipped ?? []);
      if (b.skip) skipped.add(b.skip);
      if (b.unskip) skipped.delete(b.unskip);
      await saveState(c, req.actor.id, { departmentsChecked: b.departmentsChecked, skipped: [...skipped], dismissed: b.dismissed });
      await audit(c, req.actor.id, 'setup_changed', 'company', null, b);
      return setupOf(c, req.companyId);
    });
  });

  // Many employees at once, each with their role. Each one is added or says why not; the others go on.
  app.post('/setup/people', async req => {
    ceo(req);
    const b = parse(z.object({ people: z.array(z.unknown()).min(1, 'at least one person').max(100) }), req.body);
    return tx(req.db, async c => {
      const results: ({ ok: true; id: string; name: string; position: string } | { ok: false; name: string; reasons: string[] })[] = [];
      for (const raw of b.people) {
        const name = String((raw as { fullName?: unknown })?.fullName ?? '').trim() || '(no name)';
        const v = NewPerson.safeParse(raw);
        if (!v.success) { results.push({ ok: false, name, reasons: v.error.issues.map(i => i.message) }); continue; }
        await c.query('SAVEPOINT person');
        try {
          const r = await addPerson(c, req.actor, req.companyId, v.data);
          await c.query('RELEASE SAVEPOINT person');
          results.push({ ok: true, id: r.id, name: r.full_name, position: r.position });
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT person');
          if (!(e instanceof Refused)) throw e;
          results.push({ ok: false, name, reasons: e.reasons });
        }
      }
      return { added: results.filter(r => r.ok).length, results };
    });
  });

  // Setup codes for many people at once (shown once; each with the message to send by WhatsApp).
  app.post('/setup/codes', async req => {
    ceo(req);
    const b = parse(z.object({ userIds: z.array(Uuid).min(1).max(100) }), req.body);
    return tx(req.db, async c => {
      const out: ({ ok: true; userId: string; name: string; phone: string | null; code: string; message: string } | { ok: false; userId: string; name: string; reasons: string[] })[] = [];
      for (const id of b.userIds) {
        const u = (await c.query('SELECT full_name, phone FROM users WHERE id = $1', [id])).rows[0];
        await c.query('SAVEPOINT code');
        try {
          const r = await issueCode(c, req.actor, req.companyId, id);
          await c.query('RELEASE SAVEPOINT code');
          out.push({ ok: true, userId: id, name: u?.full_name ?? '', phone: u?.phone ?? null, code: r.code, message: r.message });
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT code');
          if (!(e instanceof Refused)) throw e;
          out.push({ ok: false, userId: id, name: u?.full_name ?? '', reasons: e.reasons });
        }
      }
      return { codes: out };
    });
  });
}
