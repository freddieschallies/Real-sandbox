// The mechanic's workshop stock, seen from both sides. The mechanic counts it and notes spills;
// the stock controller decides what it keeps, issues to it and takes back. Poured stock (oil,
// coolant) is never exact: a small shortfall is allowed but always recorded as a loss.
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { nowIso } from '../device.ts';
import * as W from '../../../server/src/core/workshop.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';

export interface WorkshopLine {
  id: string; code: string; description: string; unit: string; measured: boolean; qty: number; min_qty: number; daily_check_use: 'oil' | 'water' | null; kept: boolean;
  used_30d: number; lost_30d: number; last_count: { at: string; result: W.CountResult; expected: number; counted: number; by: string } | null;
  in_stockroom: number; belowMin: boolean; usedSince: number;
}
export interface WorkshopData { lines: WorkshopLine[]; belowMin: number; lossPct: number; lossMin: number }
export interface WorkshopMove {
  id: string; created_at: string; kind: string; qty: number; to_workshop: boolean; description: string; unit: string; note: string | null; by: string; registration: string | null; job_number: number | null;
}
export type WorkshopRole = 'mechanic' | 'controller';

const KIND: Record<string, string> = {
  assign: 'Issued from the stockroom', return: 'Sent back to the stockroom', use_on_fleet: 'Used', workshop_loss: 'Loss', stocktake_adjustment: 'Count: more than expected',
};
const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const n = (x: number) => String(Math.round(x * 100) / 100);
const num = (t: string) => (t.trim() === '' ? null : Number(t.replace(',', '.').replace(/\s/g, '')));

export function useWorkshop() {
  const s = useStore();
  const [data, setData] = useState<WorkshopData | null>(null);
  const [moves, setMoves] = useState<Record<string, WorkshopMove[]>>({});
  const load = useCallback(async () => {
    const r = await s.ask({ method: 'GET', path: '/fleet/workshop' });
    if (r?.status === 200) setData(r.body as WorkshopData);
  }, [s]);
  const loadMoves = useCallback(async (itemId: string) => {
    const r = await s.ask({ method: 'GET', path: `/fleet/workshop/movements?itemId=${itemId}` });
    if (r?.status === 200) setMoves(m => ({ ...m, [itemId]: r.body as WorkshopMove[] }));
  }, [s]);
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, []);
  /** Sends a change straight away (needs signal), so the answer can be shown. */
  const send = async (method: 'POST' | 'PUT', path: string, json: object) => {
    const r = await s.ask({ method, path, json: { ...json, at: nowIso() } });
    await load();
    return r;
  };
  return { data, moves, load, loadMoves, send };
}
export type WorkshopHook = ReturnType<typeof useWorkshop>;

export function WorkshopList({ ws, role, open, onAdd }: { ws: WorkshopHook; role: WorkshopRole; open: (id: string) => void; onAdd?: () => void }) {
  const d = ws.data;
  if (!d) return <Body quiet>Loading the workshop stock…</Body>;
  return (
    <>
      <Card style={{ borderColor: d.belowMin ? C.warn : C.line }}>
        <Text style={[st.body, { fontWeight: '800' }]}>{role === 'mechanic' ? 'My workshop stock' : "Mechanic's workshop"}</Text>
        {d.belowMin ? <Pill text={`${d.belowMin} below minimum`} tone="warn" /> : <Pill text="All at or above minimum" tone="good" />}
      </Card>
      {role === 'controller' && onAdd ? <Button label="Add an item to the workshop" kind="secondary" onPress={onAdd} /> : null}
      {d.lines.map(l => (
        <Card key={l.id} onPress={() => open(l.id)} accessibilityLabel={`Workshop ${l.description}`} style={l.belowMin ? { borderLeftWidth: 5, borderLeftColor: C.warn } : undefined}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{l.description}</Text>
            <Text style={{ color: l.belowMin ? C.warn : C.text, fontSize: 22, fontWeight: '800' }}>{n(l.qty)}<Text style={st.small}> {l.unit}</Text></Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {l.min_qty ? <Pill text={`Min ${n(l.min_qty)} ${l.unit}`} tone={l.belowMin ? 'warn' : 'quiet'} /> : null}
            {l.daily_check_use ? <Pill text={l.daily_check_use === 'oil' ? 'Daily-check oil' : 'Daily-check coolant'} tone="info" /> : null}
          </View>
          <Text style={st.small}>Used {n(l.used_30d)} · lost {n(l.lost_30d)} {l.unit} in 30 days{l.last_count ? ` · last counted ${when(l.last_count.at)}` : ' · never counted'}</Text>
        </Card>
      ))}
      {!d.lines.length ? <Body quiet>Nothing set for the workshop yet.</Body> : null}
    </>
  );
}

