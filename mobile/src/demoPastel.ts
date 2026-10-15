// The test drive's Pastel set-up: the same matching as the server (core/pastelSetup.ts), on the demo's
// customers, suppliers and stock. "Use a sample file" stands in for Pastel's own export.
import * as P from '../../server/src/core/pastel.ts';
import * as PS from '../../server/src/core/pastelSetup.ts';

type Res = { ok: true; body: unknown } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown): Res => ({ ok: true, body });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });

export interface DemoPastelState {
  lists: Partial<Record<PS.ListKind, { entries: PS.Entry[]; filename: string | null; uploadedAt: string }>>;
  itemCodes: Record<string, string>; doneAt: string | null; note: string | null; yearSaved: boolean;
}
export const seedPastelSetup = (): DemoPastelState => ({ lists: {}, itemCodes: {}, doneAt: null, note: null, yearSaved: false });

export interface PastelDeps {
  clients: () => { id: string; name: string; pastel_code: string | null }[];
  setClient: (id: string, code: string | null) => void;
  suppliers: () => { id: string; name: string; pastel_code: string | null }[];
  setSupplier: (id: string, code: string | null) => void;
  items: () => { id: string; code: string; description: string }[];
  settings: () => P.PastelSettings;
  vatNo: () => string | null;
  vatPct: () => number;
}

export class DemoPastelSetup {
  constructor(public s: DemoPastelState, private d: PastelDeps, private books: boolean) {}

  setup() {
    const L = this.s.lists;
    const entries = (k: PS.ListKind) => L[k]?.entries ?? [];
    const settings = this.d.settings();
    const clients = this.d.clients().map(c => ({ id: c.id, name: c.name, code: c.pastel_code }));
    const suppliers = this.books ? this.d.suppliers().map(c => ({ id: c.id, name: c.name, code: c.pastel_code })) : [];
    const items = this.d.items().map(i => ({ ...i, pastelCode: this.s.itemCodes[i.id] ?? null }));
    const unchecked = (xs: { id: string; name: string; code: string | null }[]): PS.Match[] => xs.map(x => ({ id: x.id, name: x.name, current: x.code, code: x.code, codeName: null, how: x.code ? 'has' : 'none', score: 0 }));
    const customers = L.customers ? PS.matchNames(clients, entries('customers')) : unchecked(clients);
    const supp = L.suppliers ? PS.matchNames(suppliers, entries('suppliers')) : unchecked(suppliers);
    const stock = L.items ? PS.matchItems(items, entries('items')) : [];
    const need: PS.LineKey[] = ['labour', 'call_out', 'travel', 'bought_out', 'other', 'credit', ...(this.books ? ['purchases' as const] : [])];
    const missingLines = need.filter(k => !settings.codes[k]?.code);
    const steps = [
      { key: 'customers', done: clients.length > 0 && clients.every(x => x.code) },
      ...(this.books ? [{ key: 'suppliers', done: suppliers.every(x => x.code) }] : []),
      { key: 'lines', done: !missingLines.length },
      { key: 'year', done: this.s.yearSaved },
      { key: 'items', done: !items.length || (!!L.items && !stock.some(m => m.how === 'sure' || m.how === 'check')) },
      { key: 'practice', done: !!this.s.doneAt },
    ];
    const info = (k: PS.ListKind) => (L[k] ? { count: L[k]!.entries.length, filename: L[k]!.filename, uploadedAt: L[k]!.uploadedAt } : null);
    return {
      steps, done: steps.every(x => x.done), books: this.books,
      lists: { customers: info('customers'), suppliers: this.books ? info('suppliers') : null, accounts: info('accounts'), items: info('items') },
      customers, suppliers: supp, items: stock, itemsTotal: items.length,
      pastel: { customers: entries('customers'), suppliers: this.books ? entries('suppliers') : [], accounts: entries('accounts'), items: entries('items') },
      lineNeed: need, lineNames: PS.LINE_NAME, suggest: PS.suggestLineCodes(entries('accounts'), entries('items')), missingLines,
      settings, vatNo: this.d.vatNo(), setupDoneAt: this.s.doneAt, practiceNote: this.s.note,
    };
  }

