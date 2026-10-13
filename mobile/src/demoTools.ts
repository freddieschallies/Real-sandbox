// Demo tool store: the stockroom's tools and ladders with serials and barcodes. Thabo has a step
// ladder out for the urgent ice machine job; Sipho a vacuum pump; the extension ladder is late.
import type { Flag } from './types.ts';
import { mayHaveIncidents, EXAMPLE_TECH, REAL } from './demoReal.ts';

export interface DemoTool { id: string; name: string; kind: 'tool' | 'ladder' | 'equipment'; serial: string | null; barcode: string; notes: string | null; condition: 'good' | 'damaged' | 'lost'; active: boolean; photo_id?: string | null }
export interface DemoBooking { id: string; toolId: string; userId: string; userName: string; jobId: string | null; jobNumber: number | null; outAt: string; outBy: string; note: string | null;
  /** Booked out / signed back by someone standing in for the stock controller: their position. */ outByStandIn?: string | null; returnedByStandIn?: string | null;
  returnedAt?: string; returnedBy?: string; condition?: 'good' | 'damaged' | 'lost'; returnNote?: string | null }
export interface DemoToolsState { tools: DemoTool[]; bookings: DemoBooking[] }
type Res = { ok: true; body: unknown; status?: number } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown, status = 200): Res => ({ ok: true, body, status });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });
const sast = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
let n = 0;
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${(n++).toString(36)}`;

export function seedTools(): DemoToolsState {
  const h = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
  const late = REAL ? EXAMPLE_TECH : 'tech-3';
  return {
    tools: [
      { id: 'tl-1', name: 'Step ladder 2.4 m', kind: 'ladder', serial: 'LAD-2401', barcode: 'T-4KQ7MA', notes: null, condition: 'good', active: true },
      { id: 'tl-2', name: 'Step ladder 2.4 m', kind: 'ladder', serial: 'LAD-2402', barcode: 'T-9PX2RC', notes: null, condition: 'good', active: true },
      { id: 'tl-3', name: 'Step ladder 1.8 m', kind: 'ladder', serial: 'LAD-1801', barcode: 'T-7HN3VE', notes: null, condition: 'good', active: true },
      { id: 'tl-4', name: 'Extension ladder 6 m', kind: 'ladder', serial: 'LAD-6001', barcode: 'T-2WD8KJ', notes: 'Two-person lift', condition: 'good', active: true },
      { id: 'tl-5', name: 'Vacuum pump 6 CFM', kind: 'equipment', serial: 'VP-3301', barcode: 'T-5MB6TS', notes: null, condition: 'good', active: true },
      { id: 'tl-6', name: 'Refrigerant recovery unit', kind: 'equipment', serial: 'RR-1102', barcode: 'T-8CF4QY', notes: null, condition: 'good', active: true },
      { id: 'tl-7', name: 'Core drill', kind: 'tool', serial: 'HD-55021', barcode: 'T-3JR9LU', notes: 'With 52 mm and 107 mm bits', condition: 'good', active: true },
      { id: 'tl-8', name: 'Insulation tester (Megger)', kind: 'tool', serial: 'MG-7781', barcode: 'T-6YT2NB', notes: 'Calibrated March', condition: 'good', active: true },
      { id: 'tl-9', name: 'Pipe threader', kind: 'tool', serial: 'PT-0490', barcode: 'T-4GV7HP', notes: null, condition: 'damaged', active: true },
    ],
    bookings: [
      { id: 'tb-1', toolId: 'tl-1', userId: 'me', userName: 'Thabo Mkhize', jobId: 'job-10231', jobNumber: 10231, outAt: h(2), outBy: 'Lindiwe Zulu', note: null },
      { id: 'tb-2', toolId: 'tl-5', userId: 'tech-2', userName: 'Sipho Ndlovu', jobId: 'job-10220', jobNumber: 10220, outAt: h(5), outBy: 'Lindiwe Zulu', note: null },
      { id: 'tb-3', toolId: 'tl-4', userId: late, userName: 'Ayanda Mthembu', jobId: null, jobNumber: null, outAt: h(50), outBy: 'Lindiwe Zulu', note: 'For the warehouse lights, back the same day' },
      { id: 'tb-0', toolId: 'tl-9', userId: 'tech-2', userName: 'Sipho Ndlovu', jobId: null, jobNumber: null, outAt: h(240), outBy: 'Lindiwe Zulu', note: null, returnedAt: h(230), returnedBy: 'Lindiwe Zulu', condition: 'damaged', returnNote: 'Die head chipped' },
    ],
  };
}

export class DemoTools {
  constructor(public s: DemoToolsState, private flags: Flag[], private jobStatus: (jobId: string) => { status: string; closedAt: string | null } | null, private name: (id: string) => string) {}

  private due(b: DemoBooking, now = new Date()) {
    const j = b.jobId ? this.jobStatus(b.jobId) : null;
    const open = !!j && !['closed', 'cancelled'].includes(j.status);
    if (b.jobId && open) return { due: 'when the job is done', overdue: false, jobStatus: j?.status ?? null };
    const from = new Date(b.jobId ? j?.closedAt ?? b.outAt : b.outAt);
    const next = new Date(`${sast(from)}T10:00:00+02:00`); next.setUTCDate(next.getUTCDate() + 1);
    return { due: b.jobId ? 'now: the job is done' : 'today', overdue: now >= next, jobStatus: j?.status ?? null };
  }

  view(t: DemoTool) {
    const b = this.s.bookings.find(x => x.toolId === t.id && !x.returnedAt);
    return { ...t, out: b ? { bookingId: b.id, userId: b.userId, userName: this.name(b.userId) || b.userName, jobId: b.jobId, jobNumber: b.jobNumber, outAt: b.outAt, outBy: b.outBy, outByStandIn: b.outByStandIn ?? null, note: b.note, ...this.due(b) } : null };
  }

  list() {
    const all = this.s.tools.map(t => this.view(t)).sort((a, b) => Number(b.active) - Number(a.active) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    for (const t of all) {
      if (!t.out?.overdue || !mayHaveIncidents(t.out.userId)) continue;
      if (this.flags.some(f => f.flag_type === 'tool_not_returned' && f.details?.bookingId === t.out!.bookingId)) continue;
      this.flags.push({ id: `flag-tool-${t.out.bookingId}`, flag_type: 'tool_not_returned', severity: 'normal', raised_at: new Date().toISOString(), status: 'open',
        question: `${t.name} (${t.serial ?? t.barcode}) from the stockroom was not signed back${t.out.jobNumber ? ` after job ${t.out.jobNumber}` : ''}. Bring it back to the stockroom.`,
        explanation: null, details: { bookingId: t.out.bookingId, toolId: t.id }, ...(t.out.userId === 'me' ? {} : { tech: t.out.userId }) });
    }
    return all;
  }

  find(code: string): Res {
    const c = code.trim().toUpperCase();
    const t = this.s.tools.find(x => x.barcode === c || (x.serial ?? '').toUpperCase() === c);
    return t ? good(this.view(t)) : bad(404, `no tool with the code or serial number ${code.trim()}`);
  }

  history(id: string) {
    return this.s.bookings.filter(b => b.toolId === id).sort((a, b) => b.outAt.localeCompare(a.outAt)).map(b => ({
      id: b.id, out_at: b.outAt, returned_at: b.returnedAt ?? null, return_condition: b.condition ?? null, return_note: b.returnNote ?? null, out_note: b.note,
      user_name: this.name(b.userId) || b.userName, job_number: b.jobNumber, out_by: b.outBy, returned_by: b.returnedBy ?? null, out_by_stand_in: b.outByStandIn ?? null, returned_by_stand_in: b.returnedBy ? b.returnedByStandIn ?? null : null }));
  }

  add(b: { name?: string; kind?: DemoTool['kind']; serial?: string; barcode?: string }): Res {
    if (!b.name || b.name.trim().length < 2) return bad(400, 'what the tool is');
    const code = b.barcode?.trim().toUpperCase() || `T-${Math.random().toString(36).slice(2, 8).toUpperCase().replace(/[01OI]/g, 'X')}`;
    if (this.s.tools.some(t => t.barcode === code)) return bad(409, 'that code is already on another tool');
    if (b.serial && this.s.tools.some(t => (t.serial ?? '').toUpperCase() === b.serial!.trim().toUpperCase())) return bad(409, 'a tool with that serial number is already in the tool store');
    const t: DemoTool = { id: nid('tl'), name: b.name.trim(), kind: b.kind ?? 'tool', serial: b.serial?.trim() || null, barcode: code, notes: null, condition: 'good', active: true };
    this.s.tools.push(t);
    return good(this.view(t), 201);
  }

  edit(id: string, b: { name?: string; serial?: string; notes?: string; active?: boolean; newBarcode?: boolean; condition?: 'good' | 'damaged'; photoId?: string | null }): Res {
    const t = this.s.tools.find(x => x.id === id);
    if (!t) return bad(404, 'no such tool');
    const v = this.view(t);
    if (b.active === false && v.out) return bad(409, `${t.name} is out with ${v.out.userName}: sign it back first`);
    Object.assign(t, { name: b.name || t.name, serial: b.serial !== undefined ? b.serial || null : t.serial, notes: b.notes !== undefined ? b.notes || null : t.notes,
      active: b.active ?? t.active, condition: b.condition ?? t.condition, photo_id: b.photoId !== undefined ? b.photoId : t.photo_id ?? null, barcode: b.newBarcode ? `T-${Math.random().toString(36).slice(2, 8).toUpperCase().replace(/[01OI]/g, 'X')}` : t.barcode });
    return good(this.view(t));
  }

  bookOut(id: string, b: { userId?: string; jobId?: string; signaturePhotoId?: string; note?: string }, by: string, openJobsOf: (userId: string) => { id: string; job_number: number }[], standIn: string | null = null): Res {
    const t = this.s.tools.find(x => x.id === id && x.active);
    if (!t) return bad(404, 'no such tool in the tool store');
    if (t.condition === 'lost') return bad(409, `${t.name} is written off as lost`);
    const v = this.view(t);
    if (v.out) return bad(409, `${t.name} is already out with ${v.out.userName}`);
    if (!b.userId) return bad(400, 'who is taking it');
    const job = b.jobId ? openJobsOf(b.userId).find(j => j.id === b.jobId) : null;
    if (b.jobId && !job) return bad(400, `that job is not one of ${this.name(b.userId)}'s open jobs`);
    if (!b.signaturePhotoId) return bad(409, `${this.name(b.userId)} signs for it first`);
    this.s.bookings.push({ id: nid('tb'), toolId: id, userId: b.userId, userName: this.name(b.userId), jobId: job?.id ?? null, jobNumber: job?.job_number ?? null, outAt: new Date().toISOString(), outBy: by, outByStandIn: standIn, note: b.note ?? null });
    return good(this.view(t));
  }

  signBack(id: string, b: { condition?: 'good' | 'damaged' | 'lost'; note?: string; signaturePhotoId?: string }, by: string, standIn: string | null = null): Res {
    const t = this.s.tools.find(x => x.id === id);
    const bk = this.s.bookings.find(x => x.toolId === id && !x.returnedAt);
    if (!t || !bk) return bad(409, 'this tool is not booked out');
    const cond = b.condition ?? 'good';
    if (cond !== 'good' && (!b.note || b.note.trim().length < 5)) return bad(400, `say what happened (${cond})`);
    if (!b.signaturePhotoId) return bad(409, 'the signature first');
    Object.assign(bk, { returnedAt: new Date().toISOString(), returnedBy: by, returnedByStandIn: standIn, condition: cond, returnNote: b.note?.trim() || null });
    t.condition = cond;
    for (const f of this.flags) if (f.flag_type === 'tool_not_returned' && f.details?.bookingId === bk.id && f.status !== 'resolved') Object.assign(f, { status: 'resolved', resolution_note: `Signed back (${cond})` });
    return good(this.view(t));
  }

  mine(userId: string) {
    return this.list().filter(t => t.out?.userId === userId).map(t => ({ id: t.id, name: t.name, kind: t.kind, serial: t.serial, barcode: t.barcode, ...t.out }));
  }

  onJob(jobId: string) {
    return this.s.bookings.filter(b => b.jobId === jobId && !b.returnedAt).map(b => {
      const t = this.s.tools.find(x => x.id === b.toolId)!;
      return { name: t.name, serial: t.serial, user_id: b.userId, full_name: this.name(b.userId) || b.userName };
    });
  }
}
