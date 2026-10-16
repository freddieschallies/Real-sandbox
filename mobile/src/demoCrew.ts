// The test drive's assistants and casual labour (the server's routes/crew.ts), kept in this browser.
import * as CR from '../../server/src/core/crew.ts';

export interface CrewMemberRow { id: string; full_name: string; phone: string | null; kind: CR.CrewKind; day_rate_cents: number | null; hour_rate_cents: number | null; note: string | null; active: boolean; added_by: string; added_at: string }
export interface CrewEntryRow { id: string; job_id: string; member_id: string; work_date: string; minutes: number | null; source: 'site' | 'office'; note: string | null; added_by: string; added_by_id: string; added_at: string; removed_at?: string | null }
export interface CrewState { members: CrewMemberRow[]; entries: CrewEntryRow[]; payments: { member_id: string; from: string; to: string; days: number; amount_cents: number; by: string; at: string }[] }

type Res = { status: number; body: unknown };
const ok = (body: unknown, status = 200): Res => ({ status, body });
const no = (status: number, why: string): Res => ({ status, body: { error: 'refused', reasons: [why] } });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const back = (n: number) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
let seq = 0;
const nid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** A couple of people for the test drive (never in the real-data build, where they would look real). */
export function seedCrew(withExamples: boolean): CrewState {
  const at = new Date(Date.now() - 20 * 86_400_000).toISOString();
  return {
    members: withExamples ? [
      { id: 'crew-1', full_name: 'Bongani Khumalo', phone: '072 555 0141', kind: 'assistant', day_rate_cents: null, hour_rate_cents: 6500, note: null, active: true, added_by: 'Admin', added_at: at },
      { id: 'crew-2', full_name: 'Musa Ngcobo', phone: '061 555 0187', kind: 'casual', day_rate_cents: 35000, hour_rate_cents: null, note: 'Good with heavy lifting', active: true, added_by: 'Admin', added_at: at },
    ] : [],
    entries: [], payments: [],
  };
}

export interface CrewSources {
  who: { id: string; name: string };
  level: string;
  /** May the person do office work on jobs (assign, view all), keep the list, set pay. */
  office: boolean; keepsList: boolean; money: boolean;
  onJob: (jobId: string) => boolean;
  job: (jobId: string) => { number: number; status: string; visits: { goAt?: string; arrivedAt?: string; startedAt?: string; endedAt?: string }[] } | null;
}

export class DemoCrew {
  constructor(private s: CrewState, private src: CrewSources) {}

