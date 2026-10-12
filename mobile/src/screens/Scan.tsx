// Scan the barcode in the vehicle: tells the office (and the tracker) who is in which vehicle.
import React, { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso } from '../device.ts';
import { Body, Button, Choice, Field, Label, Notice, Screen, st } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';
import { C } from '../theme.ts';

const REASONS = ['usual', 'breakdown', 'service', 'swapped_with_colleague', 'other'] as const;
type Reason = typeof REASONS[number];

export function Scan() {
  const s = useStore();
  const nav = useNav();
  const [perm, ask] = useCameraPermissions();
  const [code, setCode] = useState('');
  const [typed, setTyped] = useState(Platform.OS === 'web');
  const [mode, setMode] = useState<'driving' | 'riding_along'>('driving');
  const [reason, setReason] = useState<Reason>('usual');
  const [note, setNote] = useState('');
  const [reasons, setReasons] = useState<string[] | null>(null);
  const v = s.cache.today?.vehicle;

  const confirm = () => {
    const missing: string[] = [];
    if (code.trim().length < 3) missing.push('vehicle barcode');
    if (reason === 'other' && note.trim().length < 5) missing.push('a short note for "other"');
    if (missing.length) { setReasons(missing); return; }
    s.queue(`Scanned into vehicle ${code.trim()}`, { method: 'POST', path: '/vehicles/scan', json: { barcode: code.trim(), mode, at: nowIso(), reason, reasonNote: note.trim() || undefined } });
    nav.back();
  };

  return (
    <Screen title="Vehicle" onBack={nav.back} right={<SyncPill />}>
      {v ? <Body quiet>Now: {v.registration} ({v.mode === 'driving' ? 'driving' : 'riding along'})</Body> : null}
      {reasons ? <Notice tone="bad" title="Still needed:" lines={reasons} /> : null}

      {!code && !typed ? (
        perm?.granted ? (
          <View style={{ height: 300, borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' }}>
            <CameraView style={{ flex: 1 }} facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr', 'code128', 'code39', 'ean13'] }}
              onBarcodeScanned={r => setCode(r.data)} />
            <Text style={{ position: 'absolute', bottom: 10, left: 0, right: 0, textAlign: 'center', color: '#fff' }}>Point at the barcode on the dashboard</Text>
          </View>
        ) : (
          <Button label="Allow camera to scan" onPress={ask} />
        )
      ) : null}
      {!code && !typed ? <Button label="Type the code instead" kind="quiet" onPress={() => setTyped(true)} /> : null}
      {typed || code ? <Field label="Vehicle code" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="e.g. ZSP-V07" /> : null}

      {code ? (
        <>
          <Text style={{ color: C.good, fontWeight: '700', fontSize: 18 }}>Code: {code}</Text>
          <Label>You are</Label>
          <Choice options={['driving', 'riding_along'] as const} value={mode} onChange={setMode} labels={{ driving: 'Driving', riding_along: 'Riding along' }} />
          <Label>Why this vehicle?</Label>
          <Choice options={REASONS} value={reason} onChange={setReason} labels={{ usual: 'My usual vehicle', swapped_with_colleague: 'Swapped with colleague' }} />
          {reason !== 'usual' ? <Field label="Note" value={note} onChangeText={setNote} multiline /> : null}
          <Text style={st.small}>If this is not your usual vehicle, your manager is told. The tracker is updated with the driver.</Text>
          <Button label="Confirm" onPress={confirm} />
          <Button label="Scan again" kind="quiet" onPress={() => { setCode(''); setTyped(Platform.OS === 'web'); }} />
        </>
      ) : null}
    </Screen>
  );
}
