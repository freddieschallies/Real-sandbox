// The office screen's data. Changes are sent straight away (the office has signal), so the answer
// (or the reasons it was refused) shows at once.
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../state.tsx';
import { nowIso } from '../device.ts';
import type { CardView } from '../types.ts';

export interface Overview {
  date: string;
  jobs: { today: number; in_progress: number; continue_later: number; carried_over: number; urgent: number; closed_today: number };
  flags: { unresolved: number; explained: number } | null;
  handoversAwaitingApproval: number;
  fleet: { in_service: number; off: number; safety_faults: number; checked_today: number; due: number; missedYesterday: { id: string; registration: string }[] };
  stock: { to_issue: number; to_receive: number; workshop_below_min: number };
  technicians: { active: number; without_work: number };
}
export interface OfficeJob { id: string; job_number: number; job_type: string; priority: string; status: string; scheduled_date: string; fault_reported: string; store: string; lead_technician: string; lead_id?: string; helper_ids?: string[] }
export interface Store { id: string; client: string; name: string; address: string | null; lat: number; lng: number; open_jobs: number }
export interface Tech { id: string; full_name: string; department: string | null; open_jobs: number; working_now: number; vehicle: string | null }
export interface OfficeFlag { id: string; flag_type: string; severity: string; raised_at: string; question: string | null; explanation: string | null; status: string; technician: string | null; job_number: number | null }
export interface Inspection {
  id: string; registration: string; driver: string; previous_driver: string | null; inspected_at: string; odometer_km: number; fuel_level: string;
  problems: string[]; new_problems: string[]; handover_by: string; handed_over_by_name: string | null; remote_reason: string | null; status: string;
}
export interface Person { id: string; full_name: string; login_level: string; position: string; does_fleet?: boolean; work?: Record<string, boolean>; trade?: string | null; tradeLabel?: string | null; department?: string | null; photo_id?: string | null }
export interface JobChange { changed_at: string; by: string; field: string; old_value: string | null; new_value: string | null; reason: string | null }

export interface OfficeData {
  overview: Overview | null; jobs: OfficeJob[]; stores: Store[]; techs: Tech[]; flags: OfficeFlag[]; handovers: Inspection[];
  people: { canManage?: boolean; positions: { level: string; label: string }[]; trades?: { key: string; label: string }[]; areas?: { key: string; label: string }[]; people: Person[] } | null; loadedAt: string | null;
}
const EMPTY: OfficeData = { overview: null, jobs: [], stores: [], techs: [], flags: [], handovers: [], people: null, loadedAt: null };

export type Answer = { ok: true; body: any } | { ok: false; reasons: string[] };

export function useOffice() {
  const s = useStore();
  const [d, setD] = useState<OfficeData>(EMPTY);
  const [loading, setLoading] = useState(false);
  const get = async <T,>(path: string): Promise<T | null> => { const r = await s.ask({ method: 'GET', path }); return r && r.status === 200 ? r.body as T : null; };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [overview, jobs, stores, techs, flags, handovers, people] = await Promise.all([
        get<Overview>('/office/overview'), get<OfficeJob[]>('/jobs'), get<Store[]>('/office/stores'), get<Tech[]>('/office/technicians'),
        get<OfficeFlag[]>('/flags'), get<Inspection[]>('/vehicles/inspections?status=awaiting_approval'), get<OfficeData['people']>('/people'),
      ]);
      setD(x => ({
        overview: overview ?? x.overview, jobs: jobs ?? x.jobs, stores: stores ?? x.stores, techs: techs ?? x.techs, flags: flags ?? x.flags,
        handovers: handovers ?? x.handovers, people: people ?? x.people, loadedAt: overview ? new Date().toISOString() : x.loadedAt,
      }));
    } finally { setLoading(false); }
  }, [s]);

  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);

  const send = async (method: 'POST' | 'PUT' | 'PATCH', path: string, json: object, withAt = false): Promise<Answer> => {
    const r = await s.ask({ method, path, json: withAt ? { ...json, at: nowIso() } : json });
    if (r && r.status < 300) { load(); return { ok: true, body: r.body }; }
    return { ok: false, reasons: (r?.body as { reasons?: string[]; error?: string })?.reasons ?? [(r?.body as { error?: string })?.error ?? 'no signal: try again'] };
  };
  const card = async (id: string) => get<CardView>(`/jobs/${id}`);
  const changes = async (id: string) => get<JobChange[]>(`/jobs/${id}/changes`);

  return { d, loading, load, send, card, changes };
}
export type OfficeHook = ReturnType<typeof useOffice>;
