// The demo's pretend office: everything the office screen needs, worked out from the same demo data
// the technician, stock controller and mechanic use, so what one does the office sees.
import type { DemoFleet } from './demoFleet.ts';
import { DEMO_TECHS } from './demoFleet.ts';
import type { DemoWorkshop } from './demoWorkshop.ts';
import type { DemoStockState } from './demoStock.ts';

export interface DemoStore { id: string; client: string; name: string; address: string | null; lat: number; lng: number; geofence_m: number }
export interface DemoInspection {
  id: string; vehicle_id: string; registration: string; driver_id: string; driver: string; previous_driver: string | null; inspected_at: string;
  odometer_km: number; fuel_level: string; problems: string[]; new_problems: string[]; handover_by: string; handed_over_by_name: string | null;
  remote_reason: string | null; status: 'signed' | 'awaiting_approval' | 'approved' | 'rejected'; decided_at: string | null; decision_note: string | null;
}
export interface DemoPerson { id: string; full_name: string; login_level: string; department: string }
export interface DemoOfficeState {
  stores: DemoStore[];
  inspections: DemoInspection[];
  people: DemoPerson[];
  changes: { at: string; by: string; person: string; action: string; change: string }[];
}

export const POSITION_LABEL: Record<string, string> = {
  technician: 'Technician', mechanic: 'Mechanic (fleet)', admin: 'Admin', stockroom: 'Stock controller', management: 'Management', director: 'Director', creator: 'Creator (CEO)',
};

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

export function seedOffice(): DemoOfficeState {
  return {
    stores: [
      { id: 'meerensee', client: 'FreshMart', name: 'FreshMart Meerensee', address: 'Meerensee Mall, Richards Bay', lat: -28.7743, lng: 32.0789, geofence_m: 150 },
      { id: 'empangeni', client: 'FreshMart', name: 'FreshMart Empangeni', address: 'Union St, Empangeni', lat: -28.7621, lng: 31.8932, geofence_m: 150 },
      { id: 'harbour', client: 'Harbour Deli', name: 'Harbour Deli, Alton', address: 'Hydrogen Line St, Alton North', lat: -28.7395, lng: 32.0201, geofence_m: 150 },
      { id: 'esikhawini', client: 'Boxer', name: 'Boxer Esikhawini', address: 'Esikhawini Mall', lat: -28.8706, lng: 31.9118, geofence_m: 150 },
      { id: 'arboretum', client: 'Spar', name: 'Spar Arboretum', address: 'Arboretum Centre, Richards Bay', lat: -28.7465, lng: 32.0584, geofence_m: 150 },
    ],
    inspections: [{
      id: 'insp-ayanda', vehicle_id: 'veh-5', registration: 'ND 771-330', driver_id: 'tech-3', driver: 'Ayanda Mthembu', previous_driver: 'Sipho Ndlovu',
      inspected_at: ago(3), odometer_km: 45120, fuel_level: 'half', problems: ['bodywork'], new_problems: [], handover_by: 'remote_approval', handed_over_by_name: null,
      remote_reason: 'Picked it up at 05:40 from the yard, nobody there to sign', status: 'awaiting_approval', decided_at: null, decision_note: null,
    }],
    people: [
      { id: 'office', full_name: 'Lilanie Schallies', login_level: 'creator', department: 'Office' },
      { id: 'admin-1', full_name: 'Zanele Khoza', login_level: 'admin', department: 'Office' },
      { id: 'mgr-1', full_name: 'Pieter van Wyk', login_level: 'management', department: 'Refrigeration' },
      { id: 'stock', full_name: 'Lindiwe Zulu', login_level: 'stockroom', department: 'Stores' },
      { id: 'mech', full_name: 'Bongani Khumalo', login_level: 'mechanic', department: 'Workshop' },
      ...DEMO_TECHS.map(t => ({ id: t.id, full_name: t.full_name, login_level: 'technician', department: 'Refrigeration' })),
    ],
    changes: [],
  };
}

