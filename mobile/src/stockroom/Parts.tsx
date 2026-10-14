// The stock controller's order list (fills as stock drops below each item's minimum) and one part's
// page: its photo, minimum, how many to order, the usual supplier, and everywhere it went.
import { rand } from '../../../server/src/core/documents.ts';
import React, { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { nowIso, takePhoto } from '../device.ts';
import { rememberPhoto, usePhotoUri } from '../photo.ts';
import { StockOrders, useStockOrders } from './Ordering.tsx';
import { Body, Button, Card, Field, Heading, Label, Notice, Pill, st, Select } from '../ui.tsx';
import { C } from '../theme.ts';
import type { RoomItem } from './useStockroom.ts';

export interface OrderLine {
  id: string; code: string; description: string; unit: string; min_qty: number; reorder_qty: number | null; photo_id: string | null; supplier_name: string | null;
  supplier_code: string | null; in_stockroom: number; suggested: number; ordered_at: string | null; ordered_qty: number | null; ordered_note: string | null; ordered_by: string | null;
  last_bought?: LastBought | null;
}
export interface LastBought { supplier: string; at: string; unitPriceCents: number | null; ref: string | null; how: 'delivery' | 'invoice'; lastPriceCents: number | null }
/** "Last bought from X on 3 Oct, R 320,00 (invoice INV-1)". */
export const lastText = (l: LastBought | null | undefined) => (l ? `Last bought from ${l.supplier} on ${new Date(l.at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}${l.lastPriceCents != null ? `, ${rand(l.lastPriceCents)} each` : ''}${l.ref ? ` (${l.how === 'invoice' ? 'invoice' : 'delivery'} ${l.ref})` : ''}` : 'Not bought yet');
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
  const so = useStockOrders();
  const d = ol.d;
  // Per line: on the order or not, how many, and from whom (the last supplier, else the usual one).
  const [pick, setPick] = useState<Record<string, { on: boolean; qty: string; supplier: string }>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!d) return <Body quiet>Loading the order list…</Body>;
  const of = (l: OrderLine) => pick[l.id] ?? { on: true, qty: String(l.suggested), supplier: l.last_bought?.supplier ?? l.supplier_name ?? '' };
  const set = (l: OrderLine, p: Partial<{ on: boolean; qty: string; supplier: string }>) => setPick(x => ({ ...x, [l.id]: { ...of(l), ...p } }));
  const groups = d.toOrder.reduce<Record<string, OrderLine[]>>((m, l) => { const k = of(l).supplier.trim() || ''; (m[k] ??= []).push(l); return m; }, {});
  const make = async (supplier: string, lines: OrderLine[]) => {
    const on = lines.filter(l => of(l).on && Number(of(l).qty.replace(',', '.')) > 0);
    if (!on.length) return;
    setBusy(supplier);
    const r = await s.ask({ method: 'POST', path: '/stock/orders', json: { supplierName: supplier, lines: on.map(l => ({ stockItemId: l.id, qty: Number(of(l).qty.replace(',', '.')) })) } });
    setBusy(null);
    if (r && r.status < 300) { setMsg({ ok: true, text: `PO ${(r.body as { poNumber: number }).poNumber} made for ${supplier}: send it below.` }); await Promise.all([ol.load(), so.load()]); }
    else setMsg({ ok: false, text: ((r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.']).join('; ') });
  };
  return (
    <>
      <Notice tone="info" title="What to order" lines={['Fills by itself as stock drops below each item\'s minimum (set on the part). Choose the supplier and how many, then make the purchase order and send it.']} />
      {msg ? <Notice tone={msg.ok ? 'good' : 'bad'} title={msg.text} /> : null}
      <Heading>To order ({d.toOrder.length})</Heading>
      {!d.toOrder.length ? <Body quiet>Nothing is below its minimum.</Body> : null}
      {Object.entries(groups).sort(([a], [b2]) => (a ? 0 : 1) - (b2 ? 0 : 1) || a.localeCompare(b2)).map(([sup, lines]) => {
        const on = lines.filter(l => of(l).on);
        const est = on.reduce((n2, l) => n2 + (l.last_bought?.supplier === sup ? l.last_bought.lastPriceCents ?? 0 : 0) * (Number(of(l).qty) || 0), 0);
        return (
          <View key={sup || 'none'} style={{ gap: 8 }}>
            <Label>{sup || 'No supplier yet: type one on each item'}</Label>
            {lines.map(l => {
              const x = of(l);
              return (
                <Card key={l.id} style={{ borderLeftWidth: 5, borderLeftColor: l.in_stockroom <= 0 ? C.bad : C.warn, opacity: x.on ? 1 : 0.6 }}>
                  <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                    <Pressable onPress={() => set(l, { on: !x.on })} accessibilityRole="checkbox" accessibilityState={{ checked: x.on }} accessibilityLabel={`Order ${l.description}`}
                      style={{ width: 26, height: 26, borderRadius: 5, borderWidth: 2, borderColor: x.on ? C.accent : C.line, backgroundColor: x.on ? C.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                      {x.on ? <Text style={{ color: C.accentText, fontWeight: '900' }}>✓</Text> : null}
                    </Pressable>
                    <Pressable onPress={() => open(l.id)} accessibilityRole="button" accessibilityLabel={`Part ${l.description}`} style={{ flex: 1, flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                      <Thumb id={l.photo_id} size={44} />
                      <View style={{ flex: 1 }}>
                        <Text style={[st.body, { fontWeight: '700' }]}>{l.description}</Text>
                        <Text style={st.small}>{l.code}{l.supplier_code ? ` · their code ${l.supplier_code}` : ''} · <Text style={{ color: l.in_stockroom <= 0 ? C.bad : C.warn }}>{n(l.in_stockroom)} left, minimum {n(l.min_qty)}</Text></Text>
                        <Text style={st.small}>{lastText(l.last_bought)}{l.supplier_name && l.supplier_name !== l.last_bought?.supplier ? ` · usual: ${l.supplier_name}` : ''}</Text>
                      </View>
                    </Pressable>
                  </View>
                  {x.on ? (
                    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                      <View style={{ flexGrow: 2, flexBasis: 180 }}><Field label="Supplier" value={x.supplier} onChangeText={t => set(l, { supplier: t })} /></View>
                      <View style={{ flexGrow: 1, flexBasis: 90 }}><Field label={`How many (${l.unit})`} value={x.qty} onChangeText={t => set(l, { qty: t })} keyboardType="decimal-pad" /></View>
                    </View>
                  ) : null}
                </Card>
              );
            })}
            {sup ? <Text style={st.small}>{`${on.length} item${on.length === 1 ? '' : 's'} ticked${est ? `, about ${rand(est)} excl. VAT at the last prices` : ''}`}</Text> : null}
            {sup ? <Button label={`Make the PO for ${sup}`} disabled={!on.length} busy={busy === sup} onPress={() => make(sup, lines)} /> : null}
          </View>
        );
      })}
      <StockOrders so={so} changed={ol.load} />
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
      <Text style={st.small}>When the delivery is received (Stock → Receive a delivery, against its PO) it comes off this list by itself.</Text>
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
      <Card>
        <Label>Last bought</Label>
        <Body>{lastText(it.lastBought)}</Body>
        {it.supplierName && it.supplierName !== it.lastBought?.supplier ? <Text style={st.small}>Usual supplier: {it.supplierName}</Text> : null}
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
