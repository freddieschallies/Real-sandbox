// Daily timesheets in a plain format: the day's hours (travel, work, paused, not accounted for),
// every job with its times, the vehicles, and the flags of the day. The technician submits the
// previous day's; HR (and a department manager for his own team) exports them for a day, a week or
// a month, for one person, a department or everyone.
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso } from '../device.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, Screen, Select, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { TITLE as FLAG_TITLE } from '../screens/Flags.tsx';
import { currentLogo } from '../brand.tsx';
import type { Day, Pay } from '../../../server/src/core/timesheet.ts';

export interface SheetFlag { id: string; flag_type: string; question: string | null; explanation: string | null; status: string; resolution_note: string | null }
export interface Sheet { date: string; label: string; weekday?: boolean; submitted: { at: string; note: string | null } | null; day: Day; pay?: Pay; flags: SheetFlag[]; status?: string }
interface Export {
  from: string; to: string; generatedAt: string; rules?: { weekdayNormalMin: number; saturdayNormalMin: number };
  technicians: { id: string; full_name: string; department: string | null; days: Sheet[];
    totals: { travelMin: number; workMin: number; pausedMin: number; unaccountedMin: number; paidMin?: number; normalMin?: number; overtimeMin?: number; doubleMin?: number; jobs: number; flags: number; submitted: number; notSubmitted: number } }[];
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
      {box('Travelled', d.travelMin)}{box('Worked', d.workMin)}{box('Paused', d.pausedMin)}{box('Not accounted for', d.unaccountedMin, d.unaccountedMin >= 30)}
      {pay ? <>{box('Normal time', pay.normalMin)}{box('Overtime 1.5×', pay.overtimeMin)}{box('Double time 2×', pay.doubleMin)}</> : null}
    </View>
  );
}
const dayKind = (p?: Pay) => (!p ? '' : p.holiday ? ` · ${p.holiday} (double time)` : p.dayType === 'sunday' ? ' · Sunday (double time)' : p.dayType === 'saturday' ? ' · Saturday (overtime)' : '');

