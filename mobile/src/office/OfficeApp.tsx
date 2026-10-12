// The office screen (control base), for Admin, Management, Directors and the CEO. Made for a desktop
// browser: menu, list and detail side by side. Works on a phone too, one screen at a time.
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../state.tsx';
import * as J from '../../../server/src/core/jobCard.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, st } from '../ui.tsx';
import { C, S } from '../theme.ts';
import { TITLE as FLAG_TITLE } from '../screens/Flags.tsx';
import type { CardView } from '../types.ts';
import { useOffice, type Answer, type OfficeHook, type OfficeJob } from './useOffice.ts';

const K = { band: '#121212', bandText: '#F7F3EC', stripe: '#E8701A' };
type Tab = 'today' | 'jobs' | 'flags' | 'handovers' | 'people' | 'stores';
type Sel = { kind: 'job'; id: string } | { kind: 'newjob' } | { kind: 'flag'; id: string } | { kind: 'handover'; id: string } | { kind: 'person'; id: string } | { kind: 'newstore' } | null;

const STATUS: Record<string, { text: string; tone: 'info' | 'good' | 'warn' | 'bad' | 'quiet' }> = {
  assigned: { text: 'Assigned', tone: 'quiet' }, in_progress: { text: 'In progress', tone: 'info' }, continue_later: { text: 'Continue later', tone: 'warn' }, closed: { text: 'Closed', tone: 'good' },
};
const TYPE: Record<string, string> = { breakdown: 'Breakdown', planned_maintenance: 'Planned maintenance', installation: 'Installation', quote_visit: 'Quote visit', follow_up: 'Follow-up' };
const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const day = (s: string) => {
  const t = ymd(new Date());
  if (s === t) return 'Today';
  if (s === ymd(new Date(Date.now() + 86_400_000))) return 'Tomorrow';
  if (s === ymd(new Date(Date.now() - 86_400_000))) return 'Yesterday';
  return new Date(`${s}T12:00:00+02:00`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
};
const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const OFFICE_LEVELS = ['admin', 'management', 'director', 'creator'];
export const isOffice = (level?: string) => OFFICE_LEVELS.includes(level ?? '');

export function OfficeApp() {
  const s = useStore();
  const ins = useSafeAreaInsets();
  const wide = useWindowDimensions().width >= 900;
  const o = useOffice();
  const [tab, setTab] = useState<Tab>('today');
  const [sel, setSel] = useState<Sel>(null);
  const ov = o.d.overview;
  const canPeople = !!o.d.people;
  const go = (t: Tab, x: Sel = null) => { setTab(t); setSel(x); };

  const tabs: { key: Tab; label: string; short?: string; count?: number }[] = [
    { key: 'today', label: 'Today' },
    { key: 'jobs', label: 'Jobs', count: ov ? ov.jobs.carried_over + ov.jobs.urgent : undefined },
    { key: 'flags', label: 'Flags', count: ov?.flags?.unresolved },
    { key: 'handovers', label: 'Handovers', short: 'Approve', count: ov?.handoversAwaitingApproval },
    ...(canPeople ? [{ key: 'people' as Tab, label: 'People' }] : []),
    { key: 'stores', label: 'Stores' },
  ];

  const list = (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 40 }}>
      {tab === 'today' ? <TodayView o={o} go={go} /> : null}
      {tab === 'jobs' ? <JobList o={o} open={id => setSel({ kind: 'job', id })} add={() => setSel({ kind: 'newjob' })} selected={sel?.kind === 'job' ? sel.id : null} /> : null}
      {tab === 'flags' ? <FlagList o={o} open={id => setSel({ kind: 'flag', id })} selected={sel?.kind === 'flag' ? sel.id : null} /> : null}
      {tab === 'handovers' ? <HandoverList o={o} open={id => setSel({ kind: 'handover', id })} /> : null}
      {tab === 'people' ? <PeopleList o={o} open={id => setSel({ kind: 'person', id })} /> : null}
      {tab === 'stores' ? <StoreList o={o} add={() => setSel({ kind: 'newstore' })} /> : null}
      {!wide ? <Button label="Sign out" kind="quiet" onPress={s.signOut} /> : null}
      <Text style={st.small}>{o.d.loadedAt ? `Updated ${when(o.d.loadedAt)}` : o.loading ? 'Loading…' : 'Needs signal to load.'}</Text>
    </ScrollView>
  );

  const close = () => setSel(null);
  const detail = (() => {
    if (!sel) return null;
    const wrap = (el: React.ReactNode) => <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60, maxWidth: 820 }}>{el}</ScrollView>;
    if (sel.kind === 'job') return wrap(<JobDetail key={sel.id} id={sel.id} o={o} />);
    if (sel.kind === 'newjob') return wrap(<NewJob o={o} done={id => setSel(id ? { kind: 'job', id } : null)} />);
    if (sel.kind === 'flag') return wrap(<FlagDetail key={sel.id} id={sel.id} o={o} done={close} />);
    if (sel.kind === 'handover') return wrap(<HandoverDetail key={sel.id} id={sel.id} o={o} done={close} />);
    if (sel.kind === 'person') return wrap(<PersonDetail key={sel.id} id={sel.id} o={o} />);
    return wrap(<NewStore o={o} done={close} />);
  })();

  const header = (
    <View style={{ backgroundColor: K.band, paddingTop: ins.top, borderBottomWidth: 4, borderBottomColor: K.stripe }}>
      <View style={{ paddingHorizontal: S.pad, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {!wide && sel ? <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Back" hitSlop={10}><Text style={{ color: K.bandText, fontSize: 34 }}>‹</Text></Pressable> : null}
        <View style={{ flex: 1 }}>
          <Text style={{ color: K.bandText, fontSize: 22, fontWeight: '800' }}>Office</Text>
          <Text style={{ color: K.bandText, opacity: 0.75 }}>{s.session?.user.name} · {s.session?.company.name}</Text>
        </View>
        <Pressable onPress={o.load} accessibilityRole="button" accessibilityLabel="Refresh" hitSlop={8}
          style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: K.bandText }}>
          <Text style={{ color: K.bandText, fontWeight: '700' }}>{o.loading ? '…' : 'Refresh'}</Text>
        </Pressable>
        {wide ? <Pressable onPress={s.signOut} accessibilityRole="button" hitSlop={8}><Text style={{ color: K.bandText }}>Sign out</Text></Pressable> : null}
      </View>
    </View>
  );

  if (wide) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {header}
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ width: 200, borderRightWidth: 1, borderRightColor: C.line, padding: 12, gap: 6 }}>
            {tabs.map(t => (
              <Pressable key={t.key} onPress={() => go(t.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, minHeight: 48, borderRadius: 8, backgroundColor: tab === t.key ? C.panel2 : 'transparent', borderLeftWidth: 3, borderLeftColor: tab === t.key ? K.stripe : 'transparent' }}>
                <Text style={{ color: tab === t.key ? C.text : C.quiet, fontWeight: '700', flex: 1 }}>{t.label}</Text>
                {t.count ? <Pill text={String(t.count)} tone="warn" /> : null}
              </Pressable>
            ))}
          </View>
          <View style={{ width: tab === 'today' ? undefined : 460, flex: tab === 'today' ? 1 : undefined, borderRightWidth: 1, borderRightColor: C.line }}>{list}</View>
          {tab !== 'today' ? <View style={{ flex: 1 }}>{detail ?? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Body quiet>Choose something on the left.</Body></View>}</View> : null}
        </View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {header}
      <View style={{ flex: 1 }}>{detail ?? list}</View>
      {!sel ? (
        <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line, paddingBottom: ins.bottom, backgroundColor: C.panel }}>
          {tabs.map(t => (
            <Pressable key={t.key} onPress={() => go(t.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}
              style={{ flex: 1, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 2, minHeight: 56, borderTopWidth: 3, borderTopColor: tab === t.key ? K.stripe : 'transparent' }}>
              <Text numberOfLines={1} style={{ color: tab === t.key ? C.text : C.quiet, fontWeight: '700', fontSize: 12 }}>{t.short ?? t.label}</Text>
              {t.count ? <Text style={{ color: C.warn, fontWeight: '800' }}>{t.count}</Text> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ---- Today -------------------------------------------------------------------------------------

function Tile({ label, value, sub, tone = 'quiet', onPress }: { label: string; value: string | number; sub?: string; tone?: 'quiet' | 'warn' | 'bad' | 'good'; onPress?: () => void }) {
  const border = tone === 'bad' ? C.bad : tone === 'warn' ? C.warn : tone === 'good' ? C.good : C.line;
  return (
    <Card onPress={onPress} accessibilityLabel={`${label} ${value}`} style={{ flexGrow: 1, flexBasis: 170, borderColor: border, borderWidth: tone === 'quiet' ? 1 : 2 }}>
      <Label>{label}</Label>
      <Text style={{ color: C.text, fontSize: 30, fontWeight: '800' }}>{value}</Text>
      {sub ? <Text style={st.small}>{sub}</Text> : null}
    </Card>
  );
}

function TodayView({ o, go }: { o: OfficeHook; go: (t: Tab, x?: Sel) => void }) {
  const v = o.d.overview;
  if (!v) return <Body quiet>Loading…</Body>;
  const row = { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: S.gap };
  return (
    <>
      <Text style={{ color: C.text, fontSize: 26, fontWeight: '800' }}>{new Date(`${v.date}T12:00:00+02:00`).toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' })}</Text>
      <Heading>Jobs</Heading>
      <View style={row}>
        <Tile label="Open today" value={v.jobs.today} onPress={() => go('jobs')} />
        <Tile label="Being worked on" value={v.jobs.in_progress} />
        <Tile label="Urgent, not closed" value={v.jobs.urgent} tone={v.jobs.urgent ? 'warn' : 'quiet'} onPress={() => go('jobs')} />
        <Tile label="Carried over" value={v.jobs.carried_over} sub="from earlier days" tone={v.jobs.carried_over ? 'warn' : 'quiet'} onPress={() => go('jobs')} />
        <Tile label="Technicians with no work" value={v.technicians.without_work} sub={`of ${v.technicians.active}`} tone={v.technicians.without_work ? 'warn' : 'quiet'} />
      </View>
      <Heading>Needs a decision</Heading>
      <View style={row}>
        {v.flags ? <Tile label="Flags to resolve" value={v.flags.unresolved} sub={`${v.flags.explained} already explained`} tone={v.flags.unresolved ? 'warn' : 'good'} onPress={() => go('flags')} /> : null}
        <Tile label="Handovers to approve" value={v.handoversAwaitingApproval} sub="taken with nobody to sign" tone={v.handoversAwaitingApproval ? 'warn' : 'good'} onPress={() => go('handovers')} />
      </View>
      <Heading>Fleet</Heading>
      <View style={row}>
        <Tile label="Daily checks today" value={`${v.fleet.checked_today} of ${v.fleet.due}`} tone={v.fleet.checked_today >= v.fleet.due ? 'good' : 'warn'} />
        <Tile label="Safety faults open" value={v.fleet.safety_faults} tone={v.fleet.safety_faults ? 'bad' : 'good'} />
        <Tile label="Off the road / workshop" value={v.fleet.off} sub={`${v.fleet.in_service} in service`} />
      </View>
      {v.fleet.missedYesterday.length ? (
        <Notice tone="warn" title={`Daily check missed yesterday: ${v.fleet.missedYesterday.length}`} lines={[v.fleet.missedYesterday.map(x => x.registration).join(', ')]} />
      ) : null}
      <Heading>Stock</Heading>
      <View style={row}>
        <Tile label="Requests to issue" value={v.stock.to_issue} tone={v.stock.to_issue ? 'warn' : 'quiet'} />
        <Tile label="Returns to receive" value={v.stock.to_receive} />
        <Tile label="Workshop below minimum" value={v.stock.workshop_below_min} tone={v.stock.workshop_below_min ? 'warn' : 'good'} />
      </View>
    </>
  );
}

// ---- Jobs ---------------------------------------------------------------------------------------

const FILTERS = ['open', 'today', 'carried', 'closed'] as const;
function JobList({ o, open, add, selected }: { o: OfficeHook; open: (id: string) => void; add: () => void; selected: string | null }) {
  const [f, setF] = useState<(typeof FILTERS)[number]>('open');
  const [q, setQ] = useState('');
  const t = ymd(new Date());
  const jobs = o.d.jobs.filter(j => (f === 'closed' ? j.status === 'closed' : j.status !== 'closed') && (f !== 'today' || j.scheduled_date === t) && (f !== 'carried' || j.scheduled_date < t))
    .filter(j => !q.trim() || `${j.job_number} ${j.store} ${j.fault_reported} ${j.lead_technician}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(b.priority === 'urgent' && b.status !== 'closed') - Number(a.priority === 'urgent' && a.status !== 'closed'));
  return (
    <>
      <Button label="New job" onPress={add} />
      <Choice options={FILTERS} value={f} onChange={setF} labels={{ open: 'All open', today: 'Today', carried: 'Carried over', closed: 'Closed' }} />
      <TextInput value={q} onChangeText={setQ} placeholder="Search number, store, fault, technician" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search jobs" />
      {jobs.map(j => <JobRow key={j.id} j={j} on={selected === j.id} onPress={() => open(j.id)} />)}
      {!jobs.length ? <Body quiet>No jobs here.</Body> : null}
    </>
  );
}

function JobRow({ j, on, onPress }: { j: OfficeJob; on: boolean; onPress: () => void }) {
  const late = j.status !== 'closed' && j.scheduled_date < ymd(new Date());
  return (
    <Card onPress={onPress} accessibilityLabel={`Job ${j.job_number}`} style={[on ? { borderColor: K.stripe, borderWidth: 2 } : {}, j.priority === 'urgent' && j.status !== 'closed' ? { borderLeftWidth: 5, borderLeftColor: C.bad } : {}] as never}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.body, { fontWeight: '800' }]}>#{j.job_number}</Text>
        <Text numberOfLines={1} style={[st.body, { flex: 1 }]}>{j.store}</Text>
        <Pill text={STATUS[j.status]?.text ?? j.status} tone={STATUS[j.status]?.tone ?? 'quiet'} />
      </View>
      <Body numberOfLines={2}>{j.fault_reported}</Body>
      <Text style={[st.small, late ? { color: C.warn } : null]}>{TYPE[j.job_type] ?? j.job_type}{j.priority === 'urgent' ? ' · URGENT' : ''} · {day(j.scheduled_date)}{late ? ' (carried over)' : ''} · {j.lead_technician}</Text>
    </Card>
  );
}

function Reasons({ a }: { a: Answer | null }) {
  if (!a || a.ok) return null;
  return <Notice tone="bad" title="Not yet. Still needed:" lines={a.reasons} />;
}

function NewJob({ o, done }: { o: OfficeHook; done: (id?: string) => void }) {
  const [storeQ, setStoreQ] = useState('');
  const [storeId, setStoreId] = useState<string>();
  const [type, setType] = useState<J.JobType>('breakdown');
  const [priority, setPriority] = useState<'urgent' | 'normal' | 'scheduled'>('normal');
  const [fault, setFault] = useState('');
  const [date, setDate] = useState(ymd(new Date()));
  const [lead, setLead] = useState<string>();
  const [helpers, setHelpers] = useState<string[]>([]);
  const [ref, setRef] = useState('');
  const [steps, setSteps] = useState('');
  const [ans, setAns] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const days = Array.from({ length: 10 }, (_, i) => ymd(new Date(Date.now() + i * 86_400_000)));
  const stores = o.d.stores.filter(s => !storeQ.trim() || `${s.client} ${s.name} ${s.address ?? ''}`.toLowerCase().includes(storeQ.trim().toLowerCase())).slice(0, 8);
  const store = o.d.stores.find(s => s.id === storeId);

  const submit = async () => {
    const missing = [!storeId ? 'which store' : null, fault.trim().length < 3 ? 'what the fault is' : null, !lead ? 'the lead technician' : null,
      type === 'planned_maintenance' && !steps.trim() ? 'the maintenance checklist steps (one per line)' : null].filter(Boolean) as string[];
    if (missing.length) { setAns({ ok: false, reasons: missing }); return; }
    setBusy(true);
    const r = await o.send('POST', '/jobs', {
      jobType: type, priority, storeId, faultReported: fault.trim(), scheduledDate: date, leadTechnicianId: lead, helperIds: helpers,
      ...(ref.trim() ? { clientOrderRef: ref.trim() } : {}), maintenanceSteps: type === 'planned_maintenance' ? steps.split('\n').map(x => x.trim()).filter(Boolean) : [],
    });
    setBusy(false);
    setAns(r);
    if (r.ok) done(r.body.id);
  };

  return (
    <>
      <Heading>New job</Heading>
      <Label>Store</Label>
      {store ? (
        <Card style={{ borderColor: K.stripe }}>
          <Text style={[st.body, { fontWeight: '800' }]}>{store.name}</Text>
          <Text style={st.small}>{store.client}{store.address ? ` · ${store.address}` : ''}{store.open_jobs ? ` · ${store.open_jobs} open job${store.open_jobs > 1 ? 's' : ''} there already` : ''}</Text>
          <Button label="Change store" kind="quiet" onPress={() => setStoreId(undefined)} style={{ minHeight: 40 }} />
        </Card>
      ) : (
        <>
          <TextInput value={storeQ} onChangeText={setStoreQ} placeholder="Search client or store" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search stores" />
          {stores.map(s => (
            <Pressable key={s.id} onPress={() => setStoreId(s.id)} accessibilityRole="button" accessibilityLabel={`Store ${s.name}`}
              style={{ padding: 12, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.panel }}>
              <Text style={[st.body, { fontWeight: '700' }]}>{s.name}</Text>
              <Text style={st.small}>{s.client}{s.address ? ` · ${s.address}` : ''}</Text>
            </Pressable>
          ))}
        </>
      )}
      <Label>Type</Label>
      <Choice options={['breakdown', 'planned_maintenance', 'installation', 'quote_visit', 'follow_up'] as const} value={type} onChange={setType} labels={TYPE} />
      <Label>Priority</Label>
      <Choice options={['urgent', 'normal', 'scheduled'] as const} value={priority} onChange={setPriority} labels={{ urgent: 'Urgent', normal: 'Normal', scheduled: 'Scheduled' }} />
      <Field label="Fault reported by the client" value={fault} onChangeText={setFault} multiline placeholder="e.g. Ice machine not dispensing, bakery" />
      {type === 'planned_maintenance' ? <Field label="Checklist steps (one per line)" value={steps} onChangeText={setSteps} multiline placeholder={'1. Descale steam generator\n2. Check door seals'} /> : null}
      <Field label="Client order number (optional)" value={ref} onChangeText={setRef} autoCapitalize="characters" />
      <Label>Day</Label>
      <Choice options={days} value={date} onChange={setDate} labels={Object.fromEntries(days.map(d => [d, day(d)]))} />
      <Label>Lead technician</Label>
      <TechPicker o={o} value={lead} onChange={id => { setLead(id); setHelpers(h => h.filter(x => x !== id)); }} />
      {lead ? (
        <>
          <Label>Helpers (optional)</Label>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {o.d.techs.filter(t => t.id !== lead).map(t => {
              const on = helpers.includes(t.id);
              return (
                <Pressable key={t.id} onPress={() => setHelpers(h => (on ? h.filter(x => x !== t.id) : [...h, t.id]))} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                  style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, borderWidth: 2, borderColor: on ? C.accent : C.line, backgroundColor: on ? C.panel2 : 'transparent' }}>
                  <Text style={{ color: C.text, fontWeight: '700' }}>{on ? '✓ ' : ''}{t.full_name}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}
      <Text style={st.small}>The technician sees it on his phone straight away. Its first work item is the fault reported.</Text>
      <Reasons a={ans} />
      <Button label="Create job" onPress={submit} busy={busy} />
      <Button label="Cancel" kind="quiet" onPress={() => done()} />
    </>
  );
}

function TechPicker({ o, value, onChange }: { o: OfficeHook; value?: string; onChange: (id: string) => void }) {
  return (
    <View style={{ gap: 8 }}>
      {o.d.techs.map(t => (
        <Pressable key={t.id} onPress={() => onChange(t.id)} accessibilityRole="radio" accessibilityState={{ checked: value === t.id }} accessibilityLabel={`Technician ${t.full_name}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 8, borderWidth: 2, borderColor: value === t.id ? C.accent : C.line }}>
          <Text style={[st.body, { fontWeight: '700', flex: 1 }]}>{t.full_name}</Text>
          <Text style={st.small}>{t.open_jobs} open{t.working_now ? ' · on a job now' : ''}{t.vehicle ? ` · ${t.vehicle}` : ''}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function JobDetail({ id, o }: { id: string; o: OfficeHook }) {
  const [c, setC] = useState<CardView | null>(null);
  const [moving, setMoving] = useState(false);
  const j = o.d.jobs.find(x => x.id === id);
  useEffect(() => { o.card(id).then(setC); }, [id, o.d.loadedAt]);
  if (!j) return <Body quiet>Job not found.</Body>;
  const v = c?.visits.at(-1);
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontSize: 26, fontWeight: '800' }}>Job {j.job_number}</Text>
        <Pill text={STATUS[j.status]?.text ?? j.status} tone={STATUS[j.status]?.tone ?? 'quiet'} />
        {j.priority === 'urgent' ? <Pill text="Urgent" tone="bad" /> : null}
      </View>
      <Card>
        <Text style={[st.body, { fontWeight: '800' }]}>{j.store}</Text>
        {c?.store_address ? <Text style={st.small}>{c.store_address}</Text> : null}
        <Body>{j.fault_reported}</Body>
        <Text style={st.small}>{TYPE[j.job_type]} · {day(j.scheduled_date)} · lead {j.lead_technician}{c?.client_order_ref ? ` · order ${c.client_order_ref}` : ''}</Text>
      </Card>
      {j.status !== 'closed' ? (moving ? <MoveJob j={j} o={o} done={() => setMoving(false)} /> : <Button label="Move to another technician" kind="secondary" onPress={() => setMoving(true)} />) : null}

      <Heading>On site</Heading>
      {c?.visits.length ? c.visits.map((x, i) => (
        <Card key={i}>
          <Text style={[st.body, { fontWeight: '700' }]}>Visit {i + 1}{x.state === 'continue_later' ? ' · continue later' : ''}</Text>
          <Text style={st.small}>
            {x.goAt ? `Left ${when(x.goAt)}` : ''}{x.arrivedAt ? ` · arrived ${when(x.arrivedAt)}` : ''}{x.startedAt ? ` · started ${when(x.startedAt)}` : ''}{x.endedAt ? ` · ended ${when(x.endedAt)}` : ''}
          </Text>
          {x.checkedInManager ? <Text style={st.small}>Store manager: {x.checkedInManager}</Text> : null}
        </Card>
      )) : <Body quiet>Not started yet.</Body>}
      {v ? <Text style={st.small}>Time on the job so far: {c!.jobMinutes} min</Text> : null}

      <Heading>Work items</Heading>
      {c?.items.map(it => (
        <Card key={it.id}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text style={[st.body, { fontWeight: '700', flex: 1 }]}>{it.title}</Text>
            <Pill text={it.status === 'finished' ? 'Finished' : it.status === 'in_progress' ? 'Busy' : 'Not started'} tone={it.status === 'finished' ? 'good' : it.status === 'in_progress' ? 'info' : 'quiet'} />
          </View>
          {it.found ? <Text style={st.small}>Found: {it.found}</Text> : null}
          {it.did ? <Text style={st.small}>Did: {it.did}</Text> : null}
          {it.status === 'in_progress' && it.missing.length ? <Text style={[st.small, { color: C.warn }]}>Still needed: {it.missing.join('; ')}</Text> : null}
        </Card>
      )) ?? <Body quiet>Loading…</Body>}
      {c?.checklist.length ? (
        <>
          <Heading>Checklist</Heading>
          <Card>{c.checklist.map(x => <Text key={x.id} style={st.body}>{x.done ? '✓' : '○'} {x.step}</Text>)}</Card>
        </>
      ) : null}
    </>
  );
}

function MoveJob({ j, o, done }: { j: OfficeJob; o: OfficeHook; done: () => void }) {
  const [lead, setLead] = useState<string | undefined>(j.lead_id);
  const [date, setDate] = useState(j.scheduled_date < ymd(new Date()) ? ymd(new Date()) : j.scheduled_date);
  const [reason, setReason] = useState('');
  const [ans, setAns] = useState<Answer | null>(null);
  const days = Array.from({ length: 10 }, (_, i) => ymd(new Date(Date.now() + i * 86_400_000)));
  return (
    <Card style={{ borderColor: K.stripe }}>
      <Heading>Move job {j.job_number}</Heading>
      <TechPicker o={o} value={lead} onChange={setLead} />
      <Label>Day</Label>
      <Choice options={days} value={date} onChange={setDate} labels={Object.fromEntries(days.map(d => [d, day(d)]))} />
      <Field label="Why does it move?" value={reason} onChangeText={setReason} placeholder="e.g. Thabo is on leave" />
      <Text style={st.small}>Both technicians are told. A job that is being worked on can only move once the technician has pressed Continue later.</Text>
      <Reasons a={ans} />
      <Button label="Move job" onPress={async () => {
        if (!lead || reason.trim().length < 5) { setAns({ ok: false, reasons: [!lead ? 'the technician' : '', reason.trim().length < 5 ? 'why it moves' : ''].filter(Boolean) }); return; }
        const r = await o.send('POST', `/jobs/${j.id}/assign`, { leadTechnicianId: lead, helperIds: (j.helper_ids ?? []).filter(h => h !== lead), scheduledDate: date, reason: reason.trim() });
        setAns(r);
        if (r.ok) done();
      }} />
      <Button label="Cancel" kind="quiet" onPress={done} />
    </Card>
  );
}

// ---- Flags --------------------------------------------------------------------------------------

function FlagList({ o, open, selected }: { o: OfficeHook; open: (id: string) => void; selected: string | null }) {
  const explained = o.d.flags.filter(f => f.status === 'explained');
  const waiting = o.d.flags.filter(f => f.status !== 'explained');
  const row = (f: (typeof o.d.flags)[number]) => (
    <Card key={f.id} onPress={() => open(f.id)} accessibilityLabel={`Flag ${FLAG_TITLE[f.flag_type] ?? f.flag_type}`} style={selected === f.id ? { borderColor: K.stripe, borderWidth: 2 } : undefined}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{FLAG_TITLE[f.flag_type] ?? f.flag_type.replace(/_/g, ' ')}</Text>
        {f.severity === 'high' ? <Pill text="High" tone="bad" /> : null}
      </View>
      <Text style={st.small}>{f.technician ?? 'Nobody'} · {when(f.raised_at)}{f.job_number ? ` · job ${f.job_number}` : ''}</Text>
      {f.question ? <Body numberOfLines={2}>{f.question}</Body> : null}
    </Card>
  );
  return (
    <>
      <Heading>Explained, ready to resolve ({explained.length})</Heading>
      {explained.map(row)}
      {!explained.length ? <Body quiet>None.</Body> : null}
      <Heading>Waiting for an explanation ({waiting.length})</Heading>
      {waiting.map(row)}
      {!waiting.length ? <Body quiet>None.</Body> : null}
    </>
  );
}

function FlagDetail({ id, o, done }: { id: string; o: OfficeHook; done: () => void }) {
  const f = o.d.flags.find(x => x.id === id);
  const [note, setNote] = useState('');
  const [ans, setAns] = useState<Answer | null>(null);
  if (!f) return <Body quiet>Resolved.</Body>;
  return (
    <>
      <Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>{FLAG_TITLE[f.flag_type] ?? f.flag_type.replace(/_/g, ' ')}</Text>
      <Text style={st.small}>{f.technician ?? ''} · raised {when(f.raised_at)}</Text>
      {f.question ? <Card><Label>Question</Label><Body>{f.question}</Body></Card> : null}
      <Card style={{ borderColor: f.explanation ? C.info : C.line }}>
        <Label>Explanation</Label>
        <Body quiet={!f.explanation}>{f.explanation ?? 'Not explained yet.'}</Body>
      </Card>
      <Field label="How was it handled?" value={note} onChangeText={setNote} multiline placeholder="e.g. Spoke to him, contactor added to the job card" />
      <Reasons a={ans} />
      <Button label="Resolve flag" disabled={note.trim().length < 5} onPress={async () => { const r = await o.send('POST', `/flags/${f.id}/resolve`, { note: note.trim() }); setAns(r); if (r.ok) done(); }} />
    </>
  );
}

// ---- Handovers -----------------------------------------------------------------------------------

function HandoverList({ o, open }: { o: OfficeHook; open: (id: string) => void }) {
  return (
    <>
      <Notice tone="info" title="Taken with nobody to sign" lines={['A driver took a vehicle when neither the previous driver nor a supervisor was there. Check the inspection and approve it, or reject it.']} />
      {o.d.handovers.map(h => (
        <Card key={h.id} onPress={() => open(h.id)} accessibilityLabel={`Handover ${h.registration}`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{h.registration}</Text>
            <Pill text="To approve" tone="warn" />
          </View>
          <Text style={st.small}>{h.driver} · {when(h.inspected_at)}{h.previous_driver ? ` · from ${h.previous_driver}` : ''}</Text>
        </Card>
      ))}
      {!o.d.handovers.length ? <Body quiet>Nothing waiting.</Body> : null}
    </>
  );
}

function HandoverDetail({ id, o, done }: { id: string; o: OfficeHook; done: () => void }) {
  const h = o.d.handovers.find(x => x.id === id);
  const [note, setNote] = useState('');
  const [ans, setAns] = useState<Answer | null>(null);
  if (!h) return <Body quiet>Decided.</Body>;
  const decide = async (approve: boolean) => { const r = await o.send('POST', `/vehicles/inspections/${h.id}/decide`, { approve, ...(note.trim() ? { note: note.trim() } : {}) }); setAns(r); if (r.ok) done(); };
  return (
    <>
      <Text style={{ color: C.text, fontSize: 26, fontWeight: '800', letterSpacing: 1 }}>{h.registration}</Text>
      <Card>
        <Text style={st.body}>{h.driver} took it over{h.previous_driver ? ` from ${h.previous_driver}` : ''}, {when(h.inspected_at)}</Text>
        <Text style={st.small}>{h.odometer_km.toLocaleString('en-ZA')} km · fuel {h.fuel_level.replace('_', ' ')}</Text>
      </Card>
      <Card><Label>Why nobody signed</Label><Body>{h.remote_reason ?? '–'}</Body></Card>
      <Card style={{ borderColor: h.new_problems.length ? C.bad : C.line }}>
        <Label>Problems found</Label>
        <Body>{h.problems.length ? h.problems.map(p => p.replace(/_/g, ' ')).join(', ') : 'None'}</Body>
        {h.new_problems.length ? <Text style={[st.small, { color: C.bad }]}>New since the last handover: {h.new_problems.join(', ')}</Text> : null}
      </Card>
      <Field label="Note (needed to reject)" value={note} onChangeText={setNote} />
      <Reasons a={ans} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Approve" onPress={() => decide(true)} style={{ flex: 1 }} />
        <Button label="Reject" kind="danger" onPress={() => decide(false)} style={{ flex: 1 }} />
      </View>
    </>
  );
}

// ---- People (the CEO's positions) -------------------------------------------------------------------

function PeopleList({ o, open }: { o: OfficeHook; open: (id: string) => void }) {
  const p = o.d.people;
  if (!p) return <Body quiet>Only whoever manages access (the CEO) sets positions.</Body>;
  return (
    <>
      <Notice tone="info" title="Positions" lines={["The position decides which app opens on the person's phone and what they may do. Changes apply the next time their app refreshes."]} />
      {p.people.map(x => (
        <Card key={x.id} onPress={() => open(x.id)} accessibilityLabel={`Person ${x.full_name}`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{x.full_name}</Text>
            <Pill text={x.position} tone="quiet" />
          </View>
          {x.does_fleet && x.login_level !== 'mechanic' ? <Text style={[st.small, { color: C.info }]}>Also does the mechanic's work</Text> : null}
        </Card>
      ))}
    </>
  );
}

function PersonDetail({ id, o }: { id: string; o: OfficeHook }) {
  const x = o.d.people?.people.find(p => p.id === id);
  const [pos, setPos] = useState(x?.login_level);
  const [ans, setAns] = useState<Answer | null>(null);
  useEffect(() => { setPos(x?.login_level); }, [x?.login_level]);
  if (!x || !o.d.people) return <Body quiet>Not found.</Body>;
  const labels = Object.fromEntries(o.d.people.positions.map(p => [p.level, p.label]));
  return (
    <>
      <Text style={{ color: C.text, fontSize: 26, fontWeight: '800' }}>{x.full_name}</Text>
      <Text style={st.small}>Now: {x.position}</Text>
      <Label>Position</Label>
      <Choice options={o.d.people.positions.map(p => p.level)} value={pos} onChange={setPos} labels={labels} />
      <Button label="Save position" disabled={!pos || pos === x.login_level} onPress={async () => { const r = await o.send('PUT', `/access/users/${x.id}/position`, { position: pos }); setAns(r.ok ? { ok: true, body: r.body } : r); }} />
      {ans?.ok ? <Notice tone="good" title="Saved" lines={[`${x.full_name} is now ${labels[pos!]}. It is logged and they are told.`]} /> : <Reasons a={ans} />}
      {x.login_level !== 'mechanic' ? (
        <Card style={{ borderColor: x.does_fleet ? C.info : C.line }}>
          <Label>Mechanic's work</Label>
          <Body>{x.does_fleet ? `${x.full_name} also does the mechanic's work (daily checks, faults, fleet job cards, workshop stock).` : 'For a small company with no mechanic of its own: give the fleet work to this person too, keeping their position.'}</Body>
          <Button label={x.does_fleet ? "Take the mechanic's work away" : "Also give the mechanic's work"} kind="secondary"
            onPress={async () => { const r = await o.send('PUT', `/access/users/${x.id}/fleet-duty`, { on: !x.does_fleet }); setAns(r.ok ? null : r); }} />
        </Card>
      ) : null}
    </>
  );
}

// ---- Stores ------------------------------------------------------------------------------------

function StoreList({ o, add }: { o: OfficeHook; add: () => void }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => o.d.stores.filter(s => !q.trim() || `${s.client} ${s.name} ${s.address ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())), [o.d.stores, q]);
  return (
    <>
      <Button label="Add a store" kind="secondary" onPress={add} />
      <TextInput value={q} onChangeText={setQ} placeholder="Search client or store" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search stores" />
      {list.map(s => (
        <Card key={s.id}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{s.name}</Text>
            {s.open_jobs ? <Pill text={`${s.open_jobs} open`} tone="info" /> : null}
          </View>
          <Text style={st.small}>{s.client}{s.address ? ` · ${s.address}` : ''} · {s.lat.toFixed(4)}, {s.lng.toFixed(4)}</Text>
        </Card>
      ))}
    </>
  );
}

function NewStore({ o, done }: { o: OfficeHook; done: () => void }) {
  const [client, setClient] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [where, setWhere] = useState('');
  const [ans, setAns] = useState<Answer | null>(null);
  // Paste straight from Google Maps: "-28.7465, 32.0584".
  const m = where.match(/(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)/);
  const lat = m ? Number(m[1]) : null;
  const lng = m ? Number(m[2]) : null;
  const clients = [...new Set(o.d.stores.map(s => s.client))];
  return (
    <>
      <Heading>Add a store</Heading>
      <Field label="Client" value={client} onChangeText={setClient} placeholder="e.g. Spar" autoCapitalize="words" />
      {clients.length ? <Choice options={clients} value={clients.find(c => c === client)} onChange={setClient} /> : null}
      <Field label="Store name" value={name} onChangeText={setName} placeholder="e.g. Spar Arboretum" autoCapitalize="words" />
      <Field label="Address" value={address} onChangeText={setAddress} />
      <Field label="Where it is (paste from Google Maps)" value={where} onChangeText={setWhere} placeholder="-28.7465, 32.0584"
        hint={lat != null ? `Latitude ${lat}, longitude ${lng}. The technician's Arrived only works within 150 m of this point.` : 'Right-click the store in Google Maps and click the numbers to copy them.'} />
      <Reasons a={ans} />
      <Button label="Add store" onPress={async () => {
        if (lat == null || lng == null) { setAns({ ok: false, reasons: ['where the store is (latitude, longitude)'] }); return; }
        const r = await o.send('POST', '/office/stores', { client: client.trim(), name: name.trim(), ...(address.trim() ? { address: address.trim() } : {}), lat, lng });
        setAns(r);
        if (r.ok) done();
      }} />
      <Button label="Cancel" kind="quiet" onPress={done} />
    </>
  );
}
