// The test drive's Real Sandbox support and owner dashboard, the same rules as the server
// (routes/support.ts and routes/platform.ts): the owner sees each company as counts only, and opens
// one only while its CEO allows it. The other companies on the dashboard are made up.
type Res = { ok: true; body: unknown } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown): Res => ({ ok: true, body });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });

export const SUPPORT_HOURS = [1, 4, 24, 72];
export const OWNER_NAME = 'Fred';
export const SUPPORT_WHO = { id: 'support', name: `Support: ${OWNER_NAME} (Real Sandbox)`, level: 'creator' };

export interface DemoGrant { id: string; grantedAt: string; until: string; reason: string | null; grantedBy: string; endedAt: string | null; endedBy: string | null; enteredAt: string | null; enteredBy: string | null }
export interface DemoOtherCompany { id: string; name: string; active: boolean; created_at: string; suspended_at: string | null; suspended_reason: string | null; people: number; activeWeek: number; jobsMonth: number;
  lastActivity: string | null; setup: { done: number; total: number }; whatsapp: { mode: string; connected: boolean } | null; pastel: boolean; ceo: { id: string; name: string; email: string; login: string; lastLogin: string | null } | null }
export interface DemoSupportState { grants: DemoGrant[]; others: DemoOtherCompany[]; demoActive: boolean; demoReason: string | null }

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
export const seedSupport = (): DemoSupportState => ({
  grants: [], demoActive: true, demoReason: null,
  others: [
    { id: 'co-coastal', name: 'Coastal Cooling (example)', active: true, created_at: ago(24 * 60), suspended_at: null, suspended_reason: null, people: 14, activeWeek: 11, jobsMonth: 96,
      lastActivity: ago(1), setup: { done: 15, total: 16 }, whatsapp: { mode: 'phone', connected: true }, pastel: true,
      ceo: { id: 'ceo-coastal', name: 'Bea Example', email: 'bea@coastal.example', login: 'on', lastLogin: ago(3) } },
    { id: 'co-inland', name: 'Inland Refrigeration (example)', active: true, created_at: ago(24 * 4), suspended_at: null, suspended_reason: null, people: 3, activeWeek: 1, jobsMonth: 0,
      lastActivity: ago(30), setup: { done: 4, total: 16 }, whatsapp: null, pastel: false,
      ceo: { id: 'ceo-inland', name: 'Ian Example', email: 'ian@inland.example', login: 'locked', lastLogin: ago(28) } },
  ],
});

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => { let s = ''; for (let i = 0; i < 8; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]; return `${s.slice(0, 4)}-${s.slice(4)}`; };

export interface SupportDeps {
  /** How the test-drive company itself is getting on, counts only. */
  health: () => Omit<DemoOtherCompany, 'id' | 'name' | 'active' | 'created_at' | 'suspended_at' | 'suspended_reason'>;
  companyName: () => string;
  /** The CEO's setup code (the test drive's own login book). */
  ceoCode: () => { code: string; email: string; name: string; message: string; expiresAt: string } | { error: string };
}

export class DemoSupport {
  constructor(public s: DemoSupportState, private d: SupportDeps) {}

  open(): DemoGrant | null {
    const now = Date.now();
    return this.s.grants.find(g => !g.endedAt && Date.parse(g.until) > now) ?? null;
  }

  // The company side.
  view(ceo: boolean, isSupport: boolean) {
    return { active: this.open(), canGrant: ceo && !isSupport, hours: SUPPORT_HOURS, history: ceo && !isSupport ? this.s.grants.slice(0, 10) : [], isSupport };
  }
  grant(by: string, hours: number, reason?: string): Res {
    if (!SUPPORT_HOURS.includes(hours) && !(hours >= 1 && hours <= 72)) return bad(400, 'between 1 and 72 hours');
    const now = new Date();
    for (const g of this.s.grants) if (!g.endedAt) { g.endedAt = now.toISOString(); g.endedBy = by; }
    this.s.grants.unshift({ id: `grant-${now.getTime()}`, grantedAt: now.toISOString(), until: new Date(now.getTime() + hours * 3_600_000).toISOString(), reason: reason?.trim() || null,
      grantedBy: by, endedAt: null, endedBy: null, enteredAt: null, enteredBy: null });
    this.s.grants.splice(20);
    return good({ active: this.open() });
  }
  end(by: string): Res {
    const g = this.open();
    if (g) { g.endedAt = new Date().toISOString(); g.endedBy = by; }
    return good({ active: null });
  }

