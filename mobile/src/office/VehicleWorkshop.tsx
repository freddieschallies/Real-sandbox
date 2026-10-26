// The office's Vehicle workshop (the mechanic's side; machines are in the Machine workshop): vehicles
// in the workshop now with their job cards, vehicles booked in, off the road, and faults waiting. The
// managers, the admin and the CEO see it; the mechanic (and whoever the CEO gave the fleet) runs it.
import React from 'react';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Body, Card, Heading, Label, Notice, Pill, st } from '../ui.tsx';
import { C, S } from '../theme.ts';
import { useFleet } from '../fleet/useFleet.ts';
import { useWorkshop } from '../fleet/Workshop.tsx';
import { FaultRow, FleetDetail, type Sel } from '../fleet/FleetApp.tsx';
import { SLOT_LABEL, STATUS, TYPE_LABEL, dayName, km } from '../fleet/common.ts';

const daysSince = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));

export function VehicleWorkshop() {
  const wide = useWindowDimensions().width >= 900;
  const f = useFleet();
  const ws = useWorkshop();
  const [stack, setStack] = React.useState<Sel[]>([]);
  const open = (x: Sel) => setStack(s0 => (wide && x.kind === 'vehicle' ? [x] : [...s0, x]));
  const back = () => setStack(s0 => s0.slice(0, -1));
  const v = f.d.vehicles;
  const jobs = f.d.jobs.filter(j => j.status === 'open');
  const inShop = v.filter(x => x.open_job || x.status === 'workshop');
  const booked = f.d.bookings.filter(b => b.status === 'booked').sort((a, b) => a.booked_for.localeCompare(b.booked_for));
  const off = v.filter(x => x.status === 'off_road' && !x.open_job);
  const waiting = f.d.faults.filter(x => x.status === 'open' && !jobs.some(j => j.vehicle_id === x.vehicle_id));
  const due = v.filter(x => ['soon', 'overdue'].includes(x.serviceDue.state) && !booked.some(b => b.vehicle_id === x.id) && !x.open_job);

  const list = (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60 }}>
      <Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>Vehicle workshop</Text>
      <Text style={st.small}>The company's vehicles at the mechanic: in the workshop now, booked in, off the road and faults waiting. Machines for clients are in the Machine workshop.</Text>
      {!f.d.loadedAt && !v.length ? (f.loading ? <Body quiet>Loading…</Body> : <Notice tone="warn" title="Could not load the vehicles" lines={['Needs signal, or you do not have access to the fleet (the CEO switches it on).']} />) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Tile label="In the workshop" value={inShop.length} tone={inShop.length ? 'warn' : 'good'} />
        <Tile label="Booked in" value={booked.length} />
        <Tile label="Off the road" value={off.length} tone={off.length ? 'bad' : 'good'} />
        <Tile label="Faults waiting" value={waiting.length} tone={waiting.some(x => x.severity === 'safety') ? 'bad' : waiting.length ? 'warn' : 'good'} />
        {ws.data ? <Tile label="Workshop stock below minimum" value={ws.data.belowMin} tone={ws.data.belowMin ? 'warn' : 'good'} /> : null}
      </View>

      <Heading>In the workshop now</Heading>
      {!inShop.length ? <Body quiet>No vehicles in the workshop.</Body> : inShop.map(x => {
        const j = jobs.find(y => y.vehicle_id === x.id);
        return (
          <Card key={x.id} onPress={() => (j ? open({ kind: 'job', id: j.id }) : open({ kind: 'vehicle', id: x.id }))} accessibilityLabel={`In the workshop ${x.registration}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{x.registration} <Text style={st.small}>{[x.make, x.model].filter(Boolean).join(' ')}</Text></Text>
              {j ? <Pill text={`Job ${j.number} · ${TYPE_LABEL[j.job_type]}`} tone="info" /> : null}
              <Pill text={STATUS[x.status].text} tone={STATUS[x.status].tone} />
            </View>
            {j ? <Body numberOfLines={2}>{j.reason}</Body> : x.status_note ? <Body numberOfLines={2}>{x.status_note}</Body> : null}
            <Text style={st.small}>{j ? `Opened ${dayName(j.opened_at.slice(0, 10))} (${daysSince(j.opened_at)} day${daysSince(j.opened_at) === 1 ? '' : 's'}) by ${j.mechanic} · ${km(j.odometer_in)}` : 'No job card open yet'}{x.driver ? ` · driver ${x.driver}` : ''}</Text>
          </Card>
        );
      })}

      <Heading>Booked in</Heading>
      {!booked.length ? <Body quiet>Nothing booked.</Body> : booked.map(b => (
        <Card key={b.id} onPress={() => open({ kind: 'booking', id: b.id })} accessibilityLabel={`Booked ${b.registration}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{b.registration}</Text>
            <Pill text={TYPE_LABEL[b.job_type]} tone="info" />
            <Pill text={`${dayName(b.booked_for)} · ${SLOT_LABEL[b.time_slot]}`} tone="quiet" />
          </View>
          <Body numberOfLines={2}>{b.reason}</Body>
          <Text style={st.small}>{b.place}{b.driver ? ` · driver ${b.driver}` : ''}</Text>
        </Card>
      ))}
      {due.length ? <><Label>Service due, not booked yet ({due.length})</Label>{due.map(x => (
        <Card key={x.id} onPress={() => open({ kind: 'vehicle', id: x.id })} style={{ borderColor: x.serviceDue.state === 'overdue' ? C.bad : C.warn }}>
          <Text style={[st.body, { fontWeight: '800' }]}>{x.registration}</Text>
          <Text style={[st.small, { color: x.serviceDue.state === 'overdue' ? C.bad : C.warn }]}>{x.serviceDue.text}</Text>
        </Card>
      ))}</> : null}

      {off.length ? <><Heading>Off the road</Heading>{off.map(x => (
        <Card key={x.id} onPress={() => open({ kind: 'vehicle', id: x.id })}>
          <Text style={[st.body, { fontWeight: '800' }]}>{x.registration}</Text>
          {x.status_note ? <Text style={st.small}>{x.status_note}</Text> : null}
        </Card>
      ))}</> : null}

      <Heading>Faults waiting for the workshop</Heading>
      {!waiting.length ? <Body quiet>None.</Body> : waiting.map(x => <FaultRow key={x.id} x={x} onPress={() => open({ kind: 'vehicle', id: x.vehicle_id })} />)}
    </ScrollView>
  );
  const sel = stack.at(-1);
  const detail = sel ? <FleetDetail sel={sel} f={f} ws={ws} open={open} back={back} extra={!wide || stack.length > 1 ? <Text onPress={back} style={[st.body, { color: C.accent, fontWeight: '700' }]} accessibilityRole="button">‹ Back</Text> : undefined} /> : null;
  if (!wide) return <View style={{ flex: 1 }}>{detail ?? list}</View>;
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <View style={{ width: 520, borderRightWidth: 1, borderRightColor: C.line }}>{list}</View>
      <View style={{ flex: 1 }}>{detail ?? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Body quiet>Choose a vehicle or booking.</Body></View>}</View>
    </View>
  );
}

function Tile({ label, value, tone = 'quiet' }: { label: string; value: number; tone?: 'quiet' | 'warn' | 'bad' | 'good' }) {
  const border = tone === 'bad' ? C.bad : tone === 'warn' ? C.warn : tone === 'good' ? C.good : C.line;
  return (
    <Card style={{ flexGrow: 1, flexBasis: 130, borderColor: border, borderWidth: tone === 'quiet' ? 1 : 2, paddingVertical: 10 }} accessibilityLabel={`${label} ${value}`}>
      <Text style={st.small}>{label}</Text>
      <Text style={{ color: C.text, fontSize: 22, fontWeight: '800' }}>{value}</Text>
    </Card>
  );
}
