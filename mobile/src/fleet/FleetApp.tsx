// The mechanic's app: the fleet only. Everything hangs off a vehicle: its details, km, faults and
// the mechanic's own job cards. Phone: tabs at the bottom. Desktop: menu, list and detail side by side.
import { BottomTabs } from '../BottomTabs.tsx';
import { VehicleBarcodes } from './Barcodes.tsx';
import { ItemPicture, Thumb } from '../ItemPicture.tsx';
import { usePhoneMenu } from '../menu.tsx';
import { ModeToggle } from '../appearance.tsx';
import { BrandLogo } from '../brand.tsx';
import React, { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../state.tsx';
import { nowIso } from '../device.ts';
import * as F from '../../../server/src/core/fleet.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, rand, st } from '../ui.tsx';
import { SyncPill } from '../screens/SyncPill.tsx';
import { C, S } from '../theme.ts';
import { useFleet, type Shot } from './useFleet.ts';
import type { Fault, FleetJob, FleetVehicle } from './types.ts';
import { DUE, K, SEV, STATUS, TYPE_LABEL, dayName, km, today, when, SLOT_LABEL } from './common.ts';
import { WorkshopItem, WorkshopList, useWorkshop } from './Workshop.tsx';
import { AssignScreen, BookingScreen, BookingsList, DailyCheckHistory, DailyCheckScreen, DailyChecksCard, FleetMap, NewBooking, TechList } from './FleetExtra.tsx';
import { ChangePassword } from '../screens/MyPassword.tsx';

type Tab = 'vehicles' | 'map' | 'bookings' | 'faults' | 'jobs' | 'stock' | 'techs' | 'codes';
export type Sel = { kind: 'vehicle'; id: string } | { kind: 'job'; id: string } | { kind: 'newjob'; vehicleId: string; bookingId?: string } | { kind: 'report'; vehicleId: string }
  | { kind: 'booking'; id: string } | { kind: 'check'; vehicleId: string } | { kind: 'wsitem'; id: string } | { kind: 'newbooking'; vehicleId?: string } | { kind: 'assign'; techId?: string; vehicleId?: string };

export function FleetApp() {
  const s = useStore();
  const ins = useSafeAreaInsets();
  const menu = usePhoneMenu();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const f = useFleet();
  const ws = useWorkshop();
  const [tab, setTab] = useState<Tab>('vehicles');
  useEffect(() => { if (tab === 'stock') ws.load(); }, [tab]);
  const [stack, setStack] = useState<Sel[]>([]);
  const sel = stack.at(-1) ?? null;
  const open = (x: Sel) => setStack(st0 => (wide && (x.kind === 'vehicle' || x.kind === 'booking' || x.kind === 'wsitem' || (x.kind === 'assign' && !!x.techId && tab === 'techs')) ? [x] : [...st0, x]));
  const back = () => setStack(st0 => st0.slice(0, -1));
  const v = f.d.vehicles;
  const due = v.filter(x => x.serviceDue.state === 'overdue' || x.serviceDue.state === 'soon' || x.licenceDue.state === 'overdue' || x.licenceDue.state === 'soon');

  const booked = new Set(f.d.bookings.filter(b => b.status === 'booked').map(b => b.vehicle_id));
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'vehicles', label: 'Vehicles' },
    { key: 'map', label: 'Map' },
    { key: 'bookings', label: 'Booked', count: due.filter(x => !booked.has(x.id)).length },
    { key: 'faults', label: 'Faults', count: f.d.faults.filter(x => x.status === 'open').length },
    { key: 'jobs', label: 'Jobs', count: f.d.jobs.length },
    { key: 'stock', label: 'Stock', count: ws.data?.belowMin },
    { key: 'techs', label: 'Techs' },
    { key: 'codes', label: 'QR codes' },
  ];

  const list = (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 40 }}>
      {tab === 'vehicles' ? <><DailyChecksCard f={f} open={open} /><VehicleList vehicles={v} open={id => open({ kind: 'vehicle', id })} /></> : null}
      {tab === 'faults' ? <FaultList faults={f.d.faults} open={id => open({ kind: 'vehicle', id })} /> : null}
      {tab === 'jobs' ? <JobList jobs={f.d.jobs} open={id => open({ kind: 'job', id })} /> : null}
      {tab === 'map' ? <FleetMap f={f} open={open} /> : null}
      {tab === 'bookings' ? <BookingsList f={f} due={due.filter(x => !booked.has(x.id))} open={open} /> : null}
      {tab === 'techs' ? <TechList f={f} open={open} /> : null}
      {tab === 'codes' ? <VehicleBarcodes /> : null}
      {tab === 'stock' ? <WorkshopList ws={ws} role="mechanic" open={id => open({ kind: 'wsitem', id })} /> : null}
      <ChangePassword />
      {!wide ? <Button label="Sign out" kind="quiet" onPress={s.signOut} disabled={s.waiting > 0} /> : null}
      <Text style={st.small}>{f.d.loadedAt ? `Updated ${when(f.d.loadedAt)}` : f.loading ? 'Loading…' : 'Needs signal to load.'}</Text>
    </ScrollView>
  );

  const detail = (() => {
    if (!sel) return null;
    if (sel.kind === 'vehicle') return <VehicleScreen key={sel.id} id={sel.id} f={f} open={open} />;
    if (sel.kind === 'job') { const j = f.d.jobs.find(x => x.id === sel.id); return j ? <JobScreen key={j.id} j={j} f={f} ws={ws} done={back} /> : <Body quiet>Job card completed.</Body>; }
    if (sel.kind === 'newjob') return <NewJob key={sel.vehicleId} vehicleId={sel.vehicleId} bookingId={sel.bookingId} f={f} done={back} />;
    if (sel.kind === 'wsitem') return <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60 }}><WorkshopItem key={sel.id} id={sel.id} ws={ws} role="mechanic" done={back} /></ScrollView>;
    if (sel.kind === 'check') return <DailyCheckScreen key={sel.vehicleId} vehicleId={sel.vehicleId} f={f} ws={ws.data} open={open} done={back} />;
    if (sel.kind === 'booking') return <BookingScreen key={sel.id} id={sel.id} f={f} open={open} done={back} />;
    if (sel.kind === 'newbooking') return <NewBooking key={sel.vehicleId ?? 'any'} vehicleId={sel.vehicleId} f={f} done={back} />;
    if (sel.kind === 'assign') return <AssignScreen key={`${sel.techId}-${sel.vehicleId}`} techId={sel.techId} vehicleId={sel.vehicleId} f={f} done={back} />;
    return <ReportFault key={sel.vehicleId} vehicleId={sel.vehicleId} f={f} done={back} />;
  })();

  const header = (
    <View style={{ backgroundColor: K.band, paddingTop: ins.top, paddingHorizontal: S.pad, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {sel && (!wide || stack.length > 1) ? (
        <Pressable onPress={back} accessibilityRole="button" accessibilityLabel="Back" hitSlop={10}><Text style={{ color: K.bandText, fontSize: 34 }}>‹</Text></Pressable>
      ) : null}
      <BrandLogo height={wide ? 36 : 28} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: K.bandText, fontSize: wide ? 22 : 19, fontWeight: '800' }}>Fleet</Text>
        <Text numberOfLines={1} style={{ color: K.bandText, opacity: 0.8 }}>{s.session?.user.name} · {s.session?.user.level === 'mechanic' ? 'Mechanic' : s.session?.user.level === 'creator' ? 'CEO' : 'Fleet'}</Text>
      </View>
      <SyncPill />
      <ModeToggle color={K.bandText} />
      <Pressable onPress={f.load} accessibilityRole="button" accessibilityLabel="Refresh" hitSlop={8}
        style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: K.bandText }}>
        <Text style={{ color: K.bandText, fontWeight: '700' }}>{f.loading ? '…' : 'Refresh'}</Text>
      </Pressable>
      {wide ? <Pressable onPress={s.signOut} accessibilityRole="button" hitSlop={8}><Text style={{ color: K.bandText }}>Sign out</Text></Pressable> : null}
    </View>
  );

  if (wide) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {header}
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ width: 200, borderRightWidth: 1, borderRightColor: C.line, padding: 12, gap: 6 }}>
            {tabs.map(t => (
              <Pressable key={t.key} onPress={() => { setTab(t.key); setStack([]); }} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }}
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, minHeight: 48, borderRadius: 8, backgroundColor: tab === t.key ? C.panel2 : 'transparent' }}>
                <Text style={{ color: tab === t.key ? C.text : C.quiet, fontWeight: '700', flex: 1 }}>{t.label}</Text>
                {t.count ? <Pill text={String(t.count)} tone="warn" /> : null}
              </Pressable>
            ))}
          </View>
          <View style={{ width: 420, borderRightWidth: 1, borderRightColor: C.line }}>{list}</View>
          <View style={{ flex: 1 }}>{detail ?? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Body quiet>Choose a vehicle, booking or technician.</Body></View>}</View>
        </View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {header}
      <View style={{ flex: 1 }}>{detail ?? list}</View>
      {!sel ? (
        <BottomTabs tabs={tabs} current={tab} onSelect={k => setTab(k)} accent={K.band} bottom={ins.bottom} pinned={menu.pinned} />
      ) : null}
    </View>
  );
}

