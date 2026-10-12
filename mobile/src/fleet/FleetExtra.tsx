// The mechanic's bookings, the map of where every vehicle is, and putting technicians in vehicles
// when their phone is off or broken.
import React, { useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { AreaMap, nearest as nearestPlace, type MapPin } from '../map/AreaMap.tsx';
import { useStore } from '../state.tsx';
import { nowIso } from '../device.ts';
import * as F from '../../../server/src/core/fleet.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, st } from '../ui.tsx';
import { C, S } from '../theme.ts';
import type { useFleet } from './useFleet.ts';
import type { FleetVehicle, Position, TimeSlot } from './types.ts';
import { K, SLOT_LABEL, STATUS, TYPE_LABEL, ago, dayName, km, nextDays } from './common.ts';
import type { Sel } from './FleetApp.tsx';

type FleetHook = ReturnType<typeof useFleet>;
type Open = (s: Sel) => void;
const PLACES = ['Own workshop', 'Tyre Mart, Alton', 'Toyota Richards Bay', 'Licensing office, Richards Bay'] as const;
const scroll = { padding: S.pad, gap: S.gap, paddingBottom: 60 };

// ---- Bookings ------------------------------------------------------------------------------

export function BookingsList({ f, due, open }: { f: FleetHook; due: FleetVehicle[]; open: Open }) {
  const upcoming = f.d.bookings.filter(b => b.status === 'booked');
  const past = f.d.bookings.filter(b => b.status !== 'booked');
  const days = [...new Set(upcoming.map(b => b.booked_for))];
  return (
    <>
      <Button label="Book a vehicle in" onPress={() => open({ kind: 'newbooking' })} />
      {due.length ? (
        <>
          <Heading>Due, not booked yet</Heading>
          {due.map(x => (
            <Card key={x.id} style={{ borderColor: x.serviceDue.state === 'overdue' || x.licenceDue.state === 'overdue' ? C.bad : C.warn }}>
              <Text style={[st.body, { fontWeight: '800' }]}>{x.registration} <Text style={st.small}>{[x.make, x.model].filter(Boolean).join(' ')}</Text></Text>
              {x.serviceDue.state === 'soon' || x.serviceDue.state === 'overdue' ? <Text style={[st.body, { color: x.serviceDue.state === 'overdue' ? C.bad : C.warn }]}>{x.serviceDue.text}</Text> : null}
              {x.licenceDue.state === 'soon' || x.licenceDue.state === 'overdue' ? <Text style={[st.body, { color: x.licenceDue.state === 'overdue' ? C.bad : C.warn }]}>{x.licenceDue.text}</Text> : null}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button label="Book in" kind="secondary" onPress={() => open({ kind: 'newbooking', vehicleId: x.id })} style={{ flex: 1, minHeight: 44 }} />
                <Button label="Vehicle" kind="quiet" onPress={() => open({ kind: 'vehicle', id: x.id })} style={{ flex: 1, minHeight: 44 }} />
              </View>
            </Card>
          ))}
        </>
      ) : null}
      <Heading>Booked in</Heading>
      {!upcoming.length ? <Body quiet>Nothing booked.</Body> : null}
      {days.map(dy => (
        <View key={dy} style={{ gap: 8 }}>
          <Label>{dayName(dy)}</Label>
          {upcoming.filter(b => b.booked_for === dy).map(b => (
            <Card key={b.id} onPress={() => open({ kind: 'booking', id: b.id })} accessibilityLabel={`Booking ${b.registration}`}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{b.registration}</Text>
                <Pill text={TYPE_LABEL[b.job_type]} tone="info" />
                <Pill text={SLOT_LABEL[b.time_slot]} tone="quiet" />
              </View>
              <Body numberOfLines={2}>{b.reason}</Body>
              <Text style={st.small}>{b.place}{b.driver ? ` · driver ${b.driver}` : ''}</Text>
            </Card>
          ))}
        </View>
      ))}
      {past.length ? (
        <>
          <Heading>Last week</Heading>
          {past.map(b => (
            <Card key={b.id}>
              <Text style={[st.body, { fontWeight: '700' }]}>{b.registration} · {TYPE_LABEL[b.job_type]} · {b.booked_for}</Text>
              <Text style={st.small}>{b.status === 'started' ? 'Job card opened' : `Cancelled: ${b.cancelled_note ?? ''}`}</Text>
            </Card>
          ))}
        </>
      ) : null}
    </>
  );
}

export function NewBooking({ vehicleId, f, done }: { vehicleId?: string; f: FleetHook; done: () => void }) {
  const s = useStore();
  const [vid, setVid] = useState<string | undefined>(vehicleId);
  const v = f.d.vehicles.find(x => x.id === vid);
  const [type, setType] = useState<F.FleetJobType>(v?.licenceDue.state === 'overdue' ? 'roadworthy' : 'service');
  const [date, setDate] = useState<string>();
  const [slot, setSlot] = useState<TimeSlot>('morning');
  const [place, setPlace] = useState<string>('Own workshop');
  const [other, setOther] = useState('');
  const [reason, setReason] = useState(() => (v && v.serviceDue.state !== 'ok' && v.serviceDue.state !== 'unknown' ? v.serviceDue.text : ''));
  const [reasons, setReasons] = useState<string[] | null>(null);
  const days = nextDays(15);
  const already = vid ? f.d.bookings.find(b => b.vehicle_id === vid && b.status === 'booked') : undefined;

  const submit = () => {
    const missing = [!vid ? 'which vehicle' : null, !date ? 'the date' : null, place === 'Other' && other.trim().length < 2 ? 'where it goes' : null,
      reason.trim().length < 5 ? 'what it is booked in for' : null].filter(Boolean) as string[];
    if (already) missing.push(`${v!.registration} is already booked for ${dayName(already.booked_for)}: move that booking instead`);
    if (missing.length) { setReasons(missing); return; }
    f.act(`Booked ${v!.registration} in`, 'POST', `/fleet/vehicles/${vid}/bookings`, {
      id: s.newId(), jobType: type, bookedFor: date, timeSlot: slot, place: place === 'Other' ? other.trim() : place, reason: reason.trim(), at: nowIso(),
    }, done);
  };

  return (
    <ScrollView contentContainerStyle={scroll}>
      <Heading>Book a vehicle in{v ? ` · ${v.registration}` : ''}</Heading>
      {!vehicleId ? (
        <>
          <Label>Vehicle</Label>
          <Choice options={f.d.vehicles.map(x => x.id)} value={vid} onChange={setVid} labels={Object.fromEntries(f.d.vehicles.map(x => [x.id, x.registration]))} />
        </>
      ) : null}
      {already ? <Notice tone="warn" title="Already booked" lines={[`${dayName(already.booked_for)}: ${already.reason}`]} /> : null}
      <Label>For</Label>
      <Choice options={F.JOB_TYPES} value={type} onChange={setType} labels={TYPE_LABEL} />
      <Label>Day</Label>
      <Choice options={days} value={date} onChange={setDate} labels={Object.fromEntries(days.map(d => [d, dayName(d)]))} />
      <Label>Time</Label>
      <Choice options={['morning', 'afternoon', 'all_day'] as const} value={slot} onChange={setSlot} labels={SLOT_LABEL} />
      <Label>Where</Label>
      <Choice options={[...PLACES, 'Other'] as const} value={place as (typeof PLACES)[number] | 'Other'} onChange={setPlace} />
      {place === 'Other' ? <Field label="Where does it go?" value={other} onChangeText={setOther} /> : null}
      <Field label="What for?" value={reason} onChangeText={setReason} multiline placeholder="e.g. 90 000 km service, replace rear tyres" />
      <Text style={st.small}>The driver and his manager are told, so the vehicle is there on the day.</Text>
      {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}
      <Button label="Book it in" onPress={submit} />
    </ScrollView>
  );
}

export function BookingScreen({ id, f, open, done }: { id: string; f: FleetHook; open: Open; done: () => void }) {
  const b = f.d.bookings.find(x => x.id === id);
  const [panel, setPanel] = useState<'none' | 'move' | 'cancel'>('none');
  const [date, setDate] = useState<string>();
  const [slot, setSlot] = useState<TimeSlot>();
  const [note, setNote] = useState('');
  if (!b) return <ScrollView contentContainerStyle={scroll}><Body quiet>Booking not found.</Body></ScrollView>;
  const days = nextDays(15);
  const v = f.d.vehicles.find(x => x.id === b.vehicle_id);
  return (
    <ScrollView contentContainerStyle={scroll}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: C.text, fontSize: 28, fontWeight: '800', letterSpacing: 1, flex: 1 }}>{b.registration}</Text>
        <Pill text={b.status === 'booked' ? 'Booked' : b.status === 'started' ? 'Started' : 'Cancelled'} tone={b.status === 'booked' ? 'info' : b.status === 'started' ? 'good' : 'quiet'} />
      </View>
      <Card>
        <Label>{TYPE_LABEL[b.job_type]}</Label>
        <Text style={[st.body, { fontWeight: '800', fontSize: 20 }]}>{dayName(b.booked_for)} · {SLOT_LABEL[b.time_slot]}</Text>
        <Body>{b.place}</Body>
        <Body>{b.reason}</Body>
        <Text style={st.small}>{b.driver ? `Driver: ${b.driver} · ` : 'Nobody is driving it · '}booked by {b.booked_by}</Text>
      </Card>
      {b.status === 'booked' ? (
        <>
          {v?.open_job ? <Notice tone="warn" title={`Job card ${v.open_job.number} is still open on this vehicle`} lines={['Complete it before you start this booking.']} />
            : <Button label="It's here: open the job card" onPress={() => open({ kind: 'newjob', vehicleId: b.vehicle_id, bookingId: b.id })} />}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button label="Move" kind="secondary" onPress={() => setPanel(panel === 'move' ? 'none' : 'move')} style={{ flex: 1 }} />
            <Button label="Cancel booking" kind="secondary" onPress={() => setPanel(panel === 'cancel' ? 'none' : 'cancel')} style={{ flex: 1 }} />
          </View>
          {panel === 'move' ? (
            <Card>
              <Label>New day</Label>
              <Choice options={days} value={date} onChange={setDate} labels={Object.fromEntries(days.map(d => [d, dayName(d)]))} />
              <Choice options={['morning', 'afternoon', 'all_day'] as const} value={slot ?? b.time_slot} onChange={setSlot} labels={SLOT_LABEL} />
              <Field label="Why is it moved?" value={note} onChangeText={setNote} />
              <Button label="Move booking" disabled={!date || note.trim().length < 5}
                onPress={() => f.act(`Moved ${b.registration}'s booking`, 'POST', `/fleet/bookings/${b.id}/move`, { bookedFor: date, timeSlot: slot ?? b.time_slot, note: note.trim() }, () => setPanel('none'))} />
            </Card>
          ) : null}
          {panel === 'cancel' ? (
            <Card>
              <Field label="Why is it cancelled?" value={note} onChangeText={setNote} />
              <Button label="Cancel booking" kind="danger" disabled={note.trim().length < 5}
                onPress={() => f.act(`Cancelled ${b.registration}'s booking`, 'POST', `/fleet/bookings/${b.id}/cancel`, { note: note.trim() }, done)} />
            </Card>
          ) : null}
        </>
      ) : null}
      <Button label="Open the vehicle" kind="quiet" onPress={() => open({ kind: 'vehicle', id: b.vehicle_id })} />
    </ScrollView>
  );
}

