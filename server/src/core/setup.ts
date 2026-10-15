// Starting a company on the app: the CEO's checklist, in the order that works. The monitoring policy
// first (nobody can use the app until they have read it), then the company's details and letterhead,
// departments, the people and what each one does (their role), their logins, the rates, the customers
// and stores, and if they want them the stock list and the vehicles. Each step says when it is done.

export const SETUP_STEPS = [
  { key: 'policy', title: 'Monitoring policy', why: 'Everyone reads and accepts it once before they can use the app.', optional: false },
  { key: 'company', title: 'Company details', why: 'Name, registration and VAT numbers, address, banking details: on every quote, invoice and statement.', optional: false },
  { key: 'numbers', title: 'Carry on your numbering', why: 'The next job card, invoice, quote, credit note and purchase order numbers carry on where your previous system stopped.', optional: false },
  { key: 'branding', title: 'Logo and letterhead', why: 'Your logo in the app, and your letterhead on everything printed or emailed.', optional: true },
  { key: 'departments', title: 'Departments', why: 'The teams your technicians work in, each with its manager.', optional: false },
  { key: 'people', title: 'Employees and their roles', why: 'Everyone who uses the app, and what they do: technician, admin, accounts, stock controller, manager, HR, mechanic.', optional: false },
  { key: 'logins', title: 'Logins', why: 'A setup code for each person; they choose their own password with it.', optional: false },
  { key: 'rates', title: 'Rates and prices', why: 'Labour, call-out and travel rates, and what an hour and a km cost you.', optional: false },
  { key: 'customers', title: 'Customers and stores', why: 'Who you work for and where: from a spreadsheet or one by one.', optional: false },
  { key: 'stock', title: 'Stock list', why: 'The parts you keep, so technicians book them out and invoices price them.', optional: true },
  { key: 'vehicles', title: 'Vehicles', why: 'Your vehicles with their QR codes, for the fleet, fuel and travel.', optional: true },
  { key: 'whatsapp', title: 'WhatsApp', why: 'Breakdowns from your WhatsApp group (or to your WhatsApp number) come into the app, and the office chats from the app.', optional: true },
  { key: 'pastel', title: 'Sage Pastel', why: 'Invoices, credit notes and supplier invoices go to Pastel without typing them again.', optional: true },
] as const;
export type SetupKey = (typeof SETUP_STEPS)[number]['key'];
export interface SetupStep { key: SetupKey; title: string; why: string; optional: boolean; done: boolean; detail: string }

/** What each role (position) does, in one line: shown when choosing someone's role, and in the help. */
export const ROLE_HELP: Record<string, string> = {
  technician: 'Does the jobs on his phone: job cards, stock, fuel, timesheet. Sees only his own work.',
  mechanic: 'Looks after the vehicles: daily checks, services, faults, mechanic job cards.',
  admin: 'The front desk: breakdowns, opening and assigning jobs, stores, quotes and invoices; looks after logins.',
  accounts: 'Invoices, credit notes, supplier invoices, Pastel, customers, debtors and statements; checks every job card.',
  stockroom: 'The stockroom: issues and receives stock, purchase orders, stock takes, the tool store.',
  management: 'A department manager: his own team\'s jobs, flags, timesheets and purchase orders.',
  hr: 'People, departments, staff records and every timesheet; adds employees and their logins.',
  director: 'Sees and runs everything, like the CEO.',
  creator: 'The owner of the system: everything, including who may do what.',
};

/** The usual monitoring policy, with the company's name. The CEO can publish it as it is. */
export function standardPolicy(company: string): string {
  return `${company}: Vehicle and App Monitoring Policy

1. Purpose. ${company} monitors its vehicles and its job app so that work is recorded accurately, clients can be billed fairly, staff and vehicles are kept safe, and company property is protected.

2. What is monitored. Vehicle position, speed, ignition, trips and stops (tracker). Who is in which vehicle (barcode scan). Your phone's location only at the moment you tap Arrived, Start or Dropped off, never in the background. Job card activity, timesheets, fuel, stock and tools on your name, supply runs, and the use of company vehicles outside working hours.

Never monitored: the content of your phone, your location outside those taps, anything after hours on your phone.

3. Automatic checks raise a flag when the tracker and the job card do not match. A flag is a question, not an accusation: you are asked to explain, and your explanation goes to your supervisor.

4. Who can see it: you see your own; managers see their department; directors see all. Every view of the confidential log is recorded.

5. How it is used: planning, invoicing, safety, checking timesheets and fuel, and, where the facts call for it, discipline under the company's code. No disciplinary decision is made on a flag alone.

6. Your rights: you may see the information held about you and ask for corrections (Protection of Personal Information Act). Records are kept for at least 5 years.`;
}

