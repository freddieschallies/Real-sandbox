// The office's Machine workshop tab (not the vehicles: those are in the Vehicle workshop): machines
// in the workshop (booked in by the office, or uplifted from site by a technician), being repaired or
// ready to go back; booking one in; the company's loan machines and where each one is; and where the
// workshop is (technicians starting a workshop visit are checked against it).
import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import { positionNow } from '../device.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, st } from '../ui.tsx';
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

  const cameIn = (j: (typeof inShop)[number]) => {
    const c = j.came_in ?? '';
    return c.startsWith('booked_in') ? c.replace(/^booked_in:?\s*/, '') || 'Booked in by the office' : c.startsWith('uplifted') ? 'Uplifted from site' : j.job_type === 'workshop_repair' ? 'Brought in' : 'Uplifted from site';
  };
  const row = (j: (typeof inShop)[number]) => {
    const days = j.workshop_since ? daysSince(j.workshop_since) : null;
    return (
      <Card key={j.id} onPress={() => openJob(j.id)} accessibilityLabel={`Job ${j.job_number}`}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={[st.body, { fontWeight: '800' }]}>#{j.job_number}</Text>
          <Text numberOfLines={1} style={[st.body, { flex: 1, minWidth: 120 }]}>{j.machine ?? j.store}</Text>
          <Pill text={j.ready_to_deliver ? 'Ready to go back' : 'Being repaired'} tone={j.ready_to_deliver ? 'good' : 'warn'} />
          {(j.loans_out ?? 0) > 0 ? <Pill text="Loan out" tone="info" /> : null}
        </View>
        {j.machine ? <Text style={st.small}>{j.store}</Text> : null}
        <Body numberOfLines={2}>{j.fault_reported}</Body>
        <Text style={[st.small, days !== null && days >= 14 && !j.ready_to_deliver ? { color: C.bad } : null]}>{cameIn(j)}{j.workshop_since ? ` ${day(j.workshop_since)} (${days} day${days === 1 ? '' : 's'} in the workshop)` : ''} · {j.lead_technician}</Text>
      </Card>
    );
  };
  const [booking, setBooking] = useState(false);

  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontSize: 24, fontWeight: '800', flex: 1, minWidth: 180 }}>Machine workshop</Text>
        {!booking ? <Button label="+ Book a machine in" onPress={() => setBooking(true)} /> : null}
      </View>
      <Text style={st.small}>Machines repaired in our workshop (bakery equipment, pumps, anything that cannot be fixed on site). Vehicles are in the Vehicle workshop.</Text>
      {booking ? <BookIn o={o} done={id => { setBooking(false); o.load(); if (id) openJob(id); }} /> : null}
      <Heading>In the workshop{inShop.length ? ` (${inShop.length})` : ''}</Heading>
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

