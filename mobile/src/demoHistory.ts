// The test drive's History: every change made in the test drive (who, when, what was sent), shown the
// way the server's history is (routes/history.ts). On the server it is the database itself that keeps
// it and refuses to change or delete it; here it stays in this browser.
type Res = { status: number; body: unknown };
export interface DemoEntry { id: number; at: string; who: string; whoId: string; what: string; kind: string; op: 'add' | 'change' | 'delete'; name: string; changes: { field: string; from: string; to: string }[] }
export interface DemoHistoryState { seq: number; entries: DemoEntry[]; since: string }
export const seedHistory = (): DemoHistoryState => ({ seq: 0, entries: [], since: new Date().toISOString() });

const KIND: [RegExp, string, string][] = [
  [/^\/jobs\/[^/]+\/stock-out/, 'stock_issues', 'Stock issue'], [/^\/jobs/, 'jobs', 'Job card'], [/^\/office\/jobs/, 'jobs', 'Job card'], [/^\/breakdowns/, 'breakdowns', 'Breakdown'],
  [/^\/invoices|^\/documents\/invoices/, 'invoices', 'Invoice'], [/^\/quotes|^\/documents\/quotes/, 'quotes', 'Quote'], [/^\/credit-notes/, 'credit_notes', 'Credit note'],
  [/^\/purchase-orders/, 'purchase_orders', 'Purchase order'], [/^\/price-list/, 'stock_items', 'Stock item'], [/^\/stock/, 'stock_movements', 'Stock'],
  [/^\/people|^\/access/, 'users', 'Person'], [/^\/timesheets|^\/me\/timesheets/, 'timesheets', 'Timesheet'], [/^\/fleet|^\/vehicles|^\/me\/vehicle/, 'vehicles', 'Vehicle'],
  [/^\/clients|^\/office\/clients|^\/customers/, 'clients', 'Customer'], [/^\/stores|^\/office\/stores/, 'stores', 'Store'], [/^\/support/, 'support_grants', 'Support access'],
  [/^\/pastel/, 'pastel_settings', 'Pastel'], [/^\/whatsapp/, 'whatsapp', 'WhatsApp'], [/^\/supplier-invoices|^\/me\/supplier-invoices/, 'supplier_invoices', 'Supplier invoice'],
  [/^\/flags|^\/me\/flags/, 'flags', 'Flag'], [/^\/queries/, 'queries', 'Query'], [/^\/fuel|^\/me\/fuel/, 'fuel_logs', 'Fuel'], [/^\/tools|^\/tool-store/, 'tools', 'Tool'],
  [/^\/photos/, 'photos', 'Photo'], [/^\/setup/, 'company_setup', 'Start-up'], [/^\/company|^\/documents\/company/, 'company_profile', 'Company details'],
];
const SKIP = /^\/(auth|policy|platform|history|search|me\/today|me\/phone-menu)/;
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120));
const field = (k: string) => k.replace(/Cents$/, '').replace(/Id$/, '').replace(/([A-Z])/g, ' $1').toLowerCase().replace(/_/g, ' ');

export class DemoHistory {
  constructor(public s: DemoHistoryState) {}

