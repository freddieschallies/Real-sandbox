// Who can do what. Each login type has default access (DEFAULTS below). A person with
// "manage_access" (by default the Director/CEO and the Creator) can change what a whole login
// type may do, or what one person may do. The effective access is worked out once per request
// and carried on the Actor, so checks here stay simple and pure.

export type LoginLevel = 'technician' | 'mechanic' | 'admin' | 'stockroom' | 'management' | 'director' | 'creator';

export const LEVELS: LoginLevel[] = ['technician', 'mechanic', 'admin', 'stockroom', 'management', 'director', 'creator'];

/** What each position is called on screen. The CEO assigns one position to each person. */
export const POSITION_LABEL: Record<LoginLevel, string> = {
  technician: 'Technician', mechanic: 'Mechanic (fleet)', admin: 'Admin', stockroom: 'Stock controller',
  management: 'Manager', director: 'Director / CEO', creator: 'Creator (system owner)',
};

/** For actions about employees: which employees' departments it covers. */
export type DeptScope = { kind: 'own' } | { kind: 'all' } | { kind: 'list'; ids: string[] };
export type Grant = true | DeptScope;
export type Permissions = Partial<Record<Action, Grant>>;

export interface Actor {
  id: string;
  level: LoginLevel;
  departmentId?: string | null;
  perms: Permissions;
}

export interface Subject {
  employeeId?: string;
  employeeDepartmentId?: string | null;
}

/** Every switchable permission, with how it shows on the access screen. scoped = applies per department. */
export const CATALOGUE = {
  view_own_work:              { group: 'Own work', label: 'See and run own jobs, timesheet, fuel', scoped: false },
  create_estimate:            { group: 'Own work', label: 'Make on-site estimates', scoped: false },

  assign_jobs:                { group: 'Jobs', label: 'Create and assign jobs', scoped: false },
  view_all_job_cards:         { group: 'Jobs', label: 'See all job cards', scoped: false },
  manage_stores_equipment:    { group: 'Jobs', label: 'Manage clients, stores and equipment', scoped: false },

  view_live_map_positions:    { group: 'Tracking', label: 'See the live map (positions)', scoped: false },
  view_live_driving_markers:  { group: 'Tracking', label: 'See live driving markers (slow, stopped, off route)', scoped: true },
  view_all_fuel:              { group: 'Tracking', label: 'See fuel logs for all vehicles', scoped: false },

  view_quotes_invoices_stock: { group: 'Office', label: 'See quotes, invoices and stock', scoped: false },
  prepare_quotes_invoices:    { group: 'Office', label: 'Prepare and send quotes and invoices', scoped: false },
  set_prices:                 { group: 'Office', label: 'Set prices and rates', scoped: false },

  view_fleet:                 { group: 'Fleet', label: 'See the fleet: vehicles, faults, km, mechanic job cards', scoped: false },
  manage_fleet:               { group: 'Fleet', label: 'Run the fleet: mechanic job cards, vehicle status, faults', scoped: false },

  manage_stockroom:           { group: 'Stock', label: 'Receive stock into the stockroom', scoped: false },
  assign_stock:               { group: 'Stock', label: 'Assign stock to technicians', scoped: false },
  run_stocktake:              { group: 'Stock', label: 'Run stock takes', scoped: false },

  view_flags:                 { group: 'People', label: 'See flags and explanations', scoped: true },
  resolve_flags:              { group: 'People', label: 'Resolve flags, approve top-up runs', scoped: true },
  view_employee_log:          { group: 'People', label: 'Read staff records (issues and warnings)', scoped: true },
  write_employee_log:         { group: 'People', label: 'Add and delete staff records', scoped: true },
  edit_technician_settings:   { group: 'People', label: 'Technician settings (department, vehicle, home)', scoped: true },
  mark_technician_left:       { group: 'People', label: 'Start a leaver\'s exit checklist', scoped: true },
  view_former_technicians:    { group: 'People', label: 'See former technicians', scoped: true },

  view_director_digest:       { group: 'Reports', label: 'Receive the daily digest', scoped: false },
  view_company_reports:       { group: 'Reports', label: 'Company-wide reports and financial summaries', scoped: false },

  manage_access:              { group: 'System', label: 'Decide who has access to what', scoped: false },
  manage_users:               { group: 'System', label: 'Create and disable logins', scoped: false },
  manage_system_settings:     { group: 'System', label: 'System settings (thresholds, tracker)', scoped: false },
  view_audit_log:             { group: 'System', label: 'See the audit log', scoped: false },
} as const;

export type Action = keyof typeof CATALOGUE;
export const ACTIONS = Object.keys(CATALOGUE) as Action[];
export const isScoped = (a: Action) => CATALOGUE[a].scoped;

// ---- Defaults per login type (stacked, as agreed) -----------------------------

const OWN: DeptScope = { kind: 'own' };
const ALL: DeptScope = { kind: 'all' };

