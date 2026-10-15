// The office's Vehicles page (the CEO's tab, which used to be Handovers): everything about the vehicles in
// one place. Tiles on top (each opens its part), then: the vehicles, handovers to approve, faults, service
// and licence discs due, who drives what, fuel, trips not allowed and the map. A vehicle opens the same
// screens the mechanic has: its job cards, bookings, daily checks, km, faults, who drove it, fuel and trips.
import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, Select, rand, st } from '../ui.tsx';
import { C, S } from '../theme.ts';
import type { TripOut } from '../../../server/src/core/timesheet.ts';
import { FaultRow, FleetDetail, VehicleCard, type Sel as FleetSel } from '../fleet/FleetApp.tsx';
import { BookingsList, DailyChecksCard, FleetMap, TechList } from '../fleet/FleetExtra.tsx';
import { useFleet } from '../fleet/useFleet.ts';
import { useWorkshop } from '../fleet/Workshop.tsx';
import { km, when } from '../fleet/common.ts';
import type { OfficeHook } from './useOffice.ts';

export type VehSection = 'vehicles' | 'handovers' | 'faults' | 'due' | 'drivers' | 'fuel' | 'trips' | 'map';
interface MonthVehicle { id: string; registration: string; kmMonth: number; fuelLitres: number; fuelCents: number; tripsNotAllowed: number }
type Trip = TripOut & { vehicleId: string; driverId: string | null; driver: string | null };
interface Fuel { id: string; vehicleId: string; registration: string; who: string; logged_at: string; litres: number; amount_cents: number; odometer_km: number | null }
interface Page {
  month: string; months: string[];
  can: { fleet: boolean; manageFleet: boolean; handovers: boolean; trips: boolean; fuel: boolean };
  summary: {
    vehicles: number; onRoad: number; off: number; driving: number; checkedToday: number; checksDue: number; safetyFaults: number; openFaults: number;
    serviceDue: number; licenceDue: number; handovers: number | null; tripsNotAllowed: number | null; tripsNotAllowedKm: number | null;
    fuelLitres: number | null; fuelCents: number | null; kmMonth: number | null;
  };
  vehicles: MonthVehicle[]; trips: Trip[] | null; fuel: Fuel[] | null;
}
type Pick = { kind: 'fleet'; stack: FleetSel[] } | { kind: 'handover'; id: string } | null;

const monthName = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const litres = (n: number) => `${n.toLocaleString('en-ZA', { maximumFractionDigits: 1 })} L`;

