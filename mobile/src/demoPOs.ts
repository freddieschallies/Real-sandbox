// The demo's purchase orders for stock runs, following the same rules as the server
// (routes/purchaseOrders.ts): asked for by the technician, approved by the stock controller, admin,
// a department manager or the CEO, then collected when the slip is scanned against it.
type Res = { ok: true; status: number; body: unknown } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown, status = 200): Res => ({ ok: true, status, body });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });

export interface DemoPO {
  id: string; po_number: number; status: 'requested' | 'approved' | 'rejected' | 'collected' | 'cancelled';
  supplier_id: string | null; supplier_name: string; job_id: string | null; job_number: number | null; store: string | null; note: string | null;
  technician_id: string; technician: string; requested_at: string; decided_at: string | null; decided_by: string | null; decision_note: string | null;
  collected_at: string | null; pastel_sent_at: null; pastel_ref: null;
  lines: { lineNo: number; description: string; qty: number; code: string | null; stockItemId: string | null }[];
  invoice: { id: string; invoiceNumber: string; totalCents: number | null; status: string } | null;
}
export interface DemoPOState { list: DemoPO[]; next: number }

const APPROVERS = ['stockroom', 'admin', 'management', 'director', 'creator'];

export class DemoPOs {
  constructor(private s: DemoPOState, private who: { id: string; name: string; level: string }) {}

  ask(b: { supplierName?: string; supplierId?: string; jobId?: string | null; note?: string; lines: { stockItemId?: string | null; description: string; qty: number }[] },
    job: { id: string; job_number: number; store: string } | null, code: (id: string) => string | null): Res {
    const name = (b.supplierName ?? b.supplierId ?? '').trim();
    if (name.length < 2) return bad(400, 'which supplier');
    if (!b.lines?.length) return bad(400, 'at least one part');
    if (b.lines.some(l => !l.description || l.description.trim().length < 2 || !(l.qty > 0))) return bad(400, 'what each part is and how many');
    const po: DemoPO = {
      id: `po-${Date.now()}`, po_number: this.s.next++, status: 'requested', supplier_id: null, supplier_name: name, job_id: job?.id ?? null, job_number: job?.job_number ?? null, store: job?.store ?? null,
      note: b.note?.trim() || null, technician_id: this.who.id, technician: this.who.name, requested_at: new Date().toISOString(), decided_at: null, decided_by: null, decision_note: null,
      collected_at: null, pastel_sent_at: null, pastel_ref: null, invoice: null,
      lines: b.lines.map((l, i) => ({ lineNo: i + 1, description: l.description.trim(), qty: l.qty, stockItemId: l.stockItemId ?? null, code: l.stockItemId ? code(l.stockItemId) : null })),
    };
    this.s.list.unshift(po);
    return good({ id: po.id, poNumber: po.po_number, status: 'requested' }, 201);
  }
  mine() { return this.s.list.filter(p => p.technician_id === this.who.id); }
  cancel(id: string): Res {
    const p = this.s.list.find(x => x.id === id && x.technician_id === this.who.id);
    if (!p) return bad(404, 'no such PO of yours');
    if (!['requested', 'approved'].includes(p.status)) return bad(409, `this PO is ${p.status}`);
    p.status = 'cancelled';
    return good({ id, status: 'cancelled' });
  }
  private mayDecide(p: DemoPO) { return p.technician_id !== this.who.id && APPROVERS.includes(this.who.level); }
  list(view: string) {
    const rows = this.s.list.filter(p => view === 'all' || p.status === (view === 'approved' ? 'approved' : view === 'collected' ? 'collected' : 'requested'));
    const counts: Record<string, number> = {};
    for (const p of this.s.list) counts[p.status] = (counts[p.status] ?? 0) + 1;
    return { view, counts, orders: rows.map(p => ({ ...p, canDecide: p.status === 'requested' && this.mayDecide(p) })) };
  }
  decide(id: string, approve: boolean, note?: string): Res {
    const p = this.s.list.find(x => x.id === id);
    if (!p) return bad(404, 'no such PO');
    if (!this.mayDecide(p)) return bad(403, p.technician_id === this.who.id ? 'someone else approves your own PO' : 'POs are approved by the stock controller, admin, the department manager or the CEO');
    if (p.status !== 'requested') return bad(409, `PO ${p.po_number} is ${p.status} already`);
    if (!approve && (!note || note.trim().length < 3)) return bad(400, 'say why not (the technician is told)');
    Object.assign(p, { status: approve ? 'approved' : 'rejected', decided_at: new Date().toISOString(), decided_by: this.who.name, decision_note: note?.trim() || null });
    return good({ id, status: p.status });
  }
  /** The slip scanned against the PO: it gives the job; the PO is collected once the slip is booked. */
  forSlip(id: string): { ok: true; po: DemoPO } | { ok: false; res: Res } {
    const p = this.s.list.find(x => x.id === id && x.technician_id === this.who.id);
    if (!p) return { ok: false, res: bad(404, 'no such PO of yours') };
    if (p.status !== 'approved') return { ok: false, res: bad(409, p.status === 'requested' ? `PO ${p.po_number} is not approved yet` : `PO ${p.po_number} is ${p.status}`) };
    return { ok: true, po: p };
  }
}
