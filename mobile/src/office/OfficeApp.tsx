// The office screen (control base), for Admin, Management, Directors and the CEO. Made for a desktop
// browser: menu, list and detail side by side. Works on a phone too, one screen at a time.
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../state.tsx';
import * as J from '../../../server/src/core/jobCard.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, Select, st } from '../ui.tsx';
import { C, S } from '../theme.ts';
import { TITLE as FLAG_TITLE } from '../screens/Flags.tsx';
import type { CardView } from '../types.ts';
import { KitCard, StaffRecord } from '../staff/Staff.tsx';
import { DepartmentCard, VanCard, VanLists } from '../vanstock/VanStock.tsx';
import { TeamMap } from '../team/TeamMap.tsx';
import { DepartmentsBoard } from '../hr/Departments.tsx';
import { Avatar, ProfileDetails, ProfileTop, useProfile } from './Profile.tsx';
import { Accounts, InvoiceDetail, InvoiceList, NewQuote, QuoteDetail, QuoteList, useBooks } from './Books.tsx';
import { NewQuery, QueryList, QueryThread, useQueries } from '../queries/Queries.tsx';
import { useOffice, type Answer, type JobChange, type OfficeHook, type OfficeJob } from './useOffice.ts';

const K = { band: '#121212', bandText: '#F7F3EC', stripe: '#E8701A' };
type Tab = 'today' | 'jobs' | 'queries' | 'quotes' | 'invoices' | 'accounts' | 'flags' | 'handovers' | 'map' | 'vans' | 'departments' | 'people' | 'stores';
type Sel = { kind: 'job'; id: string } | { kind: 'newjob' } | { kind: 'flag'; id: string } | { kind: 'handover'; id: string } | { kind: 'person'; id: string } | { kind: 'newstore' } | { kind: 'query'; id: string } | { kind: 'newquery'; toId?: string } | { kind: 'quote'; id: string } | { kind: 'newquote' } | { kind: 'invoice'; id: string } | { kind: 'van'; id: string } | null;

