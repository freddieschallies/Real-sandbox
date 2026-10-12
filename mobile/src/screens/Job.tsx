// The job card. What the technician sees depends only on where the job is in the forced path:
// Go → Arrived (manager + safety) → Start → work items → Done → sign-off, or Continue later.
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { positionNow, nowIso } from '../device.ts';
import { J } from '../local.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, Screen, Toggle, st } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';
import { C } from '../theme.ts';
import type { CardView } from '../types.ts';

const PAUSES = ['waiting_for_parts', 'collecting_parts', 'store_asked_to_stop', 'break'] as const;
const STEP: Record<string, string> = {
  not_started: 'Not started', on_the_way: 'On the way', arrived: 'Arrived', working: 'Working',
  paused: 'Paused', done: 'Done – waiting for sign-off', continue_later: 'Continue later',
};
const TYPE: Record<string, string> = { breakdown: 'Breakdown', planned_maintenance: 'Planned maintenance', installation: 'Installation', quote_visit: 'Quote visit', follow_up: 'Follow-up' };
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }) : '–');

export function Job({ jobId }: { jobId: string }) {
  const s = useStore();
  const nav = useNav();
  const v = s.cache.cards[jobId];
  const [reasons, setReasons] = useState<string[] | null>(null);
  useEffect(() => { s.loadCard(jobId); }, [jobId]);

  if (!v) {
    return (
      <Screen title="Job card" onBack={nav.back} right={<SyncPill />}>
        <Body quiet>This job card is not on the phone yet. It needs signal once to download.</Body>
        <Button label="Try again" kind="secondary" onPress={() => s.loadCard(jobId)} />
      </Screen>
    );
  }

  const run = (label: string, rule: (c: J.JobCard) => J.Result, path: string, json: object, after?: (v: CardView) => CardView) => {
    const r = s.jobAction(jobId, label, rule, { method: 'POST', path: `/jobs/${jobId}/${path}`, json }, after);
    setReasons(r.ok ? null : r.reasons);
    return r.ok;
  };

  const state = v.status === 'closed' ? 'closed' : v.currentState;
  const visit = v.visits.at(-1);
  const finished = v.items.filter(i => i.status === 'finished').length;

  return (
    <Screen title={`#${v.job_number} · ${v.store}`} sub={v.store_address ?? undefined} onBack={nav.back} right={<SyncPill />}>
      <Card>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Pill text={state === 'closed' ? 'Closed' : STEP[state]} tone={state === 'closed' ? 'good' : state === 'working' ? 'info' : state === 'paused' || state === 'continue_later' ? 'warn' : 'quiet'} />
          {v.priority === 'urgent' ? <Pill text="Urgent" tone="bad" /> : null}
          <Pill text={TYPE[v.job_type] ?? v.job_type} tone="quiet" />
        </View>
        <Label>Reported fault</Label>
        <Body>{v.fault_reported}</Body>
        {v.client_order_ref ? <Body quiet>Order ref: {v.client_order_ref}</Body> : null}
        {v.visits.length ? <Body quiet>Visit {v.visits.length} · on the way {time(visit?.goAt)} · arrived {time(visit?.arrivedAt)} · job time {v.jobMinutes} min</Body> : null}
      </Card>

      {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}

      {(state === 'not_started' || state === 'continue_later' || (state === 'done' && v.status !== 'in_progress')) ? (
        <>
          {state === 'continue_later' ? <Notice tone="warn" title="Continue later" lines={['Tap Go when you leave for this store again. A new visit starts.']} /> : null}
          <Button label="Go – I'm on the way" onPress={() => run(`On the way to ${v.store}`, c => J.go(c, nowIso()), 'go', { at: nowIso() })} />
        </>
      ) : null}

      {state === 'on_the_way' ? <ArriveForm v={v} onRefused={setReasons} /> : null}

      {state === 'arrived' ? (
        <>
          <Notice tone="good" title={`Checked in with ${visit?.checkedInManager ?? 'the manager'}`} lines={['Safety checks done.']} />
          <Button label="Start job – timer starts" onPress={() => run('Started work', c => J.start(c, nowIso()), 'start', { at: nowIso() })} />
        </>
      ) : null}

      {['working', 'paused', 'done', 'closed'].includes(state) ? (
        <>
          <Heading>Work items · {finished} of {v.items.length} finished</Heading>
          {v.items.map(it => (
            <Card key={it.id} onPress={() => nav.push({ name: 'item', jobId, itemId: it.id })} accessibilityLabel={it.title}>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <Pill text={it.status === 'finished' ? 'Finished' : it.status === 'in_progress' ? 'In progress' : 'Not started'}
                  tone={it.status === 'finished' ? 'good' : it.status === 'in_progress' ? 'info' : 'quiet'} />
                {it.origin === 'found_on_site' ? <Pill text="Found on site" tone="quiet" /> : null}
              </View>
              <Text style={{ color: C.text, fontSize: 18, fontWeight: '700' }}>{it.title}</Text>
              {it.missing.length && state !== 'closed' ? <Text style={st.small}>Still needed: {it.missing.join(', ')}</Text> : null}
            </Card>
          ))}
          {state === 'working' || state === 'paused' ? <AddItem jobId={jobId} onRefused={setReasons} /> : null}
        </>
      ) : null}

      {v.checklist.length && ['working', 'paused', 'done', 'closed'].includes(state) ? (
        <>
          <Heading>Maintenance checklist</Heading>
          {v.checklist.map(c => (
            <Toggle key={c.id} label={c.step} value={c.done} onChange={on => {
              if (!on || c.done || state === 'closed') return;
              s.jobAction(jobId, `Checklist: ${c.step}`, card => ({ ok: true, card }),
                { method: 'POST', path: `/jobs/${jobId}/checklist/${c.id}`, json: { at: nowIso() } },
                view => ({ ...view, checklist: view.checklist.map(x => (x.id === c.id ? { ...x, done: true } : x)) }));
            }} />
          ))}
        </>
      ) : null}

      <JobStock jobId={jobId} closed={state === 'closed'} />

      {state === 'working' ? (
        <>
          <Button label="Done – all work finished" onPress={() => run('Job done', c => J.done(c, nowIso()), 'done', { at: nowIso() })} />
          <PauseBox onPause={reason => run(`Paused: ${reason.replace(/_/g, ' ')}`, c => J.pause(c, reason, nowIso()), 'pause', { at: nowIso(), reason })} />
          <Button label="Continue later (another day)" kind="secondary" onPress={() => nav.push({ name: 'later', jobId })} />
        </>
      ) : null}

      {state === 'paused' ? (
        <>
          <Notice tone="warn" title={`Paused: ${visit?.pauses.at(-1)?.reason.replace(/_/g, ' ')}`} lines={[`Since ${time(visit?.pauses.at(-1)?.at)}. The job timer is stopped.`]} />
          <Button label="Resume work" onPress={() => run('Resumed work', c => J.resume(c, nowIso()), 'resume', { at: nowIso() })} />
          <Button label="Continue later (another day)" kind="secondary" onPress={() => nav.push({ name: 'later', jobId })} />
        </>
      ) : null}

      {state === 'done' && v.status === 'in_progress' ? (
        <Button label="Store manager sign-off" onPress={() => nav.push({ name: 'signoff', jobId })} />
      ) : null}

      {state === 'closed' ? <Notice tone="good" title="Job closed and locked" lines={[v.manager_name ? `Signed by ${v.manager_name}` : 'Closed without signature – the office has been told.']} /> : null}
    </Screen>
  );
}

