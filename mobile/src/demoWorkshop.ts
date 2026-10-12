// The demo's pretend workshop stock for the mechanic, following the same rules as the server
// (core/workshop.ts). Items and the stockroom come from the demo stockroom, so what Lindiwe issues
// leaves her stockroom and lands in Bongani's workshop.
import * as W from '../../server/src/core/workshop.ts';
import type { DemoStockState } from './demoStock.ts';

export interface DemoWorkshopState {
  qty: Record<string, number>;
  kept: Record<string, { min: number; dailyUse: 'oil' | 'water' | null }>;
  measured: Record<string, boolean>;
  moves: WorkshopMove[];
  counts: { itemId: string; at: string; result: W.CountResult; expected: number; counted: number; by: string }[];
}
export interface WorkshopMove {
  id: string; created_at: string; kind: 'assign' | 'return' | 'use_on_fleet' | 'workshop_loss' | 'stocktake_adjustment'; qty: number; to_workshop: boolean;
  itemId: string; description?: string; unit?: string; note: string | null; by: string; registration: string | null; job_number: number | null;
}

const MECH = 'Bongani Khumalo';
const CTL = 'Lindiwe Zulu';
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/** Adds the workshop's items to the demo stockroom (once) and seeds the workshop. */
export function seedWorkshop(stock: DemoStockState): DemoWorkshopState {
  const add = (id: string, code: string, description: string, unit: string, room: number) => {
    if (!stock.items.some(i => i.id === id)) { stock.items.push({ id, code, description, unit }); stock.stockroom[id] = room; }
  };
  add('st-oil', 'OIL-1540', 'Engine oil 15W-40', 'L', 120);
  add('st-cool', 'COOL-50', 'Coolant 50/50 premix', 'L', 40);
  add('st-of', 'OF-HILUX', 'Oil filter Hilux GD-6', 'each', 6);
  add('st-pads', 'BP-HILUX', 'Brake pads front Hilux (set)', 'set', 3);
  const m = (h: number, kind: WorkshopMove['kind'], itemId: string, qty: number, to: boolean, note: string | null, by: string, registration: string | null = null): WorkshopMove =>
    ({ id: `wm-${itemId}-${h}`, created_at: ago(h), kind, qty, to_workshop: to, itemId, note, by, registration, job_number: null });
  return {
    qty: { 'st-oil': 17.5, 'st-cool': 9, 'st-of': 3, 'st-pads': 1 },
    kept: { 'st-oil': { min: 20, dailyUse: 'oil' }, 'st-cool': { min: 10, dailyUse: 'water' }, 'st-of': { min: 2, dailyUse: null }, 'st-pads': { min: 1, dailyUse: null } },
    measured: { 'st-oil': true, 'st-cool': true },
    moves: [
      m(2, 'use_on_fleet', 'st-oil', 0.5, false, 'Daily check ND 503-221', MECH, 'ND 503-221'),
      m(26, 'workshop_loss', 'st-oil', 0.2, false, 'Count: pouring loss within the 0.25 L allowance', MECH),
      m(50, 'use_on_fleet', 'st-oil', 0.5, false, 'Daily check ND 503-221', MECH, 'ND 503-221'),
      m(60, 'use_on_fleet', 'st-cool', 1, false, 'Daily check ND 771-330', MECH, 'ND 771-330'),
      m(70, 'workshop_loss', 'st-oil', 0.3, false, 'Noted by the mechanic: spilt while pouring', MECH),
      m(140, 'assign', 'st-oil', 20, true, null, CTL), m(140, 'assign', 'st-cool', 10, true, null, CTL),
      m(140, 'assign', 'st-of', 3, true, null, CTL), m(140, 'assign', 'st-pads', 1, true, null, CTL),
    ],
    counts: [{ itemId: 'st-oil', at: ago(26), result: 'within_allowance', expected: 18.2, counted: 18, by: MECH }],
  };
}

type Res = { ok: true; body: unknown; status?: number } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown, status = 200): Res => ({ ok: true, body, status });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });

export class DemoWorkshop {
  constructor(public w: DemoWorkshopState, private stock: DemoStockState) {}

