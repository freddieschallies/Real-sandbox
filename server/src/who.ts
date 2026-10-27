// Who does a kind of work in a company: everyone in that position, and anyone the CEO gave that work
// on top of their own position. When the company does not have the position (the owner of Real Sandbox
// set it up without it), the CEO always does the work too, with whoever the CEO appointed. When it has
// the position but nobody is in it (yet), the CEO, so nothing goes unseen.
import type { Q } from './db.ts';
import type { Action, LoginLevel } from './core/permissions.ts';
import { hasPosition, planOf } from './core/plan.ts';

export async function whoDoes(c: Q, level: LoginLevel, action: Action, except?: string): Promise<string[]> {
  const ids = (await c.query(
    `SELECT id FROM users u WHERE status <> 'left' AND support_owner IS NULL AND (login_level = $1
       OR EXISTS (SELECT 1 FROM access_overrides o WHERE o.user_id = u.id AND o.action = $2 AND o.effect = 'grant'))`, [level, action])).rows.map(r => r.id as string);
  const co = (await c.query('SELECT positions, parts FROM companies WHERE id = current_company()')).rows[0];
  const missing = co ? !hasPosition(planOf(co), level) : false;
  const ceo = missing || !ids.length
    ? (await c.query("SELECT id FROM users WHERE login_level = 'creator' AND status <> 'left' AND support_owner IS NULL ORDER BY created_at")).rows.map(r => r.id as string) : [];
  return [...new Set([...ceo, ...ids])].filter(id => id !== except);
}