type FleetHook = ReturnType<typeof useFleet>;

// ---- Lists -----------------------------------------------------------------------------

function VehicleCard({ x, onPress }: { x: FleetVehicle; onPress: () => void }) {
  return (
    <Card onPress={onPress} accessibilityLabel={`Vehicle ${x.registration}`} style={x.status !== 'in_service' ? { borderLeftWidth: 5, borderLeftColor: x.status === 'off_road' ? C.bad : C.warn } : undefined}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Thumb photoId={x.photo_id} label={x.registration} size={44} />
        <Text style={{ color: C.text, fontSize: 20, fontWeight: '800', letterSpacing: 1, flex: 1 }}>{x.registration}</Text>
        <Pill text={STATUS[x.status].text} tone={STATUS[x.status].tone} />
      </View>
      <Text style={st.small}>{[x.make, x.model, x.year].filter(Boolean).join(' ')} · {km(x.km)}{x.driver ? ` · ${x.driver}` : ''}</Text>
      {x.status_note ? <Text style={[st.small, { color: C.warn }]}>{x.status_note}</Text> : null}
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {x.safety_faults ? <Pill text={`${x.safety_faults} safety fault${x.safety_faults > 1 ? 's' : ''}`} tone="bad" /> : null}
        {x.open_faults - x.safety_faults > 0 ? <Pill text={`${x.open_faults - x.safety_faults} fault${x.open_faults - x.safety_faults > 1 ? 's' : ''}`} tone="warn" /> : null}
        {x.open_job ? <Pill text={`Job card ${x.open_job.number}`} tone="info" /> : null}
        {x.status === 'in_service' ? (x.checked_today ? <Pill text={x.checked_today.oil === 'topped_up' ? `Checked · oil +${x.checked_today.oilLitres} L` : 'Checked today'} tone={x.checked_today.oil === 'topped_up' ? 'warn' : 'good'} />
          : <Pill text="Daily check due" tone="warn" />) : null}
        {x.serviceDue.state === 'soon' || x.serviceDue.state === 'overdue' ? <Pill text={x.serviceDue.state === 'overdue' ? 'Service overdue' : 'Service soon'} tone={DUE[x.serviceDue.state]} /> : null}
        {x.licenceDue.state === 'soon' || x.licenceDue.state === 'overdue' ? <Pill text={x.licenceDue.state === 'overdue' ? 'Licence expired' : 'Licence soon'} tone={DUE[x.licenceDue.state]} /> : null}
      </View>
    </Card>
  );
}