const STATUS: Record<string, { text: string; tone: 'info' | 'good' | 'warn' | 'bad' | 'quiet' }> = {
  cancelled: { text: 'Cancelled', tone: 'quiet' }, assigned: { text: 'Assigned', tone: 'quiet' }, in_progress: { text: 'In progress', tone: 'info' }, continue_later: { text: 'Continue later', tone: 'warn' }, closed: { text: 'Closed', tone: 'good' },
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
const OFFICE_LEVELS = ['admin', 'management', 'hr', 'director', 'creator'];
export const isOffice = (level?: string) => OFFICE_LEVELS.includes(level ?? '');

export function OfficeApp() {
  const s = useStore();
  const ins = useSafeAreaInsets();
  const wide = useWindowDimensions().width >= 900;
  const o = useOffice();
  const qs = useQueries();
  const books = useBooks();
  // Each person sees only the work the CEO switched on for them.
  const work0 = s.session?.user.work ?? {};
  const jobsSide = s.session?.user.level === 'creator' || !!work0.jobs;
  const [tab, setTab] = useState<Tab>(jobsSide ? 'today' : 'departments');
  const [sel, setSel] = useState<Sel>(null);
  const ov = o.d.overview;
  const canPeople = !!o.d.people;
  const go = (t: Tab, x: Sel = null) => { setTab(t); setSel(x); };
  // Each person sees only the work the CEO switched on for them.
  const work = s.session?.user.work ?? {};
  const does = (a: string) => s.session?.user.level === 'creator' || !!work[a];

  const tabs: { key: Tab; label: string; short?: string; count?: number }[] = [
    ...(jobsSide ? [
      { key: 'today' as Tab, label: 'Today' },
      { key: 'jobs' as Tab, label: 'Jobs', count: ov ? ov.jobs.carried_over + ov.jobs.urgent : undefined },
    ] : []),
    ...(does('jobs') ? [{ key: 'queries' as Tab, label: 'Queries', count: qs.unread }] : []),
    ...(does('documents') ? [
      { key: 'quotes' as Tab, label: 'Quotes', count: books.quotes.filter(q => q.status === 'draft').length || undefined },
      { key: 'invoices' as Tab, label: 'Invoices', count: books.toInvoice.length || undefined },
      { key: 'accounts' as Tab, label: 'Accounts', short: 'Pastel' },
    ] : []),
    ...(does('flags') ? [
      { key: 'flags' as Tab, label: 'Flags', count: ov?.flags?.unresolved },
      { key: 'handovers' as Tab, label: 'Handovers', short: 'Approve', count: ov?.handoversAwaitingApproval },
    ] : []),
    ...(does('flags') || s.session?.user.level === 'management' ? [{ key: 'map' as Tab, label: 'Team map', short: 'Map' }] : []),
    ...(does('vanstock') ? [{ key: 'vans' as Tab, label: 'Van stock', short: 'Vans' }] : []),
    ...(does('hr') ? [{ key: 'departments' as Tab, label: 'Departments' }] : []),
    ...(canPeople ? [{ key: 'people' as Tab, label: 'People' }] : []),
    ...(jobsSide ? [{ key: 'stores' as Tab, label: 'Stores' }] : []),
  ];

  const list = (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 40 }}>
      {tab === 'today' ? <TodayView o={o} go={go} flags={does('flags')} /> : null}
      {tab === 'jobs' ? <JobList o={o} open={id => setSel({ kind: 'job', id })} add={does('jobs') ? () => setSel({ kind: 'newjob' }) : undefined} selected={sel?.kind === 'job' ? sel.id : null} /> : null}
      {tab === 'queries' ? <QueryList q={qs} open={id => setSel({ kind: 'query', id })} ask={() => setSel({ kind: 'newquery' })} /> : null}
      {tab === 'quotes' ? <QuoteList b={books} open={id => setSel({ kind: 'quote', id })} add={() => setSel({ kind: 'newquote' })} /> : null}
      {tab === 'invoices' ? <InvoiceList b={books} open={id => setSel({ kind: 'invoice', id })} /> : null}
      {tab === 'accounts' ? <Accounts b={books} canPrices={does('prices')} /> : null}
      {tab === 'flags' ? <FlagList o={o} open={id => setSel({ kind: 'flag', id })} selected={sel?.kind === 'flag' ? sel.id : null} /> : null}
      {tab === 'handovers' ? <HandoverList o={o} open={id => setSel({ kind: 'handover', id })} /> : null}
      {tab === 'map' ? <TeamMap openPerson={canPeople ? id => { setTab('people'); setSel({ kind: 'person', id }); } : undefined} /> : null}
      {tab === 'departments' ? <DepartmentsBoard openPerson={canPeople ? id => { setTab('people'); setSel({ kind: 'person', id }); } : undefined} /> : null}
      {tab === 'vans' ? <VanLists openTech={id => setSel({ kind: 'van', id })} /> : null}
      {tab === 'people' ? <PeopleList o={o} open={id => setSel({ kind: 'person', id })} /> : null}
      {tab === 'stores' ? <StoreList o={o} add={does('stores') ? () => setSel({ kind: 'newstore' }) : undefined} /> : null}
      {!wide ? <Button label="Sign out" kind="quiet" onPress={s.signOut} /> : null}
      <Text style={st.small}>{o.d.loadedAt ? `Updated ${when(o.d.loadedAt)}` : o.loading ? 'Loading…' : 'Needs signal to load.'}</Text>
    </ScrollView>
  );

  const close = () => setSel(null);
  const detail = (() => {
    if (!sel) return null;
    const wrap = (el: React.ReactNode) => <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60, maxWidth: 820 }}>{el}</ScrollView>;
    if (sel.kind === 'job') return wrap(<JobDetail key={sel.id} id={sel.id} o={o} canEdit={does('jobs')} />);
    if (sel.kind === 'newjob') return wrap(<NewJob o={o} done={id => setSel(id ? { kind: 'job', id } : null)} />);
    if (sel.kind === 'query') return wrap(<QueryThread key={sel.id} q={qs} id={sel.id} />);
    if (sel.kind === 'newquery') return wrap(<NewQuery key={sel.toId ?? 'new'} q={qs} toId={sel.toId} jobs={o.d.jobs.filter(j => j.status !== 'closed' && j.status !== 'cancelled').map(j => ({ id: j.id, label: `#${j.job_number} ${j.store}` }))} done={() => setSel(null)} />);
    if (sel.kind === 'quote') return wrap(<QuoteDetail key={sel.id} b={books} id={sel.id} techs={o.d.techs} />);
    if (sel.kind === 'newquote') return wrap(<NewQuote b={books} stores={o.d.stores} jobs={o.d.jobs.filter(j => j.status !== 'closed' && j.status !== 'cancelled').map(j => ({ id: j.id, label: `#${j.job_number} ${j.store}` }))}
      done={id => setSel(id ? { kind: 'quote', id } : null)} />);
    if (sel.kind === 'invoice') return wrap(<InvoiceDetail key={sel.id} b={books} id={sel.id} />);
    if (sel.kind === 'flag') return wrap(<FlagDetail key={sel.id} id={sel.id} o={o} done={close} />);
    if (sel.kind === 'handover') return wrap(<HandoverDetail key={sel.id} id={sel.id} o={o} done={close} />);
    if (sel.kind === 'van') return wrap(<><Heading>{o.d.people?.people.find(y => y.id === sel.id)?.full_name ?? 'Van'}</Heading><VanCard key={sel.id} userId={sel.id} /></>);
    if (sel.kind === 'person') return wrap(<PersonDetail key={sel.id} id={sel.id} o={o} ask={does('jobs') ? toId => setSel({ kind: 'newquery', toId }) : undefined} />);
    return wrap(<NewStore o={o} done={close} />);
  })();

  const header = (
    <View style={{ backgroundColor: K.band, paddingTop: ins.top, borderBottomWidth: 4, borderBottomColor: K.stripe }}>
      <View style={{ paddingHorizontal: S.pad, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {!wide && sel ? <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Back" hitSlop={10}><Text style={{ color: K.bandText, fontSize: 34 }}>‹</Text></Pressable> : null}
        <View style={{ flex: 1 }}>
          <Text style={{ color: K.bandText, fontSize: 22, fontWeight: '800' }}>Office</Text>
          <Text style={{ color: K.bandText, opacity: 0.75 }}>{s.session?.user.name} · {s.session?.user.level === 'creator' ? 'CEO' : s.session?.user.level === 'admin' ? 'Admin' : s.session?.user.level === 'director' ? 'Director' : s.session?.user.level === 'hr' ? 'HR' : 'Department manager'} · {s.session?.company.name}</Text>
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
          <View style={{ width: tab === 'today' || tab === 'accounts' || tab === 'map' || tab === 'departments' ? undefined : 460, flex: tab === 'today' || tab === 'accounts' || tab === 'map' || tab === 'departments' ? 1 : undefined, borderRightWidth: 1, borderRightColor: C.line }}>{list}</View>
          {tab !== 'today' && tab !== 'accounts' && tab !== 'map' && tab !== 'departments' ? <View style={{ flex: 1 }}>{detail ?? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Body quiet>Choose something on the left.</Body></View>}</View> : null}
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

function TodayView({ o, go, flags }: { o: OfficeHook; go: (t: Tab, x?: Sel) => void; flags: boolean }) {
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
      {flags ? <Heading>Needs a decision</Heading> : null}
      {flags ? <View style={row}>
        {v.flags ? <Tile label="Flags to resolve" value={v.flags.unresolved} sub={`${v.flags.explained} already explained`} tone={v.flags.unresolved ? 'warn' : 'good'} onPress={() => go('flags')} /> : null}
        <Tile label="Handovers to approve" value={v.handoversAwaitingApproval} sub="taken with nobody to sign" tone={v.handoversAwaitingApproval ? 'warn' : 'good'} onPress={() => go('handovers')} />
      </View> : null}
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
function JobList({ o, open, add, selected }: { o: OfficeHook; open: (id: string) => void; add?: () => void; selected: string | null }) {
  const [f, setF] = useState<(typeof FILTERS)[number]>('open');
  const [q, setQ] = useState('');
  const t = ymd(new Date());
  const shut = (st: string) => st === 'closed' || st === 'cancelled';
  const jobs = o.d.jobs.filter(j => (f === 'closed' ? shut(j.status) : !shut(j.status)) && (f !== 'today' || j.scheduled_date === t) && (f !== 'carried' || j.scheduled_date < t))
    .filter(j => !q.trim() || `${j.job_number} ${j.store} ${j.fault_reported} ${j.lead_technician}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(b.priority === 'urgent' && b.status !== 'closed') - Number(a.priority === 'urgent' && a.status !== 'closed'));
  return (
    <>
      {add ? <Button label="New job" onPress={add} /> : null}
      <Choice options={FILTERS} value={f} onChange={setF} labels={{ open: 'All open', today: 'Today', carried: 'Carried over', closed: 'Closed / cancelled' }} />
      <TextInput value={q} onChangeText={setQ} placeholder="Search number, store, fault, technician" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search jobs" />
      {jobs.map(j => <JobRow key={j.id} j={j} on={selected === j.id} onPress={() => open(j.id)} />)}
      {!jobs.length ? <Body quiet>No jobs here.</Body> : null}
    </>
  );
}

function JobRow({ j, on, onPress }: { j: OfficeJob; on: boolean; onPress: () => void }) {
  const late = j.status !== 'closed' && j.status !== 'cancelled' && j.scheduled_date < ymd(new Date());
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

function JobDetail({ id, o, canEdit }: { id: string; o: OfficeHook; canEdit: boolean }) {
  const [c, setC] = useState<CardView | null>(null);
  const [moving, setMoving] = useState(false);
  const [panel, setPanel] = useState<'none' | 'edit' | 'cancel'>('none');
  const [hist, setHist] = useState<JobChange[]>([]);
  const j = o.d.jobs.find(x => x.id === id);
  useEffect(() => { o.card(id).then(setC); o.changes(id).then(h => setHist(h ?? [])); }, [id, o.d.loadedAt]);
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
      {canEdit && j.status !== 'cancelled' ? (
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          <Button label="Edit job" kind="secondary" onPress={() => { setPanel(panel === 'edit' ? 'none' : 'edit'); setMoving(false); }} style={{ flexGrow: 1, flexBasis: 150 }} />
          {j.status !== 'closed' ? <Button label="Move" kind="secondary" onPress={() => { setMoving(!moving); setPanel('none'); }} style={{ flexGrow: 1, flexBasis: 150 }} /> : null}
          {j.status !== 'closed' ? <Button label="Cancel job" kind="secondary" onPress={() => { setPanel(panel === 'cancel' ? 'none' : 'cancel'); setMoving(false); }} style={{ flexGrow: 1, flexBasis: 150 }} /> : null}
        </View>
      ) : null}
      {moving ? <MoveJob j={j} o={o} done={() => setMoving(false)} /> : null}
      {panel === 'edit' && c ? <EditJob j={j} c={c} o={o} started={c.visits.length > 0} done={() => setPanel('none')} /> : null}
      {panel === 'cancel' ? <CancelJob j={j} o={o} done={() => setPanel('none')} /> : null}
      {j.status === 'cancelled' ? <Notice tone="warn" title="Cancelled" lines={[hist.find(h => h.field === 'status')?.reason ?? 'Cancelled by the office.']} /> : null}

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
      {hist.length ? (
        <>
          <Heading>Changes by the office</Heading>
          <Card>
            {hist.map((h, i) => (
              <View key={i} style={{ paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <Text style={st.body}><Text style={{ fontWeight: '700' }}>{h.field}</Text>: {h.old_value ?? '–'} → {h.new_value ?? '–'}</Text>
                <Text style={st.small}>{when(h.changed_at)} · {h.by}{h.reason ? ` · ${h.reason}` : ''}</Text>
              </View>
            ))}
          </Card>
        </>
      ) : null}
    </>
  );
}

function EditJob({ j, c, o, started, done }: { j: OfficeJob; c: CardView; o: OfficeHook; started: boolean; done: () => void }) {
  const closed = j.status === 'closed';
  const [type, setType] = useState<J.JobType>(j.job_type as J.JobType);
  const [priority, setPriority] = useState(j.priority as 'urgent' | 'normal' | 'scheduled');
  const [storeId, setStoreId] = useState(c.store_id);
  const [fault, setFault] = useState(j.fault_reported);
  const [ref, setRef] = useState(c.client_order_ref ?? '');
  const [date, setDate] = useState(j.scheduled_date);
  const [steps, setSteps] = useState('');
  const [reason, setReason] = useState('');
  const [ans, setAns] = useState<Answer | null>(null);
  const days = [...new Set([j.scheduled_date, ...Array.from({ length: 14 }, (_, i) => ymd(new Date(Date.now() + i * 86_400_000)))])].sort();
  const save = async () => {
    const body: Record<string, unknown> = closed ? { clientOrderRef: ref.trim() || null } : {
      jobType: type, priority, storeId, faultReported: fault.trim(), clientOrderRef: ref.trim() || null, scheduledDate: date,
      ...(steps.trim() ? { addMaintenanceSteps: steps.split('\n').map(x => x.trim()).filter(Boolean) } : {}),
    };
    if (reason.trim()) body.reason = reason.trim();
    const r = await o.send('PATCH', `/jobs/${j.id}`, body);
    setAns(r);
    if (r.ok) done();
  };
  return (
    <Card style={{ borderColor: K.stripe }}>
      <Heading>Edit job {j.job_number}</Heading>
      {closed ? <Text style={st.small}>The job is closed: only the client's order number can still be added.</Text> : null}
      {!closed ? (
        <>
          {!started ? (
            <>
              <Label>Type</Label>
              <Choice options={['breakdown', 'planned_maintenance', 'installation', 'quote_visit', 'follow_up'] as const} value={type} onChange={setType} labels={TYPE} />
              <Label>Store</Label>
              <Choice options={o.d.stores.map(x => x.id)} value={storeId} onChange={setStoreId} labels={Object.fromEntries(o.d.stores.map(x => [x.id, x.name]))} />
            </>
          ) : <Text style={st.small}>The technician has been on site: the store and type cannot change.</Text>}
          <Label>Priority</Label>
          <Choice options={['urgent', 'normal', 'scheduled'] as const} value={priority} onChange={setPriority} labels={{ urgent: 'Urgent', normal: 'Normal', scheduled: 'Scheduled' }} />
          <Field label="Fault reported by the client" value={fault} onChangeText={setFault} multiline />
          <Label>Day</Label>
          <Choice options={days} value={date} onChange={setDate} labels={Object.fromEntries(days.map(d => [d, day(d)]))} />
          {type === 'planned_maintenance' ? <Field label="Add checklist steps (one per line)" value={steps} onChangeText={setSteps} multiline /> : null}
        </>
      ) : null}
      <Field label="Client order number" value={ref} onChangeText={setRef} autoCapitalize="characters" />
      <Field label={started && !closed ? 'Why does it change? (needed: work has started)' : 'Why does it change? (optional)'} value={reason} onChangeText={setReason} />
      <Text style={st.small}>Every change is written on the job and the technician is told.</Text>
      <Reasons a={ans} />
      <Button label="Save changes" onPress={save} />
      <Button label="Cancel" kind="quiet" onPress={done} />
    </Card>
  );
}

function CancelJob({ j, o, done }: { j: OfficeJob; o: OfficeHook; done: () => void }) {
  const [note, setNote] = useState('');
  const [ans, setAns] = useState<Answer | null>(null);
  return (
    <Card style={{ borderColor: C.bad }}>
      <Heading>Cancel job {j.job_number}</Heading>
      <Text style={st.small}>It leaves the technician's day and is kept on record. Stock booked for it must come back to the stockroom.</Text>
      <Field label="Why is it cancelled?" value={note} onChangeText={setNote} placeholder="e.g. Client fixed it themselves" />
      <Reasons a={ans} />
      <Button label="Cancel job" kind="danger" disabled={note.trim().length < 5} onPress={async () => { const r = await o.send('POST', `/jobs/${j.id}/cancel`, { note: note.trim() }); setAns(r); if (r.ok) done(); }} />
      <Button label="Keep the job" kind="quiet" onPress={done} />
    </Card>
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
  const [q, setQ] = useState('');
  if (!p) return <Body quiet>Loading…</Body>;
  const shown = p.people.filter(x => !q.trim() || `${x.full_name} ${x.position} ${x.tradeLabel ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const groups = p.positions.map(pos => ({ pos, people: shown.filter(x => x.login_level === pos.level) })).filter(g => g.people.length);
  return (
    <>
      <TextInput value={q} onChangeText={setQ} placeholder="Search name, position or trade" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search people" />
      {groups.map(g => (
        <View key={g.pos.level} style={{ gap: 6 }}>
          <Label>{g.pos.label} ({g.people.length})</Label>
          {g.people.map(x => (
            <Pressable key={x.id} onPress={() => open(x.id)} accessibilityRole="button" accessibilityLabel={`Person ${x.full_name}`}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 52, borderRadius: 8, backgroundColor: pressed ? C.panel2 : C.panel, borderWidth: 1, borderColor: C.line })}>
              <Avatar id={x.photo_id} name={x.full_name} size={34} />
              <Text style={[st.body, { fontWeight: '700', flex: 1 }]}>{x.full_name}</Text>
              {x.tradeLabel ? <Text style={st.small}>{x.tradeLabel}</Text> : null}
            </Pressable>
          ))}
        </View>
      ))}
    </>
  );
}

function PersonDetail({ id, o, ask }: { id: string; o: OfficeHook; ask?: (toId: string) => void }) {
  const p = o.d.people;
  const x = p?.people.find(y => y.id === id);
  const [ans, setAns] = useState<Answer | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [extra, setExtra] = useState(false);
  const prof = useProfile(id);
  if (!x || !p) return <Body quiet>Not found.</Body>;
  const manage = !!p.canManage;
  const first = x.full_name.split(' ')[0];
  const isTech = x.login_level === 'technician';
  const put = async (path: string, body: object, what: string) => { const r = await o.send('PUT', path, body); setAns(r.ok ? null : r); setSaved(r.ok ? what : null); if (r.ok) prof.load(); };
  return (
    <>
      {prof.p ? <ProfileTop p={prof.p} reload={prof.load} /> : <Text style={{ color: C.text, fontSize: 26, fontWeight: '800' }}>{x.full_name}</Text>}
      {isTech && ask ? <Button label={`Send ${first} a query`} kind="secondary" onPress={() => ask(x.id)} /> : null}
      {prof.p ? <ProfileDetails p={prof.p} reload={prof.load} /> : null}
      {prof.p && (isTech || ['management', 'director', 'creator'].includes(x.login_level)) ? (
        <DepartmentCard userId={x.id} departmentId={prof.p.departmentId ?? null} level={x.login_level} name={x.full_name} canManage={manage} team={prof.p.team ?? []} reload={() => { prof.load(); o.load?.(); }} />
      ) : null}
      {prof.p && isTech ? <VanCard key={`van-${x.id}-${prof.p.departmentId ?? ''}`} userId={x.id} /> : null}
      {prof.p?.kit?.read ? <KitCard userId={x.id} name={x.full_name} /> : null}
      {prof.p?.record?.read ? <StaffRecord userId={x.id} name={x.full_name} /> : null}
      <Heading>Position{isTech ? ' and trade' : ''}</Heading>
      <Card>
        <Select label="Position" value={x.login_level} disabled={!manage || x.login_level === 'creator'}
          options={p.positions.map(pos => ({ value: pos.level, label: pos.label }))} onChange={v => put(`/access/users/${x.id}/position`, { position: v }, `${first} is now ${p.positions.find(pos => pos.level === v)?.label}`)} />
        {isTech ? (
          <Select label="Trade" value={x.trade ?? null} disabled={!manage} placeholder="Not set"
            options={(p.trades ?? []).map(t => ({ value: t.key, label: t.label }))} onChange={v => put(`/access/users/${x.id}/trade`, { trade: v }, `${first} is now ${(p.trades ?? []).find(t => t.key === v)?.label}`)} />
        ) : null}
        {!manage ? <Text style={st.small}>Only the CEO, or someone the CEO gives "Positions and access", can change these.</Text> : null}
      </Card>
      {saved ? <Notice tone="good" title="Saved" lines={[`${saved}. It is logged and applies at once.`]} /> : null}
      <Reasons a={ans} />
      {isTech && !extra && !(p.areas ?? []).some(a => x.work?.[a.key]) ? (
        manage ? <Button label={`Give ${first} extra work (stockroom, fleet…)`} kind="quiet" onPress={() => setExtra(true)} /> : null
      ) : <Heading>Work {first} does</Heading>}
      {isTech && !extra && !(p.areas ?? []).some(a => x.work?.[a.key]) ? null : x.login_level === 'creator' ? <Body quiet>The CEO always has full access to everything.</Body> : (
        <Card>
          {(p.areas ?? []).map(a => {
            const on = !!x.work?.[a.key];
            return (
              <Pressable key={a.key} disabled={!manage} onPress={() => put(`/access/users/${x.id}/work`, { area: a.key, on: !on }, `${a.label}: ${on ? 'off' : 'on'} for ${first}`)}
                accessibilityRole="switch" accessibilityState={{ checked: on, disabled: !manage }} accessibilityLabel={a.label}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, borderBottomWidth: 1, borderBottomColor: C.line, opacity: manage ? 1 : 0.7 }}>
                <Text style={[st.body, { flex: 1 }]}>{a.label}</Text>
                <View style={{ width: 46, height: 26, borderRadius: 13, backgroundColor: on ? C.good : C.panel2, justifyContent: 'center', paddingHorizontal: 3 }}>
                  <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFF', alignSelf: on ? 'flex-end' : 'flex-start' }} />
                </View>
              </Pressable>
            );
          })}
        </Card>
      )}
    </>
  );
}

// ---- Stores ------------------------------------------------------------------------------------

function StoreList({ o, add }: { o: OfficeHook; add?: () => void }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => o.d.stores.filter(s => !q.trim() || `${s.client} ${s.name} ${s.address ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())), [o.d.stores, q]);
  return (
    <>
      {add ? <Button label="Add a store" kind="secondary" onPress={add} /> : null}
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
