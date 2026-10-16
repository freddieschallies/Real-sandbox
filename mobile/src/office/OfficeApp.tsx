// The office screen (control base), for Admin, Management, Directors and the CEO. Made for a desktop
// browser: menu, list and detail side by side. Works on a phone too, one screen at a time.
import { jobOutcome, NO_CHARGE_REASONS, type NoChargeReason } from '../../../server/src/core/jobOutcome.ts';
import { HistoryPage } from './History.tsx';
import { PriceList } from '../prices/PriceList.tsx';
import { SupportBanner, SupportSettings } from './Support.tsx';
import { BottomTabs } from '../BottomTabs.tsx';
import { BrandLogo } from '../brand.tsx';
import { usePhoneMenu } from '../menu.tsx';
import { ModeToggle, ThemeSettings } from '../appearance.tsx';
import { LetterheadSettings, useLetterhead } from '../letterhead.tsx';
import { StorageSettings } from '../storage.tsx';
import { JobReports, PartsReportView } from '../reports/PartsReport.tsx';
import { WorkshopBoard } from './WorkshopBoard.tsx';
import { PrintBarcodes } from './PrintBarcodes.tsx';
import { MachineMoves } from '../screens/Workshop.tsx';
import { useBrand } from '../brand.tsx';
import { PhoneMenus } from '../menus/PhoneMenus.tsx';
import { MENU_TABS, officeTabKeys } from '../../../server/src/core/phoneMenu.ts';
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
import { TimesheetsExport } from '../timesheets/Timesheet.tsx';
import { EndEmployment, LeaverDetail, TerminatedStaff } from '../hr/Terminated.tsx';
import { Avatar, ProfileDetails, ProfileTop, useProfile } from './Profile.tsx';
import { Accounts, InvoiceDetail, InvoiceList, NewQuote, QuoteDetail, QuoteList, useBooks } from './Books.tsx';
import { NewQuery, QueryList, QueryThread, useQueries } from '../queries/Queries.tsx';
import { useOffice, type Answer, type JobChange, type OfficeHook, type OfficeJob } from './useOffice.ts';
import { MyPasswordSettings } from '../screens/MyPassword.tsx';
import { MoneyOutList, SupplierInvoiceDetail, SupplierInvoiceList } from './SupplierInvoices.tsx';
import { DebtorDetail, DebtorList } from './Debtors.tsx';
import { CustomerDetail, CustomerList } from './Customers.tsx';
import { SearchButton, SearchPanel, type Openers } from '../search/Search.tsx';
import { StartUp, useSetup } from './StartUp.tsx';
import { HelpLink, HelpPanel } from '../help/Help.tsx';
import { ProfitView } from './Profit.tsx';
import { PurchaseOrderList } from './PurchaseOrders.tsx';
import { AddPerson, LOGIN_PILL, LoginCard } from './Logins.tsx';
import { ImportCustomers, StoreDetail, StoreList, pointFrom } from './Stores.tsx';
import { VehiclesPage, type VehSection } from './Vehicles.tsx';
import { PayCard } from './Pay.tsx';
import { WhatsAppTab, useWhatsAppUnread } from '../whatsapp/WhatsAppTab.tsx';
import { BreakdownAlert, BreakdownById, BreakdownList, BreakdownSettings, type Bd } from './Breakdowns.tsx';

const K = { band: '#121212', bandText: '#F7F3EC', get stripe() { return C.accent; } };
type Tab = 'history' | 'prices' | 'setup' | 'today' | 'breakdowns' | 'whatsapp' | 'jobs' | 'queries' | 'quotes' | 'invoices' | 'supplier' | 'pos' | 'customers' | 'debtors' | 'profit' | 'accounts' | 'flags' | 'vehicles' | 'map' | 'vans' | 'departments' | 'timesheets' | 'people' | 'repairs' | 'stores' | 'barcodes' | 'settings';
type Sel = { kind: 'job'; id: string } | { kind: 'newjob' } | { kind: 'flag'; id: string } | { kind: 'person'; id: string } | { kind: 'newstore' } | { kind: 'query'; id: string } | { kind: 'newquery'; toId?: string } | { kind: 'quote'; id: string } | { kind: 'newquote' } | { kind: 'invoice'; id: string } | { kind: 'van'; id: string } | { kind: 'leaver'; id: string } | { kind: 'report'; id: string } | { kind: 'newperson' } | { kind: 'breakdown'; id: string; b?: Bd } | { kind: 'bdlog'; b: Bd } | { kind: 'store'; id: string } | { kind: 'importcustomers' } | { kind: 'supplierinv'; id: string } | { kind: 'debtor'; id: string } | { kind: 'customer'; id: string; show?: 'statement' } | null;