export function VehiclesPage({ o, start }: { o: OfficeHook; start?: { section?: VehSection; vehicleId?: string } }) {
  const s = useStore();
  const wide = useWindowDimensions().width >= 900;
  const [month, setMonth] = useState<string | null>(null);
  const [d, setD] = useState<Page | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const [section, setSection] = useState<VehSection>(start?.section ?? 'vehicles');
  const [pick, setPick] = useState<Pick>(start?.vehicleId ? { kind: 'fleet', stack: [{ kind: 'vehicle', id: start.vehicleId }] } : null);
  const f = useFleet(!!d?.can.fleet);
  const ws = useWorkshop();

  const load = async (m = month) => {
    const r = await s.ask({ method: 'GET', path: `/office/vehicles${m ? `?month=${m}` : ''}` });
    if (r?.status === 200) { setD(r.body as Page); setErr(null); } else setErr((r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.']);
  };
  useEffect(() => { load(); }, [month]);
  // The handover list and the tiles follow what the fleet screens change.
  useEffect(() => { if (f.d.loadedAt) load(); }, [f.d.loadedAt]);

  if (!d) return <View style={{ padding: S.pad }}>{err ? <Notice tone="bad" title="Could not load the vehicles" lines={err} /> : <Body quiet>Loading…</Body>}</View>;

  const sections: { key: VehSection; label: string }[] = [
    ...(d.can.fleet ? [{ key: 'vehicles' as const, label: 'Vehicles' }] : []),
    ...(d.can.handovers ? [{ key: 'handovers' as const, label: `Handovers${o.d.handovers.length ? ` (${o.d.handovers.length})` : ''}` }] : []),
    ...(d.can.fleet ? [{ key: 'faults' as const, label: 'Faults' }, { key: 'due' as const, label: 'Service & licence' }, { key: 'drivers' as const, label: 'Who drives what' }] : []),
    ...(d.can.fuel ? [{ key: 'fuel' as const, label: 'Fuel' }] : []),
    ...(d.can.trips ? [{ key: 'trips' as const, label: 'Trips' }] : []),
    ...(d.can.fleet ? [{ key: 'map' as const, label: 'Map' }] : []),
  ];
  const cur = sections.some(x => x.key === section) ? section : sections[0]?.key;
  const go = (k: VehSection) => { setSection(k); setPick(null); };
  const openFleet = (x: FleetSel) => setPick(p => (p?.kind === 'fleet' && !(wide && x.kind === 'vehicle') ? { kind: 'fleet', stack: [...p.stack, x] } : { kind: 'fleet', stack: [x] }));
  const back = () => setPick(p => (p?.kind === 'fleet' && p.stack.length > 1 ? { kind: 'fleet', stack: p.stack.slice(0, -1) } : null));
  const sm = d.summary;
  const byId = new Map(d.vehicles.map(v => [v.id, v]));
  const booked = new Set(f.d.bookings.filter(b => b.status === 'booked').map(b => b.vehicle_id));
  const due = f.d.vehicles.filter(x => ['soon', 'overdue'].includes(x.serviceDue.state) || ['soon', 'overdue'].includes(x.licenceDue.state));

  const tiles = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {d.can.fleet ? <Tile label="On the road" value={`${sm.onRoad} of ${sm.vehicles}`} sub={sm.off ? `${sm.off} off the road / workshop` : 'all in service'} tone={sm.off ? 'warn' : 'good'} onPress={() => go('vehicles')} /> : null}
      {d.can.fleet ? <Tile label="Being driven" value={sm.driving} sub="who drives what" onPress={() => go('drivers')} /> : null}
      {sm.handovers != null ? <Tile label="Handovers to approve" value={sm.handovers} tone={sm.handovers ? 'warn' : 'good'} onPress={() => go('handovers')} /> : null}
      {d.can.fleet ? <Tile label="Safety faults" value={sm.safetyFaults} sub={`${sm.openFaults} faults open`} tone={sm.safetyFaults ? 'bad' : sm.openFaults ? 'warn' : 'good'} onPress={() => go('faults')} /> : null}
      {d.can.fleet ? <Tile label="Service / licence due" value={sm.serviceDue + sm.licenceDue} sub={`${sm.serviceDue} service · ${sm.licenceDue} licence disc`} tone={sm.serviceDue + sm.licenceDue ? 'warn' : 'good'} onPress={() => go('due')} /> : null}
      {d.can.fleet ? <Tile label="Daily checks today" value={`${sm.checkedToday} of ${sm.checksDue}`} tone={sm.checkedToday >= sm.checksDue ? 'good' : 'warn'} onPress={() => go('vehicles')} /> : null}
      {sm.tripsNotAllowed != null ? <Tile label="Trips not allowed" value={sm.tripsNotAllowed} sub={sm.tripsNotAllowed ? `${sm.tripsNotAllowedKm} km this month` : 'this month'} tone={sm.tripsNotAllowed ? 'bad' : 'good'} onPress={() => go('trips')} /> : null}
      {sm.fuelLitres != null ? <Tile label="Fuel this month" value={litres(sm.fuelLitres)} sub={rand(sm.fuelCents ?? 0)} onPress={() => go('fuel')} /> : null}
      {sm.kmMonth != null ? <Tile label="Km this month" value={sm.kmMonth.toLocaleString('en-ZA')} sub="from the odometer readings" onPress={() => go('vehicles')} /> : null}
    </View>
  );

  const list = (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 40 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontSize: 26, fontWeight: '800', flex: 1, minWidth: 140 }}>Vehicles</Text>
        <View style={{ minWidth: 180 }}>
          <Select label="Month" value={d.month} options={d.months.map(m => ({ value: m, label: monthName(m) }))} onChange={m => setMonth(m)} />
        </View>
      </View>
      {tiles}
      <Choice options={sections.map(x => x.key)} value={cur} onChange={go} labels={Object.fromEntries(sections.map(x => [x.key, x.label]))} />
      {cur === 'vehicles' ? <>
        <DailyChecksCard f={f} open={openFleet} />
        {f.d.vehicles.map(x => {
          const m = byId.get(x.id);
          return <VehicleCard key={x.id} x={x} onPress={() => openFleet({ kind: 'vehicle', id: x.id })}
            more={m ? <Text style={[st.small, { color: m.tripsNotAllowed ? C.bad : C.quiet }]}>{monthName(d.month)}: {m.kmMonth.toLocaleString('en-ZA')} km{d.can.fuel ? ` · ${litres(m.fuelLitres)} (${rand(m.fuelCents)})` : ''}{m.tripsNotAllowed ? ` · ${m.tripsNotAllowed} trip${m.tripsNotAllowed > 1 ? 's' : ''} not allowed` : ''}</Text> : null} />;
        })}
        {!f.d.vehicles.length ? <Body quiet>{f.loading ? 'Loading…' : 'No vehicles yet.'}</Body> : null}
      </> : null}
      {cur === 'handovers' ? <HandoverList o={o} open={id => setPick({ kind: 'handover', id })} /> : null}
      {cur === 'faults' ? (f.d.faults.length ? f.d.faults.map(x => <FaultRow key={x.id} x={x} onPress={() => openFleet({ kind: 'vehicle', id: x.vehicle_id })} />) : <Body quiet>No open faults.</Body>) : null}
      {cur === 'due' ? <BookingsList f={f} due={due.filter(x => !booked.has(x.id))} open={openFleet} /> : null}
      {cur === 'drivers' ? <TechList f={f} open={openFleet} /> : null}
      {cur === 'fuel' ? <FuelList d={d} openVehicle={id => openFleet({ kind: 'vehicle', id })} /> : null}
      {cur === 'trips' ? <TripList d={d} changed={() => load()} openVehicle={d.can.fleet ? id => openFleet({ kind: 'vehicle', id }) : undefined} /> : null}
      {cur === 'map' ? <FleetMap f={f} open={openFleet} /> : null}
    </ScrollView>
  );

  const backBar = <Button label="‹ Back" kind="quiet" onPress={back} style={{ alignSelf: 'flex-start', minHeight: 40 }} />;
  const detail = !pick ? null
    : pick.kind === 'handover' ? <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60, maxWidth: 820 }}>{!wide ? backBar : null}<HandoverDetail key={pick.id} id={pick.id} o={o} done={() => { setPick(null); o.load(); load(); }} /></ScrollView>
    : <FleetDetail sel={pick.stack.at(-1)!} f={f} ws={ws} open={openFleet} back={back} extra={!wide || pick.stack.length > 1 ? backBar : undefined} />;

  if (!wide) return <View style={{ flex: 1 }}>{detail ?? list}</View>;
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <View style={{ width: 520, borderRightWidth: 1, borderRightColor: C.line }}>{list}</View>
      <View style={{ flex: 1 }}>{detail ?? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Body quiet>Choose a vehicle, handover or booking.</Body></View>}</View>
    </View>
  );
}