  private visitOn(jobId: string, day: string) {
    const j = this.src.job(jobId);
    const v = [...(j?.visits ?? [])].reverse().find(x => x.goAt && new Date(x.goAt).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }) === day);
    return v ? { from: v.arrivedAt ?? v.startedAt ?? null, to: v.endedAt ?? null } : null;
  }
  private entry(e: CrewEntryRow): CR.CrewEntry { return { memberId: e.member_id, workDate: e.work_date, minutes: e.minutes, visit: e.minutes === null ? this.visitOn(e.job_id, e.work_date) : null }; }
  private live(jobId?: string) { return this.s.entries.filter(e => !e.removed_at && (!jobId || e.job_id === jobId)); }

  /** For the invoice and profit. */
  hours(jobId: string) { return CR.crewHours(this.live(jobId).map(e => this.entry(e))); }
  cost(jobId: string) {
    const mine = this.live(jobId);
    if (!mine.length) return 0;
    const all = this.live().filter(e => mine.some(x => x.member_id === e.member_id && x.work_date === e.work_date));
    return CR.crewCostForJob(jobId, all.map(e => ({ jobId: e.job_id, memberId: e.member_id, workDate: e.work_date, minutes: CR.crewMinutes(this.entry(e)) })), id => {
      const m = this.s.members.find(x => x.id === id);
      return { dayCents: m?.day_rate_cents ?? null, hourCents: m?.hour_rate_cents ?? null };
    });
  }

  route(method: string, p: string, q: URLSearchParams, b: any): Res | null {
    const { office, keepsList, money, who } = this.src;
    let m: RegExpMatchArray | null;
    if (p === '/crew-members') {
      if (method === 'GET') {
        const all = q.get('all') === '1' && keepsList;
        return ok({
          members: this.s.members.filter(x => all || x.active).sort((a, c) => a.kind.localeCompare(c.kind) || a.full_name.localeCompare(c.full_name)).map(x => ({
            id: x.id, full_name: x.full_name, kind: x.kind, phone: keepsList ? x.phone : undefined, active: x.active, note: keepsList ? x.note : undefined,
            lastDay: this.live().filter(e => e.member_id === x.id).map(e => e.work_date).sort().at(-1) ?? null, addedBy: x.added_by,
            ...(money ? { dayRateCents: x.day_rate_cents, hourRateCents: x.hour_rate_cents } : {}),
          })), canEdit: keepsList, canPay: money,
        });
      }
      const name = String(b.fullName ?? '').trim();
      if (name.length < 2) return no(400, 'the name and surname');
      if (!keepsList && (b.kind !== 'casual' || b.dayRateCents != null || b.hourRateCents != null)) return no(403, 'on site you add a casual worker by name; the office does the rest');
      if ((b.dayRateCents != null || b.hourRateCents != null) && !money) return no(403, 'rates are set by Accounts or the CEO');
      const had = (b.id && this.s.members.find(x => x.id === b.id)) || this.s.members.find(x => x.active && x.full_name.toLowerCase() === name.toLowerCase());
      if (had) return ok({ id: had.id, full_name: had.full_name, existing: true });
      const id = b.id ?? nid('crew');
      this.s.members.push({ id, full_name: name, phone: b.phone || null, kind: b.kind === 'assistant' ? 'assistant' : 'casual', day_rate_cents: b.dayRateCents ?? null, hour_rate_cents: b.hourRateCents ?? null,
        note: b.note || null, active: true, added_by: who.name, added_at: new Date().toISOString() });
      return ok({ id, full_name: name, existing: false }, 201);
    }
    if ((m = p.match(/^\/crew-members\/([^/]+)$/)) && method === 'PATCH') {
      if (!keepsList) return no(403, 'the office keeps the list of assistants and casual labour');
      if ((b.dayRateCents !== undefined || b.hourRateCents !== undefined) && !money) return no(403, 'rates are set by Accounts or the CEO');
      const x = this.s.members.find(y => y.id === m![1]);
      if (!x) return no(404, 'no such person');
      if (b.fullName !== undefined) x.full_name = String(b.fullName).trim();
      if (b.phone !== undefined) x.phone = b.phone; if (b.kind) x.kind = b.kind; if (b.note !== undefined) x.note = b.note;
      if (b.dayRateCents !== undefined) x.day_rate_cents = b.dayRateCents; if (b.hourRateCents !== undefined) x.hour_rate_cents = b.hourRateCents;
      if (b.active !== undefined) x.active = !!b.active;
      return ok({ id: x.id });
    }
    if ((m = p.match(/^\/jobs\/([^/]+)\/crew$/))) {
      const jobId = m[1];
      const j = this.src.job(jobId);
      if (!j) return no(404, 'no such job');
      if (!office && !money && !this.src.onJob(jobId)) return no(403, 'not your job card');
      if (method === 'GET') {
        const crew = this.live(jobId).map(e => {
          const x = this.s.members.find(y => y.id === e.member_id)!;
          const en = this.entry(e);
          return { id: e.id, memberId: e.member_id, name: x.full_name, kind: x.kind, workDate: e.work_date, minutes: CR.crewMinutes(en), typed: e.minutes !== null,
            running: e.minutes === null && !!en.visit?.from && !en.visit?.to, source: e.source, note: e.note, addedBy: e.added_by, addedAt: e.added_at,
            canRemove: office || (e.added_by_id === who.id && e.work_date === today()) };
        }).sort((a, c) => a.workDate.localeCompare(c.workDate) || a.name.localeCompare(c.name));
        return ok({ crew, canAdd: true, office, today: today(), hours: this.hours(jobId) });
      }
      if (!office && !this.src.onJob(jobId)) return no(403, 'not your job card');
      if (b.id && this.s.entries.some(e => e.id === b.id)) return ok({ id: b.id });
      if (j.status === 'cancelled') return no(409, 'the job is cancelled');
      const x = this.s.members.find(y => y.id === b.memberId && y.active);
      if (!x) return no(404, 'no such assistant or casual worker');
      const day = office && b.workDate ? String(b.workDate) : today();
      const visit = !office || !b.workDate ? this.visitOn(jobId, day) : null;
      if (!office && !visit) return no(409, 'tap Go on the job first: their time follows yours on site');
      const minutes = b.hours !== undefined ? Math.round(Number(b.hours) * 60) : null;
      if (office && !visit && minutes === null) return no(400, 'how many hours they worked');
      if (this.live(jobId).some(e => e.member_id === x.id && e.work_date === day)) return no(409, `${x.full_name} is already on this job for that day`);
      const id = b.id ?? nid('jc');
      this.s.entries.push({ id, job_id: jobId, member_id: x.id, work_date: day, minutes, source: office ? 'office' : 'site', note: b.note || null, added_by: who.name, added_by_id: who.id, added_at: new Date().toISOString() });
      return ok({ id }, 201);
    }
    if ((m = p.match(/^\/job-crew\/([^/]+)\/remove$/))) {
      const e = this.s.entries.find(x => x.id === m![1] && !x.removed_at);
      if (!e) return no(404, 'not on the job');
      if (!office && !(e.added_by_id === who.id && e.work_date === today())) return no(403, 'ask the office to take them off');
      e.removed_at = new Date().toISOString();
      return ok({ id: e.id });
    }
    if (p === '/crew/pay') {
      if (!money) return no(403, 'pay is for Accounts and the CEO');
      if (method === 'GET') {
        const from = q.get('from') ?? back(6), to = q.get('to') ?? today();
        const casual = this.live().filter(e => e.work_date >= from && e.work_date <= to && this.s.members.find(x => x.id === e.member_id)?.kind === 'casual');
        const pay = CR.casualPay(casual.map(e => ({ memberId: e.member_id, workDate: e.work_date })), id => this.s.members.find(x => x.id === id)?.day_rate_cents ?? null);
        return ok({
          from, to,
          casuals: pay.map(r => {
            const x = this.s.members.find(y => y.id === r.memberId)!;
            return { ...r, name: x.full_name, phone: x.phone, jobs: [...new Set(casual.filter(e => e.member_id === r.memberId).map(e => this.src.job(e.job_id)?.number ?? 0))],
              paid: this.s.payments.filter(y => y.member_id === r.memberId && y.to >= from && y.from <= to).map(y => ({ from: y.from, to: y.to, amountCents: y.amount_cents, at: y.at, by: y.by })) };
          }).sort((a, c) => a.name.localeCompare(c.name)),
          totalCents: pay.reduce((n, r) => n + (r.amountCents ?? 0), 0), noRate: pay.filter(r => r.dayRateCents === null).length,
        });
      }
      const x = this.s.members.find(y => y.id === b.memberId && y.kind === 'casual');
      if (!x) return no(404, 'no such casual worker');
      if (x.day_rate_cents === null) return no(409, `set ${x.full_name}'s day rate first`);
      const days = new Set(this.live().filter(e => e.member_id === x.id && e.work_date >= b.from && e.work_date <= b.to).map(e => e.work_date)).size;
      if (!days) return no(409, 'no days worked in that period');
      if (this.s.payments.some(y => y.member_id === x.id && y.from <= b.to && y.to >= b.from)) return no(409, `${x.full_name} was already paid for part of that period`);
      this.s.payments.push({ member_id: x.id, from: b.from, to: b.to, days, amount_cents: days * x.day_rate_cents, by: who.name, at: new Date().toISOString() });
      return ok({ days, amountCents: days * x.day_rate_cents });
    }
    return null;
  }
}