// ---- Map -------------------------------------------------------------------------------------

const pinColour = (p: Position) => (p.minutesAgo == null || p.minutesAgo > 60 ? C.quiet : p.status === 'off_road' ? C.bad : p.status === 'workshop' ? C.warn : C.good);

export function FleetMap({ f, open }: { f: FleetHook; open: Open }) {
  const [picked, setPicked] = useState<string>();
  const pts = f.d.positions;
  const pins: MapPin[] = pts.filter(p => p.lat != null && p.lng != null).map(p => ({ id: p.id, lat: p.lat!, lng: p.lng!, label: p.registration, colour: pinColour(p), accessibilityLabel: `Map pin ${p.registration}` }));
  const sel = pts.find(p => p.id === picked);
  const moving = pts.filter(p => p.ignition).length;
  const stale = pts.filter(p => p.minutesAgo == null || p.minutesAgo > 60).length;

  return (
    <>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Card style={{ flex: 1 }}><Label>Moving</Label><Text style={{ color: C.text, fontSize: 26, fontWeight: '800' }}>{moving}</Text></Card>
        <Card style={{ flex: 1 }}><Label>Parked</Label><Text style={{ color: C.text, fontSize: 26, fontWeight: '800' }}>{pts.length - moving - stale}</Text></Card>
        <Card style={{ flex: 1, borderColor: stale ? C.warn : C.line }}><Label>No signal</Label><Text style={{ color: C.text, fontSize: 26, fontWeight: '800' }}>{stale}</Text></Card>
      </View>
      <AreaMap pins={pins} picked={picked} onPick={setPicked} label="Map of the vehicles" />
      <Text style={st.small}>Green: in service · amber: workshop · red: off the road · grey: no tracker signal for an hour. Tap a vehicle.</Text>

      {sel ? <PinCard p={sel} open={open} /> : null}

      <Heading>All vehicles</Heading>
      {pts.map(p => (
        <Card key={p.id} onPress={() => setPicked(p.id)} accessibilityLabel={`Where is ${p.registration}`} style={picked === p.id ? { borderColor: K.bandText } : undefined}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: pinColour(p) }} />
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{p.registration}</Text>
            <Text style={st.small}>{p.ignition ? `${p.speed_kmh ?? 0} km/h` : 'Parked'} · {ago(p.minutesAgo)}</Text>
          </View>
          <Text style={st.small}>{p.driver ? p.driver : 'Nobody on it'} · near {nearest(p)}</Text>
        </Card>
      ))}
    </>
  );
}

