// A pretend server inside the app, so the app can be tried without the office server.
// It answers the same requests as the real one and uses the same rules engine, so what you
// feel in demo mode is what the technicians will get. Data is invented.
import { DemoWorkshop, seedWorkshop, type DemoWorkshopState } from './demoWorkshop.ts';
import { DemoDocs, seedDocs, type DemoDocsState } from './demoDocs.ts';
import { DemoVan, seedVan, type DemoVanState } from './demoVan.ts';
import { DemoTimes, type DemoTimesState } from './demoTimes.ts';
import { DemoTools, seedTools, type DemoToolsState } from './demoTools.ts';
import { DEMO_LOGO } from './demoLogo.ts';
import { EXAMPLE_TECH, REAL, realDeep } from './demoReal.ts';
import { APP_OF, MAX_PINNED, MENU_LABEL, MENU_LEVELS, MENU_TABS, cleanPinned, usualTabs } from '../../server/src/core/phoneMenu.ts';
import type { LoginLevel } from '../../server/src/core/permissions.ts';
import { DemoOffice, END_REASONS, HR_POSITIONS, POSITION_LABEL, seedOffice, terminate, type DemoInspection, type DemoOfficeState, type DemoStore } from './demoOffice.ts';
import { DemoLogins, type DemoLoginsState } from './demoLogins.ts';
import { DemoBreakdowns, seedBreakdowns, type DemoBdState } from './demoBreakdowns.ts';
import { NO_CHARGE_REASONS } from '../../server/src/core/jobOutcome.ts';
import { FIELDS as CUSTOMER_FIELDS, guessMapping, parseCsv, splitHeader, toCustomers } from '../../server/src/core/customerSheet.ts';
import * as J from '../../server/src/core/jobCard.ts';
import * as H from '../../server/src/core/handover.ts';
import { normReg, registrationCandidates } from '../../server/src/core/vehicleCode.ts';
import { DemoStock, seedStock, type DemoStockState } from './demoStock.ts';
import { DemoSuppliers, seedSuppliers, type DemoSupplierState } from './demoSuppliers.ts';
import * as CR from '../../server/src/core/clientRates.ts';
import { DemoFleet, seedFleet, type DemoFleetState } from './demoFleet.ts';
import { Offline, type Request, type Response, type Transport } from './transport.ts';
import type { CardView, Flag, LoanMachine, MachineMove, StockLine, Today, TodayJob, Workshop } from './types.ts';

interface DemoJob {
  meta: Omit<CardView, 'visits' | 'currentState' | 'jobMinutes' | 'items' | 'status'> & { i_am_lead: boolean; lead_id?: string; helper_ids?: string[] };
  card: J.JobCard;
  checklistIds: string[];
  /** Workshop repairs: the machine's moves on this job. */
  moves?: MachineMove[];
}

interface DemoRepairs { workshop: Workshop; loans: Omit<LoanMachine, 'out'>[] }

export interface DemoState {
  acknowledged: boolean;
  jobs: DemoJob[];
  stock: StockLine[];
  flags: Flag[];
  vehicle: Today['vehicle'];
  photos: number;
  /** Sizes of the photos sent in the test drive (for the CEO's storage figures). */
  photoSizes?: { kind: string; bytes: number; at: string }[];
  /** The demo van: who drove it last and what the last handover recorded. */
  van?: { lastDriverMe: boolean; odometerKm: number; problems: H.CheckKey[] };
  stockControl?: DemoStockState;
  vanStock?: DemoVanState;
  times?: DemoTimesState;
  /** A logo the CEO uploaded in the demo, instead of the ZSP one. */
  logoPhotoId?: string;
  /** Tabs pinned to the bottom of the phone, per position (Settings → Phone menus). */
  phoneMenus?: Record<string, string[]>;
  /** Parts reports (technicians on site), their emails, and the company letterhead. */
  reports?: { id: string; report_number: number; job_id: string; visit_start: string; created_at: string; created_by: string; created_by_name: string; machine_photo_id: string; serial_photo_id: string;
    serial_text: string | null; part_photo_id: string; part_description: string; part_qty: number; extra_photo_ids: string[]; notes: string | null; quote_id: string | null; quote_number: number | null }[];
  reportEmails?: { report_id: string; sent_to: string[]; sent_at: string; ok: boolean; error: string | null; sent_by: string }[];
  letterhead?: { headerPhotoId: string | null; footerPhotoId: string | null };
  /** The company's colour theme (the director's choice). */
  themeAccent?: 'orange' | 'blue' | 'green';
  fleet?: DemoFleetState;
  who?: { id: string; name: string; level: string };
  fuel: { litres: number; at: string }[];
  /** People given the mechanic's work on top of their own position (by the CEO). */
  fleetDuty?: Record<string, boolean>;
  workshop?: DemoWorkshopState;
  repairs?: DemoRepairs;
  toolStore?: DemoToolsState;
  office?: DemoOfficeState;
  /** Own logins: setup codes and the passwords people chose (this browser only). */
  logins?: DemoLoginsState;
  /** The Breakdowns queue: emails and WhatsApp group messages (pretend). */
  breakdowns?: DemoBdState;
  /** Customer lists uploaded in the test drive, until brought in. */
  customerImports?: Record<string, { headers: string[]; rows: string[][]; applied: boolean }>;
  docs?: DemoDocsState;
  /** Accounts: supplier invoices (the office's scans, checks of the slips, supplier Pastel codes). */
  suppliers?: DemoSupplierState;
  queries?: { id: string; from: string; to: string; job_id: string | null; subject: string; created_at: string; read: Record<string, string>; messages: { id: string; from: string; body: string; at: string }[] }[];
}

const STORES = {
  meerensee: { name: 'FreshMart Meerensee', address: 'Meerensee Mall, Richards Bay', lat: -28.7743, lng: 32.0789 },
  empangeni: { name: 'FreshMart Empangeni', address: 'Union St, Empangeni', lat: -28.7621, lng: 31.8932 },
  harbour: { name: 'Harbour Deli, Alton', address: 'Hydrogen Line St, Alton North', lat: -28.7395, lng: 32.0201 },
};

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const yesterday = () => new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
let seq = 0;
const id = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function job(n: number, type: J.JobType, priority: string, storeKey: keyof typeof STORES, fault: string, equipment: CardView['equipment'], extra: Partial<DemoJob['meta']> = {}): DemoJob {
  const s = { ...STORES[storeKey], ...(REAL?.stores[storeKey] ?? {}) };
  return {
    meta: {
      id: `job-${n}`, job_number: n, job_type: type, priority, fault_reported: fault, scheduled_date: today(),
      client_order_ref: `PO-${n + 4000}`, store_id: storeKey, store: s.name, store_address: s.address,
      store_lat: s.lat, store_lng: s.lng, geofence_m: 150, lead_technician: 'Thabo Mkhize', manager_name: null,
      checklist: [], equipment, storeManagers: ['Sipho Dube', 'Thandi Mthembu'], i_am_lead: true, ...extra,
    },
    card: {
      jobType: type, status: 'assigned', store: { lat: s.lat, lng: s.lng, geofenceM: 150 }, visits: [],
      items: [{ id: `item-${n}-1`, title: fault, origin: 'reported', beforePhotos: 0, afterPhotos: 0, vanStockLines: 0, boughtOutLines: 0, noMaterials: false }],
    },
    checklistIds: [],
  };
}

function officeJob(n: number, type: J.JobType, priority: string, s: DemoStore, fault: string, lead: { id: string; name: string }, date: string, helpers: string[] = [], ref?: string): DemoJob {
  return {
    meta: {
      id: `job-${n}`, job_number: n, job_type: type, priority, fault_reported: fault, scheduled_date: date, client_order_ref: ref ?? null,
      store_id: s.id, store: s.name, store_address: s.address, store_lat: s.lat as number, store_lng: s.lng as number, geofence_m: s.geofence_m,
      lead_technician: lead.name, manager_name: null, checklist: [], equipment: [], storeManagers: [], i_am_lead: lead.id === 'me', lead_id: lead.id, helper_ids: helpers,
    },
    card: {
      jobType: type, status: 'assigned', store: { lat: s.lat as number, lng: s.lng as number, geofenceM: s.geofence_m }, visits: [],
      items: [{ id: `item-${n}-1`, title: fault.slice(0, 200), origin: 'reported', beforePhotos: 0, afterPhotos: 0, vanStockLines: 0, boughtOutLines: 0, noMaterials: false }],
    },
    checklistIds: [],
  };
}

export function seedDemo(): DemoState {
  const ice = job(10231, 'breakdown', 'urgent', 'meerensee', 'Ice machine not dispensing', [
    { id: 'eq-1', brand: 'Scotsman', model: 'AC 86', serial: 'SC86-22918', description: 'Ice machine (bakery)' },
    { id: 'eq-2', brand: 'Rational', model: 'iCombi Pro 10-1/1', serial: 'RT-77120', description: 'Combi oven 1' },
  ]);
  const pm = job(10233, 'planned_maintenance', 'scheduled', 'empangeni', 'Quarterly service: 3 combi ovens', [
    { id: 'eq-3', brand: 'Rational', model: 'iCombi Pro 6-1/1', serial: 'RT-55102', description: 'Combi oven A' },
  ]);
  pm.meta.checklist = [
    { id: 'chk-1', step: '1. Descale steam generator', done: false },
    { id: 'chk-2', step: '2. Check door seals', done: false },
    { id: 'chk-3', step: '3. Clean fan and filters', done: false },
    { id: 'chk-4', step: '4. Test run on all modes', done: false },
  ];
  const cold = job(10228, 'breakdown', 'normal', 'harbour', 'Cold room not holding temperature', [
    { id: 'eq-4', brand: 'Macadams', model: 'CR-3000', serial: 'MC-30019', description: 'Walk-in cold room' },
  ], { scheduled_date: yesterday() });
  cold.card.status = 'continue_later';
  const y = yesterday();
  cold.card.visits = [{
    state: 'continue_later', goAt: `${y}T13:05:00+02:00`, arrivedAt: `${y}T13:31:00+02:00`, checkedInManager: 'Sipho Dube',
    safetyCheck: { areaSafe: true, isolated: true, publicClear: true }, startedAt: `${y}T13:35:00+02:00`, endedAt: `${y}T16:10:00+02:00`, pauses: [],
  }];
  cold.card.items[0] = { ...cold.card.items[0], equipmentId: 'eq-4', beforePhotos: 2, faultType: 'refrigeration', found: 'Compressor short-cycling, low on gas, slow leak at the condenser', noMaterials: false };
  return {
    acknowledged: false,
    jobs: [ice, pm, cold],
    stock: [
      { id: 'st-1', code: 'VALVE-01', description: 'Water inlet valve 24V', unit: 'each', qty: 2 },
      { id: 'st-2', code: 'SEAL-04', description: 'Oven door seal 1/1', unit: 'each', qty: 3 },
      { id: 'st-3', code: 'GAS-R404', description: 'Refrigerant R404A', unit: 'kg', qty: 4 },
      { id: 'st-4', code: 'FUSE-10A', description: 'Fuse 10A', unit: 'each', qty: 10 },
    ],
    flags: [{
      id: 'flag-1', flag_type: 'slow_to_site', severity: 'normal', raised_at: `${y}T14:12:00+02:00`, status: 'open',
      question: 'Your trip to Harbour Deli took 64 minutes; it normally takes 22. What happened?', explanation: null,
      details: { overBy: 42, stoppedMinutes: 31 }, ...(REAL ? { tech: EXAMPLE_TECH } : {}),
    }],
    vehicle: null,
    photos: 0,
    stockControl: seedStock(),
    van: { lastDriverMe: false, odometerKm: 87450, problems: ['windscreen_mirrors'] },
    fuel: [],
  };
}

const ok = (body: unknown, status = 200): Response => ({ status, body });
const refuse = (status: number, ...reasons: string[]): Response => ({ status, body: { error: 'refused', reasons } });

export class DemoTransport implements Transport {
  /** When true, behaves like a phone without signal. */
  noSignal = false;
  /** Who is signed in to the demo right now (technician, stock controller or mechanic); kept with the demo data so a reload remembers. */
  get who() { return this.state.who ?? { id: 'me', name: 'Thabo Mkhize', level: 'technician' }; }
  set who(w) { this.state.who = w; this.persist(this.state); }

  constructor(public state: DemoState, private persist: (s: DemoState) => void) {}

  private view(j: DemoJob): CardView {
    const c = j.card;
    return {
      ...j.meta,
      status: c.status,
      visits: c.visits,
      currentState: c.visits.at(-1)?.state ?? 'not_started',
      jobMinutes: J.jobMinutes(c),
      items: c.items.map(it => ({ ...it, status: J.itemStatus(it, c.jobType), missing: J.missingOnItem(it, c.jobType) })),
      parts_report_required: this.vans().partsReport(j.meta.lead_id ?? 'me'),
      parts_reports: this.reportsOn(j.meta.id),
      ...this.repairView(j),
      tools_out: this.tools().onJob(j.meta.id),
    };
  }

  // ---- The stockroom's tool store --------------------------------------------------------------
  private tools(): DemoTools {
    const st = this.state.toolStore ?? (this.state.toolStore = seedTools());
    return new DemoTools(st, this.state.flags, id => { const j = this.findJob(id); return j ? { status: j.card.status as string, closedAt: (j as { closedAt?: string }).closedAt ?? null } : null; },
      id => (this.state.office ? this.office().name(id) : id === 'me' ? 'Thabo Mkhize' : ''));
  }
  private openJobsOf(userId: string) {
    return this.state.jobs.filter(j => !['closed', 'cancelled'].includes(j.card.status as string) && ((j.meta.lead_id ?? 'me') === userId || (j.meta.helper_ids ?? []).includes(userId)))
      .map(j => ({ id: j.meta.id, job_number: j.meta.job_number, store: j.meta.store, fault_reported: j.meta.fault_reported, people: [j.meta.lead_id ?? 'me', ...(j.meta.helper_ids ?? [])] }));
  }
  private toolRoute(p: string, req: Request, b: any): Response | null {
    let m: RegExpMatchArray | null;
    if (p === '/barcodes') {
      const lvl = this.state.office ? this.office().levelOf(this.who.id) ?? this.who.level : this.who.level;
      if (lvl === 'technician' || lvl === 'hr') return refuse(403, 'printing stickers is for the office, the mechanic and the stockroom');
      const vs = this.fleet().s.vehicles as { id: string; registration: string; description?: string | null; make: string | null; model: string | null; barcode?: string; photo_id?: string | null }[];
      vs.forEach((v, i) => { v.barcode ??= v.registration === 'ND 412-778' ? 'ZSP-V07' : `ZSP-V${String(i + 10).padStart(2, '0')}`; });
      this.persist(this.state);
      return ok({ vehicles: vs.map(v => ({ id: v.id, registration: v.registration, description: v.description ?? null, make: v.make, model: v.model, barcode: v.barcode, photo_id: v.photo_id ?? null })),
        tools: this.tools().s.tools.filter(t => t.active).map(t => ({ id: t.id, name: t.name, kind: t.kind, serial: t.serial, barcode: t.barcode, condition: t.condition, photo_id: t.photo_id ?? null })) });
    }
    if (p === '/me/tools') { const r = this.tools().mine(this.who.id); this.persist(this.state); return ok(r); }
    if (!p.startsWith('/tool-store')) return null;
    if (!this.does('stockroom') && !this.covers()) return refuse(403, 'the stockroom keeps the tool store');
    const t = this.tools();
    const done = (r: { ok: true; body: unknown; status?: number } | { ok: false; status: number; reasons: string[] }) => { this.persist(this.state); return r.ok ? ok(r.body, r.status ?? 200) : refuse(r.status, ...r.reasons); };
    if (p === '/tool-store' && req.method === 'GET') {
      const people = this.office().o.people.filter(x => !['director', 'creator'].includes(x.login_level)).map(x => ({ id: x.id, full_name: x.full_name, login_level: x.login_level })).sort((a, c) => a.full_name.localeCompare(c.full_name));
      const ids = new Set(people.map(x => x.id));
      const jobs = [...new Map(people.flatMap(x => this.openJobsOf(x.id)).map(j => [j.id, j])).values()].map(j => ({ ...j, people: j.people.filter(x => ids.has(x)) }));
      const list = t.list(); this.persist(this.state);
      return ok({ tools: list, people, jobs });
    }
    if (p === '/tool-store' && req.method === 'POST') return done(t.add(b));
    if (p === '/tool-store/find') return done(t.find(new URLSearchParams(req.path.split('?')[1] ?? '').get('code') ?? ''));
    if ((m = p.match(/^\/tool-store\/([^/]+)\/history$/))) return ok(t.history(m[1]));
    if ((m = p.match(/^\/tool-store\/([^/]+)\/book-out$/))) return done(t.bookOut(m[1], b, this.who.name, id => this.openJobsOf(id), this.standIn()));
    if ((m = p.match(/^\/tool-store\/([^/]+)\/return$/))) return done(t.signBack(m[1], b, this.who.name, this.standIn()));
    if ((m = p.match(/^\/tool-store\/([^/]+)$/)) && req.method === 'PUT') return done(t.edit(m[1], b));
    return refuse(404, 'demo: not available');
  }