const STATUS: Record<string, { text: string; tone: 'info' | 'good' | 'warn' | 'bad' | 'quiet' }> = {
  cancelled: { text: 'Cancelled', tone: 'quiet' }, assigned: { text: 'Assigned', tone: 'quiet' }, in_progress: { text: 'In progress', tone: 'info' }, continue_later: { text: 'Continue later', tone: 'warn' }, closed: { text: 'Closed', tone: 'good' },
};
const TYPE: Record<string, string> = { breakdown: 'Breakdown', planned_maintenance: 'Planned maintenance', installation: 'Installation', quote_visit: 'Quote visit', follow_up: 'Follow-up', workshop_repair: 'Workshop repair' };
const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const day = (s: string) => {
  const t = ymd(new Date());
  if (s === t) return 'Today';
  if (s === ymd(new Date(Date.now() + 86_400_000))) return 'Tomorrow';
  if (s === ymd(new Date(Date.now() - 86_400_000))) return 'Yesterday';
  return new Date(`${s}T12:00:00+02:00`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
};
const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
/** On the phone, unless the CEO or an admin pinned others: the first four show and the rest go under More, most used first. */
const PHONE_ORDER: string[] = MENU_TABS.office.map(t => t.key);
/** Screens that use the whole width on a computer (no list and detail). */
const FULL: Tab[] = ['history', 'prices', 'setup', 'today', 'profit', 'pos', 'accounts', 'map', 'departments', 'timesheets', 'vehicles', 'whatsapp', 'settings'];
const OFFICE_LEVELS = ['admin', 'accounts', 'management', 'hr', 'director', 'creator'];
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
  const picked = React.useRef(false);
  const go = (t: Tab, x: Sel = null) => { picked.current = true; setTab(t); setSel(x); };
  // The Vehicles page opens on a part of it, or on one vehicle (from Today's tiles and from search).
  const [veh, setVeh] = useState<{ n: number; start?: { section?: VehSection; vehicleId?: string } }>({ n: 0 });
  const goVeh = (start?: { section?: VehSection; vehicleId?: string }) => { setVeh(v => ({ n: v.n + 1, start })); go('vehicles'); };
  // Each person sees only the work the CEO switched on for them.
  const work = s.session?.user.work ?? {};
  const does = (a: string) => s.session?.user.level === 'creator' || !!work[a];

  // Breakdowns waiting (email and the WhatsApp group): the tab's count and the pop-up.
  const [bdView, setBdView] = useState<'open' | 'done'>('open');
  const [bdTick, setBdTick] = useState(0);
  const [bdCount, setBdCount] = useState(0);
  useEffect(() => {
    if (!does('jobs')) return;
    const f = () => s.ask({ method: 'GET', path: '/breakdowns/count' }).then(r => { if (r?.status === 200) setBdCount((r.body as { breakdowns: number }).breakdowns); }).catch(() => undefined);
    f(); const t = setInterval(f, 20_000); return () => clearInterval(t);
  }, [bdTick]);
  // Supplier invoices: the list looks again when one is saved, approved or queried.
  const [supTick, setSupTick] = useState(0);
  const [debTick, setDebTick] = useState(0);
  const [searching, setSearching] = useState(false);
  const [helping, setHelping] = useState(false);
  const bdDone = (jobId?: string) => { setBdTick(t => t + 1); o.load(); if (jobId) go('jobs', { kind: 'job', id: jobId }); else setSel(null); };

  const menu = usePhoneMenu();
  const waUnread = useWhatsAppUnread(does('jobs'));
  const setup = useSetup(['creator', 'director'].includes(s.session?.user.level ?? '') || !!work?.access);
  const [menuStart, setMenuStart] = useState<string | undefined>(undefined);
  const level = s.session?.user.level ?? '';
  // Every tab the office has (in the order of the side menu on a computer); each person gets the ones their work allows.
  const allTabs: { key: Tab; label: string; short?: string; count?: number }[] = [
    ...(!setup.d?.dismissed ? [{ key: 'setup' as Tab, label: 'Start-up', count: setup.d ? setup.d.total - setup.d.done || undefined : undefined }] : []),
    { key: 'today', label: 'Today' },
    { key: 'breakdowns', label: 'Breakdowns', count: bdCount || undefined },
    { key: 'whatsapp', label: 'WhatsApp', count: waUnread || undefined },
    { key: 'jobs', label: 'Jobs', count: ov ? ov.jobs.carried_over + ov.jobs.urgent : undefined },
    { key: 'queries', label: 'Queries', count: qs.unread },
    { key: 'quotes', label: 'Quotes', count: books.quotes.filter(q => q.status === 'draft').length || undefined },
    { key: 'invoices', label: 'Invoices', count: books.toInvoice.length || undefined },
    { key: 'supplier', label: 'Supplier invoices', short: 'Suppliers' },
    { key: 'pos', label: 'Purchase orders', short: 'POs' },
    { key: 'prices', label: 'Price list', short: 'Prices' },
    { key: 'customers', label: 'Customers' },
    { key: 'debtors', label: 'Debtors' },
    { key: 'profit', label: 'Profit' },
    { key: 'accounts', label: 'Accounts', short: 'Pastel' },
    { key: 'flags', label: 'Flags', count: ov?.flags?.unresolved },
    { key: 'vehicles', label: 'Vehicles', count: ov?.handoversAwaitingApproval || undefined },
    { key: 'map', label: 'Team map', short: 'Map' },
    { key: 'vans', label: 'Van stock', short: 'Vans' },
    { key: 'departments', label: 'Departments', short: 'Depts' },
    { key: 'timesheets', label: 'Timesheets', short: 'Timesheet' },
    { key: 'people', label: 'People' },
    { key: 'repairs', label: 'Workshop', count: o.d.jobs.filter(j => j.ready_to_deliver && j.status !== 'closed' && j.status !== 'cancelled').length || undefined },
    { key: 'stores', label: 'Stores' },
    { key: 'barcodes', label: 'QR codes' },
    { key: 'history', label: 'History' },
    ...(setup.d?.dismissed ? [{ key: 'setup' as Tab, label: 'Start-up' }] : []),
    { key: 'settings', label: 'Settings' },
  ];
  const brand = useBrand();
  useLetterhead(); // ready for printing quotes, invoices and timesheets on the letterhead
  const mine = officeTabKeys(level, work, { people: canPeople, settings: menu.canEdit || brand.canTheme });
  // Support from Real Sandbox never sees the history.
  const tabs = allTabs.filter(t => mine.includes(t.key) && !(t.key === 'history' && s.session?.support));
  const has = (k: Tab) => tabs.some(t => t.key === k);
  const arrange = () => { setMenuStart(level); go('settings'); };
  // Until the person picks a tab, show their first one (their work may load after the screen does);
  // after that, only move them if the tab they are on is no longer theirs.
  // Invoices and credit notes change a job's billing: the job list is fresh each time it opens.
  useEffect(() => { if (tab === 'jobs') o.load(); }, [tab]);
  const tabKeys = tabs.map(t => t.key).join();
  useEffect(() => {
    if (!tabs.length) return;
    if (!picked.current ? tab !== tabs[0].key : !tabs.some(t => t.key === tab) && tab !== 'people') setTab(tabs[0].key);
  }, [tabKeys]);

  const list = (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 40 }}>
      {tab === 'setup' ? <StartUp setup={setup} go={w => (w === 'importcustomers' ? go('stores', { kind: 'importcustomers' }) : w === 'newstore' ? go('stores', { kind: 'newstore' }) : go(w))} /> : null}
      {tab === 'today' ? <TodayView o={o} go={go} goVeh={has('vehicles') ? goVeh : () => undefined} flags={does('flags')} /> : null}
      {tab === 'breakdowns' ? <BreakdownList view={bdView} setView={v => { setBdView(v); setSel(null); }} open={b => setSel({ kind: 'breakdown', id: b.id, b })} selected={sel?.kind === 'breakdown' ? sel.id : null} tick={bdTick} /> : null}
      {tab === 'jobs' ? <JobList o={o} open={id => setSel({ kind: 'job', id })} add={does('jobs') ? () => setSel({ kind: 'newjob' }) : undefined} selected={sel?.kind === 'job' ? sel.id : null} /> : null}
      {tab === 'queries' ? <QueryList q={qs} open={id => setSel({ kind: 'query', id })} ask={() => setSel({ kind: 'newquery' })} /> : null}
      {tab === 'quotes' ? <QuoteList b={books} open={id => setSel({ kind: 'quote', id })} add={() => setSel({ kind: 'newquote' })} /> : null}
      {tab === 'invoices' ? <InvoiceList b={books} open={id => setSel({ kind: 'invoice', id })} moneyOut={does('books') ? <MoneyOutList open={id => setSel({ kind: 'supplierinv', id })} selected={sel?.kind === 'supplierinv' ? sel.id : null} tick={supTick} /> : undefined} /> : null}
      {tab === 'supplier' ? <SupplierInvoiceList open={id => setSel({ kind: 'supplierinv', id })} selected={sel?.kind === 'supplierinv' ? sel.id : null} tick={supTick} /> : null}
      {tab === 'debtors' ? <DebtorList open={id => setSel({ kind: 'debtor', id })} selected={sel?.kind === 'debtor' ? sel.id : null} tick={debTick} /> : null}
      {tab === 'pos' ? <PurchaseOrderList /> : null}
      {tab === 'customers' ? <CustomerList open={id => setSel({ kind: 'customer', id })} selected={sel?.kind === 'customer' ? sel.id : null} /> : null}
      {tab === 'profit' ? <ProfitView openJob={id => go('jobs', { kind: 'job', id })} /> : null}
      {tab === 'accounts' ? <Accounts b={books} canPrices={does('prices')} canBooks={does('books')} /> : null}
      {tab === 'flags' ? <FlagList o={o} open={id => setSel({ kind: 'flag', id })} selected={sel?.kind === 'flag' ? sel.id : null} /> : null}
      {tab === 'map' ? <TeamMap openPerson={canPeople ? id => go('people', { kind: 'person', id }) : undefined} /> : null}
      {tab === 'timesheets' ? <TimesheetsExport /> : null}
      {tab === 'departments' ? <DepartmentsBoard openPerson={canPeople ? id => go('people', { kind: 'person', id }) : undefined} /> : null}
      {tab === 'vans' ? <VanLists openTech={id => setSel({ kind: 'van', id })} /> : null}
      {tab === 'people' ? <PeopleList key={`people-${sel?.kind === 'leaver' ? sel.id : ''}`} o={o} open={id => setSel({ kind: 'person', id })} openLeaver={id => setSel({ kind: 'leaver', id })} add={() => setSel({ kind: 'newperson' })} /> : null}
      {tab === 'repairs' ? <WorkshopBoard o={o} openJob={id => go('jobs', { kind: 'job', id })} /> : null}
      {tab === 'barcodes' ? <PrintBarcodes /> : null}
      {tab === 'stores' ? <StoreList o={o} canEdit={does('stores')} add={does('stores') ? () => setSel({ kind: 'newstore' }) : undefined} importIt={does('stores') ? () => setSel({ kind: 'importcustomers' }) : undefined} open={id => setSel({ kind: 'store', id })} /> : null}
      {tab === 'settings' ? <>{has('setup') ? <Button label={`Start-up checklist${setup.d ? ` (${setup.d.done} of ${setup.d.total} done)` : ''}`} kind="secondary" onPress={() => go('setup')} /> : null}{does('access') && !s.session?.support ? <SupportSettings /> : null}{does('access') ? <BreakdownSettings /> : null}<ThemeSettings /><LetterheadSettings /><StorageSettings />{does('access') || level === 'admin' ? <MyPasswordSettings /> : null}{menu.canEdit ? <PhoneMenus key={menuStart ?? 'menus'} start={menuStart ?? level} /> : null}</> : null}
      {!wide ? <HelpLink onPress={() => setHelping(true)} /> : null}
      {!wide ? <Button label="Sign out" kind="quiet" onPress={s.signOut} /> : null}
      <Text style={st.small}>{o.d.loadedAt ? `Updated ${when(o.d.loadedAt)}` : o.loading ? 'Loading…' : 'Needs signal to load.'}</Text>
    </ScrollView>
  );

  const [part, setPart] = useState<{ n: number; id?: string }>({ n: 0 });
  const body = tab === 'history' ? <HistoryPage />
    : tab === 'prices' ? <PriceList key={part.n} itemId={part.id} />
    : tab === 'vehicles' ? <VehiclesPage key={veh.n} o={o} start={veh.start} />
    : tab === 'whatsapp' ? <WhatsAppTab openBreakdown={id => go('breakdowns', { kind: 'breakdown', id })} /> : list;
  const close = () => setSel(null);
  const detail = (() => {
    if (!sel) return null;
    const wrap = (el: React.ReactNode) => <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60, maxWidth: 820 }}>{el}</ScrollView>;
    if (sel.kind === 'job') return wrap(<JobDetail key={sel.id} id={sel.id} o={o} canEdit={does('jobs')} canDocs={does('documents')} openReport={rid => setSel({ kind: 'report', id: rid })} />);
    if (sel.kind === 'report') return wrap(<PartsReportView key={sel.id} id={sel.id} />);
    if (sel.kind === 'newjob') return wrap(<NewJob o={o} done={id => setSel(id ? { kind: 'job', id } : null)} />);
    if (sel.kind === 'query') return wrap(<QueryThread key={sel.id} q={qs} id={sel.id} />);
    if (sel.kind === 'newquery') return wrap(<NewQuery key={sel.toId ?? 'new'} q={qs} toId={sel.toId} jobs={o.d.jobs.filter(j => j.status !== 'closed' && j.status !== 'cancelled').map(j => ({ id: j.id, label: `#${j.job_number} ${j.store}` }))} done={() => setSel(null)} />);
    if (sel.kind === 'quote') return wrap(<QuoteDetail key={sel.id} b={books} id={sel.id} techs={o.d.techs} />);
    if (sel.kind === 'newquote') return wrap(<NewQuote b={books} stores={o.d.stores} jobs={o.d.jobs.filter(j => j.status !== 'closed' && j.status !== 'cancelled').map(j => ({ id: j.id, label: `#${j.job_number} ${j.store}` }))}
      done={id => setSel(id ? { kind: 'quote', id } : null)} />);
    if (sel.kind === 'invoice') return wrap(<InvoiceDetail key={sel.id} b={books} id={sel.id} />);
    if (sel.kind === 'flag') return wrap(<FlagDetail key={sel.id} id={sel.id} o={o} done={close} />);
    if (sel.kind === 'van') return wrap(<><Heading>{o.d.people?.people.find(y => y.id === sel.id)?.full_name ?? 'Van'}</Heading><VanCard key={sel.id} userId={sel.id} /></>);
    if (sel.kind === 'person') return wrap(<PersonDetail key={sel.id} id={sel.id} o={o} ask={does('jobs') ? toId => setSel({ kind: 'newquery', toId }) : undefined}
      ended={() => { o.load(); setSel({ kind: 'leaver', id: sel.id }); }} />);
    if (sel.kind === 'leaver') return wrap(<LeaverDetail key={sel.id} id={sel.id} />);
    if (sel.kind === 'breakdown') return wrap(<BreakdownById key={`${sel.id}-${bdTick}`} id={sel.id} b={sel.b} o={o} logIt={b => setSel({ kind: 'bdlog', b })} done={bdDone} />);
    if (sel.kind === 'store') return wrap(<StoreDetail key={sel.id} id={sel.id} o={o} canEdit={does('stores')} done={close} />);
    if (sel.kind === 'importcustomers') return wrap(<ImportCustomers o={o} done={close} />);
    if (sel.kind === 'debtor') return wrap(<DebtorDetail key={sel.id} id={sel.id} changed={() => { setDebTick(t => t + 1); o.load(); }} openInvoice={id => go('invoices', { kind: 'invoice', id })} openStatement={mine.includes('customers') ? () => go('customers', { kind: 'customer', id: sel.id, show: 'statement' }) : undefined} />);
    if (sel.kind === 'customer') return wrap(<CustomerDetail key={`${sel.id}-${sel.show ?? ''}`} id={sel.id} start={sel.show ?? 'jobs'} co={books.company?.profile ?? {}} canRates={does('rates') || does('books')} openJob={id => go('jobs', { kind: 'job', id })}
      openInvoice={id => go('invoices', { kind: 'invoice', id })} openQuote={id => go('quotes', { kind: 'quote', id })} openDebtor={id => go('debtors', { kind: 'debtor', id })} />);
    if (sel.kind === 'supplierinv') return wrap(<SupplierInvoiceDetail key={sel.id} id={sel.id} changed={() => setSupTick(t => t + 1)} />);
    if (sel.kind === 'bdlog') {
      const b = sel.b;
      return wrap(<NewJob key={b.id} o={o} title="Log the breakdown as a job" path={`/breakdowns/${b.id}/log`}
        start={{ storeId: b.store_id, storeText: b.store_text, fault: b.fault ?? b.subject ?? b.body.slice(0, 200), ref: b.call_ref, urgent: b.urgent }}
        done={id => (id ? bdDone(id) : setSel({ kind: 'breakdown', id: b.id, b }))} />);
    }
    if (sel.kind === 'newperson') {
      const p = o.d.people;
      return wrap(<AddPerson positions={(p?.positions ?? []).filter(x => (p?.addPositions ?? []).includes(x.level))} trades={p?.trades ?? []}
        done={id => { o.load(); setSel(id ? { kind: 'person', id } : null); }} />);
    }
    return wrap(<NewStore o={o} done={close} />);
  })();

  const header = (
    <View style={{ backgroundColor: K.band, paddingTop: ins.top, borderBottomWidth: 4, borderBottomColor: K.stripe }}>
      <View style={{ paddingHorizontal: S.pad, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {!wide && sel ? <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Back" hitSlop={10}><Text style={{ color: K.bandText, fontSize: 34 }}>‹</Text></Pressable> : null}
        <BrandLogo />
        <View style={{ flex: 1 }}>
          <Text style={{ color: K.bandText, fontSize: 22, fontWeight: '800' }}>Office</Text>
          <Text style={{ color: K.bandText, opacity: 0.75 }}>{s.session?.user.name} · {s.session?.user.level === 'creator' ? 'CEO' : s.session?.user.level === 'admin' ? 'Admin' : s.session?.user.level === 'director' ? 'Director' : s.session?.user.level === 'hr' ? 'HR' : s.session?.user.level === 'accounts' ? 'Accounts' : 'Department manager'} · {s.session?.company.name}</Text>
        </View>
        <SearchButton color={K.bandText} onPress={() => setSearching(true)} />
        <ModeToggle color={K.bandText} />
        <Pressable onPress={o.load} accessibilityRole="button" accessibilityLabel="Refresh" hitSlop={8}
          style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: K.bandText }}>
          <Text style={{ color: K.bandText, fontWeight: '700' }}>{o.loading ? '…' : 'Refresh'}</Text>
        </Pressable>
        {wide ? <Pressable onPress={s.signOut} accessibilityRole="button" hitSlop={8}><Text style={{ color: K.bandText }}>Sign out</Text></Pressable> : null}
      </View>
    </View>
  );

  // Search: every tab this person has, and what their work lets them see; a result opens where it lives.
  const openers: Openers = {
    ...(has('jobs') ? { job: id => go('jobs', { kind: 'job', id }) } : {}),
    ...(has('stores') ? { store: id => go('stores', { kind: 'store', id }) } : {}),
    ...(has('customers') ? { client: id => go('customers', { kind: 'customer', id }) } : {}),
    ...(has('quotes') ? { quote: id => go('quotes', { kind: 'quote', id }) } : {}),
    ...(has('invoices') ? { invoice: id => go('invoices', { kind: 'invoice', id }) } : {}),
    ...(has('pos') ? { po: () => go('pos') } : {}),
    ...(has('prices') ? { stock: (id: string) => { setPart(x => ({ n: x.n + 1, id })); go('prices'); } } : {}),
    ...(has('supplier') ? { supplier_invoice: id => go('supplier', { kind: 'supplierinv', id }) } : {}),
    ...(has('people') ? { person: id => go('people', { kind: 'person', id }) } : {}),
    ...(has('vehicles') ? { vehicle: id => goVeh({ vehicleId: id }) } : {}),
  };
  const search = searching ? <SearchPanel places={[...tabs.map(t => ({ key: t.key, label: t.label, open: () => go(t.key) })), { key: 'help', label: 'How to use the app', open: () => setHelping(true) }]} open={openers} close={() => setSearching(false)} />
    : helping ? <HelpPanel close={() => setHelping(false)} /> : null;

  if (wide) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {header}
        <SupportBanner ceo={does('access')} />
        {does('jobs') ? <BreakdownAlert open={id => go('breakdowns', { kind: 'breakdown', id })} /> : null}
        <View style={{ flex: 1, flexDirection: 'row' }}>
          {/* Compact so every tab fits on a normal screen; on a short window it scrolls, with a scrollbar. */}
          <ScrollView style={{ width: 200, flexGrow: 0, borderRightWidth: 1, borderRightColor: C.line }} contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 8, gap: 2 }} showsVerticalScrollIndicator persistentScrollbar>
            {tabs.map(t => (
              <Pressable key={t.key} onPress={() => go(t.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, minHeight: 38, borderRadius: 8, backgroundColor: tab === t.key ? C.panel2 : 'transparent', borderLeftWidth: 3, borderLeftColor: tab === t.key ? K.stripe : 'transparent' }}>
                <Text style={{ color: tab === t.key ? C.text : C.quiet, fontWeight: '700', flex: 1 }}>{t.label}</Text>
                {t.count ? <Pill text={String(t.count)} tone="warn" /> : null}
              </Pressable>
            ))}
            <HelpLink onPress={() => setHelping(true)} />
          </ScrollView>
          <View style={{ width: FULL.includes(tab) ? undefined : 460, flex: FULL.includes(tab) ? 1 : undefined, borderRightWidth: 1, borderRightColor: C.line }}>{body}</View>
          {!FULL.includes(tab) ? <View style={{ flex: 1 }}>{detail ?? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Body quiet>Choose something on the left.</Body></View>}</View> : null}
        </View>
        {search}
      </View>
    );
  }
  const alert = does('jobs') ? <BreakdownAlert open={id => go('breakdowns', { kind: 'breakdown', id })} /> : null;
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {header}
      <SupportBanner ceo={does('access')} />
      <View style={{ flex: 1 }}>{detail ?? body}</View>
      {alert}
      {!sel ? (
        <BottomTabs tabs={[...tabs].sort((a, b) => PHONE_ORDER.indexOf(a.key) - PHONE_ORDER.indexOf(b.key))} current={tab} onSelect={k => go(k)} accent={K.stripe} bottom={ins.bottom}
          pinned={menu.pinned} onArrange={menu.canEdit ? arrange : undefined} />
      ) : null}
      {search}
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

