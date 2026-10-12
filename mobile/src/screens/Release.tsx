// Taking the vehicle off his name: km and where it is left. The next driver inspects it before driving.
import React, { useState } from 'react';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso } from '../device.ts';
import { Body, Button, Choice, Field, Label, Notice, Screen } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';

type Place = 'office_yard' | 'home' | 'workshop' | 'other';

export function Release() {
  const s = useStore();
  const nav = useNav();
  const v = s.cache.today?.vehicle;
  const [km, setKm] = useState('');
  const [place, setPlace] = useState<Place>();
  const [note, setNote] = useState('');
  const [reasons, setReasons] = useState<string[] | null>(null);
  if (!v) return <Screen title="Release vehicle" onBack={nav.back}><Body quiet>No vehicle is on your name.</Body></Screen>;
  const driving = v.mode === 'driving';

  const release = () => {
    const n = Number(km.replace(/\s/g, ''));
    const missing: string[] = [];
    if (driving) {
      if (!km.trim() || !(n >= 0)) missing.push('odometer reading (km)');
      if (!place) missing.push('where you left the vehicle');
      if (place === 'other' && note.trim().length < 5) missing.push('say where the vehicle is');
    }
    if (missing.length) { setReasons(missing); return; }
    s.queue(`Released ${v.registration}`, {
      method: 'POST', path: '/vehicles/release',
      json: driving ? { at: nowIso(), km: n, place, note: note.trim() || undefined } : { at: nowIso() },
    });
    s.patchToday(t => ({ ...t, vehicle: null }));
    nav.back();
  };

  return (
    <Screen title="Release vehicle" sub={v.registration} onBack={nav.back} right={<SyncPill />}>
      <Body quiet>{driving
        ? 'The vehicle comes off your name. You stay answerable for it until the next driver has done the handover inspection.'
        : 'You are no longer riding along in this vehicle.'}</Body>
      {reasons ? <Notice tone="bad" title="Still needed:" lines={reasons} /> : null}
      {driving ? (
        <>
          <Field label="Odometer now (km)" value={km} onChangeText={setKm} keyboardType="number-pad" />
          <Label>Where are you leaving it?</Label>
          <Choice options={['office_yard', 'home', 'workshop', 'other'] as const} value={place} onChange={setPlace}
            labels={{ office_yard: 'Office yard', home: 'At home (approved)', workshop: 'Mechanic / workshop', other: 'Somewhere else' }} />
          {place === 'other' || place === 'workshop' ? <Field label="Where exactly?" value={note} onChangeText={setNote} /> : null}
        </>
      ) : null}
      <Button label={`Release ${v.registration}`} onPress={release} />
    </Screen>
  );
}