function VehicleList({ vehicles, open }: { vehicles: FleetVehicle[]; open: (id: string) => void }) {
  const off = vehicles.filter(v => v.status !== 'in_service').length;
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Card style={{ flex: 1 }}><Label>On the road</Label><Text style={big}>{vehicles.length - off}</Text></Card>
        <Card style={{ flex: 1, borderColor: off ? C.warn : C.line }}><Label>Off / workshop</Label><Text style={big}>{off}</Text></Card>
      </View>
      {vehicles.map(x => <VehicleCard key={x.id} x={x} onPress={() => open(x.id)} />)}
    </>
  );
}
const big = { get color() { return C.text; }, fontSize: 26, fontWeight: '800' as const };

function FaultRow({ x, onPress }: { x: Fault; onPress?: () => void }) {
  return (
    <Card onPress={onPress} accessibilityLabel={`Fault ${x.description}`}>
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {x.registration ? <Text style={[st.body, { fontWeight: '800' }]}>{x.registration}</Text> : null}
        <Pill text={x.severity === 'safety' ? 'Safety' : x.severity === 'urgent' ? 'Urgent' : 'Normal'} tone={SEV[x.severity]} />
        {x.status === 'in_progress' ? <Pill text="On a job card" tone="info" /> : x.status === 'fixed' ? <Pill text="Fixed" tone="good" /> : x.status === 'deferred' ? <Pill text="Deferred" tone="quiet" /> : null}
      </View>
      <Body>{x.description}</Body>
      <Text style={st.small}>{x.source === 'handover' ? 'Found at a handover' : x.source === 'driver' ? 'Reported by the driver' : 'Mechanic'} · {x.reported_by_name ?? ''} · {when(x.reported_at)}</Text>
      {x.closed_note ? <Text style={st.small}>Note: {x.closed_note}</Text> : null}
    </Card>
  );
}

function FaultList({ faults, open }: { faults: Fault[]; open: (vehicleId: string) => void }) {
  if (!faults.length) return <Body quiet>No open faults.</Body>;
  return <>{faults.map(x => <FaultRow key={x.id} x={x} onPress={() => open(x.vehicle_id)} />)}</>;
}

function JobList({ jobs, open }: { jobs: FleetJob[]; open: (id: string) => void }) {
  if (!jobs.length) return <Body quiet>No open job cards.</Body>;
  return <>{jobs.map(j => (
    <Card key={j.id} onPress={() => open(j.id)} accessibilityLabel={`Job card ${j.number}`}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{j.registration} · #{j.number}</Text>
        <Pill text={TYPE_LABEL[j.job_type]} tone="info" />
      </View>
      <Body>{j.reason}</Body>
      <Text style={st.small}>Opened {when(j.opened_at)} · in at {km(j.odometer_in)}{j.faults.length ? ` · ${j.faults.length} fault${j.faults.length > 1 ? 's' : ''}` : ''}</Text>
    </Card>
  ))}</>;
}

// ---- One vehicle ---------------------------------------------------------------------------

