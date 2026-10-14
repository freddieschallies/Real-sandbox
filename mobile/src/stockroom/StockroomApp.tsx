// The stock controller's app. Phone: tabs at the bottom, list then detail. Desktop (wide screen):
// menu, list and the open request side by side. Nothing leaves or enters the stockroom without this.
import { PurchaseOrderList } from '../office/PurchaseOrders.tsx';
import { KitPeople, StockPersonView, type StockPerson } from '../staff/Staff.tsx';
import { ToolStore } from './ToolStore.tsx';
import { OrderList, PartDetail, Thumb, useOrderList } from './Parts.tsx';
import { WorkshopAdd, WorkshopItem, WorkshopList, useWorkshop } from '../fleet/Workshop.tsx';
import { BottomTabs } from '../BottomTabs.tsx';
import { usePhoneMenu } from '../menu.tsx';
import { ModeToggle } from '../appearance.tsx';
import { SearchButton, SearchPanel } from '../search/Search.tsx';
import { StockTakeTab } from './StockTake.tsx';
import { SupplierList, useStockOrders } from './Ordering.tsx';
import { HelpLink, HelpPanel } from '../help/Help.tsx';
import { BrandLogo } from '../brand.tsx';
import React, { useState } from 'react';
import { Image, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Field, Heading, Label, Notice, Pill, Select, Stepper, rand, st } from '../ui.tsx';
import { SyncPill } from '../screens/SyncPill.tsx';
import { C, S } from '../theme.ts';
import { CATEGORY_LABEL, useStockroom, type Activity, type Category, type Holding, type RoomItem } from './useStockroom.ts';
import { Choice } from '../ui.tsx';
import type { StockRequest, StockReturn } from '../types.ts';

// The stockroom's own colour, so nobody confuses it with the technician app.
const K = { band: '#1E6F6A', bandText: '#E8FFFB', tick: '#3FB57A' };

type Tab = 'issue' | 'receive' | 'pos' | 'room' | 'order' | 'count' | 'suppliers' | 'people' | 'workshop' | 'tools' | 'live' | 'items';
type Sel = { kind: 'issue'; id: string } | { kind: 'return'; id: string } | { kind: 'item'; id: string } | { kind: 'delivery' } | { kind: 'ws'; id: string } | { kind: 'wsadd' } | { kind: 'part'; id: string } | { kind: 'kit'; id: string; p: StockPerson } | null;
type Photo = { id: string; uri: string; mime: string };

