// The demo's pretend office: everything the office screen needs, worked out from the same demo data
// the technician, stock controller and mechanic use, so what one does the office sees.
import type { DemoFleet } from './demoFleet.ts';
import { DEMO_TECHS } from './demoFleet.ts';
import type { DemoWorkshop } from './demoWorkshop.ts';
import type { DemoStockState } from './demoStock.ts';
import { EXAMPLE_TECH, REAL } from './demoReal.ts';

export interface DemoStore {
  id: string; client: string; name: string; address: string | null; lat: number | null; lng: number | null; geofence_m: number;
  /** The map pin (see the server's stores): found by the pretend lookup in the test drive. */
  pin_status?: 'ok' | 'check' | 'looking' | 'not_found'; pin_source?: string; pin_note?: string | null; branch_code?: string | null; phone?: string | null; email?: string | null; looking_since?: number;
}
export interface DemoInspection {
  id: string; vehicle_id: string; registration: string; driver_id: string; driver: string; previous_driver: string | null; inspected_at: string;
  odometer_km: number; fuel_level: string; problems: string[]; new_problems: string[]; handover_by: string; handed_over_by_name: string | null;
  remote_reason: string | null; status: 'signed' | 'awaiting_approval' | 'approved' | 'rejected'; decided_at: string | null; decision_note: string | null;
}
export interface DemoPerson { id: string; full_name: string; login_level: string; department: string; trade?: keyof typeof TRADES | null }
export interface DemoProfile {
  photo_id: string | null; phone: string | null; email: string | null; emergency_name: string | null; emergency_phone: string | null;
  id_number: string | null; date_of_birth: string | null; home_address: string | null; start_date: string | null; notes: string | null;
}
/** Places around the company's area for the test drive's pretend map lookup (the real server asks OpenStreetMap or Google). */
const PLACES: [RegExp, number, number][] = [
  [/arboretum/i, -28.7465, 32.0584], [/meerensee/i, -28.7743, 32.0789], [/alton/i, -28.7395, 32.0201], [/birdswood/i, -28.768, 32.005],
  [/brackenham/i, -28.729, 32.036], [/veldenvlei/i, -28.733, 32.056], [/wildenweide/i, -28.756, 32.033], [/aquadene/i, -28.733, 32.047],
  [/esikhawini/i, -28.8706, 31.9118], [/empangeni/i, -28.7621, 31.8932], [/nseleni/i, -28.693, 32.017], [/mtunzini/i, -28.95, 31.756],
  [/felixton/i, -28.829, 31.887], [/kwambonambi/i, -28.6, 32.084], [/eshowe/i, -28.886, 31.469], [/mtubatuba/i, -28.4167, 32.1833],
  [/st\.? ?lucia/i, -28.3833, 32.4167], [/ulundi/i, -28.33, 31.416], [/durban/i, -29.8587, 31.0218], [/pietermaritzburg/i, -29.6006, 30.3794],
  [/richards ?bay/i, -28.783, 32.038],
];
function pretendLookup(st: { address: string | null; name: string }): Partial<DemoStore> {
  const text = `${st.address ?? ''} ${st.name}`;
  const hit = PLACES.find(([re]) => re.test(text));
  if (!hit) return { pin_status: 'not_found', pin_source: 'lookup', pin_note: st.address ? 'Not found on the map: check the address, or pin it by hand (test drive: pretend map lookup)' : 'No address: add the address, or pin it by hand' };
  // A street number in the address finds the building itself; otherwise only the suburb or town.
  const exact = /\b\d{1,5}\s+[A-Za-z]/.test(st.address ?? '');
  const j = () => (Math.random() - 0.5) * 0.004;
  return { lat: hit[1] + j(), lng: hit[2] + j(), pin_source: 'lookup', pin_status: exact ? 'ok' : 'check',
    pin_note: `Test drive: pretend map lookup${exact ? '' : ' (only the suburb or town was found: check the pin)'}` };
}

