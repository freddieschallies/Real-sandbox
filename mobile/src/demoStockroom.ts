// The test drive's stock takes and ordering from suppliers, following the server's rules
// (server/src/routes/stockTake.ts and stockOrders.ts, core/stockroom.ts).
import * as R from '../../server/src/core/stockroom.ts';
import type { DemoStockState } from './demoStock.ts';

type Res = { ok: true; body: unknown; status?: number } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown, status = 200): Res => ({ ok: true, body, status });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const CAT: Record<string, string> = { stock: 'Stock (parts)', tool: 'Tools', ppe: 'PPE' };

export interface Bought { supplier: string; at: string; unitPriceCents: number | null; ref: string | null; how: 'delivery' | 'invoice'; lastPriceCents: number | null }
interface Take { id: string; category: string | null; started_at: string; started_by: string; signed_off_at: string | null; signed_off_by: string | null; signoff_note: string | null; cancelled_at: string | null;
  lines: Record<string, { expected: number; counted: number; by: string; at: string; note: string | null }> }
interface Order { id: string; po_number: number; status: 'approved' | 'collected' | 'cancelled'; supplier_name: string; note: string | null; requested_at: string; sent_at: string | null; sent_to: string[] | null; sent_how: string | null;
  collected_at: string | null; made_by: string; delivery_ref: string | null; lines: { lineNo: number; stockItemId: string; code: string; unit: string; description: string; qty: number; supplierCode: string | null; unitPriceCents: number | null }[] }
export interface DemoStockroomState { takes: Take[]; orders: Order[]; contacts: Record<string, { email: string | null; phone: string | null; contact: string | null }>; bought: Record<string, Bought>; nextPo: number; seeded?: boolean }

export function seedStockroom(): DemoStockroomState {
  return { takes: [], orders: [], contacts: { 'Voltex Richards Bay': { email: 'orders@voltex.example', phone: null, contact: 'Sales desk' } }, bought: {}, nextPo: 1201 };
}

export class DemoStockroom {
  constructor(public r: DemoStockroomState, private st: DemoStockState, private me: string, private company: { name: string; address?: string | null; phone?: string | null; email?: string | null; vatNo?: string | null }) {
    if (!r.seeded) {
      // What each item was last bought, from its usual supplier, at about its cost.
      let d = 6;
      for (const i of st.items) {
        if (!i.supplierName || (i.category ?? 'stock') !== 'stock') continue;
        const price = i.costCents ?? (i.sellingPriceCents != null ? Math.round(i.sellingPriceCents * 0.62) : null);
        r.bought[i.id] = { supplier: i.supplierName, at: ago(d), unitPriceCents: price, ref: `INV ${40000 + d * 37}`, how: 'invoice', lastPriceCents: price };
        d += 5;
      }
      // An earlier stock take, signed off.
      const lines: Take['lines'] = {};
      for (const i of st.items.filter(x => (x.category ?? 'stock') === 'stock')) lines[i.id] = { expected: (st.stockroom[i.id] ?? 0) + (i.id === 'st-4' ? 2 : 0), counted: st.stockroom[i.id] ?? 0, by: me, at: ago(33), note: null };
      r.takes.push({ id: 'take-1', category: 'stock', started_at: ago(33), started_by: me, signed_off_at: ago(33), signed_off_by: me, signoff_note: 'Two fuses used on a callout and not booked out', cancelled_at: null, lines });
      r.seeded = true;
    }
  }
  private item(id: string) { return this.st.items.find(i => i.id === id); }
  lastBought(id: string): Bought | null { return this.r.bought[id] ?? null; }