/** The numbers a company carries on from its previous system, and where they start when it doesn't. */
export const NUMBER_KINDS = [
  { kind: 'job', label: 'Job cards', start: 10001, table: 'jobs', column: 'job_number' },
  { kind: 'invoice', label: 'Invoices', start: 7001, table: 'invoices', column: 'invoice_number' },
  { kind: 'quote', label: 'Quotes', start: 5001, table: 'quotes', column: 'quote_number' },
  { kind: 'credit', label: 'Credit notes', start: 9001, table: 'credit_notes', column: 'credit_number' },
  { kind: 'purchase_order', label: 'Purchase orders', start: 1001, table: 'purchase_orders', column: 'po_number' },
] as const;
export type NumberKind = (typeof NUMBER_KINDS)[number]['kind'];
export const MAX_NUMBER = 99_999_999;
/** Why a next number cannot be used: not a whole number, or not above the highest already used. */
export function numberProblem(next: number, highestUsed: number | null): string | null {
  if (!Number.isInteger(next) || next < 1 || next > MAX_NUMBER) return 'a whole number from 1 to 99 999 999';
  if (highestUsed !== null && next <= highestUsed) return `must be more than ${highestUsed}, the highest already used`;
  return null;
}

export interface SetupCounts {
  numbersChecked?: boolean;
  policy: boolean; company: { legal_name?: string | null; address?: string | null; phone?: string | null; email?: string | null; vat_no?: string | null } | null;
  logo: boolean; letterhead: boolean; departments: number; departmentsChecked: boolean;
  people: number; byRole: Record<string, number>; withEmail: number; withLogin: number; noEmail: number;
  rates: Record<string, number>; clients: number; stores: number; stock: number; vehicles: number; skipped: string[];
  whatsapp?: { done: boolean; detail: string }; pastel?: { done: boolean; detail: string };
}

/** Each step, done or not, with what there is so far. */
export function setupSteps(n: SetupCounts): SetupStep[] {
  const roles = Object.entries(n.byRole).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ');
  const has = (k: string) => (n.rates[k] ?? 0) > 0;
  const state: Record<SetupKey, { done: boolean; detail: string }> = {
    policy: { done: n.policy, detail: n.policy ? 'Published' : 'Not published yet: nobody can use the app until it is' },
    numbers: { done: !!n.numbersChecked, detail: n.numbersChecked ? 'Checked' : 'Set them to carry on from your previous system, or tick them as right' },
    company: { done: !!(n.company?.legal_name && n.company.address && (n.company.phone || n.company.email)), detail: n.company?.legal_name ? `${n.company.legal_name}${n.company.vat_no ? ` · VAT ${n.company.vat_no}` : ''}` : 'Not filled in yet' },
    branding: { done: n.logo || n.letterhead, detail: n.logo && n.letterhead ? 'Logo and letterhead' : n.logo ? 'Logo (no letterhead pictures yet)' : n.letterhead ? 'Letterhead (no logo yet)' : 'No logo or letterhead yet' },
    departments: { done: n.departments > 0 && n.departmentsChecked, detail: `${n.departments} department${n.departments === 1 ? '' : 's'}${n.departmentsChecked ? '' : ': check they are right'}` },
    people: { done: n.people > 0, detail: n.people ? `${n.people} ${n.people === 1 ? 'person' : 'people'}${roles ? `: ${roles}` : ''}` : 'Nobody added yet' },
    logins: { done: n.people > 0 && n.withLogin >= n.withEmail && n.withEmail > 0, detail: n.people ? `${n.withLogin} of ${n.people} have a login or a setup code${n.noEmail ? ` · ${n.noEmail} without an email` : ''}` : 'Add people first' },
    rates: { done: has('labour_per_hour') && has('call_out'), detail: has('labour_per_hour') ? `Labour R ${((n.rates.labour_per_hour ?? 0) / 100).toFixed(2)}/h${has('labour_cost_per_hour') ? '' : ' · cost per hour not set (for profit)'}` : 'Not set yet' },
    customers: { done: n.clients > 0 && n.stores > 0, detail: `${n.clients} customer${n.clients === 1 ? '' : 's'}, ${n.stores} store${n.stores === 1 ? '' : 's'}` },
    stock: { done: n.stock > 0 || n.skipped.includes('stock'), detail: n.stock ? `${n.stock} items` : n.skipped.includes('stock') ? 'Skipped' : 'No items yet' },
    vehicles: { done: n.vehicles > 0 || n.skipped.includes('vehicles'), detail: n.vehicles ? `${n.vehicles} vehicles` : n.skipped.includes('vehicles') ? 'Skipped' : 'No vehicles yet' },
    whatsapp: n.whatsapp?.done ? n.whatsapp : n.skipped.includes('whatsapp') ? { done: true, detail: 'Skipped' } : n.whatsapp ?? { done: false, detail: 'Not connected yet' },
    pastel: n.pastel?.done ? n.pastel : n.skipped.includes('pastel') ? { done: true, detail: 'Skipped' } : n.pastel ?? { done: false, detail: 'Not set up yet' },
  };
  return SETUP_STEPS.map(s => ({ ...s, ...state[s.key] }));
}