const blank = (): DemoProfile => ({ photo_id: null, phone: null, email: null, emergency_name: null, emergency_phone: null, id_number: null, date_of_birth: null, home_address: null, start_date: null, notes: null });
/** Demo contact details: 555 numbers and example.com addresses, so nothing real. */
function seedProfiles(): Record<string, DemoProfile> {
  // Real-data demo: the real phone and email where Servcraft has them, and nothing made up.
  if (REAL) {
    const real = [...Object.entries(REAL.people).map(([id, p]) => ({ id, ...p })), ...REAL.others];
    return Object.fromEntries(real.map(p => [p.id, { ...blank(), phone: p.phone, email: p.email }]));
  }
  const p = (id: string, phone: string, email: string, em: string, emPhone: string, start: string, addr: string): [string, DemoProfile] =>
    [id, { ...blank(), phone, email, emergency_name: em, emergency_phone: emPhone, start_date: start, home_address: addr, date_of_birth: '1990-01-01', id_number: 'DEMO-0000000' }];
  return Object.fromEntries([
    p('office', '072 555 0101', 'lilanie@example.com', 'Demo contact', '072 555 0901', '2015-03-01', '1 Demo Street, Meerensee'),
    p('admin-1', '072 555 0102', 'zanele@example.com', 'Demo contact', '072 555 0902', '2019-07-15', '2 Demo Street, Arboretum'),
    p('mgr-1', '072 555 0103', 'pieter@example.com', 'Demo contact', '072 555 0903', '2017-02-01', '3 Demo Street, Birdswood'),
    p('hr-1', '072 555 0110', 'precious@example.com', 'Demo contact', '072 555 0910', '2019-01-14', '10 Demo Street, Arboretum'),
    p('stock', '072 555 0104', 'lindiwe@example.com', 'Demo contact', '072 555 0904', '2020-05-04', '4 Demo Street, Brackenham'),
    p('mech', '072 555 0105', 'bongani@example.com', 'Demo contact', '072 555 0905', '2018-09-10', '5 Demo Street, Alton'),
    p('me', '072 555 0106', 'thabo@example.com', 'Demo contact', '072 555 0906', '2021-01-11', '6 Demo Street, Esikhawini'),
    p('tech-2', '072 555 0107', 'sipho@example.com', 'Demo contact', '072 555 0907', '2016-04-18', '7 Demo Street, Empangeni'),
    p('tech-3', '072 555 0108', 'ayanda@example.com', 'Demo contact', '072 555 0908', '2022-08-01', '8 Demo Street, Nseleni'),
    p('tech-4', '072 555 0109', null as unknown as string, 'Demo contact', '072 555 0909', '2025-02-03', '9 Demo Street, Veldenvlei'),
  ]);
}

export interface DemoLeaver {
  person: DemoPerson; date: string; reason: string; note: string | null; position: string; department: string | null; by: string;
  onName: { kit: { kind: string; name: string; detail: string | null; qty: number }[]; stock: { code: string; description: string; qty: number }[] };
}
export const END_REASONS: Record<string, string> = { resigned: 'Resigned', dismissed: 'Dismissed', retrenched: 'Retrenched', contract_ended: 'Contract ended', retired: 'Retired', other: 'Other' };
export interface DemoRecord { id: string; employeeId: string; type: string; happenedOn: string; what: string; action: string | null; reason: string | null; author: string; createdAt: string }
export const ENTRY_TYPES: Record<string, string> = {
  observation: 'Issue / note', verbal_warning: 'Verbal warning', written_warning: 'Written warning', final_written_warning: 'Final written warning', commendation: 'Commendation',
};
const WARNINGS = ['verbal_warning', 'written_warning', 'final_written_warning'];
function seedRecords(): DemoRecord[] {
  const d = (n: number) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
  return [
    { id: 'rec-1', employeeId: 'tech-3', type: 'observation', happenedOn: d(40), what: 'Arrived 50 minutes late at Spar Arboretum without phoning the office.', action: null, reason: null, author: 'Lilanie Schallies', createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString() },
    { id: 'rec-2', employeeId: 'tech-3', type: 'verbal_warning', happenedOn: d(12), what: 'Late again at FreshMart Meerensee, the store manager complained.', action: REAL ? 'Verbal warning given in the office, with the department manager present' : 'Verbal warning given in the office, with Pieter present', reason: 'Second late arrival in a month after being spoken to', author: 'Lilanie Schallies', createdAt: new Date(Date.now() - 12 * 86_400_000).toISOString() },
    { id: 'rec-3', employeeId: REAL ? EXAMPLE_TECH : 'me', type: 'commendation', happenedOn: d(20), what: 'Harbour Deli thanked us for fixing the cold room on a Sunday night.', action: null, reason: null, author: 'Lilanie Schallies', createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString() },
  ];
}

export interface DemoOfficeState {
  stores: DemoStore[];
  inspections: DemoInspection[];
  people: DemoPerson[];
  changes: { at: string; by: string; person: string; action: string; change: string }[];
  /** Work the CEO switched on or off per person, over what their position gives. */
  work?: Record<string, Partial<Record<WorkArea, boolean>>>;
  /** People whose employment ended: off every list, kept for HR with the record. */
  leavers?: DemoLeaver[];
  /** Contact and personal details per person (made-up demo numbers). */
  profiles?: Record<string, DemoProfile>;
  /** Staff records: CEO and HR only. */
  records?: DemoRecord[];
  recordDeletions?: { employeeId: string; entryHappenedOn: string; deletedAt: string; deletedBy: string }[];
  jobChanges?: { jobId: string; changed_at: string; by: string; field: string; old_value: string | null; new_value: string | null; reason: string | null }[];
}