  // ---- Workshop repairs: the workshop, loan machines, machines uplifted ----------------------

  private repairs(): DemoRepairs {
    if (!this.state.repairs) {
      this.state.repairs = {
        workshop: { name: REAL ? `${REAL.company.name} workshop` : 'ZSP workshop (demo)', address: REAL?.company.address ?? 'Alton, Richards Bay', lat: -28.7466, lng: 32.0383, geofence_m: 150 },
        loans: [
          { id: 'loan-1', name: 'Loan ice machine 1 (Scotsman AC 86)', serial: 'LN-IM-01', asset_number: 'L001', notes: null, active: true },
          { id: 'loan-2', name: 'Loan combi oven (Rational 6-1/1)', serial: 'LN-CO-01', asset_number: 'L002', notes: 'Needs a 3-phase plug', active: true },
          { id: 'loan-3', name: 'Loan bottle fridge (2-door)', serial: 'LN-BF-01', asset_number: 'L003', notes: null, active: true },
        ],
      };
      const o = this.office();
      const st = (id: string) => o.store(id) ?? this.state.office!.stores[0];
      const n0 = Math.max(...this.state.jobs.map(j => j.meta.job_number)) + 1;
      // A machine uplifted yesterday, with a loan machine at the store, being repaired.
      const y = new Date(Date.now() - 22 * 3600_000);
      const iso = (ms: number) => new Date(y.getTime() + ms * 60_000).toISOString();
      const lifted = officeJob(n0, 'breakdown', 'normal', st('arboretum') as DemoStore, 'Ice machine making very little ice, compressor noisy', { id: 'tech-2', name: o.name('tech-2') }, y.toISOString().slice(0, 10));
      lifted.card.visits = [{ state: 'uplifted', goAt: iso(0), arrivedAt: iso(20), checkedInManager: 'Store manager', safetyCheck: { areaSafe: true, isolated: true, publicClear: true }, startedAt: iso(25), endedAt: iso(70), pauses: [] }];
      lifted.card.status = 'continue_later';
      lifted.card.machineAt = 'workshop';
      lifted.card.loansOut = 1;
      lifted.moves = [
        { id: 'mv-1', kind: 'loan_out', place: 'site', at: iso(60), note: null, person_name: 'Store manager', photo_ids: [], signature_photo_id: null, loan_machine_id: 'loan-1', loan_machine: 'Loan ice machine 1 (Scotsman AC 86)', loan_serial: 'LN-IM-01', by_name: o.name('tech-2') },
        { id: 'mv-2', kind: 'uplifted', place: 'site', at: iso(68), note: 'Compressor bearings worn, needs to be stripped and rebuilt on the bench in the workshop', person_name: 'Store manager', photo_ids: [], signature_photo_id: null, loan_machine_id: null, loan_machine: null, loan_serial: null, by_name: o.name('tech-2') },
      ];
      this.state.jobs.push(lifted);
      // A machine the client brought in: the technician starts in the workshop.
      this.state.jobs.push(officeJob(n0 + 1, 'workshop_repair', 'normal', st('meerensee') as DemoStore, 'Microwave brought in by the client: not heating, turntable not turning', { id: 'me', name: 'Thabo Mkhize' }, today()));
      this.persist(this.state);
    }
    return this.state.repairs;
  }

  /** Each loan machine and where it is now (its last move on any job). */
  private loanStatus(): LoanMachine[] {
    const last = new Map<string, { m: MachineMove; j: DemoJob }>();
    for (const j of this.state.jobs) for (const m of j.moves ?? []) {
      if (!m.loan_machine_id) continue;
      const cur = last.get(m.loan_machine_id);
      if (!cur || cur.m.at <= m.at) last.set(m.loan_machine_id, { m, j });
    }
    return this.repairs().loans.map(l => {
      const x = last.get(l.id);
      const out = x?.m.kind === 'loan_out';
      return { ...l, out, ...(out ? { job_id: x!.j.meta.id, job_number: x!.j.meta.job_number, store: x!.j.meta.store, since: x!.m.at, by_name: x!.m.by_name } : {}) };
    }).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }

  private repairView(j: DemoJob) {
    const rp = this.repairs();
    const c = j.card;
    const at = J.machineAt(c);
    const last = c.visits.at(-1);
    return {
      machine_at: at,
      loans_out: c.loansOut ?? 0,
      loans_out_list: this.loanStatus().filter(l => l.out && l.job_id === j.meta.id).map(l => ({ id: l.id, name: l.name, serial: l.serial, since: l.since! })),
      moves: j.moves ?? [],
      workshop: rp.workshop,
      ready_to_deliver: at === 'workshop' && last?.place === 'workshop' && last.state === 'done',
    };
  }

  private repairRoute(p: string, req: Request, b: any): Response | null {
    let m: RegExpMatchArray | null;
    const level = this.state.office ? this.office().levelOf(this.who.id) ?? this.who.level : this.who.level;
    const office = ['admin', 'accounts', 'management', 'director', 'creator'].includes(level);
    const rp = this.repairs();
    if (p === '/company/workshop') {
      if (req.method === 'GET') return ok({ workshop: rp.workshop, canEdit: office });
      if (!office) return refuse(403, 'only the office keeps the loan machines and the workshop');
      if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return refuse(400, 'the map position');
      rp.workshop = { name: (b.name ?? 'Workshop').trim(), address: b.address ?? null, lat: b.lat, lng: b.lng, geofence_m: b.geofenceM ?? 150 };
      this.persist(this.state);
      return ok({ workshop: rp.workshop, canEdit: true });
    }
    if (p === '/loan-machines') {
      if (req.method === 'GET') return ok(this.loanStatus());
      if (!office) return refuse(403, 'only the office keeps the loan machines and the workshop');
      if (!b.name || b.name.trim().length < 2) return refuse(400, 'a name');
      const l = { id: id('loan'), name: b.name.trim(), serial: b.serial ?? null, asset_number: b.assetNumber ?? null, notes: b.notes ?? null, active: true };
      rp.loans.push(l);
      this.persist(this.state);
      return ok(this.loanStatus().find(x => x.id === l.id), 201);
    }
    if ((m = p.match(/^\/loan-machines\/([^/]+)$/)) && req.method === 'PUT') {
      if (!office) return refuse(403, 'only the office keeps the loan machines and the workshop');
      const l = rp.loans.find(x => x.id === m![1]);
      const now = this.loanStatus().find(x => x.id === m![1]);
      if (!l || !now) return refuse(404, 'no such loan machine');
      if (b.active === false && now.out) return refuse(409, `${l.name} is out at ${now.store}: collect it first`);
      Object.assign(l, { name: b.name ?? l.name, serial: b.serial ?? l.serial, asset_number: b.assetNumber ?? l.asset_number, notes: b.notes ?? l.notes, active: b.active ?? l.active });
      this.persist(this.state);
      return ok(this.loanStatus().find(x => x.id === l.id));
    }
    if (!(m = p.match(/^\/jobs\/([^/]+)\/(workshop-start|uplift|loan-out|loan-back|deliver)$/))) return null;
    const j = this.findJob(m[1]);
    if (!j) return refuse(404, 'no such job');
    j.card.workshop = { lat: rp.workshop.lat, lng: rp.workshop.lng, geofenceM: rp.workshop.geofence_m };
    const by = this.who.name;
    const add = (mv: Partial<MachineMove> & Pick<MachineMove, 'kind'>) => (jj: DemoJob) => {
      jj.moves = [...(jj.moves ?? []), { id: id('mv'), place: 'site', at: b.at ?? new Date().toISOString(), note: null, person_name: null, photo_ids: b.photoIds ?? [], signature_photo_id: b.signaturePhotoId ?? null,
        loan_machine_id: null, loan_machine: null, loan_serial: null, by_name: by, ...mv }];
    };
    const photos = (b.photoIds ?? []).length;
    switch (m[2]) {
      case 'workshop-start': return this.rule(j.meta.id, c => J.startAtWorkshop(c, { at: b.at, position: b.position, safety: b.safety, outsideReason: b.outsideReason }));
      case 'uplift':
        if (!b.signaturePhotoId) return refuse(409, 'send the store manager signature first');
        return this.rule(j.meta.id, c => J.uplift(c, { at: b.at, reason: b.reason ?? '', managerName: b.managerName ?? '', photos, signed: true }), add({ kind: 'uplifted', note: (b.reason ?? '').trim(), person_name: (b.managerName ?? '').trim() }));
      case 'loan-out': {
        const lm = this.loanStatus().find(x => x.id === b.loanMachineId);
        if (!lm || !lm.active) return refuse(400, 'unknown loan machine');
        if (lm.out) return refuse(409, `${lm.name} is already out at ${lm.store} (job ${lm.job_number})`);
        if (!b.signaturePhotoId) return refuse(409, 'send the store manager signature first');
        return this.rule(j.meta.id, c => J.loanOut(c, { photos, managerName: b.managerName ?? '', signed: true }), add({ kind: 'loan_out', loan_machine_id: lm.id, loan_machine: lm.name, loan_serial: lm.serial, person_name: (b.managerName ?? '').trim() }));
      }
      case 'loan-back': {
        const lm = this.loanStatus().find(x => x.id === b.loanMachineId);
        if (!lm || !lm.out || lm.job_id !== j.meta.id) return refuse(409, 'that loan machine is not out on this job');
        return this.rule(j.meta.id, c => J.loanBack(c, { photos }), add({ kind: 'loan_back', loan_machine_id: lm.id, loan_machine: lm.name, loan_serial: lm.serial, note: b.note ?? null, signature_photo_id: null }));
      }
      default: {
        const place = J.placeOf(j.card.visits.at(-1));
        return this.rule(j.meta.id, c => J.deliver(c, { photos, receivedBy: b.receivedBy ?? '' }), add({ kind: 'delivered', place, person_name: (b.receivedBy ?? '').trim(), note: b.note ?? null, signature_photo_id: null }));
      }
    }
  }

  private office(): DemoOffice {
    // Older saved demos: add HR.
    if (this.state.office && !this.state.office.people.some(x => x.login_level === 'hr')) this.state.office.people.splice(2, 0, { id: 'hr-1', full_name: 'Precious Ngcobo', login_level: 'hr', department: 'Office' });
    if (!this.state.office) {
      this.state.office = seedOffice();
      const st = (id: string) => this.state.office!.stores.find(x => x.id === id)!;
      const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
      if (!this.findJob('job-10220')) {
        const sipho = officeJob(10220, 'breakdown', 'normal', st('esikhawini'), 'Condenser fan not running on the bakery display', { id: 'tech-2', name: 'Sipho Ndlovu' }, today());
        sipho.card.status = 'in_progress';
        this.state.jobs.push(sipho);
        // Two jobs already closed, for invoicing.
        const y1 = new Date(Date.now() - 26 * 3600_000), y3 = new Date(Date.now() - 74 * 3600_000);
        const closed = (n: number, store: string, fault: string, lead: { id: string; name: string }, end: Date, mins: number, ref: string | null) => {
          const j = officeJob(n, 'breakdown', 'normal', st(store), fault, lead, end.toISOString().slice(0, 10), [], ref ?? undefined);
          const startedAt = new Date(end.getTime() - mins * 60_000).toISOString();
          j.card.visits = [{ state: 'done', goAt: new Date(end.getTime() - (mins + 30) * 60_000).toISOString(), arrivedAt: new Date(end.getTime() - (mins + 5) * 60_000).toISOString(),
            checkedInManager: 'Store manager', safetyCheck: { areaSafe: true, isolated: true, publicClear: true }, startedAt, endedAt: end.toISOString(), pauses: [] }] as never;
          (j.card as { status: string }).status = 'closed';
          (j as { closedAt?: string }).closedAt = end.toISOString();
          return j;
        };
        this.state.jobs.push(closed(10212, 'esikhawini', 'Freezer room alarm going off, temperature rising', { id: 'tech-2', name: 'Sipho Ndlovu' }, y1, 95, 'BX-22817'));
        this.state.jobs.push(closed(10219, 'meerensee', 'Ice machine leaking water at the inlet', { id: 'me', name: 'Thabo Mkhize' }, y3, 80, 'PO-14190'));
        this.state.jobs.push(officeJob(10236, 'installation', 'scheduled', st('arboretum'), 'Install new 3-door display fridge and connect to the existing circuit', { id: 'tech-3', name: 'Ayanda Mthembu' }, tomorrow));
      }
      const y = new Date(Date.now() - 20 * 3600_000).toISOString();
      // In the real-data demo the example incidents are the Example Tech's only (nothing about the real staff).
      this.state.flags.push(
        { id: 'flag-sipho', flag_type: 'stock_return_short', severity: 'normal', raised_at: y, status: 'explained', tech: REAL ? EXAMPLE_TECH : 'tech-2',
          question: `You sent back 1 of 2 contactors booked out for job ${REAL ? 10236 : 10220}. Where is the other one?`, explanation: 'Fitted the second one on the same unit, forgot to put it on the job card.', details: {} },
        ...(REAL ? [] : [{ id: 'flag-oil', flag_type: 'workshop_stock_short', severity: 'normal', raised_at: y, status: 'open', tech: 'mech',
          question: 'Workshop Engine oil 15W-40 counted 2 L short (allowance 0.25 L). What happened?', explanation: null, details: {} }]),
      );
    }
    // Older saved demos and new ones: the bookkeeper (Accounts).
    if (!this.state.office.people.some(x => x.login_level === 'accounts')) {
      const at = this.state.office.people.findIndex(x => x.login_level === 'admin');
      this.state.office.people.splice(at < 0 ? 2 : at + 1, 0, { id: 'acc-1', full_name: 'Nandi Khumalo', login_level: 'accounts', department: 'Office' } as never);
    }
    const myHandover: DemoInspection | null = this.state.vehicle?.handover_status === 'awaiting_approval' ? {
      id: 'insp-me', vehicle_id: this.state.vehicle.id, registration: this.state.vehicle.registration, driver_id: 'me', driver: 'Thabo Mkhize', previous_driver: REAL ? 'Ayanda Mthembu' : 'Sipho Ndlovu',
      inspected_at: new Date().toISOString(), odometer_km: this.van().odometerKm, fuel_level: 'half', problems: this.van().problems, new_problems: [],
      handover_by: 'remote_approval', handed_over_by_name: null, remote_reason: 'Nobody at the yard to sign', status: 'awaiting_approval', decided_at: null, decision_note: null,
    } : null;
    return new DemoOffice(this.state.office, {
      jobs: this.state.jobs, flags: this.state.flags, fleet: this.fleet(), workshop: this.workshop(), stock: this.state.stockControl!,
      fleetDuty: (this.state.fleetDuty ??= {}), myHandover,
    });
  }

  /** Whether the signed-in person does this kind of work (their position, or switched on by the CEO). */
  private does(area: 'jobs' | 'documents' | 'stores' | 'stockroom' | 'fleet' | 'flags' | 'prices' | 'access' | 'hr' | 'vanstock' | 'jobcards' | 'books') {
    if (area === 'fleet' && this.who.level === 'mechanic') return true;
    if (area === 'stockroom' && this.who.level === 'stockroom') return true;
    return this.office().workOf(this.who.id, this.who.level)[area];
  }

  /** The Breakdowns queue (emails and the WhatsApp group). */
  private bds(): DemoBreakdowns {
    const stores = () => this.office().o.stores.map(s => ({ id: s.id, name: s.name, client: s.client, address: s.address }));
    const company = REAL ? REAL.company.name : 'ZSP';
    return new DemoBreakdowns((this.state.breakdowns ??= seedBreakdowns(stores(), company)), {
      stores,
      jobs: () => this.state.jobs.map(j => ({ id: j.meta.id, job_number: j.meta.job_number, status: j.card.status as string, store_id: (j.meta as { store_id?: string }).store_id ?? null, store: j.meta.store,
        client_order_ref: (j.meta as { client_order_ref?: string | null }).client_order_ref ?? null, lead: j.meta.lead_technician })),
    });
  }

