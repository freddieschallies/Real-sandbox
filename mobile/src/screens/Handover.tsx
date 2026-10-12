// Vehicle handover inspection: odometer, fuel, photos all round, a checklist, then two signatures:
// the new driver accepting responsibility, and the previous driver or a supervisor handing over.
import React, { useRef, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { nowIso, takePhoto } from '../device.ts';
import * as H from '../../../server/src/core/handover.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, Screen, st } from '../ui.tsx';
import { SignaturePad, type SignaturePadHandle } from '../SignaturePad.tsx';
import { SyncPill } from './SyncPill.tsx';
import { C } from '../theme.ts';

export interface Lookup {
  vehicle: { id: string; registration: string };
  lastDriver: { id: string; name: string } | null;
  lastInspection: { odometerKm: number; problems: H.CheckKey[]; at: string; by: string } | null;
  needsInspection: boolean;
  offline?: boolean;
}

interface Shot { id: string; uri: string; mime: string }
const FUEL_LABEL: Record<H.FuelLevel, string> = { empty: 'Empty', quarter: '¼', half: '½', three_quarters: '¾', full: 'Full' };
const checkLabel = (k: H.CheckKey) => H.CHECKS.find(c => c[0] === k)![1];

export function Handover({ look, onBack, onDone }: { look: Lookup; onBack: () => void; onDone: (inspection: object) => void }) {
  const s = useStore();
  const prev = look.lastInspection ? { odometerKm: look.lastInspection.odometerKm, problems: look.lastInspection.problems } : null;
  const [odo, setOdo] = useState('');
  const [fuel, setFuel] = useState<H.FuelLevel>();
  const [checks, setChecks] = useState<Partial<Record<H.CheckKey, H.CheckResult>>>({});
  const [sides, setSides] = useState<Partial<Record<H.Side, Shot>>>({});
  const [damage, setDamage] = useState<Shot[]>([]);
  const [by, setBy] = useState<H.HandoverBy>();
  const [byName, setByName] = useState(look.lastDriver?.name ?? '');
  const [remoteReason, setRemoteReason] = useState('');
  const [reasons, setReasons] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = useRef<SignaturePadHandle>(null);
  const theirs = useRef<SignaturePadHandle>(null);

  const shoot = async (): Promise<Shot | null> => {
    const p = await takePhoto();
    return p ? { id: s.newId(), uri: p.uri, mime: p.mime } : null;
  };
  const setCheck = (k: H.CheckKey, r: H.CheckResult) => setChecks(c => ({ ...c, [k]: r }));

  // What the rules see. Signatures count once there is ink on the pad.
  const draft = (): H.Inspection => ({
    odometerKm: odo.trim() === '' ? undefined : Number(odo.replace(/\s/g, '')),
    fuelLevel: fuel,
    checks,
    sidePhotos: Object.fromEntries(Object.entries(sides).map(([k, v]) => [k, v!.id])),
    damagePhotos: damage.map(d => d.id),
    driverSignatureId: mine.current?.signed() ? 'pending' : undefined,
    handoverBy: by,
    handedOverByName: byName,
    handoverSignatureId: by && by !== 'remote_approval' && theirs.current?.signed() ? 'pending' : undefined,
    remoteReason,
  });

  const submit = async () => {
    const missing = H.missingOnInspection(draft(), prev);
    if (missing.length) { setReasons(missing); return; }
    setBusy(true);
    try {
      const at = nowIso();
      const upload = (label: string, kind: string, shot: { id: string; uri: string; mime: string }) =>
        s.queue(label, { method: 'POST', path: '/photos', upload: { fields: { kind, takenAt: at, id: shot.id }, fileUri: shot.uri, mime: shot.mime } });
      const mySig = { id: s.newId(), uri: await mine.current!.capture(), mime: 'image/png' };
      const theirSig = by !== 'remote_approval' ? { id: s.newId(), uri: await theirs.current!.capture(), mime: 'image/png' } : null;
      for (const side of H.SIDES) upload(`Vehicle photo: ${H.SIDE_LABEL[side]}`, `vehicle_${side}`, sides[side]!);
      damage.forEach((d, i) => upload(`Vehicle damage photo ${i + 1}`, 'vehicle_damage', d));
      upload('Your handover signature', 'handover_signature', mySig);
      if (theirSig) upload('Handover signature', 'handover_signature', theirSig);
      onDone({
        id: s.newId(),
        odometerKm: Number(odo.replace(/\s/g, '')),
        fuelLevel: fuel,
        checks,
        sidePhotos: Object.fromEntries(H.SIDES.map(k => [k, sides[k]!.id])),
        damagePhotos: damage.map(d => d.id),
        driverSignatureId: mySig.id,
        handoverBy: by,
        ...(by === 'remote_approval'
          ? { remoteReason: remoteReason.trim() }
          : { handedOverByName: byName.trim(), handoverSignatureId: theirSig!.id }),
      });
    } catch {
      setReasons(['could not save the signatures; try again']);
    } finally {
      setBusy(false);
    }
  };

  const problemsNow = H.problemsOf({ checks, sidePhotos: {}, damagePhotos: [] });
  const known = new Set(prev?.problems ?? []);

  return (
    <Screen title="Vehicle handover" sub={look.vehicle.registration} onBack={onBack} right={<SyncPill />}>
      <Card>
        <Label>Taking over from</Label>
        <Body>{look.lastDriver ? look.lastDriver.name : look.offline ? 'Unknown (no signal)' : 'Nobody yet: first handover of this vehicle'}</Body>
        {look.lastInspection ? <Text style={st.small}>Last handover: {look.lastInspection.odometerKm.toLocaleString('en-ZA')} km, by {look.lastInspection.by}</Text> : null}
        {prev?.problems.length ? (
          <Text style={[st.small, { color: C.warn }]}>Already reported: {prev.problems.map(checkLabel).join('; ')}</Text>
        ) : null}
        <Text style={st.small}>Anything wrong that isn't on the last handover is sent to the previous driver to explain. Check properly.</Text>
      </Card>
      {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}

      <Heading>1. Odometer and fuel</Heading>
      <Field label="Odometer (km)" value={odo} onChangeText={setOdo} keyboardType="number-pad" placeholder={prev ? `more than ${prev.odometerKm}` : 'e.g. 87 520'} />
      <Label>Fuel level</Label>
      <Choice options={H.FUEL_LEVELS} value={fuel} onChange={setFuel} labels={FUEL_LABEL} />

      <Heading>2. Photos all round</Heading>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {H.SIDES.map(side => (
          <View key={side} style={{ width: '47%', gap: 6 }}>
            {sides[side] ? <Image source={{ uri: sides[side]!.uri }} style={{ width: '100%', aspectRatio: 4 / 3, borderRadius: 8, backgroundColor: C.panel2 }} /> : null}
            <Button label={`${sides[side] ? '✓ ' : ''}${H.SIDE_LABEL[side].split(' (')[0]}`} kind={sides[side] ? 'quiet' : 'secondary'}
              onPress={async () => { const p = await shoot(); if (p) setSides(x => ({ ...x, [side]: p })); }} />
          </View>
        ))}
      </View>

      <Heading>3. Checks</Heading>
      {H.CHECKS.map(([k, label]) => {
        const r = checks[k];
        return (
          <Card key={k} style={r && !r.ok ? { borderColor: C.bad } : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[st.body, { flex: 1 }]}>{label}</Text>
              {known.has(k) ? <Pill text="Known" tone="warn" /> : null}
            </View>
            <Choice options={['ok', 'problem'] as const} value={r ? (r.ok ? 'ok' : 'problem') : undefined}
              onChange={o => setCheck(k, o === 'ok' ? { ok: true } : { ok: false, note: r?.note ?? '' })} labels={{ ok: 'OK', problem: 'Problem' }} />
            {r && !r.ok ? <Field label="What is wrong?" value={r.note ?? ''} onChangeText={t => setCheck(k, { ok: false, note: t })} /> : null}
          </Card>
        );
      })}
      {problemsNow.length ? (
        <>
          <Label>Photos of the problems</Label>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {damage.map(d => <Image key={d.id} source={{ uri: d.uri }} style={{ width: 96, height: 96, borderRadius: 8 }} />)}
          </View>
          <Button label={`Add photo of a problem (${damage.length})`} kind="secondary" onPress={async () => { const p = await shoot(); if (p) setDamage(x => [...x, p]); }} />
        </>
      ) : null}

      <Heading>4. You accept the vehicle</Heading>
      <Card style={{ backgroundColor: C.panel2 }}>
        <Body>{H.ACCEPTANCE_TEXT}</Body>
      </Card>
      <SignaturePad ref={mine} hint="Your signature" />

      <Heading>5. Handed over by</Heading>
      <Choice options={['previous_driver', 'supervisor', 'remote_approval'] as const} value={by} onChange={setBy}
        labels={{ previous_driver: 'Previous driver', supervisor: 'Supervisor', remote_approval: 'Nobody here' }} />
      {by === 'previous_driver' || by === 'supervisor' ? (
        <>
          <Field label={by === 'previous_driver' ? "Previous driver's name" : "Supervisor's name"} value={byName} onChangeText={setByName} autoCapitalize="words" />
          <SignaturePad ref={theirs} hint={by === 'previous_driver' ? 'Previous driver signs here' : 'Supervisor signs here'} />
        </>
      ) : null}
      {by === 'remote_approval' ? (
        <>
          <Field label="Why can nobody sign now?" value={remoteReason} onChangeText={setRemoteReason} multiline />
          <Text style={st.small}>Your supervisor is asked to approve. The vehicle shows "awaiting approval" until then.</Text>
        </>
      ) : null}

      <Button label="Accept vehicle" onPress={submit} busy={busy} />
    </Screen>
  );
}
