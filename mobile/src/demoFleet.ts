// The demo's pretend fleet for the mechanic, following the same rules as the server (core/fleet.ts).
// ND 412-778 (veh-1) is the technician's demo van, so what Thabo does shows up here.
import * as F from '../../server/src/core/fleet.ts';
import type { Fault, FleetJob, FleetVehicle, VehicleDetail } from './fleet/types.ts';

type V = Omit<VehicleDetail['vehicle'], 'km' | 'driver' | 'open_faults' | 'safety_faults' | 'open_job' | 'serviceDue' | 'licenceDue'>;
type Job = Omit<FleetJob, 'faults' | 'parts' | 'registration'> & { odometer_out: number | null; completed_at: string | null; next_service_km?: number | null; next_service_at?: string | null };
export interface DemoFleetState {
  vehicles: V[];
  drivers: Record<string, string>;
  km: { vehicle_id: string; km: number; read_at: string; source: string; by: string }[];
  faults: Fault[];
  jobs: Job[];
  parts: { job_id: string; id: string; description: string; qty: number; unitCostCents: number | null; source: 'stockroom' | 'bought' | 'other' }[];
  nextJob: number;
}

const d = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();
const day = (offsetDays: number) => d(offsetDays).slice(0, 10);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

export function seedFleet(): DemoFleetState {
  const v = (id: string, registration: string, make: string, model: string, year: number, extra: Partial<V> = {}): V => ({
    id, registration, description: `${make} ${model}`, make, model, year, vin: null, engine_no: null, tank_litres: 80,
    status: 'in_service', status_note: null, licence_expiry: day(200), service_interval_km: 15000, service_interval_months: 12,
    next_service_km: null, next_service_at: day(150), ...extra,
  });
  return {
    vehicles: [
      v('veh-1', 'ND 412-778', 'Toyota', 'Hilux 2.4 GD-6', 2021, { next_service_km: 90000, licence_expiry: day(18) }),
      v('veh-2', 'ND 503-221', 'Isuzu', 'D-Max 250', 2020, { next_service_km: 121000 }),
      v('veh-3', 'ND 618-904', 'Nissan', 'NP200', 2018, { status: 'workshop', status_note: 'Job card 3007: clutch slipping', next_service_km: 160000 }),
      v('veh-4', 'ND 220-115', 'Toyota', 'Quantum', 2016, { status: 'off_road', status_note: 'Gearbox: waiting for parts', next_service_km: 240000, next_service_at: day(-20) }),
      v('veh-5', 'ND 771-330', 'Ford', 'Ranger 2.2', 2022, { next_service_km: 45500, licence_expiry: day(-3) }),
    ],
    drivers: { 'veh-2': 'Sipho Ndlovu', 'veh-5': 'Ayanda Mthembu' },
    km: [
      { vehicle_id: 'veh-1', km: 87450, read_at: d(-1), source: 'handover', by: 'Sipho Ndlovu' },
      { vehicle_id: 'veh-1', km: 75100, read_at: d(-60), source: 'fleet_job', by: 'Bongani Khumalo' },
      { vehicle_id: 'veh-2', km: 118230, read_at: d(-2), source: 'handover', by: 'Sipho Ndlovu' },
      { vehicle_id: 'veh-3', km: 152870, read_at: d(-1), source: 'fleet_job', by: 'Bongani Khumalo' },
      { vehicle_id: 'veh-4', km: 236400, read_at: d(-9), source: 'fleet_job', by: 'Bongani Khumalo' },
      { vehicle_id: 'veh-5', km: 45120, read_at: d(-1), source: 'handover', by: 'Ayanda Mthembu' },
    ],
    faults: [
      { id: 'flt-1', vehicle_id: 'veh-1', description: 'Windscreen and mirrors (no cracks): crack low on the passenger side', severity: 'safety', source: 'handover', status: 'open', reported_at: d(-1), reported_by_name: 'Sipho Ndlovu' },
      { id: 'flt-2', vehicle_id: 'veh-2', description: 'Rear left tyre losing pressure overnight', severity: 'urgent', source: 'driver', status: 'open', reported_at: d(-2), reported_by_name: 'Sipho Ndlovu' },
      { id: 'flt-3', vehicle_id: 'veh-3', description: 'Clutch slipping in third and fourth gear', severity: 'urgent', source: 'driver', status: 'in_progress', reported_at: d(-3), reported_by_name: 'Ayanda Mthembu', fleet_job_id: 'fj-7' },
      { id: 'flt-4', vehicle_id: 'veh-4', description: 'Gearbox grinding into second, jumps out of gear', severity: 'safety', source: 'mechanic', status: 'in_progress', reported_at: d(-9), reported_by_name: 'Bongani Khumalo', fleet_job_id: 'fj-6' },
      { id: 'flt-5', vehicle_id: 'veh-5', description: 'Canopy lock sticking', severity: 'normal', source: 'driver', status: 'open', reported_at: d(-5), reported_by_name: 'Ayanda Mthembu' },
    ],
    jobs: [
      { id: 'fj-5', number: 3005, vehicle_id: 'veh-1', job_type: 'service', status: 'completed', reason: '75 000 km service', opened_at: d(-60), odometer_in: 75080, odometer_out: 75100, completed_at: d(-60),
        found_text: 'Due for the 75 000 km service, front pads at 30 percent', did_text: 'Full service, oil and all filters, rotated the tyres', labour_hours: 3, before_photo_ids: [], after_photo_ids: ['p'], mechanic: 'Bongani Khumalo' },
      { id: 'fj-6', number: 3006, vehicle_id: 'veh-4', job_type: 'repair', status: 'open', reason: 'Gearbox jumping out of second', opened_at: d(-9), odometer_in: 236400, odometer_out: null, completed_at: null,
        found_text: 'Second gear synchro worn, selector fork bent', did_text: null, labour_hours: 4, before_photo_ids: ['p'], after_photo_ids: [], mechanic: 'Bongani Khumalo' },
      { id: 'fj-7', number: 3007, vehicle_id: 'veh-3', job_type: 'repair', status: 'open', reason: 'Clutch slipping', opened_at: d(-1), odometer_in: 152870, odometer_out: null, completed_at: null,
        found_text: null, did_text: null, labour_hours: null, before_photo_ids: [], after_photo_ids: [], mechanic: 'Bongani Khumalo' },
    ],
    parts: [
      { job_id: 'fj-5', id: 'pt-1', description: 'Service kit (oil, oil/air/fuel filters)', qty: 1, unitCostCents: 189000, source: 'bought' },
      { job_id: 'fj-6', id: 'pt-2', description: 'Gearbox synchro ring 2nd', qty: 1, unitCostCents: 145000, source: 'bought' },
    ],
    nextJob: 3008,
  };
}

