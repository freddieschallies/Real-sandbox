// Demo departments and van stock: each department's manager, the technicians under him, the van
// stock list he sets, and each technician's van against it (a van short of it is flagged).
import { REAL, mayHaveIncidents } from './demoReal.ts';
import { STANDARD_DEPARTMENTS } from '../../server/src/core/departments.ts';
import type { Flag } from './types.ts';
import type { DemoOfficeState } from './demoOffice.ts';
import type { DemoStockState } from './demoStock.ts';

export interface DemoDepartment { id: string; name: string; managerId: string | null; active?: boolean; logoPhotoId?: string | null }
export interface DemoVanState {
  departments: DemoDepartment[];
  /** Department of each person (technicians mostly). */
  memberOf: Record<string, string | null>;
  lists: Record<string, Record<string, number>>;
  changes: { departmentId: string; at: string; by: string; code: string; description: string; old_qty: number | null; new_qty: number | null }[];
}

export function seedVan(): DemoVanState {
  // Real-data demo: the Example Tech is in Foodservice too, so his van (not a real person's) carries the van-short flag.
  return {
    departments: [
      // The usual five (Admin is the office staff's); Refrigeration is offered to switch on.
      { id: 'dep-admin', name: 'Admin', managerId: null },
      { id: 'dep-elec', name: 'Electrical', managerId: null },
      { id: 'dep-ref', name: 'Foodservice', managerId: 'mgr-1' },
      { id: 'dep-plumb', name: 'Plumbing', managerId: null },
      { id: 'dep-svc', name: 'Service', managerId: null },
    ],
    memberOf: { 'admin-1': 'dep-admin', 'hr-1': 'dep-admin', me: 'dep-ref', 'tech-2': 'dep-ref', 'tech-4': 'dep-ref', 'tech-3': REAL ? 'dep-ref' : 'dep-plumb', 'mgr-1': 'dep-ref' },
    lists: { 'dep-ref': { 'st-1': 2, 'st-2': 2, 'st-3': 4, 'st-4': 8, 'st-5': 1, 'st-6': 2 } },
    changes: [],
  };
}

type Res = { ok: true; body: unknown } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown): Res => ({ ok: true, body });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });
const r2 = (n: number) => Math.round(n * 100) / 100;

export class DemoVan {
  constructor(public v: DemoVanState, private o: DemoOfficeState, private st: DemoStockState, private flags: Flag[]) { this.syncNames(); }

  private name(id: string | null) { return id ? this.o.people.find(p => p.id === id)?.full_name ?? id : null; }
  private person(id: string) { return this.o.people.find(p => p.id === id); }
  private item(id: string) { return this.st.items.find(i => i.id === id); }
  dept(id: string | null | undefined) { return id ? this.v.departments.find(d => d.id === id) ?? null : null; }
  deptOf(userId: string) { return this.dept(this.v.memberOf[userId] ?? null); }
  techsIn(deptId: string) { return this.o.people.filter(p => p.login_level === 'technician' && this.v.memberOf[p.id] === deptId).sort((a, b) => a.full_name.localeCompare(b.full_name)); }
  /** The department ids a person manages. */
  manages(userId: string) { return this.v.departments.filter(d => d.managerId === userId).map(d => d.id); }

  /** Van stock on his name (not booked to a job). */
  private van(userId: string) {
    const name = this.name(userId);
    const m = new Map<string, number>();
    for (const h of this.st.holdings) {
      if (h.holdingJobId !== null || h.qty <= 0) continue;
      const who = h.tech ?? 'me';
      if (who === userId || who === name) m.set(h.stockItemId, (m.get(h.stockItemId) ?? 0) + h.qty);
    }
    return m;
  }

