// Daily timesheets in a plain format: the day's hours (travel, work, paused, not accounted for),
// every job with its times, the vehicles, and the flags of the day. The technician submits the
// previous day's; HR (and a department manager for his own team) exports them for a day, a week or
// a month, for one person, a department or everyone.
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso } from '../device.ts';
import { randomUUID } from 'expo-crypto';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, Screen, Select, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { TITLE as FLAG_TITLE } from '../screens/Flags.tsx';
import { letterheadBottom, letterheadTop } from '../letterhead.tsx';
import { currentLogo } from '../brand.tsx';
import type { Day, Pay } from '../../../server/src/core/timesheet.ts';
import type { PerfLine } from '../../../server/src/core/worth.ts';
import { PersonHistory, PersonLog } from './History.tsx';

export interface SheetFlag { id: string; flag_type: string; question: string | null; explanation: string | null; status: string; resolution_note: string | null }
export interface Sheet { date: string; label: string; weekday?: boolean; submitted: { at: string; note: string | null; filledBy?: string | null } | null; day: Day; pay?: Pay; flags: SheetFlag[]; status?: string }
interface TechSheets {
  id: string; full_name: string; department: string | null; days: Sheet[]; left?: boolean;
  totals: { travelMin: number; workMin: number; pausedMin: number; unaccountedMin: number; officeMin?: number; invoicedMin?: number; paidMin?: number; normalMin?: number; overtimeMin?: number; doubleMin?: number;
    jobs: number; flags: number; submitted: number; notSubmitted: number; unauthorisedTrips?: number; unauthorisedKm?: number };
  /** CEO, Accounts and HR, when switched on for him; money and verdict the CEO and Accounts only. */
  performance?: PerfLine[] | null; money?: PerfLine[] | null; verdict?: { text: string; tone: 'good' | 'warn' | 'bad' | 'quiet' } | null;
  settings?: { showPerformance: boolean; costPerHourCents?: number | null } | null;
  /** His wages for the period, from the pay on his profile: the CEO and Accounts only. */
  wages?: { rateCents: number; salaried: boolean; normalCents: number; overtimeCents: number; doubleCents: number; totalCents: number } | null;
}
interface Export {
  from: string; to: string; generatedAt: string; rules?: { weekdayNormalMin: number; saturdayNormalMin: number };
  /** Only the CEO fills in a timesheet a technician did not submit. */ canFill?: boolean;
  canMoney?: boolean; canPerformance?: boolean; companyCostPerHourCents?: number | null;
  technicians: TechSheets[];
}

export const hm = (m: number) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const time = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' }) : '–');
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['no signal: try again'];
const sastToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const addDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const flagStatus = (f: SheetFlag) => (f.status === 'resolved' ? `resolved${f.resolution_note ? `: ${f.resolution_note}` : ''}` : f.status === 'explained' ? `explained: ${f.explanation ?? ''}` : 'open');

function Totals({ d, pay }: { d: Day; pay?: Pay }) {
  const box = (label: string, m: number, bad = false) => (
    <View style={{ flex: 1, minWidth: 110, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: bad ? C.bad : C.line }}>
      <Text style={st.small}>{label}</Text>
      <Text style={{ color: bad ? C.bad : C.text, fontSize: 22, fontWeight: '800' }}>{hm(m)}</Text>
    </View>
  );
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {box('Travelled', d.travelMin)}{box('Worked', d.workMin)}{box('Office time', d.officeMin ?? 0)}{box('Paused', d.pausedMin)}{box('Not accounted for', d.unaccountedMin, d.unaccountedMin >= 30)}
      {d.invoicedMin !== undefined ? box('Hours invoiced', d.invoicedMin) : null}
      {pay ? <>{box('Normal time', pay.normalMin)}{box('Overtime 1.5×', pay.overtimeMin)}{box('Double time 2×', pay.doubleMin)}</> : null}
    </View>
  );
}

/** What someone may do on a sheet: the technician removes his own office time (before he submits);
 *  the office takes office time off and allows a trip. */
export type SheetActions = { kind: 'mine'; reload: () => void } | { kind: 'office'; reload: () => void } | undefined;

