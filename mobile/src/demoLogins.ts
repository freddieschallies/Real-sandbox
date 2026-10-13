// The test drive's own logins: the same rules as the real server (setup code from HR or the CEO,
// the person chooses their own password, five wrong tries lock it), kept in this browser only.
// The real server keeps bcrypt hashes; here a simple scrambled copy is enough, nothing leaves the page.
import { passwordProblem } from './password.ts';

export interface DemoLogin { hash?: string; enabled: boolean; setAt?: string; lastAt?: string; failed: number; lockedUntil?: string }
export interface DemoCode { hash: string; issuedAt: string; expiresAt: string; issuedBy: string; tries: number }
export interface DemoLoginsState { logins: Record<string, DemoLogin>; codes: Record<string, DemoCode>; log: { userId: string; at: string; change: string; by: string }[] }
export interface LoginPerson { id: string; full_name: string; login_level: string; email: string | null; phone: string | null }

type Res = { ok: true; body: unknown } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown): Res => ({ ok: true, body });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });

export const CODE_DAYS = 7;
const MAX_WRONG = 5;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function scramble(salt: string, text: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (const ch of `${salt}:${text}`) { h1 = Math.imul(h1 ^ ch.charCodeAt(0), 0x01000193) >>> 0; h2 = Math.imul(h2 + ch.charCodeAt(0), 0x5bd1e995) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
const normal = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export class DemoLogins {
  constructor(public s: DemoLoginsState, private people: () => LoginPerson[]) {}

  private person(id: string) { return this.people().find(p => p.id === id); }
  private byEmail(email: string) { const e = email.trim().toLowerCase(); return e ? this.people().find(p => (p.email ?? '').toLowerCase() === e) : undefined; }
  private log(userId: string, change: string, by: string) { this.s.log.unshift({ userId, at: new Date().toISOString(), change, by }); this.s.log = this.s.log.slice(0, 500); }
  private openCode(id: string) { const c = this.s.codes[id]; return c && Date.parse(c.expiresAt) > Date.now() ? c : undefined; }

  state(id: string): 'on' | 'code' | 'stopped' | 'none' {
    const l = this.s.logins[id];
    if (l?.enabled && l.hash) return 'on';
    if (this.openCode(id)) return 'code';
    return l?.hash ? 'stopped' : 'none';
  }

  /** For the People list: also whether five wrong passwords locked it. */
  listState(id: string): 'on' | 'code' | 'stopped' | 'none' | 'locked' {
    const l = this.s.logins[id];
    return l?.lockedUntil && Date.parse(l.lockedUntil) > Date.now() ? 'locked' : this.state(id);
  }

  /** Whether someone at `level` (with `ceo`: manages access) looks after the login of `target`. */
  manages(me: { id: string; level: string; ceo: boolean }, target: { id: string; login_level: string }) {
    if (target.id === me.id) return false;
    if (me.ceo) return target.login_level !== 'creator' || me.level === 'creator';
    // The admin looks after everyone's login except the directors' and the CEO's.
    return me.level === 'admin' && target.login_level !== 'director' && target.login_level !== 'creator';
  }

  info(id: string, canManage: boolean, mine: boolean, left: boolean) {
    const p = this.person(id);
    const l = this.s.logins[id];
    const c = this.openCode(id);
    const locked = !!l?.lockedUntil && Date.parse(l.lockedUntil) > Date.now();
    return {
      email: p?.email ?? null, state: this.state(id), hasPassword: !!l?.hash, passwordSetAt: l?.setAt ?? null, lastSignIn: l?.lastAt ?? null,
      locked, lockedUntil: locked ? l!.lockedUntil : null, codeWaiting: c ? { issued_at: c.issuedAt, expires_at: c.expiresAt, issued_by: c.issuedBy } : null,
      left, canManage: canManage && !left, mine, codeDays: CODE_DAYS, history: this.s.log.filter(x => x.userId === id).slice(0, 12).map(x => ({ at: x.at, change: x.change, by: x.by })),
    };
  }

  issueCode(id: string, by: string, company: string): Res {
    const p = this.person(id);
    if (!p) return bad(404, 'no such person');
    if (!p.email) return bad(409, `${p.full_name.split(' ')[0]} needs an email first: it is what he signs in with (edit the contact details)`);
    const other = this.people().find(x => x.id !== id && (x.email ?? '').toLowerCase() === p.email!.toLowerCase());
    if (other) return bad(409, `that email is also ${other.full_name}'s: give one of them another email`);
    let raw = '';
    for (let i = 0; i < 8; i++) raw += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const expiresAt = new Date(Date.now() + CODE_DAYS * 86_400_000).toISOString();
    const had = !!this.s.logins[id]?.hash;
    this.s.codes[id] = { hash: scramble(id, normal(code)), issuedAt: new Date().toISOString(), expiresAt, issuedBy: by, tries: 0 };
    const l = (this.s.logins[id] ??= { enabled: false, failed: 0 });
    l.failed = 0; delete l.lockedUntil;
    this.log(id, had ? 'New setup code (to reset the password)' : 'Setup code given for the first sign-in', by);
    const until = new Date(expiresAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' });
    return good({
      code, expiresAt, email: p.email,
      message: `Hi ${p.full_name.split(' ')[0]}, this is your ${company} job card app sign-in.\n1. Open the app and tap "I have a setup code".\n2. Email: ${p.email}\n3. Setup code: ${code}\n`
        + `4. Choose your own password (at least 8 characters). Don't tell anyone your password.\nThe code works once, until ${until}.\n(Test drive: this code only works in the test drive, in this browser.)`,
    });
  }

  stop(id: string, by: string): Res {
    const l = (this.s.logins[id] ??= { enabled: false, failed: 0 });
    l.enabled = false; delete this.s.codes[id];
    this.log(id, 'Login stopped', by);
    return good({ id, state: this.state(id) });
  }
  allow(id: string, by: string): Res {
    const l = this.s.logins[id];
    const p = this.person(id);
    if (!l?.hash) return bad(409, `${p?.full_name.split(' ')[0] ?? 'They'} has not chosen a password yet: give a setup code`);
    l.enabled = true; l.failed = 0; delete l.lockedUntil;
    this.log(id, 'Login allowed again', by);
    return good({ id, state: 'on' });
  }
  signOutAll(id: string, by: string): Res { this.log(id, 'Signed out on every phone', by); return good({ id }); }

  login(email: string, password: string): Res {
    const wrong = bad(401, 'wrong email or password', 'First time? Tap "I have a setup code" and use the code the office gave you.');
    const p = this.byEmail(email);
    if (!p) return wrong;
    const l = this.s.logins[p.id];
    if (l?.lockedUntil && Date.parse(l.lockedUntil) > Date.now()) {
      const min = Math.ceil((Date.parse(l.lockedUntil) - Date.now()) / 60_000);
      return bad(429, `too many wrong passwords: try again in ${min} minute${min === 1 ? '' : 's'}`, 'Forgot it? Ask the office for a new setup code.');
    }
    if (!l?.hash || l.hash !== scramble(p.id, password)) {
      if (l) { l.failed += 1; if (l.failed >= MAX_WRONG) { l.failed = 0; l.lockedUntil = new Date(Date.now() + 15 * 60_000).toISOString(); } }
      return wrong;
    }
    if (!l.enabled) return bad(403, 'your login is stopped', 'Ask the office (HR or the CEO) to allow it again.');
    l.failed = 0; delete l.lockedUntil; l.lastAt = new Date().toISOString();
    return good({ id: p.id });
  }

  setup(email: string, code: string, password: string): Res {
    const wrong = bad(401, 'wrong email or setup code, or the code has expired', 'Ask the office for a new setup code.');
    const weak = passwordProblem(password, email);
    if (weak) return bad(400, weak);
    const p = this.byEmail(email);
    if (!p) return wrong;
    const c = this.openCode(p.id);
    if (!c) return wrong;
    if (c.hash !== scramble(p.id, normal(code))) {
      c.tries += 1;
      if (c.tries >= MAX_WRONG) delete this.s.codes[p.id];
      return wrong;
    }
    delete this.s.codes[p.id];
    const now = new Date().toISOString();
    this.s.logins[p.id] = { hash: scramble(p.id, password), enabled: true, setAt: now, lastAt: now, failed: 0 };
    this.log(p.id, 'Chose their own password with the setup code', p.full_name);
    return good({ id: p.id });
  }

  change(id: string, name: string, email: string, current: string, password: string): Res {
    const l = this.s.logins[id];
    if (!l?.hash) return bad(409, 'you came in through the test drive\'s "Open as" buttons, so there is no password to change: give yourself a login under People, then sign in with it');
    if (l.hash !== scramble(id, current)) return bad(403, 'your current password is wrong');
    const weak = passwordProblem(password, email);
    if (weak) return bad(400, weak);
    if (password === current) return bad(400, 'the new password is the same as the old one');
    l.hash = scramble(id, password); l.setAt = new Date().toISOString();
    this.log(id, 'Changed their own password', name);
    return good({ token: `demo-${id}-${Date.now()}` });
  }
}