type Res = { ok: true; body: unknown; status?: number } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown, status = 200): Res => ({ ok: true, body, status });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });
const MECH = 'Bongani Khumalo';

export class DemoFleet {
  constructor(public s: DemoFleetState) {}

  private veh(id: string) { return this.s.vehicles.find(v => v.id === id); }
  latestKm(id: string) { const k = this.s.km.filter(x => x.vehicle_id === id).map(x => x.km); return k.length ? Math.max(...k) : null; }

  private recordKm(vehicleId: string, km: number, source: string, by: string): Res | null {
    const last = this.latestKm(vehicleId);
    if (last != null && km < last) return bad(409, `odometer cannot be lower than the last reading (${last} km)`);
    this.s.km.unshift({ vehicle_id: vehicleId, km, read_at: new Date().toISOString(), source, by });
    return null;
  }

  private summary(v: V): FleetVehicle & V {
    const km = this.latestKm(v.id);
    const open = this.s.faults.filter(f => f.vehicle_id === v.id && (f.status === 'open' || f.status === 'in_progress'));
    const job = this.s.jobs.find(j => j.vehicle_id === v.id && j.status === 'open');
    return {
      ...v, km, driver: this.s.drivers[v.id] ?? null, open_faults: open.length, safety_faults: open.filter(f => f.severity === 'safety').length,
      open_job: job ? { id: job.id, number: job.number, type: job.job_type } : null,
      serviceDue: F.serviceDue(v, km, today()), licenceDue: F.licenceDue(v.licence_expiry, today()),
    };
  }

  list() { return this.s.vehicles.map(v => this.summary(v)); }

  openFaults() {
    const rank = { safety: 0, urgent: 1, normal: 2 };
    return this.s.faults.filter(f => f.status === 'open' || f.status === 'in_progress')
      .map(f => ({ ...f, registration: this.veh(f.vehicle_id)?.registration }))
      .sort((a, b) => rank[a.severity] - rank[b.severity] || a.reported_at.localeCompare(b.reported_at));
  }

  jobsList(status: string): FleetJob[] {
    return this.s.jobs.filter(j => j.status === status).map(j => ({
      ...j, registration: this.veh(j.vehicle_id)!.registration,
      faults: this.s.faults.filter(f => f.fleet_job_id === j.id).map(f => ({ id: f.id, description: f.description, severity: f.severity, status: f.status })),
      parts: this.s.parts.filter(p => p.job_id === j.id).map(({ job_id: _j, ...p }) => p),
    })).sort((a, b) => b.opened_at.localeCompare(a.opened_at));
  }