function TodayView({ o, go, goVeh, flags }: { o: OfficeHook; go: (t: Tab, x?: Sel) => void; goVeh: (start?: { section?: VehSection; vehicleId?: string }) => void; flags: boolean }) {
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
        <Tile label="Handovers to approve" value={v.handoversAwaitingApproval} sub="taken with nobody to sign" tone={v.handoversAwaitingApproval ? 'warn' : 'good'} onPress={() => goVeh({ section: 'handovers' })} />
      </View> : null}
      <Heading>Fleet</Heading>
      <View style={row}>
        <Tile label="Daily checks today" value={`${v.fleet.checked_today} of ${v.fleet.due}`} tone={v.fleet.checked_today >= v.fleet.due ? 'good' : 'warn'} onPress={() => goVeh({ section: 'vehicles' })} />
        <Tile label="Safety faults open" value={v.fleet.safety_faults} tone={v.fleet.safety_faults ? 'bad' : 'good'} onPress={() => goVeh({ section: 'faults' })} />
        <Tile label="Off the road / workshop" value={v.fleet.off} sub={`${v.fleet.in_service} in service`} onPress={() => goVeh({ section: 'vehicles' })} />
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

const FILTERS = ['open', 'today', 'carried', 'workshop', 'closed', 'all'] as const;
const BILLING = ['any', 'not_invoiced', 'invoiced', 'credited', 'no_charge', 'cancelled'] as const;
function JobList({ o, open, add, selected }: { o: OfficeHook; open: (id: string) => void; add?: () => void; selected: string | null }) {
  const [f, setF] = useState<(typeof FILTERS)[number]>('open');
  const [bill, setBill] = useState<(typeof BILLING)[number]>('any');
  const [tech, setTech] = useState<string>('');
  const [type, setType] = useState<string>('');
  const [q, setQ] = useState('');
  const t = ymd(new Date());
  const shut = (st: string) => st === 'closed' || st === 'cancelled';
  const techs = [...new Set(o.d.jobs.map(j => j.lead_technician))].sort();
  const jobs = o.d.jobs
    .filter(j => f === 'all' || (f === 'closed' ? shut(j.status) : !shut(j.status)) && (f !== 'today' || j.scheduled_date === t) && (f !== 'carried' || j.scheduled_date < t)
      && (f !== 'workshop' || j.machine_at === 'workshop' || (j.loans_out ?? 0) > 0))
    // Billing: not invoiced means a closed job with no invoice sent yet (a draft counts as not sent).
    .filter(j => bill === 'any' || (bill === 'cancelled' ? j.status === 'cancelled' : bill === 'no_charge' ? j.billing === 'no_charge'
      : bill === 'credited' ? j.billing === 'credited' : bill === 'invoiced' ? j.billing === 'invoiced' || j.billing === 'credited'
      : j.status === 'closed' && (j.billing === 'not_invoiced' || j.billing === 'draft_invoice')))
    .filter(j => !tech || j.lead_technician === tech)
    .filter(j => !type || j.job_type === type)
    .filter(j => !q.trim() || `${j.job_number} ${j.store} ${j.fault_reported} ${j.lead_technician} ${j.invoice_number ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(b.priority === 'urgent' && b.status !== 'closed') - Number(a.priority === 'urgent' && a.status !== 'closed'));
  const filtered = bill !== 'any' || !!tech || !!type || !!q.trim();
  return (
    <>
      {add ? <Button label="New job" onPress={add} /> : null}
      <Choice options={FILTERS} value={f} onChange={setF} labels={{ open: 'All open', today: 'Today', carried: 'Carried over', workshop: 'Workshop & loans', closed: 'Closed / cancelled', all: 'All jobs' }} />
      <Label>Invoicing</Label>
      <Choice options={BILLING} value={bill} onChange={v => { setBill(v); if (v !== 'any' && f !== 'closed') setF('all'); }}
        labels={{ any: 'Any', not_invoiced: 'Not invoiced', invoiced: 'Invoiced', credited: 'Credited', no_charge: 'No charge', cancelled: 'Cancelled' }} />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <View style={{ flex: 1, minWidth: 180 }}>
          <Select label="Technician" value={tech} onChange={setTech} options={[{ value: '', label: 'Everyone' }, ...techs.map(n => ({ value: n, label: n }))]} />
        </View>
        <View style={{ flex: 1, minWidth: 180 }}>
          <Select label="Job type" value={type} onChange={setType} options={[{ value: '', label: 'All types' }, ...Object.entries(TYPE).map(([k, l]) => ({ value: k, label: l }))]} />
        </View>
      </View>
      <TextInput value={q} onChangeText={setQ} placeholder="Search number, store, fault, technician, invoice" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search jobs" />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.small, { flex: 1 }]}>{jobs.length} job{jobs.length === 1 ? '' : 's'}</Text>
        {filtered ? <Button label="Clear filters" kind="quiet" onPress={() => { setBill('any'); setTech(''); setType(''); setQ(''); }} /> : null}
      </View>
      {jobs.map(j => <JobRow key={j.id} j={j} on={selected === j.id} onPress={() => open(j.id)} />)}
      {!jobs.length ? <Body quiet>No jobs here.</Body> : null}
    </>
  );
}

/** Where a job stands in one pill: open (assigned, in progress), done and where the money stands (to invoice, invoiced, paid, credited, no charge), or who cancelled it. */
function OutcomePill({ j }: { j: OfficeJob }) {
  const x = jobOutcome(j);
  return <Pill text={x.label} tone={x.tone} />;
}

function JobRow({ j, on, onPress }: { j: OfficeJob; on: boolean; onPress: () => void }) {
  const late = j.status !== 'closed' && j.status !== 'cancelled' && j.scheduled_date < ymd(new Date());
  return (
    <Card onPress={onPress} accessibilityLabel={`Job ${j.job_number}`} style={[on ? { borderColor: K.stripe, borderWidth: 2 } : {}, j.priority === 'urgent' && j.status !== 'closed' ? { borderLeftWidth: 5, borderLeftColor: C.bad } : {}] as never}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.body, { fontWeight: '800' }]}>#{j.job_number}</Text>
        <Text numberOfLines={1} style={[st.body, { flex: 1 }]}>{j.store}</Text>
        {j.client_on_hold && j.status !== 'closed' && j.status !== 'cancelled' ? <Pill text="On hold" tone="bad" /> : null}
        {j.status === 'continue_later' && j.machine_at === 'workshop' ? <Pill text={j.ready_to_deliver ? 'Ready to deliver' : 'In the workshop'} tone={j.ready_to_deliver ? 'good' : 'warn'} />
          : <OutcomePill j={j} />}
      </View>
      {j.status !== 'closed' && j.status !== 'cancelled' && ((j.machine_at === 'workshop' && j.status !== 'continue_later') || (j.loans_out ?? 0) > 0) ? (
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {j.machine_at === 'workshop' && j.status !== 'continue_later' ? <Pill text="Machine in the workshop" tone="warn" /> : null}
          {(j.loans_out ?? 0) > 0 ? <Pill text="Loan machine out" tone="info" /> : null}
        </View>
      ) : null}
      <Body numberOfLines={2}>{j.fault_reported}</Body>
      <Text style={[st.small, late ? { color: C.warn } : null]}>{TYPE[j.job_type] ?? j.job_type}{j.priority === 'urgent' ? ' · URGENT' : ''} · {day(j.scheduled_date)}{late ? ' (carried over)' : ''} · {j.lead_technician}</Text>
    </Card>
  );
}

function Reasons({ a }: { a: Answer | null }) {
  if (!a || a.ok) return null;
  return <Notice tone="bad" title="Not yet. Still needed:" lines={a.reasons} />;
}

/** Filled in already when the job comes from a breakdown email or WhatsApp message. */
export interface JobStart { storeId?: string | null; storeText?: string | null; fault?: string | null; ref?: string | null; urgent?: boolean }

export function NewJob({ o, done, start, path, title }: { o: OfficeHook; done: (id?: string) => void; start?: JobStart; path?: string; title?: string }) {
  const [storeQ, setStoreQ] = useState(start?.storeId ? '' : start?.storeText ?? '');
  const [storeId, setStoreId] = useState<string | undefined>(start?.storeId ?? undefined);
  const [type, setType] = useState<J.JobType>('breakdown');
  const [priority, setPriority] = useState<'urgent' | 'normal' | 'scheduled'>(start?.urgent ? 'urgent' : 'normal');
  const [fault, setFault] = useState(start?.fault ?? '');
  const [date, setDate] = useState(ymd(new Date()));
  const [lead, setLead] = useState<string>();
  const [helpers, setHelpers] = useState<string[]>([]);
  const [ref, setRef] = useState(start?.ref ?? '');
  const [steps, setSteps] = useState('');
  const [ans, setAns] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [holdOk, setHoldOk] = useState(false);
  const days = Array.from({ length: 10 }, (_, i) => ymd(new Date(Date.now() + i * 86_400_000)));
  const stores = o.d.stores.filter(s => !storeQ.trim() || `${s.client} ${s.name} ${s.address ?? ''}`.toLowerCase().includes(storeQ.trim().toLowerCase())).slice(0, 8);
  const store = o.d.stores.find(s => s.id === storeId);

  const submit = async () => {
    const missing = [!storeId ? 'which store' : null, fault.trim().length < 3 ? 'what the fault is' : null, !lead ? 'the lead technician' : null,
      type === 'planned_maintenance' && !steps.trim() ? 'the maintenance checklist steps (one per line)' : null].filter(Boolean) as string[];
    if (store?.client_on_hold && !holdOk) missing.push(`${store.client} is on hold: tick "Open it anyway" if the job must go ahead`);
    if (missing.length) { setAns({ ok: false, reasons: missing }); return; }
    setBusy(true);
    const r = await o.send('POST', path ?? '/jobs', {
      ...(store?.client_on_hold && holdOk ? { holdOk: true } : {}),
      jobType: type, priority, storeId, faultReported: fault.trim(), scheduledDate: date, leadTechnicianId: lead, helperIds: helpers,
      ...(ref.trim() ? { clientOrderRef: ref.trim() } : {}), maintenanceSteps: type === 'planned_maintenance' ? steps.split('\n').map(x => x.trim()).filter(Boolean) : [],
    });
    setBusy(false);
    setAns(r);
    if (r.ok) done(r.body.id ?? r.body.jobId);
  };

  return (
    <>
      <Heading>{title ?? 'New job'}</Heading>
      <Label>Store</Label>
      {!storeId && start?.storeText ? <Text style={st.small}>The message says "{start.storeText}": pick the store below (or add it under Stores).</Text> : null}
      {!storeId && start && !start.storeText ? <Text style={st.small}>The store was not clear from the message: search for it below.</Text> : null}
      {store ? (
        <Card style={{ borderColor: K.stripe }}>
          <Text style={[st.body, { fontWeight: '800' }]}>{store.name}</Text>
          <Text style={st.small}>{store.client}{store.address ? ` · ${store.address}` : ''}{store.open_jobs ? ` · ${store.open_jobs} open job${store.open_jobs > 1 ? 's' : ''} there already` : ''}</Text>
          <Button label="Change store" kind="quiet" onPress={() => { setStoreId(undefined); setHoldOk(false); }} style={{ minHeight: 40 }} />
        </Card>
      ) : (
        <>
          <TextInput value={storeQ} onChangeText={setStoreQ} placeholder="Search client or store" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search stores" />
          {stores.map(s => (
            <Pressable key={s.id} onPress={() => setStoreId(s.id)} accessibilityRole="button" accessibilityLabel={`Store ${s.name}`}
              style={{ padding: 12, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.panel }}>
              <Text style={[st.body, { fontWeight: '700' }]}>{s.name}</Text>
              <Text style={st.small}>{s.client}{s.address ? ` · ${s.address}` : ''}</Text>
              {s.client_on_hold ? <Text style={[st.small, { color: C.bad, fontWeight: '700' }]}>Account on hold</Text> : null}
            </Pressable>
          ))}
        </>
      )}
      {store?.client_on_hold ? (
        <Card style={{ borderColor: C.bad, borderWidth: 2 }}>
          <Text style={[st.body, { fontWeight: '800', color: C.bad }]}>{store.client}: account on hold</Text>
          <Text style={st.body}>{(store.hold_reason ?? 'Not paying').replace(/[.\s]*$/, '.')} Check with Accounts before sending a technician.</Text>
          <Pressable onPress={() => setHoldOk(!holdOk)} accessibilityRole="checkbox" accessibilityState={{ checked: holdOk }} accessibilityLabel="Open it anyway"
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}>
            <Text style={{ fontSize: 20, color: holdOk ? C.bad : C.quiet }}>{holdOk ? '☑' : '☐'}</Text>
            <Text style={st.body}>Open it anyway (Accounts and the CEO are told)</Text>
          </Pressable>
        </Card>
      ) : null}
      <Label>Type</Label>
      <Choice options={['breakdown', 'planned_maintenance', 'installation', 'quote_visit', 'follow_up', 'workshop_repair'] as const} value={type} onChange={setType} labels={TYPE} />
      <Label>Priority</Label>
      <Choice options={['urgent', 'normal', 'scheduled'] as const} value={priority} onChange={setPriority} labels={{ urgent: 'Urgent', normal: 'Normal', scheduled: 'Scheduled' }} />
      <Field label="Fault reported by the client" value={fault} onChangeText={setFault} multiline placeholder="e.g. Ice machine not dispensing, bakery" />
      {type === 'workshop_repair' ? <Notice tone="info" title="The machine is already in our workshop" lines={['Brought in by the client. The technician starts in the workshop, and it goes back by delivery or the client fetches it.', 'For a machine still on site, open a breakdown: the technician uplifts it from there.']} /> : null}
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

function JobDetail({ id, o, canEdit, canDocs, openReport }: { id: string; o: OfficeHook; canEdit: boolean; canDocs: boolean; openReport: (id: string) => void }) {
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
        <OutcomePill j={j} />
        {j.priority === 'urgent' && j.status !== 'closed' && j.status !== 'cancelled' ? <Pill text="Urgent" tone="bad" /> : null}
        {j.client_on_hold ? <Pill text="Account on hold" tone="bad" /> : null}
      </View>
      <JobReports jobId={id} open={openReport} />
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
      {j.status === 'cancelled' ? <Notice tone="warn" title={j.cancelled_by_party === 'client' ? 'Cancelled by the client' : j.cancelled_by_party === 'us' ? 'Cancelled by us' : 'Cancelled'}
        lines={[j.cancel_note ?? hist.find(h => h.field === 'status')?.reason ?? 'Cancelled by the office.']} /> : null}
      {j.status === 'closed' ? <Billing j={j} o={o} canDocs={canDocs} /> : null}

      {c ? <MachineMoves v={c} /> : null}
      <Heading>Visits</Heading>
      {c?.visits.length ? c.visits.map((x, i) => (
        <Card key={i}>
          <Text style={[st.body, { fontWeight: '700' }]}>Visit {i + 1}{x.place === 'workshop' ? ' · in the workshop' : ''}{x.state === 'continue_later' ? ' · continue later' : x.state === 'uplifted' ? ' · machine uplifted' : ''}</Text>
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
              <Choice options={['breakdown', 'planned_maintenance', 'installation', 'quote_visit', 'follow_up', 'workshop_repair'] as const} value={type} onChange={setType} labels={TYPE} />
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

/** A closed job: where the money stands, and closing it at no charge (warranty, callback, ...) instead of invoicing it. */
function Billing({ j, o, canDocs }: { j: OfficeJob; o: OfficeHook; canDocs: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<NoChargeReason | ''>('');
  const [note, setNote] = useState('');
  const [ans, setAns] = useState<Answer | null>(null);
  const x = jobOutcome(j);
  const send = async (method: 'POST' | 'DELETE', body?: object) => {
    const r = await o.send(method, `/jobs/${j.id}/no-charge`, body ?? {});
    setAns(r);
    if (r.ok) { setOpen(false); setReason(''); setNote(''); }
  };
  if (j.billing === 'no_charge') return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>Closed at no charge</Text>
        <Pill text={NO_CHARGE_REASONS[j.no_charge_reason as NoChargeReason] ?? j.no_charge_reason ?? ''} tone="good" />
      </View>
      {j.no_charge_note ? <Body>{j.no_charge_note}</Body> : null}
      <Text style={st.small}>It is off the To invoice list. Who decided it is under Changes by the office.</Text>
      <Reasons a={ans} />
      {canDocs ? <Button label="Take off no charge (invoice it after all)" kind="quiet" onPress={() => send('DELETE')} /> : null}
    </Card>
  );
  const canNoCharge = canDocs && (j.billing === 'not_invoiced' || !j.billing);
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>Invoicing</Text>
        <Pill text={x.label} tone={x.tone} />
      </View>
      <Text style={st.small}>{j.billing === 'draft_invoice' ? `Invoice ${j.invoice_number} is a draft: send it from Documents, or cancel the draft if the job is not charged.`
        : j.billing === 'invoiced' ? `Invoice ${j.invoice_number} was sent${j.invoice_status === 'paid' ? ' and paid' : ''}.`
        : j.billing === 'credited' ? `Invoice ${j.invoice_number} was credited.` : 'Done and waiting to be invoiced (it is on the To invoice list).'}</Text>
      {canNoCharge && !open ? <Button label="Close at no charge" kind="secondary" onPress={() => setOpen(true)} /> : null}
      {open ? (
        <>
          <Label>Why is there no charge?</Label>
          <Choice options={Object.keys(NO_CHARGE_REASONS) as NoChargeReason[]} value={reason as NoChargeReason} onChange={setReason} labels={NO_CHARGE_REASONS} />
          <Field label={reason === 'other' ? 'Say why' : 'Note (optional)'} value={note} onChangeText={setNote} placeholder="e.g. Same compressor we fitted last month" />
          <Reasons a={ans} />
          <Button label="Close at no charge" disabled={!reason || (reason === 'other' && note.trim().length < 3)} onPress={() => send('POST', { reason, note: note.trim() || undefined })} />
          <Button label="Cancel" kind="quiet" onPress={() => { setOpen(false); setAns(null); }} />
        </>
      ) : <Reasons a={ans} />}
    </Card>
  );
}

function CancelJob({ j, o, done }: { j: OfficeJob; o: OfficeHook; done: () => void }) {
  const [note, setNote] = useState('');
  const [by, setBy] = useState<'client' | 'us' | ''>('');
  const [ans, setAns] = useState<Answer | null>(null);
  return (
    <Card style={{ borderColor: C.bad }}>
      <Heading>Cancel job {j.job_number}</Heading>
      <Text style={st.small}>It leaves the technician's day and is kept on record. Stock booked for it must come back to the stockroom.</Text>
      <Label>Who cancelled?</Label>
      <Choice options={['client', 'us'] as const} value={by as 'client' | 'us'} onChange={setBy} labels={{ client: 'The client', us: 'Us' }} />
      <Field label="Why is it cancelled?" value={note} onChangeText={setNote} placeholder={by === 'us' ? 'e.g. Logged twice' : 'e.g. Client fixed it themselves'} />
      <Reasons a={ans} />
      <Button label="Cancel job" kind="danger" disabled={!by || note.trim().length < 5} onPress={async () => { const r = await o.send('POST', `/jobs/${j.id}/cancel`, { note: note.trim(), by }); setAns(r); if (r.ok) done(); }} />
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

// ---- People (the CEO's positions) -------------------------------------------------------------------

function PeopleList({ o, open, openLeaver, add }: { o: OfficeHook; open: (id: string) => void; openLeaver: (id: string) => void; add: () => void }) {
  const p = o.d.people;
  const [q, setQ] = useState('');
  if (!p) return <Body quiet>Loading…</Body>;
  const shown = p.people.filter(x => !q.trim() || `${x.full_name} ${x.position} ${x.tradeLabel ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const groups = p.positions.map(pos => ({ pos, people: shown.filter(x => x.login_level === pos.level) })).filter(g => g.people.length);
  return (
    <>
      {p.canAdd ? <Button label="Add a person" kind="secondary" onPress={add} /> : null}
      <TextInput value={q} onChangeText={setQ} placeholder="Search name, position or trade" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search people" />
      {groups.map(g => (
        <View key={g.pos.level} style={{ gap: 6 }}>
          <Label>{g.pos.label} ({g.people.length})</Label>
          {g.people.map(x => (
            <Pressable key={x.id} onPress={() => open(x.id)} accessibilityRole="button" accessibilityLabel={`Person ${x.full_name}`}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 52, borderRadius: 8, backgroundColor: pressed ? C.panel2 : C.panel, borderWidth: 1, borderColor: C.line })}>
              <Avatar id={x.photo_id} name={x.full_name} size={34} />
              <Text style={[st.body, { fontWeight: '700', flex: 1 }]}>{x.full_name}</Text>
              {x.login && LOGIN_PILL[x.login] ? <View><Pill text={LOGIN_PILL[x.login]!.text} tone={LOGIN_PILL[x.login]!.tone} /></View> : null}
              {x.tradeLabel ? <Text style={st.small}>{x.tradeLabel}</Text> : null}
            </Pressable>
          ))}
        </View>
      ))}
      {p.canManage || p.canSetPositions ? <TerminatedStaff open={openLeaver} /> : null}
    </>
  );
}