function VehicleScreen({ id, f, open }: { id: string; f: FleetHook; open: (s: Sel) => void }) {
  const s = useStore();
  const d = f.d.details[id];
  const sum = f.d.vehicles.find(x => x.id === id);
  const [panel, setPanel] = useState<'none' | 'km' | 'status' | 'edit'>('none');
  useEffect(() => { f.loadVehicle(id); }, [id, f.d.loadedAt]);
  if (!d || !sum) return <ScrollView contentContainerStyle={{ padding: S.pad }}><Body quiet>{sum ? 'Loading…' : 'Not found.'}</Body></ScrollView>;
  const v = d.vehicle;
  const openFaults = d.faults.filter(x => x.status === 'open' || x.status === 'in_progress');
  const booking = f.d.bookings.find(b => b.vehicle_id === id && b.status === 'booked');
  return (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: C.text, fontSize: 28, fontWeight: '800', letterSpacing: 1, flex: 1 }}>{v.registration}</Text>
        <Pill text={STATUS[v.status].text} tone={STATUS[v.status].tone} />
      </View>
      <Body quiet>{[v.make, v.model, v.year].filter(Boolean).join(' ') || 'Make and model not recorded'}{sum.driver ? ` · driven by ${sum.driver}` : ''}</Body>
      <ItemPicture photoId={v.photo_id} kind="vehicle_profile" label={v.registration} canEdit save={async pid => { const r = await s.ask({ method: 'POST', path: `/fleet/vehicles/${id}/photo`, json: { photoId: pid } }); if (r && r.status < 300) { f.load(); f.loadVehicle(id); return null; } return 'Not saved: needs signal.'; }} />
      {v.status_note ? <Notice tone={v.status === 'off_road' ? 'bad' : 'warn'} title={STATUS[v.status].text} lines={[v.status_note]} /> : null}
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Card style={{ flex: 1, minWidth: 140 }}><Label>Odometer</Label><Text style={big}>{km(v.km)}</Text></Card>
        <Card style={{ flex: 1, minWidth: 140 }}><Label>Next service</Label><Text style={[st.body, { color: dueColor(d.serviceDue.state) }]}>{d.serviceDue.text.replace('Service: ', '')}</Text>
          <Text style={st.small}>{v.next_service_km ? km(v.next_service_km) : ''}{v.next_service_at ? ` · ${v.next_service_at}` : ''}</Text></Card>
        <Card style={{ flex: 1, minWidth: 140 }}><Label>Licence disc</Label><Text style={[st.body, { color: dueColor(d.licenceDue.state) }]}>{d.licenceDue.text.replace('Licence disc: ', '')}</Text>
          <Text style={st.small}>{v.licence_expiry ?? ''}</Text></Card>
      </View>

      {booking ? (
        <Card onPress={() => open({ kind: 'booking', id: booking.id })} accessibilityLabel="Booking" style={{ borderColor: C.info }}>
          <Label>Booked in</Label>
          <Text style={[st.body, { fontWeight: '800' }]}>{dayName(booking.booked_for)} · {SLOT_LABEL[booking.time_slot]} · {TYPE_LABEL[booking.job_type]}</Text>
          <Text style={st.small}>{booking.place} · {booking.reason}</Text>
        </Card>
      ) : null}
      {v.status === 'in_service' && !sum.checked_today ? <Button label="Do today's daily check" onPress={() => open({ kind: 'check', vehicleId: id })} /> : null}
      {sum.open_job ? <Button label={`Open job card ${sum.open_job.number}`} onPress={() => open({ kind: 'job', id: sum.open_job!.id })} />
        : <Button label="New job card" onPress={() => open({ kind: 'newjob', vehicleId: id, bookingId: booking?.id })} />}
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Button label="Log km" kind="secondary" onPress={() => setPanel(panel === 'km' ? 'none' : 'km')} style={{ flexBasis: '46%', flexGrow: 1 }} />
        <Button label="Status" kind="secondary" onPress={() => setPanel(panel === 'status' ? 'none' : 'status')} style={{ flexBasis: '46%', flexGrow: 1 }} />
        <Button label="Details" kind="secondary" onPress={() => setPanel(panel === 'edit' ? 'none' : 'edit')} style={{ flexBasis: '46%', flexGrow: 1 }} />
        <Button label="Add fault" kind="secondary" onPress={() => open({ kind: 'report', vehicleId: id })} style={{ flexBasis: '46%', flexGrow: 1 }} />
        {!booking ? <Button label="Book in" kind="secondary" onPress={() => open({ kind: 'newbooking', vehicleId: id })} style={{ flexBasis: '46%', flexGrow: 1 }} /> : null}
        <Button label="Put a tech in" kind="secondary" onPress={() => open({ kind: 'assign', vehicleId: id })} style={{ flexBasis: '46%', flexGrow: 1 }} />
      </View>
      {panel === 'km' ? <LogKm id={id} last={v.km} f={f} done={() => setPanel('none')} /> : null}
      {panel === 'status' ? <SetStatus id={id} current={v.status} f={f} done={() => setPanel('none')} /> : null}
      {panel === 'edit' ? <EditDetails v={v} f={f} done={() => setPanel('none')} /> : null}

      <Heading>Faults ({openFaults.length} open)</Heading>
      {d.faults.length ? d.faults.slice(0, 20).map(x => <FaultWithDefer key={x.id} x={x} f={f} />) : <Body quiet>No faults recorded.</Body>}

      <Heading>Job cards</Heading>
      {d.jobs.length ? d.jobs.map(j => (
        <Card key={j.id} onPress={j.status === 'open' ? () => open({ kind: 'job', id: j.id }) : undefined}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>#{j.number} · {TYPE_LABEL[j.job_type]}</Text>
            <Pill text={j.status === 'open' ? 'Open' : 'Completed'} tone={j.status === 'open' ? 'info' : 'good'} />
          </View>
          <Body>{j.reason}</Body>
          {j.did_text ? <Text style={st.small}>Done: {j.did_text}</Text> : null}
          <Text style={st.small}>{when(j.opened_at)} · {km(j.odometer_in)}{j.odometer_out ? ` → ${km(j.odometer_out)}` : ''} · {j.mechanic}{j.labour_hours ? ` · ${j.labour_hours} h` : ''}{j.parts_cents ? ` · parts ${rand(j.parts_cents)}` : ''}</Text>
        </Card>
      )) : <Body quiet>No job cards yet.</Body>}

      <Heading>Daily checks</Heading>
      {d.dailyChecks?.length ? <DailyCheckHistory rows={d.dailyChecks.slice(0, 10)} /> : <Body quiet>No daily checks yet.</Body>}

      <Heading>Km history</Heading>
      <Card>
        {d.km.slice(0, 15).map((k, n) => (
          <View key={n} style={{ flexDirection: 'row', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '700', minWidth: 110 }]}>{km(k.km)}</Text>
            <Text style={[st.small, { flex: 1 }]}>{when(k.read_at)} · {k.source === 'handover' ? 'handover' : k.source === 'fleet_job' ? 'job card' : k.source === 'release' ? 'released' : k.source === 'daily_check' ? 'daily check' : 'mechanic'} · {k.by}</Text>
          </View>
        ))}
        {!d.km.length ? <Body quiet>No readings yet.</Body> : null}
      </Card>
    </ScrollView>
  );
}
const dueColor = (s: F.Due['state']) => (s === 'overdue' ? C.bad : s === 'soon' ? C.warn : s === 'ok' ? C.good : C.quiet);