const nearest = (p: Position) => nearestPlace(p.lat, p.lng);

function PinCard({ p, open }: { p: Position; open: Open }) {
  return (
    <Card style={{ borderColor: K.bandText }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: C.text, fontSize: 22, fontWeight: '800', letterSpacing: 1, flex: 1 }}>{p.registration}</Text>
        <Pill text={STATUS[p.status].text} tone={STATUS[p.status].tone} />
      </View>
      <Body>{p.driver ? `Driven by ${p.driver}` : 'Nobody is on this vehicle'}</Body>
      <Text style={st.small}>{p.ignition ? `Moving, ${p.speed_kmh ?? 0} km/h` : 'Parked'} · near {nearest(p)} · {ago(p.minutesAgo)}</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Button label="Open vehicle" kind="secondary" onPress={() => open({ kind: 'vehicle', id: p.id })} style={{ flexBasis: '46%', flexGrow: 1, minHeight: 44 }} />
        {p.lat != null ? <Button label="Open in Maps" kind="secondary" onPress={() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`).catch(() => undefined)}
          style={{ flexBasis: '46%', flexGrow: 1, minHeight: 44 }} /> : null}
      </View>
    </Card>
  );
}

// ---- Technicians and their vehicles ------------------------------------------------------------

export function TechList({ f, open }: { f: FleetHook; open: Open }) {
  return (
    <>
      <Notice tone="info" title="Phone off or broken?" lines={['Put the technician in a vehicle here, or take it off his name. He and his manager are told, and it is logged against you.']} />
      {f.d.techs.map(t => (
        <Card key={t.id} onPress={() => open({ kind: 'assign', techId: t.id })} accessibilityLabel={`Technician ${t.full_name}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{t.full_name}</Text>
            {t.registration ? <Pill text={t.mode === 'driving' ? 'Driving' : 'Riding along'} tone={t.mode === 'driving' ? 'info' : 'quiet'} /> : <Pill text="No vehicle" tone="quiet" />}
          </View>
          <Text style={st.small}>{t.registration ? `In ${t.registration}` : 'Not in a vehicle'}</Text>
        </Card>
      ))}
      {!f.d.techs.length ? <Body quiet>No technicians loaded yet.</Body> : null}
    </>
  );
}

