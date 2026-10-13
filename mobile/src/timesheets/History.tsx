// One person's timesheets all the way back (month by month, any previous day opens in full), and
// the log of them: submitted, filled in by the CEO, flagged as missing, explained, closed, and who
// looked at them. HR and the CEO see everyone's, also people who have left.
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Heading, Label, Notice, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { SheetView, hm, type Sheet } from './Timesheet.tsx';

interface HDay { date: string; label: string; status: 'submitted' | 'filled' | 'missing' | 'none'; submittedAt: string | null; filledBy: string | null; travelMin: number; workMin: number; unaccountedMin: number; normalMin: number; overtimeMin: number; doubleMin: number; flags: number }
interface HMonth { month: string; label: string; days: HDay[]; totals: { travelMin: number; workMin: number; unaccountedMin: number; normalMin: number; overtimeMin: number; doubleMin: number; submitted: number; filled: number; missing: number } }
interface History { person: { id: string; full_name: string; left: boolean; left_on: string | null; since: string }; months: HMonth[]; older: string | null }
interface LogEvent { at: string; kind: string; text: string; by: string }

const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['no signal: try again'];
const PILL: Record<HDay['status'], { text: string; tone: 'good' | 'info' | 'warn' | 'quiet' }> = {
  submitted: { text: 'Submitted', tone: 'good' }, filled: { text: 'Filled in by the CEO', tone: 'info' }, missing: { text: 'Missing', tone: 'warn' }, none: { text: 'No work', tone: 'quiet' },
};