  detail(id: string): Res {
    const v = this.veh(id);
    if (!v) return bad(404, 'no such vehicle');
    const sum = this.summary(v);
    return good({
      vehicle: sum, serviceDue: sum.serviceDue, licenceDue: sum.licenceDue,
      faults: this.s.faults.filter(f => f.vehicle_id === id).sort((a, b) => Number(b.status === 'open' || b.status === 'in_progress') - Number(a.status === 'open' || a.status === 'in_progress') || b.reported_at.localeCompare(a.reported_at)),
      jobs: this.s.jobs.filter(j => j.vehicle_id === id).sort((a, b) => b.opened_at.localeCompare(a.opened_at)).map(j => ({
        ...j, parts_cents: this.s.parts.filter(p => p.job_id === j.id).reduce((n, p) => n + p.qty * (p.unitCostCents ?? 0), 0),
      })),
      km: this.s.km.filter(k => k.vehicle_id === id).sort((a, b) => b.read_at.localeCompare(a.read_at)),
      inspections: [],
    } satisfies VehicleDetail);
  }

  /** Can the technician drive it? Off-road and workshop vehicles can't be driven. */
  canDrive(id: string) { const v = this.veh(id); return v ? F.canDrive(v.status) : { ok: true as const }; }

  reportFault(vehicleId: string, b: { id?: string; description: string; severity?: F.FaultSeverity; at: string }, by: string, mechanic: boolean): Res {
    if (!this.veh(vehicleId)) return bad(404, 'no such vehicle');
    if (!b.description || b.description.trim().length < 10) return bad(400, 'describe the fault (at least a short sentence)');
    const id = b.id ?? `flt-${Date.now()}`;
    this.s.faults.push({ id, vehicle_id: vehicleId, description: b.description.trim(), severity: b.severity ?? 'normal', source: mechanic ? 'mechanic' : 'driver', status: 'open', reported_at: new Date().toISOString(), reported_by_name: by });
    return good({ id }, 201);
  }

  /** Called from the technician's handover inspection. */
  fromHandover(vehicleId: string, km: number, problems: string[], by: string) {
    this.recordKm(vehicleId, km, 'handover', by);
    const sev: Record<string, F.FaultSeverity> = { tyres: 'safety', lights: 'safety', windscreen_mirrors: 'safety', fire_extinguisher: 'urgent' };
    for (const p of problems) {
      this.s.faults.push({ id: `flt-${Date.now()}-${p}`, vehicle_id: vehicleId, description: p, severity: sev[p.split(':')[0]] ?? 'normal', source: 'handover', status: 'open', reported_at: new Date().toISOString(), reported_by_name: by });
    }
  }

  defer(id: string, note: string): Res {
    const f = this.s.faults.find(x => x.id === id);
    if (!f || f.status !== 'open' || f.severity === 'safety') return bad(409, 'only an open fault that is not a safety fault can be deferred');
    if (!note || note.trim().length < 5) return bad(400, 'say why it is deferred');
    Object.assign(f, { status: 'deferred', closed_note: note.trim() });
    return good({ id, status: 'deferred' });
  }

  setStatus(id: string, b: { status: F.VehicleStatus; note?: string }): Res {
    const v = this.veh(id);
    if (!v) return bad(404, 'no such vehicle');
    if (b.status !== 'in_service' && !(b.note && b.note.trim().length >= 5)) return bad(400, 'say why the vehicle is off the road');
    Object.assign(v, { status: b.status, status_note: b.status === 'in_service' ? null : b.note!.trim() });
    return good({ id, status: b.status });
  }

  odometer(id: string, km: number): Res {
    if (!this.veh(id)) return bad(404, 'no such vehicle');
    return this.recordKm(id, km, 'mechanic', MECH) ?? good({ id, km });
  }

  patchVehicle(id: string, b: Record<string, unknown>): Res {
    const v = this.veh(id);
    if (!v) return bad(404, 'no such vehicle');
    const map: Record<string, keyof V> = { make: 'make', model: 'model', year: 'year', vin: 'vin', engineNo: 'engine_no', licenceExpiry: 'licence_expiry',
      serviceIntervalKm: 'service_interval_km', serviceIntervalMonths: 'service_interval_months', nextServiceKm: 'next_service_km', nextServiceAt: 'next_service_at' };
    for (const [k, val] of Object.entries(b)) if (map[k] && val !== undefined) (v as Record<string, unknown>)[map[k]] = val;
    return good({ id });
  }

