// The test drive's office Vehicles page: the same answer as the server's /office/vehicles, made from the
// demo fleet, the made-up timesheet trips and fuel slips made up per vehicle (plus the ones logged in the test drive).
import * as T from '../../server/src/core/timesheet.ts';
import type { FleetVehicle } from './fleet/types.ts';

const sast = (d: Date = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const lastDay = (month: string) => { const d = new Date(`${month}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1, 0); return d.toISOString().slice(0, 10); };
const addMonths = (m: string, n: number) => { const d = new Date(`${m}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; };
/** Diesel per litre, roughly. */
const PRICE_CENTS = 2385;

export interface DemoFuel { id: string; vehicleId: string; registration: string; who: string; logged_at: string; litres: number; amount_cents: number; odometer_km: number | null }
export type DemoTrip = T.TripOut & { driverId: string; driver: string };

/** Fuel slips between two dates: about one fill every five days per vehicle on the road, and the test drive's own. */
export function demoFuel(vehicles: { id: string; registration: string; status: string; km: number | null }[], driverOf: (vehicleId: string) => string, from: string, to: string,
  mine: { litres: number; at: string }[], myVehicleId: string | null): DemoFuel[] {
  const t = sast();
  const last = to < t ? to : t;
  const out: DemoFuel[] = [];
  if (last < from) return out;
  for (const d of T.daysBetween(from, last)) {
    for (const v of vehicles) {
      if (v.status === 'off_road' || hash(`f|${v.id}|${d}`) > 0.2) continue;
      const hour = 7 + Math.floor(hash(`h|${v.id}|${d}`) * 9), min = Math.floor(hash(`m|${v.id}|${d}`) * 60);
      const at = `${d}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+02:00`;
      if (new Date(at).getTime() > Date.now()) continue;
      const litres = 35 + Math.round(hash(`l|${v.id}|${d}`) * 350) / 10;
      out.push({ id: `fuel-${v.id}-${d}`, vehicleId: v.id, registration: v.registration, who: driverOf(v.id), logged_at: new Date(at).toISOString(), litres, amount_cents: Math.round(litres * PRICE_CENTS), odometer_km: null });
    }
  }
  const myReg = vehicles.find(v => v.id === myVehicleId);
  mine.filter(x => sast(new Date(x.at)) >= from && sast(new Date(x.at)) <= to).forEach((x, n) => {
    if (myReg) out.push({ id: `fuel-mine-${n}`, vehicleId: myReg.id, registration: myReg.registration, who: driverOf(myReg.id), logged_at: x.at, litres: x.litres, amount_cents: Math.round(x.litres * PRICE_CENTS), odometer_km: null });
  });
  return out.sort((a, b) => b.logged_at.localeCompare(a.logged_at));
}

export function demoVehiclesPage(a: {
  month: string | null; can: { fleet: boolean; manageFleet: boolean; handovers: boolean; trips: boolean; fuel: boolean };
  vehicles: FleetVehicle[]; km: { vehicle_id: string; km: number; read_at: string }[]; handovers: number;
  fuel: (from: string, to: string) => DemoFuel[]; trips: (from: string, to: string) => DemoTrip[];
}) {
  const t = sast();
  const month = a.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(a.month) && a.month <= t.slice(0, 7) ? a.month : t.slice(0, 7);
  const from = `${month}-01`, to = month === t.slice(0, 7) ? t : lastDay(month);
  const fuel = a.can.fuel ? a.fuel(from, to) : null;
  const trips = a.can.trips ? a.trips(from, to).map(x => ({ ...x, vehicleId: a.vehicles.find(v => v.registration === x.registration)?.id ?? x.registration })) : null;
  const vehicles = a.can.fleet ? a.vehicles.map(v => {
    const day = (iso: string) => sast(new Date(iso));
    const inMonth = a.km.filter(k => k.vehicle_id === v.id && day(k.read_at) >= from && day(k.read_at) <= to).map(k => k.km);
    const before = a.km.filter(k => k.vehicle_id === v.id && day(k.read_at) < from).map(k => k.km);
    const f = (fuel ?? []).filter(x => x.vehicleId === v.id);
    const litres = Math.round(f.reduce((n, x) => n + x.litres, 0) * 10) / 10;
    // The test drive has few km readings (and old seeded ones): when they don't fit the fuel, about 9 km a litre.
    const read = inMonth.length ? Math.max(...inMonth) - (before.length ? Math.max(...before) : Math.min(...inMonth)) : 0;
    return { ...v, kmMonth: read > 0 && read < litres * 20 + 200 ? read : Math.round(litres * 9), fuelLitres: litres, fuelCents: f.reduce((n, x) => n + x.amount_cents, 0),
      tripsNotAllowed: (trips ?? []).filter(x => x.vehicleId === v.id && x.unauthorised).length };
  }) : [];
  const inService = vehicles.filter(v => v.status === 'in_service');
  const due = (s: { state: string }) => s.state === 'soon' || s.state === 'overdue';
  const bad = (trips ?? []).filter(x => x.unauthorised);
  return {
    month, months: Array.from({ length: 12 }, (_, n) => addMonths(t.slice(0, 7), -n)), can: a.can,
    summary: {
      vehicles: vehicles.length, onRoad: inService.length, off: vehicles.length - inService.length, driving: vehicles.filter(v => v.driver).length,
      checkedToday: inService.filter(v => v.checked_today).length, checksDue: inService.length,
      safetyFaults: vehicles.reduce((n, v) => n + v.safety_faults, 0), openFaults: vehicles.reduce((n, v) => n + v.open_faults, 0),
      serviceDue: vehicles.filter(v => due(v.serviceDue)).length, licenceDue: vehicles.filter(v => due(v.licenceDue)).length,
      handovers: a.can.handovers ? a.handovers : null, tripsNotAllowed: trips ? bad.length : null, tripsNotAllowedKm: trips ? Math.round(bad.reduce((n, x) => n + x.km, 0)) : null,
      fuelLitres: fuel ? Math.round(fuel.reduce((n, x) => n + x.litres, 0) * 10) / 10 : null, fuelCents: fuel ? fuel.reduce((n, x) => n + x.amount_cents, 0) : null,
      kmMonth: a.can.fleet ? vehicles.reduce((n, v) => n + v.kmMonth, 0) : null,
    },
    vehicles, trips, fuel,
  };
}