/** Booking a machine in: the client brought it, or we collected it. It becomes a workshop repair job card. */
function BookIn({ o, done }: { o: OfficeHook; done: (jobId?: string) => void }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const [storeId, setStoreId] = useState<string | null>(null);
  const [eq, setEq] = useState<{ id: string; description: string; brand: string | null; model: string | null; serial: string | null }[] | null>(null);
  const [equipmentId, setEquipmentId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [desc, setDesc] = useState(''); const [brand, setBrand] = useState(''); const [model, setModel] = useState(''); const [serial, setSerial] = useState('');
  const [fault, setFault] = useState('');
  const [came, setCame] = useState<'client_brought' | 'we_collected'>('client_brought');
  const [by, setBy] = useState('');
  const [lead, setLead] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [holdOk, setHoldOk] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const store = o.d.stores.find(x => x.id === storeId);
  const stores = o.d.stores.filter(x => !q.trim() || `${x.client} ${x.name} ${x.address ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8);
  useEffect(() => {
    setEq(null); setEquipmentId(null); setIsNew(false);
    if (storeId) s.ask({ method: 'GET', path: `/stores/${storeId}/equipment` }).then(r => { if (r?.status === 200) { setEq(r.body); if (!r.body.length) setIsNew(true); } }).catch(() => setEq([]));
  }, [storeId]);
  const save = async () => {
    const missing = [!storeId ? 'whose machine it is (the store)' : null, !equipmentId && !(isNew && desc.trim().length >= 2) ? 'which machine' : null,
      fault.trim().length < 3 ? 'what is wrong with it' : null, !lead ? 'who repairs it' : null].filter(Boolean) as string[];
    if (missing.length) { setErr(missing); return; }
    setBusy(true); setErr(null);
    const r = await s.ask({ method: 'POST', path: '/workshop/book-in', json: {
      storeId, ...(equipmentId ? { equipmentId } : { machine: { description: desc.trim(), ...(brand.trim() ? { brand: brand.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...(serial.trim() ? { serial: serial.trim() } : {}) } }),
      faultReported: fault.trim(), cameIn: came, ...(by.trim() ? { handedOverBy: by.trim() } : {}), leadTechnicianId: lead, ...(ref.trim() ? { clientOrderRef: ref.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}), ...(holdOk ? { holdOk: true } : {}),
    } }).catch(() => null);
    setBusy(false);
    if (r && r.status < 300) done((r.body as { id: string }).id);
    else setErr((r?.body as { reasons?: string[] })?.reasons ?? ['Not booked in: needs signal.']);
  };
  return (
    <Card style={{ borderColor: C.accent, borderWidth: 2 }}>
      <Heading>Book a machine in</Heading>
      <Label>Whose machine (client and store)</Label>
      {store ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}><Text style={[st.body, { fontWeight: '800' }]}>{store.name}</Text><Text style={st.small}>{store.client}</Text></View>
          <Button label="Change" kind="quiet" onPress={() => setStoreId(null)} />
        </View>
      ) : (
        <>
          <TextInput value={q} onChangeText={setQ} placeholder="Search client or store" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search stores" />
          {stores.map(x => (
            <Pressable key={x.id} onPress={() => setStoreId(x.id)} accessibilityRole="button" accessibilityLabel={`Store ${x.name}`} style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.panel2 }}>
              <Text style={[st.body, { fontWeight: '700' }]}>{x.name}</Text><Text style={st.small}>{x.client}</Text>
            </Pressable>
          ))}
        </>
      )}
      {store?.client_on_hold ? (
        <Pressable onPress={() => setHoldOk(!holdOk)} accessibilityRole="checkbox" accessibilityState={{ checked: holdOk }} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Text style={{ fontSize: 20, color: holdOk ? C.bad : C.quiet }}>{holdOk ? '☑' : '☐'}</Text>
          <Text style={[st.body, { color: C.bad, flex: 1 }]}>{store.client} is on hold: book it in anyway (Accounts is told)</Text>
        </Pressable>
      ) : null}
      {storeId ? (
        <>
          <Label>Which machine</Label>
          {eq === null ? <Body quiet>Loading the store's machines…</Body> : null}
          {(eq ?? []).map(e => (
            <Pressable key={e.id} onPress={() => { setEquipmentId(e.id); setIsNew(false); }} accessibilityRole="radio" accessibilityState={{ selected: equipmentId === e.id }} accessibilityLabel={`Machine ${e.description}`}
              style={{ padding: 10, borderRadius: 8, borderWidth: equipmentId === e.id ? 2 : 1, borderColor: equipmentId === e.id ? C.accent : C.line, backgroundColor: C.panel2 }}>
              <Text style={[st.body, { fontWeight: '700' }]}>{e.description}</Text>
              <Text style={st.small}>{[e.brand, e.model].filter(Boolean).join(' ') || '–'}{e.serial ? ` · serial ${e.serial}` : ''}</Text>
            </Pressable>
          ))}
          {isNew ? (
            <View style={{ gap: 8 }}>
              <Field label="What it is" value={desc} onChangeText={setDesc} placeholder="e.g. Bread slicer, Water pump, Proofer" />
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <View style={{ flexGrow: 1, flexBasis: 140 }}><Field label="Brand" value={brand} onChangeText={setBrand} /></View>
                <View style={{ flexGrow: 1, flexBasis: 140 }}><Field label="Model" value={model} onChangeText={setModel} /></View>
                <View style={{ flexGrow: 1, flexBasis: 140 }}><Field label="Serial number" value={serial} onChangeText={setSerial} autoCapitalize="characters" /></View>
              </View>
              <Text style={st.small}>It is added to the store's machines.</Text>
            </View>
          ) : <Button label="+ A machine not on the list" kind="quiet" onPress={() => { setIsNew(true); setEquipmentId(null); }} />}
        </>
      ) : null}
      <Field label="What is wrong with it" value={fault} onChangeText={setFault} multiline placeholder="e.g. Motor runs but the blades do not turn" />
      <Label>How it came in</Label>
      <Choice options={['client_brought', 'we_collected'] as const} value={came} onChange={setCame} labels={{ client_brought: 'The client brought it', we_collected: 'We collected it' }} />
      <Field label={came === 'client_brought' ? 'Who brought it (name)' : 'Who handed it over at the store (name)'} value={by} onChangeText={setBy} />
      <Label>Who repairs it</Label>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {o.d.techs.map(t => (
          <Pressable key={t.id} onPress={() => setLead(t.id)} accessibilityRole="radio" accessibilityState={{ selected: lead === t.id }} accessibilityLabel={`Technician ${t.full_name}`}
            style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, borderWidth: 2, borderColor: lead === t.id ? C.accent : C.line }}>
            <Text style={{ color: C.text, fontWeight: '700' }}>{lead === t.id ? '✓ ' : ''}{t.full_name}</Text>
          </Pressable>
        ))}
      </View>
      <Field label="Client's order number (optional)" value={ref} onChangeText={setRef} />
      <Field label="Note (optional): condition, parts with it, accessories" value={note} onChangeText={setNote} multiline />
      {err ? <Notice tone="bad" title="Still needed" lines={err} /> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Cancel" kind="quiet" onPress={() => done()} style={{ flex: 1 }} />
        <Button label="Book it in" busy={busy} onPress={save} style={{ flex: 2 }} />
      </View>
      <Text style={st.small}>The technician gets the job card on his phone; he starts it at the workshop. When it is repaired it shows here as ready to go back.</Text>
    </Card>
  );
}