  /** The office opens a job (New job, or a breakdown from the queue). */
  private newOfficeJob(o: DemoOffice, b: any): Response {
    const store = o.store(b.storeId);
    const missing = [!store ? 'which store' : null, !b.faultReported || b.faultReported.trim().length < 3 ? 'what the fault is' : null, !b.scheduledDate ? 'the date' : null,
      !b.leadTechnicianId ? 'the lead technician' : null].filter(Boolean) as string[];
    if (missing.length) return refuse(400, ...missing);
    if (b.jobType === 'planned_maintenance' && !(b.maintenanceSteps ?? []).length) return refuse(400, 'planned maintenance needs its checklist steps');
    const n = Math.max(...this.state.jobs.map(j => j.meta.job_number)) + 1;
    const j = officeJob(n, b.jobType, b.priority ?? 'normal', store!, b.faultReported.trim(), { id: b.leadTechnicianId, name: o.name(b.leadTechnicianId) }, b.scheduledDate, b.helperIds ?? [], b.clientOrderRef);
    j.meta.checklist = (b.maintenanceSteps ?? []).map((step: string, i: number) => ({ id: `chk-${n}-${i}`, step, done: false }));
    this.state.jobs.push(j);
    this.persist(this.state);
    return ok(this.view(j), 201);
  }