export function WorkshopItem({ id, ws, role, done }: { id: string; ws: WorkshopHook; role: WorkshopRole; done: () => void }) {
  const l = ws.data?.lines.find(x => x.id === id);
  const [panel, setPanel] = useState<'none' | 'count' | 'loss' | 'set' | 'issue' | 'back'>('none');
  const [reply, setReply] = useState<{ tone: 'good' | 'warn' | 'bad'; title: string; lines: string[] } | null>(null);
  useEffect(() => { ws.loadMoves(id); }, [id, ws.data]);
  if (!l) return <Body quiet>Not in the workshop.</Body>;
  const moves = ws.moves[id] ?? [];
  const after = async (r: Awaited<ReturnType<WorkshopHook['send']>>, ok: string) => {
    if (r && r.status < 300) {
      const b = r.body as { text?: string; result?: string };
      setReply({ tone: b.result === 'short' ? 'bad' : b.result === 'within_allowance' || b.result === 'over' ? 'warn' : 'good', title: ok, lines: b.text ? [b.text] : [] });
      setPanel('none');
    } else setReply({ tone: 'bad', title: 'Not saved', lines: (r?.body as { reasons?: string[] })?.reasons ?? ['needs signal: try again'] });
  };
  const btn = { flexBasis: '46%' as const, flexGrow: 1 };
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: C.text, fontSize: 24, fontWeight: '800', flex: 1 }}>{l.description}</Text>
        {l.belowMin ? <Pill text="Below minimum" tone="warn" /> : null}
      </View>
      <Text style={st.small}>{l.code}</Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Card style={{ flex: 1 }}><Label>In the workshop</Label><Text style={{ color: C.text, fontSize: 26, fontWeight: '800' }}>{n(l.qty)} {l.unit}</Text></Card>
        <Card style={{ flex: 1 }}><Label>Minimum</Label><Text style={{ color: C.text, fontSize: 26, fontWeight: '800' }}>{n(l.min_qty)} {l.unit}</Text></Card>
      </View>
      <Text style={st.small}>Used since the last count: {n(l.usedSince)} {l.unit}{l.last_count ? ` · last count ${when(l.last_count.at)} by ${l.last_count.by}` : ' · never counted'}</Text>
      {reply ? <Notice tone={reply.tone} title={reply.title} lines={reply.lines} /> : null}

      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Button label={l.measured ? 'Dip / count' : 'Count'} kind="secondary" onPress={() => setPanel(panel === 'count' ? 'none' : 'count')} style={btn} />
        {role === 'mechanic' ? <Button label="Note a spill or loss" kind="secondary" onPress={() => setPanel(panel === 'loss' ? 'none' : 'loss')} style={btn} /> : null}
        {role === 'controller' ? <Button label="Issue more" kind="secondary" onPress={() => setPanel(panel === 'issue' ? 'none' : 'issue')} style={btn} /> : null}
        {role === 'controller' ? <Button label="Minimum / use" kind="secondary" onPress={() => setPanel(panel === 'set' ? 'none' : 'set')} style={btn} /> : null}
        {role === 'controller' ? <Button label="Take back" kind="secondary" onPress={() => setPanel(panel === 'back' ? 'none' : 'back')} style={btn} /> : null}
      </View>
      {panel === 'count' ? <CountPanel l={l} send={(counted, note) => ws.send('POST', '/fleet/workshop/count', { itemId: id, counted, note }).then(r => after(r, 'Count saved'))} /> : null}
      {panel === 'loss' ? <LossPanel l={l} send={(qty, reason) => ws.send('POST', '/fleet/workshop/loss', { itemId: id, qty, reason }).then(r => after(r, 'Loss noted'))} /> : null}
      {panel === 'issue' ? <QtyPanel title={`Issue from the stockroom (${n(l.in_stockroom)} ${l.unit} there)`} unit={l.unit} max={l.in_stockroom} label="Issue to workshop"
        send={qty => ws.send('POST', '/fleet/workshop/issue', { lines: [{ itemId: id, qty }] }).then(r => after(r, `Issued ${qty} ${l.unit}`))} /> : null}
      {panel === 'back' ? <QtyPanel title="Take back into the stockroom" unit={l.unit} max={l.qty} label="Take back" needNote
        send={(qty, note) => ws.send('POST', '/fleet/workshop/return', { itemId: id, qty, note }).then(r => after(r, `Took back ${qty} ${l.unit}`))} /> : null}
      {panel === 'set' ? <SetPanel l={l} send={b => ws.send('PUT', `/fleet/workshop/items/${id}`, b).then(r => after(r, 'Saved'))} /> : null}

      <Heading>In and out</Heading>
      <Card>
        {moves.map(m => (
          <View key={m.id} style={{ paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.line, gap: 2 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Text style={{ color: m.to_workshop ? C.good : m.kind === 'workshop_loss' ? C.warn : C.text, fontWeight: '800', minWidth: 70 }}>{m.to_workshop ? '+' : '−'}{n(m.qty)} {m.unit}</Text>
              <Text style={[st.body, { flex: 1 }]}>{KIND[m.kind] ?? m.kind}{m.registration ? `: ${m.registration}` : ''}{m.job_number ? ` (job card ${m.job_number})` : ''}</Text>
            </View>
            <Text style={st.small}>{when(m.created_at)} · {m.by}{m.note ? ` · ${m.note}` : ''}</Text>
          </View>
        ))}
        {!moves.length ? <Body quiet>Nothing yet.</Body> : null}
      </Card>
      <Button label="Back to the list" kind="quiet" onPress={done} />
    </>
  );
}

