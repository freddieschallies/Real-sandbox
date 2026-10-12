import type { Due, FaultSeverity, FleetJobType, FluidResult, TyreResult, VehicleStatus } from '../../../server/src/core/fleet.ts';

export interface FleetVehicle {
  id: string; registration: string; description: string | null; make: string | null; model: string | null; year: number | null;
  status: VehicleStatus; status_note: string | null; licence_expiry: string | null; next_service_km: number | null; next_service_at: string | null;
  km: number | null; driver: string | null; open_faults: number; safety_faults: number;
  open_job: { id: string; number: number; type: FleetJobType } | null;
  serviceDue: Due; licenceDue: Due;
  checked_today?: { oil: FluidResult; oilLitres: number | null; water: FluidResult; tyres: TyreResult; at: string } | null;
}

export interface Fault {
  id: string; vehicle_id: string; registration?: string; description: string; severity: FaultSeverity; source: 'driver' | 'handover' | 'mechanic';
  status: 'open' | 'in_progress' | 'fixed' | 'deferred'; reported_at: string; reported_by_name?: string; photo_ids?: string[];
  fleet_job_id?: string | null; closed_note?: string | null;
}

export interface FleetJobPart { id: string; description: string; qty: number; unitCostCents: number | null; source: 'stockroom' | 'bought' | 'other' | 'workshop' }

export interface FleetJob {
  id: string; number: number; vehicle_id: string; registration: string; job_type: FleetJobType; status: 'open' | 'completed'; reason: string;
  opened_at: string; odometer_in: number; found_text: string | null; did_text: string | null; labour_hours: number | null;
  before_photo_ids: string[]; after_photo_ids: string[]; mechanic: string; faults: Pick<Fault, 'id' | 'description' | 'severity' | 'status'>[]; parts: FleetJobPart[];
}

export interface VehicleDetail {
  vehicle: FleetVehicle & { vin: string | null; engine_no: string | null; service_interval_km: number; service_interval_months: number; tank_litres: number };
  serviceDue: Due; licenceDue: Due;
  faults: Fault[];
  jobs: { id: string; number: number; job_type: FleetJobType; status: string; reason: string; opened_at: string; completed_at: string | null; odometer_in: number; odometer_out: number | null; found_text: string | null; did_text: string | null; labour_hours: number | null; mechanic: string; parts_cents: number }[];
  km: { km: number; read_at: string; source: string; by: string }[];
  dailyChecks?: DailyCheck[];
  inspections: { id: string; inspected_at: string; odometer_km: number; fuel_level: string; problems: string[]; new_problems: string[]; driver: string }[];
}

export type TimeSlot = 'morning' | 'afternoon' | 'all_day';
export interface Booking {
  id: string; vehicle_id: string; registration: string; job_type: FleetJobType; booked_for: string; time_slot: TimeSlot; place: string; reason: string;
  status: 'booked' | 'started' | 'cancelled'; booked_at: string; booked_by: string; fleet_job_id: string | null; cancelled_note: string | null; driver: string | null;
}
export interface Position {
  id: string; registration: string; status: VehicleStatus; lat: number | null; lng: number | null; speed_kmh: number | null; ignition: boolean | null;
  recorded_at: string | null; minutesAgo: number | null; driver: string | null;
}
export interface Technician { id: string; full_name: string; mode: 'driving' | 'riding_along' | null; vehicle_id: string | null; registration: string | null }

export interface DailyCheck {
  id: string; check_date: string; checked_at: string; by: string; odometer_km: number; oil: FluidResult; oil_litres: number | null;
  water: FluidResult; water_litres: number | null; tyres: TyreResult; notes: string | null;
}
export interface DailyCheckDay {
  date: string; done: number; due: number;
  vehicles: ({ vehicle_id: string; registration: string; status: VehicleStatus; required: boolean } & Partial<Omit<DailyCheck, 'id'>> & { id: string | null })[];
}
