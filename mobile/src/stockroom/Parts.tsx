// The stock controller's order list (fills as stock drops below each item's minimum) and one part's
// page: its photo, minimum, how many to order, the usual supplier, and everywhere it went.
import React, { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { nowIso, takePhoto } from '../device.ts';
import { rememberPhoto, usePhotoUri } from '../photo.ts';
import { Body, Button, Card, Field, Heading, Label, Notice, Pill, st, Select } from '../ui.tsx';
import { C } from '../theme.ts';
import type { RoomItem } from './useStockroom.ts';

export interface OrderLine {
  id: string; code: string; description: string; unit: string; min_qty: number; reorder_qty: number | null; photo_id: string | null; supplier_name: string | null;
  supplier_code: string | null; in_stockroom: number; suggested: number; ordered_at: string | null; ordered_qty: number | null; ordered_note: string | null; ordered_by: string | null;
}
export interface Move {
  id: string; at: string; kind: string; qty: number; note: string | null; job_number: number | null; store: string | null; technician: string | null; by: string;
  vehicle: string | null; fleet_job_number: number | null; to_workshop?: boolean; from_workshop?: boolean;
}
const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const n = (x: number) => String(Math.round(x * 100) / 100);
const KIND: Record<string, string> = {
  receive: 'Delivered into the stockroom', assign: 'Issued', return: 'Returned', use_on_job: 'Used on a job', use_on_fleet: 'Used on a vehicle',
  supplier_invoice: 'Bought on a supplier invoice', stocktake_adjustment: 'Stock count', workshop_loss: 'Loss', transfer: 'Moved between technicians', supply_run: 'Supply run',
};

export function Thumb({ id, size = 56 }: { id: string | null | undefined; size?: number }) {
  const uri = usePhotoUri(id);
  return uri ? <Image source={{ uri }} style={{ width: size, height: size, borderRadius: 8, backgroundColor: C.panel2 }} />
    : <View style={{ width: size, height: size, borderRadius: 8, backgroundColor: C.panel2, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: C.quiet, fontSize: 11 }}>{id ? 'Photo' : 'No photo'}</Text></View>;
}

export function useOrderList() {
  const s = useStore();
  const [d, setD] = useState<{ toOrder: OrderLine[]; ordered: OrderLine[] } | null>(null);
  const load = useCallback(async () => {
    const r = await s.ask({ method: 'GET', path: '/stock/order-list' });
    if (r?.status === 200) setD(r.body);
  }, [s]);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);
  return { d, load };
}

