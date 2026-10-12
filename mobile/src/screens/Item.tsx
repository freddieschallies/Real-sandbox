// One work item. The technician can come back to it as often as he likes until the job is closed.
import React, { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { takePhoto, nowIso, type Photo } from '../device.ts';
import { J } from '../local.ts';
import * as St from '../../../server/src/core/stock.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, Screen, Toggle, st } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';
import { C } from '../theme.ts';

const FAULTS = ['electrical', 'refrigeration', 'mechanical', 'water', 'wear_and_tear', 'user_damage', 'no_fault_found', 'other'] as const;
const TESTED = ['yes', 'partly', 'no'] as const;
const OUTCOMES = ['complete', 'needs_follow_up', 'needs_quote', 'waiting_for_parts'] as const;

export function Item({ jobId, itemId }: { jobId: string; itemId: string }) {
  const s = useStore();
  const nav = useNav();
  const v = s.cache.cards[jobId];
  const it = v?.items.find(i => i.id === itemId);
  const [found, setFound] = useState(it?.found ?? '');
  const [did, setDid] = useState(it?.did ?? '');
  const [stillNeeded, setStillNeeded] = useState(it?.stillNeeded ?? '');
  const [reasons, setReasons] = useState<string[] | null>(null);
  const [shots, setShots] = useState<{ kind: string; uri: string }[]>([]);
  useEffect(() => { setFound(it?.found ?? ''); setDid(it?.did ?? ''); setStillNeeded(it?.stillNeeded ?? ''); }, [itemId]);

  if (!v || !it) return <Screen title="Work item" onBack={nav.back}><Body quiet>Not found on the phone.</Body></Screen>;
  const locked = v.status === 'closed';
  const editable = !locked && ['working', 'paused'].includes(v.currentState);

  const patch = (label: string, p: Partial<J.WorkItem>) => {
    const r = s.jobAction(jobId, `${it.title}: ${label}`, c => J.updateItem(c, itemId, p),
      { method: 'PATCH', path: `/jobs/${jobId}/items/${itemId}`, json: p });
    setReasons(r.ok ? null : r.reasons);
  };
  const saveText = (key: 'found' | 'did' | 'stillNeeded', value: string, label: string) => {
    if ((it[key] ?? '') !== value) patch(label, { [key]: value });
  };

  const photo = async (kind: 'before' | 'after') => {
    const p = await takePhoto();
    if (!p) return;
    const id = s.newId();
    const key = kind === 'before' ? 'beforePhotos' : 'afterPhotos';
    const r = s.jobAction(jobId, `${it.title}: ${kind} photo`, c => {
      const cur = c.items.find(x => x.id === itemId);
      return cur ? J.updateItem(c, itemId, { [key]: cur[key] + 1 }) : { ok: false, reasons: ['no such item'] };
    }, { method: 'POST', path: `/jobs/${jobId}/items/${itemId}/photos`, upload: { fields: { kind, takenAt: nowIso(), id }, fileUri: p.uri, mime: p.mime } });
    if (r.ok) setShots(x => [...x, { kind, uri: p.uri }]);
    setReasons(r.ok ? null : r.reasons);
  };

  return (
    <Screen title={it.title} sub={`#${v.job_number} · ${v.store}`} onBack={nav.back} right={<SyncPill />}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pill text={it.status === 'finished' ? 'Finished' : it.status === 'in_progress' ? 'In progress' : 'Not started'}
          tone={it.status === 'finished' ? 'good' : it.status === 'in_progress' ? 'info' : 'quiet'} />
        {locked ? <Pill text="Locked" tone="quiet" /> : null}
      </View>
      {!editable && !locked ? <Notice tone="info" title="Read only" lines={['Tap Start job (or Resume) on the job card to work on this item.']} /> : null}
      {reasons ? <Notice tone="bad" title="Not saved" lines={reasons} /> : null}
      {it.missing.length && !locked ? <Notice tone="warn" title="Still needed for this item" lines={it.missing} /> : null}

      <Heading>Equipment</Heading>
      {v.equipment.length ? (
        <Choice options={v.equipment.map(e => e.id)} value={it.equipmentId}
          onChange={id => editable && patch('equipment', { equipmentId: id })}
          labels={Object.fromEntries(v.equipment.map(e => [e.id, `${e.description}${e.serial ? ` · ${e.serial}` : ''}`]))} />
      ) : <Body quiet>No equipment on record for this store. Ask the office to add it.</Body>}

      <Heading>Photos</Heading>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label={`Before (${it.beforePhotos})`} kind="secondary" disabled={!editable} onPress={() => photo('before')} style={{ flex: 1 }} />
        <Button label={`After (${it.afterPhotos})`} kind="secondary" disabled={!editable} onPress={() => photo('after')} style={{ flex: 1 }} />
      </View>
      {shots.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {shots.map((p, i) => (
            <View key={i}>
              <Image source={{ uri: p.uri }} style={{ width: 96, height: 96, borderRadius: 8, backgroundColor: C.panel2 }} />
              <Text style={st.small}>{p.kind}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <Heading>Fault</Heading>
      <Choice options={FAULTS} value={it.faultType} onChange={f => editable && patch('fault type', { faultType: f })} />
      <Field label="What did you find?" value={found} onChangeText={setFound} editable={editable} multiline
        onBlur={() => saveText('found', found, 'what was found')} hint="A full sentence, so the office and the next technician understand." />
      <Field label="What did you do?" value={did} onChangeText={setDid} editable={editable} multiline
        onBlur={() => saveText('did', did, 'what was done')} />

      <Heading>Materials</Heading>
      <Materials jobId={jobId} itemId={itemId} editable={editable} lines={it.vanStockLines + it.boughtOutLines} onRefused={setReasons} />
      <Toggle label="No materials used" value={it.noMaterials} onChange={on => editable && patch('no materials', { noMaterials: on })} />

      <Heading>Result</Heading>
      <Label>Tested and working?</Label>
      <Choice options={TESTED} value={it.tested} onChange={t => editable && patch('tested', { tested: t })} />
      <Label>Outcome</Label>
      <Choice options={OUTCOMES} value={it.outcome} onChange={o => editable && patch('outcome', { outcome: o })} />
      {it.outcome && it.outcome !== 'complete' ? (
        <Field label="What is still needed?" value={stillNeeded} onChangeText={setStillNeeded} editable={editable} multiline
          onBlur={() => saveText('stillNeeded', stillNeeded, 'still needed')} />
      ) : null}

      <Button label="Back to job card" kind="secondary" onPress={() => {
        if (editable) { saveText('found', found, 'what was found'); saveText('did', did, 'what was done'); saveText('stillNeeded', stillNeeded, 'still needed'); }
        nav.back();
      }} />
    </Screen>
  );
}

function Materials({ jobId, itemId, editable, lines, onRefused }: { jobId: string; itemId: string; editable: boolean; lines: number; onRefused: (r: string[] | null) => void }) {
  const s = useStore();
  const [mode, setMode] = useState<'none' | 'van' | 'bought'>('none');
  const [qty, setQty] = useState('1');
  const [desc, setDesc] = useState('');
  const [price, setPrice] = useState('');
  const [slip, setSlip] = useState<Photo | null>(null);

  const bump = (key: 'vanStockLines' | 'boughtOutLines') => (c: J.JobCard): J.Result => {
    const cur = c.items.find(x => x.id === itemId);
    return cur ? J.updateItem(c, itemId, { [key]: cur[key] + 1 }) : { ok: false, reasons: ['no such item'] };
  };

  const useVan = (stockItemId: string, label: string, onVan: number) => {
    const n = Number(qty.replace(',', '.'));
    if (!(n > 0)) { onRefused(['a quantity above 0']); return; }
    if (n > onVan) { onRefused([`only ${onVan} on your name; book it out from the stockroom, or add it under Bought out if you bought it`]); return; }
    const r = s.jobAction(jobId, `Used ${n} × ${label}`, bump('vanStockLines'), { method: 'POST', path: `/jobs/${jobId}/items/${itemId}/materials`, json: { stockItemId, qty: n } });
    onRefused(r.ok ? null : r.reasons);
    if (r.ok) {
      s.adjustStock(stockItemId, -n);
      // Same order as the office: this job's stock first, then van stock, then other jobs.
      s.patchCache(c => {
        const inv = (c.inventory ?? []).map(x => ({ ...x }));
        const plan = St.drawPlan(inv.filter(x => x.stockItemId === stockItemId), n, jobId);
        if (plan.ok) for (const t of plan.take) { const h = inv.find(x => x.stockItemId === stockItemId && x.holdingJobId === t.holdingJobId); if (h) h.qty -= t.qty; }
        const js = (c.jobStock?.[jobId] ?? []).map(x => (x.stockItemId === stockItemId ? { ...x, used: x.used + n, onTechnician: Math.max(0, x.onTechnician - n) } : x));
        return { ...c, inventory: inv.filter(x => x.qty > 0), jobStock: { ...c.jobStock, [jobId]: js } };
      });
      setMode('none'); setQty('1');
    }
  };

  const addBought = () => {
    const n = Number(qty.replace(',', '.'));
    const rand = Number(price.replace(',', '.'));
    const missing: string[] = [];
    if (desc.trim().length < 2) missing.push('what was bought');
    if (!(n > 0)) missing.push('quantity');
    if (!(rand >= 0) || price.trim() === '') missing.push('price paid (R)');
    if (!slip) missing.push('photo of the slip');
    if (missing.length) { onRefused(missing); return; }
    const slipId = s.newId();
    s.queue('Bought-out slip photo', { method: 'POST', path: '/photos', upload: { fields: { kind: 'bought_out_slip', takenAt: nowIso(), id: slipId }, fileUri: slip!.uri, mime: slip!.mime } }, jobId);
    const r = s.jobAction(jobId, `Bought out: ${desc.trim()}`, bump('boughtOutLines'), {
      method: 'POST', path: `/jobs/${jobId}/items/${itemId}/bought-out`,
      json: { id: s.newId(), description: desc.trim(), qty: n, priceCents: Math.round(rand * 100), slipPhotoId: slipId },
    });
    onRefused(r.ok ? null : r.reasons);
    if (r.ok) { setMode('none'); setDesc(''); setPrice(''); setQty('1'); setSlip(null); }
  };

  return (
    <View style={{ gap: 10 }}>
      <Body quiet>{lines ? `${lines} material line${lines > 1 ? 's' : ''} on this item` : 'No materials added yet'}</Body>
      {editable && mode === 'none' ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button label="From my stock" kind="secondary" onPress={() => setMode('van')} style={{ flex: 1 }} />
          <Button label="Bought out" kind="secondary" onPress={() => setMode('bought')} style={{ flex: 1 }} />
        </View>
      ) : null}
      {mode === 'van' ? (
        <Card>
          <Field label="Quantity" value={qty} onChangeText={setQty} keyboardType="decimal-pad" />
          <Label>Tap the item you used</Label>
          {s.cache.stock.length === 0 ? <Body quiet>Nothing on your name. Book it out from the stockroom on the job card.</Body> : null}
          {s.cache.stock.map(l => (
            <Card key={l.id} onPress={() => useVan(l.id, l.description, l.qty)} style={{ backgroundColor: C.panel2 }}>
              <Text style={[st.body, { fontWeight: '700' }]}>{l.description}</Text>
              <Text style={st.small}>{l.code} · {l.qty} {l.unit} on your name</Text>
            </Card>
          ))}
          <Button label="Cancel" kind="quiet" onPress={() => setMode('none')} />
        </Card>
      ) : null}
      {mode === 'bought' ? (
        <Card>
          <Field label="What was bought" value={desc} onChangeText={setDesc} placeholder="e.g. 2.5mm cable, 10 m" />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label="Qty" value={qty} onChangeText={setQty} keyboardType="decimal-pad" /></View>
            <View style={{ flex: 1 }}><Field label="Price paid (R)" value={price} onChangeText={setPrice} keyboardType="decimal-pad" /></View>
          </View>
          <Button label={slip ? 'Slip photo taken ✓ (retake)' : 'Photo of the slip'} kind="secondary" onPress={async () => { const p = await takePhoto(); if (p) setSlip(p); }} />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button label="Cancel" kind="quiet" onPress={() => setMode('none')} style={{ flex: 1 }} />
            <Button label="Add" onPress={addBought} style={{ flex: 1 }} />
          </View>
        </Card>
      ) : null}
    </View>
  );
}
