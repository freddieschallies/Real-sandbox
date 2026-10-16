// The tab bar at the bottom of the phone screens. With more than five tabs the bar shows four and
// the rest go under "More". The CEO or an admin chooses, per position, which tabs are pinned to the
// bar; until they do, the most used ones are (the order below).
import { DEFAULTS, LEVELS, POSITION_LABEL, workOf, type LoginLevel, type WorkArea } from './permissions.ts';

export type MenuApp = 'office' | 'stockroom' | 'fleet';
export const MAX_PINNED = 4;

/** Every tab each app can have, most used first (the automatic order on the phone). */
export const MENU_TABS: Record<MenuApp, { key: string; label: string }[]> = {
  office: [
    { key: 'setup', label: 'Start-up' }, { key: 'today', label: 'Today' }, { key: 'breakdowns', label: 'Breakdowns' }, { key: 'whatsapp', label: 'WhatsApp' }, { key: 'jobs', label: 'Jobs' }, { key: 'departments', label: 'Departments' },
    { key: 'timesheets', label: 'Timesheets' }, { key: 'flags', label: 'Flags' }, { key: 'people', label: 'People' },
    { key: 'map', label: 'Team map' }, { key: 'vans', label: 'Van stock' }, { key: 'queries', label: 'Queries' },
    { key: 'quotes', label: 'Quotes' }, { key: 'invoices', label: 'Invoices' }, { key: 'supplier', label: 'Supplier invoices' }, { key: 'pos', label: 'Purchase orders' }, { key: 'prices', label: 'Price list' }, { key: 'customers', label: 'Customers' }, { key: 'debtors', label: 'Debtors' }, { key: 'profit', label: 'Profit' }, { key: 'accounts', label: 'Accounts' },
    { key: 'vehicles', label: 'Vehicles' }, { key: 'repairs', label: 'Workshop' }, { key: 'stores', label: 'Stores' }, { key: 'barcodes', label: 'QR codes' }, { key: 'history', label: 'History' }, { key: 'settings', label: 'Settings' },
  ],
  stockroom: [
    { key: 'issue', label: 'To issue' }, { key: 'receive', label: 'To receive' }, { key: 'pos', label: 'Purchase orders' }, { key: 'room', label: 'Stock' },
    { key: 'order', label: 'To order' }, { key: 'count', label: 'Stock take' }, { key: 'suppliers', label: 'Suppliers' }, { key: 'people', label: 'People' }, { key: 'workshop', label: 'Workshop' },
    { key: 'tools', label: 'Tool store' }, { key: 'live', label: 'Live' }, { key: 'items', label: 'New items' },
  ],
  fleet: [
    { key: 'vehicles', label: 'Vehicles' }, { key: 'map', label: 'Map' }, { key: 'bookings', label: 'Booked' },
    { key: 'faults', label: 'Faults' }, { key: 'jobs', label: 'Jobs' }, { key: 'stock', label: 'Stock' }, { key: 'techs', label: 'Techs' }, { key: 'codes', label: 'QR codes' },
  ],
};

/** Which app each position opens. Technicians have their own screen without a tab bar. */
export const APP_OF: Partial<Record<LoginLevel, MenuApp>> = {
  admin: 'office', accounts: 'office', management: 'office', hr: 'office', director: 'office', creator: 'office', stockroom: 'stockroom', mechanic: 'fleet',
};
export const MENU_LEVELS = LEVELS.filter(l => APP_OF[l]);
export const MENU_LABEL: Record<LoginLevel, string> = { ...POSITION_LABEL, director: 'Director', creator: 'CEO' };

/** The office tabs someone sees, from the work the CEO gave them. */
export function officeTabKeys(level: string, work: Partial<Record<WorkArea, boolean>>, opts: { people: boolean; settings: boolean }): string[] {
  const does = (a: WorkArea) => level === 'creator' || !!work[a];
  const jobsSide = level === 'creator' || !!work.jobs;
  const on: Record<string, boolean> = {
    today: jobsSide, jobs: jobsSide || does('jobcards'), queries: does('jobs'), breakdowns: does('jobs'), whatsapp: does('jobs'),
    quotes: does('documents'), invoices: does('documents'), supplier: does('books'), pos: does('jobs') || does('books'), customers: does('documents'), debtors: does('documents'), profit: does('books'), accounts: does('documents'),
    flags: does('flags'), vehicles: does('flags') || does('fleet'), map: does('flags') || level === 'management',
    vans: does('vanstock'), departments: does('hr'),
    // HR and the CEO always have every timesheet; a department manager his own technicians'.
    timesheets: does('hr') || ['management', 'hr', 'director', 'creator', 'accounts'].includes(level),
    // The CEO's start-up checklist for a new company.
    setup: does('access'),
    // Every part and its selling price (for when a client asks): everyone in the office but HR.
    prices: level !== 'hr' || jobsSide,
    // Every change anyone made, kept for good (for in case of fraud): the Creator only.
    history: level === 'creator',
    people: opts.people, repairs: jobsSide, stores: jobsSide, barcodes: jobsSide, settings: opts.settings,
  };
  return MENU_TABS.office.map(t => t.key).filter(k => on[k]);
}

/** The tabs a position has unless the CEO gave someone extra work: shown first on the settings screen. */
export function usualTabs(level: LoginLevel): string[] {
  const app = APP_OF[level];
  if (!app) return [];
  if (app !== 'office') return MENU_TABS[app].map(t => t.key);
  const p = DEFAULTS[level];
  const people = !!(p.manage_access || p.assign_departments || p.view_all_job_cards || p.assign_jobs);
  return officeTabKeys(level, workOf(p), { people, settings: !!p.set_phone_menu });
}

/** Tabs that were renamed: a menu saved with the old name keeps its place. */
export const RENAMED: Record<string, string> = { handovers: 'vehicles' };

/** Clean a chosen list: known tabs of the app, no repeats, at most four. */
export function cleanPinned(app: MenuApp, pinned: string[]): string[] {
  const known = new Set(MENU_TABS[app].map(t => t.key));
  return [...new Set(pinned.map(k => RENAMED[k] ?? k))].filter(k => known.has(k)).slice(0, MAX_PINNED);
}

/**
 * Which of someone's tabs go on the bar and which under More. Nothing chosen: up to five show, or the
 * first four and the rest under More. Chosen: the pinned ones (that this person has) on the bar, the
 * rest under More; a More with just one tab in it is pointless, so that one goes on the bar.
 */
export function arrangeTabs<T extends { key: string }>(tabs: T[], pinned: string[] | null | undefined): { bar: T[]; more: T[] } {
  const chosen = (pinned ?? []).map(k => tabs.find(t => t.key === k)).filter((t): t is T => !!t).slice(0, MAX_PINNED);
  if (!pinned || !chosen.length) {
    if (tabs.length <= 5) return { bar: tabs, more: [] };
    return { bar: tabs.slice(0, 4), more: tabs.slice(4) };
  }
  const more = tabs.filter(t => !chosen.includes(t));
  if (more.length === 1) return { bar: [...chosen, more[0]], more: [] };
  return { bar: chosen, more };
}