export function OrderList({ ol, open }: { ol: ReturnType<typeof useOrderList>; open: (id: string) => void }) {
  const s = useStore();
  const [marking, setMarking] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const d = ol.d;
  if (!d) return <Body quiet>Loading the order list…</Body>;
  const bySupplier = d.toOrder.reduce<Record<string, OrderLine[]>>((m, l) => { (m[l.supplier_name || 'No supplier set'] ??= []).push(l); return m; }, {});
  const send = async (path: string, json: object) => { await s.ask({ method: 'POST', path, json }); setMarking(null); await ol.load(); };
  return (
    <>
      <Notice tone="info" title="What to order" lines={['Fills by itself as stock drops below each item\'s minimum. Set the minimum on the part (Stock → the part → Minimum).']} />
      <Heading>To order ({d.toOrder.length})</Heading>
      {!d.toOrder.length ? <Body quiet>Nothing is below its minimum.</Body> : null}
      {Object.entries(bySupplier).map(([sup, lines]) => (
        <View key={sup} style={{ gap: 8 }}>
          <Label>{sup}</Label>
          {lines.map(l => (
            <Card key={l.id} style={{ borderLeftWidth: 5, borderLeftColor: l.in_stockroom <= 0 ? C.bad : C.warn }}>
              <Pressable onPress={() => open(l.id)} accessibilityRole="button" accessibilityLabel={`Part ${l.description}`} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                <Thumb id={l.photo_id} />
                <View style={{ flex: 1 }}>
                  <Text style={[st.body, { fontWeight: '700' }]}>{l.description}</Text>
                  <Text style={st.small}>{l.code}{l.supplier_code ? ` · supplier code ${l.supplier_code}` : ''}</Text>
                  <Text style={[st.small, { color: l.in_stockroom <= 0 ? C.bad : C.warn }]}>{n(l.in_stockroom)} in the stockroom · minimum {n(l.min_qty)}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Label>Order</Label>
                  <Text style={{ color: C.text, fontSize: 22, fontWeight: '800' }}>{n(l.suggested)}</Text>
                  <Text style={st.small}>{l.unit}</Text>
                </View>
              </Pressable>
              {marking === l.id ? (
                <View style={{ gap: 8 }}>
                  <Field label={`How many ordered (${l.unit})`} value={qty} onChangeText={setQty} keyboardType="decimal-pad" />
                  <Field label="Order number or note" value={note} onChangeText={setNote} placeholder="e.g. Voltex order 5521" />
                  <Button label="Mark as ordered" disabled={!(Number(qty) > 0)} onPress={() => send(`/stock/items/${l.id}/ordered`, { qty: Number(qty), note: note.trim() || undefined })} />
                </View>
              ) : <Button label="Ordered it" kind="secondary" onPress={() => { setMarking(l.id); setQty(String(l.suggested)); setNote(''); }} style={{ minHeight: 44 }} />}
            </Card>
          ))}
        </View>
      ))}
      <Heading>Ordered, waiting for delivery ({d.ordered.length})</Heading>
      {!d.ordered.length ? <Body quiet>Nothing waiting.</Body> : null}
      {d.ordered.map(l => (
        <Card key={l.id} onPress={() => open(l.id)} accessibilityLabel={`Ordered ${l.description}`}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <Thumb id={l.photo_id} size={44} />
            <View style={{ flex: 1 }}>
              <Text style={[st.body, { fontWeight: '700' }]}>{l.description}</Text>
              <Text style={st.small}>{n(l.ordered_qty ?? 0)} {l.unit} ordered {when(l.ordered_at!)}{l.ordered_by ? ` by ${l.ordered_by}` : ''}{l.ordered_note ? ` · ${l.ordered_note}` : ''}</Text>
            </View>
            <Pill text={`${n(l.in_stockroom)} left`} tone="warn" />
          </View>
        </Card>
      ))}
      <Text style={st.small}>When the delivery is received (Stock → Receive a delivery) it comes off this list by itself.</Text>
    </>
  );
}