  // ---- Stock take ----------------------------------------------------------------------------------
  private label(t: Take) { return t.category ? CAT[t.category] : 'Everything'; }
  private lines(t: Take) {
    const open = !t.signed_off_at && !t.cancelled_at;
    return this.st.items.filter(i => t.lines[i.id] || (open && !i.needsReview && (!t.category || (i.category ?? 'stock') === t.category))).map(i => {
      const l = t.lines[i.id];
      return { id: i.id, code: i.code, description: i.description, unit: i.unit, category: i.category ?? 'stock', photoId: i.photoId ?? null, costCents: i.costCents ?? this.r.bought[i.id]?.lastPriceCents ?? null,
        counted: l ? l.counted : null, expected: l ? l.expected : null, live: this.st.stockroom[i.id] ?? 0, note: l?.note ?? null, countedBy: l?.by ?? null, diff: l ? Math.round((l.counted - l.expected) * 100) / 100 : null };
    });
  }
  private summary(t: Take) { return R.takeSummary(this.lines(t).map(i => ({ expected: i.expected ?? i.live, counted: i.counted, costCents: i.costCents }))); }
  takes() {
    const row = (t: Take) => { const s = this.summary(t); return { id: t.id, label: this.label(t), category: t.category, started_at: t.started_at, started_by: t.started_by, signed_off_at: t.signed_off_at, signed_off_by: t.signed_off_by,
      cancelled_at: t.cancelled_at, counted: s.counted, differences: s.differences, net_cents: t.signed_off_at ? s.gainCents - s.lossCents : 0 }; };
    const list = [...this.r.takes].sort((a, b) => b.started_at.localeCompare(a.started_at)).map(row);
    return { open: list.find(x => !x.signed_off_at && !x.cancelled_at) ?? null, past: list.filter(x => x.signed_off_at || x.cancelled_at) };
  }
  start(b: { category?: string | null }): Res {
    if (this.r.takes.some(t => !t.signed_off_at && !t.cancelled_at)) return bad(409, 'a stock take is already open: finish or cancel it first');
    const t: Take = { id: `take-${Date.now().toString(36)}`, category: b.category ?? null, started_at: new Date().toISOString(), started_by: this.me, signed_off_at: null, signed_off_by: null, signoff_note: null, cancelled_at: null, lines: {} };
    this.r.takes.push(t);
    return good({ id: t.id }, 201);
  }
  take(id: string): Res {
    const t = this.r.takes.find(x => x.id === id);
    if (!t) return bad(404, 'no such stock take');
    return good({ take: { id: t.id, label: this.label(t), category: t.category, started_at: t.started_at, started_by: t.started_by, signed_off_at: t.signed_off_at, signed_off_by: t.signed_off_by, signoff_note: t.signoff_note, cancelled_at: t.cancelled_at },
      items: this.lines(t), summary: this.summary(t) });
  }
  count(id: string, b: { stockItemId?: string; counted?: number; note?: string }): Res {
    const t = this.r.takes.find(x => x.id === id);
    if (!t) return bad(404, 'no such stock take');
    if (t.signed_off_at || t.cancelled_at) return bad(409, 'this stock take is finished');
    const it = this.item(b.stockItemId ?? '');
    if (!it) return bad(404, 'no such item');
    if (!(Number(b.counted) >= 0)) return bad(400, 'how many are on the shelf');
    if (t.category && (it.category ?? 'stock') !== t.category) return bad(400, `this stock take is for ${CAT[t.category]} only`);
    const live = this.st.stockroom[it.id] ?? 0;
    t.lines[it.id] = { expected: live, counted: Number(b.counted), by: this.me, at: new Date().toISOString(), note: b.note?.trim() || null };
    return good({ stockItemId: it.id, counted: Number(b.counted), expected: live, diff: Number(b.counted) - live });
  }
  signOff(id: string, b: { note?: string; partial?: boolean }, record: (stockItemId: string, qty: number, note: string) => void): Res {
    const t = this.r.takes.find(x => x.id === id);
    if (!t) return bad(404, 'no such stock take');
    if (t.signed_off_at || t.cancelled_at) return bad(409, 'this stock take is finished');
    const s = this.summary(t);
    if (!s.counted) return bad(409, 'nothing has been counted yet');
    if (s.left && !b.partial) return bad(409, `${s.left} item${s.left === 1 ? '' : 's'} not counted yet: count them, or sign off only what was counted`);
    if (s.differences && (!b.note || b.note.trim().length < 5)) return bad(400, 'say why the counts differ (e.g. used on jobs and not booked, damaged, miscounted before)');
    for (const [itemId, l] of Object.entries(t.lines)) {
      const d = l.counted - l.expected;
      if (!d) continue;
      this.st.stockroom[itemId] = Math.max(0, (this.st.stockroom[itemId] ?? 0) + d);
      record(itemId, d, `Stock take: counted ${l.counted}, expected ${l.expected}`);
    }
    Object.assign(t, { signed_off_at: new Date().toISOString(), signed_off_by: this.me, signoff_note: b.note?.trim() || null });
    return good({ id, ...s });
  }
  cancelTake(id: string): Res {
    const t = this.r.takes.find(x => x.id === id);
    if (!t || t.signed_off_at || t.cancelled_at) return bad(409, 'this stock take is finished');
    t.cancelled_at = new Date().toISOString();
    return good({ id, cancelled: true });
  }