  /** Bringing in customers from a CSV (the test drive reads CSV; the real server also reads Excel). */
  private async customerRoute(p: string, req: Request, b: any): Promise<Response | null> {
    let m: RegExpMatchArray | null;
    if (!p.startsWith('/office/customers/import')) return null;
    if (!this.does('stores')) return refuse(403, 'bringing in customers is for whoever looks after clients and stores');
    const imports = (this.state.customerImports ??= {});
    if (p === '/office/customers/import') {
      if (!req.upload) return refuse(400, 'no file');
      let text: string;
      try { const blob = await (await fetch(req.upload.fileUri)).blob(); const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer()); if (head[0] === 0x50 && head[1] === 0x4b) return refuse(400, 'In the test drive, use a CSV file (in Excel: File → Save as → CSV). The real server reads Excel files too.'); text = await blob.text(); }
      catch { return refuse(400, 'could not read the file'); }
      const all = parseCsv(text);
      if (all.length < 2) return refuse(400, 'the file has no rows: export the customer list with its headings');
      const { headers, body } = splitHeader(all);
      const id = `imp-${Date.now()}`;
      imports[id] = { headers, rows: body, applied: false };
      this.persist(this.state);
      return ok({ id, filename: req.upload.name ?? null, headers, rows: body.length, guess: guessMapping(headers), fields: CUSTOMER_FIELDS, samples: headers.map((_, i) => body.slice(0, 3).map(r => r[i] ?? '').filter(Boolean)) });
    }
    if ((m = p.match(/^\/office\/customers\/import\/([^/]+)\/(preview|apply)$/))) {
      const imp = imports[m[1]];
      if (!imp) return refuse(404, 'no such upload');
      if (b.mapping?.client === undefined) return refuse(400, 'say which column is the customer');
      const { rows, skipped } = toCustomers(imp.rows, b.mapping);
      const st = this.office().o.stores;
      if (m[2] === 'preview') {
        const clients = new Set(rows.map(r => r.client.toLowerCase()));
        const known = new Set(st.map(s => s.client.toLowerCase()));
        return ok({ customers: clients.size, newCustomers: [...clients].filter(c => !known.has(c)).length, sites: rows.length,
          newSites: rows.filter(r => !st.some(s => s.client.toLowerCase() === r.client.toLowerCase() && s.name.toLowerCase() === r.store.toLowerCase())).length,
          withAddress: rows.filter(r => r.address).length, withPin: rows.filter(r => r.lat !== null).length, skipped, preview: rows.slice(0, 8), applied: imp.applied });
      }
      if (imp.applied) return refuse(409, 'this file was already brought in');
      imp.applied = true;
      const r = this.office().importRows(rows);
      this.persist(this.state);
      return ok({ ...r, skipped });
    }
    return refuse(404, 'demo: not available');
  }

  private breakdownRoute(p: string, req: Request, b: any): Response | null {
    let m: RegExpMatchArray | null;
    if (!(p.startsWith('/breakdowns') || p === '/demo/breakdowns/simulate')) return null;
    const q = new URLSearchParams(req.path.split('?')[1] ?? '');
    const res = (r: { ok: true; body: unknown } | { ok: false; status: number; reasons: string[] }, status = 200) => { this.persist(this.state); return r.ok ? ok(r.body, status) : refuse(r.status, ...r.reasons); };
    const bd = this.bds();
    const ceo = this.does('access');
    if (p.startsWith('/breakdowns/settings') || p.startsWith('/breakdowns/inboxes') || p.startsWith('/breakdowns/whatsapp')) {
      if (!ceo) return refuse(403, 'only the CEO connects the inboxes and WhatsApp');
      if (p === '/breakdowns/settings' && req.method === 'GET') return ok(bd.settings('demo-company'));
      if (p === '/breakdowns/settings') return res(bd.saveSettings(b));
      if (p === '/breakdowns/inboxes') return res(bd.addInbox(b.address, b.appPassword));
      if ((m = p.match(/^\/breakdowns\/inboxes\/([^/]+)$/))) return res(bd.removeInbox(m[1]));
      if (p === '/breakdowns/whatsapp/group') return res(bd.chooseGroup(b.jid));
      return refuse(404, 'demo: not available');
    }
    if (!this.does('jobs')) return refuse(403, 'the breakdowns queue is for whoever opens jobs');
    if (p === '/demo/breakdowns/simulate') return res(bd.simulate(b.channel === 'whatsapp' ? 'whatsapp' : 'email'));
    if (p === '/breakdowns/count') { this.persist(this.state); return ok(bd.count()); }
    if (p === '/breakdowns') { this.persist(this.state); return ok(bd.list(q.get('view') === 'done' ? 'done' : 'open', ceo)); }
    if ((m = p.match(/^\/breakdowns\/([^/]+)\/log$/))) {
      const c = bd.check(m[1]);
      if (c) return res(c);
      const made = this.newOfficeJob(this.office(), b);
      if (made.status !== 201) return made;
      const v = made.body as { id: string };
      const j = this.findJob(v.id)!;
      return res(bd.logged(m[1], { id: j.meta.id, job_number: j.meta.job_number, store_id: b.storeId, store: j.meta.store, lead: j.meta.lead_technician, ref: b.clientOrderRef ?? null }, this.who.name), 201);
    }
    if ((m = p.match(/^\/breakdowns\/([^/]+)\/merge$/))) return res(bd.merge(m[1], b.jobId, this.who.name));
    if ((m = p.match(/^\/breakdowns\/([^/]+)\/ignore$/))) return res(bd.ignore(m[1], this.who.name, b.note, !!b.alwaysIgnoreSender));
    if ((m = p.match(/^\/breakdowns\/([^/]+)\/reopen$/))) return res(bd.reopen(m[1]));
    return refuse(404, 'demo: not available');
  }

  /** Own logins in the test drive. */
  private loginBook(): DemoLogins {
    return new DemoLogins((this.state.logins ??= { logins: {}, codes: {}, log: [] }), () => this.office().loginPeople());
  }

  /** The admin stands in for the stock controller when he is out: issuing stock and tools (unless the CEO switched the stockroom off for her). */
  private covers(): boolean {
    const lvl = this.office().levelOf(this.who.id) ?? this.who.level;
    return lvl === 'admin' && this.office().o.work?.[this.who.id]?.stockroom !== false;
  }
  /** Who is doing stockroom work when it is not a stock controller: their position, e.g. "Admin". */
  private standIn(): string | null {
    const lvl = this.office().levelOf(this.who.id) ?? this.who.level;
    return lvl === 'stockroom' ? null : POSITION_LABEL[lvl] ?? lvl;
  }

  /** Daily timesheets: the technician's own, and HR's export. */
  private timesRoute(p: string, req: Request, b: any): Response | null {
    let m: RegExpMatchArray | null;
    if (!(p === '/me/timesheets' || p.startsWith('/me/timesheets/') || p === '/timesheets' || p === '/timesheets/settings' || p === '/timesheets/people' || p.startsWith('/timesheets/person/') || /^\/timesheets\/[^/]+\/\d{4}-\d{2}-\d{2}\/fill$/.test(p))) return null;
    const t = this.times();
    const save = (r: { ok: true; body: unknown } | { ok: false; status: number; reasons: string[] }) => { this.persist(this.state); return r.ok ? ok(r.body) : refuse(r.status, ...r.reasons); };
    if (p === '/me/timesheets') { if (this.who.level !== 'technician') return ok({ due: [], recent: [], explainFromMin: 30 }); const r = t.mine(this.who.id); this.persist(this.state); return ok(r); }
    if ((m = p.match(/^\/me\/timesheets\/(\d{4}-\d{2}-\d{2})\/submit$/))) return this.who.level === 'technician' ? save(t.submit(this.who.id, m[1], b)) : refuse(403, 'timesheets are for technicians');
    if ((m = p.match(/^\/me\/timesheets\/(\d{4}-\d{2}-\d{2})$/))) return ok(t.sheet(this.who.id, m[1]));
    const ceo = ['director', 'creator'].includes(this.office().levelOf(this.who.id) ?? this.who.level);
    if ((m = p.match(/^\/timesheets\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/fill$/))) return ceo ? save(t.fill(m[1], m[2], this.who.name)) : refuse(403, "only the CEO fills in a technician's timesheet");
    // HR and the CEO always see everyone (also people who have left); a department manager his own technicians.
    const lvl = this.office().levelOf(this.who.id) ?? this.who.level;
    const all = this.does('hr') || ['hr', 'director', 'creator'].includes(lvl);
    const full = ['hr', 'director', 'creator'].includes(lvl);
    if (p === '/timesheets/settings') {
      const canEdit = this.does('hr') || this.does('access');
      if (req.method === 'PUT') return canEdit ? save(t.setRules(b)) : refuse(403, 'only HR or the CEO sets the normal hours');
      return ok({ ...t.rules(), canEdit });
    }
    if (!all && this.who.level !== 'management') return refuse(403, 'timesheets are for HR and department managers');
    const v = this.vans();
    const q = new URLSearchParams(req.path.split('?')[1] ?? '');
    const from = q.get('from') ?? '', to = q.get('to') ?? '';
    const mine = all ? null : v.v.memberOf[this.who.id] ?? null;
    const leavers = (this.office().o.leavers ?? []).filter(l => l.person.login_level === 'technician');
    if (p === '/timesheets/people') {
      const staff = this.office().o.people.filter(x => x.login_level === 'technician').filter(x => all || (mine && v.v.memberOf[x.id] === mine))
        .map(x => ({ id: x.id, full_name: x.full_name, left: false, left_on: null, department: v.deptOf(x.id)?.name ?? null })).sort((a, c) => a.full_name.localeCompare(c.full_name));
      return ok({ people: [...staff, ...(full ? leavers.map(l => ({ id: l.person.id, full_name: l.person.full_name, left: true, left_on: l.date, department: l.department })) : [])], full });
    }
    let m2: RegExpMatchArray | null;
    if ((m2 = p.match(/^\/timesheets\/person\/([^/]+)\/(history|log)$/))) {
      const id2 = m2[1];
      const isLeaver = leavers.some(l => l.person.id === id2);
      if (!all && (isLeaver || !mine || v.v.memberOf[id2] !== mine)) return refuse(403, 'not one of your technicians');
      if (isLeaver && !full) return refuse(403, 'not one of your technicians');
      if (m2[2] === 'log') return full ? save(t.log(id2, x => v.v.memberOf[x] ?? null)) : refuse(403, 'the timesheet log is for HR and the CEO');
      const r = t.history(id2, q.get('before'));
      if (r.ok) t.viewed({ by: this.who.name, userId: id2, departmentId: null, history: true });
      return save(r);
    }
    const withLeft = full && (q.get('includeLeft') === '1' || !!q.get('userId'));
    const techs = [...this.office().o.people, ...(withLeft ? leavers.map(l => l.person) : [])].filter(x => x.login_level === 'technician')
      .filter(x => all || (mine && v.v.memberOf[x.id] === mine))
      .filter(x => !q.get('userId') || x.id === q.get('userId'))
      .filter(x => !q.get('departmentId') || v.v.memberOf[x.id] === q.get('departmentId'))
      .sort((a, c) => (v.deptOf(a.id)?.name ?? '~').localeCompare(v.deptOf(c.id)?.name ?? '~') || a.full_name.localeCompare(c.full_name))
      .map(x => ({ id: x.id, department: v.deptOf(x.id)?.name ?? null }));
    if (q.get('userId') && !techs.length) return refuse(403, 'not one of your technicians');
    const res = t.exportFor(from, to, techs, ceo);
    if (res.ok) {
      t.viewed({ by: this.who.name, userId: q.get('userId'), departmentId: q.get('departmentId'), from, to });
      const left = new Set(leavers.map(l => l.person.id));
      for (const x of (res.body as { technicians: { id: string; left?: boolean }[] }).technicians) if (left.has(x.id)) x.left = true;
    }
    return save(res);
  }

  /** Departments and van stock lists. */
  private vanRoute(p: string, req: Request, b: any): Response | null {
    let m: RegExpMatchArray | null;
    if (!(p.startsWith('/departments') || p.startsWith('/van-stock') || p === '/me/van' || p === '/team/map' || /^\/access\/users\/[^/]+\/department$/.test(p))) return null;
    const v = this.vans();
    const office = ['admin', 'management', 'hr', 'director', 'creator'].includes(this.who.level);
    const stockroom = this.does('stockroom');
    const manages = this.does('hr');
    const save = (r: { ok: true; body: unknown } | { ok: false; status: number; reasons: string[] }) => { this.persist(this.state); return r.ok ? ok(r.body) : refuse(r.status, ...r.reasons); };
    const mine = this.who.level === 'management' ? [v.v.memberOf[this.who.id]].filter(Boolean) as string[] : null;
    const editable = (d: string) => this.does('vanstock') && (mine ? mine.includes(d) : true);
    if (p === '/me/van') return ok(v.report(this.who.id));
    if (p === '/team/map') {
      const all = ['director', 'creator'].includes(this.who.level) || (this.who.level !== 'management' && this.does('flags'));
      if (!all && this.who.level !== 'management') return refuse(403, 'you have no team on the map');
      const deptIds = all ? null : [...new Set([...v.manages(this.who.id), v.v.memberOf[this.who.id]].filter(Boolean) as string[])];
      const o = this.office(); const f = this.fleet(); const spots = f.positions(); const crew = f.technicians(this.thaboIn());
      const techs = o.o.people.filter(x => x.login_level === 'technician' && (all || deptIds!.includes(v.v.memberOf[x.id] ?? '')))
        .sort((a, c) => (v.deptOf(a.id)?.name ?? '~').localeCompare(v.deptOf(c.id)?.name ?? '~') || a.full_name.localeCompare(c.full_name));
      const flags = { record: { read: false, write: false }, kit: { read: false, write: false } };
      return ok({
        all, departments: all ? [...new Set(techs.map(t => v.deptOf(t.id)?.name).filter(Boolean))] : deptIds!.map(id => v.dept(id)!.name),
        technicians: techs.map(t => {
          const pr = o.profile(t.id, false, flags, crew, x => spots.find(y => y.id === x) ?? null);
          const b = (pr.ok ? pr.body : {}) as { tradeLabel?: string | null; photo_id?: string | null; now?: unknown };
          return { id: t.id, full_name: t.full_name, tradeLabel: b.tradeLabel ?? null, department: v.deptOf(t.id)?.name ?? null, photo_id: b.photo_id ?? null, now: b.now };
        }),
      });
    }
    if (p === '/departments' && req.method === 'GET') return office || stockroom ? ok(v.departments(manages)) : refuse(403, 'departments are not part of your work');
    if (p === '/departments' || (m = p.match(/^\/departments\/([^/]+)$/))) {
      if (!manages) return refuse(403, 'only HR (or the CEO) sets up departments');
      return save(p === '/departments' ? v.createDept(b) : v.updateDept(m![1], b));
    }
    if ((m = p.match(/^\/access\/users\/([^/]+)\/department$/))) return manages ? save(v.setDepartment(m[1], b.departmentId ?? null, this.who.name)) : refuse(403, 'only HR (or the CEO) puts people in departments');
    if (p === '/van-stock') {
      if (!office && !stockroom && !this.does('vanstock')) return refuse(403, 'van stock lists are not part of your work');
      return ok(v.lists(mine && !manages && !stockroom ? mine : 'all', editable));
    }
    if ((m = p.match(/^\/van-stock\/departments\/([^/]+)\/items\/([^/]+)$/))) {
      if (!editable(m[1])) return refuse(403, "only the department's manager (or the CEO) sets its van stock list");
      return save(v.setItem(m[1], m[2], Number(b.qty), this.who.id));
    }
    if ((m = p.match(/^\/van-stock\/departments\/([^/]+)\/changes$/))) return ok(v.changes(m[1]));
    if ((m = p.match(/^\/van-stock\/technicians\/([^/]+)\/issue$/))) return stockroom ? save(v.issue(m[1], b.lines, this.who.id)) : refuse(403, 'the stockroom issues van stock');
    if ((m = p.match(/^\/van-stock\/technicians\/([^/]+)$/))) return office || stockroom || m[1] === this.who.id ? ok(v.report(m[1], stockroom)) : refuse(403, 'not your technician');
    return refuse(404, 'not found');
  }

  /** The office's routes; only office positions get here. */

  private reportsOn(jobId: string) {
    return (this.state.reports ?? []).filter(r => r.job_id === jobId).sort((a, c) => c.created_at.localeCompare(a.created_at))
      .map(r => ({ id: r.id, report_number: r.report_number, created_at: r.created_at, part_description: r.part_description, part_qty: r.part_qty, visit_id: null, quote_number: r.quote_number, created_by: r.created_by_name }));
  }
  /** Parts reports, emailing them, and the letterhead (as the server). */
  private reportRoute(p: string, req: Request, b: any): Response | null {
    let m: RegExpMatchArray | null;
    const level = this.state.office ? this.office().levelOf(this.who.id) ?? this.who.level : this.who.level;
    const office = ['admin', 'accounts', 'management', 'director', 'creator', 'stockroom'].includes(level);
    const ceo = ['director', 'creator'].includes(level);
    if (p === '/company/letterhead') {
      if (req.method === 'GET') return ok({ headerPhotoId: this.state.letterhead?.headerPhotoId ?? null, footerPhotoId: this.state.letterhead?.footerPhotoId ?? null, canEdit: ceo });
      if (!ceo) return refuse(403, 'only the CEO sets the letterhead');
      const cur = this.state.letterhead ?? { headerPhotoId: null, footerPhotoId: null };
      this.state.letterhead = { headerPhotoId: b.headerPhotoId === undefined ? cur.headerPhotoId : b.headerPhotoId, footerPhotoId: b.footerPhotoId === undefined ? cur.footerPhotoId : b.footerPhotoId };
      this.persist(this.state);
      return ok(this.state.letterhead);
    }
    if ((m = p.match(/^\/jobs\/([^/]+)\/parts-reports$/))) return ok(this.reportsOn(m[1]));
    if ((m = p.match(/^\/jobs\/([^/]+)\/parts-report$/))) {
      const j = this.findJob(m[1]);
      if (!j) return refuse(404, 'no such job');
      const me = this.who.id;
      if ((j.meta.lead_id ?? 'me') !== me && !(j.meta.helper_ids ?? []).includes(me)) return refuse(403, 'you are not on this job');
      if (['closed', 'cancelled'].includes(j.card.status)) return refuse(409, 'the job is finished: start a new quote and link the job card for reference');
      const had = (this.state.reports ?? []).find(r => r.id === b.id);
      if (had) return ok({ id: had.id, reportNumber: had.report_number, again: true });
      if (!b.machinePhotoId || !b.serialPhotoId || !b.partPhotoId) return refuse(400, 'the photos of the machine, the serial tag and the part');
      if (!b.partDescription || b.partDescription.trim().length < 2) return refuse(400, 'what part is needed');
      const d = this.docs();
      const q = d.techQuote({ jobId: j.meta.id, title: `Parts needed: ${b.partDescription.trim()}`, notes: [b.serialText ? `Serial: ${b.serialText}` : null, b.notes ?? null, 'See the parts report for photos.'].filter(Boolean).join('\n'),
        boughtOutLines: [{ description: b.partDescription.trim(), qty: Number(b.partQty ?? 1), estimatedPriceCents: 0 }] },
        { id: me, name: this.who.name }, [{ id: j.meta.id, status: j.card.status }], () => null);
      const qb = q.ok ? q.body as { id: string; quoteNumber: number } : null;
      const list = (this.state.reports ??= []);
      const n = 1001 + list.length;
      const r = { id: b.id ?? id('report'), report_number: n, job_id: j.meta.id, visit_start: j.card.visits.at(-1)?.goAt ?? '', created_at: b.at ?? new Date().toISOString(), created_by: me, created_by_name: this.who.name,
        machine_photo_id: b.machinePhotoId, serial_photo_id: b.serialPhotoId, serial_text: b.serialText?.trim() || null, part_photo_id: b.partPhotoId, part_description: b.partDescription.trim(),
        part_qty: Number(b.partQty ?? 1), extra_photo_ids: b.extraPhotoIds ?? [], notes: b.notes?.trim() || null, quote_id: qb?.id ?? null, quote_number: qb?.quoteNumber ?? null };
      list.push(r);
      this.persist(this.state);
      return ok({ id: r.id, reportNumber: n, quoteId: r.quote_id, quoteNumber: r.quote_number }, 201);
    }
    if ((m = p.match(/^\/parts-reports\/([^/]+)(\/email)?$/))) {
      const r = (this.state.reports ?? []).find(x => x.id === m![1]);
      if (!r) return refuse(404, 'no such report');
      if (r.created_by !== this.who.id && !office) return refuse(403, 'not your report');
      const j = this.findJob(r.job_id);
      const store = j ? this.office().o.stores.find(x => x.id === j.meta.store_id) : undefined;
      if (m[2]) {
        const to: string[] = Array.isArray(b.to) ? b.to : [];
        if (!to.length || to.some(x => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) return refuse(400, 'a valid email address');
        (this.state.reportEmails ??= []).unshift({ report_id: r.id, sent_to: to, sent_at: new Date().toISOString(), ok: true, error: null, sent_by: this.who.name });
        this.persist(this.state);
        return ok({ ok: true, to, demo: true });
      }
      return ok({ report: { ...r, technician: r.created_by_name, job_number: j?.meta.job_number ?? null, fault_reported: j?.meta.fault_reported ?? '', store: j?.meta.store ?? '', store_address: j?.meta.store_address ?? null,
        store_email: null, client: store?.client ?? '' }, emails: (this.state.reportEmails ?? []).filter(e => e.report_id === r.id), canEmail: true });
    }
    return null;
  }

  /** A technician's quotes: on his jobs not finished, or new for a store with a job card for reference. */
  private techQuoteRoute(p: string, req: Request, b: any): Response | null {
    if (p !== '/me/quote-options' && p !== '/me/quotes') return null;
    const level = this.office().levelOf(this.who.id) ?? this.who.level;
    if (['mechanic', 'stockroom', 'hr'].includes(level)) return refuse(403, 'quotes from site are for technicians');
    const id = this.who.id;
    const mine = this.state.jobs.filter(j => (j.card.status as string) !== 'cancelled' && ((j.meta.lead_id ?? 'me') === id || (j.meta.helper_ids ?? []).includes(id)))
      .map(j => ({ id: j.meta.id, job_number: j.meta.job_number, status: j.card.status, store: j.meta.store, fault_reported: j.meta.fault_reported, scheduled_date: j.meta.scheduled_date, open: j.card.status !== 'closed' }))
      .sort((a, c) => Number(!a.open) - Number(!c.open) || c.scheduled_date.localeCompare(a.scheduled_date));
    if (p === '/me/quote-options') return ok({ stores: this.office().o.stores.map(x => ({ id: x.id, name: x.name, address: x.address, client: x.client })), jobs: mine });
    const d = this.docs();
    if (req.method === 'GET') return ok(d.myQuotes(id));
    const st = this.stock().s;
    const r = d.techQuote(b, { id, name: this.who.name }, mine, sid => { const it = st.items.find(x => x.id === sid); return it ? { description: it.description, sellingPriceCents: it.sellingPriceCents ?? null } : null; });
    this.persist(this.state);
    return r.ok ? ok(r.body, r.status ?? 200) : refuse(r.status, ...r.reasons);
  }

  /** Settings → Phone menus: which tabs each position has pinned to the bottom of the phone. */
  private menuRoute(p: string, req: Request, b: any): Response | null {
    if (p !== '/me/phone-menu' && !p.startsWith('/phone-menus')) return null;
    const level = this.office().levelOf(this.who.id) ?? this.who.level;
    const canEdit = ['admin', 'director', 'creator'].includes(level);
    const menus = this.state.phoneMenus ?? {};
    if (p === '/me/phone-menu') return ok({ pinned: menus[level] ?? null, canEdit });
    if (!canEdit) return refuse(403, 'only the CEO or an admin arranges the phone menus');
    if (p === '/phone-menus' && req.method === 'GET') {
      return ok({ maxPinned: MAX_PINNED, positions: MENU_LEVELS.map(l => ({ level: l, label: MENU_LABEL[l], app: APP_OF[l], tabs: MENU_TABS[APP_OF[l]!], usual: usualTabs(l), pinned: menus[l] ?? null, updatedAt: null })) });
    }
    const m = p.match(/^\/phone-menus\/([^/]+)$/);
    if (m && req.method === 'PUT') {
      const app = APP_OF[m[1] as LoginLevel];
      if (!app) return refuse(400, 'that position has no tab bar');
      const want: string[] | null = Array.isArray(b?.pinned) ? b.pinned : null;
      const pinned = want ? cleanPinned(app, want) : null;
      if (want && (pinned!.length !== want.length || !pinned!.length)) return refuse(400, 'each tab once, up to four, and only tabs that position can have');
      const next = { ...menus };
      if (pinned) next[m[1]] = pinned; else delete next[m[1]];
      this.state.phoneMenus = next;
      this.persist(this.state);
      return ok({ level: m[1], pinned });
    }
    return null;
  }
  private officeRoute(p: string, req: Request, b: any): Response | null {
    let m: RegExpMatchArray | null;
    const office = ['admin', 'accounts', 'management', 'hr', 'director', 'creator'].includes(this.who.level);
    const isOffice = p.startsWith('/office') || p === '/jobs' || p.startsWith('/flags') && !p.endsWith('/explain') || p.startsWith('/vehicles/inspections') || p === '/access/positions'
      || p === '/people' || /^\/people\/[^/]+(\/profile|\/terminate|\/record(\/[^/]+)?|\/login(\/(code|stop|allow|sign-out))?)?$/.test(p) || /^\/access\/users\/[^/]+\/(position|work|trade)$/.test(p) || /^\/jobs\/[^/]+\/(assign|cancel|changes)$/.test(p) || (/^\/jobs\/[^/]+$/.test(p) && req.method === 'PATCH');
    if (!isOffice) return null;
    if (!office) return refuse(403, 'office only');
    if (!this.does('jobs') && !this.does('jobcards') && (p === '/office/overview' || p === '/jobs' || p === '/office/stores' || p === '/office/technicians') && req.method === 'GET') return refuse(403, 'office only');
    const o = this.office();
    const done = (r: Parameters<DemoTransport['fleetResult']>[0]) => this.fleetResult(r);
    const q = new URLSearchParams(req.path.split('?')[1] ?? '');
    const need = (area: Parameters<DemoTransport['does']>[0], what: string) => (this.does(area) ? null : refuse(403, what));
    if (p === '/office/overview') { const v = o.overview(); return ok(this.does('flags') ? v : { ...v, flags: null, handoversAwaitingApproval: 0 }); }
    if ((p === '/jobs' && req.method === 'POST') || /\/(assign|cancel)$/.test(p) || req.method === 'PATCH') { const n = need('jobs', 'opening and editing jobs is not part of your work'); if (n) return n; }
    if (p.startsWith('/flags') || p.startsWith('/vehicles/inspections')) { const n = need('flags', 'flags and approvals are not part of your work'); if (n) return n; }
    if (p === '/office/stores' && req.method === 'POST') { const n = need('stores', 'adding stores is not part of your work'); if (n) return n; }
    const manages = this.does('access');
    // The CEO and HR edit profiles, end employment and keep the terminated staff.
    const hrOrCeo = manages || this.does('hr');
    // Logins and passwords (setup codes) are for Admin and the CEO only.
    const loginsToo = manages || (this.office().levelOf(this.who.id) ?? this.who.level) === 'admin';
    if (p === '/people' && req.method === 'POST') {
      if (!hrOrCeo) return refuse(403, 'only HR or the CEO looks after logins');
      const vn = this.vans();
      const dept = b.departmentId ? vn.v.departments.find(d => d.id === b.departmentId) : undefined;
      if (b.departmentId && !dept) return refuse(400, 'unknown department');
      const lvl = this.office().levelOf(this.who.id) ?? this.who.level;
      const r = o.addPerson(b, manages, lvl === 'creator', dept?.name ?? '');
      if (r.ok && dept) vn.v.memberOf[(r.body as { id: string }).id] = dept.id;
      return done(r);
    }
    if (p === '/people') {
      const list = o.people(manages, manages || this.does('hr')) as ReturnType<DemoOffice['people']> & { canAdd?: boolean; addPositions?: string[] };
      if (hrOrCeo) {
        const L = this.loginBook();
        const lvl = this.office().levelOf(this.who.id) ?? this.who.level;
        list.canAdd = true;
        list.addPositions = manages ? Object.keys(POSITION_LABEL).filter(x => x !== 'creator' || lvl === 'creator') : HR_POSITIONS;
      }
      // Logins and passwords: Admin and the CEO.
      (list as { canLogins?: boolean }).canLogins = loginsToo;
      if (hrOrCeo || loginsToo) { const L = this.loginBook(); list.people = list.people.map(x => ({ ...x, login: L.listState(x.id) })); }
      return ok(list);
    }
    if ((m = p.match(/^\/people\/([^/]+)\/login(?:\/(code|stop|allow|sign-out))?$/))) {
      if (!loginsToo) return refuse(403, 'only Admin or the CEO looks after logins and passwords');
      const L = this.loginBook();
      const id = m[1];
      const left = (this.state.office!.leavers ?? []).some(l => l.person.id === id);
      const target = this.state.office!.people.find(x => x.id === id);
      if (!target && !left) return refuse(404, 'no such person');
      const lvl = this.office().levelOf(this.who.id) ?? this.who.level;
      const may = !!target && L.manages({ id: this.who.id, level: lvl, ceo: manages }, target);
      if (!m[2]) return ok(L.info(id, may, id === this.who.id, left));
      if (id === this.who.id) return refuse(403, 'change your own password under Settings → My password');
      if (!may) return refuse(403, manages ? "only the Creator looks after the Creator's login" : `the admin looks after everyone's login except the directors' and the CEO's; ${target?.full_name.split(' ')[0] ?? 'this'}'s is the CEO's`);
      const r = m[2] === 'code' ? L.issueCode(id, this.who.name, REAL ? REAL.company.name : 'ZSP')
        : m[2] === 'stop' ? L.stop(id, this.who.name) : m[2] === 'allow' ? L.allow(id, this.who.name) : L.signOutAll(id, this.who.name);
      return done(r);
    }
    if (p === '/people/terminated') {
      if (!hrOrCeo) return refuse(403, 'terminated staff are kept by HR');
      return ok((this.state.office!.leavers ?? []).map(l => ({ id: l.person.id, full_name: l.person.full_name, photo_id: null, date: l.date, reason: l.reason, reasonLabel: END_REASONS[l.reason], note: l.note,
        position: l.position, department: l.department, by: l.by, items_on_name: l.onName.kit.length + l.onName.stock.length })));
    }
    if ((m = p.match(/^\/people\/([^/]+)\/terminate$/))) {
      if (!hrOrCeo) return refuse(403, "only HR or the CEO ends someone's employment");
      if (m[1] === this.who.id) return refuse(409, 'you cannot end your own employment here');
      const id = m[1];
      const person = this.state.office!.people.find(x => x.id === id);
      const openJobs = this.state.jobs.filter(j => !['closed', 'cancelled'].includes(j.card.status) && (j.meta.lead_id ?? 'me') === id).map(j => j.meta.job_number);
      const st = this.stock().s;
      const kit = (st.kit ?? []).filter(k => k.userId === id && k.status === 'issued').map(k => ({ kind: k.kind, name: k.name, detail: k.detail, qty: k.qty }));
      const stock = st.holdings.filter(h => h.qty > 0 && ((h.tech ?? 'me') === id || h.tech === person?.full_name))
        .map(h => { const it = st.items.find(i => i.id === h.stockItemId); return { code: it?.code ?? '', description: it?.description ?? '', qty: h.qty }; });
      const vn = this.vans();
      const dept = vn.deptOf(id)?.name ?? null;
      const r = terminate(this.state.office!, id, b, this.who.name, openJobs, { kit, stock }, dept);
      if (r.ok) { for (const d of vn.v.departments) if (d.managerId === id) d.managerId = null; vn.v.memberOf[id] = null; }
      return done(r);
    }
    if ((m = p.match(/^\/people\/([^/]+)\/record(?:\/([^/]+))?$/))) {
      if (!this.does('hr') || m[1] === this.who.id) return refuse(403, 'staff records are for the CEO and HR only');
      if (req.method === 'GET') return done(o.record(m[1], true));
      if (req.method === 'POST') return done(o.addRecord(m[1], this.who.id, b));
      if (req.method === 'DELETE' && m[2]) return done(o.deleteRecord(m[1], m[2], this.who.id));
    }
    if ((m = p.match(/^\/people\/([^/]+)\/profile$/))) return hrOrCeo ? done(o.saveProfile(m[1], b)) : refuse(403, 'only HR or the CEO edits profiles');
    if ((m = p.match(/^\/people\/([^/]+)$/))) {
      const f = this.fleet();
      const spots = f.positions();
      const rec = this.does('hr') && m[1] !== this.who.id;
      const res = o.profile(m[1], hrOrCeo, { record: { read: rec, write: rec }, kit: { read: true, write: this.does('stockroom') } }, f.technicians(this.thaboIn()), v => spots.find(x => x.id === v) ?? null);
      if (res.ok) {
        const vn = this.vans(); const d = vn.deptOf(m[1]);
        Object.assign(res.body as object, { department: d?.name ?? null, departmentId: d?.id ?? null, departmentLogo: d?.logoPhotoId ?? null, manager: d?.managerId ? o.name(d.managerId) : null, team: vn.team(m[1]) });
        const left = (this.state.office!.leavers ?? []).find(l => l.person.id === m![1]);
        const lv = (res.body as { login_level: string }).login_level;
        Object.assign(res.body as object, left
          ? { canEdit: false, canTerminate: false, status: 'left', department: left.department, termination: hrOrCeo ? { date: left.date, reason: left.reason, note: left.note, position: left.position, department: left.department, on_name: left.onName, by: left.by } : { date: left.date } }
          : { canTerminate: hrOrCeo && !['director', 'creator'].includes(lv) && m[1] !== this.who.id, termination: null });
      }
      return done(res);
    }
    if ((m = p.match(/^\/access\/users\/([^/]+)\/work$/))) return manages ? done(o.setWork(m[1], b.area, !!b.on)) : refuse(403, 'only whoever manages access');
    if ((m = p.match(/^\/access\/users\/([^/]+)\/trade$/))) return manages || this.does('hr') ? done(o.setTrade(m[1], b.trade)) : refuse(403, 'only the CEO or HR sets trades');
    if ((m = p.match(/^\/jobs\/([^/]+)\/changes$/))) return ok((this.state.office!.jobChanges ?? []).filter(x => x.jobId === m![1]).sort((a, c) => c.changed_at.localeCompare(a.changed_at)));
    if ((m = p.match(/^\/jobs\/([^/]+)\/cancel$/))) {
      const j = this.findJob(m[1]);
      if (!j) return refuse(404, 'no such job');
      if (!b.note || b.note.trim().length < 5) return refuse(400, 'say why the job is cancelled');
      if (j.card.status === 'closed' || (j.card.status as string) === 'cancelled') return refuse(409, `the job is already ${j.card.status}`);
      if (j.card.status === 'in_progress') return refuse(409, 'the technician is working on it: he must Continue later first');
      const by = b.by === 'client' || b.by === 'us' ? b.by : null;
      this.logChange(j.meta.id, 'status', j.card.status, by === 'client' ? 'cancelled by client' : by === 'us' ? 'cancelled by us' : 'cancelled', b.note.trim());
      (j.card as { status: string }).status = 'cancelled';
      Object.assign(j.meta, { cancelled_by_party: by, cancel_note: b.note.trim() });
      this.persist(this.state);
      return ok({ jobId: j.meta.id, status: 'cancelled' });
    }
    if ((m = p.match(/^\/jobs\/([^/]+)$/)) && req.method === 'PATCH') {
      const j = this.findJob(m[1]);
      if (!j) return refuse(404, 'no such job');
      const st = j.card.status as string;
      if (st === 'cancelled') return refuse(409, 'the job is cancelled');
      const started = j.card.visits.length > 0;
      const refused: string[] = [];
      if (st === 'closed' && Object.keys(b).some(k => !['clientOrderRef', 'reason'].includes(k) && b[k] !== undefined)) refused.push('a closed job can only have its client order number changed');
      if (started && b.storeId && b.storeId !== j.meta.store_id) refused.push('the store cannot change once the technician has been there: cancel and open a new job');
      if (started && b.jobType && b.jobType !== j.meta.job_type) refused.push('the job type cannot change once work has started');
      if (refused.length) return refuse(409, ...refused);
      const ch: [string, string | null, string | null][] = [];
      if (b.storeId && b.storeId !== j.meta.store_id) {
        const sNew = o.store(b.storeId);
        if (!sNew) return refuse(400, 'unknown store');
        ch.push(['store', j.meta.store, sNew.name]);
        Object.assign(j.meta, { store_id: sNew.id, store: sNew.name, store_address: sNew.address, store_lat: sNew.lat, store_lng: sNew.lng });
        j.card.store = { lat: sNew.lat as number, lng: sNew.lng as number, geofenceM: sNew.geofence_m };
      }
      if (b.jobType && b.jobType !== j.meta.job_type) { ch.push(['job type', j.meta.job_type, b.jobType]); j.meta.job_type = b.jobType; j.card.jobType = b.jobType; }
      if (b.priority && b.priority !== j.meta.priority) { ch.push(['priority', j.meta.priority, b.priority]); j.meta.priority = b.priority; }
      if (b.faultReported && b.faultReported.trim() !== j.meta.fault_reported) {
        ch.push(['fault reported', j.meta.fault_reported, b.faultReported.trim()]); j.meta.fault_reported = b.faultReported.trim();
        if (!started) j.card.items[0].title = b.faultReported.trim().slice(0, 200);
      }
      if (b.clientOrderRef !== undefined && (b.clientOrderRef || null) !== j.meta.client_order_ref) { ch.push(['client order number', j.meta.client_order_ref, b.clientOrderRef || null]); j.meta.client_order_ref = b.clientOrderRef || null; }
      if (b.scheduledDate && b.scheduledDate !== j.meta.scheduled_date) { ch.push(['date', j.meta.scheduled_date, b.scheduledDate]); j.meta.scheduled_date = b.scheduledDate; }
      for (const step of (b.addMaintenanceSteps ?? []) as string[]) j.meta.checklist.push({ id: id('chk'), step, done: false });
      if ((b.addMaintenanceSteps ?? []).length) ch.push(['checklist', null, `added: ${b.addMaintenanceSteps.join('; ')}`]);
      if (ch.length && started && st !== 'closed' && !(b.reason && b.reason.trim().length >= 5)) return refuse(400, 'the technician has started: say why it changes');
      for (const [f, a, c] of ch) this.logChange(j.meta.id, f, a, c, b.reason ?? null);
      this.persist(this.state);
      return ok({ jobId: j.meta.id, changes: ch.map(([field, old, nw]) => ({ field, old, new: nw })) });
    }
    if (p === '/office/overview') return ok(o.overview());
    if (p === '/office/stores' && req.method === 'GET') return ok(o.stores());
    if (p === '/office/stores') return done(o.addStore(b));
    if ((m = p.match(/^\/office\/stores\/([^/]+)\/pin$/))) return this.does('stores') ? done(o.pin(m[1], b.action === 'confirm' ? 'confirm' : 'lookup', this.who.name)) : refuse(403, 'you cannot change stores');
    if ((m = p.match(/^\/office\/stores\/([^/]+)$/)) && req.method === 'PUT') return this.does('stores') ? done(o.editStore(m[1], b)) : refuse(403, 'you cannot change stores');
    if (p === '/office/technicians') return ok(o.technicians(id => (id === 'me' ? this.state.vehicle?.registration ?? null : this.fleet().technicians(null).find(t => t.id === id)?.registration ?? null)));
    if (p === '/jobs' && req.method === 'GET') {
      const d = this.docs();
      this.repairs();
      return ok(o.jobs(q.get('status')).map(j => {
        const dj = this.findJob(j.id);
        const r = dj ? this.repairView(dj) : null;
        return { ...j, ...d.billingOf(j.id), ...(r ? { machine_at: r.machine_at, loans_out: r.loans_out, ready_to_deliver: r.ready_to_deliver } : {}) };
      }));
    }
    if (p === '/jobs') return this.newOfficeJob(o, b);
    if ((m = p.match(/^\/jobs\/([^/]+)\/assign$/))) {
      const j = this.findJob(m[1]);
      if (!j) return refuse(404, 'no such job');
      if (!b.reason || b.reason.trim().length < 5) return refuse(400, 'say why it moves');
      if (j.card.status === 'closed') return refuse(409, 'the job is closed');
      if (j.card.status === 'in_progress' && b.leadTechnicianId !== (j.meta.lead_id ?? 'me')) return refuse(409, 'the technician is busy on this job: he must Continue later before it can move');
      if ((b.helperIds ?? []).includes(b.leadTechnicianId)) return refuse(400, 'every helper must be another active technician');
      Object.assign(j.meta, { lead_id: b.leadTechnicianId, lead_technician: o.name(b.leadTechnicianId), helper_ids: b.helperIds ?? [], i_am_lead: b.leadTechnicianId === 'me', scheduled_date: b.scheduledDate ?? j.meta.scheduled_date });
      this.persist(this.state);
      return ok({ jobId: j.meta.id, leadTechnicianId: b.leadTechnicianId });
    }
    if (p === '/flags') return ok(o.flags(q.get('status') ?? 'unresolved'));
    if ((m = p.match(/^\/flags\/([^/]+)\/resolve$/))) return done(o.resolve(m[1], b.note));
    if (p === '/vehicles/inspections') return ok(o.inspections(q.get('status')));
    if ((m = p.match(/^\/vehicles\/inspections\/([^/]+)\/decide$/))) {
      if (!b.approve && !(b.note && b.note.trim().length >= 5)) return refuse(400, 'say why the handover is rejected');
      const status = b.approve ? 'approved' : 'rejected';
      if (m[1] === 'insp-me' && this.state.vehicle) { this.state.vehicle.handover_status = status; this.persist(this.state); return ok({ id: m[1], status }); }
      const i = this.state.office!.inspections.find(x => x.id === m![1]);
      if (!i) return refuse(404, 'no such inspection');
      if (i.status !== 'awaiting_approval') return refuse(409, 'this handover is not waiting for approval');
      Object.assign(i, { status, decided_at: new Date().toISOString(), decision_note: b.note ?? null });
      this.persist(this.state);
      return ok({ id: m[1], status });
    }
    if (p === '/access/positions') return manages ? ok(o.positions()) : refuse(403, 'only whoever manages access');
    if ((m = p.match(/^\/access\/users\/([^/]+)\/position$/))) return manages || this.does('hr') ? done(o.setPosition(m[1], b.position, this.who.level, manages, this.who.id)) : refuse(403, 'only the CEO or HR sets positions');
    return null;
  }

  private docs(): DemoDocs {
    this.office();
    const d = this.state.docs ?? (this.state.docs = seedDocs());
    const items = this.stock().s.items;
    return new DemoDocs(d, {
      jobs: this.state.jobs as never,
      stores: this.state.office!.stores,
      minutesOf: id => { const j = this.findJob(id); return j ? J.jobMinutes(j.card) : 0; },
      stockUsed: n => {
        const used = (this.stock().s.activity ?? []).filter(a => a.kind === 'use_on_job' && a.jobNumber === n);
        const by = new Map<string, { stockItemId: string; description: string; qty: number; sellingPriceCents: number | null; costCents: number | null; code: string; unit: string }>();
        for (const a of used) {
          const it = items.find(i => i.code === a.code);
          if (!it) continue;
          const x = by.get(it.id) ?? { stockItemId: it.id, description: it.description, qty: 0, sellingPriceCents: it.sellingPriceCents ?? null, costCents: it.costCents ?? null, code: it.code, unit: it.unit };
          x.qty += a.qty; by.set(it.id, x);
        }
        return [...by.values()];
      },
      stockCode: id => { const it = items.find(i => i.id === id); return it ? { code: it.code, unit: it.unit } : null; },
      // Driving there and back: Go to Arrived (twice); km estimated from the workshop by road (no tracker in the test drive).
      travelOf: jobId => {
        const j = this.findJob(jobId);
        if (!j) return null;
        const visits = (j.card.visits as { place?: string; goAt?: string; arrivedAt?: string }[]).filter(v => v.place !== 'workshop' && v.goAt && v.arrivedAt);
        if (!visits.length) return null;
        const minutes = visits.reduce((n, v) => n + Math.max(0, (Date.parse(v.arrivedAt!) - Date.parse(v.goAt!)) / 60_000), 0) * 2;
        const st = this.state.office!.stores.find(x => x.id === (j.meta as { store_id?: string }).store_id);
        const w = this.state.repairs?.workshop ?? { lat: -28.7466, lng: 32.0383 };
        const km = st?.lat != null && st?.lng != null ? CR.kmBetween(w, { lat: st.lat, lng: st.lng }) * CR.ROAD_FACTOR * 2 * visits.length : 0;
        return { km: Math.round(km), minutes: Math.round(minutes), kmEstimated: true };
      },
      name: this.who.name,
      openJob: (storeId, fault, leadId, date, priority, ref) => {
        const st = this.state.office!.stores.find(x => x.id === storeId)!;
        const n = Math.max(...this.state.jobs.map(j => j.meta.job_number)) + 1;
        const j = officeJob(n, 'follow_up', priority, st, fault, { id: leadId, name: this.office().name(leadId) }, date, [], ref ?? undefined);
        this.state.jobs.push(j);
        return { id: j.meta.id, job_number: n };
      },
    });
  }

  private docRoute(p: string, req: Request, b: any): Response | null {
    let m: RegExpMatchArray | null;
    const isDoc = /^\/jobs\/[^/]+\/no-charge$/.test(p) || p.startsWith('/quotes') || p.startsWith('/invoices') || p.startsWith('/pastel') || p.startsWith('/office/supplier-invoices')
      || /^\/office\/clients\/[^/]+\/rates$/.test(p) || ['/office/company', '/office/rates', '/office/to-invoice'].includes(p);
    if (!isDoc) return null;
    if (!['admin', 'accounts', 'management', 'director', 'creator', 'stockroom'].includes(this.who.level) || !this.does('documents')) return refuse(403, 'quotes and invoices are not part of your work');
    const d = this.docs();
    const done = (r: Parameters<DemoTransport['fleetResult']>[0]) => this.fleetResult(r);
    const q = new URLSearchParams(req.path.split('?')[1] ?? '');
    const get = req.method === 'GET';
    // Accounts: supplier invoices and the suppliers' Pastel codes.
    const books = this.does('books');
    const sup = () => new DemoSuppliers((this.state.suppliers ??= seedSuppliers()), this.stock().s, this.who.name);
    const vatPct = Number((this.state.docs?.profile as { vat_pct?: number } | null)?.vat_pct ?? 15);
    if (p.startsWith('/office/supplier-invoices') || p.startsWith('/pastel/suppliers') || (p === '/pastel/ready' && q.get('kind') === 'supplier_invoice') || (p === '/pastel/batches' && b?.kind === 'supplier_invoice')) {
      if (!books) return refuse(403, 'supplier invoices are for Accounts');
    }
    if (p === '/office/supplier-invoices' && get) { const r = sup().list(q.get('view') ?? 'to_check'); this.persist(this.state); return ok(r); }
    if (p === '/office/supplier-invoices/scan') {
      const u = req.upload;
      if (!u) return refuse(400, 'no file');
      const photoId = id('photo');
      const r = sup().scan(photoId, u.mime === 'image/jpg' ? 'image/jpeg' : u.mime);
      this.persist(this.state);
      return done(r);
    }
    if ((m = p.match(/^\/office\/supplier-invoices\/([^/]+)\/check$/))) { const r = sup().check(m[1], b.action, b.note); this.persist(this.state); return done(r); }
    if ((m = p.match(/^\/office\/supplier-invoices\/([^/]+)$/))) {
      const r = get ? sup().detail(m[1]) : req.method === 'DELETE' ? sup().remove(m[1]) : sup().save(m[1], b);
      this.persist(this.state);
      return done(r);
    }
    if (p === '/pastel/suppliers') return ok(sup().suppliers());
    if ((m = p.match(/^\/pastel\/suppliers\/([^/]+)$/))) { const r = sup().setCode(decodeURIComponent(m[1]), b.code); this.persist(this.state); return done(r); }
    // Each client's own rates and mark-up: the CEO and Accounts.
    if ((m = p.match(/^\/office\/clients\/([^/]+)\/rates$/))) {
      const cid = decodeURIComponent(m[1]);
      if (get) return ok(d.clientRates(cid, books));
      if (!books) return refuse(403, "only the CEO and Accounts set a client's rates and mark-up");
      const r = req.method === 'DELETE' ? d.clearClientRates(cid) : d.setClientRates(cid, b);
      this.persist(this.state);
      return done(r);
    }
    if (p === '/office/company' && get) return ok(d.company());
    if (p === '/office/company') {
      if (!this.does('prices')) return refuse(403, 'only the CEO (prices and rates) sets the company details');
      if (b.logoPhotoId) this.state.logoPhotoId = b.logoPhotoId;
      return done(d.setCompany(b));
    }
    if (p === '/office/rates') return this.does('prices') ? done(d.setRates(b)) : refuse(403, 'only the CEO sets rates');
    if (p === '/office/to-invoice') return ok(d.toInvoice());
    if ((m = p.match(/^\/jobs\/([^/]+)\/no-charge$/))) {
      if (!this.does('documents')) return refuse(403, 'you cannot prepare quotes and invoices');
      const r = req.method === 'DELETE' ? d.clearNoCharge(m[1]) : d.setNoCharge(m[1], b.reason, b.note, this.who.name);
      if (r.ok) { const j = this.findJob(m[1]); const nc = r.body as { noChargeReason: string | null }; this.logChange(m[1], 'billing', nc.noChargeReason ? 'to invoice' : 'no charge', nc.noChargeReason ? `no charge (${NO_CHARGE_REASONS[nc.noChargeReason as keyof typeof NO_CHARGE_REASONS]})` : 'to invoice', b.note ?? null); void j; }
      this.persist(this.state);
      return r.ok ? ok(r.body) : refuse(r.status, ...r.reasons);
    }
    if (p === '/quotes' && get) return ok(d.quotes(q.get('status')));
    if (p === '/quotes') return done(d.newQuote(b));
    if ((m = p.match(/^\/quotes\/([^/]+)$/))) return get ? done(d.quote(m[1])) : done(d.editQuote(m[1], b));
    if ((m = p.match(/^\/quotes\/([^/]+)\/send$/))) return done(d.sendQuote(m[1]));
    if ((m = p.match(/^\/quotes\/([^/]+)\/accept$/))) return done(d.acceptQuote(m[1], b));
    if ((m = p.match(/^\/quotes\/([^/]+)\/decline$/))) return done(d.declineQuote(m[1], b.note));
    if ((m = p.match(/^\/quotes\/([^/]+)\/cancel$/))) return done(d.cancelQuote(m[1], b.note));
    if (p === '/invoices' && get) return ok(d.invoices(q.get('status')));
    if (p === '/invoices') return done(d.newInvoice(b.jobId));
    if ((m = p.match(/^\/invoices\/([^/]+)$/))) return get ? done(d.invoice(m[1])) : done(d.editInvoice(m[1], b));
    if ((m = p.match(/^\/invoices\/([^/]+)\/send$/))) return done(d.sendInvoice(m[1]));
    if ((m = p.match(/^\/invoices\/([^/]+)\/paid$/))) return done(d.paid(m[1], b.ref));
    if ((m = p.match(/^\/invoices\/([^/]+)\/cancel$/))) return done(d.cancelInvoice(m[1], b.note));
    if ((m = p.match(/^\/invoices\/([^/]+)\/credit$/))) return done(d.credit(m[1], b, this.who.name));
    if (p === '/pastel/settings') return get ? ok(d.pastelSettings()) : done(d.setPastel(b));
    if (p === '/pastel/clients') return ok(d.clients());
    if ((m = p.match(/^\/pastel\/clients\/([^/]+)$/))) return done(d.setClientCode(decodeURIComponent(m[1]), b.code));
    if (p === '/pastel/ready') return ok(d.ready((q.get('kind') as 'invoice' | 'quote' | 'credit' | 'supplier_invoice') ?? 'invoice', sup().pastel(vatPct)));
    if (p === '/pastel/batches' && get) return ok(d.batches());
    if (p === '/pastel/batches') { const r = d.batch(b.kind, this.who.name, sup().pastel(vatPct)); this.persist(this.state); return done(r); }
    if ((m = p.match(/^\/pastel\/batches\/([^/]+)\/file$/))) { const f = d.batchFile(m[1]); return f ? ok(f) : refuse(404, 'no such batch'); }
    return null;
  }

  private queries() {
    if (!this.state.queries) {
      const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
      this.state.queries = [
        { id: 'q-1', from: 'admin-1', to: 'me', job_id: 'job-10228', subject: 'Harbour Deli access card', created_at: ago(1), read: { 'admin-1': ago(1) },
          messages: [{ id: 'qm-1', from: 'admin-1', body: 'Did you get the access card back from the Harbour Deli manager yesterday? They are asking for it.', at: ago(1) }] },
        { id: 'q-2', from: 'me', to: 'tech-2', job_id: null, subject: 'Spare 25A contactor', created_at: ago(20), read: { me: ago(19), 'tech-2': ago(19) },
          messages: [{ id: 'qm-2', from: 'me', body: 'Sipho, do you have a spare 25A contactor in your van?', at: ago(20) },
                     { id: 'qm-3', from: 'tech-2', body: 'Yes, one. Meet me at the yard at 4.', at: ago(19) }] },
      ];
    }
    return this.state.queries;
  }

  private queryRoute(p: string, req: Request, b: any): Response | null {
    let m: RegExpMatchArray | null;
    if (!(p === '/me/queries' || p.startsWith('/queries'))) return null;
    const me = this.who.id;
    const o = this.office();
    const may = this.who.level === 'technician' || this.does('jobs') || this.who.level === 'creator';
    const list = this.queries();
    if (p === '/queries/people') return may ? ok(o.o.people.filter(x => x.login_level === 'technician' && x.id !== me).map(x => ({ id: x.id, full_name: x.full_name }))) : refuse(403, 'you cannot send queries');
    if (p === '/me/queries') {
      const out = list.filter(q => q.from === me || q.to === me).map(q => {
        const readAt = q.read[me] ?? '';
        const msgs = q.messages.map(x => ({ ...x, name: o.name(x.from) }));
        const job = q.job_id ? this.findJob(q.job_id) : null;
        return {
          id: q.id, subject: q.subject, created_at: q.created_at, job_id: q.job_id, job_number: job?.meta.job_number ?? null,
          from_user: q.from, from_name: o.name(q.from), to_user: q.to, to_name: o.name(q.to), messages: msgs,
          unread: msgs.filter(x => x.from !== me && x.at > readAt).length, waitingForAnswer: msgs.at(-1)?.from === me, lastAt: msgs.at(-1)?.at ?? q.created_at,
        };
      }).sort((a, c) => c.lastAt.localeCompare(a.lastAt));
      return ok({ queries: out, unread: out.reduce((n, q) => n + q.unread, 0) });
    }
    const now = new Date().toISOString();
    if (p === '/queries' && req.method === 'POST') {
      if (!may) return refuse(403, 'you cannot send queries');
      const to = o.o.people.find(x => x.id === b.toUserId && x.login_level === 'technician');
      const missing = [!to ? 'which technician' : null, !b.subject || b.subject.trim().length < 3 ? 'what it is about' : null, !b.body || b.body.trim().length < 2 ? 'the question' : null].filter(Boolean) as string[];
      if (b.toUserId === me) return refuse(400, 'you cannot send a query to yourself');
      if (missing.length) return refuse(400, ...missing);
      const q = { id: id('q'), from: me, to: b.toUserId, job_id: b.jobId ?? null, subject: b.subject.trim(), created_at: now, read: { [me]: now }, messages: [{ id: id('qm'), from: me, body: b.body.trim(), at: now }] };
      list.unshift(q);
      this.persist(this.state);
      return ok({ id: q.id }, 201);
    }
    if ((m = p.match(/^\/queries\/([^/]+)\/(messages|read)$/))) {
      const q = list.find(x => x.id === m![1]);
      if (!q) return refuse(404, 'no such query');
      if (q.from !== me && q.to !== me) return refuse(403, 'not your query');
      if (m[2] === 'messages') {
        if (!b.body || !b.body.trim()) return refuse(400, 'the answer');
        q.messages.push({ id: id('qm'), from: me, body: b.body.trim(), at: now });
      }
      q.read[me] = new Date(Date.now() + 1).toISOString();
      this.persist(this.state);
      return ok({ id: q.id }, m[2] === 'messages' ? 201 : 200);
    }
    return null;
  }

  private logChange(jobId: string, field: string, oldV: string | null, newV: string | null, reason: string | null) {
    const o = this.state.office!;
    (o.jobChanges ??= []).push({ jobId, changed_at: new Date().toISOString(), by: this.who.name, field, old_value: oldV, new_value: newV, reason });
  }

  private workshop(): DemoWorkshop {
    this.stock();
    const st = this.state.stockControl!;
    return new DemoWorkshop(this.state.workshop ?? (this.state.workshop = seedWorkshop(st)), st);
  }

  private vans(): DemoVan {
    const fresh = !this.state.vanStock;
    const v = this.state.vanStock ?? (this.state.vanStock = seedVan());
    this.office(); this.stock();
    const dv = new DemoVan(v, this.state.office!, this.state.stockControl!, this.state.flags);
    if (fresh) { dv.checkAll('the system'); this.persist(this.state); }
    return dv;
  }

  private times(): DemoTimes {
    const o = this.office();
    const real = this.state.jobs.map(j => ({ jobId: j.meta.id, jobNumber: j.meta.job_number, store: j.meta.store, fault: j.meta.fault_reported,
      techIds: [j.meta.lead_id ?? 'me', ...(j.meta.helper_ids ?? [])], visits: j.card.visits as never }));
    return new DemoTimes(this.state.times ?? (this.state.times = { submitted: {} }), o.o, this.state.flags, real);
  }

  private stock(): DemoStock {
    const st = this.state.stockControl ?? (this.state.stockControl = seedStock());
    const ds = new DemoStock(st, jobId => {
      if (jobId === 'job-10190') return { number: 10190, status: 'closed', store: 'Spar Arboretum' };
      if (jobId === 'job-10220') return { number: 10220, status: 'in_progress', store: 'Boxer Esikhawini' };
      const j = this.findJob(jobId);
      return j ? { number: j.meta.job_number, status: j.card.status, store: j.meta.store } : null;
    });
    ds.tick();
    return ds;
  }

  /** The demo has one vehicle, ND 412-778, with sticker ZSP-V07 (any other sticker code also works). */
  private isDemoVehicle(code: string) {
    // A licence disc must be ND 412-778's; any sticker code or that registration is accepted.
    if (code.trim().startsWith('%')) return registrationCandidates(code).includes(normReg('ND 412-778'));
    return code.trim().length >= 3;
  }

  private thaboIn() {
    const v = this.state.vehicle;
    return v ? { vehicle_id: v.id, mode: v.mode } : null;
  }

  private fleet(): DemoFleet {
    const fl = this.state.fleet ?? (this.state.fleet = seedFleet());
    if (!fl.bookings) { const fresh = seedFleet(); Object.assign(fl, { bookings: fresh.bookings, spots: fresh.spots, crew: fresh.crew }); }
    if (!fl.checks) fl.checks = seedFleet().checks;
    return new DemoFleet(fl);
  }

  private fleetResult(r: { ok: true; body: unknown; status?: number } | { ok: false; status: number; reasons: string[] }): Response {
    this.persist(this.state);
    return r.ok ? ok(r.body, r.status ?? 200) : refuse(r.status, ...r.reasons);
  }

  private van() {
    return this.state.van ?? (this.state.van = { lastDriverMe: false, odometerKm: 87450, problems: ['windscreen_mirrors'] });
  }

  private stockResult(r: { ok: true; body: unknown } | { ok: false; status: number; reasons: string[] }, status = 200): Response {
    if (r.ok) this.vans().checkAll(this.who.name);
    this.persist(this.state);
    return r.ok ? ok(r.body, status) : refuse(r.status, ...r.reasons);
  }

  private findJob(jobId: string) { return this.state.jobs.find(j => j.meta.id === jobId); }

  private rule(jobId: string, fn: (c: J.JobCard) => J.Result, after?: (j: DemoJob, r: Extract<J.Result, { ok: true }>) => void): Response {
    const j = this.findJob(jobId);
    if (!j) return refuse(404, 'no such job');
    if (this.state.repairs) { const w = this.state.repairs.workshop; j.card.workshop = { lat: w.lat, lng: w.lng, geofenceM: w.geofence_m }; }
    const r = fn(j.card);
    if (!r.ok) return refuse(409, ...r.reasons);
    j.card = r.card;
    after?.(j, r);
    this.persist(this.state);
    return ok(this.view(j));
  }

  async send(req: Request): Promise<Response> {
    if (this.noSignal) throw new Offline('demo: no signal');
    await new Promise(r => setTimeout(r, 25));
    if (req.upload && req.method === 'POST') {
      const u = req.upload.fileUri;
      const bytes = u.startsWith('data:') ? Math.round((u.length - u.indexOf(',') - 1) * 3 / 4) : 0;
      if (bytes) { (this.state.photoSizes ??= []).unshift({ kind: req.upload.fields.kind ?? 'photo', bytes, at: new Date().toISOString() }); this.state.photoSizes.splice(400); }
    }
    if (req.path === '/company/storage') {
      const lvl = this.state.office ? this.office().levelOf(this.who.id) ?? this.who.level : this.who.level;
      if (!['director', 'creator'].includes(lvl)) return refuse(403, 'the storage figures are for the CEO');
      const all = this.state.photoSizes ?? [];
      const since = Date.now() - 30 * 86_400_000;
      const by = new Map<string, { photos: number; bytes: number }>();
      for (const x of all) { const k = by.get(x.kind) ?? { photos: 0, bytes: 0 }; k.photos++; k.bytes += x.bytes; by.set(x.kind, k); }
      const bytes = all.reduce((n, x) => n + x.bytes, 0);
      const recent = all.filter(x => Date.parse(x.at) > since);
      return ok({ photos: all.length, bytes, photos30: recent.length, bytes30: recent.reduce((n, x) => n + x.bytes, 0), over1mb: all.filter(x => x.bytes > 1_000_000).length,
        averageBytes: all.length ? Math.round(bytes / all.length) : 0, kinds: [...by].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.bytes - a.bytes).slice(0, 8), demo: true });
    }
    // A slip in the demo must never leave a screen blank: answer with the error instead.
    // In the real-data demo, the company's real people and stores stand in for the made-up ones.
    try { return realDeep(await this.handle(req)); } catch (e) {
      console.error('demo error', req.method, req.path, e);
      return { status: 500, body: { error: 'demo error', reasons: [`the test drive hit a problem (${(e as Error)?.message ?? e}); Reset the demo on the welcome screen if it keeps happening`] } };
    }
  }

  private async handle(req: Request): Promise<Response> {
    const b = (req.json ?? {}) as any;
    const p = req.path.split('?')[0];
    let m: RegExpMatchArray | null;

    // Own logins: someone HR or the CEO added and gave a setup code signs in as themselves.
    if ((p === '/auth/login' && String(b.email ?? '').includes('@')) || p === '/auth/setup') {
      const L = this.loginBook();
      const r = p === '/auth/setup' ? L.setup(String(b.email ?? ''), String(b.code ?? ''), String(b.password ?? '')) : L.login(String(b.email ?? ''), String(b.password ?? ''));
      this.persist(this.state);
      if (!r.ok) return refuse(r.status, ...r.reasons);
      const id = (r.body as { id: string }).id;
      const person = this.office().o.people.find(x => x.id === id);
      if (!person) return refuse(401, 'wrong email or password');
      this.who = { id, name: person.full_name, level: person.login_level };
      return ok({ token: `demo-${id}`, user: this.who, company: { id: 'demo', name: REAL ? REAL.company.name : 'ZSP (demo)' }, signedInFor: b.remember ? '30 days' : '12 hours' });
    }
    if (p === '/auth/login') {
      // The same pretend company seen as the technician or as the stock controller.
      const pick = b.email === 'stock' ? { id: 'stock', name: 'Lindiwe Zulu', level: 'stockroom' }
        : b.email === 'mech' ? { id: 'mech', name: 'Bongani Khumalo', level: 'mechanic' }
        : b.email === 'office' ? { id: 'office', name: 'Lilanie Schallies', level: 'creator' }
        : b.email === 'admin' ? { id: 'admin-1', name: 'Zanele Khoza', level: 'admin' }
        : b.email === 'manager' ? { id: 'mgr-1', name: 'Pieter van Wyk', level: 'management' }
        : b.email === 'hr' ? { id: 'hr-1', name: 'Precious Ngcobo', level: 'hr' }
        : b.email === 'accounts' ? { id: 'acc-1', name: 'Nandi Khumalo', level: 'accounts' }
        : { id: 'me', name: 'Thabo Mkhize', level: 'technician' };
      // Each "View as" button opens whoever holds that position now: if someone was given another
      // position or left the company, the next person in that position stands in.
      let who = pick;
      if (this.state.office && this.office().levelOf(pick.id) !== pick.level) {
        const now = this.state.office.people.find(x => x.login_level === pick.level);
        if (!now) return refuse(409, `Nobody is ${pick.level === 'management' ? 'a department manager' : `in the ${pick.level} position`} now. Give someone that position under People (as HR or the CEO), or start over with fresh demo data.`);
        who = { id: now.id, name: now.full_name, level: pick.level };
      }
      this.who = who;
      return ok({
        token: `demo-${who.id}`,
        user: who,
        company: { id: 'demo', name: 'ZSP (demo)' },
      });
    }
    if (p === '/policy/current') return ok({ id: 'policy-1', version: '1.0', body: DEMO_POLICY });
    if (p === '/policy/acknowledge') { this.state.acknowledged = true; this.persist(this.state); return ok({ ok: true }); }
    if (!this.state.acknowledged) return { status: 403, body: { error: 'acknowledge the monitoring policy first', code: 'policy_required' } };
    if (!this.state.vanStock) this.vans();
    const dr = this.docRoute(p, req, b);
    if (dr) return dr;
    const qr = this.queryRoute(p, req, b);
    if (qr) return qr;
    const vr = this.vanRoute(p, req, b);
    if (vr) return vr;
    const tr = this.timesRoute(p, req, b);
    if (tr) return tr;
    const mr = this.menuRoute(p, req, b);
    if (mr) return mr;
    const tq = this.techQuoteRoute(p, req, b);
    if (tq) return tq;
    const rr = this.reportRoute(p, req, b);
    if (rr) return rr;
    const wr = this.repairRoute(p, req, b);
    if (wr) return wr;
    const tl = this.toolRoute(p, req, b);
    if (tl) return tl;
    const ceoLevel = ['director', 'creator'].includes(this.office().levelOf(this.who.id) ?? this.who.level);
    if (p === '/company/brand') return ok({ name: 'ZSP (demo)', logoPhotoId: this.state.logoPhotoId ?? null, logoDataUri: this.state.logoPhotoId ? null : DEMO_LOGO,
      accent: this.state.themeAccent ?? 'orange', canTheme: ceoLevel });
    if (p === '/company/theme' && req.method === 'PUT') {
      if (!ceoLevel) return refuse(403, 'only the director chooses the colour theme');
      if (!['orange', 'blue', 'green'].includes(b.accent)) return refuse(400, 'one of the three colour themes');
      this.state.themeAccent = b.accent; this.persist(this.state);
      return ok({ accent: b.accent });
    }
    const cust = await this.customerRoute(p, req, b);
    if (cust) return cust;
    const bdr = this.breakdownRoute(p, req, b);
    if (bdr) return bdr;
    const off = this.officeRoute(p, req, b);
    if (off) return off;

    if (p === '/me') {
      const level = this.office().levelOf(this.who.id) ?? this.who.level;
      const work = this.office().workOf(this.who.id, level);
      this.persist(this.state);
      return ok({ id: this.who.id, full_name: this.who.name, login_level: level, work, fleetDuty: work.fleet && level !== 'mechanic', stockDuty: work.stockroom && level !== 'stockroom',
        stockCover: !work.stockroom && this.covers() });
    }
    if (p === '/me/password') {
      const myLevel = this.office().levelOf(this.who.id) ?? this.who.level;
      if (myLevel !== 'admin' && !this.does('access')) return refuse(403, 'ask Admin or the CEO for a new setup code to change your password');
      const pr = this.office().loginPeople().find(x => x.id === this.who.id);
      const r = this.loginBook().change(this.who.id, this.who.name, pr?.email ?? '', String(b.current ?? ''), String(b.password ?? ''));
      this.persist(this.state);
      return r.ok ? ok({ ...(r.body as object), user: this.who, company: { id: 'demo', name: REAL ? REAL.company.name : 'ZSP (demo)' } }) : refuse(r.status, ...r.reasons);
    }
    if ((m = p.match(/^\/access\/users\/([^/]+)\/fleet-duty$/))) {
      // The CEO's switch; in the test build anyone may flip it (the tester's "small company" switch).
      const r = this.office().setWork(m[1], 'fleet', !!b.on);
      this.persist(this.state);
      return r.ok ? ok({ userId: m[1], fleetDuty: !!b.on }) : refuse(r.status, ...r.reasons);
    }
    if (p === '/me/today') {
      this.repairs();
      // Someone added under People who signed in with their own login has their own (new, empty) day.
      const meId = this.who.id.startsWith('p-') ? this.who.id : 'me';
      const jobs: TodayJob[] = this.state.jobs.filter(j => (j.card.status as string) !== 'cancelled' && !(j.card.status === 'closed' && j.meta.scheduled_date < today()) && ((j.meta.lead_id ?? 'me') === meId || (j.meta.helper_ids ?? []).includes(meId))).map(j => ({
        id: j.meta.id, job_number: j.meta.job_number, job_type: j.meta.job_type, priority: j.meta.priority as TodayJob['priority'],
        status: j.card.status, scheduled_date: j.meta.scheduled_date, fault_reported: j.meta.fault_reported, store: j.meta.store,
        address: j.meta.store_address, i_am_lead: true,
        planned_return: j.card.status === 'continue_later' ? today() : null,
        carried_over: j.meta.scheduled_date < today() && j.card.status !== 'closed',
      }));
      const vehicle = this.state.vehicle ? { ...this.state.vehicle, booking: this.fleet().nextBooking(this.state.vehicle.id) } : null;
      return ok({ date: today(), jobs, vehicle, flagsToAnswer: this.state.flags.filter(f => f.status === 'open' && (f.tech ?? 'me') === 'me').length, unreadNotices: 0 });
    }
    if (p === '/me/stock') return ok(this.stock().totals());
    if (p === '/me/inventory') { const r = this.stock().inventory(); this.persist(this.state); return ok(r); }
    if (p === '/stock/catalogue') return ok(this.stock().catalogue());
    {
      const kitWrite = this.does('stockroom') || this.covers();
      const office = ['admin', 'management', 'hr', 'director', 'creator'].includes(this.who.level);
      if (p === '/me/kit') { const k = this.stock().kitFor(this.who.id, false); this.persist(this.state); return ok(k); }
      if (p === '/kit/people') return kitWrite ? ok((() => { const v = this.vans(); return this.stock().kitPeople(this.office().stockroomPeople()).map(x => ({ ...x, van_short: v.shortCount(x.id) })); })()) : refuse(403, 'the stockroom keeps tools and PPE');
      if ((m = p.match(/^\/people\/([^/]+)\/kit$/))) {
        if (req.method === 'GET') return (kitWrite || office || m[1] === this.who.id) ? ok(this.stock().kitFor(m[1], kitWrite)) : refuse(403, 'not your list');
        if (!kitWrite) return refuse(403, 'the stockroom keeps tools and PPE');
        const r = this.stock().issueKit(m[1], this.office().name(m[1]), this.who.name, b);
        this.persist(this.state); return this.stockResult(r);
      }
      if ((m = p.match(/^\/kit\/([^/]+)\/close$/))) {
        if (!kitWrite) return refuse(403, 'the stockroom keeps tools and PPE');
        const st = this.stock(); const u = st.userOfKit(m[1]);
        return this.stockResult(st.closeKit(m[1], this.who.name, u ? this.office().name(u) : '', b));
      }
    }
    if (p === '/me/supplier-invoices' && req.method === 'GET') { this.stock(); this.persist(this.state); return ok(this.state.stockControl!.invoices); }
    if (p === '/me/returns' && req.method === 'GET') { this.stock(); this.persist(this.state); return ok(this.state.stockControl!.returns); }
    if (p === '/supplier-invoices') return this.stockResult(this.stock().scanInvoice(b), 201);
    if ((m = p.match(/^\/supplier-invoices\/([^/]+)\/confirm$/))) return this.stockResult(this.stock().confirmInvoice(m[1], b));
    if (p === '/me/returns') return this.stockResult(this.stock().sendReturn(b), 201);
    if ((m = p.match(/^\/jobs\/([^/]+)\/stock$/))) return ok(this.stock().jobStock(m[1]));
    if ((m = p.match(/^\/jobs\/([^/]+)\/stock-out$/))) {
      const j = this.findJob(m[1]);
      if (!j) return refuse(404, 'no such job');
      if (j.card.status === 'closed') return refuse(409, 'job is closed');
      return this.stockResult(this.stock().request(m[1], b, { number: j.meta.job_number, store: j.meta.store }), 201);
    }
    if (p === '/me/stock-requests') return ok(this.stock().requests().filter(r => (r.technician_id ?? 'me') === 'me'));
    // Stock controller
    if (p === '/stock/overview') return ok(this.stock().overview());
    if (p === '/stock/issues') return ok(this.stock().requests(new URLSearchParams(req.path.split('?')[1] ?? '').get('status') ?? 'pending'));
    if ((m = p.match(/^\/stock\/issues\/([^/]+)\/issue$/))) return this.stockResult(this.stock().issue(m[1], b, this.who.name, this.standIn()));
    if ((m = p.match(/^\/stock\/issues\/([^/]+)\/reject$/))) return this.stockResult(this.stock().reject(m[1], b.reason, this.who.name, this.standIn()));
    if (p === '/stock/returns') {
      const st = new URLSearchParams(req.path.split('?')[1] ?? '').get('status') ?? 'pending';
      return ok(this.stock().s.returns.filter(r => r.status === st));
    }
    if ((m = p.match(/^\/stock\/returns\/([^/]+)\/receive$/))) return this.stockResult(this.stock().receive(m[1], b));
    if (p === '/stock/stockroom') return ok(this.stock().stockroomList());
    if (p === '/stock/order-list') return ok(this.stock().orderList());
    if ((m = p.match(/^\/stock\/items\/([^/]+)\/settings$/))) return this.stockResult(this.stock().settings(m[1], b));
    if ((m = p.match(/^\/stock\/items\/([^/]+)\/ordered$/))) return this.stockResult(this.stock().markOrdered(m[1], b));
    if ((m = p.match(/^\/stock\/items\/([^/]+)\/history$/))) return ok(this.stock().history(m[1]));
    if (p === '/stock/holdings') return ok(this.stock().allHoldings());
    if (p === '/stock/activity') return ok(this.stock().activity());
    if ((m = p.match(/^\/stock\/items\/([^/]+)$/)) && req.method === 'PATCH') return this.stockResult(this.stock().nameItem(m[1], b));
    if (p === '/stock/deliveries') return this.stockResult(this.stock().delivery(b), 201);
    if (p === '/stock/invoices') return ok(this.stock().s.invoices.filter(i => i.status === 'confirmed'));
    if (p === '/me/flags') return ok(this.state.flags.filter(f => (f.status === 'open' || f.status === 'explained') && (f.tech ?? 'me') === 'me'));
    if ((m = p.match(/^\/flags\/([^/]+)\/explain$/))) {
      const f = this.state.flags.find(x => x.id === m![1]);
      if (!f || f.status !== 'open') return refuse(404, 'no open flag of yours with that id');
      if (!b.explanation || String(b.explanation).trim().length < 10) return refuse(400, 'explanation: give a proper explanation (at least a short sentence)');
      f.explanation = b.explanation; f.status = 'explained'; this.persist(this.state);
      return ok({ id: f.id, status: 'explained' });
    }
    if (p === '/vehicles/lookup') {
      const barcode = new URLSearchParams(req.path.split('?')[1] ?? '').get('barcode') ?? '';
      if (!this.isDemoVehicle(barcode)) return refuse(404, 'unknown vehicle barcode: in the demo use ZSP-V07, ND 412-778 or its licence disc');
      const van = this.van();
      const mode = new URLSearchParams(req.path.split('?')[1] ?? '').get('mode') ?? 'driving';
      return ok({
        vehicle: { id: 'veh-1', registration: 'ND 412-778', photo_id: (this.fleet().s.vehicles.find(x => x.id === 'veh-1') as { photo_id?: string | null } | undefined)?.photo_id ?? null },
        lastDriver: van.lastDriverMe ? { id: 'me', name: 'Thabo Mkhize' } : REAL ? { id: EXAMPLE_TECH, name: 'Ayanda Mthembu' } : { id: 'tech-2', name: 'Sipho Ndlovu' },
        lastInspection: { odometerKm: van.odometerKm, problems: van.problems, at: new Date(Date.now() - 86_400_000).toISOString(), by: 'Sipho Ndlovu' },
        needsInspection: H.needsInspection(mode as 'driving', van.lastDriverMe ? 'me' : REAL ? EXAMPLE_TECH : 'tech-2', 'me', true),
      });
    }
    if (p === '/vehicles/scan') {
      if (!this.isDemoVehicle(b.barcode ?? '')) return refuse(404, 'unknown vehicle barcode');
      if (b.mode === 'driving') { const dr = this.fleet().canDrive('veh-1'); if (!dr.ok) return refuse(409, dr.reason); }
      const van = this.van();
      let handoverStatus: 'signed' | 'awaiting_approval' | null = null;
      if (b.mode === 'driving' && !van.lastDriverMe) {
        if (!b.inspection) return refuse(409, 'inspect the vehicle and sign for it before you drive it');
        const missing = H.missingOnInspection(b.inspection, { odometerKm: van.odometerKm, problems: van.problems });
        if (missing.length) return refuse(409, ...missing);
        // New problems go to the previous driver (Sipho, in the demo) to explain, not to you.
        handoverStatus = b.inspection.handoverBy === 'remote_approval' ? 'awaiting_approval' : 'signed';
        const fresh = H.newProblems(b.inspection, { odometerKm: van.odometerKm, problems: van.problems });
        this.fleet().fromHandover('veh-1', b.inspection.odometerKm,
          fresh.map(k => `${H.CHECKS.find(c => c[0] === k)![1]}${b.inspection.checks[k]?.note ? `: ${b.inspection.checks[k].note}` : ''}`), 'Thabo Mkhize');
        this.state.van = { lastDriverMe: true, odometerKm: b.inspection.odometerKm, problems: H.problemsOf(b.inspection) };
      }
      if (b.mode === 'driving') { this.state.van = { ...this.van(), lastDriverMe: true }; this.fleet().s.drivers['veh-1'] = 'Thabo Mkhize'; }
      this.state.vehicle = { id: 'veh-1', registration: 'ND 412-778', mode: b.mode, dropped_off_at: null, handover_status: handoverStatus ?? this.state.vehicle?.handover_status ?? null };
      this.persist(this.state);
      return ok({ scanId: id('scan'), vehicle: { id: 'veh-1', registration: 'ND 412-778' }, mode: b.mode, awaitingIgnition: true, handoverStatus });
    }
    if (p === '/vehicles/release') {
      const v = this.state.vehicle;
      if (!v) return refuse(409, 'no vehicle is on your name');
      if (v.mode === 'driving') {
        const missing = [b.km === undefined ? 'odometer reading (km)' : null, !b.place ? 'where you left the vehicle' : null].filter(Boolean) as string[];
        if (missing.length) return refuse(409, ...missing);
        if (b.place === 'home') return refuse(409, 'you are not approved to take a vehicle home: leave it at the office yard');
        const last = this.fleet().latestKm(v.id);
        if (last != null && b.km < last) return refuse(409, `odometer cannot be lower than the last reading (${last} km)`);
        this.fleet().s.km.unshift({ vehicle_id: v.id, km: b.km, read_at: new Date().toISOString(), source: 'release', by: 'Thabo Mkhize' });
        delete this.fleet().s.drivers[v.id];
      }
      this.state.vehicle = null;
      this.persist(this.state);
      return ok({ released: v.registration });
    }
    if (p === '/photos') { this.state.photos++; this.persist(this.state); return ok({ id: req.upload?.fields.id ?? id('photo') }, 201); }
    if (p === '/fuel') {
      if (!this.state.vehicle && !b.vehicleId) return refuse(409, 'scan into a vehicle first, or choose the vehicle');
      this.state.fuel.push({ litres: b.litres, at: b.at });
      const problems = b.litres > 80 ? [`${b.litres} L is more than the 80 L tank`] : [];
      if (problems.length) this.state.flags.push({ id: id('flag'), flag_type: 'fuel_mismatch', severity: 'normal', raised_at: b.at, status: 'open', question: 'Explain this fuel entry', explanation: null, details: { problems } });
      this.persist(this.state);
      return ok({ id: id('fuel'), vehicle: this.state.vehicle?.registration ?? 'ND 412-778', problems }, 201);
    }

    // Fleet (mechanic). Technicians may report faults; the rest is the mechanic's.
    if ((m = p.match(/^\/fleet\/vehicles\/([^/]+)\/faults$/))) return this.fleetResult(this.fleet().reportFault(m[1], b, this.who.name, this.who.level === 'mechanic'));
    // The workshop's stock: the mechanic uses and counts it; the stock controller sets and issues it.
    if (p.startsWith('/fleet/workshop')) {
      const mech = this.does('fleet');
      const ctl = this.does('stockroom');
      if (!mech && !ctl) return refuse(403, 'fleet or stock controller only');
      const ws = this.workshop();
      const done = (r: Parameters<DemoTransport['fleetResult']>[0]) => this.fleetResult(r);
      if (p === '/fleet/workshop') { const r = ws.list(); this.persist(this.state); return ok(r); }
      if (p === '/fleet/workshop/movements') return ok(ws.movements(new URLSearchParams(req.path.split('?')[1] ?? '').get('itemId')));
      if ((m = p.match(/^\/fleet\/workshop\/items\/([^/]+)$/))) return ctl ? done(ws.setItem(m[1], b)) : refuse(403, 'stock controller or office only');
      if (p === '/fleet/workshop/issue') return ctl ? done(ws.issue(b)) : refuse(403, 'stock controller or office only');
      if (p === '/fleet/workshop/return') return ctl ? done(ws.sendBack(b)) : refuse(403, 'stock controller or office only');
      if (p === '/fleet/workshop/loss') return mech ? done(ws.loss(b)) : refuse(403, 'mechanic only');
      if (p === '/fleet/workshop/count') return done(ws.count(b, this.who.name));
    }
    if (p.startsWith('/fleet') && !this.does('fleet')) return refuse(403, 'mechanic only');
    // A vehicle's profile picture.
    if ((m = p.match(/^\/fleet\/vehicles\/([^/]+)\/photo$/))) {
      const v = this.fleet().s.vehicles.find(x => x.id === m![1]) as ({ photo_id?: string | null } & object) | undefined;
      if (!v) return refuse(404, 'no such vehicle');
      v.photo_id = b?.photoId ?? null; this.persist(this.state);
      return ok({ id: m[1], photo_id: v.photo_id });
    }
    // Vehicle barcode stickers.
    if (p === '/fleet/barcodes' || /^\/fleet\/vehicles\/[^/]+\/barcode$/.test(p)) {
      const vs = this.fleet().s.vehicles as (typeof this.fleet extends () => { s: { vehicles: (infer V)[] } } ? V & { barcode?: string } : never)[];
      vs.forEach((v, i) => { v.barcode ??= v.registration === 'ND 412-778' ? 'ZSP-V07' : `ZSP-V${String(i + 10).padStart(2, '0')}`; });
      if (p === '/fleet/barcodes') { this.persist(this.state); return ok({ vehicles: vs.map(v => ({ id: v.id, registration: v.registration, description: v.description ?? null, make: v.make, model: v.model, barcode: v.barcode, photo_id: (v as { photo_id?: string | null }).photo_id ?? null })), canEdit: true }); }
      const v = vs.find(x => p === `/fleet/vehicles/${x.id}/barcode`);
      if (!v) return refuse(404, 'no such vehicle');
      const code = b?.code ? String(b.code).trim().toUpperCase() : `V-${Math.random().toString(36).slice(2, 8).toUpperCase().replace(/[01OI]/g, 'X')}`;
      if (!/^[A-Z0-9][A-Z0-9-]{2,23}$/.test(code)) return refuse(400, 'a code of 3 to 24 letters, digits or dashes');
      const other = vs.find(x => x.barcode === code && x.id !== v.id);
      if (other) return refuse(409, `that code is already on ${other.registration}`);
      const previous = v.barcode;
      v.barcode = code; this.persist(this.state);
      return ok({ id: v.id, registration: v.registration, barcode: code, previous });
    }
    if (p === '/fleet/daily-checks') return ok(this.fleet().checksFor());
    if ((m = p.match(/^\/fleet\/vehicles\/([^/]+)\/daily-check$/))) {
      const r = this.fleet().dailyCheck(m[1], b);
      if (r.ok) {
        const reg = this.fleet().s.vehicles.find(v => v.id === m![1])!.registration;
        const notes = [b.oil === 'topped_up' ? this.workshop().pourForCheck('oil', b.oilLitres, reg) : null, b.water === 'topped_up' && b.waterLitres ? this.workshop().pourForCheck('water', b.waterLitres, reg) : null].filter(Boolean);
        (r.body as Record<string, unknown>).stockNotes = notes;
      }
      return this.fleetResult(r);
    }
    if (p === '/fleet/bookings') return ok(this.fleet().bookings());
    if ((m = p.match(/^\/fleet\/vehicles\/([^/]+)\/bookings$/))) return this.fleetResult(this.fleet().book(m[1], b));
    if ((m = p.match(/^\/fleet\/bookings\/([^/]+)\/move$/))) return this.fleetResult(this.fleet().move(m[1], b));
    if ((m = p.match(/^\/fleet\/bookings\/([^/]+)\/cancel$/))) return this.fleetResult(this.fleet().cancel(m[1], b.note));
    if (p === '/fleet/positions') { const r = this.fleet().positions(); this.persist(this.state); return ok(r); }
    if (p === '/fleet/technicians') return ok(this.fleet().technicians(this.thaboIn()));
    if ((m = p.match(/^\/fleet\/vehicles\/([^/]+)\/assign$/))) {
      const r = this.fleet().assign(m[1], b);
      if (r.ok) {
        const reg = this.fleet().s.vehicles.find(v => v.id === m![1])!.registration;
        if (b.technicianId === 'me') this.state.vehicle = { id: m[1], registration: reg, mode: b.mode, dropped_off_at: null, handover_status: null, assigned_by_mechanic: true };
        else if (r.tookFrom?.includes('me') || (this.state.vehicle?.id === m[1] && b.mode === 'driving' && this.state.vehicle.mode === 'driving')) this.state.vehicle = null;
        if (b.technicianId === 'me' && m[1] === 'veh-1' && b.mode === 'driving') this.state.van = { ...this.van(), lastDriverMe: true };
      }
      return this.fleetResult(r);
    }
    if ((m = p.match(/^\/fleet\/technicians\/([^/]+)\/release$/))) {
      const t = this.fleet().technicians(this.thaboIn()).find(x => x.id === m![1]);
      const r = this.fleet().releaseFor(m[1], t?.vehicle_id ? { vehicle_id: t.vehicle_id, mode: t.mode! } : null, b);
      if (r.ok && m[1] === 'me') this.state.vehicle = null;
      return this.fleetResult(r);
    }
    if (p === '/fleet') return ok(this.fleet().list());
    if (p === '/fleet/faults') return ok(this.fleet().openFaults());
    if (p === '/fleet/jobs') return ok(this.fleet().jobsList(new URLSearchParams(req.path.split('?')[1] ?? '').get('status') ?? 'open'));
    if ((m = p.match(/^\/fleet\/vehicles\/([^/]+)$/)) && req.method === 'GET') return this.fleetResult(this.fleet().detail(m[1]));
    if ((m = p.match(/^\/fleet\/vehicles\/([^/]+)$/)) && req.method === 'PATCH') return this.fleetResult(this.fleet().patchVehicle(m[1], b));
    if ((m = p.match(/^\/fleet\/vehicles\/([^/]+)\/status$/))) return this.fleetResult(this.fleet().setStatus(m[1], b));
    if ((m = p.match(/^\/fleet\/vehicles\/([^/]+)\/odometer$/))) return this.fleetResult(this.fleet().odometer(m[1], b.km));
    if ((m = p.match(/^\/fleet\/vehicles\/([^/]+)\/jobs$/))) return this.fleetResult(this.fleet().openJob(m[1], b));
    if ((m = p.match(/^\/fleet\/faults\/([^/]+)\/defer$/))) return this.fleetResult(this.fleet().defer(m[1], b.note));
    if ((m = p.match(/^\/fleet\/jobs\/([^/]+)$/)) && req.method === 'PATCH') return this.fleetResult(this.fleet().patchJob(m[1], b));
    if ((m = p.match(/^\/fleet\/jobs\/([^/]+)\/parts$/))) {
      if (b.source === 'workshop') {
        if (!b.stockItemId) return refuse(400, 'which workshop stock item');
        const j = this.fleet().s.jobs.find(x => x.id === m![1]);
        if (!j) return refuse(404, 'no such job card');
        if (j.status !== 'open') return refuse(409, 'this job card is completed and locked');
        const reg = this.fleet().s.vehicles.find(v => v.id === j.vehicle_id)!.registration;
        const err = this.workshop().useOnJob(b.stockItemId, b.qty, reg, j.number);
        if (err) return this.fleetResult(err);
      }
      return this.fleetResult(this.fleet().addPart(m[1], b));
    }
    if ((m = p.match(/^\/fleet\/jobs\/([^/]+)\/complete$/))) return this.fleetResult(this.fleet().complete(m[1], b));

    if ((m = p.match(/^\/jobs\/([^/]+)$/)) && req.method === 'GET') {
      const j = this.findJob(m[1]);
      return j ? ok(this.view(j)) : refuse(404, 'no such job');
    }
    if ((m = p.match(/^\/jobs\/([^/]+)\/(go|start|resume|done)$/))) {
      const fn = { go: J.go, start: J.start, resume: J.resume, done: J.done }[m[2] as 'go'];
      const r = this.rule(m[1], c => fn(c, b.at));
      if (m[2] === 'done' && r.status < 300 && this.state.breakdowns) { this.bds().jobUpdate(m[1], 'done'); this.persist(this.state); }
      return r;
    }
    if ((m = p.match(/^\/jobs\/([^/]+)\/pause$/))) return this.rule(m[1], c => J.pause(c, b.reason, b.at));
    if ((m = p.match(/^\/jobs\/([^/]+)\/arrive$/))) {
      const r = this.rule(m[1], c => J.arrive(c, { at: b.at, vehiclePosition: b.position, managerName: b.managerName, safety: b.safety, outsideReason: b.outsideReason }));
      if (r.status < 300 && this.state.breakdowns) { this.bds().jobUpdate(m[1], 'on_site'); this.persist(this.state); }
      return r;
    }
    if ((m = p.match(/^\/jobs\/([^/]+)\/continue-later$/))) {
      const j = this.findJob(m[1]);
      if (j && this.vans().partsReport(j.meta.lead_id ?? 'me')) {
        if (b.quoteNeeded === undefined) return refuse(400, 'say whether another quote is needed for parts');
        const start = j.card.visits.at(-1)?.goAt ?? j.card.visits.at(-1)?.arrivedAt ?? '';
        if (b.quoteNeeded && !(this.state.reports ?? []).some(r => r.job_id === j.meta.id && r.created_at >= start)) return refuse(409, 'the parts report first: the machine or site, the serial tag, the part needed');
      }
      return this.rule(m[1], c => J.continueLater(c, b));
    }
    if ((m = p.match(/^\/jobs\/([^/]+)\/close$/))) {
      return this.rule(m[1], c => J.close(c, b.signOff.signature ? { signature: true, managerName: b.signOff.managerName } : b.signOff, b.at), j => {
        if (b.signOff.signature) j.meta.manager_name = b.signOff.managerName;
      });
    }
    if ((m = p.match(/^\/jobs\/([^/]+)\/items$/))) {
      return this.rule(m[1], c => J.addItem(c, { id: b.id ?? id('item'), title: b.title, origin: 'found_on_site', beforePhotos: 0, afterPhotos: 0, vanStockLines: 0, boughtOutLines: 0, noMaterials: false }));
    }
    if ((m = p.match(/^\/jobs\/([^/]+)\/items\/([^/]+)$/)) && req.method === 'PATCH') return this.rule(m[1], c => J.updateItem(c, m![2], b));
    if ((m = p.match(/^\/jobs\/([^/]+)\/items\/([^/]+)\/photos$/))) {
      const kind = req.upload?.fields.kind;
      return this.rule(m[1], c => {
        const it = c.items.find(i => i.id === m![2]);
        if (!it) return { ok: false, reasons: ['no such item'] };
        const key = kind === 'after' ? 'afterPhotos' : kind === 'before' ? 'beforePhotos' : null;
        return key ? J.updateItem(c, it.id, { [key]: it[key] + 1 }) : { ok: true, card: c };
      });
    }
    if ((m = p.match(/^\/jobs\/([^/]+)\/items\/([^/]+)\/materials$/))) {
      const ds = this.stock();
      const jobId = m[1];
      const check = ds.use(jobId, b.stockItemId, b.qty);
      if (!check.ok) return refuse(check.status, ...check.reasons);
      this.vans().check('me', 'Thabo Mkhize');
      return this.rule(jobId, c => {
        const it = c.items.find(i => i.id === m![2]);
        return it ? J.updateItem(c, it.id, { vanStockLines: it.vanStockLines + 1 }) : { ok: false, reasons: ['no such item'] };
      });
    }
    if ((m = p.match(/^\/jobs\/([^/]+)\/items\/([^/]+)\/bought-out$/))) {
      return this.rule(m[1], c => {
        const it = c.items.find(i => i.id === m![2]);
        return it ? J.updateItem(c, it.id, { boughtOutLines: it.boughtOutLines + 1 }) : { ok: false, reasons: ['no such item'] };
      });
    }
    if ((m = p.match(/^\/jobs\/([^/]+)\/checklist\/([^/]+)$/))) {
      const j = this.findJob(m[1]);
      if (!j) return refuse(404, 'no such job');
      j.meta.checklist = j.meta.checklist.map(c => (c.id === m![2] ? { ...c, done: true } : c));
      j.card.maintenanceChecklistDone = j.meta.checklist.every(c => c.done);
      this.persist(this.state);
      return ok(this.view(j));
    }
    return refuse(404, `demo: ${req.method} ${p} not available`);
  }
}

export const DEMO_POLICY = `Vehicle and App Monitoring Policy (demo copy)

1. Purpose. The company monitors its vehicles and its job app so that work is recorded accurately, clients can be billed fairly, staff and vehicles are kept safe, and company property is protected.

2. What is monitored. Vehicle position, speed, ignition, trips and stops (tracker). Who is in which vehicle (barcode scan). Your phone's location only at the moment you tap Arrived, Start or Dropped off, never in the background. Job card activity, timesheets, fuel, stock and tools on your name, supply runs.

Never monitored: the content of your phone, your location outside those taps, anything after hours on your phone.

3. Automatic checks raise a flag when tracker and job card do not match. A flag is a question, not an accusation: you are asked to explain, and your explanation goes to your supervisor.

4. Who can see it: you see your own; managers see their department; directors see all. Every view of the confidential log is recorded.

5. How it is used: planning, invoicing, safety, checking timesheets and fuel, and, where the facts call for it, discipline under the company's code. No disciplinary decision is made on a flag alone.

6. Your rights: you may see the information held about you and ask for corrections. Records are kept at least 5 years.

This is a demo copy. Your company's real policy is shown here once it is published.`;