export const WORK_AREAS = {
  jobs: 'Jobs: open, assign and edit', documents: 'Quotes and invoices', stores: 'Clients, stores and equipment', stockroom: 'Stockroom (full access)',
  fleet: "Fleet (the mechanic's work)", flags: 'Flags and approvals', prices: 'Prices and rates', access: 'Positions and access (People)',
  hr: 'HR: staff records, and who works in which department', vanstock: 'Van stock lists (bill of quantities)',
  jobcards: 'See every job card (without changing them)', books: "Accounts: supplier invoices and each client's rates and mark-up",
} as const;
/** The positions HR gives and takes; the others stay with the CEO. */
export const HR_POSITIONS = ['technician', 'admin', 'accounts', 'management', 'stockroom'];
export const TRADES = { foodservice: 'Foodservice tech', plumber: 'Plumber', electrician: 'Electrician', assistant: 'Assistant' } as const;
export type WorkArea = keyof typeof WORK_AREAS;
const ALL_WORK = Object.keys(WORK_AREAS) as WorkArea[];
/** What each position does before the CEO changes anything (as on the server). */
const DEFAULT_WORK: Record<string, WorkArea[]> = {
  technician: [], mechanic: ['fleet'], admin: ['jobs', 'documents', 'stores'], accounts: ['jobcards', 'documents', 'books'], stockroom: ['jobs', 'documents', 'stores', 'stockroom'],
  management: ['jobs', 'flags', 'vanstock'], hr: ['hr'], director: ALL_WORK, creator: ALL_WORK,
};

export const POSITION_LABEL: Record<string, string> = {
  technician: 'Technician', mechanic: 'Mechanic (fleet)', admin: 'Admin', accounts: 'Accounts', stockroom: 'Stock controller', management: 'Department manager', hr: 'HR', director: 'Director', creator: 'Creator (CEO)',
};

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

