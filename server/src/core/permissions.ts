// Login levels and what each one may do. Levels are stacked: each sees everything below it.
// Stockroom sits at Admin level.

export type LoginLevel = 'technician' | 'admin' | 'stockroom' | 'management' | 'director' | 'creator';

const RANK: Record<LoginLevel, number> = {
  technician: 0,
  admin: 1,
  stockroom: 1,
  management: 2,
  director: 3,
  creator: 4,
};

export interface Actor {
  id: string;
  level: LoginLevel;
  departmentId?: string | null;
  extra?: ReadonlyArray<'pricing'>;
}

export interface Subject {
  /** The employee the data is about (technician). */
  employeeId?: string;
  employeeDepartmentId?: string | null;
}

export type Action =
  | 'view_own_work'
  | 'create_estimate'
  | 'assign_jobs'
  | 'manage_stores_equipment'
  | 'view_quotes_invoices_stock'
  | 'prepare_quotes_invoices'
  | 'view_all_job_cards'
  | 'view_live_map_positions'
  | 'view_live_driving_markers'
  | 'view_flags'
  | 'resolve_flags'
  | 'view_employee_log'
  | 'write_employee_log'
  | 'edit_technician_settings'
  | 'mark_technician_left'
  | 'view_former_technicians'
  | 'manage_stockroom'
  | 'assign_stock'
  | 'run_stocktake'
  | 'set_prices'
  | 'grant_pricing_access'
  | 'view_director_digest'
  | 'view_company_reports'
  | 'manage_users'
  | 'manage_system_settings'
  | 'view_audit_log'
  | 'view_all_fuel';

const atLeast = (a: Actor, l: LoginLevel) => RANK[a.level] >= RANK[l];

/** True when the subject is in the actor's own department (Management is limited to its own). */
function ownDepartment(a: Actor, s?: Subject): boolean {
  if (!s || s.employeeDepartmentId === undefined) return false;
  return !!a.departmentId && a.departmentId === s.employeeDepartmentId;
}

/** Management sees its own department only; Director and Creator see everyone. */
function teamScoped(a: Actor, s?: Subject): boolean {
  if (atLeast(a, 'director')) return true;
  if (a.level === 'management') return ownDepartment(a, s);
  return false;
}

export function can(a: Actor, action: Action, s?: Subject): boolean {
  switch (action) {
    case 'view_own_work':
      return !s?.employeeId || s.employeeId === a.id || atLeast(a, 'admin');
    case 'create_estimate':
      return true;

    case 'assign_jobs':
    case 'manage_stores_equipment':
    case 'view_quotes_invoices_stock':
    case 'prepare_quotes_invoices':
    case 'view_all_job_cards':
    case 'view_live_map_positions':
    case 'view_all_fuel':
      return atLeast(a, 'admin');

    case 'manage_stockroom':
    case 'assign_stock':
    case 'run_stocktake':
      return a.level === 'stockroom' || atLeast(a, 'management');

    case 'view_live_driving_markers':
      return atLeast(a, 'management');

    case 'view_flags':
    case 'resolve_flags':
    case 'view_employee_log':
    case 'write_employee_log':
    case 'edit_technician_settings':
    case 'mark_technician_left':
    case 'view_former_technicians':
      return teamScoped(a, s);

    case 'set_prices':
      return atLeast(a, 'director') || (a.extra ?? []).includes('pricing');
    case 'grant_pricing_access':
      return a.level === 'director';

    case 'view_director_digest':
    case 'view_company_reports':
      return atLeast(a, 'director');

    case 'manage_users':
    case 'manage_system_settings':
    case 'view_audit_log':
      return a.level === 'creator';
  }
}