  report(userId: string, canIssue = false) {
    const d = this.deptOf(userId);
    const list = d ? this.v.lists[d.id] ?? {} : {};
    const van = this.van(userId);
    const lines = Object.entries(list).map(([id, need]) => {
      const it = this.item(id)!; const have = r2(van.get(id) ?? 0);
      return { stockItemId: id, code: it.code, description: it.description, unit: it.unit, need, have, short: r2(Math.max(0, need - have)) };
    }).sort((a, b) => a.description.localeCompare(b.description));
    const extra = [...van.entries()].filter(([id]) => !(id in list)).map(([id, have]) => { const it = this.item(id)!; return { stockItemId: id, code: it.code, description: it.description, unit: it.unit, have }; });
    const shortLines = lines.filter(l => l.short > 0).length;
    return { technicianId: userId, name: this.name(userId), departmentId: d?.id ?? null, department: d?.name ?? null, manager: this.name(d?.managerId ?? null),
      hasList: lines.length > 0, complete: shortLines === 0, shortLines, lines, extra, canIssue };
  }

  /** Opens, updates or closes his van-short flag, as the server does. */
  check(userId: string, by: string) {
    const r = this.report(userId);
    const open = this.flags.find(f => f.flag_type === 'van_stock_short' && f.tech === userId && f.status !== 'resolved');
    const short = r.lines.filter(l => l.short > 0).map(l => ({ code: l.code, description: l.description, need: l.need, have: l.have, short: l.short }));
    const text = short.map(s => `${s.description} ${s.have} of ${s.need}`).join(', ');
    const question = `Your van is short of the ${r.department} van stock list: ${text}. The stockroom tops it up.`;
    if (short.length) {
      // Real-data demo: flags only on the Example Tech; a real person's van just shows what it is short of.
      if (!mayHaveIncidents(userId)) return r;
      if (open) Object.assign(open, { details: { short }, question });
      else this.flags.unshift({ id: `flag-van-${userId}-${Date.now()}`, flag_type: 'van_stock_short', severity: 'normal', raised_at: new Date().toISOString(), status: 'open', question, explanation: null, details: { short }, tech: userId });
    } else if (open) Object.assign(open, { status: 'resolved', resolution_note: r.hasList ? `Van stock complete again (${by})` : 'No van stock list for his department any more' });
    return r;
  }
  checkAll(by: string) { for (const p of this.o.people.filter(x => x.login_level === 'technician')) this.check(p.id, by); }
  shortCount(userId: string) {
    if (REAL) return this.report(userId).shortLines;
    const f = this.flags.find(x => x.flag_type === 'van_stock_short' && x.tech === userId && x.status !== 'resolved');
    return f ? ((f.details.short as unknown[]) ?? []).length : 0;
  }

  // ---- Departments ------------------------------------------------------------------------------
  departments(canManage: boolean) {
    return {
      canManage,
      missing: STANDARD_DEPARTMENTS.filter(x => !this.v.departments.some(d => d.name.toLowerCase() === x.name.toLowerCase())).map(x => x.name),
      departments: [...this.v.departments].sort((a, b) => a.name.localeCompare(b.name)).map(d => ({ id: d.id, name: d.name, active: d.active !== false, logo_photo_id: d.logoPhotoId ?? null, manager_id: d.managerId, manager: this.name(d.managerId), technicians: this.techsIn(d.id).length, staff: Object.entries(this.v.memberOf).filter(([u, dep]) => dep === d.id && this.person(u)).length, van_lines: Object.keys(this.v.lists[d.id] ?? {}).length })),
      managers: this.o.people.filter(p => ['management', 'director', 'creator'].includes(p.login_level)).map(p => ({ id: p.id, full_name: p.full_name, login_level: p.login_level })),
      members: this.o.people.filter(p => !['director', 'creator'].includes(p.login_level)).sort((a, b) => a.full_name.localeCompare(b.full_name))
        .map(p => ({ id: p.id, full_name: p.full_name, login_level: p.login_level, trade: p.trade ?? null, department_id: this.v.memberOf[p.id] ?? null })),
    };
  }
  private okManager(id: string | null | undefined): Res | null {
    if (!id) return null;
    const p = this.person(id);
    if (!p) return bad(404, 'no such person');
    return ['management', 'director', 'creator'].includes(p.login_level) ? null : bad(409, 'make the person a Department manager first');
  }
  /** Managers run one department each: he leaves any other, and the previous manager is left without one. */
  private makeManager(managerId: string, deptId: string): string | null {
    const d = this.dept(deptId)!;
    const prev = d.managerId && d.managerId !== managerId ? d.managerId : null;
    for (const x of this.v.departments) if (x.managerId === managerId && x.id !== deptId) x.managerId = null;
    d.managerId = managerId;
    if (this.person(managerId)?.login_level === 'management') this.v.memberOf[managerId] = deptId;
    if (prev && this.person(prev)?.login_level === 'management') this.v.memberOf[prev] = null;
    return prev ? this.name(prev) : null;
  }

