// The office's Vehicles page (the CEO's tab, which used to be Handovers): everything about the vehicles in
// one place. Who is driving what, handovers to approve, faults, services and licence discs due, daily
// checks, fuel, km and trips not allowed, for a month. Each part only for whoever may see it.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, departmentsFor } from '../core/permissions.ts';
import { Refused, parse } from '../http.ts';
import { fleetRows } from './fleet.ts';
import { tripScope, tripsBetween } from './timesheets.ts';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const lastDay = (month: string) => { const d = new Date(`${month}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1, 0); return d.toISOString().slice(0, 10); };
const addMonths = (m: string, n: number) => { const d = new Date(`${m}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };

export function registerVehicleRoutes(app: FastifyInstance) {
  app.get('/office/vehicles', async req => {
    const a = req.actor;
    const fleet = can(a, 'view_fleet');
    const handoverDepts = departmentsFor(a, 'resolve_flags');
    const tripDepts = tripScope(a);
    const fuelOk = fleet || can(a, 'view_all_fuel');
    if (!fleet && !handoverDepts && !tripDepts) throw new Refused(403, ['the Vehicles page is for the fleet, and for flags and approvals']);
    const q = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month like 2026-10').optional() }), req.query);
    const t = today();
    const month = q.month && q.month <= t.slice(0, 7) ? q.month : t.slice(0, 7);
    const from = `${month}-01`;
    const to = month === t.slice(0, 7) ? t : lastDay(month);
    const db = req.db;

    const rows = fleet ? await fleetRows(db) : [];
    // This month per vehicle: km driven (readings), fuel, and trips not allowed.
    const kmRows = fleet ? (await db.query(
      `SELECT vehicle_id, max(km) FILTER (WHERE (read_at AT TIME ZONE 'Africa/Johannesburg')::date BETWEEN $1::date AND $2::date)::float AS hi,
              max(km) FILTER (WHERE (read_at AT TIME ZONE 'Africa/Johannesburg')::date < $1::date)::float AS before,
              min(km) FILTER (WHERE (read_at AT TIME ZONE 'Africa/Johannesburg')::date BETWEEN $1::date AND $2::date)::float AS lo
         FROM odometer_readings GROUP BY vehicle_id`, [from, to])).rows : [];
    const kmOf = new Map(kmRows.map(r => [r.vehicle_id as string, r.hi == null ? 0 : Math.max(0, Math.round(r.hi - (r.before ?? r.lo ?? r.hi)))]));
    const fuel = fuelOk ? (await db.query(
      `SELECT f.id, f.vehicle_id, v.registration, u.full_name AS who, f.logged_at, f.litres::float AS litres, f.amount_cents, f.odometer_km::float AS odometer_km
         FROM fuel_logs f JOIN vehicles v ON v.id = f.vehicle_id JOIN users u ON u.id = f.user_id
        WHERE (f.logged_at AT TIME ZONE 'Africa/Johannesburg')::date BETWEEN $1::date AND $2::date ORDER BY f.logged_at DESC`, [from, to])).rows : null;
    const trips = tripDepts ? (await tripsBetween(db, from, to, { departments: tripDepts })).filter(x => x.why.length) : null;

    const vehicles = rows.map(v => {
      const f = (fuel ?? []).filter(x => x.vehicle_id === v.id);
      return { ...v, kmMonth: kmOf.get(v.id) ?? 0, fuelLitres: Math.round(f.reduce((n, x) => n + x.litres, 0) * 10) / 10, fuelCents: f.reduce((n, x) => n + x.amount_cents, 0),
        tripsNotAllowed: (trips ?? []).filter(x => x.vehicleId === v.id && x.unauthorised).length };
    });
    const handovers = handoverDepts ? Number((await db.query(
      `SELECT count(*)::int AS n FROM vehicle_inspections i JOIN users d ON d.id = i.driver_id
        WHERE i.status = 'awaiting_approval' AND ($1::uuid[] IS NULL OR d.department_id = ANY($1))`, [handoverDepts === 'all' ? null : handoverDepts])).rows[0].n) : null;

    const inService = vehicles.filter(v => v.status === 'in_service');
    const due = (s: { state: string }) => s.state === 'soon' || s.state === 'overdue';
    const summary = {
      vehicles: vehicles.length, onRoad: inService.length, off: vehicles.length - inService.length,
      driving: vehicles.filter(v => v.driver).length, checkedToday: inService.filter(v => v.checked_today).length, checksDue: inService.length,
      safetyFaults: vehicles.reduce((n, v) => n + v.safety_faults, 0), openFaults: vehicles.reduce((n, v) => n + v.open_faults, 0),
      serviceDue: vehicles.filter(v => due(v.serviceDue)).length, licenceDue: vehicles.filter(v => due(v.licenceDue)).length,
      handovers, tripsNotAllowed: trips ? trips.filter(x => x.unauthorised).length : null, tripsNotAllowedKm: trips ? Math.round(trips.filter(x => x.unauthorised).reduce((n, x) => n + x.km, 0)) : null,
      fuelLitres: fuel ? Math.round(fuel.reduce((n, x) => n + x.litres, 0) * 10) / 10 : null, fuelCents: fuel ? fuel.reduce((n, x) => n + x.amount_cents, 0) : null,
      kmMonth: fleet ? vehicles.reduce((n, v) => n + v.kmMonth, 0) : null,
    };
    return {
      month, months: Array.from({ length: 12 }, (_, n) => addMonths(t.slice(0, 7), -n)),
      can: { fleet, manageFleet: can(a, 'manage_fleet'), handovers: !!handoverDepts, trips: !!tripDepts, fuel: fuelOk },
      summary, vehicles, trips, fuel: fuel?.map(({ vehicle_id: _v, ...x }) => ({ ...x, vehicleId: _v })) ?? null,
    };
  });
}
