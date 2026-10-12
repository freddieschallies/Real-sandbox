// A technician reports a fault on the vehicle he is in. It goes straight to the mechanic.
import React, { useState } from 'react';
import { Image } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso, takePhoto, type Photo } from '../device.ts';
import { Body, Button, Choice, Field, Label, Notice, Screen } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';

export function VehicleFault() {
  const s = useStore();
  const nav = useNav();
  const v = s.cache.today?.vehicle;
  const [desc, setDesc] = useState('');
  const [sev, setSev] = useState<'safety' | 'urgent' | 'normal'>('normal');
  const [photo, setPhoto] = useState<Photo | null>(null);
  if (!v) return <Screen title="Report a fault" onBack={nav.back}><Body quiet>Scan into a vehicle first.</Body></Screen>;
  const send = () => {
    const photoId = photo ? s.newId() : null;
    if (photo && photoId) s.queue('Fault photo', { method: 'POST', path: '/photos', upload: { fields: { kind: 'fleet_fault', takenAt: nowIso(), id: photoId }, fileUri: photo.uri, mime: photo.mime } });
    s.queue(`Fault reported on ${v.registration}`, { method: 'POST', path: `/fleet/vehicles/${v.id}/faults`, json: { id: s.newId(), description: desc.trim(), severity: sev, photoIds: photoId ? [photoId] : [], at: nowIso() } });
    nav.back();
  };
  return (
    <Screen title="Report a fault" sub={v.registration} onBack={nav.back} right={<SyncPill />}>
      <Body quiet>Goes straight to the mechanic. For anything that makes the vehicle unsafe to drive, choose Safety and phone your supervisor.</Body>
      <Field label="What is wrong?" value={desc} onChangeText={setDesc} multiline placeholder="e.g. Brakes squeal and pull to the left" />
      <Label>How bad is it?</Label>
      <Choice options={['safety', 'urgent', 'normal'] as const} value={sev} onChange={setSev} labels={{ safety: 'Safety', urgent: 'Urgent', normal: 'Can wait' }} />
      {sev === 'safety' ? <Notice tone="bad" title="Unsafe to drive?" lines={['Stop driving it and tell your supervisor. The mechanic is told at once.']} /> : null}
      {photo ? <Image source={{ uri: photo.uri }} style={{ width: 120, height: 120, borderRadius: 8 }} /> : null}
      <Button label={photo ? 'Retake photo' : 'Photo (optional)'} kind="quiet" onPress={async () => setPhoto(await takePhoto())} />
      <Button label="Send to the mechanic" onPress={send} disabled={desc.trim().length < 10} />
    </Screen>
  );
}
