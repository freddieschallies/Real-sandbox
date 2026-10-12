// The mechanic's bookings, the map of where every vehicle is, and putting technicians in vehicles
// when their phone is off or broken.
import React, { useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import Svg, { Circle, Line, Rect, Text as SvgText } from 'react-native-svg';
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

/** Places to find your way on the map. */
const LANDMARKS: { name: string; lat: number; lng: number }[] = [
  { name: 'Office yard (Alton)', lat: -28.7499, lng: 32.0507 },
  { name: 'Richards Bay CBD', lat: -28.7606, lng: 32.0420 },
  { name: 'Meerensee', lat: -28.7743, lng: 32.0789 },
  { name: 'Harbour', lat: -28.7990, lng: 32.0720 },
  { name: 'Empangeni', lat: -28.7621, lng: 31.8932 },
  { name: 'Esikhawini', lat: -28.8710, lng: 31.9150 },
];
/** The main road from Empangeni to Richards Bay, roughly. */
const ROAD: [number, number][] = [[-28.7621, 31.8932], [-28.7560, 31.9500], [-28.7520, 32.0000], [-28.7499, 32.0507], [-28.7606, 32.0420], [-28.7743, 32.0789]];

/** Richards Bay itself; vehicles outside it are listed under the map. */
const TOWN = { s: -28.812, n: -28.738, w: 32.018, e: 32.098 };
const inTown = (lat: number, lng: number) => lat >= TOWN.s && lat <= TOWN.n && lng >= TOWN.w && lng <= TOWN.e;

const pinColour = (p: Position) => (p.minutesAgo == null || p.minutesAgo > 60 ? C.quiet : p.status === 'off_road' ? C.bad : p.status === 'workshop' ? C.warn : C.good);

export function FleetMap({ f, open }: { f: FleetHook; open: Open }) {
  const [w, setW] = useState(0);
  const [picked, setPicked] = useState<string>();
  const [zoom, setZoom] = useState<'town' | 'all'>('town');
  const pts = f.d.positions;
  const h = Math.max(260, Math.min(460, w * 0.85));
  const fixed = pts.filter(p => p.lat != null && p.lng != null);
  const shown = zoom === 'all' ? fixed : fixed.filter(p => inTown(p.lat!, p.lng!));
  const outside = fixed.filter(p => !shown.includes(p));
  const marks = zoom === 'all' ? LANDMARKS : LANDMARKS.filter(l => inTown(l.lat, l.lng));

  // Fit what is shown, keeping the shape right (a degree of longitude is shorter here).
  const proj = useMemo(() => {
    const lats = zoom === 'all' ? [...fixed.map(p => p.lat!), ...LANDMARKS.map(l => l.lat)] : [TOWN.s, TOWN.n];
    const lngs = zoom === 'all' ? [...fixed.map(p => p.lng!), ...LANDMARKS.map(l => l.lng)] : [TOWN.w, TOWN.e];
    const pad = zoom === 'all' ? 0.012 : 0.002;
    let [s0, n0, w0, e0] = [Math.min(...lats) - pad, Math.max(...lats) + pad, Math.min(...lngs) - pad, Math.max(...lngs) + pad];
    const k = Math.cos((s0 + n0) / 2 * Math.PI / 180);
    const spanX = (e0 - w0) * k, spanY = n0 - s0;
    const ratio = w / h;
    if (spanX / spanY > ratio) { const extra = (spanX / ratio - spanY) / 2; s0 -= extra; n0 += extra; }
    else { const extra = (spanY * ratio - spanX) / 2 / k; w0 -= extra; e0 += extra; }
    return (lat: number, lng: number) => ({ x: (lng - w0) / (e0 - w0) * w, y: (n0 - lat) / (n0 - s0) * h });
  }, [fixed.map(p => `${p.lat},${p.lng}`).join('|'), w, h, zoom]);

  // Labels step down when vehicles stand close together, and flip left at the right edge.
  const pins = useMemo(() => {
    const placed: { x: number; y: number }[] = [];
    return shown.map(p => proj(p.lat!, p.lng!)).map((xy, i) => {
      // Try right, left, below, above the pin; only stack down if all four are taken.
      const spots = [[xy.x + 12, xy.y - 9], [xy.x - 92, xy.y - 9], [xy.x - 40, xy.y + 12], [xy.x - 40, xy.y - 30]].filter(([x]) => x >= 0 && x + 86 <= w);
      const free = (x: number, y: number) => !placed.some(q => Math.abs(q.x - x) < 86 && Math.abs(q.y - y) < 18);
      let [lx, ly] = spots.find(([x, y]) => free(x, y)) ?? spots[0] ?? [xy.x + 12, xy.y - 9];
      while (!free(lx, ly)) ly += 18;
      placed.push({ x: lx, y: ly });
      return { p: shown[i], ...xy, lx, ly };
    });
  }, [proj, shown.map(p => p.id).join()]);

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
      <Choice options={['town', 'all'] as const} value={zoom} onChange={setZoom} labels={{ town: 'Richards Bay', all: 'Whole area' }} />
      <View onLayout={e => setW(e.nativeEvent.layout.width)} style={{ height: h, borderRadius: S.radius, overflow: 'hidden', backgroundColor: '#1D2B3A', borderWidth: 1, borderColor: C.line }}
        accessibilityLabel="Map of the vehicles">
        {w > 0 ? (
          <>
            <Svg width={w} height={h} pointerEvents="none">
              <Rect x={0} y={0} width={w} height={h} fill="#1D2B3A" />
              {ROAD.slice(1).map((pt, i) => {
                const a = proj(ROAD[i][0], ROAD[i][1]), b = proj(pt[0], pt[1]);
                return <Line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#4A5A6E" strokeWidth={4} strokeLinecap="round" />;
              })}
              {marks.map(l => {
                const p = proj(l.lat, l.lng);
                return (
                  <React.Fragment key={l.name}>
                    <Rect x={p.x - 3} y={p.y - 3} width={6} height={6} fill="#8FA3B8" />
                    <SvgText x={p.x + 6} y={p.y + 16} fill="#8FA3B8" fontSize={11}>{l.name}</SvgText>
                  </React.Fragment>
                );
              })}
              {sel && sel.lat != null && shown.includes(sel) ? (() => { const p = proj(sel.lat, sel.lng!); return <Circle cx={p.x} cy={p.y} r={18} fill="none" stroke="#FFFFFF" strokeWidth={2} />; })() : null}
            </Svg>
            {pins.map(({ p, x, y, lx, ly }) => (
              <React.Fragment key={p.id}>
                <Pressable onPress={() => setPicked(p.id)} accessibilityRole="button" accessibilityLabel={`Map pin ${p.registration}`} hitSlop={10}
                  style={{ position: 'absolute', left: x - 10, top: y - 10, width: 20, height: 20, borderRadius: 10, backgroundColor: pinColour(p), borderWidth: 2, borderColor: picked === p.id ? '#FFFFFF' : '#0E141B' }} />
                <Pressable onPress={() => setPicked(p.id)} accessibilityElementsHidden importantForAccessibility="no"
                  style={{ position: 'absolute', left: lx, top: ly, backgroundColor: picked === p.id ? '#FFFFFF' : 'rgba(14,20,27,0.85)', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                  <Text style={{ color: picked === p.id ? '#0E141B' : '#FFFFFF', fontSize: 11, fontWeight: '800' }}>{p.registration}</Text>
                </Pressable>
              </React.Fragment>
            ))}
          </>
        ) : null}
      </View>
      {outside.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <Text style={st.small}>Out of town:</Text>
          {outside.map(p => (
            <Pressable key={p.id} onPress={() => setPicked(p.id)} accessibilityRole="button" style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: C.panel2 }}>
              <Text style={{ color: C.text, fontWeight: '700' }}>{p.registration} · {nearest(p)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
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

function nearest(p: Position) {
  if (p.lat == null || p.lng == null) return 'unknown';
  let best = LANDMARKS[0], dist = Infinity;
  for (const l of LANDMARKS) { const d = (l.lat - p.lat) ** 2 + ((l.lng - p.lng) * 0.88) ** 2; if (d < dist) { dist = d; best = l; } }
  return best.name;
}

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