function Tile({ label, value, sub, tone = 'quiet', onPress }: { label: string; value: string | number; sub?: string; tone?: 'quiet' | 'warn' | 'bad' | 'good'; onPress?: () => void }) {
  const border = tone === 'bad' ? C.bad : tone === 'warn' ? C.warn : tone === 'good' ? C.good : C.line;
  return (
    <Card onPress={onPress} accessibilityLabel={`${label} ${value}`} style={{ flexGrow: 1, flexBasis: 140, borderColor: border, borderWidth: tone === 'quiet' ? 1 : 2, paddingVertical: 10 }}>
      <Label>{label}</Label>
      <Text style={{ color: C.text, fontSize: 22, fontWeight: '800' }}>{value}</Text>
      {sub ? <Text style={st.small}>{sub}</Text> : null}
    </Card>
  );
}

// ---- Handovers to approve ---------------------------------------------------------------------------

function HandoverList({ o, open }: { o: OfficeHook; open: (id: string) => void }) {
  return (
    <>
      <Notice tone="info" title="Taken with nobody to sign" lines={['A driver took a vehicle when neither the previous driver nor a supervisor was there. Check the inspection and approve it, or reject it.']} />
      {o.d.handovers.map(h => (
        <Card key={h.id} onPress={() => open(h.id)} accessibilityLabel={`Handover ${h.registration}`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{h.registration}</Text>
            <Pill text="To approve" tone="warn" />
          </View>
          <Text style={st.small}>{h.driver} · {when(h.inspected_at)}{h.previous_driver ? ` · from ${h.previous_driver}` : ''}</Text>
        </Card>
      ))}
      {!o.d.handovers.length ? <Body quiet>Nothing waiting.</Body> : null}
    </>
  );
}

function HandoverDetail({ id, o, done }: { id: string; o: OfficeHook; done: () => void }) {
  const h = o.d.handovers.find(x => x.id === id);
  const [note, setNote] = useState('');
  const [ans, setAns] = useState<string[] | null>(null);
  if (!h) return <Body quiet>Decided.</Body>;
  const decide = async (approve: boolean) => {
    const r = await o.send('POST', `/vehicles/inspections/${h.id}/decide`, { approve, ...(note.trim() ? { note: note.trim() } : {}) });
    if (r.ok) done(); else setAns(r.reasons);
  };
  return (
    <>
      <Text style={{ color: C.text, fontSize: 26, fontWeight: '800', letterSpacing: 1 }}>{h.registration}</Text>
      <Card>
        <Text style={st.body}>{h.driver} took it over{h.previous_driver ? ` from ${h.previous_driver}` : ''}, {when(h.inspected_at)}</Text>
        <Text style={st.small}>{h.odometer_km.toLocaleString('en-ZA')} km · fuel {h.fuel_level.replace('_', ' ')}</Text>
      </Card>
      <Card><Label>Why nobody signed</Label><Body>{h.remote_reason ?? '–'}</Body></Card>
      <Card style={{ borderColor: h.new_problems.length ? C.bad : C.line }}>
        <Label>Problems found</Label>
        <Body>{h.problems.length ? h.problems.map(p => p.replace(/_/g, ' ')).join(', ') : 'None'}</Body>
        {h.new_problems.length ? <Text style={[st.small, { color: C.bad }]}>New since the last handover: {h.new_problems.join(', ')}</Text> : null}
      </Card>
      <Field label="Note (needed to reject)" value={note} onChangeText={setNote} />
      {ans ? <Notice tone="bad" title="Not done" lines={ans} /> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Approve" onPress={() => decide(true)} style={{ flex: 1 }} />
        <Button label="Reject" kind="danger" onPress={() => decide(false)} style={{ flex: 1 }} />
      </View>
    </>
  );
}

// ---- Fuel ------------------------------------------------------------------------------------------

function FuelList({ d, openVehicle }: { d: Page; openVehicle: (id: string) => void }) {
  const fuel = d.fuel ?? [];
  const per = [...new Set(fuel.map(x => x.vehicleId))].map(id => {
    const rows = fuel.filter(x => x.vehicleId === id);
    const v = d.vehicles.find(x => x.id === id);
    const l = rows.reduce((n, x) => n + x.litres, 0);
    return { id, registration: rows[0].registration, litres: l, cents: rows.reduce((n, x) => n + x.amount_cents, 0), slips: rows.length, per100: v && v.kmMonth > 50 ? (l / v.kmMonth) * 100 : null };
  }).sort((a, b) => b.cents - a.cents);
  if (!fuel.length) return <Body quiet>No fuel slips in {monthName(d.month)}.</Body>;
  return (
    <>
      <Heading>Per vehicle, {monthName(d.month)}</Heading>
      {per.map(x => (
        <Card key={x.id} onPress={d.can.fleet ? () => openVehicle(x.id) : undefined} accessibilityLabel={`Fuel ${x.registration}`}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{x.registration}</Text>
            <Text style={[st.body, { fontWeight: '700' }]}>{rand(x.cents)}</Text>
          </View>
          <Text style={st.small}>{litres(x.litres)} · {x.slips} slip{x.slips > 1 ? 's' : ''}{x.per100 ? ` · about ${x.per100.toFixed(1)} L per 100 km` : ''}</Text>
        </Card>
      ))}
      <Heading>Every slip</Heading>
      <Card>
        {fuel.map(x => (
          <View key={x.id} style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Text style={[st.body, { fontWeight: '700', minWidth: 110 }]}>{x.registration}</Text>
            <Text style={[st.small, { flex: 1, minWidth: 160 }]}>{when(x.logged_at)} · {x.who} · {litres(x.litres)} · {rand(x.amount_cents)}{x.odometer_km ? ` · ${km(x.odometer_km)}` : ''}</Text>
          </View>
        ))}
      </Card>
    </>
  );
}

// ---- Trips not allowed -------------------------------------------------------------------------------

function TripList({ d, changed, openVehicle }: { d: Page; changed: () => void; openVehicle?: (id: string) => void }) {
  const s = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [ans, setAns] = useState<string[] | null>(null);
  const trips = d.trips ?? [];
  const allow = async (t: Trip, yes: boolean) => {
    const r = await s.ask({ method: yes ? 'POST' : 'DELETE', path: `/timesheets/trips/${t.id}/allow`, json: yes ? { note: note.trim() } : undefined });
    if (r && r.status < 300) { setOpen(null); setNote(''); setAns(null); changed(); } else setAns((r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.']);
  };
  return (
    <>
      <Notice tone="info" title="Trips with a company vehicle that need a reason" lines={['No reason, after hours or a weekend, home and back, or a detour on the way to a job. Allow one when he was sent (it then stops counting on his timesheet).']} />
      {trips.map(t => (
        <Card key={t.id} style={{ borderColor: t.unauthorised ? C.bad : C.line }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{t.registration} · {t.driver ?? 'unknown driver'}</Text>
            <Pill text={t.unauthorised ? 'Not allowed' : 'Allowed'} tone={t.unauthorised ? 'bad' : 'good'} />
          </View>
          <Text style={st.small}>{when(t.startedAt)}{t.endedAt ? ` → ${new Date(t.endedAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}` : ''} · {t.km} km</Text>
          <Text style={[st.small, { color: t.unauthorised ? C.bad : C.quiet }]}>{t.whyText.join(' · ')}</Text>
          {t.allowed ? <Text style={st.small}>Allowed by {t.allowed.by}: {t.allowed.note}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {t.unauthorised ? <Button label="Allow it" kind="secondary" onPress={() => { setOpen(open === t.id ? null : t.id); setNote(''); setAns(null); }} style={{ minHeight: 40 }} />
              : <Button label="Undo allowed" kind="quiet" onPress={() => allow(t, false)} style={{ minHeight: 40 }} />}
            {openVehicle ? <Button label="The vehicle" kind="quiet" onPress={() => openVehicle(t.vehicleId)} style={{ minHeight: 40 }} /> : null}
          </View>
          {open === t.id ? (
            <View style={{ gap: 8 }}>
              <Field label="Why it is allowed" value={note} onChangeText={setNote} placeholder="e.g. sent to the after-hours call" />
              {ans ? <Notice tone="bad" title="Not saved" lines={ans} /> : null}
              <Button label="Allow the trip" disabled={note.trim().length < 3} onPress={() => allow(t, true)} />
            </View>
          ) : null}
        </Card>
      ))}
      {!trips.length ? <Body quiet>No trips that need a reason in {monthName(d.month)}.</Body> : null}
    </>
  );
}