function ArriveForm({ v, onRefused }: { v: CardView; onRefused: (r: string[] | null) => void }) {
  const s = useStore();
  const [manager, setManager] = useState('');
  const [areaSafe, setAreaSafe] = useState(false);
  const [isolated, setIsolated] = useState(false);
  const [publicClear, setPublicClear] = useState(false);
  const [outside, setOutside] = useState(false);
  const [outsideReason, setOutsideReason] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    // Demo jobs are made-up stores, so the demo pretends you are standing at the store.
    const position = s.session?.mode === 'demo' ? { lat: v.store_lat, lng: v.store_lng } : await positionNow();
    setBusy(false);
    const at = nowIso();
    const safety = { areaSafe, isolated, publicClear };
    const input = { at, managerName: manager, safety, outsideReason: outsideReason || undefined };
    const r = s.jobAction(v.id, `Arrived at ${v.store}`, c => J.arrive(c, { ...input, vehiclePosition: position ?? undefined }),
      { method: 'POST', path: `/jobs/${v.id}/arrive`, json: { ...input, position: position ?? undefined } });
    if (r.ok) { onRefused(null); return; }
    if (r.reasons.some(x => x.startsWith('you are not at the store'))) setOutside(true);
    onRefused(r.reasons);
  };

  return (
    <Card>
      <Heading>Arrived</Heading>
      <Field label="Store manager you checked in with" value={manager} onChangeText={setManager} placeholder="Full name" autoCapitalize="words" />
      {v.storeManagers.length ? <Choice options={v.storeManagers} value={manager} onChange={setManager} labels={Object.fromEntries(v.storeManagers.map(m => [m, m]))} /> : null}
      <Label>Safety</Label>
      <Toggle label="Work area is safe" value={areaSafe} onChange={setAreaSafe} />
      <Toggle label="Power / gas / water isolated where needed" value={isolated} onChange={setIsolated} />
      <Toggle label="Public kept clear of the work area" value={publicClear} onChange={setPublicClear} />
      {outside ? (
        <Field label="You are not at the store. Why?" value={outsideReason} onChangeText={setOutsideReason} multiline
          hint="For example: dropped off by a colleague, store's loading bay is round the back. Your supervisor sees this." />
      ) : null}
      <Button label="Confirm arrived" onPress={submit} busy={busy} />
    </Card>
  );
}

