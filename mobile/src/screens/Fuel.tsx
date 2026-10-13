// Fuel: always against a vehicle, with litres and a photo of the slip.
import React, { useState } from 'react';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso, takePhoto, type Photo } from '../device.ts';
import { Body, Button, Field, Notice, Screen } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';

export function Fuel() {
  const s = useStore();
  const nav = useNav();
  const v = s.cache.today?.vehicle;
  const [litres, setLitres] = useState('');
  const [amount, setAmount] = useState('');
  const [slip, setSlip] = useState<Photo | null>(null);
  const [reasons, setReasons] = useState<string[] | null>(null);

  const save = () => {
    const l = Number(litres.replace(',', '.'));
    const r = Number(amount.replace(',', '.'));
    const missing: string[] = [];
    if (!v) missing.push('scan into a vehicle first');
    if (!(l > 0)) missing.push('litres');
    if (!(r > 0)) missing.push('amount (R)');
    if (!slip) missing.push('photo of the fuel slip');
    if (missing.length) { setReasons(missing); return; }
    const slipId = s.newId();
    s.queue('Fuel slip photo', { method: 'POST', path: '/photos', upload: { fields: { kind: 'fuel_slip', takenAt: nowIso(), id: slipId }, fileUri: slip!.uri, mime: slip!.mime } });
    s.queue(`Fuel ${l} L for ${v!.registration}`, { method: 'POST', path: '/fuel', json: { id: s.newId(), vehicleId: v!.id, litres: l, amountCents: Math.round(r * 100), slipPhotoId: slipId, at: nowIso() } });
    nav.back();
  };

  return (
    <Screen title="Fuel" sub={v ? `For ${v.registration}` : 'No vehicle scanned'} onBack={nav.back} right={<SyncPill />}>
      {reasons ? <Notice tone="bad" title="Still needed:" lines={reasons} /> : null}
      {!v ? <Button label="Scan into a vehicle" kind="secondary" onPress={() => nav.push({ name: 'scan' })} /> : null}
      <Field label="Litres" value={litres} onChangeText={setLitres} keyboardType="decimal-pad" placeholder="e.g. 54.3" />
      <Field label="Amount paid (R)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="e.g. 1250.00" />
      <Button label={slip ? 'Slip photo taken ✓ (retake)' : 'Photo of the fuel slip'} kind="secondary" onPress={async () => { const p = await takePhoto('document'); if (p) setSlip(p); }} />
      <Body quiet>Litres are checked against the tank size and the tracker's distance since the last fill-up.</Body>
      <Button label="Save fuel" onPress={save} />
    </Screen>
  );
}