const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function StockroomApp() {
  const s = useStore();
  const ins = useSafeAreaInsets();
  const menu = usePhoneMenu();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const room = useStockroom();
  const ws = useWorkshop();
  const ol = useOrderList();
  const [tab, setTab] = useState<Tab>('issue');
  const [sel, setSel] = useState<Sel>(null);
  const [searching, setSearching] = useState(false);
  const [helping, setHelping] = useState(false);
  const [kitTick, setKitTick] = useState(0);
  const o = room.ctl.overview;
  // Standing in for the stock controller (an admin, when he is out): issuing stock and tools only.
  const u = s.session?.user;
  const cover = !!u && u.level !== 'stockroom' && !u.stockDuty && !!u.stockCover;
  const COVER: Tab[] = ['issue', 'tools', 'people'];

  const allTabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'issue', label: 'To issue', count: room.ctl.issues.length },
    { key: 'receive', label: 'To receive', count: room.ctl.returns.length },
    { key: 'pos', label: 'Purchase orders' },
    { key: 'room', label: 'Stock' },
    { key: 'order', label: 'To order', count: ol.d?.toOrder.length },
    { key: 'count', label: 'Stock take' },
    { key: 'suppliers', label: 'Suppliers' },
    { key: 'people', label: 'People' },
    { key: 'workshop', label: 'Workshop', count: ws.data?.belowMin },
    { key: 'tools', label: 'Tool store' },
    { key: 'live', label: 'Live', count: (room.ctl.activity ?? []).filter(a => !room.ctl.seenActivityAt || a.at > room.ctl.seenActivityAt).length },
    { key: 'items', label: 'New items', count: o?.newItems ?? room.ctl.room.filter(i => i.needsReview).length },
  ];
  const tabs = cover ? allTabs.filter(t => COVER.includes(t.key)) : allTabs;
  // What others did in the stockroom while the stock controller was out: since his own last stockroom
  // movement, in the last three days.
  const acts = room.ctl.activity ?? [];
  const mineLast = acts.filter(a => a.by === u?.name && !a.byStandIn).reduce((m, a) => (a.at > m ? a.at : m), '');
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const away = cover ? [] : acts.filter(a => a.byStandIn && a.at > mineLast && a.at > since);

  const list = (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 40 }}>
      {cover ? <Notice tone="info" title="Standing in for the stock controller" lines={[
        'What you issue, book out or sign back is under your name, and the stock controller is told.',
        'Receiving deliveries and returns, and stock counts, wait for him.',
      ]} /> : null}
      {away.length ? (
        <Notice tone="warn" title={`While you were out: ${[...new Set(away.map(a => `${a.by} (${a.byStandIn})`))].join(', ')}`}
          lines={[`${away.length} stockroom movement${away.length > 1 ? 's' : ''} under their name: see Live. Their issues are marked in the Issued register.`]} />
      ) : null}
      {tab === 'issue' ? <IssueTab waiting={room.ctl.issues} issued={room.ctl.issued ?? []} open={id => setSel({ kind: 'issue', id })} selected={sel?.kind === 'issue' ? sel.id : null} /> : null}
      {tab === 'pos' ? <PurchaseOrderList /> : null}
      {tab === 'receive' ? <ReturnList items={room.ctl.returns} open={id => setSel({ kind: 'return', id })} selected={sel?.kind === 'return' ? sel.id : null} /> : null}
      {tab === 'room' ? <RoomList items={room.ctl.room} holdings={room.ctl.holdings ?? []} onDelivery={() => setSel({ kind: 'delivery' })} onPart={id => setSel({ kind: 'part', id })} /> : null}
      {tab === 'count' ? <StockTakeTab /> : null}
      {tab === 'suppliers' ? <SupplierList /> : null}
      {tab === 'order' ? <OrderList ol={ol} open={id => setSel({ kind: 'part', id })} /> : null}
      {tab === 'people' ? <KitPeople open={p => setSel({ kind: 'kit', id: p.id, p })} selected={sel?.kind === 'kit' ? sel.id : null} tick={kitTick} /> : null}
      {tab === 'workshop' ? <WorkshopList ws={ws} role="controller" open={id => setSel({ kind: 'ws', id })} onAdd={() => setSel({ kind: 'wsadd' })} /> : null}
      {tab === 'tools' ? <ToolStore /> : null}
      {tab === 'live' ? <LiveFeed items={room.ctl.activity ?? []} seen={room.ctl.seenActivityAt ?? null} invoices={room.ctl.invoices} /> : null}
      {tab === 'items' ? <NewItemList items={room.ctl.room.filter(i => i.needsReview)} open={id => setSel({ kind: 'item', id })} /> : null}
      {!wide ? <Button label="Sign out" kind="quiet" onPress={s.signOut} disabled={s.waiting > 0} /> : null}
      {room.ctl.loadedAt ? <Text style={st.small}>Updated {when(room.ctl.loadedAt)}</Text> : <Text style={st.small}>{room.loading ? 'Loading…' : 'Needs signal to load.'}</Text>}
      <HelpLink onPress={() => setHelping(true)} />
    </ScrollView>
  );

  const detail = (() => {
    if (!sel) return null;
    const close = () => setSel(null);
    if (sel.kind === 'issue') {
      const r = room.ctl.issues.find(x => x.id === sel.id);
      return r ? <IssueDetail key={r.id} r={r} room={room} done={close} /> : null;
    }
    if (sel.kind === 'return') {
      const r = room.ctl.returns.find(x => x.id === sel.id);
      return r ? <ReturnDetail key={r.id} r={r} room={room} done={close} /> : null;
    }
    if (sel.kind === 'item') {
      const it = room.ctl.room.find(x => x.id === sel.id);
      return it ? <NameItem key={it.id} it={it} room={room} done={close} /> : null;
    }
    if (sel.kind === 'part') {
      const it = room.ctl.room.find(x => x.id === sel.id);
      return it ? <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60 }}><PartDetail key={it.id} it={it} done={close} reload={() => { room.load(); ol.load(); }} /></ScrollView> : null;
    }
    if (sel.kind === 'kit') return <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60 }}><StockPersonView key={sel.id} p={sel.p} holdings={room.ctl.holdings ?? []} onChange={() => { setKitTick(t => t + 1); room.load(); }} /></ScrollView>;
    if (sel.kind === 'ws') return <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60 }}><WorkshopItem key={sel.id} id={sel.id} ws={ws} role="controller" done={close} /></ScrollView>;
    if (sel.kind === 'wsadd') return <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60 }}><WorkshopAdd ws={ws} done={() => { close(); room.load(); }} /></ScrollView>;
    return <Delivery room={room} done={close} />;
  })();

  const header = (
    <View style={{ backgroundColor: K.band, paddingTop: ins.top, paddingHorizontal: S.pad, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {!wide && sel ? (
        <Pressable onPress={() => setSel(null)} accessibilityRole="button" accessibilityLabel="Back" hitSlop={10}>
          <Text style={{ color: K.bandText, fontSize: 34 }}>‹</Text>
        </Pressable>
      ) : null}
      <BrandLogo height={wide ? 36 : 28} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: K.bandText, fontSize: wide ? 22 : 19, fontWeight: '800' }}>Stockroom{cover ? ' · standing in' : ''}</Text>
        <Text numberOfLines={1} style={{ color: K.bandText, opacity: 0.8 }}>{s.session?.user.name} · {s.session?.company.name}</Text>
      </View>
      <SyncPill />
      <SearchButton color={K.bandText} onPress={() => setSearching(true)} />
      <ModeToggle color={K.bandText} />
      <Pressable onPress={room.load} accessibilityRole="button" accessibilityLabel="Refresh" hitSlop={8}
        style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: K.bandText }}>
        <Text style={{ color: K.bandText, fontWeight: '700' }}>{room.loading ? '…' : 'Refresh'}</Text>
      </Pressable>
      {wide ? (
        <Pressable onPress={s.signOut} accessibilityRole="button" hitSlop={8}><Text style={{ color: K.bandText }}>Sign out</Text></Pressable>
      ) : null}
    </View>
  );

  if (wide) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {header}
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ width: 210, borderRightWidth: 1, borderRightColor: C.line, padding: 12, gap: 6 }}>
            {tabs.map(t => <SideTab key={t.key} t={t} on={tab === t.key} press={() => { if (tab === 'live') room.seenActivity(); setTab(t.key); setSel(null); }} />)}
          </View>
          <View style={{ width: 420, borderRightWidth: 1, borderRightColor: C.line }}>{list}</View>
          <View style={{ flex: 1 }}>
            {detail ?? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Body quiet>Choose something on the left.</Body></View>}
          </View>
        </View>
        {searching ? <SearchPanel places={[...tabs.map(t => ({ key: t.key, label: t.label, open: () => { setTab(t.key); setSel(null); } })), { key: 'help', label: 'How to use the app', open: () => setHelping(true) }]} open={{ stock: id => { setTab('room'); setSel(room.ctl.room.some(x => x.id === id) ? { kind: 'part', id } : null); }, po: () => { setTab('pos'); setSel(null); } }} close={() => setSearching(false)} /> : null}
        {helping ? <HelpPanel close={() => setHelping(false)} /> : null}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {header}
      <View style={{ flex: 1 }}>{detail ?? list}</View>
      {!sel ? (
        <BottomTabs tabs={tabs} current={tab} onSelect={k => { if (tab === 'live') room.seenActivity(); setTab(k); }} accent={K.band} bottom={ins.bottom} pinned={menu.pinned} />
      ) : null}
      {searching ? <SearchPanel places={[...tabs.map(t => ({ key: t.key, label: t.label, open: () => { setTab(t.key); setSel(null); } })), { key: 'help', label: 'How to use the app', open: () => setHelping(true) }]} open={{ stock: id => { setTab('room'); setSel(room.ctl.room.some(x => x.id === id) ? { kind: 'part', id } : null); }, po: () => { setTab('pos'); setSel(null); } }} close={() => setSearching(false)} /> : null}
        {helping ? <HelpPanel close={() => setHelping(false)} /> : null}
    </View>
  );
}