export function PartDetail({ it, done, reload }: { it: RoomItem; done: () => void; reload: () => void }) {
  const s = useStore();
  const [min, setMin] = useState(String(it.minQty ?? 0));
  const [reorder, setReorder] = useState(it.reorderQty != null ? String(it.reorderQty) : '');
  const [supplier, setSupplier] = useState(it.supplierName ?? '');
  const [hist, setHist] = useState<Move[] | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  useEffect(() => { s.ask({ method: 'GET', path: `/stock/items/${it.id}/history` }).then(r => { if (r?.status === 200) setHist(r.body); }); }, [it.id]);
  const lastUse = hist?.find(h => h.kind === 'use_on_job' || h.kind === 'use_on_fleet');

  const shoot = async () => {
    const p = await takePhoto();
    if (!p) return;
    const id = s.newId();
    rememberPhoto(s, id, p.uri);
    s.queue(`Photo of ${it.code}`, { method: 'POST', path: '/photos', upload: { fields: { kind: 'stock_item', takenAt: nowIso(), id }, fileUri: p.uri, mime: p.mime } });
    s.queue(`Photo on ${it.code}`, { method: 'PUT', path: `/stock/items/${it.id}/settings`, json: { minQty: Number(min) || 0, reorderQty: Number(reorder) > 0 ? Number(reorder) : null, supplierName: supplier.trim() || null, photoId: id } });
    setTimeout(reload, 800);
  };
  const save = async () => {
    const r = await s.ask({ method: 'PUT', path: `/stock/items/${it.id}/settings`, json: { minQty: Number(min) || 0, reorderQty: Number(reorder) > 0 ? Number(reorder) : null, supplierName: supplier.trim() || null } });
    setMsg(r && r.status < 300 ? { tone: 'good', text: 'Saved' } : { tone: 'bad', text: (r?.body as { reasons?: string[] })?.reasons?.join('; ') ?? 'No signal: try again' });
    reload();
  };

  return (
    <>
      <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
        <Thumb id={it.photoId} size={96} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.text, fontSize: 22, fontWeight: '800' }}>{it.description}</Text>
          <Text style={st.small}>{it.code} · {it.unit}{it.supplierCode ? ` · supplier code ${it.supplierCode}` : ''}</Text>
          {it.belowMin ? <Pill text="Below minimum: on the order list" tone="warn" /> : null}
        </View>
      </View>
      <Button label={it.photoId ? 'Replace the photo of the part' : 'Add a photo of the part'} kind="secondary" onPress={shoot} />
      <Select label="Category" value={it.category ?? 'stock'} options={[{ value: 'stock', label: 'Stock (parts for jobs)' }, { value: 'tool', label: 'Tool (issued to a person)' }, { value: 'ppe', label: 'PPE (issued to a person)' }] as const}
        onChange={async c => {
          const r = await s.ask({ method: 'PATCH', path: `/stock/items/${it.id}`, json: { code: it.code, description: it.description, unit: it.unit, category: c } });
          setMsg(r && r.status < 300 ? { tone: 'good', text: `Moved to ${c === 'stock' ? 'Stock' : c === 'tool' ? 'Tools' : 'PPE'}` } : { tone: 'bad', text: (r?.body as { reasons?: string[] })?.reasons?.join('; ') ?? 'No signal: try again' });
          reload();
        }} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Card style={{ flex: 1 }}><Label>Stockroom</Label><Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>{n(it.inStockroom)}</Text></Card>
        <Card style={{ flex: 1 }}><Label>With techs</Label><Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>{n(it.withTechnicians)}</Text></Card>
      </View>
      <Card>
        <Label>Last used</Label>
        {lastUse ? <Body>{lastUse.job_number ? `Job ${lastUse.job_number}${lastUse.store ? `, ${lastUse.store}` : ''}` : lastUse.vehicle ? `Vehicle ${lastUse.vehicle}${lastUse.fleet_job_number ? ` (job card ${lastUse.fleet_job_number})` : ''}` : 'Used'}{lastUse.technician ? ` · ${lastUse.technician}` : ''}</Body> : <Body quiet>{hist ? 'Not used yet.' : 'Loading…'}</Body>}
        {lastUse ? <Text style={st.small}>{when(lastUse.at)} · {n(lastUse.qty)} {it.unit}</Text> : null}
      </Card>
      <Heading>Order list</Heading>
      <Field label={`Minimum to keep in the stockroom (${it.unit})`} value={min} onChangeText={setMin} keyboardType="decimal-pad" hint="Below this it goes on the order list. 0 = never." />
      <Field label={`How many to order at a time (${it.unit}, optional)`} value={reorder} onChangeText={setReorder} keyboardType="decimal-pad" />
      <Field label="Usual supplier" value={supplier} onChangeText={setSupplier} placeholder="e.g. Voltex Richards Bay" />
      {msg ? <Notice tone={msg.tone} title={msg.text} lines={[]} /> : null}
      <Button label="Save" onPress={save} />
      <Heading>Where it went</Heading>
      <Card>
        {(hist ?? []).slice(0, 40).map(h => (
          <View key={h.id} style={{ paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.line, gap: 2 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Text style={[st.body, { fontWeight: '700', minWidth: 54 }]}>{n(h.qty)}</Text>
              <Text style={[st.body, { flex: 1 }]}>
                {KIND[h.kind] ?? h.kind}{h.job_number ? ` · job ${h.job_number}` : ''}{h.store ? `, ${h.store}` : ''}{h.vehicle ? ` · ${h.vehicle}` : ''}{h.technician ? ` · ${h.technician}` : ''}
              </Text>
            </View>
            <Text style={st.small}>{when(h.at)} · by {h.by}{h.note ? ` · ${h.note}` : ''}</Text>
          </View>
        ))}
        {hist && !hist.length ? <Body quiet>Nothing yet.</Body> : null}
      </Card>
      <Button label="Back" kind="quiet" onPress={done} />
    </>
  );
}