export function seedOffice(): DemoOfficeState {
  return {
    stores: ([
      { id: 'meerensee', client: 'FreshMart', name: 'FreshMart Meerensee', address: 'Meerensee Mall, Richards Bay', lat: -28.7743, lng: 32.0789, geofence_m: 150 },
      { id: 'empangeni', client: 'FreshMart', name: 'FreshMart Empangeni', address: 'Union St, Empangeni', lat: -28.7621, lng: 31.8932, geofence_m: 150 },
      { id: 'harbour', client: 'Harbour Deli', name: 'Harbour Deli, Alton', address: 'Hydrogen Line St, Alton North', lat: -28.7395, lng: 32.0201, geofence_m: 150 },
      { id: 'esikhawini', client: 'Boxer', name: 'Boxer Esikhawini', address: 'Esikhawini Mall', lat: -28.8706, lng: 31.9118, geofence_m: 150 },
      { id: 'arboretum', client: 'Spar', name: 'Spar Arboretum', address: 'Arboretum Centre, Richards Bay', lat: -28.7465, lng: 32.0584, geofence_m: 150 },
    ] as DemoStore[]).map(x => (REAL?.stores[x.id] ? { ...x, ...REAL.stores[x.id] } : x)),
    inspections: [{
      id: 'insp-ayanda', vehicle_id: 'veh-5', registration: 'ND 771-330', driver_id: 'tech-3', driver: 'Ayanda Mthembu', previous_driver: REAL ? null : 'Sipho Ndlovu',
      inspected_at: ago(3), odometer_km: 45120, fuel_level: 'half', problems: ['bodywork'], new_problems: [], handover_by: 'remote_approval', handed_over_by_name: null,
      remote_reason: 'Picked it up at 05:40 from the yard, nobody there to sign', status: 'awaiting_approval', decided_at: null, decision_note: null,
    }],
    people: [
      { id: 'office', full_name: 'Lilanie Schallies', login_level: 'creator', department: 'Office' },
      { id: 'admin-1', full_name: 'Zanele Khoza', login_level: 'admin', department: 'Office' },
      { id: 'mgr-1', full_name: 'Pieter van Wyk', login_level: 'management', department: 'Foodservice' },
      { id: 'hr-1', full_name: 'Precious Ngcobo', login_level: 'hr', department: 'Office' },
      { id: 'stock', full_name: 'Lindiwe Zulu', login_level: 'stockroom', department: 'Stores' },
      { id: 'mech', full_name: 'Bongani Khumalo', login_level: 'mechanic', department: 'Workshop' },
      ...DEMO_TECHS.map(t => ({ id: t.id, full_name: t.full_name, login_level: 'technician', department: 'Foodservice',
        trade: ({ me: 'foodservice', 'tech-2': 'electrician', 'tech-3': 'plumber', 'tech-4': 'assistant' } as const)[t.id as 'me'] ?? null })),
      // Real-data demo: the rest of the staff, as technicians without a department yet.
      ...(REAL?.others ?? []).map(o => ({ id: o.id, full_name: o.name, login_level: 'technician', department: '', trade: null })),
    ],
    changes: [],
    profiles: seedProfiles(),
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
    const open = jobs.filter(j => j.card.status !== 'closed' && j.card.status !== 'cancelled');
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
      cancelled_by_party: (j.meta as { cancelled_by_party?: string | null }).cancelled_by_party ?? null, cancel_note: (j.meta as { cancel_note?: string | null }).cancel_note ?? null,
    })).sort((a, b) => Number(a.status === 'closed' || a.status === 'cancelled') - Number(b.status === 'closed' || b.status === 'cancelled') || a.scheduled_date.localeCompare(b.scheduled_date) || a.job_number - b.job_number);
  }

  stores() {
    // The test drive's pretend map lookup: a store waiting a few seconds is "found".
    for (const st of this.o.stores) if (st.pin_status === 'looking' && Date.now() - (st.looking_since ?? 0) > 2500) Object.assign(st, pretendLookup(st));
    return this.o.stores.map(s => ({ ...s, branch_code: s.branch_code ?? null, pin_status: s.pin_status ?? 'ok', pin_source: s.pin_source ?? 'manual', pin_note: s.pin_note ?? null, equipment: 0,
      open_jobs: this.src.jobs.filter(j => j.meta.store === s.name && j.card.status !== 'closed' && j.card.status !== 'cancelled').length }))
      .sort((a, b) => a.client.localeCompare(b.client) || a.name.localeCompare(b.name));
  }

  addStore(b: { client: string; name: string; address?: string; lat?: number; lng?: number }): Res {
    const pinned = b.lat !== undefined && b.lat !== null;
    const missing = [!b.client || b.client.trim().length < 2 ? 'client name' : null, !b.name || b.name.trim().length < 2 ? 'store name' : null,
      pinned && !(b.lat! >= -35 && b.lat! <= -22 && b.lng! >= 16 && b.lng! <= 33) ? 'that point is not in South Africa' : null,
      !pinned && !b.address?.trim() ? 'the address (the app finds it on the map), or the map point' : null].filter(Boolean) as string[];
    if (missing.length) return bad(400, ...missing);
    if (this.o.stores.some(s => s.client.toLowerCase() === b.client.trim().toLowerCase() && s.name.toLowerCase() === b.name.trim().toLowerCase())) return bad(409, `${b.client} ${b.name} is already a store`);
    const id = `store-${Date.now()}`;
    this.o.stores.push({ id, client: b.client.trim(), name: b.name.trim(), address: b.address?.trim() || null, lat: pinned ? b.lat! : null, lng: pinned ? b.lng! : null, geofence_m: 150,
      pin_status: pinned ? 'ok' : 'looking', pin_source: pinned ? 'manual' : 'none', looking_since: Date.now() });
    return good({ id, pinStatus: pinned ? 'ok' : 'looking' }, 201);
  }

  editStore(id: string, b: { name?: string; address?: string; branchCode?: string; phone?: string; email?: string; lat?: number; lng?: number }): Res {
    const st = this.o.stores.find(x => x.id === id);
    if (!st) return bad(404, 'no such store');
    if (b.lat !== undefined && !(b.lat >= -35 && b.lat <= -22 && b.lng! >= 16 && b.lng! <= 33)) return bad(400, 'that is not in South Africa');
    if (b.name?.trim()) st.name = b.name.trim();
    if (b.branchCode !== undefined) st.branch_code = b.branchCode || null;
    if (b.phone !== undefined) st.phone = b.phone || null;
    if (b.email !== undefined) st.email = b.email || null;
    const moved = b.address !== undefined && (b.address || null) !== st.address;
    if (b.address !== undefined) st.address = b.address || null;
    if (b.lat !== undefined) Object.assign(st, { lat: b.lat, lng: b.lng, pin_source: 'manual', pin_status: 'ok', pin_note: 'Pinned by hand' });
    else if (moved && st.pin_source !== 'manual') Object.assign(st, { pin_status: 'looking', looking_since: Date.now(), pin_note: 'New address: looking it up' });
    return good({ id, pin_status: st.pin_status ?? 'ok' });
  }

  pin(id: string, action: 'confirm' | 'lookup', by: string): Res {
    const st = this.o.stores.find(x => x.id === id);
    if (!st) return bad(404, 'no such store');
    if (action === 'confirm') { if (st.lat == null) return bad(409, 'there is no pin to confirm yet'); Object.assign(st, { pin_status: 'ok', pin_note: `Checked by ${by}` }); }
    else Object.assign(st, { pin_status: 'looking', looking_since: Date.now(), pin_note: 'Looking it up again' });
    return good({ id, pin_status: st.pin_status });
  }

  /** Customers and sites from an uploaded list (the rows already read). */
  importRows(rows: { client: string; store: string; address: string | null; branchCode: string | null; phone: string | null; email: string | null; lat: number | null; lng: number | null }[]) {
    const r = { customersNew: 0, customersUpdated: 0, sitesNew: 0, sitesUpdated: 0, toFind: 0, pinnedFromFile: 0 };
    const seen = new Set<string>();
    for (const x of rows) {
      const c = x.client.toLowerCase();
      if (!seen.has(c)) { seen.add(c); if (this.o.stores.some(s => s.client.toLowerCase() === c)) r.customersUpdated++; else r.customersNew++; }
      const st = this.o.stores.find(s => s.client.toLowerCase() === c && s.name.toLowerCase() === x.store.toLowerCase());
      if (st) {
        if (x.address && x.address !== st.address && st.pin_source !== 'manual' && x.lat === null) Object.assign(st, { address: x.address, pin_status: 'looking', looking_since: Date.now() });
        else if (x.address && !st.address) st.address = x.address;
        st.branch_code ??= x.branchCode; st.phone ??= x.phone; st.email ??= x.email;
        r.sitesUpdated++;
      } else {
        this.o.stores.push({ id: `store-${Date.now()}-${r.sitesNew}`, client: x.client, name: x.store, address: x.address, lat: x.lat, lng: x.lng, geofence_m: 150,
          branch_code: x.branchCode, phone: x.phone, email: x.email, pin_status: x.lat !== null ? 'ok' : 'looking', pin_source: x.lat !== null ? 'import' : 'none',
          pin_note: x.lat !== null ? 'From the imported file' : null, looking_since: Date.now() });
        r.sitesNew++;
      }
      if (x.lat !== null) r.pinnedFromFile++;
    }
    r.toFind = this.o.stores.filter(s => s.pin_status === 'looking').length;
    return r;
  }

  store(id: string) { return this.o.stores.find(s => s.id === id); }

  technicians(vehicleOf: (id: string) => string | null) {
    const t = this.today();
    return this.techs().map(p => {
      const mine = this.src.jobs.filter(j => j.card.status !== 'closed' && j.card.status !== 'cancelled' && j.meta.scheduled_date <= t && ((j.meta.lead_id ?? 'me') === p.id || (j.meta.helper_ids ?? []).includes(p.id)));
      return { id: p.id, full_name: p.full_name, department: p.department, open_jobs: mine.length, working_now: mine.filter(j => j.card.status === 'in_progress').length, vehicle: vehicleOf(p.id) };
    });
  }

  flags(status: string) {
    const want = status === 'unresolved' ? ['open', 'explained', 'escalated'] : [status];
    return this.src.flags.filter(f => want.includes(f.status)).map(f => ({ ...f, technician: this.name(f.tech ?? 'me'), job_number: null, department: 'Foodservice' }))
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
      areas: Object.entries(WORK_AREAS).map(([key, label]) => ({ key, label })),
      people: this.o.people.map(p => ({ ...p, department_id: null, position: POSITION_LABEL[p.login_level], does_fleet: p.login_level === 'mechanic' || this.workOf(p.id).fleet, work: this.workOf(p.id) })),
    };
  }

  setPosition(id: string, position: string, by: string, full = true, me?: string): Res {
    const p = this.o.people.find(x => x.id === id);
    if (!p) return bad(404, 'no such user');
    if (!POSITION_LABEL[position]) return bad(400, 'no such position');
    if (!full && (!HR_POSITIONS.includes(p.login_level) || !HR_POSITIONS.includes(position))) return bad(403, "HR sets technician, admin, department manager or stock controller; the other positions are the CEO's");
    if (!full && id === me) return bad(403, 'you cannot change your own position');
    if ((position === 'creator' || p.login_level === 'creator') && by !== 'creator') return bad(403, 'only the Creator can give or take the Creator position');
    if (p.login_level === 'creator' && position !== 'creator' && this.o.people.filter(x => x.login_level === 'creator').length === 1) return bad(409, 'somebody must still be able to manage access');
    const change = `${POSITION_LABEL[p.login_level]} → ${POSITION_LABEL[position]}`;
    p.login_level = position;
    this.o.changes.unshift({ at: new Date().toISOString(), by: this.name('office'), person: p.full_name, action: 'position', change });
    return good({ userId: id, position, label: POSITION_LABEL[position] });
  }

  people(canManage: boolean, setsPositions = canManage) {
    return {
      canManage, canSetPositions: setsPositions, settablePositions: canManage ? Object.keys(POSITION_LABEL) : setsPositions ? HR_POSITIONS : [],
      positions: Object.entries(POSITION_LABEL).map(([level, label]) => ({ level, label })),
      trades: Object.entries(TRADES).map(([key, label]) => ({ key, label })),
      areas: Object.entries(WORK_AREAS).map(([key, label]) => ({ key, label })),
      people: this.o.people.map(p => ({ ...p, position: POSITION_LABEL[p.login_level], tradeLabel: p.trade ? TRADES[p.trade] : null, work: this.workOf(p.id) }))
        .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    };
  }

  /** What the stockroom may see of people: names, position, trade, picture. Nothing personal. */
  stockroomPeople() {
    return this.o.people.map(p => ({ id: p.id, full_name: p.full_name, login_level: p.login_level, position: POSITION_LABEL[p.login_level], tradeLabel: p.trade ? TRADES[p.trade] : null, photo_id: this.profiles()[p.id]?.photo_id ?? null }));
  }

  private profiles() { return this.o.profiles ?? (this.o.profiles = seedProfiles()); }

  /** One person's profile; `crew` says who is in which vehicle, `spot` where a vehicle is. */
  profile(id: string, canEdit: boolean, flags: { record: { read: boolean; write: boolean }; kit: { read: boolean; write: boolean } }, crew: { id: string; full_name: string; vehicle_id: string | null; registration: string | null; mode: 'driving' | 'riding_along' | null }[],
    spot: (vehicleId: string) => { lat: number | null; lng: number | null; speed_kmh: number | null; ignition: boolean | null; minutesAgo: number | null } | null): Res {
    const left = this.o.leavers?.find(l => l.person.id === id);
    const p = this.o.people.find(x => x.id === id) ?? left?.person;
    if (!p) return bad(404, 'no such person');
    const f = { ...blank(), ...this.profiles()[id] };
    const mine = left ? undefined : crew.find(c => c.id === id);
    const open = this.src.jobs.filter(j => !['closed', 'cancelled'].includes(j.card.status) && ((j.meta.lead_id ?? 'me') === id || (j.meta.helper_ids ?? []).includes(id)));
    const rank = (st: string) => (st === 'in_progress' ? 0 : st === 'continue_later' ? 1 : 2);
    const j = open.sort((a, b) => rank(a.card.status) - rank(b.card.status) || a.meta.scheduled_date.localeCompare(b.meta.scheduled_date))[0];
    const withIds = new Set<string>();
    if (mine?.vehicle_id) crew.filter(c => c.vehicle_id === mine.vehicle_id && c.id !== id).forEach(c => withIds.add(c.id));
    if (j) [j.meta.lead_id ?? 'me', ...(j.meta.helper_ids ?? [])].filter(x => x !== id).forEach(x => withIds.add(x));
    let location = null;
    const store = j ? this.o.stores.find(s => s.name === j.meta.store) : undefined;
    if (j?.card.status === 'in_progress' && store) location = { source: 'on site', lat: store.lat, lng: store.lng, moving: false, speedKmh: null, minutesAgo: 0 };
    else if (mine?.vehicle_id) {
      const v = spot(mine.vehicle_id);
      if (v && v.lat != null && v.lng != null) location = { source: 'vehicle tracker', lat: v.lat, lng: v.lng, moving: !!v.ignition, speedKmh: v.speed_kmh, minutesAgo: v.minutesAgo };
    }
    const since = new Date(Date.now() - 2 * 3_600_000).toISOString();
    return good({
      id, full_name: p.full_name, position: POSITION_LABEL[p.login_level], login_level: p.login_level, tradeLabel: p.trade ? TRADES[p.trade] : null, department: p.department, photo_id: f.photo_id,
      now: {
        vehicle: mine?.vehicle_id && mine.registration ? { registration: mine.registration, mode: mine.mode ?? 'driving', since } : null,
        job: j ? { id: j.meta.id, number: j.meta.job_number, status: j.card.status, store: j.meta.store, fault: j.meta.fault_reported, lead: (j.meta.lead_id ?? 'me') === id, startedAt: null } : null,
        with: [...withIds].map(x => this.name(x)),
        location,
      },
      contact: { phone: f.phone, email: f.email, emergency_name: f.emergency_name, emergency_phone: f.emergency_phone },
      personal: canEdit ? { id_number: f.id_number, date_of_birth: f.date_of_birth, home_address: f.home_address, start_date: f.start_date, notes: f.notes } : null,
      canEdit, ...flags,
    });
  }

  private recs() { return this.o.records ?? (this.o.records = seedRecords()); }
  record(id: string, canWrite: boolean): Res {
    const left = (this.o.leavers ?? []).some(l => l.person.id === id);
    if (!this.o.people.some(p => p.id === id) && !left) return bad(404, 'no such person');
    if (left) canWrite = false;
    const entries = this.recs().filter(r => r.employeeId === id).sort((a, b) => b.happenedOn.localeCompare(a.happenedOn) || b.createdAt.localeCompare(a.createdAt))
      .map(r => ({ id: r.id, entry_type: r.type, typeLabel: ENTRY_TYPES[r.type] ?? r.type, happened_on: r.happenedOn, what_happened: r.what, action_taken: r.action, reason: r.reason, corrects_entry_id: null, job_number: null, author: r.author, created_at: r.createdAt }));
    const n = (t: string) => entries.filter(e => e.entry_type === t).length;
    return good({
      canWrite, types: Object.entries(ENTRY_TYPES).map(([key, label]) => ({ key, label, warning: WARNINGS.includes(key) })),
      summary: { issues: n('observation'), verbal: n('verbal_warning'), written: n('written_warning'), final: n('final_written_warning'), commendations: n('commendation') },
      entries, deletions: (this.o.recordDeletions ?? []).filter(d => d.employeeId === id).map(d => ({ entry_happened_on: d.entryHappenedOn, deleted_at: d.deletedAt, deleted_by: d.deletedBy })),
    });
  }
  addRecord(id: string, by: string, b: { type: string; happenedOn?: string; whatHappened?: string; actionTaken?: string; reason?: string }): Res {
    if (!this.o.people.some(p => p.id === id)) return bad(404, 'no such person');
    if (!ENTRY_TYPES[b.type]) return bad(400, 'which kind of record');
    const miss: string[] = [];
    if (!b.whatHappened || b.whatHappened.trim().length < 5) miss.push('say what happened');
    if (WARNINGS.includes(b.type)) {
      if (!b.actionTaken || b.actionTaken.trim().length < 3) miss.push('the action taken (a warning must say what was done)');
      if (!b.reason || b.reason.trim().length < 3) miss.push('the reason for the warning');
    }
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
    if (b.happenedOn && !/^\d{4}-\d{2}-\d{2}$/.test(b.happenedOn)) miss.push('the date like 2026-10-12');
    else if (b.happenedOn && b.happenedOn > today) miss.push('a date that is not in the future');
    if (miss.length) return bad(400, ...miss);
    const rec: DemoRecord = { id: `rec-${Date.now()}`, employeeId: id, type: b.type, happenedOn: b.happenedOn || today, what: b.whatHappened!.trim(), action: b.actionTaken?.trim() || null, reason: b.reason?.trim() || null, author: this.name(by), createdAt: new Date().toISOString() };
    this.recs().push(rec);
    return good({ id: rec.id });
  }
  deleteRecord(id: string, entryId: string, by: string): Res {
    const r = this.recs().find(x => x.id === entryId && x.employeeId === id);
    if (!r) return bad(404, 'no such record');
    this.o.records = this.recs().filter(x => x !== r);
    (this.o.recordDeletions ??= []).unshift({ employeeId: id, entryHappenedOn: r.happenedOn, deletedAt: new Date().toISOString(), deletedBy: this.name(by) });
    return good({ deleted: 1 });
  }

  saveProfile(id: string, b: Record<string, string | null | undefined>): Res {
    const p = this.o.people.find(x => x.id === id);
    if (!p) return bad(404, 'no such person');
    const f = (this.profiles()[id] ??= blank());
    const map: Record<string, keyof DemoProfile> = { phone: 'phone', email: 'email', emergencyName: 'emergency_name', emergencyPhone: 'emergency_phone', idNumber: 'id_number',
      dateOfBirth: 'date_of_birth', homeAddress: 'home_address', startDate: 'start_date', notes: 'notes', photoId: 'photo_id' };
    for (const k of ['dateOfBirth', 'startDate']) if (b[k] && !/^\d{4}-\d{2}-\d{2}$/.test(b[k]!)) return bad(400, `${k === 'dateOfBirth' ? 'date of birth' : 'start date'} must look like 2021-03-31`);
    if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) return bad(400, 'that email address does not look right');
    if (b.email && Object.entries(this.profiles()).some(([k, v]) => k !== id && (v.email ?? '').toLowerCase() === b.email!.toLowerCase())) return bad(409, 'that email is already someone else\'s sign-in: use another one');
    for (const [k, col] of Object.entries(map)) if (k in b) (f as unknown as Record<string, string | null>)[col] = b[k] === '' ? null : (b[k] ?? null);
    this.o.changes.unshift({ at: new Date().toISOString(), by: this.name('office'), person: p.full_name, action: 'profile', change: 'Profile details updated' });
    return good({ userId: id });
  }

  /** HR or the CEO adds a person (no login until they get a setup code). `full`: the CEO, who adds any position. */
  addPerson(b: { fullName?: string; email?: string; phone?: string; position?: string; trade?: string | null }, full: boolean, creator: boolean, department: string): Res {
    const name = (b.fullName ?? '').trim();
    if (name.length < 3) return bad(400, 'their full name');
    if (!b.position || !POSITION_LABEL[b.position]) return bad(400, 'their position');
    if (!full && !HR_POSITIONS.includes(b.position)) return bad(403, "HR adds technicians, admin, department managers and stock controllers; the other positions are the CEO's");
    if (b.position === 'creator' && !creator) return bad(403, 'only the Creator adds another Creator');
    if (this.o.people.some(p => p.full_name.toLowerCase() === name.toLowerCase())) return bad(409, `${name} is already under People`);
    const email = (b.email ?? '').trim().toLowerCase() || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(400, 'a valid email');
    if (email && Object.values(this.profiles()).some(v => (v.email ?? '').toLowerCase() === email)) return bad(409, "that email is already someone else's");
    const id = `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    this.o.people.push({ id, full_name: name, login_level: b.position, department, trade: b.position === 'technician' && b.trade && b.trade in TRADES ? b.trade as keyof typeof TRADES : null });
    this.profiles()[id] = { ...blank(), email, phone: (b.phone ?? '').trim() || null, start_date: new Date().toISOString().slice(0, 10) };
    this.o.changes.unshift({ at: new Date().toISOString(), by: this.name('office'), person: name, action: 'added', change: `Added as ${POSITION_LABEL[b.position]}` });
    return good({ id, full_name: name, position: POSITION_LABEL[b.position] });
  }

  /** Name, position, email and phone of everyone (for the logins). */
  loginPeople() {
    return this.o.people.map(p => ({ id: p.id, full_name: p.full_name, login_level: p.login_level, email: this.profiles()[p.id]?.email ?? null, phone: this.profiles()[p.id]?.phone ?? null }));
  }

  setTrade(id: string, trade: keyof typeof TRADES | null): Res {
    const p = this.o.people.find(x => x.id === id);
    if (!p) return bad(404, 'no such user');
    if (p.login_level !== 'technician') return bad(409, 'only technicians have a trade');
    if (trade && !TRADES[trade]) return bad(400, 'no such trade');
    const change = `Trade: ${p.trade ? TRADES[p.trade] : 'none'} → ${trade ? TRADES[trade] : 'none'}`;
    p.trade = trade;
    this.o.changes.unshift({ at: new Date().toISOString(), by: this.name('office'), person: p.full_name, action: 'trade', change });
    return good({ userId: id, trade });
  }

  levelOf(id: string) { return this.o.people.find(p => p.id === id)?.login_level; }

  workOf(id: string, level?: string): Record<WorkArea, boolean> {
    const lv = this.levelOf(id) ?? level ?? 'technician';
    const over = this.o.work?.[id] ?? {};
    const legacyFleet = this.src.fleetDuty[id];
    return Object.fromEntries(ALL_WORK.map(a => [a, lv === 'creator' ? true : over[a] ?? (a === 'fleet' && legacyFleet !== undefined ? legacyFleet : (DEFAULT_WORK[lv] ?? []).includes(a))])) as Record<WorkArea, boolean>;
  }

  setWork(id: string, area: WorkArea, on: boolean): Res {
    const p = this.o.people.find(x => x.id === id);
    if (!p) return bad(404, 'no such user');
    if (!WORK_AREAS[area]) return bad(400, 'no such kind of work');
    if (p.login_level === 'creator') return bad(409, 'the CEO always has full access');
    this.o.work = { ...this.o.work, [id]: { ...this.o.work?.[id], [area]: on } };
    if (area === 'fleet') this.src.fleetDuty[id] = on;
    this.o.changes.unshift({ at: new Date().toISOString(), by: this.name('office'), person: p.full_name, action: `work:${area}`, change: `${WORK_AREAS[area]}: ${on ? 'on' : 'off'}` });
    return good({ userId: id, area, on, work: this.workOf(id) });
  }
}

export function terminate(o: DemoOfficeState, id: string, b: { date?: string; reason?: string; note?: string }, by: string, openJobs: number[],
  onName: DemoLeaver['onName'], department: string | null): { ok: true; body: unknown } | { ok: false; status: number; reasons: string[] } {
  const p = o.people.find(x => x.id === id);
  if (!p) return (o.leavers ?? []).some(l => l.person.id === id) ? { ok: false, status: 409, reasons: ['already with the terminated staff'] } : { ok: false, status: 404, reasons: ['no such person'] };
  if (['director', 'creator'].includes(p.login_level)) return { ok: false, status: 403, reasons: ["the CEO's position is not ended here"] };
  if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return { ok: false, status: 400, reasons: ['the last day'] };
  if (!b.reason || !END_REASONS[b.reason]) return { ok: false, status: 400, reasons: ['why the employment ended'] };
  if (b.reason === 'other' && (!b.note || b.note.trim().length < 3)) return { ok: false, status: 400, reasons: ['say what the reason is'] };
  if (openJobs.length) return { ok: false, status: 409, reasons: [`give ${p.full_name.split(' ')[0]}'s open jobs to someone else first: ${openJobs.map(n => `#${n}`).join(', ')}`] };
  o.people = o.people.filter(x => x.id !== id);
  (o.leavers ??= []).unshift({ person: p, date: b.date, reason: b.reason, note: b.note?.trim() || null, position: POSITION_LABEL[p.login_level], department, by, onName });
  o.changes.unshift({ at: new Date().toISOString(), by, person: p.full_name, action: 'terminated', change: `Employment ended ${b.date}: ${END_REASONS[b.reason]}` });
  return { ok: true, body: { id, status: 'left', onName } };
}