function FaultWithDefer({ x, f }: { x: Fault; f: FleetHook }) {
  const [deferring, setDeferring] = useState(false);
  const [note, setNote] = useState('');
  return (
    <View style={{ gap: 6 }}>
      <FaultRow x={x} />
      {x.status === 'open' && x.severity !== 'safety' ? (
        deferring ? (
          <Card>
            <Field label="Why defer it?" value={note} onChangeText={setNote} />
            <Button label="Defer fault" kind="secondary" disabled={note.trim().length < 5}
              onPress={() => f.act('Deferred a fault', 'POST', `/fleet/faults/${x.id}/defer`, { note: note.trim(), at: nowIso() }, () => setDeferring(false))} />
          </Card>
        ) : <Button label="Defer" kind="quiet" onPress={() => setDeferring(true)} style={{ minHeight: 40 }} />
      ) : null}
    </View>
  );
}

function LogKm({ id, last, f, done }: { id: string; last: number | null; f: FleetHook; done: () => void }) {
  const [val, setVal] = useState('');
  const n = Number(val.replace(/\s/g, ''));
  const low = last != null && n < last;
  return (
    <Card>
      <Field label="Odometer reading (km)" value={val} onChangeText={setVal} keyboardType="number-pad" placeholder={last != null ? `at least ${last}` : ''}
        hint={low ? `Cannot be lower than the last reading (${km(last)})` : undefined} />
      <Button label="Save reading" disabled={!val || !(n >= 0) || low} onPress={() => f.act(`Km reading ${n}`, 'POST', `/fleet/vehicles/${id}/odometer`, { km: n, at: nowIso() }, done)} />
    </Card>
  );
}

function SetStatus({ id, current, f, done }: { id: string; current: F.VehicleStatus; f: FleetHook; done: () => void }) {
  const [status, setStatusV] = useState<F.VehicleStatus>(current);
  const [note, setNote] = useState('');
  return (
    <Card>
      <Choice options={['in_service', 'workshop', 'off_road'] as const} value={status} onChange={setStatusV} labels={{ in_service: 'In service', workshop: 'Workshop', off_road: 'Off the road' }} />
      {status !== 'in_service' ? <Field label="Why?" value={note} onChangeText={setNote} hint="The driver and his manager are told. A vehicle off the road or in the workshop cannot be scanned for driving." /> : null}
      <Button label="Save status" disabled={status !== 'in_service' && note.trim().length < 5}
        onPress={() => f.act('Vehicle status changed', 'POST', `/fleet/vehicles/${id}/status`, { status, note: note.trim() || undefined, at: nowIso() }, done)} />
    </Card>
  );
}

function EditDetails({ v, f, done }: { v: NonNullable<FleetHook['d']['details'][string]>['vehicle']; f: FleetHook; done: () => void }) {
  const [make, setMake] = useState(v.make ?? '');
  const [model, setModel] = useState(v.model ?? '');
  const [year, setYear] = useState(v.year ? String(v.year) : '');
  const [vin, setVin] = useState(v.vin ?? '');
  const [lic, setLic] = useState(v.licence_expiry ?? '');
  const [ikm, setIkm] = useState(String(v.service_interval_km ?? 15000));
  const okDate = !lic || /^\d{4}-\d{2}-\d{2}$/.test(lic);
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Field label="Make" value={make} onChangeText={setMake} /></View>
        <View style={{ flex: 1 }}><Field label="Model" value={model} onChangeText={setModel} /></View>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Field label="Year" value={year} onChangeText={setYear} keyboardType="number-pad" /></View>
        <View style={{ flex: 2 }}><Field label="VIN" value={vin} onChangeText={setVin} autoCapitalize="characters" /></View>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Field label="Licence expiry" value={lic} onChangeText={setLic} placeholder="YYYY-MM-DD" hint={okDate ? undefined : 'Use YYYY-MM-DD'} /></View>
        <View style={{ flex: 1 }}><Field label="Service every (km)" value={ikm} onChangeText={setIkm} keyboardType="number-pad" /></View>
      </View>
      <Button label="Save details" disabled={!okDate} onPress={() => f.act('Vehicle details', 'PATCH', `/fleet/vehicles/${v.id}`, {
        make: make.trim() || null, model: model.trim() || null, year: year ? Number(year) : null, vin: vin.trim() || null,
        licenceExpiry: lic || null, serviceIntervalKm: Number(ikm) || undefined,
      }, done)} />
    </Card>
  );
}