  private item(id: string) { return this.stock.items.find(i => i.id === id); }
  private have(id: string) { return Math.round((this.w.qty[id] ?? 0) * 100) / 100; }
  private move(kind: WorkshopMove['kind'], itemId: string, qty: number, to: boolean, note: string | null, by: string, registration: string | null = null, job: number | null = null) {
    this.w.qty[itemId] = W.round2((this.w.qty[itemId] ?? 0) + (to ? qty : -qty));
    this.w.moves.unshift({ id: `wm-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, created_at: new Date().toISOString(), kind, qty, to_workshop: to, itemId, note, by, registration, job_number: job });
  }
  private usedSince(itemId: string) {
    const last = this.w.counts.filter(c => c.itemId === itemId).map(c => c.at).sort().at(-1) ?? '';
    return W.round2(this.w.moves.filter(m => m.itemId === itemId && m.kind === 'use_on_fleet' && m.created_at > last).reduce((n, m) => n + m.qty, 0));
  }

  list() {
    const since = ago(24 * 30);
    const ids = [...new Set([...Object.keys(this.w.kept), ...Object.keys(this.w.qty).filter(k => this.have(k) !== 0)])];
    const lines = ids.map(id => {
      const it = this.item(id)!;
      const k = this.w.kept[id];
      const qty = this.have(id);
      const sum = (kind: string) => W.round2(this.w.moves.filter(m => m.itemId === id && m.kind === kind && !m.to_workshop && m.created_at > since).reduce((n, m) => n + m.qty, 0));
      const lc = this.w.counts.filter(c => c.itemId === id).sort((a, b) => b.at.localeCompare(a.at))[0];
      return {
        id, code: it.code, description: it.description, unit: it.unit, measured: !!this.w.measured[id], qty, min_qty: k?.min ?? 0, daily_check_use: k?.dailyUse ?? null, kept: !!k,
        used_30d: sum('use_on_fleet'), lost_30d: sum('workshop_loss'), last_count: lc ? { at: lc.at, result: lc.result, expected: lc.expected, counted: lc.counted, by: lc.by } : null,
        in_stockroom: this.stock.stockroom[id] ?? 0, belowMin: W.belowMin({ qty, min_qty: k?.min ?? 0 }), usedSince: this.usedSince(id),
      };
    }).sort((a, b) => Number(b.belowMin) - Number(a.belowMin) || a.description.localeCompare(b.description));
    return { lines, belowMin: lines.filter(l => l.belowMin).length, lossPct: W.LOSS_PCT, lossMin: W.LOSS_MIN };
  }

  movements(itemId?: string | null) {
    return this.w.moves.filter(m => !itemId || m.itemId === itemId).slice(0, 300).map(m => {
      const it = this.item(m.itemId);
      return { ...m, description: it?.description ?? '', unit: it?.unit ?? '' };
    });
  }

  setItem(id: string, b: { minQty: number; dailyCheckUse?: 'oil' | 'water' | null; measured?: boolean }): Res {
    const it = this.item(id);
    if (!it) return bad(404, 'no such stock item');
    if (!(b.minQty >= 0)) return bad(400, 'minimum must be 0 or more');
    if (b.dailyCheckUse) for (const k of Object.values(this.w.kept)) if (k.dailyUse === b.dailyCheckUse) k.dailyUse = null;
    this.w.kept[id] = { min: b.minQty, dailyUse: b.dailyCheckUse ?? null };
    if (b.measured !== undefined) this.w.measured[id] = b.measured;
    return good({ itemId: id, description: it.description, minQty: b.minQty, dailyCheckUse: b.dailyCheckUse ?? null });
  }

  issue(b: { lines: { itemId: string; qty: number }[]; note?: string }): Res {
    if (!b.lines?.length) return bad(400, 'what to issue');
    const short = b.lines.map(l => { const it = this.item(l.itemId); const room = this.stock.stockroom[l.itemId] ?? 0; return it && room < l.qty ? `${it.description}: only ${room} ${it.unit} in the stockroom` : null; }).filter(Boolean) as string[];
    if (short.length) return bad(409, ...short);
    const done: string[] = [];
    for (const l of b.lines) {
      const it = this.item(l.itemId)!;
      this.stock.stockroom[l.itemId] = (this.stock.stockroom[l.itemId] ?? 0) - l.qty;
      this.move('assign', l.itemId, l.qty, true, b.note ?? null, CTL);
      done.push(`${l.qty} ${it.unit} ${it.description}`);
    }
    return good({ issued: done });
  }

  sendBack(b: { itemId: string; qty: number; note: string }): Res {
    const it = this.item(b.itemId);
    if (!it) return bad(404, 'no such stock item');
    if (!b.note || b.note.trim().length < 5) return bad(400, 'say why it goes back');
    if (this.have(b.itemId) < b.qty) return bad(409, `only ${this.have(b.itemId)} ${it.unit} in the workshop`);
    this.move('return', b.itemId, b.qty, false, b.note.trim(), CTL);
    this.stock.stockroom[b.itemId] = (this.stock.stockroom[b.itemId] ?? 0) + b.qty;
    return good({ returned: b.qty });
  }

  loss(b: { itemId: string; qty: number; reason: string }): Res {
    const it = this.item(b.itemId);
    if (!it) return bad(404, 'no such stock item');
    if (!(b.qty > 0)) return bad(400, 'how much was lost');
    if (!b.reason || b.reason.trim().length < 5) return bad(400, 'say what happened (e.g. spilt while pouring)');
    if (this.have(b.itemId) < b.qty) return bad(409, `only ${this.have(b.itemId)} ${it.unit} in the workshop: count it instead`);
    this.move('workshop_loss', b.itemId, b.qty, false, `Noted by the mechanic: ${b.reason.trim()}`, MECH);
    return good({ left: this.have(b.itemId) }, 201);
  }

  count(b: { itemId: string; counted: number; note?: string | null }, by: string): Res {
    const it = this.item(b.itemId);
    if (!it) return bad(404, 'no such stock item');
    const expected = this.have(b.itemId);
    const used = this.usedSince(b.itemId);
    const r = W.countResult(expected, b.counted, used, !!this.w.measured[b.itemId]);
    const missing = W.missingOnCount(b.counted, b.note, r);
    if (missing.length) return bad(409, ...missing);
    if (r.loss > 0) this.move('workshop_loss', b.itemId, r.loss, false, r.result === 'within_allowance' ? `Count: pouring loss within the ${r.allowance} ${it.unit} allowance` : `Count: short, ${b.note!.trim()}`, by);
    if (r.loss < 0) this.move('stocktake_adjustment', b.itemId, -r.loss, true, `Count: more than expected, ${b.note!.trim()}`, by);
    this.w.counts.push({ itemId: b.itemId, at: new Date().toISOString(), result: r.result, expected, counted: b.counted, by });
    return good({ expected, counted: b.counted, usedSince: used, ...r, text: W.countText(r, it.unit), flagged: r.result === 'short' }, 201);
  }

  /** Oil or coolant poured on a daily check. */
  pourForCheck(use: 'oil' | 'water', litres: number, registration: string) {
    const id = Object.entries(this.w.kept).find(([, k]) => k.dailyUse === use)?.[0];
    if (!id) return null;
    const short = this.have(id) < litres;
    this.move('use_on_fleet', id, litres, false, `Daily check ${registration}`, MECH, registration);
    return short ? `The workshop shows less ${this.item(id)!.description} than you poured: count (dip) it.` : null;
  }

  /** A part from the workshop on a mechanic job card. */
  useOnJob(itemId: string, qty: number, registration: string, jobNumber: number): Res | null {
    const it = this.item(itemId);
    if (!it) return bad(404, 'no such stock item');
    if (!this.w.measured[itemId] && this.have(itemId) < qty) return bad(409, `only ${this.have(itemId)} ${it.unit} of ${it.description} in the workshop`);
    this.move('use_on_fleet', itemId, qty, false, `Job card ${jobNumber}`, MECH, registration, jobNumber);
    return null;
  }
}