/** Every timesheet of one person, newest first, three months at a time. */
export function PersonHistory({ userId, name }: { userId: string; name: string }) {
  const s = useStore();
  const [months, setMonths] = useState<HMonth[]>([]);
  const [info, setInfo] = useState<History['person'] | null>(null);
  const [older, setOlder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const load = async (before?: string) => {
    setBusy(true); setErr(null);
    const r = await s.ask({ method: 'GET', path: `/timesheets/person/${userId}/history${before ? `?before=${before}` : ''}` });
    setBusy(false);
    if (r?.status !== 200) { setErr(reasons(r).join('; ')); return; }
    const h = r.body as History;
    setInfo(h.person); setOlder(h.older);
    setMonths(m => (before ? [...m, ...h.months] : h.months));
  };
  useEffect(() => { setMonths([]); setOpen(null); load(); }, [userId]);
  const openDay = async (date: string) => {
    if (open === date) { setOpen(null); return; }
    setOpen(date); setSheet(null);
    const r = await s.ask({ method: 'GET', path: `/timesheets?from=${date}&to=${date}&userId=${userId}` });
    const day = (r?.body as { technicians?: { days: Sheet[] }[] })?.technicians?.[0]?.days.find(x => x.date === date);
    if (day) setSheet(day); else setErr(r?.status === 200 ? 'Nothing recorded that day.' : reasons(r).join('; '));
  };
  return (
    <View style={{ gap: 10 }}>
      <Heading>{name}: every timesheet</Heading>
      {info ? <Text style={st.small}>Since {info.since}{info.left ? ` · left ${info.left_on ?? ''}` : ''}. Tap a day to open the full sheet.</Text> : null}
      {err ? <Notice tone="bad" title="Could not load" lines={[err]} /> : null}
      {months.map(m => (
        <Card key={m.month}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{m.label}</Text>
            <Text style={st.small}>{m.totals.submitted} submitted{m.totals.filled ? ` · ${m.totals.filled} filled in` : ''}{m.totals.missing ? ` · ${m.totals.missing} missing` : ''}</Text>
          </View>
          <Text style={st.small}>Work {hm(m.totals.workMin)} · Travel {hm(m.totals.travelMin)} · Normal {hm(m.totals.normalMin)} · OT {hm(m.totals.overtimeMin)} · DT {hm(m.totals.doubleMin)}{m.totals.unaccountedMin ? ` · Not accounted ${hm(m.totals.unaccountedMin)}` : ''}</Text>
          {!m.days.length ? <Body quiet>Nothing this month.</Body> : null}
          {m.days.map(d => (
            <View key={d.date} style={{ borderTopWidth: 1, borderTopColor: C.line }}>
              <Pressable onPress={() => openDay(d.date)} accessibilityRole="button" accessibilityLabel={`Timesheet ${d.date}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
                <Text style={[st.body, { width: 110, fontWeight: open === d.date ? '800' : '600' }]}>{d.label}</Text>
                <Text style={[st.small, { flex: 1 }]} numberOfLines={1}>W {hm(d.workMin)} · T {hm(d.travelMin)}{d.overtimeMin ? ` · OT ${hm(d.overtimeMin)}` : ''}{d.doubleMin ? ` · DT ${hm(d.doubleMin)}` : ''}{d.unaccountedMin ? ` · NA ${hm(d.unaccountedMin)}` : ''}{d.flags ? ` · ${d.flags} flag${d.flags > 1 ? 's' : ''}` : ''}</Text>
                <Pill text={PILL[d.status].text} tone={PILL[d.status].tone} />
              </Pressable>
              {open === d.date ? (sheet && sheet.date === d.date ? <View style={{ paddingBottom: 10 }}><SheetView s={sheet} name={name} /></View> : <Body quiet>Loading…</Body>) : null}
            </View>
          ))}
        </Card>
      ))}
      {busy ? <Body quiet>Loading…</Body> : null}
      {older && !busy ? <Button label="Older months" kind="secondary" onPress={() => load(older)} /> : null}
      {!older && months.length && !busy ? <Text style={st.small}>That is everything since {info?.since}.</Text> : null}
    </View>
  );
}

const KIND: Record<string, { label: string; color: () => string }> = {
  submitted: { label: 'Submitted', color: () => C.good }, filled: { label: 'Filled in', color: () => C.accent }, missing: { label: 'Missing', color: () => C.warn },
  explained: { label: 'Explained', color: () => C.text }, resolved: { label: 'Closed', color: () => C.good }, viewed: { label: 'Viewed', color: () => C.quiet },
};

/** The log of one person's timesheets (HR and the CEO). */
export function PersonLog({ userId, name }: { userId: string; name: string }) {
  const s = useStore();
  const [ev, setEv] = useState<LogEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [only, setOnly] = useState<'all' | 'changes'>('changes');
  useEffect(() => {
    setEv(null); setErr(null);
    s.ask({ method: 'GET', path: `/timesheets/person/${userId}/log` }).then(r => { if (r?.status === 200) setEv((r.body as { events: LogEvent[] }).events); else setErr(reasons(r).join('; ')); });
  }, [userId]);
  const list = (ev ?? []).filter(e => only === 'all' || e.kind !== 'viewed');
  return (
    <View style={{ gap: 10 }}>
      <Heading>{name}: timesheet log</Heading>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label="Submissions and flags" kind={only === 'changes' ? 'primary' : 'secondary'} onPress={() => setOnly('changes')} style={{ flex: 1 }} />
        <Button label="Everything, with who looked" kind={only === 'all' ? 'primary' : 'secondary'} onPress={() => setOnly('all')} style={{ flex: 1 }} />
      </View>
      {err ? <Notice tone="bad" title="Could not load" lines={[err]} /> : null}
      {!ev && !err ? <Body quiet>Loading…</Body> : null}
      {ev && !list.length ? <Body quiet>Nothing yet.</Body> : null}
      {list.length ? (
        <Card>
          {list.map((e, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 10, paddingVertical: 6, borderTopWidth: i ? 1 : 0, borderTopColor: C.line }}>
              <Text style={[st.small, { width: 120 }]}>{new Date(e.at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[st.small, { fontWeight: '800', color: (KIND[e.kind] ?? KIND.viewed).color() }]}>{(KIND[e.kind] ?? KIND.viewed).label} · {e.by}</Text>
                <Text style={st.body}>{e.text}</Text>
              </View>
            </View>
          ))}
        </Card>
      ) : null}
      <Label>Kept for good: nothing on this log can be changed or deleted.</Label>
    </View>
  );
}