function ExtraRows({ s, actions }: { s: Sheet; actions: SheetActions }) {
  const st0 = useStore();
  const [off, setOff] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const [err, setErr] = useState<string[] | null>(null);
  const list = s.day.extras ?? [];
  if (!list.length) return null;
  return (
    <View style={{ gap: 6 }}>
      <Label>Office time ({hm(s.day.officeMin ?? 0)}{list.some(e => e.kind === 'driving_back') ? ', driving back is under travel' : ''})</Label>
      {list.map(e => (
        <View key={e.id} style={{ borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 6, gap: 4 }} accessibilityLabel={`Office time ${e.label}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{time(e.start)} to {time(e.end)} · {e.label}</Text>
            <Text style={[st.body, { fontWeight: '800' }]}>{hm(e.minutes)}</Text>
          </View>
          {e.note ? <Text style={st.small}>{e.note}</Text> : null}
          {e.byOffice ? <Text style={st.small}>Added by {e.addedBy}</Text> : null}
          {actions?.kind === 'mine' && !s.submitted && !e.byOffice ? (
            <Button label="Remove" kind="quiet" onPress={async () => { const r = await st0.ask({ method: 'DELETE', path: `/me/timesheets/extra/${e.id}` }); if (r && r.status < 300) actions.reload(); else setErr(reasons(r)); }} />
          ) : null}
          {actions?.kind === 'office' ? (off === e.id ? (
            <>
              <Field label="Why is it taken off? (he is told)" value={why} onChangeText={setWhy} />
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Button label="Take it off" kind="danger" disabled={why.trim().length < 5} onPress={async () => {
                  const r = await st0.ask({ method: 'POST', path: `/timesheets/extra/${e.id}/remove`, json: { reason: why.trim() } });
                  if (r && r.status < 300) { setOff(null); setWhy(''); setErr(null); actions.reload(); } else setErr(reasons(r));
                }} style={{ flexGrow: 1 }} />
                <Button label="Cancel" kind="quiet" onPress={() => setOff(null)} style={{ flexGrow: 1 }} />
              </View>
            </>
          ) : <Pressable onPress={() => { setOff(e.id); setWhy(''); }} accessibilityRole="button"><Text style={[st.small, { color: C.info, textDecorationLine: 'underline' }]}>Take this off his timesheet</Text></Pressable>) : null}
        </View>
      ))}
      {err ? <Notice tone="bad" title="Not done" lines={err} /> : null}
    </View>
  );
}

function TripRows({ s, actions }: { s: Sheet; actions: SheetActions }) {
  const st0 = useStore();
  const [allowing, setAllowing] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string[] | null>(null);
  const list = s.day.trips ?? [];
  if (!list.length) return null;
  const bad = list.filter(t => t.unauthorised);
  return (
    <View style={{ gap: 6 }}>
      <Label>{bad.length ? `Unauthorised trips with a company vehicle (${bad.length})` : 'Trips with a company vehicle (allowed)'}</Label>
      {list.map(t => (
        <View key={t.id} style={{ borderLeftWidth: 4, borderLeftColor: t.unauthorised ? C.bad : C.good, paddingLeft: 8, paddingVertical: 4, gap: 2 }} accessibilityLabel={`Trip ${t.registration} ${time(t.startedAt)}`}>
          <Text style={[st.body, { fontWeight: '800', color: t.unauthorised ? C.bad : C.text }]}>{time(t.startedAt)} to {time(t.endedAt)} · {t.registration} · {Math.round(t.km)} km</Text>
          <Text style={st.small}>{t.whyText.join(' · ')}{t.store ? ` · to ${t.store}` : ''}</Text>
          {t.allowed ? <Text style={[st.small, { color: C.good }]}>Allowed by {t.allowed.by}: {t.allowed.note}</Text> : null}
          {actions?.kind === 'office' ? (t.allowed ? (
            <Pressable onPress={async () => { const r = await st0.ask({ method: 'DELETE', path: `/timesheets/trips/${t.id}/allow` }); if (r && r.status < 300) actions.reload(); else setErr(reasons(r)); }} accessibilityRole="button">
              <Text style={[st.small, { color: C.info, textDecorationLine: 'underline' }]}>Not allowed after all</Text>
            </Pressable>
          ) : allowing === t.id ? (
            <>
              <Field label="Why was it allowed?" value={note} onChangeText={setNote} placeholder="e.g. Sent to the after-hours call-out" />
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Button label="Allow this trip" disabled={note.trim().length < 3} onPress={async () => {
                  const r = await st0.ask({ method: 'POST', path: `/timesheets/trips/${t.id}/allow`, json: { note: note.trim() } });
                  if (r && r.status < 300) { setAllowing(null); setNote(''); setErr(null); actions.reload(); } else setErr(reasons(r));
                }} style={{ flexGrow: 1 }} />
                <Button label="Cancel" kind="quiet" onPress={() => setAllowing(null)} style={{ flexGrow: 1 }} />
              </View>
            </>
          ) : <Pressable onPress={() => { setAllowing(t.id); setNote(''); }} accessibilityRole="button"><Text style={[st.small, { color: C.info, textDecorationLine: 'underline' }]}>It was allowed</Text></Pressable>) : null}
        </View>
      ))}
      {err ? <Notice tone="bad" title="Not done" lines={err} /> : null}
    </View>
  );
}
const dayKind = (p?: Pay) => (!p ? '' : p.holiday ? ` · ${p.holiday} (double time)` : p.dayType === 'sunday' ? ' · Sunday (double time)' : p.dayType === 'saturday' ? ' · Saturday (overtime)' : '');

/** One day's sheet, plain. */
export function SheetView({ s, name, actions }: { s: Sheet; name?: string; actions?: SheetActions }) {
  const d = s.day;
  return (
    <View style={{ gap: 10 }} accessibilityLabel={`Timesheet ${name ?? ''} ${s.date}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontSize: 18, fontWeight: '800', flex: 1 }}>{name ? `${name} · ` : ''}{s.label}</Text>
        {s.submitted ? <Pill text={s.submitted.filledBy ? 'Filled in by the CEO' : 'Submitted'} tone={s.submitted.filledBy ? 'info' : 'good'} /> : s.status === 'none' ? <Pill text="No work recorded" tone="quiet" /> : <Pill text="Not submitted" tone="warn" />}
      </View>
      <Text style={st.small}>{d.start ? `Started ${time(d.start)} · last job finished ${time(d.end)} · ${hm(d.spanMin)} day` : 'Nothing recorded on this day.'}{d.vehicles.length ? ` · Vehicle ${d.vehicles.join(', ')}` : ''}{dayKind(s.pay)}</Text>
      <Totals d={d} pay={s.pay} />
      {d.jobs.length ? (
        <View style={{ borderTopWidth: 2, borderTopColor: C.line }}>
          {d.jobs.map((j, i) => (
            <View key={i} style={{ borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 8, gap: 2 }}>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'baseline' }}>
                <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>Job {j.jobNumber} · {j.store}{j.helper ? ' (helping)' : ''}</Text>
                <Text style={st.small}>Travel {hm(j.travelMin)} · Work {hm(j.workMin)}{j.pausedMin ? ` · Paused ${hm(j.pausedMin)}` : ''}</Text>
              </View>
              <Text style={st.small}>{j.fault}</Text>
              <Text style={st.small}>Go {time(j.go)} · arrived {time(j.arrived)} · left {time(j.ended)} · {j.result}</Text>
              {j.pauses.length ? <Text style={st.small}>Pauses: {j.pauses.map(p => `${p.label} ${hm(p.minutes)}`).join(', ')}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}
      <ExtraRows s={s} actions={actions} />
      <TripRows s={s} actions={actions} />
      {s.flags.length ? (
        <View style={{ gap: 4 }}>
          <Label>Flags this day ({s.flags.length})</Label>
          {s.flags.map(f => <Text key={f.id} style={st.small}>• {FLAG_TITLE[f.flag_type] ?? f.flag_type.replace(/_/g, ' ')}: {f.question ?? ''} ({flagStatus(f)})</Text>)}
        </View>
      ) : <Text style={st.small}>No flags this day.</Text>}
      {s.submitted?.note ? <Text style={st.small}>{s.submitted.filledBy ? 'Note' : 'Technician\'s note'}: {s.submitted.note}</Text> : null}
      {s.submitted ? <Text style={st.small}>{s.submitted.filledBy ? `Filled in by ${s.submitted.filledBy} (not submitted by the technician)` : 'Submitted'} {new Date(s.submitted.at).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</Text> : null}
    </View>
  );
}

// ---- The technician ---------------------------------------------------------------------------

type DueDay = Sheet & { overdue: boolean };
interface Mine { due: DueDay[]; recent: Sheet[]; today?: { date: string; label: string; day: Day }; explainFromMin: number; extraKinds?: { key: string; label: string }[] }
export function useMyTimesheets() {
  const s = useStore();
  const [d, setD] = useState<Mine | null>(null);
  const load = async () => { const r = await s.ask({ method: 'GET', path: '/me/timesheets' }); if (r?.status === 200) setD(r.body as Mine); };
  useEffect(() => { load(); }, []);
  return { d, load };
}

const KIND_HINT: Record<string, string> = {
  meeting: 'Toolbox talk, staff meeting', getting_ready: 'Loading the van, tools, stock', office_work: 'Paperwork at the office', training: 'Courses, learning', driving_back: 'From the last job to the workshop', other: 'Say what it was',
};
const LONG = [15, 30, 45, 60, 90, 120, 180, 240];
const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const localMin = (iso: string) => { const d = new Date(new Date(iso).getTime() + 2 * 3600_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

/** Add office time: four big steps on one screen. */
function AddOfficeTime({ days, kinds, done }: { days: { date: string; label: string; day: Day }[]; kinds: { key: string; label: string }[]; done: (saved: boolean) => void }) {
  const s = useStore();
  const [date, setDate] = useState(days[0].date);
  const [kind, setKind] = useState<string | null>(null);
  const [start, setStart] = useState<number | null>(null);
  const [mins, setMins] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  const day = days.find(x => x.date === date)!.day;
  const suggest = (k: string) => {
    const jobs = day.jobs.filter(j => j.go || j.arrived);
    if (k === 'driving_back') { const last = jobs.map(j => j.ended).filter(Boolean).sort().at(-1); return last ? Math.ceil(localMin(last) / 5) * 5 : 16 * 60; }
    const first = jobs.map(j => j.go ?? j.arrived).filter(Boolean).sort()[0];
    return first ? Math.max(0, Math.floor((localMin(first!) - 30) / 15) * 15) : 7 * 60;
  };
  const pick = (k: string) => { setKind(k); setStart(suggest(k)); setErr(null); };
  const move = (n: number) => setStart(v => Math.min(23 * 60 + 45, Math.max(0, (v ?? 7 * 60) + n)));
  const big = { flexGrow: 1, flexBasis: 140, minHeight: 56 };
  const save = async () => {
    if (!kind || start === null || !mins) return;
    setBusy(true);
    const r = await s.ask({ method: 'POST', path: `/me/timesheets/${date}/extra`, json: { id: randomUUID(), kind, start: `${date}T${clock(start)}:00+02:00`, minutes: mins, ...(note.trim() ? { note: note.trim() } : {}) } });
    setBusy(false);
    if (r && r.status < 300) done(true); else setErr(reasons(r));
  };
  return (
    <Card>
      <Text style={{ color: C.text, fontSize: 20, fontWeight: '800' }}>Add office time</Text>
      {days.length > 1 ? (
        <>
          <Label>1. Which day?</Label>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {days.map(x => <Button key={x.date} label={x.label} kind={date === x.date ? 'primary' : 'secondary'} onPress={() => { setDate(x.date); setKind(null); setStart(null); }} style={big} />)}
          </View>
        </>
      ) : <Text style={st.body}>For {days[0].label}</Text>}
      <Label>{days.length > 1 ? '2' : '1'}. What was it?</Label>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {kinds.map(k => (
          <Pressable key={k.key} onPress={() => pick(k.key)} accessibilityRole="radio" accessibilityState={{ selected: kind === k.key }} accessibilityLabel={k.label}
            style={{ flexGrow: 1, flexBasis: 150, minHeight: 64, padding: 10, borderRadius: 10, borderWidth: 2, borderColor: kind === k.key ? C.accent : C.line, backgroundColor: kind === k.key ? C.accent : 'transparent', justifyContent: 'center' }}>
            <Text style={{ color: kind === k.key ? C.accentText : C.text, fontSize: 17, fontWeight: '800' }}>{k.label.replace(/ \(.*\)$/, '')}</Text>
            <Text style={{ color: kind === k.key ? C.accentText : C.quiet, fontSize: 12 }}>{KIND_HINT[k.key] ?? ''}</Text>
          </Pressable>
        ))}
      </View>
      {kind === 'other' ? <Field label="What was it?" value={note} onChangeText={setNote} placeholder="e.g. Collected the company bakkie from the panel beater" /> : null}
      {kind ? (
        <>
          <Label>{days.length > 1 ? '3' : '2'}. What time did it start?</Label>
          <Text style={{ textAlign: 'center', color: C.text, fontSize: 40, fontWeight: '900' }} accessibilityLabel="Start time">{clock(start ?? 0)}</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label="−1 h" kind="secondary" onPress={() => move(-60)} style={{ flex: 1, minWidth: 0, paddingHorizontal: 4 }} />
            <Button label="−15 min" kind="secondary" onPress={() => move(-15)} style={{ flex: 1, minWidth: 0, paddingHorizontal: 4 }} />
            <Button label="+15 min" kind="secondary" onPress={() => move(15)} style={{ flex: 1, minWidth: 0, paddingHorizontal: 4 }} />
            <Button label="+1 h" kind="secondary" onPress={() => move(60)} style={{ flex: 1, minWidth: 0, paddingHorizontal: 4 }} />
          </View>
          <Label>{days.length > 1 ? '4' : '3'}. How long?</Label>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {LONG.map(m => <Button key={m} label={m < 60 ? `${m} min` : m === 90 ? '1½ hours' : `${m / 60} hour${m > 60 ? 's' : ''}`} kind={mins === m ? 'primary' : 'secondary'} onPress={() => { setMins(m); setErr(null); }} style={{ flexGrow: 1, flexBasis: 90, minHeight: 52 }} />)}
          </View>
        </>
      ) : null}
      {kind && start !== null && mins ? <Notice tone="info" title={`${kinds.find(k => k.key === kind)?.label.replace(/ \(.*\)$/, '')}: ${clock(start)} to ${clock((start + mins) % 1440)} (${hm(mins)})`} /> : null}
      {err ? <Notice tone="bad" title="Not added" lines={err} /> : null}
      <Button label="Save" disabled={!kind || start === null || !mins || (kind === 'other' && note.trim().length < 3)} busy={busy} onPress={save} />
      <Button label="Cancel" kind="quiet" onPress={() => done(false)} />
    </Card>
  );
}

export function MyTimesheetsScreen() {
  const nav = useNav();
  const s = useStore();
  const { d, load } = useMyTimesheets();
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [past, setPast] = useState(false);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const cur = d?.due[0];
  const explain = cur && cur.day.unaccountedMin >= (d?.explainFromMin ?? 30);
  const addDays = d ? [...(cur ? [{ date: cur.date, label: cur.label, day: cur.day }] : []), ...(d.today ? [{ date: d.today.date, label: `Today (${d.today.label})`, day: d.today.day }] : [])] : [];
  const mine: SheetActions = { kind: 'mine', reload: load };
  const todayExtras = d?.today?.day.extras ?? [];
  return (
    <Screen title="Timesheet" sub={cur ? `${d!.due.length} day${d!.due.length > 1 ? 's' : ''} to submit` : 'All submitted'} onBack={nav.back}>
      {done ? <Notice tone="good" title="Submitted" lines={[`Your timesheet for ${done} went to HR.`]} /> : null}
      {added ? <Notice tone="good" title="Office time added" /> : null}
      {d && d.extraKinds && addDays.length ? (adding
        ? <AddOfficeTime days={addDays} kinds={d.extraKinds} done={ok => { setAdding(false); setAdded(ok); if (ok) load(); }} />
        : <Button label="+ Add office time (meeting, getting ready…)" kind="secondary" onPress={() => { setAdding(true); setAdded(false); }} style={{ minHeight: 56 }} />) : null}
      {!adding && todayExtras.length && d?.today ? (
        <Card><Text style={[st.body, { fontWeight: '800' }]}>Today</Text><ExtraRows s={{ date: d.today.date, label: d.today.label, submitted: null, day: d.today.day, flags: [] }} actions={mine} /></Card>
      ) : null}
      {!d ? <Body quiet>Loading…</Body> : adding ? null : cur ? (
        <>
          <Text style={st.body}>The app made this from your jobs and vehicle scans. Add any office time, check it and submit it.</Text>
          <Card><SheetView s={{ ...cur, submitted: null }} actions={mine} /></Card>
          {explain ? <Notice tone="warn" title={`${hm(cur.day.unaccountedMin)} not accounted for`} lines={['Was it a meeting or getting ready? Add it as office time above.', 'Otherwise say what that time was (e.g. waiting for the store to open).']} /> : null}
          <Field label={explain ? 'What was the time not accounted for?' : 'Note (optional)'} value={note} onChangeText={setNote} multiline />
          {err ? <Notice tone="bad" title="Not submitted" lines={err} /> : null}
          <Button label={`Submit ${cur.label}`} busy={busy} onPress={async () => {
            setBusy(true);
            const r = await s.ask({ method: 'POST', path: `/me/timesheets/${cur.date}/submit`, json: { at: nowIso(), ...(note.trim() ? { note: note.trim() } : {}) } });
            setBusy(false);
            if (r && r.status < 300) { setDone(cur.label); setNote(''); setErr(null); load(); } else setErr(reasons(r));
          }} />
          <Text style={st.small}>Once submitted it cannot be changed; corrections go through your manager.</Text>
        </>
      ) : <Body>Nothing to submit. Yesterday's timesheet is in.</Body>}
      {d?.recent.length && !adding ? (
        <>
          <Pressable onPress={() => setPast(v => !v)} accessibilityRole="button"><Text style={[st.small, { textDecorationLine: 'underline' }]}>{past ? 'Hide' : 'Show'} submitted timesheets ({d.recent.length})</Text></Pressable>
          {past ? d.recent.filter(r => r.day).map(r => <Card key={r.date}><SheetView s={{ ...r, flags: r.flags ?? [] }} /></Card>) : null}
        </>
      ) : null}
    </Screen>
  );
}

// ---- HR's export ------------------------------------------------------------------------------

type Period = 'day' | 'week' | 'month';
function rangeOf(p: Period, anchor: string): { from: string; to: string; label: string } {
  const d = new Date(`${anchor}T12:00:00Z`);
  const fmt = (x: string, o: Intl.DateTimeFormatOptions) => new Date(`${x}T12:00:00Z`).toLocaleDateString('en-ZA', { ...o, timeZone: 'UTC' });
  if (p === 'day') return { from: anchor, to: anchor, label: fmt(anchor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) };
  if (p === 'week') {
    const back = (d.getUTCDay() + 6) % 7;
    const from = addDays(anchor, -back), to = addDays(from, 6);
    return { from, to, label: `Week ${fmt(from, { day: 'numeric', month: 'short' })} – ${fmt(to, { day: 'numeric', month: 'short', year: 'numeric' })}` };
  }
  const from = `${anchor.slice(0, 7)}-01`;
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { from, to: end, label: fmt(from, { month: 'long', year: 'numeric' }) };
}
const step = (p: Period, anchor: string, n: number) => (p === 'day' ? addDays(anchor, n) : p === 'week' ? addDays(anchor, 7 * n) : (() => { const d = new Date(`${anchor.slice(0, 7)}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); })());

export function TimesheetsExport() {
  const s = useStore();
  const [period, setPeriod] = useState<Period>('day');
  const [anchor, setAnchor] = useState(addDays(sastToday(), -1));
  const [who, setWho] = useState<string>('all');
  const [people, setPeople] = useState<{ value: string; label: string }[]>([]);
  const [d, setD] = useState<Export | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // HR and the CEO: everyone's, also people who have left; a person's whole history and its log.
  const [full, setFull] = useState(false);
  const [withLeft, setWithLeft] = useState(false);
  const [view, setView] = useState<'period' | 'history' | 'log'>('period');
  const [hide, setHide] = useState(false);
  const r = rangeOf(period, anchor);
  useEffect(() => {
    Promise.all([s.ask({ method: 'GET', path: '/departments' }), s.ask({ method: 'GET', path: '/timesheets/people' })]).then(([x, y]) => {
      const b = (x?.status === 200 ? x.body : { departments: [] }) as { departments: { id: string; name: string; active?: boolean }[]; members?: { id: string; full_name: string; login_level: string }[] };
      const tp = y?.status === 200 ? (y.body as { people: { id: string; full_name: string; left: boolean; left_on: string | null }[]; full: boolean }) : null;
      setFull(!!tp?.full);
      const persons = tp ? tp.people.map(m => ({ value: `user:${m.id}`, label: `${m.full_name}${m.left ? ` (left${m.left_on ? ` ${m.left_on}` : ''})` : ''}` }))
        : (b.members ?? []).filter(m => m.login_level === 'technician').map(m => ({ value: `user:${m.id}`, label: m.full_name }));
      setPeople([{ value: 'all', label: 'Everyone' }, ...b.departments.filter(dp => dp.active !== false).map(dp => ({ value: `dept:${dp.id}`, label: `${dp.name} department` })), ...persons]);
    });
  }, []);
  useEffect(() => { if (!who.startsWith('user:')) setView('period'); }, [who]);
  useEffect(() => {
    setD(null); setErr(null);
    const q = `from=${r.from}&to=${r.to}${who.startsWith('dept:') ? `&departmentId=${who.slice(5)}` : who.startsWith('user:') ? `&userId=${who.slice(5)}` : ''}${withLeft ? '&includeLeft=1' : ''}`;
    s.ask({ method: 'GET', path: `/timesheets?${q}` }).then(x => { if (x?.status === 200) setD(x.body); else setErr(reasons(x).join('; ')); });
  }, [r.from, r.to, who, tick, withLeft]);
  const whoLabel = people.find(p => p.value === who)?.label ?? 'Everyone';
  const person = who.startsWith('user:') ? { id: who.slice(5), name: whoLabel.replace(/ \(left.*\)$/, '') } : null;
  const switches = (
    <>
      <Select label="Who" value={who} options={people.length ? people : [{ value: 'all', label: 'Everyone' }]} onChange={setWho} />
      {full && !person ? (
        <Pressable onPress={() => setWithLeft(v => !v)} accessibilityRole="switch" accessibilityState={{ checked: withLeft }} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: withLeft ? C.accent : C.line, backgroundColor: withLeft ? C.accent : 'transparent' }} />
          <Text style={st.body}>Include people who have left</Text>
        </Pressable>
      ) : null}
      {person ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Button label="This period" kind={view === 'period' ? 'primary' : 'secondary'} onPress={() => setView('period')} style={{ flexGrow: 1 }} />
          <Button label="Every timesheet" kind={view === 'history' ? 'primary' : 'secondary'} onPress={() => setView('history')} style={{ flexGrow: 1 }} />
          {full ? <Button label="Log" kind={view === 'log' ? 'primary' : 'secondary'} onPress={() => setView('log')} style={{ flexGrow: 1 }} /> : null}
        </View>
      ) : null}
    </>
  );
  if (person && view === 'history') return <>{switches}<PersonHistory userId={person.id} name={person.name} /></>;
  if (person && view === 'log') return <>{switches}<PersonLog userId={person.id} name={person.name} /></>;
  const sheets = d?.technicians.flatMap(t => t.days.map(day => ({ t, day }))) ?? [];
  return (
    <>
      <Choice options={['day', 'week', 'month'] as const} value={period} onChange={setPeriod} labels={{ day: 'Daily', week: 'Weekly', month: 'Monthly' }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Button label="‹" kind="secondary" onPress={() => setAnchor(a => step(period, a, -1))} style={{ width: 56 }} />
        <Text style={[st.body, { fontWeight: '800', flex: 1, textAlign: 'center' }]} accessibilityLabel="Period">{r.label}</Text>
        <Button label="›" kind="secondary" disabled={r.to >= sastToday()} onPress={() => setAnchor(a => step(period, a, 1))} style={{ width: 56 }} />
      </View>
      {switches}
      <HoursRules reload={() => setTick(t => t + 1)} />
      {err ? <Notice tone="bad" title="Could not load" lines={[err]} /> : null}
      {!d && !err ? <Body quiet>Loading…</Body> : null}
      {d ? (
        <>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {Platform.OS === 'web' ? <Button label="Print / save as PDF" onPress={() => setMsg(printSheets(d, `${whoLabel} · ${r.label}`, s.session?.company.name ?? '', hide, r.label) ? null : 'The browser blocked the print window: allow pop-ups for this site.')} style={{ flexGrow: 1 }} /> : null}
            {Platform.OS === 'web' ? <Button label="Download for Excel (CSV)" kind="secondary" onPress={() => setMsg(downloadCsv(d, `timesheets-${r.from}-to-${r.to}.csv`) ? null : 'This browser could not save the file.')} style={{ flexGrow: 1 }} /> : null}
          </View>
          {Platform.OS === 'web' && d.canPerformance && d.technicians.some(t => t.performance) ? (
            <Pressable onPress={() => setHide(v => !v)} accessibilityRole="switch" accessibilityState={{ checked: hide }} accessibilityLabel="Hide performance on the print-out" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: hide ? C.accent : C.line, backgroundColor: hide ? C.accent : 'transparent' }} />
              <Text style={[st.body, { flex: 1 }]}>Hide performance{d.canMoney ? ' and money' : ''} on the print-out (when the technician asks for a copy)</Text>
            </Pressable>
          ) : null}
          {msg ? <Notice tone="warn" title="Not done" lines={[msg]} /> : null}
          <Label>{whoLabel} · {r.label}</Label>
          {d.technicians.map(t => <TechSummary key={t.id} t={t} d={d} open={who.startsWith('user:') ? undefined : () => setWho(`user:${t.id}`)} reload={() => setTick(n => n + 1)} />)}
          {!d.technicians.length ? <Body quiet>No technicians.</Body> : null}
          <Heading>Timesheets ({sheets.length})</Heading>
          {sheets.map(({ t, day }) => {
            const k = `${t.id}|${day.date}`;
            return (
              <Card key={k} onPress={open === k ? undefined : () => setOpen(k)} accessibilityLabel={`Sheet ${t.full_name} ${day.date}`}>
                {open === k ? <SheetView s={day} name={t.full_name} actions={{ kind: 'office', reload: () => setTick(n => n + 1) }} /> : (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={[st.body, { fontWeight: '700', flex: 1 }]}>{t.full_name} · {day.label}</Text>
                    <Text style={st.small}>W {hm(day.day.workMin)} · T {hm(day.day.travelMin)}{day.day.officeMin ? ` · O ${hm(day.day.officeMin)}` : ''}{day.day.trips?.some(x => x.unauthorised) ? ' · TRIP' : ''}{day.pay?.overtimeMin ? ` · OT ${hm(day.pay.overtimeMin)}` : ''}{day.pay?.doubleMin ? ` · DT ${hm(day.pay.doubleMin)}` : ''}{day.day.unaccountedMin ? ` · NA ${hm(day.day.unaccountedMin)}` : ''}{day.flags.length ? ` · ${day.flags.length} flag${day.flags.length > 1 ? 's' : ''}` : ''}</Text>
                    {day.submitted ? <Pill text={day.submitted.filledBy ? 'Filled in' : 'Submitted'} tone={day.submitted.filledBy ? 'info' : 'good'} /> : day.status === 'none' ? <Pill text="No work" tone="quiet" /> : <Pill text="Missing" tone="warn" />}
                  </View>
                )}
                {open === k && d.canFill && !day.submitted && day.status === 'not_submitted' ? (
                  <View style={{ gap: 6 }}>
                    <Text style={st.small}>{t.full_name} did not submit this day. As the CEO you can fill it in as the app made it; it shows as filled in by you, and he is told.</Text>
                    <Button label="Fill in and submit for him" kind="secondary" onPress={async () => {
                      const x = await s.ask({ method: 'POST', path: `/timesheets/${t.id}/${day.date}/fill`, json: {} });
                      if (x && x.status < 300) { setMsg(null); setTick(n => n + 1); } else setMsg(reasons(x).join('; '));
                    }} />
                  </View>
                ) : null}
                {open === k ? <Button label="Close" kind="quiet" onPress={() => setOpen(null)} /> : null}
              </Card>
            );
          })}
        </>
      ) : null}
    </>
  );
}

const TONE_C = (t?: string) => (t === 'good' ? C.good : t === 'warn' ? C.warn : t === 'bad' ? C.bad : C.text);
function Lines({ lines }: { lines: PerfLine[] }) {
  return (
    <View>
      {lines.map(l => (
        <View key={l.label} style={{ flexDirection: 'row', gap: 8, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.line, flexWrap: 'wrap' }}>
          <Text style={[st.body, { flex: 1, minWidth: 160 }]}>{l.label}</Text>
          <Text style={[st.body, { fontWeight: '800', color: TONE_C(l.tone) }]}>{l.value}</Text>
        </View>
      ))}
    </View>
  );
}

/** One technician's totals for the period; his performance and worth (who may see it); the CEO's and Accounts' switch for it. */
function TechSummary({ t, d, open, reload }: { t: TechSheets; d: Export; open?: () => void; reload: () => void }) {
  const s = useStore();
  const x = t.totals;
  const [edit, setEdit] = useState(false);
  const [show, setShow] = useState(!!t.settings?.showPerformance);
  const [cost, setCost] = useState(t.settings?.costPerHourCents != null ? String(t.settings.costPerHourCents / 100) : '');
  const [err, setErr] = useState<string[] | null>(null);
  const box = (label: string, v: string, tone?: string) => (
    <View style={{ flexGrow: 1, flexBasis: 92, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: tone ? TONE_C(tone) : C.line }}>
      <Text style={st.small}>{label}</Text>
      <Text style={{ color: tone ? TONE_C(tone) : C.text, fontSize: 18, fontWeight: '800' }}>{v}</Text>
    </View>
  );
  return (
    <Card accessibilityLabel={`Totals ${t.full_name}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {open ? (
          <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={`Open ${t.full_name}`} style={{ flex: 1 }}>
            <Text style={[st.body, { fontWeight: '800', color: C.accent }]}>{t.full_name}{t.left ? ' (left)' : ''}</Text>
          </Pressable>
        ) : <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{t.full_name}{t.left ? ' (left)' : ''}</Text>}
        {t.department ? <Text style={st.small}>{t.department}</Text> : null}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {box('Paid', hm(x.paidMin ?? 0))}{box('Travel', hm(x.travelMin))}{box('Work', hm(x.workMin))}{box('Office', hm(x.officeMin ?? 0))}
        {box('Invoiced', hm(x.invoicedMin ?? 0))}{box('Normal', hm(x.normalMin ?? 0))}{box('OT 1.5×', hm(x.overtimeMin ?? 0))}{box('DT 2×', hm(x.doubleMin ?? 0))}
        {box('Not acc.', hm(x.unaccountedMin), x.unaccountedMin >= 30 ? 'bad' : undefined)}{box('Flags', String(x.flags), x.flags ? 'warn' : undefined)}
        {box('Missing', String(x.notSubmitted), x.notSubmitted ? 'warn' : undefined)}
        {box(x.unauthorisedTrips ? `Unauth. trips (${x.unauthorisedKm} km)` : 'Unauth. trips', String(x.unauthorisedTrips ?? 0), x.unauthorisedTrips ? 'bad' : undefined)}
      </View>
      {t.performance ? (
        <View style={{ gap: 4 }}>
          <Label>Performance · not on his print-out if hidden</Label>
          <Lines lines={t.performance} />
        </View>
      ) : null}
      {t.money ? (
        <View style={{ gap: 4 }}>
          <Label>Made and cost the company (CEO and Accounts only)</Label>
          {t.verdict ? <Notice tone={t.verdict.tone === 'quiet' ? 'info' : t.verdict.tone} title={t.verdict.text} /> : null}
          <Lines lines={t.money} />
        </View>
      ) : null}
      {t.wages ? (
        <View style={{ gap: 4 }}>
          <Label>Wages for these days (CEO and Accounts only)</Label>
          <Text style={[st.body, { fontWeight: '800' }]}>R {(t.wages.totalCents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
          <Text style={st.small}>{t.wages.salaried ? `Salary R ${(t.wages.normalCents / 100).toFixed(2)}` : `Normal R ${(t.wages.normalCents / 100).toFixed(2)}`} · overtime R {(t.wages.overtimeCents / 100).toFixed(2)} · Sundays and public holidays R {(t.wages.doubleCents / 100).toFixed(2)} · at R {(t.wages.rateCents / 100).toFixed(2)}/h</Text>
        </View>
      ) : d.canMoney ? <Text style={st.small}>No pay set for him yet: People → {t.full_name} → Pay.</Text> : null}
      {d.canMoney && t.settings ? (edit ? (
        <View style={{ gap: 8 }}>
          <Pressable onPress={() => setShow(v => !v)} accessibilityRole="switch" accessibilityState={{ checked: show }} accessibilityLabel={`Show performance ${t.full_name}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: show ? C.accent : C.line, backgroundColor: show ? C.accent : 'transparent' }} />
            <Text style={[st.body, { flex: 1 }]}>Show performance on his monthly timesheet</Text>
          </Pressable>
          <Field label={`What an hour of him costs (R, blank = the company rate${d.companyCostPerHourCents ? ` of R ${(d.companyCostPerHourCents / 100).toFixed(2)}` : ''})`} value={cost} onChangeText={setCost} keyboardType="decimal-pad" />
          {err ? <Notice tone="bad" title="Not saved" lines={err} /> : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button label="Save" onPress={async () => {
              const c = cost.trim() ? Math.round(Number(cost.replace(',', '.')) * 100) : null;
              if (c !== null && !(c >= 0)) { setErr(['the cost per hour, in rand']); return; }
              const r = await s.ask({ method: 'PUT', path: `/timesheets/worth/${t.id}`, json: { showPerformance: show, costPerHourCents: c } });
              if (r && r.status < 300) { setEdit(false); setErr(null); reload(); } else setErr(reasons(r));
            }} style={{ flexGrow: 1 }} />
            <Button label="Cancel" kind="quiet" onPress={() => setEdit(false)} style={{ flexGrow: 1 }} />
          </View>
        </View>
      ) : (
        <Pressable onPress={() => setEdit(true)} accessibilityRole="button" accessibilityLabel={`Performance settings ${t.full_name}`}>
          <Text style={[st.small, { color: C.info, textDecorationLine: 'underline' }]}>{t.settings.showPerformance ? 'Performance shown' : 'Performance not shown'} · {t.settings.costPerHourCents != null ? `R ${(t.settings.costPerHourCents / 100).toFixed(2)}/h` : 'company rate'} · change</Text>
        </Pressable>
      )) : null}
    </Card>
  );
}

/** The company's normal hours: overtime after them, double time on Sundays and public holidays. */
function HoursRules({ reload }: { reload: () => void }) {
  const s = useStore();
  const [r, setR] = useState<{ weekdayNormalMin: number; saturdayNormalMin: number; workStartMin?: number; workEndMin?: number; canEdit: boolean } | null>(null);
  const [edit, setEdit] = useState(false);
  const [wk, setWk] = useState('8:00');
  const [sat, setSat] = useState('0:00');
  const [from, setFrom] = useState('7:00');
  const [to, setTo] = useState('17:00');
  const [err, setErr] = useState<string[] | null>(null);
  const load = async () => { const x = await s.ask({ method: 'GET', path: '/timesheets/settings' }); if (x?.status === 200) { setR(x.body); setWk(hm(x.body.weekdayNormalMin)); setSat(hm(x.body.saturdayNormalMin)); setFrom(hm(x.body.workStartMin ?? 420)); setTo(hm(x.body.workEndMin ?? 1020)); } };
  useEffect(() => { load(); }, []);
  if (!r) return null;
  const toMin = (v: string) => { const m = v.trim().match(/^(\d{1,2})(?::(\d{2}))?$/); return m ? Number(m[1]) * 60 + Number(m[2] ?? 0) : NaN; };
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.small, { flex: 1 }]}>Normal day {hm(r.weekdayNormalMin)} Mon–Fri{r.saturdayNormalMin ? `, Saturday ${hm(r.saturdayNormalMin)}` : ''}; after that overtime (1.5×){r.saturdayNormalMin ? '' : ', all of Saturday overtime'}; Sundays and public holidays double time (2×). Paid time is travel, work and office time. Working hours {hm(r.workStartMin ?? 420)} to {hm(r.workEndMin ?? 1020)}: driving outside them with no job is an unauthorised trip.</Text>
        {r.canEdit && !edit ? <Pressable onPress={() => setEdit(true)} accessibilityRole="button"><Text style={[st.small, { color: C.info, textDecorationLine: 'underline' }]}>Change</Text></Pressable> : null}
      </View>
      {edit ? (
        <>
          <Field label="Normal hours Monday to Friday (h:mm)" value={wk} onChangeText={setWk} />
          <Field label="Normal hours on Saturday (h:mm, 0:00 = all overtime)" value={sat} onChangeText={setSat} />
          <Field label="Working day starts (h:mm)" value={from} onChangeText={setFrom} />
          <Field label="Working day ends (h:mm)" value={to} onChangeText={setTo} />
          {err ? <Notice tone="bad" title="Not saved" lines={err} /> : null}
          <Button label="Save the hours" onPress={async () => {
            const x = await s.ask({ method: 'PUT', path: '/timesheets/settings', json: { weekdayNormalMin: toMin(wk), saturdayNormalMin: toMin(sat), workStartMin: toMin(from), workEndMin: toMin(to) } });
            if (x && x.status < 300) { setEdit(false); setErr(null); await load(); reload(); } else setErr(reasons(x));
          }} />
          <Button label="Cancel" kind="quiet" onPress={() => setEdit(false)} />
        </>
      ) : null}
    </Card>
  );
}

// ---- Export files -----------------------------------------------------------------------------

const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** One printable page per timesheet, on the company letterhead (black and orange). */
function printSheets(d: Export, title: string, company: string, hide = false, period?: string): boolean {
  if (Platform.OS !== 'web') return false;
  const head = (sub: string, right: string) => `<div class=bar></div><div class=head>${currentLogo() ? `<img src="${currentLogo()}" style="height:48px;background:#fff;padding:3px;border-radius:4px;margin-right:12px">` : ''}<div style="flex:1"><h1>${esc(company)}</h1><div>${esc(sub)}</div></div><div class=t>${esc(right)}</div></div>`;
  const lines = (l: PerfLine[]) => `<table>${l.map(x => `<tr><td>${esc(x.label)}</td><td class="r${x.tone === 'bad' ? ' bad' : ''}"><b>${esc(x.value)}</b></td></tr>`).join('')}</table>`;
  // The statement for the period: one page per technician with his totals, office time, hours invoiced,
  // unauthorised trips; and his performance (and worth) unless hidden for his copy.
  const range = period ?? (d.from === d.to ? d.from : `${d.from} to ${d.to}`);
  const summaries = d.technicians.map(t => {
    const x = t.totals;
    const trips = t.days.flatMap(s => (s.day.trips ?? []).filter(tr => tr.unauthorised).map(tr => `<tr><td>${esc(s.label)}</td><td>${time(tr.startedAt)} to ${time(tr.endedAt)}</td><td>${esc(tr.registration)}</td><td class=r>${Math.round(tr.km)} km</td><td>${esc(tr.whyText.join(', '))}</td></tr>`)).join('');
    const extras = t.days.flatMap(s => (s.day.extras ?? []).map(e => `<tr><td>${esc(s.label)}</td><td>${time(e.start)} to ${time(e.end)}</td><td>${esc(e.label)}${e.note ? `: ${esc(e.note)}` : ''}</td><td class=r>${hm(e.minutes)}</td></tr>`)).join('');
    return `<section>${letterheadTop(head('Timesheet statement', range))}${letterheadTop('') ? `<h2 style="margin:10px 20px 0">Timesheet statement · ${esc(range)}</h2>` : ''}
<div class=body><div class=two><div><b>Technician</b> ${esc(t.full_name)}<br><b>Department</b> ${esc(t.department ?? '–')}</div><div><b>Days</b> ${t.days.length} · <b>submitted</b> ${x.submitted} · <b>not submitted</b> ${x.notSubmitted}</div></div>
<table class=tot><tr><th>Paid</th><th>Travel</th><th>Work</th><th>Office</th><th>Hours invoiced</th><th>Normal</th><th>OT 1.5×</th><th>DT 2×</th><th>Not acc.</th></tr>
<tr><td>${hm(x.paidMin ?? 0)}</td><td>${hm(x.travelMin)}</td><td>${hm(x.workMin)}</td><td>${hm(x.officeMin ?? 0)}</td><td>${hm(x.invoicedMin ?? 0)}</td><td>${hm(x.normalMin ?? 0)}</td><td>${hm(x.overtimeMin ?? 0)}</td><td>${hm(x.doubleMin ?? 0)}</td><td${x.unaccountedMin >= 30 ? ' class=bad' : ''}>${hm(x.unaccountedMin)}</td></tr></table>
<h3>Office time</h3>${extras ? `<table><tr><th>Day</th><th>Time</th><th>What</th><th class=r>Hours</th></tr>${extras}</table>` : '<p>None.</p>'}
<h3>Unauthorised trips with a company vehicle</h3>${trips ? `<table><tr><th>Day</th><th>Time</th><th>Vehicle</th><th class=r>Distance</th><th>Why</th></tr>${trips}</table>` : '<p>None.</p>'}
${!hide && t.performance ? `<h3>Performance</h3>${lines(t.performance)}` : ''}${!hide && t.money ? `<h3>Made and cost the company</h3>${t.verdict ? `<p><b>${esc(t.verdict.text)}</b></p>` : ''}${lines(t.money)}` : ''}${!hide && t.wages ? `<h3>Wages</h3><p><b>R ${(t.wages.totalCents / 100).toFixed(2)}</b>: ${t.wages.salaried ? 'salary' : 'normal'} R ${(t.wages.normalCents / 100).toFixed(2)}, overtime R ${(t.wages.overtimeCents / 100).toFixed(2)}, Sundays and public holidays R ${(t.wages.doubleCents / 100).toFixed(2)} (R ${(t.wages.rateCents / 100).toFixed(2)}/h)</p>` : ''}
<p class=sign>Technician: ____________________ &nbsp;&nbsp; Manager / HR: ____________________</p></div>${letterheadBottom('<div class=bar></div>')}</section>`;
  }).join('');
  const pages = d.technicians.flatMap(t => t.days.map(s => {
    const x = s.day;
    const jobs = x.jobs.map(j => `<tr><td>${j.jobNumber}</td><td>${esc(j.store)}${j.helper ? ' (helping)' : ''}<br><small>${esc(j.fault)}</small></td><td>${time(j.go)}</td><td>${time(j.arrived)}</td><td>${time(j.ended)}</td>
<td class=r>${hm(j.travelMin)}</td><td class=r>${hm(j.workMin)}</td><td class=r>${hm(j.pausedMin)}</td><td>${esc(j.result)}${j.pauses.length ? `<br><small>${esc(j.pauses.map(p => `${p.label} ${hm(p.minutes)}`).join(', '))}</small>` : ''}</td></tr>`).join('');
    const flags = s.flags.map(f => `<li><b>${esc(FLAG_TITLE[f.flag_type] ?? f.flag_type)}</b>: ${esc(f.question)} <i>(${esc(flagStatus(f))})</i></li>`).join('');
    const plainHead = `<div class=bar></div><div class=head>${currentLogo() ? `<img src="${currentLogo()}" style="height:48px;background:#fff;padding:3px;border-radius:4px;margin-right:12px">` : ''}<div style="flex:1"><h1>${esc(company)}</h1><div>Daily timesheet</div></div><div class=t>${esc(s.label)}</div></div>`;
    // On the company letterhead (set by the CEO) when there is one: the sheet's own title under it.
    return `<section>${letterheadTop(plainHead)}${letterheadTop('') ? `<h2 style="margin:10px 20px 0">Daily timesheet · ${esc(s.label)}</h2>` : ''}
<div class=body><div class=two><div><b>Technician</b> ${esc(t.full_name)}<br><b>Department</b> ${esc(t.department ?? '–')}</div>
<div><b>Started</b> ${time(x.start)} · <b>Last job finished</b> ${time(x.end)}<br><b>Vehicle</b> ${esc(x.vehicles.join(', ') || '–')}<br><b>Status</b> ${s.submitted ? `${s.submitted.filledBy ? `Filled in by ${esc(s.submitted.filledBy)}` : 'Submitted'} ${esc(new Date(s.submitted.at).toLocaleString('en-ZA'))}` : s.status === 'none' ? 'No work recorded' : 'NOT SUBMITTED'}</div></div>
<table class=tot><tr><th>Travelled</th><th>Worked</th><th>Office</th><th>Paused</th><th>Not accounted for</th><th>Normal time</th><th>Overtime 1.5×</th><th>Double time 2×</th><th>Hours invoiced</th></tr><tr><td>${hm(x.travelMin)}</td><td>${hm(x.workMin)}</td><td>${hm(x.officeMin ?? 0)}</td><td>${hm(x.pausedMin)}</td><td${x.unaccountedMin >= 30 ? ' class=bad' : ''}>${hm(x.unaccountedMin)}</td><td>${hm(s.pay?.normalMin ?? 0)}</td><td>${hm(s.pay?.overtimeMin ?? 0)}</td><td>${hm(s.pay?.doubleMin ?? 0)}</td><td>${hm(x.invoicedMin ?? 0)}</td></tr></table>${s.pay?.holiday ? `<p><b>${esc(s.pay.holiday)}</b>: public holiday, double time.</p>` : s.pay?.dayType === 'sunday' ? '<p><b>Sunday</b>: double time.</p>' : ''}
<table><tr><th>Job</th><th>Store and fault</th><th>Go</th><th>Arrived</th><th>Left</th><th class=r>Travel</th><th class=r>Work</th><th class=r>Paused</th><th>Result</th></tr>${jobs || '<tr><td colspan=9>No jobs recorded.</td></tr>'}</table>
${x.extras?.length ? `<h3>Office time</h3><table>${x.extras.map(e => `<tr><td>${time(e.start)} to ${time(e.end)}</td><td>${esc(e.label)}${e.note ? `: ${esc(e.note)}` : ''}</td><td class=r>${hm(e.minutes)}</td></tr>`).join('')}</table>` : ''}
${x.trips?.length ? `<h3>Trips with a company vehicle</h3><table>${x.trips.map(tr => `<tr><td${tr.unauthorised ? ' class=bad' : ''}>${time(tr.startedAt)} to ${time(tr.endedAt)} · ${esc(tr.registration)} · ${Math.round(tr.km)} km</td><td>${esc(tr.whyText.join(', '))}${tr.allowed ? ` · allowed by ${esc(tr.allowed.by)}: ${esc(tr.allowed.note)}` : ''}</td></tr>`).join('')}</table>` : ''}
<h3>Flags this day</h3>${flags ? `<ul>${flags}</ul>` : '<p>None.</p>'}${s.submitted?.note ? `<p><b>Technician's note:</b> ${esc(s.submitted.note)}</p>` : ''}
<p class=sign>Technician: ____________________ &nbsp;&nbsp; Manager / HR: ____________________</p></div>${letterheadBottom('<div class=bar></div>')}</section>`;
  })).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Timesheets ${esc(title)}</title><style>
body{font:12px Arial,sans-serif;margin:0;color:#111}section{page-break-after:always}.bar{height:8px;background:#E8701A}.head{background:#111;color:#fff;padding:10px 20px;display:flex;justify-content:space-between;align-items:center}
.head h1{margin:0;font-size:18px}.head .t{color:#E8701A;font-weight:900;font-size:16px}.body{padding:12px 20px}.two{display:flex;justify-content:space-between;gap:16px}
table{width:100%;border-collapse:collapse;margin-top:10px}th{text-align:left;border-top:2px solid #111;border-bottom:1px solid #ccc;padding:4px}td{border-bottom:1px solid #eee;padding:4px;vertical-align:top}.r{text-align:right}
.tot td{font-size:16px;font-weight:bold}.bad{color:#B00020}.sign{margin-top:24px}h3{margin:14px 0 4px}@media print{.noprint{display:none}}</style></head><body>
<p class=noprint style="padding:10px 20px">${esc(title)} · ${d.technicians.reduce((n, t) => n + t.days.length, 0)} timesheets${hide ? ' · performance hidden' : ''} <button onclick="print()">Print / save as PDF</button></p>${d.technicians.length ? summaries : ''}${pages || '<p style="padding:20px">No timesheets.</p>'}</body></html>`;
  try { const w = window.open('', '_blank'); if (!w) return false; w.document.write(html); w.document.close(); return true; } catch { return false; }
}

/** One row per technician per day, for Excel: hours, jobs and flags as text. */
function downloadCsv(d: Export, filename: string): boolean {
  if (Platform.OS !== 'web') return false;
  const q = (x: unknown) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Technician', 'Department', 'Status', 'Started', 'Last job finished', 'Vehicle', 'Travel (h:mm)', 'Work (h:mm)', 'Office (h:mm)', 'Paused (h:mm)', 'Not accounted for (h:mm)', 'Normal time (h:mm)', 'Overtime 1.5x (h:mm)', 'Double time 2x (h:mm)', 'Day', 'Hours invoiced (h:mm)', 'Unauthorised trips', 'Office time', 'Jobs', 'Flags', 'Technician note']];
  for (const t of d.technicians) for (const s of t.days) {
    const x = s.day;
    rows.push([s.date, t.full_name, t.department ?? '', s.submitted ? (s.submitted.filledBy ? `Filled in by ${s.submitted.filledBy}` : 'Submitted') : s.status === 'none' ? 'No work' : 'Not submitted', time(x.start), time(x.end), x.vehicles.join(' '),
      hm(x.travelMin), hm(x.workMin), hm(x.officeMin ?? 0), hm(x.pausedMin), hm(x.unaccountedMin), hm(s.pay?.normalMin ?? 0), hm(s.pay?.overtimeMin ?? 0), hm(s.pay?.doubleMin ?? 0), s.pay?.holiday ?? s.pay?.dayType ?? '', hm(x.invoicedMin ?? 0),
      (x.trips ?? []).filter(tr => tr.unauthorised).map(tr => `${time(tr.startedAt)} ${tr.registration} ${Math.round(tr.km)} km: ${tr.whyText.join(', ')}`).join(' | '),
      (x.extras ?? []).map(e => `${time(e.start)} ${e.label} ${hm(e.minutes)}${e.note ? ` (${e.note})` : ''}`).join(' | '),
      x.jobs.map(j => `Job ${j.jobNumber} ${j.store}: travel ${hm(j.travelMin)}, work ${hm(j.workMin)}, ${j.result}`).join(' | '),
      s.flags.map(f => `${FLAG_TITLE[f.flag_type] ?? f.flag_type} (${flagStatus(f)})`).join(' | '), s.submitted?.note ?? '']);
  }
  try {
    const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    return true;
  } catch { return false; }
}