function PersonDetail({ id, o, ask, ended }: { id: string; o: OfficeHook; ask?: (toId: string) => void; ended: () => void }) {
  const p = o.d.people;
  const x = p?.people.find(y => y.id === id);
  const [ans, setAns] = useState<Answer | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [extra, setExtra] = useState(false);
  const prof = useProfile(id);
  const sess = useStore().session;
  const me = sess?.user.id;
  const canPay = sess?.user.level === 'creator' || !!sess?.user.work?.pay;
  if (!x || !p) return <Body quiet>Not found.</Body>;
  const manage = !!p.canManage;
  const setsPos = !!(p.canSetPositions ?? manage);
  const settable = p.settablePositions ?? (manage ? p.positions.map(pos => pos.level) : []);
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
      {canPay && x.login_level !== 'creator' ? <PayCard key={`pay-${x.id}`} userId={x.id} name={first} isTech={isTech} /> : null}
      <Heading>Position{isTech ? ' and trade' : ''}</Heading>
      <Card>
        <Select label="Position" value={x.login_level} disabled={!setsPos || x.login_level === 'creator' || x.id === me && !manage || !settable.includes(x.login_level)}
          options={p.positions.filter(pos => settable.includes(pos.level) || pos.level === x.login_level).map(pos => ({ value: pos.level, label: pos.label }))} onChange={v => put(`/access/users/${x.id}/position`, { position: v }, `${first} is now ${p.positions.find(pos => pos.level === v)?.label}`)} />
        {isTech ? (
          <Select label="Trade" value={x.trade ?? null} disabled={!setsPos} placeholder="Not set"
            options={(p.trades ?? []).map(t => ({ value: t.key, label: t.label }))} onChange={v => put(`/access/users/${x.id}/trade`, { trade: v }, `${first} is now ${(p.trades ?? []).find(t => t.key === v)?.label}`)} />
        ) : null}
        {!setsPos ? <Text style={st.small}>Only the CEO or HR can change these.</Text>
          : !manage ? <Text style={st.small}>HR sets technician, admin, department manager or stock controller. Mechanic, HR, director and CEO positions are the CEO's.</Text> : null}
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
      {p.canLogins ? <LoginCard key={`login-${x.id}`} userId={x.id} name={x.full_name} phone={prof.p?.contact?.phone} changed={() => o.load?.()} /> : null}
      {prof.p?.canTerminate ? <EndEmployment id={x.id} name={x.full_name} done={ended} /> : null}
    </>
  );
}