type Res = { ok: true; body: unknown; status?: number } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown, status = 200): Res => ({ ok: true, body, status });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });

/** What the office needs from the rest of the demo. */
export interface OfficeSources {
  jobs: { meta: { id: string; job_number: number; job_type: string; priority: string; scheduled_date: string; fault_reported: string; store: string; lead_technician: string; lead_id?: string; helper_ids?: string[] }; card: { status: string } }[];
  flags: { id: string; flag_type: string; severity: string; raised_at: string; question: string | null; explanation: string | null; status: string; details: Record<string, unknown>; tech?: string; resolution_note?: string | null }[];
  fleet: DemoFleet;
  workshop: DemoWorkshop;
  stock: DemoStockState;
  fleetDuty: Record<string, boolean>;
  /** The demo technician's own handover waiting for approval, if any. */
  myHandover: DemoInspection | null;
}

export class DemoOffice {
  constructor(public o: DemoOfficeState, private src: OfficeSources) {}

  private today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }); }
  private yesterday() { return new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }); }
  name(id: string) { return this.o.people.find(p => p.id === id)?.full_name ?? id; }
  private techs() { return this.o.people.filter(p => p.login_level === 'technician'); }

  overview() {
    const t = this.today();
    const jobs = this.src.jobs;
    const open = jobs.filter(j => j.card.status !== 'closed');
    const flags = this.flags('unresolved');
    const checks = this.src.fleet.checksFor();
    const y = this.src.fleet.checksFor(this.yesterday());
    const veh = this.src.fleet.list();
    const ws = this.src.workshop.list();
    const req = this.src.stock.requests ?? [];
    return {
      date: t,
      jobs: {
        today: open.filter(j => j.meta.scheduled_date === t).length, in_progress: jobs.filter(j => j.card.status === 'in_progress').length,
        continue_later: jobs.filter(j => j.card.status === 'continue_later').length, carried_over: open.filter(j => j.meta.scheduled_date < t).length,
        urgent: open.filter(j => j.meta.priority === 'urgent').length, closed_today: jobs.filter(j => j.card.status === 'closed').length,
      },
      flags: { unresolved: flags.length, explained: flags.filter(f => f.status === 'explained').length },
      handoversAwaitingApproval: this.inspections('awaiting_approval').length,
      fleet: {
        in_service: veh.filter(v => v.status === 'in_service').length, off: veh.filter(v => v.status !== 'in_service').length,
        safety_faults: this.src.fleet.openFaults().filter(f => f.severity === 'safety').length, checked_today: checks.done, due: checks.due,
        missedYesterday: y.vehicles.filter(v => v.required && !v.id).map(v => ({ id: v.vehicle_id, registration: v.registration })),
      },
      stock: { to_issue: req.filter(r => r.status === 'pending').length, to_receive: this.src.stock.returns.filter(r => r.status === 'pending').length, workshop_below_min: ws.belowMin },
      technicians: { active: this.techs().length, without_work: this.techs().filter(p => !open.some(j => (j.meta.lead_id ?? 'me') === p.id)).length },
    };
  }

  jobs(status?: string | null) {
    return this.src.jobs.filter(j => !status || j.card.status === status).map(j => ({
      id: j.meta.id, job_number: j.meta.job_number, job_type: j.meta.job_type, priority: j.meta.priority, status: j.card.status,
      scheduled_date: j.meta.scheduled_date, fault_reported: j.meta.fault_reported, store: j.meta.store, lead_technician: j.meta.lead_technician,
      lead_id: j.meta.lead_id ?? 'me', helper_ids: j.meta.helper_ids ?? [],
    })).sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || a.scheduled_date.localeCompare(b.scheduled_date) || a.job_number - b.job_number);
  }

  stores() {
    return this.o.stores.map(s => ({ ...s, branch_code: null, equipment: 0, open_jobs: this.src.jobs.filter(j => j.meta.store === s.name && j.card.status !== 'closed').length }))
      .sort((a, b) => a.client.localeCompare(b.client) || a.name.localeCompare(b.name));
  }

  addStore(b: { client: string; name: string; address?: string; lat: number; lng: number }): Res {
    const missing = [!b.client || b.client.trim().length < 2 ? 'client name' : null, !b.name || b.name.trim().length < 2 ? 'store name' : null,
      !(b.lat >= -35 && b.lat <= -22 && b.lng >= 16 && b.lng <= 33) ? 'where the store is (a point in South Africa)' : null].filter(Boolean) as string[];
    if (missing.length) return bad(400, ...missing);
    if (this.o.stores.some(s => s.client.toLowerCase() === b.client.trim().toLowerCase() && s.name.toLowerCase() === b.name.trim().toLowerCase())) return bad(409, `${b.client} ${b.name} is already a store`);
    const id = `store-${Date.now()}`;
    this.o.stores.push({ id, client: b.client.trim(), name: b.name.trim(), address: b.address?.trim() || null, lat: b.lat, lng: b.lng, geofence_m: 150 });
    return good({ id }, 201);
  }

  store(id: string) { return this.o.stores.find(s => s.id === id); }

  technicians(vehicleOf: (id: string) => string | null) {
    const t = this.today();
    return this.techs().map(p => {
      const mine = this.src.jobs.filter(j => j.card.status !== 'closed' && j.meta.scheduled_date <= t && ((j.meta.lead_id ?? 'me') === p.id || (j.meta.helper_ids ?? []).includes(p.id)));
      return { id: p.id, full_name: p.full_name, department: p.department, open_jobs: mine.length, working_now: mine.filter(j => j.card.status === 'in_progress').length, vehicle: vehicleOf(p.id) };
    });
  }

  flags(status: string) {
    const want = status === 'unresolved' ? ['open', 'explained', 'escalated'] : [status];
    return this.src.flags.filter(f => want.includes(f.status)).map(f => ({ ...f, technician: this.name(f.tech ?? 'me'), job_number: null, department: 'Refrigeration' }))
      .sort((a, b) => b.raised_at.localeCompare(a.raised_at));
  }

  resolve(id: string, note: string): Res {
    const f = this.src.flags.find(x => x.id === id);
    if (!f) return bad(404, 'no such flag');
    if (!note || note.trim().length < 5) return bad(400, 'add a note saying how it was handled');
    if (f.status === 'resolved') return bad(409, 'already resolved');
    Object.assign(f, { status: 'resolved', resolution_note: note.trim() });
    return good({ id, status: 'resolved' });
  }

  inspections(status?: string | null) {
    const all = [...(this.src.myHandover ? [this.src.myHandover] : []), ...this.o.inspections];
    return all.filter(i => !status || i.status === status).sort((a, b) => b.inspected_at.localeCompare(a.inspected_at));
  }

  positions() {
    return {
      positions: Object.entries(POSITION_LABEL).map(([level, label]) => ({ level, label })),
      people: this.o.people.map(p => ({ ...p, department_id: null, position: POSITION_LABEL[p.login_level], does_fleet: p.login_level === 'mechanic' || !!this.src.fleetDuty[p.id] })),
    };
  }

  setPosition(id: string, position: string, by: string): Res {
    const p = this.o.people.find(x => x.id === id);
    if (!p) return bad(404, 'no such user');
    if (!POSITION_LABEL[position]) return bad(400, 'no such position');
    if ((position === 'creator' || p.login_level === 'creator') && by !== 'creator') return bad(403, 'only the Creator can give or take the Creator position');
    if (p.login_level === 'creator' && position !== 'creator' && this.o.people.filter(x => x.login_level === 'creator').length === 1) return bad(409, 'somebody must still be able to manage access');
    const change = `${POSITION_LABEL[p.login_level]} → ${POSITION_LABEL[position]}`;
    p.login_level = position;
    this.o.changes.unshift({ at: new Date().toISOString(), by: this.name('office'), person: p.full_name, action: 'position', change });
    return good({ userId: id, position, label: POSITION_LABEL[position] });
  }

  levelOf(id: string) { return this.o.people.find(p => p.id === id)?.login_level; }
}