function CountPanel({ l, send }: { l: WorkshopLine; send: (counted: number, note: string | null) => Promise<void> }) {
  const [t, setT] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const counted = num(t);
  const r = counted == null || Number.isNaN(counted) ? null : W.countResult(l.qty, counted, l.usedSince, l.measured);
  const missing = W.missingOnCount(counted, note, r);
  return (
    <Card>
      <Field label={`How much is there? (${l.unit})`} value={t} onChangeText={setT} keyboardType="decimal-pad" hint={`The system expects ${n(l.qty)} ${l.unit}`} />
      {r ? <Notice tone={r.result === 'ok' ? 'good' : r.result === 'short' ? 'bad' : 'warn'} title={r.result === 'ok' ? 'Matches' : r.result === 'within_allowance' ? 'Small loss: allowed, recorded' : r.result === 'short' ? 'Short: the office is asked' : 'More than expected'}
        lines={[W.countText(r, l.unit)]} /> : null}
      {r && r.result !== 'ok' ? <Field label={r.result === 'within_allowance' ? 'Note (optional)' : 'What happened?'} value={note} onChangeText={setNote} /> : null}
      <Button label="Save count" busy={busy} disabled={missing.length > 0} onPress={async () => { setBusy(true); await send(counted!, note.trim() || null); setBusy(false); }} />
    </Card>
  );
}

const LOSS_REASONS = ['Spilt while pouring', 'Leaked from the drum', 'Contaminated, thrown away', 'Damaged'];
function LossPanel({ l, send }: { l: WorkshopLine; send: (qty: number, reason: string) => Promise<void> }) {
  const [t, setT] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const qty = num(t);
  return (
    <Card>
      <Text style={st.small}>Note it straight away, however small. It comes off the workshop stock and stays on record.</Text>
      <Field label={`How much? (${l.unit})`} value={t} onChangeText={setT} keyboardType="decimal-pad" />
      <Choice options={LOSS_REASONS} value={LOSS_REASONS.find(x => x === reason)} onChange={setReason} />
      <Field label="What happened?" value={reason} onChangeText={setReason} />
      <Button label="Note the loss" busy={busy} disabled={!(qty && qty > 0) || reason.trim().length < 5 || qty > l.qty}
        onPress={async () => { setBusy(true); await send(qty!, reason.trim()); setBusy(false); }} />
    </Card>
  );
}

function QtyPanel({ title, unit, max, label, needNote, send }: { title: string; unit: string; max: number; label: string; needNote?: boolean; send: (qty: number, note?: string) => Promise<void> }) {
  const [t, setT] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const qty = num(t);
  return (
    <Card>
      <Label>{title}</Label>
      <Field label={`Quantity (${unit})`} value={t} onChangeText={setT} keyboardType="decimal-pad" hint={qty != null && qty > max ? `Only ${n(max)} ${unit}` : undefined} />
      {needNote ? <Field label="Why?" value={note} onChangeText={setNote} /> : null}
      <Button label={label} busy={busy} disabled={!(qty && qty > 0) || qty > max || (!!needNote && note.trim().length < 5)}
        onPress={async () => { setBusy(true); await send(qty!, note.trim() || undefined); setBusy(false); }} />
    </Card>
  );
}