function SideTab({ t, on, press }: { t: { label: string; count?: number }; on: boolean; press: () => void }) {
  return (
    <Pressable onPress={press} accessibilityRole="tab" accessibilityState={{ selected: on }}
      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, minHeight: 48, borderRadius: 8, backgroundColor: on ? C.panel2 : 'transparent' }}>
      <Text style={{ color: on ? C.text : C.quiet, fontWeight: '700', flex: 1 }}>{t.label}</Text>
      {t.count ? <Pill text={String(t.count)} tone="warn" /> : null}
    </Pressable>
  );
}

// ---- Requests to issue, and the register of what was issued to whom -----------------

function IssueTab({ waiting, issued, open, selected }: { waiting: StockRequest[]; issued: StockRequest[]; open: (id: string) => void; selected: string | null }) {
  const [view, setView] = useState<'waiting' | 'issued'>('waiting');
  return (
    <>
      <Choice options={['waiting', 'issued'] as const} value={view} onChange={setView}
        labels={{ waiting: `Waiting (${waiting.length})`, issued: 'Issued register' }} />
      {view === 'waiting' ? <IssueList items={waiting} open={open} selected={selected} /> : <IssuedRegister items={issued} />}
    </>
  );
}

function IssuedRegister({ items }: { items: StockRequest[] }) {
  const [q, setQ] = useState('');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter(r => words.every(w => `${r.technician} ${r.job_number ?? ''} ${r.store ?? ''} ${r.lines.map(l => `${l.code} ${l.description}`).join(' ')}`.toLowerCase().includes(w)));
  return (
    <>
      <Field label="Search" value={q} onChangeText={setQ} placeholder="technician, job number or item" autoCorrect={false} />
      {!shown.length ? <Body quiet>Nothing issued{q ? ' that matches' : ' yet'}.</Body> : null}
      {shown.map(r => (
        <Card key={r.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{r.technician}</Text>
            <Text style={st.small}>{r.decided_at ? when(r.decided_at) : ''}</Text>
          </View>
          <Text style={st.small}>{r.job_number ? `Job #${r.job_number}${r.store ? ` · ${r.store}` : ''}` : 'Van stock'} · issued by {r.decided_by ?? '–'}</Text>
          {r.decidedByStandIn ? <Pill text={`${r.decidedByStandIn}, standing in for the stockroom`} tone="warn" /> : null}
          {r.lines.map(l => (
            <Text key={l.lineId} style={[st.body, (l.qtyIssued ?? 0) < l.qtyRequested && { color: C.warn }]}>
              {l.qtyIssued ?? 0}{(l.qtyIssued ?? 0) < l.qtyRequested ? ` of ${l.qtyRequested}` : ''} × {l.description} <Text style={st.small}>{l.code}</Text>
            </Text>
          ))}
          {r.note ? <Text style={st.small}>Note: {r.note}</Text> : null}
        </Card>
      ))}
    </>
  );
}


function IssueList({ items, open, selected }: { items: StockRequest[]; open: (id: string) => void; selected: string | null }) {
  if (!items.length) return <Body quiet>No stock requests waiting.</Body>;
  return <>{items.map(r => (
    <Card key={r.id} onPress={() => open(r.id)} style={selected === r.id ? { borderColor: K.band, borderWidth: 2 } : undefined} accessibilityLabel={`Request from ${r.technician}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{r.technician}</Text>
        <Text style={st.small}>{when(r.requested_at)}</Text>
      </View>
      <Text style={st.small}>Job #{r.job_number}{r.store ? ` · ${r.store}` : ''}</Text>
      <Body>{r.lines.map(l => `${l.qtyRequested} × ${l.code}`).join(', ')}</Body>
      {r.lines.some(l => l.inStockroom < l.qtyRequested) ? <Pill text="Short in stockroom" tone="bad" /> : null}
    </Card>
  ))}</>;
}

function IssueDetail({ r, room, done }: { r: StockRequest; room: ReturnType<typeof useStockroom>; done: () => void }) {
  // Pick list: each line is ticked when picked; quantity defaults to what was asked (or what is there).
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(r.lines.map(l => [l.lineId, Math.min(l.qtyRequested, Math.max(0, l.inStockroom))])));
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [photos, setPhotos] = useState<Record<string, Photo>>({});
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string[] | null>(null);
  const allTicked = r.lines.every(l => ticked[l.lineId]);
  const total = r.lines.reduce((n, l) => n + (qty[l.lineId] ?? 0), 0);

  return (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60 }}>
      <Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>{r.technician}</Text>
      <Body quiet>Job #{r.job_number}{r.store ? ` · ${r.store}` : ''} · asked {when(r.requested_at)}</Body>
      <Notice tone="info" title="Pick each item and tick it" lines={['Change the quantity if you give less. A photo is optional.']} />
      {problem ? <Notice tone="bad" title="Not yet" lines={problem} /> : null}
      {r.lines.map(l => (
        <PickLine key={l.lineId} title={l.description} sub={`${l.code} · asked ${l.qtyRequested} ${l.unit} · ${l.inStockroom} in stockroom`}
          short={l.inStockroom < l.qtyRequested} qty={qty[l.lineId] ?? 0} max={Math.min(l.qtyRequested, Math.max(0, l.inStockroom))}
          setQty={n => setQty(q => ({ ...q, [l.lineId]: n }))} ticked={!!ticked[l.lineId]} tick={() => setTicked(t => ({ ...t, [l.lineId]: !t[l.lineId] }))}
          photo={photos[l.lineId]} takePhoto={async () => { const p = await room.photo(); if (p) setPhotos(x => ({ ...x, [l.lineId]: p })); }} />
      ))}
      {!rejecting ? (
        <>
          <Field label="Note (optional)" value={note} onChangeText={setNote} />
          <Button label={allTicked ? `Issue to ${r.technician}` : `Tick all ${r.lines.length} lines first`} disabled={!allTicked}
            onPress={() => { if (total <= 0) { setProblem(['nothing to issue: reject the request instead']); return; } room.issue(r, qty, photos, note.trim() || undefined); done(); }} />
          <Button label="Reject request" kind="danger" onPress={() => setRejecting(true)} />
        </>
      ) : (
        <>
          <Field label="Why is it rejected?" value={reason} onChangeText={setReason} multiline />
          <Button label="Reject" kind="danger" disabled={reason.trim().length < 5} onPress={() => { room.reject(r, reason.trim()); done(); }} />
          <Button label="Cancel" kind="quiet" onPress={() => setRejecting(false)} />
        </>
      )}
    </ScrollView>
  );
}

function PickLine(p: { title: string; sub: string; short?: boolean; qty: number; max: number; setQty: (n: number) => void; ticked: boolean; tick: () => void; photo?: Photo; takePhoto: () => void }) {
  return (
    <Card style={p.ticked ? { borderColor: K.tick, borderWidth: 2 } : undefined}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable onPress={p.tick} accessibilityRole="checkbox" accessibilityState={{ checked: p.ticked }} accessibilityLabel={`Tick ${p.title}`} hitSlop={8}
          style={{ width: 44, height: 44, borderRadius: 10, borderWidth: 2, borderColor: p.ticked ? K.tick : C.line, backgroundColor: p.ticked ? K.tick : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: C.bg, fontSize: 24, fontWeight: '900' }}>{p.ticked ? '✓' : ''}</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={[st.body, { fontWeight: '700' }]}>{p.title}</Text>
          <Text style={[st.small, p.short && { color: C.bad }]}>{p.sub}</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Stepper value={p.qty} max={p.max} onChange={p.setQty} label={p.title} />
        <View style={{ flex: 1 }} />
        {p.photo ? <Image source={{ uri: p.photo.uri }} style={{ width: 56, height: 56, borderRadius: 8 }} /> : null}
        <Button label={p.photo ? 'Retake' : 'Photo'} kind="quiet" onPress={p.takePhoto} style={{ minHeight: 44 }} />
      </View>
    </Card>
  );
}

// ---- Returns to receive -------------------------------------------------------------

function ReturnList({ items, open, selected }: { items: StockReturn[]; open: (id: string) => void; selected: string | null }) {
  if (!items.length) return <Body quiet>No returns waiting.</Body>;
  return <>{items.map(r => (
    <Card key={r.id} onPress={() => open(r.id)} style={selected === r.id ? { borderColor: K.band, borderWidth: 2 } : undefined} accessibilityLabel={`Return from ${r.technician ?? 'technician'}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{r.technician ?? 'Technician'}</Text>
        <Text style={st.small}>{when(r.requested_at)}</Text>
      </View>
      <Body>{r.lines.map(l => `${l.qty} × ${l.code}`).join(', ')}</Body>
    </Card>
  ))}</>;
}

function ReturnDetail({ r, room, done }: { r: StockReturn; room: ReturnType<typeof useStockroom>; done: () => void }) {
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(r.lines.map(l => [l.lineId, l.qty])));
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [photos, setPhotos] = useState<Record<string, Photo>>({});
  const [note, setNote] = useState('');
  const allTicked = r.lines.every(l => ticked[l.lineId]);
  const short = r.lines.filter(l => (qty[l.lineId] ?? 0) < l.qty);
  return (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60 }}>
      <Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>{r.technician ?? 'Technician'}</Text>
      <Body quiet>Sent back {when(r.requested_at)}</Body>
      <Notice tone="info" title="Count each item and tick it" lines={['Only what you tick comes off his name. Anything short stays on his name and he is asked about it.']} />
      {r.lines.map(l => (
        <PickLine key={l.lineId} title={l.description} sub={`${l.code} · he sent ${l.qty}${l.jobNumber ? ` · job #${l.jobNumber}` : ' · van stock'}`}
          qty={qty[l.lineId] ?? 0} max={l.qty} setQty={n => setQty(q => ({ ...q, [l.lineId]: n }))}
          ticked={!!ticked[l.lineId]} tick={() => setTicked(t => ({ ...t, [l.lineId]: !t[l.lineId] }))}
          photo={photos[l.lineId]} takePhoto={async () => { const p = await room.photo(); if (p) setPhotos(x => ({ ...x, [l.lineId]: p })); }} />
      ))}
      {short.length && allTicked ? <Notice tone="warn" title="Short" lines={short.map(l => `${l.code}: ${qty[l.lineId] ?? 0} of ${l.qty}`)} /> : null}
      <Field label="Note (optional)" value={note} onChangeText={setNote} />
      <Button label={allTicked ? 'Confirm received' : `Tick all ${r.lines.length} lines first`} disabled={!allTicked}
        onPress={() => { room.receive(r, qty, photos, note.trim() || undefined); done(); }} />
    </ScrollView>
  );
}

