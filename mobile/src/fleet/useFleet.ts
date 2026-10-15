// The mechanic's data, kept on the phone; changes go through the same outbox as everything else.
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../state.tsx';
import { nowIso, takePhoto } from '../device.ts';
import type { Booking, DailyCheckDay, Fault, FleetJob, FleetVehicle, Position, Technician, VehicleDetail } from './types.ts';

export interface FleetData {
  vehicles: FleetVehicle[]; faults: Fault[]; jobs: FleetJob[]; details: Record<string, VehicleDetail>; loadedAt: string | null;
  bookings: Booking[]; positions: Position[]; techs: Technician[]; checks: DailyCheckDay | null;
}
const EMPTY: FleetData = { vehicles: [], faults: [], jobs: [], details: {}, loadedAt: null, bookings: [], positions: [], techs: [], checks: null };
export type Shot = { id: string; uri: string; mime: string };

/** active: false keeps it quiet (nothing loaded) until it is needed, e.g. the office away from its Vehicles page. */
export function useFleet(active = true) {
  const s = useStore();
  const [d, setD] = useState<FleetData>(() => ({ ...EMPTY, ...(s.cache.fleet as Partial<FleetData> | undefined) }));
  const [loading, setLoading] = useState(false);

  const save = useCallback((fn: (x: FleetData) => FleetData) => {
    setD(prev => { const next = fn(prev); s.patchCache(c => ({ ...c, fleet: next })); return next; });
  }, [s]);

  const get = async <T,>(path: string): Promise<T | null> => { const r = await s.ask({ method: 'GET', path }); return r && r.status === 200 ? r.body as T : null; };

  const load = useCallback(async () => {
    if (s.waiting) { await s.syncNow(); if (s.waiting) return; }
    setLoading(true);
    try {
      const [vehicles, faults, jobs, bookings, positions, techs] = await Promise.all([
        get<FleetVehicle[]>('/fleet'), get<Fault[]>('/fleet/faults'), get<FleetJob[]>('/fleet/jobs?status=open'),
        get<Booking[]>('/fleet/bookings'), get<Position[]>('/fleet/positions'), get<Technician[]>('/fleet/technicians'),
      ]);
      const checks = await get<DailyCheckDay>('/fleet/daily-checks');
      if (!vehicles) return;
      save(x => ({ ...x, vehicles, faults: faults ?? x.faults, jobs: jobs ?? x.jobs, bookings: bookings ?? x.bookings, positions: positions ?? x.positions, techs: techs ?? x.techs, checks: checks ?? x.checks, loadedAt: new Date().toISOString() }));
    } finally { setLoading(false); }
  }, [s, save]);

  const loadVehicle = useCallback(async (id: string) => {
    const v = await get<VehicleDetail>(`/fleet/vehicles/${id}`);
    if (v) save(x => ({ ...x, details: { ...x.details, [id]: v } }));
  }, [s, save]);

  useEffect(() => { if (!active) return; load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, [active]);

  const shoot = async (): Promise<Shot | null> => { const p = await takePhoto(); return p ? { id: s.newId(), uri: p.uri, mime: p.mime } : null; };
  const upload = (label: string, kind: string, p: Shot) =>
    s.queue(label, { method: 'POST', path: '/photos', upload: { fields: { kind, takenAt: nowIso(), id: p.id }, fileUri: p.uri, mime: p.mime } });

  /** Sends a change and reloads once it has gone through. */
  const act = async (label: string, method: 'POST' | 'PATCH', path: string, json: object, then?: () => void) => {
    s.queue(label, { method, path, json });
    then?.();
    setTimeout(() => { load(); }, 600);
  };

  return { d, loading, load, loadVehicle, save, shoot, upload, act };
}
