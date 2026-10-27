// What a company has, set by the owner of Real Sandbox when the company is set up (and changed later):
// the positions it uses, the parts of the app, and what it pays. Pure: the server and the app share it.
import type { LoginLevel, WorkArea } from './permissions.ts';

/** Positions a company may or may not have. Technicians and the CEO are always there. */
export const OPTIONAL_POSITIONS = ['admin', 'accounts', 'stockroom', 'management', 'hr', 'mechanic', 'director'] as const satisfies readonly LoginLevel[];
export type OptionalPosition = (typeof OPTIONAL_POSITIONS)[number];

/** The work of each position: when a company does not have it, the CEO has it and appoints people to it. */
export const POSITION_WORK: Record<OptionalPosition, { areas: WorkArea[]; what: string }> = {
  admin: { areas: ['jobs', 'documents', 'stores'], what: 'opening and assigning jobs, quotes and invoices, clients and stores' },
  accounts: { areas: ['books', 'documents', 'rates', 'pay'], what: 'supplier invoices, quotes and invoices, client rates, pay and profit' },
  stockroom: { areas: ['stockroom'], what: 'the stockroom: issuing, receiving, ordering and stock takes' },
  management: { areas: ['jobs', 'flags', 'vanstock'], what: 'running technicians: jobs, flags and van stock' },
  hr: { areas: ['hr'], what: 'people, departments, staff records and timesheets' },
  mechanic: { areas: ['fleet'], what: 'the vehicles: job cards, faults, bookings and daily checks' },
  director: { areas: [], what: 'the CEO\'s deputy (the CEO does this)' },
};

/** Parts of the app a company can have or not (the rest is always there). */
export const PARTS = {
  fleet: 'Vehicles and the vehicle workshop (Fleet)',
  workshop: 'Machine workshop and loan machines',
  whatsapp: 'WhatsApp (breakdowns group and chats)',
  pastel: 'Pastel accounting link',
} as const;
export type Part = keyof typeof PARTS;
export const PART_KEYS = Object.keys(PARTS) as Part[];

/** The server paths of each part: refused when the company does not have it. */
export const PART_PATHS: Record<Part, RegExp> = {
  fleet: /^\/(fleet|vehicles|fuel)(\/|$)|^\/office\/vehicles(\/|$)/,
  workshop: /^\/(workshop|loan-machines)(\/|$)|^\/company\/workshop$|^\/jobs\/[^/]+\/(uplift|workshop-start|loan-out|loan-back|deliver)$/,
  whatsapp: /^\/whatsapp(\/|$)/,
  pastel: /^\/pastel(\/|$)/,
};

export interface CompanyPlan { positions: OptionalPosition[]; parts: Part[] }
/** What a company has (NULL in the database: everything, as before plans). */
export function planOf(row: { positions: string[] | null; parts: string[] | null }): CompanyPlan {
  return {
    positions: (row.positions ?? OPTIONAL_POSITIONS).filter((p): p is OptionalPosition => (OPTIONAL_POSITIONS as readonly string[]).includes(p)),
    parts: (row.parts ?? PART_KEYS).filter((p): p is Part => p in PARTS),
  };
}
/** Whether a company may give someone this position. */
export const hasPosition = (plan: CompanyPlan, level: string) => level === 'technician' || level === 'creator' || (plan.positions as string[]).includes(level);
/** The part a request belongs to, if the company does not have it. */
export function partMissing(plan: CompanyPlan, path: string): Part | null {
  for (const p of PART_KEYS) if (!plan.parts.includes(p) && PART_PATHS[p].test(path)) return p;
  return null;
}

// ---- Billing ----------------------------------------------------------------------------------

export interface Billing { plan_name: string; base_cents: number; per_user_cents: number; free_users: number; billing_day: number; due_days: number; grace_days: number; auto_suspend: boolean }
export interface InvoiceLine { description: string; qty: number; unitCents: number; totalCents: number }

/** A month's invoice: the plan, and each person on the app above the free ones. */
export function monthCharge(b: Billing, users: number, period: string, vat?: { pct: number; registered: boolean }) {
  const lines: InvoiceLine[] = [];
  const month = new Date(`${period}-15T12:00:00Z`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (b.base_cents) lines.push({ description: `${b.plan_name}: ${month}`, qty: 1, unitCents: b.base_cents, totalCents: b.base_cents });
  const extra = Math.max(0, users - b.free_users);
  if (b.per_user_cents && extra) lines.push({ description: `People on the app: ${users}${b.free_users ? ` (${b.free_users} included)` : ''}`, qty: extra, unitCents: b.per_user_cents, totalCents: extra * b.per_user_cents });
  const ex = lines.reduce((n, l) => n + l.totalCents, 0);
  const vatCents = vat?.registered ? Math.round(ex * (vat.pct / 100)) : 0;
  if (vatCents) lines.push({ description: `VAT ${vat!.pct}%`, qty: 1, unitCents: vatCents, totalCents: vatCents });
  return { lines, amountCents: ex + vatCents };
}

/** Where an invoice stands on a day. */
export function invoiceState(inv: { due_on: string; paid_at: string | null; cancelled_at: string | null }, today: string, graceDays: number) {
  if (inv.cancelled_at) return 'cancelled' as const;
  if (inv.paid_at) return 'paid' as const;
  if (today <= inv.due_on) return 'due' as const;
  const over = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${inv.due_on}T12:00:00Z`)) / 86_400_000);
  return over > graceDays ? 'suspend' as const : 'overdue' as const;
}
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