function SetPanel({ l, send }: { l: WorkshopLine; send: (b: object) => Promise<void> }) {
  const [min, setMin] = useState(String(l.min_qty));
  const [use, setUse] = useState<'none' | 'oil' | 'water'>(l.daily_check_use ?? 'none');
  const [measured, setMeasured] = useState<'poured' | 'counted'>(l.measured ? 'poured' : 'counted');
  const m = num(min);
  return (
    <Card>
      <Field label={`Minimum to keep in the workshop (${l.unit})`} value={min} onChangeText={setMin} keyboardType="decimal-pad" />
      <Label>Used for daily checks</Label>
      <Choice options={['none', 'oil', 'water'] as const} value={use} onChange={setUse} labels={{ none: 'No', oil: 'Engine oil', water: 'Coolant / water' }} />
      <Label>How it is measured</Label>
      <Choice options={['poured', 'counted'] as const} value={measured} onChange={setMeasured} labels={{ poured: 'Poured (small losses allowed)', counted: 'Counted (must match)' }} />
      <Button label="Save" disabled={m == null || Number.isNaN(m) || m < 0} onPress={() => send({ minQty: m, dailyCheckUse: use === 'none' ? null : use, measured: measured === 'poured' })} />
    </Card>
  );
}

/** Stock controller: start keeping a stockroom item in the workshop. */
export function WorkshopAdd({ ws, done }: { ws: WorkshopHook; done: () => void }) {
  const s = useStore();
  const [items, setItems] = useState<{ id: string; code: string; description: string; unit: string; inStockroom: number }[]>([]);
  const [pick, setPick] = useState<string>();
  const [min, setMin] = useState('');
  const [qty, setQty] = useState('');
  const [poured, setPoured] = useState<'poured' | 'counted'>('counted');
  const [msg, setMsg] = useState<string[] | null>(null);
  useEffect(() => { s.ask({ method: 'GET', path: '/stock/stockroom' }).then(r => { if (r?.status === 200) setItems(r.body as typeof items); }); }, []);
  const kept = new Set(ws.data?.lines.map(l => l.id));
  const choices = items.filter(i => !kept.has(i.id));
  const it = items.find(i => i.id === pick);
  return (
    <>
      <Heading>Add an item to the workshop</Heading>
      <Label>Stockroom item</Label>
      {choices.map(i => (
        <Pressable key={i.id} onPress={() => setPick(i.id)} accessibilityRole="radio" accessibilityState={{ checked: pick === i.id }}
          style={{ padding: 12, borderRadius: 8, borderWidth: 2, borderColor: pick === i.id ? C.accent : C.line }}>
          <Text style={[st.body, { fontWeight: '700' }]}>{i.description}</Text>
          <Text style={st.small}>{i.code} · {i.inStockroom} {i.unit} in the stockroom</Text>
        </Pressable>
      ))}
      {it ? (
        <>
          <Field label={`Minimum to keep (${it.unit})`} value={min} onChangeText={setMin} keyboardType="decimal-pad" />
          <Field label={`Issue now (${it.unit})`} value={qty} onChangeText={setQty} keyboardType="decimal-pad" hint={`${it.inStockroom} ${it.unit} in the stockroom`} />
          <Choice options={['poured', 'counted'] as const} value={poured} onChange={setPoured} labels={{ poured: 'Poured (small losses allowed)', counted: 'Counted (must match)' }} />
          {msg ? <Notice tone="bad" title="Not saved" lines={msg} /> : null}
          <Button label="Add to workshop" disabled={!(num(min)! >= 0)} onPress={async () => {
            const r1 = await ws.send('PUT', `/fleet/workshop/items/${it.id}`, { minQty: num(min) ?? 0, measured: poured === 'poured' });
            if (!r1 || r1.status >= 300) { setMsg((r1?.body as { reasons?: string[] })?.reasons ?? ['needs signal']); return; }
            const q = num(qty);
            if (q && q > 0) {
              const r2 = await ws.send('POST', '/fleet/workshop/issue', { lines: [{ itemId: it.id, qty: q }] });
              if (!r2 || r2.status >= 300) { setMsg((r2?.body as { reasons?: string[] })?.reasons ?? ['needs signal']); return; }
            }
            done();
          }} />
        </>
      ) : null}
      <Button label="Cancel" kind="quiet" onPress={done} />
    </>
  );
}