  // ---- Ordering ------------------------------------------------------------------------------------
  private view(o: Order) {
    const c = this.r.contacts[o.supplier_name] ?? { email: null, phone: null, contact: null };
    return { ...o, supplier_id: o.supplier_name, decided_by: o.made_by, sent_by: o.sent_at ? this.me : null, supplier_email: c.email, supplier_phone: c.phone, supplier_contact: c.contact };
  }
  orders() { return { orders: [...this.r.orders].filter(o => o.status !== 'cancelled').sort((a, b) => b.requested_at.localeCompare(a.requested_at)).map(o => this.view(o)), canEmail: true }; }
  makeOrder(b: { supplierName?: string; note?: string; lines?: { stockItemId: string; qty: number }[] }): Res {
    const sup = (b.supplierName ?? '').trim();
    if (sup.length < 2) return bad(400, 'the supplier');
    if (!b.lines?.length) return bad(400, 'at least one item');
    const n = this.r.nextPo++;
    const o: Order = { id: `spo-${n}`, po_number: n, status: 'approved', supplier_name: sup, note: b.note?.trim() || null, requested_at: new Date().toISOString(), sent_at: null, sent_to: null, sent_how: null, collected_at: null,
      made_by: this.me, delivery_ref: null, lines: [] };
    let no = 1;
    for (const l of b.lines) {
      const it = this.item(l.stockItemId);
      if (!it || !(l.qty > 0)) return bad(400, 'an item or its quantity');
      const lb = this.r.bought[it.id];
      o.lines.push({ lineNo: no++, stockItemId: it.id, code: it.code, unit: it.unit, description: it.description, qty: l.qty, supplierCode: it.supplierCode ?? null,
        unitPriceCents: lb && lb.supplier.toLowerCase() === sup.toLowerCase() ? lb.lastPriceCents ?? it.costCents ?? null : it.costCents ?? null });
      it.ordered = { at: new Date().toISOString(), qty: l.qty, note: `PO ${n}, ${sup}`, by: this.me };
    }
    this.r.orders.push(o);
    if (!this.r.contacts[sup]) this.r.contacts[sup] = { email: null, phone: null, contact: null };
    return good({ id: o.id, poNumber: n }, 201);
  }
  doc(o: Order): R.PoDoc {
    const c = this.r.contacts[o.supplier_name];
    return { number: o.po_number, date: new Date(o.requested_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }), supplier: o.supplier_name, contact: c?.contact ?? null, note: o.note,
      by: o.made_by, company: this.company, lines: o.lines.map(l => ({ code: l.code, supplierCode: l.supplierCode, description: l.description, qty: l.qty, unit: l.unit, unitPriceCents: l.unitPriceCents })) };
  }
  order(id: string): Res {
    const o = this.r.orders.find(x => x.id === id);
    if (!o) return bad(404, 'no such purchase order');
    const doc = this.doc(o);
    return good({ order: this.view(o), doc, text: R.poText(doc), canEmail: true });
  }
  sent(id: string, how: string, to: string[] | null): Res {
    const o = this.r.orders.find(x => x.id === id);
    if (!o) return bad(404, 'no such purchase order');
    if (o.status === 'cancelled') return bad(409, 'this purchase order is cancelled');
    if (how === 'email' && !(to ?? []).every(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) return bad(400, 'a valid email address');
    Object.assign(o, { sent_at: new Date().toISOString(), sent_to: to, sent_how: how });
    if (how === 'email' && to?.[0]) { const c = (this.r.contacts[o.supplier_name] ??= { email: null, phone: null, contact: null }); c.email = c.email || to[0]; }
    return good({ id, sent: true, how, to });
  }
  cancelOrder(id: string, note: string): Res {
    const o = this.r.orders.find(x => x.id === id);
    if (!o) return bad(404, 'no such purchase order');
    if (o.status === 'collected') return bad(409, 'it was already received');
    if (!note || note.trim().length < 3) return bad(400, 'why it is cancelled');
    o.status = 'cancelled';
    for (const l of o.lines) { const it = this.item(l.stockItemId); if (it?.ordered?.note?.startsWith(`PO ${o.po_number},`)) it.ordered = null; }
    return good({ id, cancelled: true });
  }
  /** A delivery came in: the last supplier, and the PO it was against is received. */
  received(b: { supplierName: string; reference: string; lines: { stockItemId: string; qty: number }[]; purchaseOrderId?: string }): Res | null {
    if (b.purchaseOrderId) {
      const o = this.r.orders.find(x => x.id === b.purchaseOrderId);
      if (!o) return bad(404, 'no such purchase order');
      if (o.status !== 'approved') return bad(409, `that purchase order is ${o.status === 'collected' ? 'already received' : o.status}`);
    }
    for (const l of b.lines) {
      const prev = this.r.bought[l.stockItemId];
      this.r.bought[l.stockItemId] = { supplier: b.supplierName, at: new Date().toISOString(), unitPriceCents: null, ref: b.reference, how: 'delivery', lastPriceCents: prev?.lastPriceCents ?? null };
    }
    if (b.purchaseOrderId) { const o = this.r.orders.find(x => x.id === b.purchaseOrderId)!; Object.assign(o, { status: 'collected', collected_at: new Date().toISOString(), delivery_ref: b.reference }); }
    return null;
  }
  suppliers() {
    const names = new Set<string>([...Object.keys(this.r.contacts), ...this.st.items.map(i => i.supplierName).filter((x): x is string => !!x), ...Object.values(this.r.bought).map(b => b.supplier)]);
    return [...names].sort((a, b) => a.localeCompare(b)).map(n => {
      const c = this.r.contacts[n] ?? { email: null, phone: null, contact: null };
      const last = this.r.orders.filter(o => o.supplier_name === n).map(o => o.requested_at).sort().at(-1) ?? null;
      return { id: n, name: n, email: c.email, phone: c.phone, contact_name: c.contact, pastel_code: null, last_order: last, usual_items: this.st.items.filter(i => i.supplierName === n).length };
    });
  }
  setSupplier(name: string, b: { email?: string; phone?: string; contactName?: string }): Res {
    if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) return bad(400, 'a valid email');
    this.r.contacts[name] = { email: b.email || null, phone: b.phone || null, contact: b.contactName || null };
    return good({ id: name });
  }
}