/** One day's sheet, plain. */
export function SheetView({ s, name }: { s: Sheet; name?: string }) {
  const d = s.day;
  return (
    <View style={{ gap: 10 }} accessibilityLabel={`Timesheet ${name ?? ''} ${s.date}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontSize: 18, fontWeight: '800', flex: 1 }}>{name ? `${name} · ` : ''}{s.label}</Text>
        {s.submitted ? <Pill text="Submitted" tone="good" /> : s.status === 'none' ? <Pill text="No work recorded" tone="quiet" /> : <Pill text="Not submitted" tone="warn" />}
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
      {s.flags.length ? (
        <View style={{ gap: 4 }}>
          <Label>Flags this day ({s.flags.length})</Label>
          {s.flags.map(f => <Text key={f.id} style={st.small}>• {FLAG_TITLE[f.flag_type] ?? f.flag_type.replace(/_/g, ' ')}: {f.question ?? ''} ({flagStatus(f)})</Text>)}
        </View>
      ) : <Text style={st.small}>No flags this day.</Text>}
      {s.submitted?.note ? <Text style={st.small}>Technician's note: {s.submitted.note}</Text> : null}
      {s.submitted ? <Text style={st.small}>Submitted {new Date(s.submitted.at).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</Text> : null}
    </View>
  );
}

// ---- The technician ---------------------------------------------------------------------------

export function useMyTimesheets() {
  const s = useStore();
  const [d, setD] = useState<{ due: (Sheet & { overdue: boolean })[]; recent: Sheet[]; explainFromMin: number } | null>(null);
  const load = async () => { const r = await s.ask({ method: 'GET', path: '/me/timesheets' }); if (r?.status === 200) setD(r.body); };
  useEffect(() => { load(); }, []);
  return { d, load };
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
  const cur = d?.due[0];
  const explain = cur && cur.day.unaccountedMin >= (d?.explainFromMin ?? 30);
  return (
    <Screen title="Timesheet" sub={cur ? `${d!.due.length} day${d!.due.length > 1 ? 's' : ''} to submit` : 'All submitted'} onBack={nav.back}>
      {done ? <Notice tone="good" title="Submitted" lines={[`Your timesheet for ${done} went to HR.`]} /> : null}
      {!d ? <Body quiet>Loading…</Body> : cur ? (
        <>
          <Text style={st.body}>The app made this from your jobs and vehicle scans. Check it and submit it.</Text>
          <Card><SheetView s={{ ...cur, submitted: null }} /></Card>
          {explain ? <Notice tone="warn" title={`${hm(cur.day.unaccountedMin)} not accounted for`} lines={['Say what that time was (e.g. loading the van at the yard, waiting for the store to open).']} /> : null}
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
      {d?.recent.length ? (
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
  const r = rangeOf(period, anchor);
  useEffect(() => {
    s.ask({ method: 'GET', path: '/departments' }).then(x => {
      if (x?.status !== 200) return;
      const b = x.body as { departments: { id: string; name: string }[]; members?: { id: string; full_name: string; login_level: string }[] };
      setPeople([{ value: 'all', label: 'Everyone' }, ...b.departments.map(dp => ({ value: `dept:${dp.id}`, label: `${dp.name} department` })),
        ...(b.members ?? []).filter(m => m.login_level === 'technician').map(m => ({ value: `user:${m.id}`, label: m.full_name }))]);
    });
  }, []);
  useEffect(() => {
    setD(null); setErr(null);
    const q = `from=${r.from}&to=${r.to}${who.startsWith('dept:') ? `&departmentId=${who.slice(5)}` : who.startsWith('user:') ? `&userId=${who.slice(5)}` : ''}`;
    s.ask({ method: 'GET', path: `/timesheets?${q}` }).then(x => { if (x?.status === 200) setD(x.body); else setErr(reasons(x).join('; ')); });
  }, [r.from, r.to, who, tick]);
  const whoLabel = people.find(p => p.value === who)?.label ?? 'Everyone';
  const sheets = d?.technicians.flatMap(t => t.days.map(day => ({ t, day }))) ?? [];
  return (
    <>
      <Choice options={['day', 'week', 'month'] as const} value={period} onChange={setPeriod} labels={{ day: 'Daily', week: 'Weekly', month: 'Monthly' }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Button label="‹" kind="secondary" onPress={() => setAnchor(a => step(period, a, -1))} style={{ width: 56 }} />
        <Text style={[st.body, { fontWeight: '800', flex: 1, textAlign: 'center' }]} accessibilityLabel="Period">{r.label}</Text>
        <Button label="›" kind="secondary" disabled={r.to >= sastToday()} onPress={() => setAnchor(a => step(period, a, 1))} style={{ width: 56 }} />
      </View>
      <Select label="Who" value={who} options={people.length ? people : [{ value: 'all', label: 'Everyone' }]} onChange={setWho} />
      <HoursRules reload={() => setTick(t => t + 1)} />
      {err ? <Notice tone="bad" title="Could not load" lines={[err]} /> : null}
      {!d && !err ? <Body quiet>Loading…</Body> : null}
      {d ? (
        <>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {Platform.OS === 'web' ? <Button label="Print / save as PDF" onPress={() => setMsg(printSheets(d, `${whoLabel} · ${r.label}`, s.session?.company.name ?? '') ? null : 'The browser blocked the print window: allow pop-ups for this site.')} style={{ flexGrow: 1 }} /> : null}
            {Platform.OS === 'web' ? <Button label="Download for Excel (CSV)" kind="secondary" onPress={() => setMsg(downloadCsv(d, `timesheets-${r.from}-to-${r.to}.csv`) ? null : 'This browser could not save the file.')} style={{ flexGrow: 1 }} /> : null}
          </View>
          {msg ? <Notice tone="warn" title="Not exported" lines={[msg]} /> : null}
          <Card>
            <Label>{whoLabel} · {r.label}</Label>
            <View style={{ flexDirection: 'row', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>
              {['Technician', 'Travel', 'Work', 'Normal', 'OT 1.5×', 'DT 2×', 'Not acc.', 'Flags', 'Missing'].map((h, i) => <Text key={h} style={[st.small, { fontWeight: '800', flex: i === 0 ? 2 : 1 }]}>{h}</Text>)}
            </View>
            {d.technicians.map(t => (
              <View key={t.id} style={{ flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }} accessibilityLabel={`Totals ${t.full_name}`}>
                <Text style={[st.body, { flex: 2, fontWeight: '700' }]}>{t.full_name}</Text>
                <Text style={[st.body, { flex: 1 }]}>{hm(t.totals.travelMin)}</Text>
                <Text style={[st.body, { flex: 1 }]}>{hm(t.totals.workMin)}</Text>
                <Text style={[st.body, { flex: 1 }]}>{hm(t.totals.normalMin ?? 0)}</Text>
                <Text style={[st.body, { flex: 1 }]}>{hm(t.totals.overtimeMin ?? 0)}</Text>
                <Text style={[st.body, { flex: 1 }]}>{hm(t.totals.doubleMin ?? 0)}</Text>
                <Text style={[st.body, { flex: 1, color: t.totals.unaccountedMin >= 30 ? C.bad : C.text }]}>{hm(t.totals.unaccountedMin)}</Text>
                <Text style={[st.body, { flex: 1 }]}>{t.totals.flags}</Text>
                <Text style={[st.body, { flex: 1, color: t.totals.notSubmitted ? C.warn : C.text }]}>{t.totals.notSubmitted}</Text>
              </View>
            ))}
            {!d.technicians.length ? <Body quiet>No technicians.</Body> : null}
          </Card>
          <Heading>Timesheets ({sheets.length})</Heading>
          {sheets.map(({ t, day }) => {
            const k = `${t.id}|${day.date}`;
            return (
              <Card key={k} onPress={open === k ? undefined : () => setOpen(k)} accessibilityLabel={`Sheet ${t.full_name} ${day.date}`}>
                {open === k ? <SheetView s={day} name={t.full_name} /> : (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={[st.body, { fontWeight: '700', flex: 1 }]}>{t.full_name} · {day.label}</Text>
                    <Text style={st.small}>W {hm(day.day.workMin)} · T {hm(day.day.travelMin)}{day.pay?.overtimeMin ? ` · OT ${hm(day.pay.overtimeMin)}` : ''}{day.pay?.doubleMin ? ` · DT ${hm(day.pay.doubleMin)}` : ''}{day.day.unaccountedMin ? ` · NA ${hm(day.day.unaccountedMin)}` : ''}{day.flags.length ? ` · ${day.flags.length} flag${day.flags.length > 1 ? 's' : ''}` : ''}</Text>
                    {day.submitted ? <Pill text="Submitted" tone="good" /> : day.status === 'none' ? <Pill text="No work" tone="quiet" /> : <Pill text="Missing" tone="warn" />}
                  </View>
                )}
                {open === k ? <Button label="Close" kind="quiet" onPress={() => setOpen(null)} /> : null}
              </Card>
            );
          })}
        </>
      ) : null}
    </>
  );
}

/** The company's normal hours: overtime after them, double time on Sundays and public holidays. */
function HoursRules({ reload }: { reload: () => void }) {
  const s = useStore();
  const [r, setR] = useState<{ weekdayNormalMin: number; saturdayNormalMin: number; canEdit: boolean } | null>(null);
  const [edit, setEdit] = useState(false);
  const [wk, setWk] = useState('8:00');
  const [sat, setSat] = useState('0:00');
  const [err, setErr] = useState<string[] | null>(null);
  const load = async () => { const x = await s.ask({ method: 'GET', path: '/timesheets/settings' }); if (x?.status === 200) { setR(x.body); setWk(hm(x.body.weekdayNormalMin)); setSat(hm(x.body.saturdayNormalMin)); } };
  useEffect(() => { load(); }, []);
  if (!r) return null;
  const toMin = (v: string) => { const m = v.trim().match(/^(\d{1,2})(?::(\d{2}))?$/); return m ? Number(m[1]) * 60 + Number(m[2] ?? 0) : NaN; };
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.small, { flex: 1 }]}>Normal day {hm(r.weekdayNormalMin)} Mon–Fri{r.saturdayNormalMin ? `, Saturday ${hm(r.saturdayNormalMin)}` : ''}; after that overtime (1.5×){r.saturdayNormalMin ? '' : ', all of Saturday overtime'}; Sundays and public holidays double time (2×). Paid time is travel plus work.</Text>
        {r.canEdit && !edit ? <Pressable onPress={() => setEdit(true)} accessibilityRole="button"><Text style={[st.small, { color: C.info, textDecorationLine: 'underline' }]}>Change</Text></Pressable> : null}
      </View>
      {edit ? (
        <>
          <Field label="Normal hours Monday to Friday (h:mm)" value={wk} onChangeText={setWk} />
          <Field label="Normal hours on Saturday (h:mm, 0:00 = all overtime)" value={sat} onChangeText={setSat} />
          {err ? <Notice tone="bad" title="Not saved" lines={err} /> : null}
          <Button label="Save the hours" onPress={async () => {
            const x = await s.ask({ method: 'PUT', path: '/timesheets/settings', json: { weekdayNormalMin: toMin(wk), saturdayNormalMin: toMin(sat) } });
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
function printSheets(d: Export, title: string, company: string): boolean {
  if (Platform.OS !== 'web') return false;
  const pages = d.technicians.flatMap(t => t.days.map(s => {
    const x = s.day;
    const jobs = x.jobs.map(j => `<tr><td>${j.jobNumber}</td><td>${esc(j.store)}${j.helper ? ' (helping)' : ''}<br><small>${esc(j.fault)}</small></td><td>${time(j.go)}</td><td>${time(j.arrived)}</td><td>${time(j.ended)}</td>
<td class=r>${hm(j.travelMin)}</td><td class=r>${hm(j.workMin)}</td><td class=r>${hm(j.pausedMin)}</td><td>${esc(j.result)}${j.pauses.length ? `<br><small>${esc(j.pauses.map(p => `${p.label} ${hm(p.minutes)}`).join(', '))}</small>` : ''}</td></tr>`).join('');
    const flags = s.flags.map(f => `<li><b>${esc(FLAG_TITLE[f.flag_type] ?? f.flag_type)}</b>: ${esc(f.question)} <i>(${esc(flagStatus(f))})</i></li>`).join('');
    return `<section><div class=bar></div><div class=head>${currentLogo() ? `<img src="${currentLogo()}" style="height:48px;background:#fff;padding:3px;border-radius:4px;margin-right:12px">` : ''}<div style="flex:1"><h1>${esc(company)}</h1><div>Daily timesheet</div></div><div class=t>${esc(s.label)}</div></div>
<div class=body><div class=two><div><b>Technician</b> ${esc(t.full_name)}<br><b>Department</b> ${esc(t.department ?? '–')}</div>
<div><b>Started</b> ${time(x.start)} · <b>Last job finished</b> ${time(x.end)}<br><b>Vehicle</b> ${esc(x.vehicles.join(', ') || '–')}<br><b>Status</b> ${s.submitted ? `Submitted ${esc(new Date(s.submitted.at).toLocaleString('en-ZA'))}` : s.status === 'none' ? 'No work recorded' : 'NOT SUBMITTED'}</div></div>
<table class=tot><tr><th>Travelled</th><th>Worked</th><th>Paused</th><th>Not accounted for</th><th>Normal time</th><th>Overtime 1.5×</th><th>Double time 2×</th></tr><tr><td>${hm(x.travelMin)}</td><td>${hm(x.workMin)}</td><td>${hm(x.pausedMin)}</td><td${x.unaccountedMin >= 30 ? ' class=bad' : ''}>${hm(x.unaccountedMin)}</td><td>${hm(s.pay?.normalMin ?? 0)}</td><td>${hm(s.pay?.overtimeMin ?? 0)}</td><td>${hm(s.pay?.doubleMin ?? 0)}</td></tr></table>${s.pay?.holiday ? `<p><b>${esc(s.pay.holiday)}</b>: public holiday, double time.</p>` : s.pay?.dayType === 'sunday' ? '<p><b>Sunday</b>: double time.</p>' : ''}
<table><tr><th>Job</th><th>Store and fault</th><th>Go</th><th>Arrived</th><th>Left</th><th class=r>Travel</th><th class=r>Work</th><th class=r>Paused</th><th>Result</th></tr>${jobs || '<tr><td colspan=9>No jobs recorded.</td></tr>'}</table>
<h3>Flags this day</h3>${flags ? `<ul>${flags}</ul>` : '<p>None.</p>'}${s.submitted?.note ? `<p><b>Technician's note:</b> ${esc(s.submitted.note)}</p>` : ''}
<p class=sign>Technician: ____________________ &nbsp;&nbsp; Manager / HR: ____________________</p></div><div class=bar></div></section>`;
  })).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Timesheets ${esc(title)}</title><style>
body{font:12px Arial,sans-serif;margin:0;color:#111}section{page-break-after:always}.bar{height:8px;background:#E8701A}.head{background:#111;color:#fff;padding:10px 20px;display:flex;justify-content:space-between;align-items:center}
.head h1{margin:0;font-size:18px}.head .t{color:#E8701A;font-weight:900;font-size:16px}.body{padding:12px 20px}.two{display:flex;justify-content:space-between;gap:16px}
table{width:100%;border-collapse:collapse;margin-top:10px}th{text-align:left;border-top:2px solid #111;border-bottom:1px solid #ccc;padding:4px}td{border-bottom:1px solid #eee;padding:4px;vertical-align:top}.r{text-align:right}
.tot td{font-size:16px;font-weight:bold}.bad{color:#B00020}.sign{margin-top:24px}h3{margin:14px 0 4px}@media print{.noprint{display:none}}</style></head><body>
<p class=noprint style="padding:10px 20px">${esc(title)} · ${d.technicians.reduce((n, t) => n + t.days.length, 0)} timesheets <button onclick="print()">Print / save as PDF</button></p>${pages || '<p style="padding:20px">No timesheets.</p>'}</body></html>`;
  try { const w = window.open('', '_blank'); if (!w) return false; w.document.write(html); w.document.close(); return true; } catch { return false; }
}

/** One row per technician per day, for Excel: hours, jobs and flags as text. */
function downloadCsv(d: Export, filename: string): boolean {
  if (Platform.OS !== 'web') return false;
  const q = (x: unknown) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Technician', 'Department', 'Status', 'Started', 'Last job finished', 'Vehicle', 'Travel (h:mm)', 'Work (h:mm)', 'Paused (h:mm)', 'Not accounted for (h:mm)', 'Normal time (h:mm)', 'Overtime 1.5x (h:mm)', 'Double time 2x (h:mm)', 'Day', 'Jobs', 'Flags', 'Technician note']];
  for (const t of d.technicians) for (const s of t.days) {
    const x = s.day;
    rows.push([s.date, t.full_name, t.department ?? '', s.submitted ? 'Submitted' : s.status === 'none' ? 'No work' : 'Not submitted', time(x.start), time(x.end), x.vehicles.join(' '),
      hm(x.travelMin), hm(x.workMin), hm(x.pausedMin), hm(x.unaccountedMin), hm(s.pay?.normalMin ?? 0), hm(s.pay?.overtimeMin ?? 0), hm(s.pay?.doubleMin ?? 0), s.pay?.holiday ?? s.pay?.dayType ?? '',
      x.jobs.map(j => `Job ${j.jobNumber} ${j.store}: travel ${hm(j.travelMin)}, work ${hm(j.workMin)}, ${j.result}`).join(' | '),
      s.flags.map(f => `${FLAG_TITLE[f.flag_type] ?? f.flag_type} (${flagStatus(f)})`).join(' | '), s.submitted?.note ?? '']);
  }
  try {
    const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    return true;
  } catch { return false; }
}