// ---- Faults reported by the mechanic --------------------------------------------------------

function ReportFault({ vehicleId, f, done }: { vehicleId: string; f: FleetHook; done: () => void }) {
  const [desc, setDesc] = useState('');
  const [sev, setSev] = useState<F.FaultSeverity>('normal');
  const [photo, setPhoto] = useState<Shot | null>(null);
  const reg = f.d.vehicles.find(x => x.id === vehicleId)?.registration;
  return (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap }}>
      <Heading>New fault on {reg}</Heading>
      <Field label="What is wrong?" value={desc} onChangeText={setDesc} multiline />
      <Choice options={['safety', 'urgent', 'normal'] as const} value={sev} onChange={setSev} labels={{ safety: 'Safety', urgent: 'Urgent', normal: 'Normal' }} />
      {photo ? <Image source={{ uri: photo.uri }} style={{ width: 120, height: 120, borderRadius: 8 }} /> : null}
      <Button label={photo ? 'Retake photo' : 'Photo (optional)'} kind="quiet" onPress={async () => setPhoto(await f.shoot())} />
      <Button label="Save fault" disabled={desc.trim().length < 10} onPress={() => {
        if (photo) f.upload('Fault photo', 'fleet_fault', photo);
        f.act(`Fault on ${reg}`, 'POST', `/fleet/vehicles/${vehicleId}/faults`, { description: desc.trim(), severity: sev, photoIds: photo ? [photo.id] : [], at: nowIso() }, done);
      }} />
    </ScrollView>
  );
}

// ---- Mechanic job cards ------------------------------------------------------------------------

function NewJob({ vehicleId, bookingId, f, done }: { vehicleId: string; bookingId?: string; f: FleetHook; done: () => void }) {
  const s = useStore();
  const v = f.d.vehicles.find(x => x.id === vehicleId);
  const booking = bookingId ? f.d.bookings.find(b => b.id === bookingId) : undefined;
  const faults = (f.d.details[vehicleId]?.faults ?? []).filter(x => x.status === 'open' || x.status === 'deferred');
  const [type, setType] = useState<F.FleetJobType>(booking?.job_type ?? 'service');
  const [reason, setReason] = useState(booking?.reason ?? '');
  const [odo, setOdo] = useState(v?.km != null ? String(v.km) : '');
  const [chosen, setChosen] = useState<Record<string, boolean>>(() => Object.fromEntries(faults.filter(x => x.severity !== 'normal').map(x => [x.id, true])));
  const [during, setDuring] = useState<F.VehicleStatus>('workshop');
  const n = Number(odo.replace(/\s/g, ''));
  const low = v?.km != null && n < v.km;
  return (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60 }}>
      <Heading>New job card · {v?.registration}</Heading>
      {booking ? <Notice tone="info" title={`From the booking for ${dayName(booking.booked_for)}`} lines={['The booking is marked as started when you open this job card.']} /> : null}
      <Label>Type of work</Label>
      <Choice options={F.JOB_TYPES} value={type} onChange={setType} labels={TYPE_LABEL} />
      <Field label="Why is it in?" value={reason} onChangeText={setReason} placeholder="e.g. 90 000 km service, windscreen crack" />
      <Field label="Odometer now (km)" value={odo} onChangeText={setOdo} keyboardType="number-pad" hint={low ? `Cannot be lower than ${km(v?.km)}` : undefined} />
      {faults.length ? (
        <>
          <Label>Faults this job card deals with</Label>
          {faults.map(x => (
            <Pressable key={x.id} onPress={() => setChosen(c => ({ ...c, [x.id]: !c[x.id] }))} accessibilityRole="checkbox" accessibilityState={{ checked: !!chosen[x.id] }}
              style={{ flexDirection: 'row', gap: 10, alignItems: 'center', minHeight: 48 }}>
              <View style={{ width: 28, height: 28, borderRadius: 6, borderWidth: 2, borderColor: chosen[x.id] ? C.good : C.line, backgroundColor: chosen[x.id] ? C.good : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: C.bg, fontWeight: '900' }}>{chosen[x.id] ? '✓' : ''}</Text>
              </View>
              <Text style={[st.body, { flex: 1 }]}>{x.description}</Text>
              <Pill text={x.severity} tone={SEV[x.severity]} />
            </Pressable>
          ))}
        </>
      ) : null}
      <Label>While it is being worked on</Label>
      <Choice options={['workshop', 'off_road', 'in_service'] as const} value={during} onChange={setDuring} labels={{ workshop: 'In workshop', off_road: 'Off the road', in_service: 'Can still be driven' }} />
      <Button label="Open job card" disabled={reason.trim().length < 5 || !odo || low} onPress={() => {
        const id = s.newId();
        f.act(`Job card on ${v?.registration}`, 'POST', `/fleet/vehicles/${vehicleId}/jobs`, {
          id, jobType: type, reason: reason.trim(), odometerIn: n, faultIds: Object.keys(chosen).filter(k => chosen[k]), vehicleStatus: during, at: nowIso(),
          ...(booking ? { bookingId: booking.id } : {}),
        }, done);
      }} />
    </ScrollView>
  );
}