const QUICK = ['Phone is off / flat battery', 'Phone is broken', 'App not working on his phone'];

export function AssignScreen({ techId, vehicleId, f, done }: { techId?: string; vehicleId?: string; f: FleetHook; done: () => void }) {
  const [tid, setTid] = useState(techId);
  const [vid, setVid] = useState(vehicleId);
  const t = f.d.techs.find(x => x.id === tid);
  const v = f.d.vehicles.find(x => x.id === vid);
  const [mode, setMode] = useState<'driving' | 'riding_along'>('driving');
  const [kmText, setKm] = useState(() => { const k = f.d.vehicles.find(x => x.id === vehicleId)?.km; return k != null ? String(k) : ''; });
  const [reason, setReason] = useState('');
  const [releasing, setReleasing] = useState(false);
  const [reasons, setReasons] = useState<string[] | null>(null);
  const kmNow = Number(kmText.replace(/\s/g, ''));
  const startKm = (vehicle?: FleetVehicle) => setKm(vehicle?.km != null ? String(vehicle.km) : '');
  const current = t?.vehicle_id ? f.d.vehicles.find(x => x.id === t.vehicle_id) : undefined;

  const assign = () => {
    const missing = [!tid ? 'which technician' : null, !vid ? 'which vehicle' : null, reason.trim().length < 5 ? 'why you are doing it for him' : null].filter(Boolean) as string[];
    if (v && mode === 'driving') {
      if (v.status !== 'in_service') missing.push(`${v.registration} is ${STATUS[v.status].text.toLowerCase()}: put it back in service first`);
      if (!kmText.trim()) missing.push('odometer reading (km)');
      else if (v.km != null && kmNow < v.km) missing.push(`odometer cannot be lower than ${km(v.km)}`);
    }
    if (missing.length) { setReasons(missing); return; }
    f.act(`Put ${t!.full_name} in ${v!.registration}`, 'POST', `/fleet/vehicles/${vid}/assign`, {
      technicianId: tid, mode, reason: reason.trim(), ...(mode === 'driving' ? { km: kmNow } : {}), at: nowIso(),
    }, done);
  };

  const release = () => {
    const missing = [reason.trim().length < 5 ? 'why you are doing it for him' : null] as (string | null)[];
    if (t?.mode === 'driving') {
      if (!kmText.trim()) missing.push('odometer reading (km)');
      else if (current?.km != null && kmNow < current.km) missing.push(`odometer cannot be lower than ${km(current.km)}`);
    }
    const m = missing.filter(Boolean) as string[];
    if (m.length) { setReasons(m); return; }
    f.act(`Took ${t!.registration} off ${t!.full_name}`, 'POST', `/fleet/technicians/${tid}/release`, {
      reason: reason.trim(), ...(t?.mode === 'driving' ? { km: kmNow } : {}), at: nowIso(),
    }, done);
  };

  return (
    <ScrollView contentContainerStyle={scroll}>
      <Heading>{t ? t.full_name : v ? `Put a technician in ${v.registration}` : 'Put a technician in a vehicle'}</Heading>
      {!techId ? (
        <>
          <Label>Technician</Label>
          <Choice options={f.d.techs.map(x => x.id)} value={tid} onChange={x => { setTid(x); setReasons(null); }} labels={Object.fromEntries(f.d.techs.map(x => [x.id, x.full_name]))} />
        </>
      ) : null}
      {t ? <Body quiet>{t.registration ? `Now ${t.mode === 'driving' ? 'driving' : 'riding along in'} ${t.registration}.` : 'Not in a vehicle now.'}</Body> : null}

      {t?.registration && techId && !releasing ? (
        <Button label={`Take ${t.registration} off his name`} kind="secondary" onPress={() => { setReleasing(true); startKm(current); setReasons(null); }} />
      ) : null}

      {releasing && t ? (
        <>
          <Heading>Take {t.registration} off his name</Heading>
          {t.mode === 'driving' ? <Field label="Odometer now (km)" value={kmText} onChangeText={setKm} keyboardType="number-pad" /> : null}
          <Label>Why are you doing it for him?</Label>
          <Choice options={[...QUICK, 'Back at the yard'] as string[]} value={reason} onChange={setReason} />
          <Field label="Or type it" value={reason} onChangeText={setReason} />
          {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}
          <Button label="Take vehicle off his name" onPress={release} />
          <Button label="Back" kind="quiet" onPress={() => setReleasing(false)} />
        </>
      ) : (
        <>
          <Heading>Put him in a vehicle</Heading>
          {!vehicleId ? (
            <>
              <Label>Vehicle</Label>
              <Choice options={f.d.vehicles.map(x => x.id)} value={vid} onChange={x => { setVid(x); startKm(f.d.vehicles.find(y => y.id === x)); setReasons(null); }}
                labels={Object.fromEntries(f.d.vehicles.map(x => [x.id, `${x.registration}${x.status !== 'in_service' ? ` (${STATUS[x.status].text.toLowerCase()})` : x.driver ? ` · ${x.driver.split(' ')[0]}` : ''}`]))} />
            </>
          ) : null}
          {v?.driver && mode === 'driving' && v.driver !== t?.full_name ? <Notice tone="warn" title={`${v.driver} is driving ${v.registration}`} lines={['He is taken off it and told.']} /> : null}
          <Label>He is</Label>
          <Choice options={['driving', 'riding_along'] as const} value={mode} onChange={setMode} labels={{ driving: 'Driving', riding_along: 'Riding along' }} />
          {mode === 'driving' ? <Field label="Odometer now (km)" value={kmText} onChangeText={x => setKm(x)} keyboardType="number-pad" hint={v?.km != null ? `Last reading ${km(v.km)}` : undefined}
            onFocus={() => { if (!kmText) startKm(v); }} /> : null}
          <Label>Why are you doing it for him?</Label>
          <Choice options={QUICK as unknown as string[]} value={reason} onChange={setReason} />
          <Field label="Or type it" value={reason} onChangeText={setReason} />
          <Text style={st.small}>His phone shows the vehicle as put in by the mechanic, and the tracker is told who is driving.</Text>
          {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}
          <Button label={t ? `Put ${t.full_name.split(' ')[0]} in${v ? ` ${v.registration}` : ''}` : 'Put him in'} onPress={assign} />
        </>
      )}
    </ScrollView>
  );
}