  openJob(vehicleId: string, b: { id?: string; jobType: F.FleetJobType; reason: string; odometerIn: number; faultIds?: string[]; vehicleStatus?: F.VehicleStatus; at: string }): Res {
    const v = this.veh(vehicleId);
    if (!v) return bad(404, 'no such vehicle');
    const open = this.s.jobs.find(j => j.vehicle_id === vehicleId && j.status === 'open');
    if (open) return bad(409, `job card ${open.number} is still open on this vehicle`);
    if (!b.reason || b.reason.trim().length < 5) return bad(400, 'reason for the job card');
    const err = this.recordKm(vehicleId, b.odometerIn, 'fleet_job', MECH);
    if (err) return err;
    const id = b.id ?? `fj-${Date.now()}`;
    const number = this.s.nextJob++;
    this.s.jobs.push({ id, number, vehicle_id: vehicleId, job_type: b.jobType, status: 'open', reason: b.reason.trim(), opened_at: new Date().toISOString(), odometer_in: b.odometerIn,
      odometer_out: null, completed_at: null, found_text: null, did_text: null, labour_hours: null, before_photo_ids: [], after_photo_ids: [], mechanic: MECH });
    for (const f of this.s.faults) if ((b.faultIds ?? []).includes(f.id)) Object.assign(f, { status: 'in_progress', fleet_job_id: id });
    if (b.vehicleStatus && b.vehicleStatus !== 'in_service') Object.assign(v, { status: b.vehicleStatus, status_note: `Job card ${number}: ${b.reason.trim()}` });
    return good({ id, number }, 201);
  }

  private job(id: string) { return this.s.jobs.find(j => j.id === id); }

  patchJob(id: string, b: { found?: string; did?: string; labourHours?: number; addBeforePhotoIds?: string[]; addAfterPhotoIds?: string[] }): Res {
    const j = this.job(id);
    if (!j) return bad(404, 'no such job card');
    if (j.status !== 'open') return bad(409, 'this job card is completed and locked');
    if (b.found !== undefined) j.found_text = b.found;
    if (b.did !== undefined) j.did_text = b.did;
    if (b.labourHours !== undefined) j.labour_hours = b.labourHours;
    j.before_photo_ids = [...j.before_photo_ids, ...(b.addBeforePhotoIds ?? [])];
    j.after_photo_ids = [...j.after_photo_ids, ...(b.addAfterPhotoIds ?? [])];
    return good({ id });
  }

  addPart(id: string, b: { id?: string; description: string; qty: number; unitCostCents?: number | null; source: 'stockroom' | 'bought' | 'other'; slipPhotoId?: string }): Res {
    const j = this.job(id);
    if (!j) return bad(404, 'no such job card');
    if (j.status !== 'open') return bad(409, 'this job card is completed and locked');
    if (b.source === 'bought' && !b.slipPhotoId) return bad(400, 'a photo of the slip for anything bought');
    this.s.parts.push({ job_id: id, id: b.id ?? `pt-${Date.now()}`, description: b.description, qty: b.qty, unitCostCents: b.unitCostCents ?? null, source: b.source });
    return good({ id: b.id }, 201);
  }

  complete(id: string, b: { odometerOut: number; faults?: { id: string; outcome: 'fixed' | 'deferred'; note?: string }[]; nextServiceKm?: number | null; nextServiceAt?: string | null; vehicleStatusAfter: F.VehicleStatus; statusNote?: string }): Res {
    const j = this.job(id);
    if (!j) return bad(404, 'no such job card');
    if (j.status !== 'open') return bad(409, 'this job card is already completed');
    const linked = this.s.faults.filter(f => f.fleet_job_id === id);
    const given = new Map((b.faults ?? []).map(f => [f.id, f]));
    const missing = F.missingToComplete({
      jobType: j.job_type, odometerIn: j.odometer_in, found: j.found_text, did: j.did_text, labourHours: j.labour_hours, afterPhotos: j.after_photo_ids.length,
      odometerOut: b.odometerOut, faults: linked.map(l => ({ id: l.id, severity: l.severity, outcome: given.get(l.id)?.outcome, note: given.get(l.id)?.note })),
      nextServiceKm: b.nextServiceKm, nextServiceAt: b.nextServiceAt, vehicleStatusAfter: b.vehicleStatusAfter,
    });
    if (missing.length) return bad(409, ...missing);
    const err = this.recordKm(j.vehicle_id, b.odometerOut, 'fleet_job', MECH);
    if (err) return err;
    for (const l of linked) Object.assign(l, { status: given.get(l.id)!.outcome, closed_note: given.get(l.id)!.note ?? null });
    Object.assign(j, { status: 'completed', odometer_out: b.odometerOut, completed_at: new Date().toISOString() });
    const v = this.veh(j.vehicle_id)!;
    Object.assign(v, { status: b.vehicleStatusAfter, status_note: b.vehicleStatusAfter === 'in_service' ? null : (b.statusNote ?? `After job card ${j.number}`) });
    if (b.nextServiceKm && b.nextServiceAt) Object.assign(v, { next_service_km: b.nextServiceKm, next_service_at: b.nextServiceAt });
    return good({ id, status: 'completed' });
  }
}