function AddItem({ jobId, onRefused }: { jobId: string; onRefused: (r: string[] | null) => void }) {
  const s = useStore();
  const nav = useNav();
  const [title, setTitle] = useState('');
  const [open, setOpen] = useState(false);
  if (!open) return <Button label="+ Add something else found on site" kind="secondary" onPress={() => setOpen(true)} />;
  const add = () => {
    const id = s.newId();
    const t = title.trim();
    if (t.length < 3) { onRefused(['a short title for the new work item']); return; }
    const item: J.WorkItem = { id, title: t, origin: 'found_on_site', beforePhotos: 0, afterPhotos: 0, vanStockLines: 0, boughtOutLines: 0, noMaterials: false };
    const r = s.jobAction(jobId, `Added item: ${t}`, c => J.addItem(c, item), { method: 'POST', path: `/jobs/${jobId}/items`, json: { id, title: t } });
    if (!r.ok) { onRefused(r.reasons); return; }
    onRefused(null);
    setTitle(''); setOpen(false);
    nav.push({ name: 'item', jobId, itemId: id });
  };
  return (
    <Card>
      <Field label="What else did you find?" value={title} onChangeText={setTitle} placeholder="e.g. Cold room door seal torn" />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Cancel" kind="quiet" onPress={() => setOpen(false)} style={{ flex: 1 }} />
        <Button label="Add item" onPress={add} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

function PauseBox({ onPause }: { onPause: (r: J.PauseReason) => boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<J.PauseReason>();
  if (!open) return <Button label="Pause" kind="secondary" onPress={() => setOpen(true)} />;
  return (
    <Card>
      <Label>Why are you pausing?</Label>
      <Choice options={PAUSES} value={reason} onChange={setReason} />
      {reason === 'collecting_parts' ? <Text style={st.small}>This opens a supply run. Your trip to the supplier is checked against the tracker.</Text> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Cancel" kind="quiet" onPress={() => setOpen(false)} style={{ flex: 1 }} />
        <Button label="Pause now" disabled={!reason} onPress={() => { if (reason && onPause(reason)) setOpen(false); }} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

/** Stock for this job: booked out, used on the card, and still on the technician's name. */
function JobStock({ jobId, closed }: { jobId: string; closed: boolean }) {
  const s = useStore();
  const nav = useNav();
  const lines = s.cache.jobStock?.[jobId] ?? [];
  const left = lines.filter(l => l.onTechnician > 0);
  const invoices = (s.cache.invoices ?? []).filter(i => i.job_id === jobId && i.status !== 'confirmed');
  return (
    <>
      <Heading>Stock for this job</Heading>
      {invoices.map(i => (
        <Card key={i.id} onPress={i.status === 'reading' ? undefined : () => nav.push({ name: 'invoice', invoiceId: i.id })} style={{ borderColor: C.warn }}>
          <Text style={[st.body, { color: C.warn, fontWeight: '700' }]}>{i.status === 'reading' ? 'Supplier invoice: reading…' : 'Supplier invoice read: tap to check and confirm'}</Text>
        </Card>
      ))}
      {lines.length ? (
        <Card>
          {lines.map(l => (
            <View key={l.stockItemId} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Text style={[st.body, { flex: 1 }]} numberOfLines={1}>{l.description}</Text>
              <Text style={st.small}>out {l.booked} · used {l.used}{l.returned ? ` · back ${l.returned}` : ''}</Text>
              <Text style={{ color: l.onTechnician > 0 ? (closed ? C.bad : C.warn) : C.good, fontWeight: '700', minWidth: 28, textAlign: 'right' }}>{l.onTechnician}</Text>
            </View>
          ))}
          <Text style={st.small}>Last column: still on your name for this job.</Text>
        </Card>
      ) : <Body quiet>Nothing booked out for this job yet.</Body>}
      {closed && left.length ? <Notice tone="bad" title="Return what was not used" lines={left.map(l => `${l.onTechnician} × ${l.description}`)} /> : null}
      {closed && left.length ? <Button label="Return to stockroom" kind="secondary" onPress={() => nav.push({ name: 'return' })} /> : null}
      {!closed ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button label="Book out" kind="secondary" onPress={() => nav.push({ name: 'bookout', jobId })} style={{ flex: 1 }} />
          <Button label="Scan invoice" kind="secondary" onPress={() => nav.push({ name: 'invoice', jobId })} style={{ flex: 1 }} />
        </View>
      ) : null}
    </>
  );
}