  list(kind: PS.ListKind, rows: string[][] | null, filename: string | null): Res {
    if (kind === 'suppliers' && !this.books) return bad(403, 'suppliers are for Accounts');
    const entries = rows ? PS.readPastelList(rows) : this.sample(kind);
    if (!entries.length) return bad(400, 'no codes and names found in that file: in Pastel use File → Import/Export (or save the listing report to Excel), then try again');
    this.s.lists[kind] = { entries, filename: rows ? filename : 'sample from Pastel (test drive)', uploadedAt: new Date().toISOString() };
    return good(this.setup());
  }

  /** What Pastel's own export would hold for the demo company (a few names differ a little, as in real life). */
  private sample(kind: PS.ListKind): PS.Entry[] {
    const code = (name: string, n: number) => `${name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X')}${String(n).padStart(3, '0')}`;
    if (kind === 'customers') return [...this.d.clients().map((c, i) => ({ code: code(c.name, i + 1), name: i % 3 === 0 ? `${c.name} (Pty) Ltd` : c.name })), { code: 'CAS001', name: 'Cash Sales' }];
    if (kind === 'suppliers') return this.d.suppliers().map((c, i) => ({ code: code(c.name, i + 1), name: i % 2 ? `${c.name} CC` : c.name }));
    if (kind === 'accounts') return [
      { code: '1000000', name: 'Sales' }, { code: '1050000', name: 'Sales Returns' }, { code: '1100000', name: 'Travel Recovered' }, { code: '2000000', name: 'Purchases' },
      { code: '3000000', name: 'Accounting Fees' }, { code: '3050000', name: 'Bank Charges' }, { code: '8400000', name: 'Bank' }];
    return [{ code: 'LABOUR', name: 'Labour per hour' }, { code: 'CALLOUT', name: 'Call-out fee' },
      ...this.d.items().map((i, n) => (n % 4 === 3 ? { code: `P${String(n + 100).padStart(4, '0')}`, name: i.description } : { code: i.code, name: i.description }))];
  }

  codes(b: { clients?: { id: string; code: string | null }[]; suppliers?: { id: string; code: string | null }[]; items?: { id: string; code: string | null }[] }): Res {
    const all = [...(b.clients ?? [])];
    const seen = new Map<string, string>();
    for (const x of all) if (x.code) { const k = x.code.toUpperCase(); if (seen.has(k) && seen.get(k) !== x.id) return bad(409, `${x.code} is chosen for two customers`); seen.set(k, x.id); }
    if ((b.suppliers ?? []).length && !this.books) return bad(403, 'suppliers are for Accounts');
    for (const x of b.clients ?? []) this.d.setClient(x.id, x.code ? x.code.toUpperCase() : null);
    for (const x of b.suppliers ?? []) this.d.setSupplier(x.id, x.code ? x.code.toUpperCase() : null);
    const items = this.d.items();
    for (const x of b.items ?? []) {
      const it = items.find(i => i.id === x.id);
      if (!it) continue;
      if (!x.code || x.code.toUpperCase() === it.code.toUpperCase()) delete this.s.itemCodes[x.id]; else this.s.itemCodes[x.id] = x.code;
    }
    return good(this.setup());
  }

  saved() { this.s.yearSaved = true; }

  practice(): Res {
    const st = this.d.settings();
    const cl = this.d.clients().find(c => c.pastel_code);
    if (!cl) return bad(409, 'match your customers to Pastel first (step 1)');
    if (!st.codes.labour?.code) return bad(409, 'say where labour goes in Pastel first');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
    const doc: P.PastelDoc = { kind: 'invoice', number: 'TEST', customerCode: cl.pastel_code, date: today, dueDate: today, orderNumber: 'PRACTICE', message: 'Practice from Real Sandbox: delete this invoice',
      deliverTo: [cl.name], contact: null, lines: [{ kind: 'labour', description: 'Practice line: delete this invoice', qty: 1, unitPriceCents: 100 }] };
    const problems = P.missingForPastel(doc, st);
    if (problems.length) return bad(409, ...problems);
    return good({ filename: 'pastel-practice-invoice.csv', file: P.pastelFile([doc], st, this.d.vatPct()), where: P.PASTEL_WHERE.invoice, customer: cl.pastel_code, number: 'TEST', real: false });
  }

  done(b: { worked?: boolean; note?: string }): Res {
    this.s.doneAt = b.worked ? new Date().toISOString() : null;
    this.s.note = b.worked ? null : (b.note ?? 'did not work');
    return good(this.setup());
  }
}