// ---- Stores ------------------------------------------------------------------------------------

function NewStore({ o, done }: { o: OfficeHook; done: () => void }) {
  const [client, setClient] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [where, setWhere] = useState('');
  const [ans, setAns] = useState<Answer | null>(null);
  // Paste straight from Google Maps: "-28.7465, 32.0584". Optional: without it the address is found on the map.
  const pt = where.trim() ? pointFrom(where) : null;
  const lat = pt?.lat ?? null;
  const lng = pt?.lng ?? null;
  const clients = [...new Set(o.d.stores.map(s => s.client))];
  return (
    <>
      <Heading>Add a store</Heading>
      <Field label="Client" value={client} onChangeText={setClient} placeholder="e.g. Spar" autoCapitalize="words" />
      {clients.length ? <Choice options={clients} value={clients.find(c => c === client)} onChange={setClient} /> : null}
      <Field label="Store name" value={name} onChangeText={setName} placeholder="e.g. Spar Arboretum" autoCapitalize="words" />
      <Field label="Address" value={address} onChangeText={setAddress} />
      <Field label="Where it is (optional: paste from Google Maps)" value={where} onChangeText={setWhere} placeholder="-28.7465, 32.0584"
        hint={lat != null ? `Latitude ${lat}, longitude ${lng}. The technician's Arrived is checked within 150 m of this point.` : where.trim() ? 'Paste the two numbers, like -28.7465, 32.0584' : 'Leave it empty: the app finds the address on the map. Or right-click the store in Google Maps and copy the numbers.'} />
      <Reasons a={ans} />
      <Button label="Add store" onPress={async () => {
        if (where.trim() && lat == null) { setAns({ ok: false, reasons: ['paste the point from Google Maps, like -28.7465, 32.0584'] }); return; }
        if (lat == null && !address.trim()) { setAns({ ok: false, reasons: ['the address (the app finds it on the map), or the point from Google Maps'] }); return; }
        const r = await o.send('POST', '/office/stores', { client: client.trim(), name: name.trim(), ...(address.trim() ? { address: address.trim() } : {}), ...(lat != null ? { lat, lng } : {}) });
        setAns(r);
        if (r.ok) done();
      }} />
      <Button label="Cancel" kind="quiet" onPress={done} />
    </>
  );
}
