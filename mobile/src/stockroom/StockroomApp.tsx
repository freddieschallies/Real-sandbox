// The stock controller's app. Phone: tabs at the bottom, list then detail. Desktop (wide screen):
// menu, list and the open request side by side. Nothing leaves or enters the stockroom without this.
import React, { useState } from 'react';
import { Image, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Field, Heading, Label, Notice, Pill, Stepper, rand, st } from '../ui.tsx';
import { SyncPill } from '../screens/SyncPill.tsx';
import { C, S } from '../theme.ts';
import { useStockroom, type RoomItem } from './useStockroom.ts';
import type { StockRequest, StockReturn } from '../types.ts';

// The stockroom's own colour, so nobody confuses it with the technician app.
const K = { band: '#1E6F6A', bandText: '#E8FFFB', tick: '#3FB57A' };

type Tab = 'issue' | 'receive' | 'room' | 'items' | 'invoices';
type Sel = { kind: 'issue'; id: string } | { kind: 'return'; id: string } | { kind: 'item'; id: string } | { kind: 'delivery' } | null;
type Photo = { id: string; uri: string; mime: string };

const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function StockroomApp() {
  const s = useStore();
  const ins = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const room = useStockroom();
  const [tab, setTab] = useState<Tab>('issue');
  const [sel, setSel] = useState<Sel>(null);
  const o = room.ctl.overview;

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'issue', label: 'To issue', count: room.ctl.issues.length },
    { key: 'receive', label: 'To receive', count: room.ctl.returns.length },
    { key: 'room', label: 'Stockroom' },
    { key: 'items', label: 'New items', count: o?.newItems ?? room.ctl.room.filter(i => i.needsReview).length },
    { key: 'invoices', label: 'Invoices' },
  ];

  const list = (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 40 }}>
      {tab === 'issue' ? <IssueList items={room.ctl.issues} open={id => setSel({ kind: 'issue', id })} selected={sel?.kind === 'issue' ? sel.id : null} /> : null}
      {tab === 'receive' ? <ReturnList items={room.ctl.returns} open={id => setSel({ kind: 'return', id })} selected={sel?.kind === 'return' ? sel.id : null} /> : null}
      {tab === 'room' ? <RoomList items={room.ctl.room} onDelivery={() => setSel({ kind: 'delivery' })} /> : null}
      {tab === 'items' ? <NewItemList items={room.ctl.room.filter(i => i.needsReview)} open={id => setSel({ kind: 'item', id })} /> : null}
      {tab === 'invoices' ? <InvoiceList invoices={room.ctl.invoices} /> : null}
      {!wide ? <Button label="Sign out" kind="quiet" onPress={s.signOut} disabled={s.waiting > 0} /> : null}
      {room.ctl.loadedAt ? <Text style={st.small}>Updated {when(room.ctl.loadedAt)}</Text> : <Text style={st.small}>{room.loading ? 'Loading…' : 'Needs signal to load.'}</Text>}
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
    return <Delivery room={room} done={close} />;
  })();

  const header = (
    <View style={{ backgroundColor: K.band, paddingTop: ins.top, paddingHorizontal: S.pad, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {!wide && sel ? (
        <Pressable onPress={() => setSel(null)} accessibilityRole="button" accessibilityLabel="Back" hitSlop={10}>
          <Text style={{ color: K.bandText, fontSize: 34 }}>‹</Text>
        </Pressable>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={{ color: K.bandText, fontSize: 22, fontWeight: '800' }}>Stockroom</Text>
        <Text style={{ color: K.bandText, opacity: 0.8 }}>{s.session?.user.name} · {s.session?.company.name}</Text>
      </View>
      <SyncPill />
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
            {tabs.map(t => <SideTab key={t.key} t={t} on={tab === t.key} press={() => { setTab(t.key); setSel(null); }} />)}
          </View>
          <View style={{ width: 420, borderRightWidth: 1, borderRightColor: C.line }}>{list}</View>
          <View style={{ flex: 1 }}>
            {detail ?? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Body quiet>Choose something on the left.</Body></View>}
          </View>
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
            <Pressable key={t.key} onPress={() => setTab(t.key)} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}
              style={{ flex: 1, alignItems: 'center', paddingVertical: 10, minHeight: 56, borderTopWidth: 3, borderTopColor: tab === t.key ? K.band : 'transparent' }}>
              <Text style={{ color: tab === t.key ? C.text : C.quiet, fontWeight: '700', fontSize: 12, textAlign: 'center' }}>{t.label}</Text>
              {t.count ? <Text style={{ color: C.warn, fontWeight: '800' }}>{t.count}</Text> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
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

// ---- Requests to issue -----------------------------------------------------------

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

function RoomList({ items, onDelivery }: { items: RoomItem[]; onDelivery: () => void }) {
  const [q, setQ] = useState('');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter(i => words.every(w => `${i.code} ${i.description}`.toLowerCase().includes(w)));
  return (
    <>
      <Button label="Receive a delivery" onPress={onDelivery} />
      <Field label="Search" value={q} onChangeText={setQ} placeholder="code or description" autoCorrect={false} />
      {shown.map(i => (
        <Card key={i.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={[st.body, { fontWeight: '700' }]}>{i.description}</Text>
              <Text style={st.small}>{i.code} · {i.unit}{i.needsReview ? ' · needs a code' : ''}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: i.inStockroom <= 0 ? C.bad : C.text, fontSize: 22, fontWeight: '800' }}>{i.inStockroom}</Text>
              <Text style={st.small}>{i.withTechnicians} with techs</Text>
            </View>
          </View>
        </Card>
      ))}
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
  const taken = room.ctl.room.some(x => x.id !== it.id && x.code.toLowerCase() === code.trim().toLowerCase());
  return (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap }}>
      <Heading>Name {it.code}</Heading>
      <Field label="Our code" value={code} onChangeText={setCode} autoCapitalize="characters" hint={taken ? 'That code is already used' : undefined} />
      <Field label="Description" value={desc} onChangeText={setDesc} />
      <Field label="Unit" value={unit} onChangeText={setUnit} />
      <Button label="Save" disabled={code.trim().length < 2 || desc.trim().length < 2 || !unit.trim() || taken}
        onPress={() => { room.nameItem(it, { code: code.trim(), description: desc.trim(), unit: unit.trim() }); done(); }} />
    </ScrollView>
  );
}

function Delivery({ room, done }: { room: ReturnType<typeof useStockroom>; done: () => void }) {
  const [supplier, setSupplier] = useState('');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState<Photo | null>(null);
  const [q, setQ] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = room.ctl.room.filter(i => !i.needsReview && words.every(w => `${i.code} ${i.description}`.toLowerCase().includes(w))).slice(0, 30);
  const lines = Object.entries(qty).filter(([, n]) => n > 0).map(([stockItemId, n]) => ({ stockItemId, qty: n }));
  return (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60 }}>
      <Heading>Receive a delivery</Heading>
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
        onPress={() => { room.delivery({ supplierName: supplier.trim(), reference: ref.trim(), lines }, note); done(); }} />
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