// ---- The stockroom, deliveries and new items ------------------------------------------

// The whole inventory: what is in the stockroom and exactly who holds the rest, for which job.
function RoomList({ items, holdings, onDelivery, onPart }: { items: RoomItem[]; holdings: Holding[]; onDelivery: () => void; onPart: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [view, setView] = useState<'item' | 'tech'>('item');
  const [cat, setCat] = useState<Category>('stock');
  const [open, setOpen] = useState<string | null>(null);
  const catOf = (i: RoomItem): Category => i.category ?? 'stock';
  const count = (c: Category) => items.filter(i => catOf(i) === c).length;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (t: string) => words.every(w => t.toLowerCase().includes(w));
  const totalOut = holdings.reduce((n, h) => n + h.qty, 0);
  const mustBack = holdings.filter(h => h.mustReturn);
  const techs = [...new Set(holdings.map(h => h.technician))];
  return (
    <>
      <Button label="Receive a delivery" onPress={onDelivery} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Card style={{ flex: 1 }}><Label>Stockroom</Label><Text style={big}>{items.filter(i => catOf(i) === cat).reduce((n, i) => n + i.inStockroom, 0)}</Text></Card>
        {cat === 'stock' ? (
          <>
            <Card style={{ flex: 1 }}><Label>With techs</Label><Text style={big}>{totalOut}</Text></Card>
            <Card style={{ flex: 1, borderColor: mustBack.length ? C.bad : C.line }}><Label>To return</Label><Text style={[big, mustBack.length ? { color: C.bad } : null]}>{mustBack.reduce((n, h) => n + h.qty, 0)}</Text></Card>
          </>
        ) : <Card style={{ flex: 2 }}><Label>On people's names</Label><Text style={big}>{items.filter(i => catOf(i) === cat).reduce((n, i) => n + (i.onNames ?? 0), 0)}</Text></Card>}
      </View>
      <Choice options={['stock', 'tool', 'ppe'] as const} value={cat} onChange={c => { setCat(c); if (c !== 'stock') setView('item'); }}
        labels={{ stock: `Stock (${count('stock')})`, tool: `Tools (${count('tool')})`, ppe: `PPE (${count('ppe')})` }} />
      {cat === 'stock' ? <Choice options={['item', 'tech'] as const} value={view} onChange={setView} labels={{ item: 'By item', tech: 'By technician' }} />
        : <Text style={st.small}>{CATEGORY_LABEL[cat]} are issued to a person by name (People tab), not booked onto jobs.</Text>}
      <Field label="Search" value={q} onChangeText={setQ} placeholder={view === 'item' ? 'code or description' : 'technician, job or item'} autoCorrect={false} />
      {view === 'item' ? items.filter(i => catOf(i) === cat && hit(`${i.code} ${i.description}`)).map(i => {
        const out = holdings.filter(h => h.stockItemId === i.id);
        const isOpen = open === i.id;
        return (
          <Card key={i.id} onPress={() => setOpen(isOpen ? null : i.id)} accessibilityLabel={`${i.code} stock`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Thumb id={i.photoId} size={44} />
              <View style={{ flex: 1 }}>
                <Text style={[st.body, { fontWeight: '700' }]}>{i.description}</Text>
                <Text style={st.small}>{i.code} · {i.unit}{i.needsReview ? ' · needs a code' : ''}{i.minQty ? ` · min ${i.minQty}` : ''}</Text>
                {i.belowMin ? <Text style={[st.small, { color: C.warn }]}>{i.ordered ? 'Below minimum · ordered' : 'Below minimum · on the order list'}</Text> : null}
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ color: i.inStockroom <= 0 ? C.bad : C.text, fontSize: 22, fontWeight: '800' }}>{i.inStockroom}</Text>
                <Text style={st.small}>{catOf(i) === 'stock' ? `${i.withTechnicians} with techs · ${i.inStockroom + i.withTechnicians} total` : `${i.onNames ?? 0} on names · ${i.inStockroom + (i.onNames ?? 0)} total`}</Text>
              </View>
            </View>
            {isOpen ? (
              <>
                {i.lastUsed ? <Text style={st.small}>Last used: {i.lastUsed.jobNumber ? `job ${i.lastUsed.jobNumber}${i.lastUsed.store ? `, ${i.lastUsed.store}` : ''}` : i.lastUsed.vehicle ? `vehicle ${i.lastUsed.vehicle}` : ''}{i.lastUsed.technician ? ` · ${i.lastUsed.technician}` : ''} · {new Date(i.lastUsed.at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}</Text> : <Text style={st.small}>Not used yet.</Text>}
                {out.length ? out.map((h, n) => <HoldingRow key={n} h={h} who />) : <Text style={st.small}>None out with technicians.</Text>}
                <Button label="Open part: photo, minimum, history" kind="secondary" onPress={() => onPart(i.id)} style={{ minHeight: 44 }} />
              </>
            ) : null}
          </Card>
        );
      }) : techs.filter(t => holdings.some(h => h.technician === t && hit(`${t} ${h.code} ${h.description} ${h.jobNumber ?? ''} ${h.store ?? ''}`))).map(t => {
        const hs = holdings.filter(h => h.technician === t);
        const back = hs.filter(h => h.mustReturn).length;
        return (
          <Card key={t}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{t}</Text>
              {back ? <Pill text={`${back} to return`} tone="bad" /> : null}
            </View>
            {hs.map((h, n) => <HoldingRow key={n} h={h} />)}
          </Card>
        );
      })}
    </>
  );
}

const big = { get color() { return C.text; }, fontSize: 24, fontWeight: '800' as const };

function HoldingRow({ h, who }: { h: Holding; who?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, borderTopWidth: 1, borderTopColor: C.line }}>
      <Text style={{ color: h.mustReturn ? C.bad : C.text, fontWeight: '800', minWidth: 32 }}>{h.qty}</Text>
      <View style={{ flex: 1 }}>
        <Text style={st.body} numberOfLines={1}>{who ? h.technician : `${h.code} ${h.description}`}</Text>
        <Text style={st.small}>{h.jobNumber ? `Job #${h.jobNumber}${h.store ? ` · ${h.store}` : ''}${h.jobStatus === 'closed' ? ' · closed' : ''}` : 'Van stock'}{h.pendingReturn ? ` · ${h.pendingReturn} on its way back` : ''}</Text>
      </View>
      {h.mustReturn ? <Pill text="Return" tone="bad" /> : null}
    </View>
  );
}

