// A pretend server inside the app, so the app can be tried without the office server.
// It answers the same requests as the real one and uses the same rules engine, so what you
// feel in demo mode is what the technicians will get. Data is invented.
import { DemoWorkshop, seedWorkshop, type DemoWorkshopState } from './demoWorkshop.ts';
import * as J from '../../server/src/core/jobCard.ts';
import * as H from '../../server/src/core/handover.ts';
import { normReg, registrationCandidates } from '../../server/src/core/vehicleCode.ts';
import { DemoStock, seedStock, type DemoStockState } from './demoStock.ts';
import { DemoFleet, seedFleet, type DemoFleetState } from './demoFleet.ts';
import { Offline, type Request, type Response, type Transport } from './transport.ts';
import type { CardView, Flag, StockLine, Today, TodayJob } from './types.ts';

interface DemoJob {
  meta: Omit<CardView, 'visits' | 'currentState' | 'jobMinutes' | 'items' | 'status'> & { i_am_lead: boolean };
  card: J.JobCard;
  checklistIds: string[];
}

export interface DemoState {
  acknowledged: boolean;
  jobs: DemoJob[];
  stock: StockLine[];
  flags: Flag[];
  vehicle: Today['vehicle'];
  photos: number;
  /** The demo van: who drove it last and what the last handover recorded. */
  van?: { lastDriverMe: boolean; odometerKm: number; problems: H.CheckKey[] };
  stockControl?: DemoStockState;
  fleet?: DemoFleetState;
  who?: { id: string; name: string; level: string };
  fuel: { litres: number; at: string }[];
  /** People given the mechanic's work on top of their own position (by the CEO). */
  fleetDuty?: Record<string, boolean>;
  workshop?: DemoWorkshopState;
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
  const s = STORES[storeKey];
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
      details: { overBy: 42, stoppedMinutes: 31 },
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
    };
  }

  private workshop(): DemoWorkshop {
    this.stock();
    const st = this.state.stockControl!;
    return new DemoWorkshop(this.state.workshop ?? (this.state.workshop = seedWorkshop(st)), st);
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
    this.persist(this.state);
    return r.ok ? ok(r.body, status) : refuse(r.status, ...r.reasons);
  }

  private findJob(jobId: string) { return this.state.jobs.find(j => j.meta.id === jobId); }

  private rule(jobId: string, fn: (c: J.JobCard) => J.Result, after?: (j: DemoJob, r: Extract<J.Result, { ok: true }>) => void): Response {
    const j = this.findJob(jobId);
    if (!j) return refuse(404, 'no such job');
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
    const b = (req.json ?? {}) as any;
    const p = req.path.split('?')[0];
    let m: RegExpMatchArray | null;

    if (p === '/auth/login') {
      // The same pretend company seen as the technician or as the stock controller.
      const who = b.email === 'stock' ? { id: 'stock', name: 'Lindiwe Zulu', level: 'stockroom' }
        : b.email === 'mech' ? { id: 'mech', name: 'Bongani Khumalo', level: 'mechanic' }
        : { id: 'me', name: 'Thabo Mkhize', level: 'technician' };
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

    if (p === '/me') return ok({ id: this.who.id, full_name: this.who.name, login_level: this.who.level, fleetDuty: !!this.state.fleetDuty?.[this.who.id] });
    if ((m = p.match(/^\/access\/users\/([^/]+)\/fleet-duty$/))) {
      // The CEO's switch; in the test build anyone may flip it.
      this.state.fleetDuty = { ...this.state.fleetDuty, [m[1]]: !!b.on };
      this.persist(this.state);
      return ok({ userId: m[1], fleetDuty: !!b.on });
    }
    if (p === '/me/today') {
      const jobs: TodayJob[] = this.state.jobs.map(j => ({
        id: j.meta.id, job_number: j.meta.job_number, job_type: j.meta.job_type, priority: j.meta.priority as TodayJob['priority'],
        status: j.card.status, scheduled_date: j.meta.scheduled_date, fault_reported: j.meta.fault_reported, store: j.meta.store,
        address: j.meta.store_address, i_am_lead: true,
        planned_return: j.card.status === 'continue_later' ? today() : null,
        carried_over: j.meta.scheduled_date < today() && j.card.status !== 'closed',
      }));
      const vehicle = this.state.vehicle ? { ...this.state.vehicle, booking: this.fleet().nextBooking(this.state.vehicle.id) } : null;
      return ok({ date: today(), jobs, vehicle, flagsToAnswer: this.state.flags.filter(f => f.status === 'open').length, unreadNotices: 0 });
    }
    if (p === '/me/stock') return ok(this.stock().totals());
    if (p === '/me/inventory') { const r = this.stock().inventory(); this.persist(this.state); return ok(r); }
    if (p === '/stock/catalogue') return ok(this.stock().catalogue());
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
    if ((m = p.match(/^\/stock\/issues\/([^/]+)\/issue$/))) return this.stockResult(this.stock().issue(m[1], b));
    if ((m = p.match(/^\/stock\/issues\/([^/]+)\/reject$/))) return this.stockResult(this.stock().reject(m[1], b.reason));
    if (p === '/stock/returns') {
      const st = new URLSearchParams(req.path.split('?')[1] ?? '').get('status') ?? 'pending';
      return ok(this.stock().s.returns.filter(r => r.status === st));
    }
    if ((m = p.match(/^\/stock\/returns\/([^/]+)\/receive$/))) return this.stockResult(this.stock().receive(m[1], b));
    if (p === '/stock/stockroom') return ok(this.stock().stockroomList());
    if (p === '/stock/holdings') return ok(this.stock().allHoldings());
    if (p === '/stock/activity') return ok(this.stock().activity());
    if ((m = p.match(/^\/stock\/items\/([^/]+)$/)) && req.method === 'PATCH') return this.stockResult(this.stock().nameItem(m[1], b));
    if (p === '/stock/deliveries') return this.stockResult(this.stock().delivery(b), 201);
    if (p === '/stock/invoices') return ok(this.stock().s.invoices.filter(i => i.status === 'confirmed'));
    if (p === '/me/flags') return ok(this.state.flags.filter(f => f.status === 'open' || f.status === 'explained'));
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
        vehicle: { id: 'veh-1', registration: 'ND 412-778' },
        lastDriver: van.lastDriverMe ? { id: 'me', name: 'Thabo Mkhize' } : { id: 'tech-2', name: 'Sipho Ndlovu' },
        lastInspection: { odometerKm: van.odometerKm, problems: van.problems, at: new Date(Date.now() - 86_400_000).toISOString(), by: 'Sipho Ndlovu' },
        needsInspection: H.needsInspection(mode as 'driving', van.lastDriverMe ? 'me' : 'tech-2', 'me', true),
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
      const mech = this.who.level === 'mechanic' || !!this.state.fleetDuty?.[this.who.id];
      const ctl = this.who.level === 'stockroom';
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
    if (p.startsWith('/fleet') && this.who.level !== 'mechanic' && !this.state.fleetDuty?.[this.who.id]) return refuse(403, 'mechanic only');
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
      return this.rule(m[1], c => fn(c, b.at));
    }
    if ((m = p.match(/^\/jobs\/([^/]+)\/pause$/))) return this.rule(m[1], c => J.pause(c, b.reason, b.at));
    if ((m = p.match(/^\/jobs\/([^/]+)\/arrive$/))) {
      return this.rule(m[1], c => J.arrive(c, { at: b.at, vehiclePosition: b.position, managerName: b.managerName, safety: b.safety, outsideReason: b.outsideReason }));
    }
    if ((m = p.match(/^\/jobs\/([^/]+)\/continue-later$/))) return this.rule(m[1], c => J.continueLater(c, b));
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