  // The owner's side.
  dashboard() {
    const now = new Date().toISOString();
    const g = this.open();
    const me = { id: 'demo', name: this.d.companyName(), active: this.s.demoActive, created_at: ago(24 * 30), suspended_at: this.s.demoActive ? null : now, suspended_reason: this.s.demoReason,
      ...this.d.health(), support: g ? { until: g.until, grantedBy: g.grantedBy, reason: g.reason, enteredAt: g.enteredAt } : null };
    const companies = [me, ...this.s.others.map(o => ({ ...o, support: null }))].sort((a, b) => a.name.localeCompare(b.name));
    return { owner: OWNER_NAME, companies, demo: true };
  }
  enter(id: string): Res {
    if (id !== 'demo') {
      const o = this.s.others.find(x => x.id === id);
      if (!o) return bad(404, 'no such company');
      return bad(409, `${o.name}'s CEO has not let support in`, 'Ask the CEO to open Settings → Real Sandbox support and tap "Let support in".');
    }
    if (!this.s.demoActive) return bad(409, 'the company is suspended: reactivate it first');
    const g = this.open();
    if (!g) return bad(409, `${this.d.companyName()}'s CEO has not let support in`, 'In the test drive: open as the CEO, go to Settings → Real Sandbox support and tap "Let support in", then come back here.');
    if (!g.enteredAt) { g.enteredAt = new Date().toISOString(); g.enteredBy = OWNER_NAME; }
    return good({ token: 'demo-support', user: SUPPORT_WHO, company: { id: 'demo', name: this.d.companyName() }, until: g.until, signedInFor: 'until support access ends' });
  }
  ceoCode(id: string): Res {
    if (id === 'demo') {
      const r = this.d.ceoCode();
      return 'error' in r ? bad(409, r.error) : good({ ...r, company: this.d.companyName() });
    }
    const o = this.s.others.find(x => x.id === id);
    if (!o?.ceo) return bad(404, 'no such company');
    if (!o.active) return bad(409, 'the company is suspended: reactivate it first');
    const code = newCode();
    o.ceo.login = 'code';
    return good({ code, email: o.ceo.email, name: o.ceo.name, company: o.name, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      message: `Hi ${o.ceo.name.split(' ')[0]}, this is your ${o.name} job card app sign-in.\n1. Open the app and tap "I have a setup code".\n2. Email: ${o.ceo.email}\n3. Setup code: ${code}\n4. Choose your own password (at least 8 characters). Don't tell anyone your password.\nThe code works once, for 7 days.` });
  }
  add(b: { name?: string; creator?: { name?: string; email?: string } }): Res {
    const name = String(b.name ?? '').trim();
    const ceo = { name: String(b.creator?.name ?? '').trim(), email: String(b.creator?.email ?? '').trim().toLowerCase() };
    if (name.length < 2) return bad(400, 'type the company name');
    if (ceo.name.length < 2) return bad(400, "type the CEO's name");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ceo.email)) return bad(400, "type the CEO's email");
    if (this.s.others.some(o => o.name.toLowerCase() === name.toLowerCase()) || name.toLowerCase() === this.d.companyName().toLowerCase()) return bad(409, 'a company with that name exists');
    if (this.s.others.some(o => o.ceo?.email === ceo.email)) return bad(409, 'that email already has a login');
    const id = `co-${Date.now()}`;
    this.s.others.push({ id, name, active: true, created_at: new Date().toISOString(), suspended_at: null, suspended_reason: null, people: 1, activeWeek: 0, jobsMonth: 0, lastActivity: new Date().toISOString(),
      setup: { done: 1, total: 16 }, whatsapp: null, pastel: false, ceo: { id: `ceo-${id}`, name: ceo.name, email: ceo.email, login: 'none', lastLogin: null } });
    const code = this.ceoCode(id);
    return good({ companyId: id, code: code.ok ? code.body : null });
  }
  suspend(id: string, active: boolean, reason?: string): Res {
    if (!active && !reason?.trim()) return bad(400, 'give a reason for suspending');
    // Suspending the test drive's own company would lock you out of the test drive: try it on an example one.
    if (id === 'demo') return active ? good({ id, name: this.d.companyName(), active }) : bad(409, 'In the test drive this company cannot be suspended (you would lock yourself out): try it on one of the example companies.');
    const o = this.s.others.find(x => x.id === id);
    if (!o) return bad(404, 'no such company');
    o.active = active; o.suspended_at = active ? null : new Date().toISOString(); o.suspended_reason = active ? null : reason!.trim();
    return good({ id, name: o.name, active });
  }
}