// Live: every stock movement as it happens, newest first; new since you last looked are marked.
const FILTERS = ['all', 'use_on_job', 'assign', 'return', 'supplier_invoice', 'receive'] as const;
const FILTER_LABEL = { all: 'All', use_on_job: 'Used on jobs', assign: 'Issued', return: 'Returned', supplier_invoice: 'Invoices', receive: 'Deliveries' };
const TONE: Record<string, 'info' | 'good' | 'warn' | 'bad' | 'quiet'> = { use_on_job: 'warn', assign: 'info', return: 'good', supplier_invoice: 'quiet', receive: 'good' };

function LiveFeed({ items, seen, invoices }: { items: Activity[]; seen: string | null; invoices: ReturnType<typeof useStockroom>['ctl']['invoices'] }) {
  const [f, setF] = useState<typeof FILTERS[number]>('all');
  const shown = items.filter(a => f === 'all' || a.kind === f);
  return (
    <>
      <Body quiet>Updates every few seconds. Used on a job card = on the job, ready to invoice.</Body>
      <Choice options={FILTERS} value={f} onChange={setF} labels={FILTER_LABEL} />
      {!shown.length ? <Body quiet>Nothing yet.</Body> : null}
      {shown.map(a => {
        const fresh = !!seen && a.at > seen;
        return (
          <Card key={a.id} style={fresh ? { borderColor: C.accent, borderWidth: 2 } : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Pill text={a.what} tone={TONE[a.kind] ?? 'quiet'} />
              {fresh ? <Pill text="New" tone="warn" /> : null}
              <View style={{ flex: 1 }} />
              <Text style={st.small}>{when(a.at)}</Text>
            </View>
            <Text style={[st.body, { fontWeight: '700' }]}>{a.qty} × {a.description}</Text>
            {a.byStandIn ? <Text style={[st.small, { color: C.warn, fontWeight: '700' }]}>By {a.by} ({a.byStandIn}, standing in)</Text> : null}
            <Text style={st.small}>
              {[a.code, a.technician, a.jobNumber ? `job #${a.jobNumber}${a.store ? ` ${a.store}` : ''}` : null, a.reference, a.unitCostCents != null ? `@ ${rand(a.unitCostCents)}` : null].filter(Boolean).join(' · ')}
            </Text>
          </Card>
        );
      })}
      {f === 'supplier_invoice' ? <><Heading>Invoice details</Heading><InvoiceList invoices={invoices} /></> : null}
    </>
  );
}

function NewItemList({ items, open }: { items: RoomItem[]; open: (id: string) => void }) {
  if (!items.length) return <Body quiet>No new items to name.</Body>;
  return (
    <>
      <Body quiet>Items first seen on a supplier invoice. Give each a proper code and name.</Body>
      {items.map(i => (
        <Card key={i.id} onPress={() => open(i.id)} accessibilityLabel={`Name ${i.code}`}>
          <Text style={[st.body, { fontWeight: '700' }]}>{i.description}</Text>
          <Text style={st.small}>{i.code}{i.supplierCode ? ` · supplier code ${i.supplierCode}` : ''} · {i.withTechnicians} with techs</Text>
        </Card>
      ))}
    </>
  );
}

function NameItem({ it, room, done }: { it: RoomItem; room: ReturnType<typeof useStockroom>; done: () => void }) {
  const [code, setCode] = useState(it.supplierCode ?? '');
  const [desc, setDesc] = useState(it.description);
  const [unit, setUnit] = useState(it.unit);
  const [cat, setCat] = useState<Category>(it.category ?? 'stock');
  const taken = room.ctl.room.some(x => x.id !== it.id && x.code.toLowerCase() === code.trim().toLowerCase());
  return (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap }}>
      <Heading>Name {it.code}</Heading>
      <Field label="Our code" value={code} onChangeText={setCode} autoCapitalize="characters" hint={taken ? 'That code is already used' : undefined} />
      <Field label="Description" value={desc} onChangeText={setDesc} />
      <Field label="Unit" value={unit} onChangeText={setUnit} />
      <Label>Category</Label>
      <Choice options={['stock', 'tool', 'ppe'] as const} value={cat} onChange={setCat} labels={{ stock: 'Stock (parts)', tool: 'Tool', ppe: 'PPE' }} />
      <Button label="Save" disabled={code.trim().length < 2 || desc.trim().length < 2 || !unit.trim() || taken}
        onPress={() => { room.nameItem(it, { code: code.trim(), description: desc.trim(), unit: unit.trim(), category: cat }); done(); }} />
    </ScrollView>
  );
}