// ---- Daily checks --------------------------------------------------------------------------------

const FLUID = { ok: 'OK', topped_up: 'Topped up', problem: 'Problem' } as const;
const TYRES = { ok: 'OK', pressure_adjusted: 'Pressure adjusted', problem: 'Problem' } as const;
const OIL_CHIPS = ['0.25', '0.5', '1', '2'] as const;

/** The summary at the top of the Vehicles list. */
export function DailyChecksCard({ f, open }: { f: FleetHook; open: Open }) {
  const c = f.d.checks;
  if (!c) return null;
  const next = c.vehicles.find(v => v.required && !v.id);
  const all = c.done >= c.due;
  return (
    <Card style={{ borderColor: all ? C.good : C.warn, borderWidth: 2 }} accessibilityLabel="Daily checks">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>Daily checks today</Text>
        <Pill text={`${c.done} of ${c.due}`} tone={all ? 'good' : 'warn'} />
      </View>
      <Text style={st.small}>Oil, water and tyres on every vehicle in service. Oil added is always noted.</Text>
      {next ? <Button label={`Check ${next.registration}`} onPress={() => open({ kind: 'check', vehicleId: next.vehicle_id })} style={{ minHeight: 48 }} />
        : <Text style={[st.body, { color: C.good }]}>All done for today.</Text>}
    </Card>
  );
}

