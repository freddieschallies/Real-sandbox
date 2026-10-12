// A department manager's map of his team: where each technician is, the vehicle he is in, the job
// he is busy with and who he is with. The CEO sees every technician.
import React, { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Heading, Label, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { AreaMap, nearest, type MapPin } from '../map/AreaMap.tsx';
import { Avatar, type Profile } from '../office/Profile.tsx';

interface TeamTech { id: string; full_name: string; tradeLabel: string | null; department: string | null; photo_id: string | null; now: Profile['now'] }
type State = 'site' | 'driving' | 'parked' | 'unknown';

const stateOf = (t: TeamTech): State => {
  const n = t.now;
  if (n.job?.status === 'in_progress' && n.location?.source === 'on site') return 'site';
  if (!n.location) return n.job?.status === 'in_progress' ? 'site' : 'unknown';
  if (n.location.moving) return 'driving';
  return n.job?.status === 'in_progress' ? 'site' : 'parked';
};
const COLOUR: Record<State, string> = { site: C.good, driving: C.info, parked: C.warn, unknown: C.quiet };
const LABEL: Record<State, string> = { site: 'On site', driving: 'Driving', parked: 'Parked', unknown: 'No location' };
const ago = (m: number | null | undefined) => (m == null ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`);

export function TeamMap({ openPerson }: { openPerson?: (id: string) => void }) {
  const s = useStore();
  const [d, setD] = useState<{ all: boolean; departments: string[]; technicians: TeamTech[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>();
  const load = async () => {
    const r = await s.ask({ method: 'GET', path: '/team/map' });
    if (r?.status === 200) { setD(r.body); setErr(null); } else setErr((r?.body as { reasons?: string[] })?.reasons?.join('; ') ?? 'Needs signal to load.');
  };
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);
  if (err) return <Body quiet>{err}</Body>;
  if (!d) return <Body quiet>Loading…</Body>;
  const techs = d.technicians;
  const count = (x: State) => techs.filter(t => stateOf(t) === x).length;
  const pins: MapPin[] = techs.filter(t => t.now.location).map(t => ({
    id: t.id, lat: t.now.location!.lat, lng: t.now.location!.lng, label: t.full_name.split(' ')[0], colour: COLOUR[stateOf(t)], accessibilityLabel: `Map pin ${t.full_name}`,
  }));
  const sel = techs.find(t => t.id === picked);
  return (
    <>
      <Text style={st.small}>{d.all ? 'Every technician' : `Your team: ${d.departments.join(', ') || 'no department yet'}`} · updates every 30 seconds</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['site', 'driving', 'parked', 'unknown'] as State[]).map(x => (
          <Card key={x} style={{ flex: 1, padding: 10, borderColor: x === 'unknown' && count(x) ? C.warn : C.line }}>
            <Label>{LABEL[x]}</Label>
            <Text style={{ color: COLOUR[x], fontSize: 24, fontWeight: '800' }}>{count(x)}</Text>
          </Card>
        ))}
      </View>
      <AreaMap pins={pins} picked={picked} onPick={setPicked} label="Map of your team" />
      <Text style={st.small}>Green: on site · blue: driving · amber: parked · grey: no location (no vehicle and not on site). Tap a name.</Text>
      {sel ? <TechCard t={sel} openPerson={openPerson} /> : null}
      <Heading>{d.all ? 'Technicians' : 'Your team'} ({techs.length})</Heading>
      {techs.map(t => {
        const x = stateOf(t); const n = t.now;
        return (
          <Card key={t.id} onPress={() => setPicked(t.id)} accessibilityLabel={`Where is ${t.full_name}`} style={picked === t.id ? { borderColor: C.accent, borderWidth: 2 } : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Avatar id={t.photo_id} name={t.full_name} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={[st.body, { fontWeight: '700' }]}>{t.full_name}</Text>
                <Text style={st.small}>{n.job ? `Job ${n.job.number}, ${n.job.store}` : 'No open job'}{n.vehicle ? ` · ${n.vehicle.registration}` : ''}{d.all && t.department ? ` · ${t.department}` : ''}</Text>
              </View>
              <Pill text={LABEL[x]} tone={x === 'site' ? 'good' : x === 'driving' ? 'info' : x === 'parked' ? 'warn' : 'quiet'} />
            </View>
          </Card>
        );
      })}
      {!techs.length ? <Body quiet>No technicians under you yet. The CEO puts technicians in your department.</Body> : null}
    </>
  );
}

function TechCard({ t, openPerson }: { t: TeamTech; openPerson?: (id: string) => void }) {
  const n = t.now; const l = n.location; const x = stateOf(t);
  return (
    <Card style={{ borderColor: C.accent, borderWidth: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar id={t.photo_id} name={t.full_name} size={56} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.text, fontSize: 20, fontWeight: '800' }}>{t.full_name}</Text>
          <Text style={st.small}>{[t.tradeLabel, t.department].filter(Boolean).join(' · ')}</Text>
        </View>
        <Pill text={LABEL[x]} tone={x === 'site' ? 'good' : x === 'driving' ? 'info' : x === 'parked' ? 'warn' : 'quiet'} />
      </View>
      <Body>{l ? `${l.source === 'on site' ? `On site at ${n.job?.store}` : l.moving ? `Driving${l.speedKmh ? `, ${l.speedKmh} km/h` : ''}` : 'Parked'}, near ${nearest(l.lat, l.lng)}${l.minutesAgo != null ? ` · ${ago(l.minutesAgo)}` : ''}` : 'No location: not in a vehicle and not on site.'}</Body>
      <Text style={st.small}>Vehicle: {n.vehicle ? `${n.vehicle.registration} (${n.vehicle.mode === 'driving' ? 'driving' : 'riding along'})` : 'none'}</Text>
      <Text style={st.small}>Busy with: {n.job ? `job ${n.job.number}, ${n.job.store}${n.job.status === 'in_progress' ? ' (working now)' : n.job.status === 'continue_later' ? ' (continue later)' : ' (next)'}` : 'no open job'}</Text>
      {n.job ? <Text style={st.small}>{n.job.fault}</Text> : null}
      <Text style={st.small}>With: {n.with.length ? n.with.join(', ') : 'nobody else'}</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {openPerson ? <Button label="Open profile" kind="secondary" onPress={() => openPerson(t.id)} style={{ flexBasis: '46%', flexGrow: 1, minHeight: 44 }} /> : null}
        {l ? <Button label="Open in Maps" kind="secondary" onPress={() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lng}`).catch(() => undefined)} style={{ flexBasis: '46%', flexGrow: 1, minHeight: 44 }} /> : null}
      </View>
    </Card>
  );
}
