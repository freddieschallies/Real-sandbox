// Shapes of what the server sends (see server/src/routes).
import type { Visit, WorkItem, JobType } from '../../server/src/core/jobCard.ts';

export interface Session {
  mode: 'demo' | 'server';
  baseUrl: string;
  token: string;
  user: { id: string; name: string; level: string };
  company: { id: string; name: string };
}

export interface TodayJob {
  id: string;
  job_number: number;
  job_type: JobType;
  priority: 'urgent' | 'normal' | 'scheduled';
  status: 'assigned' | 'in_progress' | 'continue_later' | 'closed';
  scheduled_date: string;
  fault_reported: string;
  store: string;
  address: string | null;
  i_am_lead: boolean;
  planned_return: string | null;
  carried_over: boolean;
}

export interface Today {
  date: string;
  jobs: TodayJob[];
  vehicle: {
    id: string; registration: string; mode: 'driving' | 'riding_along'; dropped_off_at: string | null;
    handover_status?: 'signed' | 'awaiting_approval' | 'approved' | 'rejected' | null;
  } | null;
  flagsToAnswer: number;
  unreadNotices: number;
}

export interface CardItem extends WorkItem {
  status: 'not_started' | 'in_progress' | 'finished';
  missing: string[];
}

export interface CardView {
  id: string;
  job_number: number;
  job_type: JobType;
  priority: string;
  status: TodayJob['status'];
  fault_reported: string;
  scheduled_date: string;
  client_order_ref: string | null;
  store_id: string;
  store: string;
  store_address: string | null;
  store_lat: number;
  store_lng: number;
  geofence_m: number;
  lead_technician: string;
  manager_name: string | null;
  visits: Visit[];
  currentState: Visit['state'];
  jobMinutes: number;
  checklist: { id: string; step: string; done: boolean }[];
  equipment: { id: string; brand: string | null; model: string | null; serial: string | null; description: string }[];
  storeManagers: string[];
  items: CardItem[];
}

export interface StockLine { id: string; code: string; description: string; unit: string; qty: number }

export interface Flag {
  id: string;
  flag_type: string;
  severity: string;
  raised_at: string;
  question: string | null;
  explanation: string | null;
  status: string;
  details: Record<string, unknown>;
}

export interface Policy { id: string; version: string; body: string }

/** One holding on my name: van stock (holdingJobId null) or stock for a job. */
export interface InventoryLine {
  stockItemId: string; code: string; description: string; unit: string; needsReview: boolean;
  holdingJobId: string | null; jobNumber: number | null; jobStatus: string | null; store: string | null;
  qty: number; pendingReturn: number; mustReturn: boolean;
}

export interface CatalogueLine { id: string; code: string; description: string; unit: string; inStockroom: number }

export interface JobStockLine { stockItemId: string; code: string; description: string; unit: string; booked: number; used: number; returned: number; onTechnician: number; requested: number }

export interface ReadLine { description: string; supplierCode: string | null; qty: number; unitPriceCents: number | null }

export interface SupplierInvoice {
  id: string;
  status: 'reading' | 'to_confirm' | 'confirmed' | 'unreadable';
  job_id: string | null;
  photo_id?: string;
  supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total_cents: number | null;
  scanned_at: string;
  confirmed_at: string | null;
  read_result: { supplierName: string | null; invoiceNumber: string | null; invoiceDate: string | null; totalCents: number | null; vatCents: number | null; lines: ReadLine[] } | null;
  read_error: string | null;
  /** Phone only: the photo as taken, until the office has it. */
  localPhotoUri?: string;
}

export interface StockReturn {
  id: string; technician?: string; status: 'pending' | 'received'; requested_at: string; received_at: string | null; note: string | null;
  lines: { lineId: string; stockItemId: string; code: string; description: string; holdingJobId: string | null; jobNumber: number | null; qty: number; qtyReceived: number | null }[];
}

/** A request to the stockroom: nothing is on the technician's name until the stock controller issues it. */
export interface StockRequest {
  id: string; technician_id?: string; technician?: string; job_id: string | null; job_number: number | null; store: string | null;
  status: 'pending' | 'issued' | 'rejected'; requested_at: string; decided_at: string | null; note: string | null; decided_by?: string | null;
  lines: { lineId: string; stockItemId: string; code: string; description: string; unit: string; qtyRequested: number; qtyIssued: number | null; inStockroom: number }[];
}