  createDept(b: { name?: string; managerId?: string | null }): Res {
    const name = (b.name ?? '').trim();
    if (name.length < 2) return bad(400, 'the department name');
    const same = this.v.departments.find(d => d.name.toLowerCase() === name.toLowerCase());
    if (same && same.active !== false) return bad(409, `there is already a ${name} department`);
    const m = this.okManager(b.managerId); if (m) return m;
    // Switched off before: switch it back on (with its van stock list).
    if (same) { same.active = true; if (b.managerId) this.makeManager(b.managerId, same.id); return good({ id: same.id }); }
    const id = `dep-${Date.now()}`;
    this.v.departments.push({ id, name, managerId: null });
    if (b.managerId) this.makeManager(b.managerId, id);
    return good({ id });
  }
  /** Each person's department as the office lists show it: always the department's current name. */
  private syncNames() { for (const p of this.o.people) { const d = this.deptOf(p.id); if (d) p.department = d.name; } }
  updateDept(id: string, b: { name?: string; managerId?: string | null; active?: boolean; logoPhotoId?: string | null }): Res {
    const d = this.dept(id);
    if (!d) return bad(404, 'no such department');
    if (b.active === false && d.active !== false) {
      const n = Object.entries(this.v.memberOf).filter(([u, dep]) => dep === id && this.person(u)).length;
      if (n || d.managerId) return bad(409, `move everyone in ${d.name} (${Math.max(n, 1)} ${Math.max(n, 1) === 1 ? 'person' : 'people'}) to another department first`);
    }
    if (b.active === undefined && d.active === false && b.managerId) return bad(409, `switch ${d.name} on first`);
    if (b.active !== undefined) d.active = b.active;
    const m = this.okManager(b.managerId); if (m) return m;
    if (b.name !== undefined) {
      const name = b.name.trim();
      if (name.length < 2) return bad(400, 'the department name');
      if (this.v.departments.some(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) return bad(409, `there is already a ${name} department`);
      d.name = name;
      this.syncNames();
    }
    if (b.logoPhotoId !== undefined) d.logoPhotoId = b.logoPhotoId;
    let replaced: string | null = null;
    if (b.managerId) replaced = this.makeManager(b.managerId, id);
    else if (b.managerId === null && d.managerId) { if (this.person(d.managerId)?.login_level === 'management') this.v.memberOf[d.managerId] = null; d.managerId = null; }
    return good({ id, replaced });
  }
  setDepartment(userId: string, departmentId: string | null, by: string): Res {
    if (!this.person(userId)) return bad(404, 'no such person');
    if (departmentId && !this.dept(departmentId)) return bad(404, 'no such department');
    if (departmentId && this.dept(departmentId)!.active === false) return bad(409, `${this.dept(departmentId)!.name} is switched off: switch it on under Departments first`);
    if (this.person(userId)!.login_level === 'management') {
      let replaced: string | null = null;
      if (departmentId) replaced = this.makeManager(userId, departmentId);
      else { for (const x of this.v.departments) if (x.managerId === userId) x.managerId = null; this.v.memberOf[userId] = null; }
      return good({ userId, departmentId, manages: departmentId, replaced, van: null });
    }
    this.v.memberOf[userId] = departmentId;
    this.syncNames();
    const r = this.check(userId, by);
    return good({ userId, departmentId, manages: null, replaced: null, van: { complete: r.complete, shortLines: r.shortLines } });
  }
  team(managerId: string) {
    return this.manages(managerId).flatMap(d => this.techsIn(d).map(t => ({ id: t.id, full_name: t.full_name, department: this.dept(d)!.name })));
  }

  // ---- Van stock lists ----------------------------------------------------------------------------
  lists(scope: 'all' | string[], editable: (deptId: string) => boolean) {
    const depts = this.v.departments.filter(d => d.active !== false && (scope === 'all' || scope.includes(d.id)))
      .sort((a, b) => Number(editable(b.id)) - Number(editable(a.id)) || a.name.localeCompare(b.name));
    return {
      departments: depts.map(d => ({
        id: d.id, name: d.name, logo_photo_id: d.logoPhotoId ?? null, manager: this.name(d.managerId), canEdit: editable(d.id),
        lines: Object.entries(this.v.lists[d.id] ?? {}).map(([id, qty]) => { const it = this.item(id)!; return { stockItemId: id, code: it.code, description: it.description, unit: it.unit, qty }; })
          .sort((a, b) => a.description.localeCompare(b.description)),
        techs: this.techsIn(d.id).map(t => { const r = this.report(t.id); return { id: t.id, full_name: t.full_name, complete: r.complete, shortLines: r.shortLines }; }),
      })),
    };
  }
  setItem(deptId: string, itemId: string, qty: number, by: string): Res {
    if (!this.dept(deptId)) return bad(404, 'no such department');
    const it = this.item(itemId);
    if (!it) return bad(404, 'no such stock item');
    if ((it.category ?? 'stock') !== 'stock') return bad(409, `${it.description} is ${it.category === 'ppe' ? 'PPE' : 'a tool'}: those are issued by name, not carried as van stock`);
    if (!(qty >= 0)) return bad(400, 'how many');
    const list = (this.v.lists[deptId] ??= {});
    const old = list[itemId] ?? null;
    if (qty === 0) delete list[itemId]; else list[itemId] = qty;
    if (old !== (qty || null)) this.v.changes.unshift({ departmentId: deptId, at: new Date().toISOString(), by: this.name(by) ?? by, code: it.code, description: it.description, old_qty: old, new_qty: qty || null });
    const techs = this.techsIn(deptId).map(t => { const r = this.check(t.id, this.name(by) ?? by); return { id: t.id, full_name: t.full_name, complete: r.complete, shortLines: r.shortLines }; });
    return good({ departmentId: deptId, stockItemId: itemId, qty, techs });
  }
  changes(deptId: string) {
    return this.v.changes.filter(c => c.departmentId === deptId).map(c => ({ changed_at: c.at, by: c.by, code: c.code, description: c.description, old_qty: c.old_qty, new_qty: c.new_qty }));
  }
  issue(userId: string, lines: { stockItemId: string; qty: number }[], by: string): Res {
    const p = this.person(userId);
    if (!p) return bad(404, 'no such person');
    if (p.login_level !== 'technician') return bad(409, 'van stock is for technicians');
    if (!lines?.length) return bad(400, 'what to put on his van');
    const problems: string[] = [];
    for (const l of lines) {
      const it = this.item(l.stockItemId);
      if (!it) { problems.push('unknown stock item'); continue; }
      if ((it.category ?? 'stock') !== 'stock') problems.push(`${it.code} is ${it.category === 'ppe' ? 'PPE' : 'a tool'}: issue it by name on his People page`);
      else if ((this.st.stockroom[it.id] ?? 0) < l.qty) problems.push(`${it.code}: only ${this.st.stockroom[it.id] ?? 0} in the stockroom`);
    }
    if (problems.length) return bad(409, ...problems);
    const tech = userId === 'me' ? undefined : p.full_name;
    for (const l of lines) {
      this.st.stockroom[l.stockItemId] -= l.qty;
      const h = this.st.holdings.find(x => x.stockItemId === l.stockItemId && x.holdingJobId === null && (x.tech ?? 'me') === (tech ?? 'me'));
      if (h) h.qty += l.qty; else this.st.holdings.push({ stockItemId: l.stockItemId, holdingJobId: null, qty: l.qty, ...(tech ? { tech } : {}) });
      const it = this.item(l.stockItemId)!;
      (this.st.activity ??= []).unshift({ id: `a-${Date.now()}-${l.stockItemId}`, at: new Date().toISOString(), kind: 'assign', what: 'Van stock issued', qty: l.qty, code: it.code, description: it.description, unit: it.unit,
        technician: p.full_name, by: this.name(by) ?? by, jobNumber: null, store: null, unitCostCents: null, reference: null });
    }
    return good(this.check(userId, this.name(by) ?? by));
  }
}