const technician: Permissions = { view_own_work: true, create_estimate: true };
// The mechanic is a position of his own: the fleet only, no jobs.
const mechanic: Permissions = { view_fleet: true, manage_fleet: true };
const admin: Permissions = {
  ...technician,
  assign_jobs: true, view_all_job_cards: true, manage_stores_equipment: true,
  view_live_map_positions: true, view_all_fuel: true,
  view_quotes_invoices_stock: true, prepare_quotes_invoices: true,
};
const stockroom: Permissions = { ...admin, manage_stockroom: true, assign_stock: true, run_stocktake: true };
// Staff records are for the CEO and whoever the CEO gives HR work, not managers by default.
const management: Permissions = {
  ...stockroom, view_fleet: true,
  view_live_driving_markers: OWN, view_flags: OWN, resolve_flags: OWN,
  edit_technician_settings: OWN, mark_technician_left: OWN, view_former_technicians: OWN,
};
const director: Permissions = {
  ...management,
  view_live_driving_markers: ALL, view_flags: ALL, resolve_flags: ALL, view_employee_log: ALL, write_employee_log: ALL,
  edit_technician_settings: ALL, mark_technician_left: ALL, view_former_technicians: ALL,
  set_prices: true, view_director_digest: true, view_company_reports: true, manage_access: true, manage_fleet: true,
};
const creator: Permissions = { ...director, manage_users: true, manage_system_settings: true, view_audit_log: true };

export const DEFAULTS: Record<LoginLevel, Permissions> = { technician, mechanic, admin, stockroom, management, director, creator };

// ---- Changes the CEO makes -----------------------------------------------------

export type Effect = 'grant' | 'deny';
export interface Override {
  action: Action;
  effect: Effect;
  /** For scoped actions: own_department, all_departments or selected_departments. */
  scope?: 'own_department' | 'all_departments' | 'selected_departments';
  departmentIds?: string[];
}

function scopeOf(o: Override): Grant {
  if (!isScoped(o.action)) return true;
  if (o.scope === 'all_departments') return ALL;
  if (o.scope === 'selected_departments') return { kind: 'list', ids: o.departmentIds ?? [] };
  return OWN;
}

/** Defaults for the login type, then changes for the whole type, then changes for this one person. */
export function effectivePermissions(level: LoginLevel, levelOverrides: Override[], userOverrides: Override[]): Permissions {
  const p: Permissions = { ...DEFAULTS[level] };
  for (const list of [levelOverrides, userOverrides]) {
    for (const o of list) {
      if (o.effect === 'deny') delete p[o.action];
      else p[o.action] = scopeOf(o);
    }
  }
  return p;
}

// ---- Checks ----------------------------------------------------------------------

export function can(a: Actor, action: Action, s?: Subject): boolean {
  if (action === 'view_own_work' && s?.employeeId && s.employeeId !== a.id) return can(a, 'view_all_job_cards');
  const g = a.perms[action];
  if (!g) return false;
  if (g === true) return true;
  if (!s || s.employeeDepartmentId === undefined) return false;
  const dept = s.employeeDepartmentId;
  if (g.kind === 'all') return true;
  if (!dept) return false;
  if (g.kind === 'own') return !!a.departmentId && a.departmentId === dept;
  return g.ids.includes(dept);
}

/** For lists: 'all', the department ids the person may see for this action, or null for none. */
export function departmentsFor(a: Actor, action: Action): 'all' | string[] | null {
  const g = a.perms[action];
  if (!g) return null;
  if (g === true || g.kind === 'all') return 'all';
  if (g.kind === 'own') return a.departmentId ? [a.departmentId] : null;
  return g.ids.length ? g.ids : null;
}

/** Convenience for tests and tools: an actor with the defaults of a login type. */
export function actorWithDefaults(id: string, level: LoginLevel, departmentId: string | null = null, overrides: Override[] = []): Actor {
  return { id, level, departmentId, perms: effectivePermissions(level, [], overrides) };
}

/**
 * The kinds of work the CEO switches on or off per person (an Admin who only does quotes and invoices,
 * another who also runs the stockroom). Each is a set of permissions turned on or off together.
 */
export const WORK_AREAS = {
  jobs:      { label: 'Jobs: open, assign and edit', actions: ['assign_jobs', 'view_all_job_cards'] },
  documents: { label: 'Quotes and invoices', actions: ['view_quotes_invoices_stock', 'prepare_quotes_invoices'] },
  stores:    { label: 'Clients, stores and equipment', actions: ['manage_stores_equipment'] },
  stockroom: { label: 'Stockroom (full access)', actions: ['manage_stockroom', 'assign_stock', 'run_stocktake'] },
  fleet:     { label: "Fleet (the mechanic's work)", actions: ['view_fleet', 'manage_fleet'] },
  flags:     { label: 'Flags and approvals', actions: ['view_flags', 'resolve_flags'] },
  prices:    { label: 'Prices and rates', actions: ['set_prices'] },
  access:    { label: 'Positions and access (People)', actions: ['manage_access'] },
  hr:        { label: 'Staff records (HR): issues and warnings', actions: ['view_employee_log', 'write_employee_log'] },
} as const satisfies Record<string, { label: string; actions: readonly Action[] }>;
export type WorkArea = keyof typeof WORK_AREAS;

/** What kind of technician someone is. */
export const TRADES = { foodservice: 'Foodservice tech', plumber: 'Plumber', electrician: 'Electrician', assistant: 'Assistant' } as const;
export type Trade = keyof typeof TRADES;

/** Which kinds of work a set of permissions covers (all of an area's permissions, for any department). */
export function workOf(p: Permissions): Record<WorkArea, boolean> {
  return Object.fromEntries(Object.entries(WORK_AREAS).map(([k, a]) => [k, a.actions.every(x => !!p[x as Action])])) as Record<WorkArea, boolean>;
}