function JobScreen({ j, f, ws, done }: { j: FleetJob; f: FleetHook; ws: ReturnType<typeof useWorkshop>; done: () => void }) {
  const v = f.d.vehicles.find(x => x.id === j.vehicle_id);
  const det = f.d.details[j.vehicle_id]?.vehicle;
  const [found, setFound] = useState(j.found_text ?? '');
  const [did, setDid] = useState(j.did_text ?? '');
  const [hours, setHours] = useState(j.labour_hours != null ? String(j.labour_hours) : '');
  const [after, setAfter] = useState<Shot[]>([]);
  const [before, setBefore] = useState<Shot[]>([]);
  const [part, setPart] = useState<{ desc: string; qty: string; cost: string; source: 'workshop' | 'stockroom' | 'bought' | 'other'; slip: Shot | null; itemId?: string } | null>(null);
  const wsLine = part?.itemId ? ws.data?.lines.find(l => l.id === part.itemId) : undefined;
  const [odoOut, setOdoOut] = useState(String(Math.max(j.odometer_in, v?.km ?? 0)));
  const ns = F.nextService(Number(odoOut) || j.odometer_in, det?.service_interval_km ?? 15000, det?.service_interval_months ?? 12, today());
  const [nextKm, setNextKm] = useState(j.job_type === 'service' ? String(ns.km) : '');
  const [nextAt, setNextAt] = useState(j.job_type === 'service' ? ns.at : '');
  const [outcome, setOutcome] = useState<Record<string, { outcome?: 'fixed' | 'deferred'; note?: string }>>({});
  const [after_, setAfterStatus] = useState<F.VehicleStatus>('in_service');
  const [reasons, setReasons] = useState<string[] | null>(null);

  const saveText = () => {
    const patch: Record<string, unknown> = {};
    if (found !== (j.found_text ?? '')) patch.found = found;
    if (did !== (j.did_text ?? '')) patch.did = did;
    const h = Number(hours.replace(',', '.'));
    if (hours && h !== j.labour_hours) patch.labourHours = h;
    if (Object.keys(patch).length) f.act(`Job card ${j.number}`, 'PATCH', `/fleet/jobs/${j.id}`, patch);
  };
  const photo = async (kind: 'before' | 'after') => {
    const p = await f.shoot();
    if (!p) return;
    f.upload(`Job card ${j.number} ${kind} photo`, kind === 'after' ? 'fleet_after' : 'fleet_before', p);
    f.act(`Job card ${j.number} photo`, 'PATCH', `/fleet/jobs/${j.id}`, kind === 'after' ? { addAfterPhotoIds: [p.id] } : { addBeforePhotoIds: [p.id] });
    (kind === 'after' ? setAfter : setBefore)(x => [...x, p]);
  };

  const complete = () => {
    saveText();
    const body = {
      odometerOut: Number(odoOut), faults: j.faults.map(x => ({ id: x.id, outcome: outcome[x.id]?.outcome!, note: outcome[x.id]?.note })),
      nextServiceKm: nextKm ? Number(nextKm) : null, nextServiceAt: nextAt || null, vehicleStatusAfter: after_,
    };
    const missing = F.missingToComplete({
      jobType: j.job_type, odometerIn: j.odometer_in, found, did, labourHours: hours ? Number(hours.replace(',', '.')) : null,
      afterPhotos: j.after_photo_ids.length + after.length, odometerOut: body.odometerOut,
      faults: j.faults.map(x => ({ id: x.id, severity: x.severity, ...outcome[x.id] })), nextServiceKm: body.nextServiceKm, nextServiceAt: body.nextServiceAt, vehicleStatusAfter: after_,
    });
    if (missing.length) { setReasons(missing); return; }
    f.act(`Completed job card ${j.number}`, 'POST', `/fleet/jobs/${j.id}/complete`, { ...body, faults: body.faults.filter(x => x.outcome), at: nowIso() }, done);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: C.text, fontSize: 24, fontWeight: '800', flex: 1 }}>{j.registration} · #{j.number}</Text>
        <Pill text={TYPE_LABEL[j.job_type]} tone="info" />
      </View>
      <Body>{j.reason}</Body>
      <Text style={st.small}>Opened {when(j.opened_at)} by {j.mechanic} · in at {km(j.odometer_in)}</Text>
      {j.faults.length ? <><Label>Faults on this card</Label>{j.faults.map(x => <Text key={x.id} style={st.body}>• {x.description} <Text style={[st.small, { color: x.severity === 'safety' ? C.bad : C.quiet }]}>({x.severity})</Text></Text>)}</> : null}

      <Heading>Work</Heading>
      <Field label="What did you find?" value={found} onChangeText={setFound} onBlur={saveText} multiline />
      <Field label="What did you do?" value={did} onChangeText={setDid} onBlur={saveText} multiline />
      <Field label="Labour hours" value={hours} onChangeText={setHours} onBlur={saveText} keyboardType="decimal-pad" />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label={`Before (${j.before_photo_ids.length + before.length})`} kind="secondary" onPress={() => photo('before')} style={{ flex: 1 }} />
        <Button label={`After (${j.after_photo_ids.length + after.length})`} kind="secondary" onPress={() => photo('after')} style={{ flex: 1 }} />
      </View>
      {[...before, ...after].length ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{[...before, ...after].map(p => <Image key={p.id} source={{ uri: p.uri }} style={{ width: 80, height: 80, borderRadius: 8 }} />)}</View> : null}

      <Heading>Parts</Heading>
      {j.parts.map(p => <Text key={p.id} style={st.body}>{p.qty} × {p.description} <Text style={st.small}>{p.unitCostCents != null ? rand(p.unitCostCents) : ''} · {p.source}</Text></Text>)}
      {!j.parts.length ? <Body quiet>No parts yet.</Body> : null}
      {part ? (
        <Card>
          <Choice options={['workshop', 'stockroom', 'bought', 'other'] as const} value={part.source} onChange={x => setPart({ ...part, source: x })} labels={{ workshop: 'My workshop stock', stockroom: 'From stockroom', bought: 'Bought', other: 'Other' }} />
          {part.source === 'workshop' ? (
            <>
              <Label>Which item</Label>
              <Choice options={(ws.data?.lines ?? []).filter(l => l.qty > 0).map(l => l.id)} value={part.itemId}
                onChange={id => { const l = ws.data!.lines.find(x => x.id === id)!; setPart({ ...part, itemId: id, desc: l.description }); }}
                labels={Object.fromEntries((ws.data?.lines ?? []).map(l => [l.id, `${l.description} (${l.qty} ${l.unit})`]))} />
            </>
          ) : null}
          <Field label="Part" value={part.desc} onChangeText={t => setPart({ ...part, desc: t })} />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label="Qty" value={part.qty} onChangeText={t => setPart({ ...part, qty: t })} keyboardType="decimal-pad" /></View>
            <View style={{ flex: 1 }}><Field label="Cost each (R)" value={part.cost} onChangeText={t => setPart({ ...part, cost: t })} keyboardType="decimal-pad" /></View>
          </View>
          {wsLine && !wsLine.measured && Number(part.qty) > wsLine.qty ? <Notice tone="bad" title={`Only ${wsLine.qty} ${wsLine.unit} in the workshop`} lines={['Ask the stock controller to issue more.']} /> : null}
          {part.source === 'bought' ? <Button label={part.slip ? 'Slip photo ✓ (retake)' : 'Photo of the slip'} kind="quiet" onPress={async () => { const p = await f.shoot(); if (p) setPart({ ...part, slip: p }); }} /> : null}
          <Button label="Add part" disabled={part.desc.trim().length < 2 || !(Number(part.qty) > 0) || (part.source === 'bought' && !part.slip) || (part.source === 'workshop' && (!wsLine || (!wsLine.measured && Number(part.qty) > wsLine.qty)))} onPress={() => {
            if (part.slip) f.upload('Parts slip', 'fleet_slip', part.slip);
            f.act(`Part on job card ${j.number}`, 'POST', `/fleet/jobs/${j.id}/parts`, {
              description: part.desc.trim(), qty: Number(part.qty), unitCostCents: part.cost ? Math.round(Number(part.cost.replace(',', '.')) * 100) : null, source: part.source, slipPhotoId: part.slip?.id, stockItemId: part.source === 'workshop' ? part.itemId : undefined,
            }, () => { setPart(null); setTimeout(ws.load, 800); });
          }} />
        </Card>
      ) : <Button label="+ Add part" kind="secondary" onPress={() => setPart({ desc: '', qty: '1', cost: '', source: 'workshop', slip: null })} />}

      <Heading>Complete</Heading>
      {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}
      <Field label="Odometer when done (km)" value={odoOut} onChangeText={setOdoOut} keyboardType="number-pad" />
      {j.faults.map(x => (
        <Card key={x.id}>
          <Text style={[st.body, { fontWeight: '700' }]}>{x.description}</Text>
          <Choice options={['fixed', 'deferred'] as const} value={outcome[x.id]?.outcome} onChange={o => setOutcome(m => ({ ...m, [x.id]: { ...m[x.id], outcome: o } }))} labels={{ fixed: 'Fixed', deferred: 'Deferred' }} />
          {outcome[x.id]?.outcome === 'deferred' ? <Field label="Why deferred?" value={outcome[x.id]?.note ?? ''} onChangeText={t => setOutcome(m => ({ ...m, [x.id]: { ...m[x.id], note: t } }))} /> : null}
        </Card>
      ))}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Field label="Next service (km)" value={nextKm} onChangeText={setNextKm} keyboardType="number-pad" /></View>
        <View style={{ flex: 1 }}><Field label="Next service (date)" value={nextAt} onChangeText={setNextAt} placeholder="YYYY-MM-DD" /></View>
      </View>
      <Label>After this job card</Label>
      <Choice options={['in_service', 'off_road', 'workshop'] as const} value={after_} onChange={setAfterStatus} labels={{ in_service: 'Back on the road', off_road: 'Off the road', workshop: 'Stays in workshop' }} />
      <Button label="Complete job card" onPress={complete} />
    </ScrollView>
  );
}