export function DailyCheckScreen({ vehicleId, f, ws, open, done }: { vehicleId: string; f: FleetHook; ws?: import('./Workshop.tsx').WorkshopData | null; open: Open; done: () => void }) {
  const oilStock = ws?.lines.find(l => l.daily_check_use === 'oil');
  const waterStock = ws?.lines.find(l => l.daily_check_use === 'water');
  const s = useStore();
  const v = f.d.vehicles.find(x => x.id === vehicleId);
  const hist = f.d.details[vehicleId]?.dailyChecks ?? [];
  React.useEffect(() => { f.loadVehicle(vehicleId); }, [vehicleId]);
  const [kmText, setKm] = useState('');
  const [oil, setOil] = useState<F.FluidResult>();
  const [oilL, setOilL] = useState('');
  const [water, setWater] = useState<F.FluidResult>();
  const [waterL, setWaterL] = useState('');
  const [tyres, setTyres] = useState<F.TyreResult>();
  const [notes, setNotes] = useState('');
  const [reasons, setReasons] = useState<string[] | null>(null);
  const num = (t: string) => (t.trim() === '' ? null : Number(t.replace(',', '.').replace(/\s/g, '')));
  const draft: F.DailyCheckDraft = { odometerKm: num(kmText), oil, oilLitres: oil === 'topped_up' ? num(oilL) : null, water, waterLitres: water === 'topped_up' ? num(waterL) : null, tyres, notes };

  // Warn before saving if this top-up makes three in a week, or 2 litres.
  const since = new Date(Date.now() - F.OIL_WATCH_DAYS * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
  const recent = hist.filter(h => h.oil === 'topped_up' && h.check_date > since).map(h => ({ litres: h.oil_litres ?? 0 }));
  const watch = oil === 'topped_up' && (draft.oilLitres ?? 0) > 0 ? F.oilWatch([...recent, { litres: draft.oilLitres! }]) : null;
  const checkedToday = !!v?.checked_today;

  const save = () => {
    const missing = F.missingOnDailyCheck(draft, v?.km ?? null);
    if (checkedToday) missing.push(`${v!.registration} was already checked today`);
    if (missing.length) { setReasons(missing); return; }
    f.act(`Daily check ${v!.registration}`, 'POST', `/fleet/vehicles/${vehicleId}/daily-check`, { id: s.newId(), ...draft, notes: notes.trim() || null, at: nowIso() }, () => {
      const next = f.d.checks?.vehicles.find(x => x.required && !x.id && x.vehicle_id !== vehicleId);
      done();
      if (next) open({ kind: 'check', vehicleId: next.vehicle_id });
    });
  };

  if (!v) return <ScrollView contentContainerStyle={scroll}><Body quiet>Vehicle not found.</Body></ScrollView>;
  return (
    <ScrollView contentContainerStyle={scroll}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: C.text, fontSize: 28, fontWeight: '800', letterSpacing: 1, flex: 1 }}>{v.registration}</Text>
        <Pill text="Daily check" tone="info" />
      </View>
      <Body quiet>{[v.make, v.model].filter(Boolean).join(' ')}{v.driver ? ` · ${v.driver}` : ''}</Body>
      {checkedToday ? <Notice tone="good" title="Already checked today" lines={['One check per vehicle per day. It is locked once saved.']} /> : null}
      {recent.length ? <Notice tone="warn" title={`Oil added ${recent.length} time${recent.length > 1 ? 's' : ''} this week`} lines={[`${recent.reduce((n, r) => n + r.litres, 0)} L in total. Look for leaks or blue smoke.`]} /> : null}

      <Field label="Odometer (km)" value={kmText} onChangeText={setKm} keyboardType="number-pad" hint={v.km != null ? `Last reading ${km(v.km)}` : undefined} />

      <Heading>Oil</Heading>
      <Choice options={['ok', 'topped_up', 'problem'] as const} value={oil} onChange={setOil} labels={FLUID} />
      {oil === 'topped_up' ? (
        <Card style={{ borderColor: C.warn }}>
          <Label>How much oil did you add? (must be noted)</Label>
          <Choice options={OIL_CHIPS} value={OIL_CHIPS.find(c => c === oilL)} onChange={setOilL} labels={{ '0.25': '¼ L', '0.5': '½ L', '1': '1 L', '2': '2 L' }} />
          <Field label="Litres" value={oilL} onChangeText={setOilL} keyboardType="decimal-pad" placeholder="e.g. 0.5" />
          {oilStock ? <Text style={st.small}>Comes off the workshop: {oilStock.description}, {oilStock.qty} L there.</Text> : null}
        </Card>
      ) : null}
      {watch?.flag ? <Notice tone="bad" title="This engine is using oil" lines={[watch.text, 'Saving raises it as a fault and tells the driver\'s manager.']} /> : null}

      <Heading>Water / coolant</Heading>
      <Choice options={['ok', 'topped_up', 'problem'] as const} value={water} onChange={setWater} labels={FLUID} />
      {water === 'topped_up' ? <Field label="Litres added (if you know)" value={waterL} onChangeText={setWaterL} keyboardType="decimal-pad" hint={waterStock ? `Comes off the workshop: ${waterStock.description}, ${waterStock.qty} L there` : undefined} /> : null}

      <Heading>Tyres</Heading>
      <Choice options={['ok', 'pressure_adjusted', 'problem'] as const} value={tyres} onChange={setTyres} labels={TYRES} />

      <Field label={[oil, water, tyres].includes('problem') ? 'What is the problem? (becomes a fault)' : 'Notes (optional)'} value={notes} onChangeText={setNotes} multiline
        placeholder="e.g. front right tyre worn on the inside edge" />

      {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}
      <Button label="Save daily check" onPress={save} disabled={checkedToday} />

      {hist.length ? (
        <>
          <Heading>Last checks</Heading>
          <DailyCheckHistory rows={hist.slice(0, 7)} />
        </>
      ) : null}
    </ScrollView>
  );
}

export function DailyCheckHistory({ rows }: { rows: import('./types.ts').DailyCheck[] }) {
  return (
    <Card>
      {rows.map(h => {
        const bad = [h.oil, h.water, h.tyres].includes('problem');
        return (
          <View key={h.id} style={{ gap: 2, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Text style={[st.body, { fontWeight: '700', minWidth: 96 }]}>{dayName(h.check_date)}</Text>
              <Text style={[st.small, { flex: 1 }]}>{km(h.odometer_km)} · {h.by}</Text>
              {bad ? <Pill text="Problem" tone="bad" /> : null}
            </View>
            <Text style={[st.small, { color: h.oil === 'topped_up' ? C.warn : h.oil === 'problem' ? C.bad : C.quiet }]}>
              Oil: {h.oil === 'topped_up' ? `topped up ${h.oil_litres} L` : FLUID[h.oil].toLowerCase()} · Water: {h.water === 'topped_up' ? `topped up${h.water_litres ? ` ${h.water_litres} L` : ''}` : FLUID[h.water].toLowerCase()} · Tyres: {TYRES[h.tyres].toLowerCase()}
            </Text>
            {h.notes ? <Text style={st.small}>{h.notes}</Text> : null}
          </View>
        );
      })}
    </Card>
  );
}