function Delivery({ room, done }: { room: ReturnType<typeof useStockroom>; done: () => void }) {
  const so = useStockOrders();
  const [po, setPo] = useState<string | null>(null);
  const [supplier, setSupplier] = useState('');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState<Photo | null>(null);
  const [q, setQ] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = room.ctl.room.filter(i => !i.needsReview && ((qty[i.id] ?? 0) > 0 || words.every(w => `${i.code} ${i.description}`.toLowerCase().includes(w))))
    .sort((a, b) => Number((qty[b.id] ?? 0) > 0) - Number((qty[a.id] ?? 0) > 0)).slice(0, 30);
  const lines = Object.entries(qty).filter(([, n]) => n > 0).map(([stockItemId, n]) => ({ stockItemId, qty: n }));
  return (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60 }}>
      <Heading>Receive a delivery</Heading>
      {(so.d?.orders ?? []).some(o => o.status === 'approved') ? (
        <Select label="Against a purchase order (optional)" value={po} placeholder="Not against a PO"
          options={(so.d?.orders ?? []).filter(o => o.status === 'approved').map(o => ({ value: o.id, label: `PO ${o.po_number} · ${o.supplier_name} · ${(o.lines ?? []).length} items` }))}
          onChange={v => {
            setPo(v);
            const o = so.d?.orders.find(x => x.id === v);
            if (o) { setSupplier(o.supplier_name); setQty(Object.fromEntries((o.lines ?? []).filter(l => l.stockItemId).map(l => [l.stockItemId!, l.qty]))); setQ(''); }
          }} />
      ) : null}
      <Field label="Supplier" value={supplier} onChangeText={setSupplier} />
      <Field label="Delivery note / invoice number" value={ref} onChangeText={setRef} autoCapitalize="characters" />
      {note ? <Image source={{ uri: note.uri }} style={{ width: '100%', height: 200, borderRadius: 8 }} resizeMode="contain" /> : null}
      <Button label={note ? 'Retake delivery note photo' : 'Photo of the delivery note (optional)'} kind="quiet" onPress={async () => setNote(await room.photo())} />
      <Label>What arrived</Label>
      <TextInput value={q} onChangeText={setQ} placeholder="Search items" placeholderTextColor={C.quiet} style={st.input} />
      {shown.map(i => (
        <View key={i.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56 }}>
          <View style={{ flex: 1 }}>
            <Text style={[st.body, { fontWeight: '700' }]}>{i.description}</Text>
            <Text style={st.small}>{i.code} · {i.inStockroom} in stockroom</Text>
          </View>
          <Stepper value={qty[i.id] ?? 0} onChange={n => setQty(x => ({ ...x, [i.id]: n }))} label={i.code} />
        </View>
      ))}
      <Button label={lines.length ? `Receive ${lines.length} line${lines.length > 1 ? 's' : ''} into the stockroom` : 'Receive'}
        disabled={!lines.length || supplier.trim().length < 2 || !ref.trim()}
        onPress={() => { room.delivery({ supplierName: supplier.trim(), reference: ref.trim(), lines, ...(po ? { purchaseOrderId: po } : {}) }, note); done(); }} />
    </ScrollView>
  );
}

function InvoiceList({ invoices }: { invoices: ReturnType<typeof useStockroom>['ctl']['invoices'] }) {
  if (!invoices.length) return <Body quiet>No supplier invoices booked by technicians yet.</Body>;
  return <>{invoices.map(i => (
    <Card key={i.id}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Text style={[st.body, { fontWeight: '700', flex: 1 }]}>{i.supplier_name} {i.invoice_number}</Text>
        <Text style={st.body}>{rand(i.total_cents)}</Text>
      </View>
      <Text style={st.small}>{i.technician ?? 'Technician'}{i.job_number ? ` · job #${i.job_number}` : ' · van stock'}{i.confirmed_at ? ` · ${when(i.confirmed_at)}` : ''}</Text>
      {i.changed_from_read ? <Pill text="Changed from what was read" tone="warn" /> : null}
      {i.lines?.map((l, n) => <Text key={n} style={st.small}>{l.qty} × {l.description} {l.unitPriceCents != null ? `@ ${rand(l.unitPriceCents)}` : ''}</Text>)}
    </Card>
  ))}</>;
}
