// The office's Workshop tab: machines in the workshop (being repaired, or ready to go back), the
// company's loan machines and where each one is, and where the workshop is (technicians starting a
// workshop visit are checked against it).
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { positionNow } from '../device.ts';
import { Body, Button, Card, Field, Heading, Label, Notice, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';
import type { LoanMachine, Workshop } from '../types.ts';
import type { OfficeHook } from './useOffice.ts';

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }) : '');
const daysSince = (iso?: string) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)) : 0);

export function WorkshopBoard({ o, openJob }: { o: OfficeHook; openJob: (id: string) => void }) {
  const s = useStore();
  const [loans, setLoans] = useState<LoanMachine[] | null>(null);
  const [ws, setWs] = useState<{ workshop: Workshop | null; canEdit: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    s.ask({ method: 'GET', path: '/loan-machines' }).then(r => r?.status === 200 && setLoans(r.body)).catch(() => {});
    s.ask({ method: 'GET', path: '/company/workshop' }).then(r => r?.status === 200 && setWs(r.body)).catch(() => {});
  }, [tick, o.d.loadedAt]);
  const open = (st: string) => st !== 'closed' && st !== 'cancelled';
  const inShop = o.d.jobs.filter(j => open(j.status) && j.machine_at === 'workshop');
  const ready = inShop.filter(j => j.ready_to_deliver);
  const repairing = inShop.filter(j => !j.ready_to_deliver);
  const out = (loans ?? []).filter(l => l.out);

  const row = (j: (typeof inShop)[number]) => (
    <Card key={j.id} onPress={() => openJob(j.id)} accessibilityLabel={`Job ${j.job_number}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.body, { fontWeight: '800' }]}>#{j.job_number}</Text>
        <Text numberOfLines={1} style={[st.body, { flex: 1 }]}>{j.store}</Text>
        <Pill text={j.ready_to_deliver ? 'Ready to deliver' : 'Being repaired'} tone={j.ready_to_deliver ? 'good' : 'warn'} />
        {(j.loans_out ?? 0) > 0 ? <Pill text="Loan out" tone="info" /> : null}
      </View>
      <Body numberOfLines={2}>{j.fault_reported}</Body>
      <Text style={st.small}>{j.job_type === 'workshop_repair' ? 'Workshop repair' : 'Uplifted from site'} · {j.lead_technician}</Text>
    </Card>
  );

  return (
    <>
      <Heading>In the workshop</Heading>
      {!inShop.length ? <Body quiet>No machines in the workshop.</Body> : null}
      {ready.length ? <><Label>Ready to go back ({ready.length})</Label>{ready.map(row)}</> : null}
      {repairing.length ? <><Label>Being repaired ({repairing.length})</Label>{repairing.map(row)}</> : null}

      <Heading>Loan machines</Heading>
      {loans === null ? <Body quiet>Loading… (needs signal)</Body> : null}
      {loans && !loans.length ? <Body quiet>No loan machines yet{ws?.canEdit ? ': add them below.' : '.'}</Body> : null}
      {loans?.length ? <Text style={st.small}>{out.length} of {loans.filter(l => l.active).length} out at clients</Text> : null}
      {(loans ?? []).map(l => <LoanRow key={l.id} l={l} canEdit={!!ws?.canEdit} openJob={openJob} changed={() => setTick(t => t + 1)} />)}
      {ws?.canEdit ? <AddLoan added={() => setTick(t => t + 1)} /> : null}

      <Heading>Where the workshop is</Heading>
      {ws ? <WorkshopPlace ws={ws.workshop} canEdit={ws.canEdit} saved={w => setWs({ workshop: w, canEdit: ws.canEdit })} /> : <Body quiet>Loading…</Body>}
    </>
  );
}

function LoanRow({ l, canEdit, openJob, changed }: { l: LoanMachine; canEdit: boolean; openJob: (id: string) => void; changed: () => void }) {
  const s = useStore();
  const [msg, setMsg] = useState<string | null>(null);
  const toggle = async () => {
    const r = await s.ask({ method: 'PUT', path: `/loan-machines/${l.id}`, json: { active: !l.active } });
    if (r && r.status < 300) changed(); else setMsg((r?.body as { reasons?: string[] })?.reasons?.[0] ?? 'Needs signal.');
  };
  const long = l.out && daysSince(l.since) >= 14;
  return (
    <Card onPress={l.out && l.job_id ? () => openJob(l.job_id!) : undefined} accessibilityLabel={`Loan machine ${l.name}`} style={!l.active ? { opacity: 0.6 } : undefined}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{l.name}</Text>
        <Pill text={!l.active ? 'Retired' : l.out ? 'Out' : 'In'} tone={!l.active ? 'quiet' : l.out ? (long ? 'bad' : 'warn') : 'good'} />
      </View>
      {l.serial || l.asset_number ? <Text style={st.small}>{[l.serial ? `Serial ${l.serial}` : '', l.asset_number ? `Asset ${l.asset_number}` : ''].filter(Boolean).join(' · ')}</Text> : null}
      {l.out ? <Text style={[st.small, long ? { color: C.bad } : null]}>At {l.store} since {day(l.since)} ({daysSince(l.since)} days) · job {l.job_number} · left by {l.by_name}</Text> : null}
      {l.notes ? <Text style={st.small}>{l.notes}</Text> : null}
      {canEdit && !l.out ? <Button label={l.active ? 'Retire' : 'Use again'} kind="quiet" onPress={toggle} /> : null}
      {msg ? <Notice tone="bad" title={msg} /> : null}
    </Card>
  );
}

function AddLoan({ added }: { added: () => void }) {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [serial, setSerial] = useState('');
  const [asset, setAsset] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!open) return <Button label="Add a loan machine" kind="secondary" onPress={() => setOpen(true)} />;
  const save = async () => {
    if (name.trim().length < 2) { setMsg('Give it a name, e.g. "Loan ice machine 1".'); return; }
    const r = await s.ask({ method: 'POST', path: '/loan-machines', json: { name: name.trim(), ...(serial.trim() ? { serial: serial.trim() } : {}), ...(asset.trim() ? { assetNumber: asset.trim() } : {}) } });
    if (r && r.status < 300) { setName(''); setSerial(''); setAsset(''); setOpen(false); setMsg(null); added(); }
    else setMsg((r?.body as { reasons?: string[] })?.reasons?.[0] ?? 'Not saved: needs signal.');
  };
  return (
    <Card>
      <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Loan ice machine 1 (Scotsman AC 86)" />
      <Field label="Serial number (optional)" value={serial} onChangeText={setSerial} autoCapitalize="characters" />
      <Field label="Asset number (optional)" value={asset} onChangeText={setAsset} autoCapitalize="characters" />
      {msg ? <Notice tone="bad" title={msg} /> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Cancel" kind="quiet" onPress={() => setOpen(false)} style={{ flex: 1 }} />
        <Button label="Add" onPress={save} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

function WorkshopPlace({ ws, canEdit, saved }: { ws: Workshop | null; canEdit: boolean; saved: (w: Workshop) => void }) {
  const s = useStore();
  const [edit, setEdit] = useState(!ws && canEdit);
  const [name, setName] = useState(ws?.name ?? 'Workshop');
  const [address, setAddress] = useState(ws?.address ?? '');
  const [lat, setLat] = useState(ws ? String(ws.lat) : '');
  const [lng, setLng] = useState(ws ? String(ws.lng) : '');
  const [msg, setMsg] = useState<string | null>(null);
  const here = async () => {
    const p = await positionNow();
    if (p) { setLat(p.lat.toFixed(5)); setLng(p.lng.toFixed(5)); } else setMsg('Could not get your location: allow location, or type it in.');
  };
  const save = async () => {
    const la = Number(lat), ln = Number(lng);
    if (!lat || !lng || Number.isNaN(la) || Number.isNaN(ln)) { setMsg('The map position: stand in the workshop and tap "I am at the workshop", or type it in.'); return; }
    const r = await s.ask({ method: 'PUT', path: '/company/workshop', json: { name: name.trim() || 'Workshop', address: address.trim() || undefined, lat: la, lng: ln, geofenceM: 150 } });
    if (r && r.status < 300) { saved(r.body.workshop); setEdit(false); setMsg(null); }
    else setMsg((r?.body as { reasons?: string[] })?.reasons?.[0] ?? 'Not saved: needs signal.');
  };
  if (!edit) {
    return (
      <Card>
        {ws ? <>
          <Text style={[st.body, { fontWeight: '800' }]}>{ws.name}</Text>
          {ws.address ? <Text style={st.small}>{ws.address}</Text> : null}
          <Text style={st.small}>Map position {ws.lat.toFixed(5)}, {ws.lng.toFixed(5)} · technicians must be within {ws.geofence_m} m to start a workshop visit</Text>
        </> : <Body quiet>Not set yet: technicians cannot start workshop visits until it is.</Body>}
        {canEdit ? <Button label={ws ? 'Change' : 'Set the workshop'} kind="secondary" onPress={() => setEdit(true)} /> : null}
      </Card>
    );
  }
  return (
    <Card>
      <Field label="Name" value={name} onChangeText={setName} />
      <Field label="Address" value={address} onChangeText={setAddress} />
      <Button label="I am at the workshop: use my location" kind="secondary" onPress={here} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}><Field label="Latitude" value={lat} onChangeText={setLat} keyboardType="numbers-and-punctuation" /></View>
        <View style={{ flex: 1 }}><Field label="Longitude" value={lng} onChangeText={setLng} keyboardType="numbers-and-punctuation" /></View>
      </View>
      {msg ? <Notice tone="bad" title={msg} /> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {ws ? <Button label="Cancel" kind="quiet" onPress={() => setEdit(false)} style={{ flex: 1 }} /> : null}
        <Button label="Save" onPress={save} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}