  /** A change that was made (anything but reading). */
  remember(req: { method: string; path: string; json?: unknown; upload?: unknown }, res: Res, who: { id: string; name: string }) {
    if (req.method === 'GET' || res.status >= 300) return;
    const p = req.path.split('?')[0];
    if (SKIP.test(p)) return;
    const k = KIND.find(([re]) => re.test(p));
    const body = (res.body ?? {}) as Record<string, unknown>;
    const json = (req.json ?? {}) as Record<string, unknown>;
    const pick = (o: Record<string, unknown>, ...ks: string[]) => { for (const x of ks) if (o[x] != null && o[x] !== '') return String(o[x]); return null; };
    const num = pick(body, 'job_number', 'invoice_number', 'quote_number', 'po_number', 'number');
    const named = pick(body, 'description');
    const name = named ?? (num ? `${k?.[2]?.toLowerCase() ?? ''} ${num}`.trim() : pick(json, 'description', 'name', 'fullName', 'full_name', 'supplierName', 'reason') ?? pick(body, 'name', 'full_name', 'description') ?? p.split('/').filter(Boolean).slice(-1)[0]);
    const changes = Object.entries(json).filter(([key, v]) => !/^(id|photoId|at|idemKey)$/.test(key) && v !== null && v !== undefined && typeof v !== 'object').slice(0, 8)
      .map(([key, v]) => ({ field: field(key), from: '', to: show(v) }));
    if (!changes.length) changes.push({ field: 'what was done', from: '', to: p.split('/').filter(x => x && !/^[0-9a-f-]{8,}$/i.test(x)).slice(-1)[0]?.replace(/-/g, ' ') ?? req.method.toLowerCase() });
    const op = req.method === 'DELETE' || /\/(cancel|remove|delete|end|stop)$/.test(p) ? 'delete' : req.method === 'POST' && !/\/[a-z-]+$/.test(p.replace(/^\/[a-z-]+/, '')) ? 'add' : req.method === 'POST' ? 'add' : 'change';
    this.s.entries.unshift({ id: ++this.s.seq, at: new Date().toISOString(), who: who.name, whoId: who.id, what: k?.[2] ?? 'Record', kind: k?.[1] ?? 'other', op, name: name ?? '', changes });
    this.s.entries.splice(3000);
  }

  route(path: string): Res {
    const [p, qs] = path.split('?');
    const ok = (body: unknown): Res => ({ status: 200, body });
    if (p === '/history/check') return ok({ ok: true, checked: this.s.entries.length, problem: null, badId: null, badAt: null, sealedAt: new Date().toISOString() });
    const OP = { add: 'Added', change: 'Changed', delete: 'Deleted' } as const;
    const out = (e: DemoEntry) => ({ ...e, id: String(e.id), opLabel: OP[e.op] });
    const m = p.match(/^\/history\/(\d+)$/);
    if (m) {
      const e = this.s.entries.find(x => x.id === Number(m[1]));
      if (!e) return { status: 404, body: { error: 'no such entry', reasons: ['no such entry'] } };
      return ok({ ...out(e), fields: e.changes.map(c => ({ field: c.field, before: c.from, after: c.to, changed: true })), fingerprint: `test-drive-${e.id}`.padEnd(16, '0'),
        record: this.s.entries.filter(x => x.kind === e.kind && x.name === e.name).slice().reverse().map(out) });
    }
    const q = new URLSearchParams(qs ?? '');
    const text = (q.get('q') ?? '').toLowerCase();
    const days = Number(q.get('days') ?? 0);
    const before = Number(q.get('before') ?? 0);
    const list = this.s.entries.filter(e => (!text || JSON.stringify(e).toLowerCase().includes(text)) && (!q.get('who') || e.whoId === q.get('who')) && (!q.get('what') || e.kind === q.get('what'))
      && (!q.get('op') || e.op === q.get('op')) && (!days || Date.parse(e.at) > Date.now() - days * 86_400_000) && (!before || e.id < before));
    const people = new Map<string, { id: string; name: string; n: number }>();
    const kinds = new Map<string, { key: string; label: string; n: number }>();
    for (const e of this.s.entries) {
      const pp = people.get(e.whoId) ?? { id: e.whoId, name: e.who, n: 0 }; pp.n++; people.set(e.whoId, pp);
      const kk = kinds.get(e.kind) ?? { key: e.kind, label: e.what, n: 0 }; kk.n++; kinds.set(e.kind, kk);
    }
    const page = list.slice(0, 100);
    return ok({ entries: page.map(out), people: [...people.values()], kinds: [...kinds.values()].sort((a, b) => b.n - a.n), since: this.s.since, total: this.s.entries.length,
      more: list.length > 100 ? page[page.length - 1].id : null });
  }
}
