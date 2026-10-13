// Scan the barcode in the vehicle: tells the office (and the tracker) who is in which vehicle.
// Taking over a vehicle as its driver means a handover inspection first (see Handover.tsx).
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import type { BarcodeType } from 'expo-camera';
import { describeCode, parseLicenceDisc } from '../../../server/src/core/vehicleCode.ts';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { CodeScanner } from '../CodeScanner.tsx';
import { ItemPicture } from '../ItemPicture.tsx';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso } from '../device.ts';
import { Body, Button, Card, Choice, Field, Label, Notice, Screen, st } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';
import { Handover, type Lookup } from './Handover.tsx';
import { C } from '../theme.ts';

// Every kind of barcode the camera reads: our stickers and the licence disc (PDF417).
const ALL_CODES: BarcodeType[] = ['qr', 'pdf417', 'code128', 'code39', 'code93', 'ean13', 'ean8', 'upc_a', 'upc_e', 'itf14', 'codabar', 'datamatrix', 'aztec'];
const DEMO_DISC = '%MVL1CC09%0154%4025T09N%1%4025015ABCD1%ND412778%BCD123X%Bakkie / Bakkie%TOYOTA%HILUX%White / Wit%AHTFR22G406123456%1GD1234567%2027-03-31%';
const REASONS = ['usual', 'breakdown', 'service', 'swapped_with_colleague', 'other'] as const;
type Reason = typeof REASONS[number];
type Mode = 'driving' | 'riding_along';

export function Scan() {
  const s = useStore();
  const nav = useNav();
  const [perm, ask] = useCameraPermissions();
  const [code, setCode] = useState('');
  const [typed, setTyped] = useState(false);
  const [mode, setMode] = useState<Mode>('driving');
  const [reason, setReason] = useState<Reason>('usual');
  const [note, setNote] = useState('');
  const [reasons, setReasons] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [handover, setHandover] = useState<Lookup | null>(null);
  const [torch, setTorch] = useState(false);
  const isDisc = !!parseLicenceDisc(code);
  // As soon as a code is read: which vehicle it is, with its picture, so he knows it is the right one.
  const [seen, setSeen] = useState<{ registration: string; photo_id: string | null } | null>(null);
  useEffect(() => {
    setSeen(null);
    if (code.trim().length < 3) return;
    const t = setTimeout(() => {
      s.ask({ method: 'GET', path: `/vehicles/lookup?barcode=${encodeURIComponent(code.trim())}&mode=riding_along` }).then(r => { if (r?.status === 200) setSeen({ registration: r.body.vehicle.registration, photo_id: r.body.vehicle.photo_id ?? null }); }).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [code]);
  const v = s.cache.today?.vehicle;

  const details = () => {
    const missing: string[] = [];
    if (code.trim().length < 3) missing.push('vehicle barcode');
    if (reason === 'other' && note.trim().length < 5) missing.push('a short note for "other"');
    return missing;
  };

  const send = (inspection?: object, label?: string, registration?: string) => {
    s.queue(label ?? `Scanned into ${describeCode(code)}`, {
      method: 'POST', path: '/vehicles/scan',
      json: { barcode: code.trim(), mode, at: nowIso(), reason, reasonNote: note.trim() || undefined, inspection },
    });
    if (registration) {
      s.patchToday(t => ({ ...t, vehicle: { id: t.vehicle?.id ?? '', registration, mode, dropped_off_at: null, handover_status: inspection ? (inspection as { handoverBy: string }).handoverBy === 'remote_approval' ? 'awaiting_approval' : 'signed' : t.vehicle?.handover_status ?? null } }));
    }
    nav.back();
  };

  const next = async () => {
    const missing = details();
    if (missing.length) { setReasons(missing); return; }
    setReasons(null);
    setChecking(true);
    const r = await s.ask({ method: 'GET', path: `/vehicles/lookup?barcode=${encodeURIComponent(code.trim())}&mode=${mode}` });
    setChecking(false);
    if (r && r.status !== 200) { setReasons(r.body?.reasons ?? ['unknown vehicle barcode']); return; }
    // No signal: assume a handover is needed when driving; the office checks it when it arrives.
    const look: Lookup = r ? r.body : { vehicle: { id: '', registration: parseLicenceDisc(code)?.registration ?? code.trim() }, lastDriver: null, lastInspection: null, needsInspection: mode === 'driving', offline: true };
    if (look.needsInspection) setHandover(look);
    else send(undefined, `Scanned into ${look.vehicle.registration}`, look.vehicle.registration);
  };

  if (handover) {
    return <Handover look={handover} onBack={() => setHandover(null)}
      onDone={inspection => send(inspection, `Took over ${handover.vehicle.registration} (handover inspection)`, handover.vehicle.registration)} />;
  }

  return (
    <Screen title="Vehicle" onBack={nav.back} right={<SyncPill />}>
      {v ? <Body quiet>Now: {v.registration} ({v.mode === 'driving' ? 'driving' : 'riding along'})</Body> : null}
      {reasons ? <Notice tone="bad" title="Still needed:" lines={reasons} /> : null}

      {!code && !typed ? (
        Platform.OS === 'web' ? <CodeScanner onCode={c => { if (!code) setCode(c); }} hint="Point at the vehicle sticker or the licence disc" />
        : perm?.granted ? (
          <View style={{ height: 300, borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' }}>
            <CameraView style={{ flex: 1 }} facing="back" enableTorch={torch}
              barcodeScannerSettings={{ barcodeTypes: ALL_CODES }}
              onBarcodeScanned={r => { if (r.data && !code) setCode(r.data); }} />
            <Text style={{ position: 'absolute', bottom: 10, left: 0, right: 0, textAlign: 'center', color: '#fff' }}>Point at the vehicle sticker or the licence disc</Text>
            <Pressable onPress={() => setTorch(t => !t)} accessibilityRole="button" accessibilityLabel="Torch"
              style={{ position: 'absolute', top: 10, right: 10, backgroundColor: '#000a', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 }}>
              <Text style={{ color: '#fff', fontWeight: '700' }}>{torch ? 'Torch off' : 'Torch on'}</Text>
            </Pressable>
          </View>
        ) : (
          <Button label="Allow camera to scan" onPress={ask} />
        )
      ) : null}
      {!code && !typed ? <Button label="Type the code instead" kind="quiet" onPress={() => setTyped(true)} /> : null}
      {typed && !code && s.session?.mode === 'demo' ? (
        <Card>
          <Text style={st.small}>Demo: tap a code to use it, or type one.</Text>
          <Choice options={['ZSP-V07', DEMO_DISC] as string[]} value={undefined} onChange={setCode} labels={{ 'ZSP-V07': 'Vehicle sticker ZSP-V07', [DEMO_DISC]: 'Licence disc ND 412-778' }} />
        </Card>
      ) : null}
      {(typed || code) && !isDisc ? <Field label="Vehicle code or registration" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="e.g. ZSP-V07 or ND 412-778" /> : null}

      {code ? (
        <>
          {seen?.photo_id ? <ItemPicture photoId={seen.photo_id} kind="vehicle_profile" label={seen.registration} canEdit={false} save={async () => null} /> : null}
          <Text style={{ color: C.good, fontWeight: '700', fontSize: 18 }}>{seen ? `${seen.registration} · ` : ''}{describeCode(code)}</Text>
          <Label>You are</Label>
          <Choice options={['driving', 'riding_along'] as const} value={mode} onChange={setMode} labels={{ driving: 'Driving', riding_along: 'Riding along' }} />
          <Label>Why this vehicle?</Label>
          <Choice options={REASONS} value={reason} onChange={setReason} labels={{ usual: 'My usual vehicle', swapped_with_colleague: 'Swapped with colleague' }} />
          {reason !== 'usual' ? <Field label="Note" value={note} onChangeText={setNote} multiline /> : null}
          {mode === 'driving' ? (
            <Card style={{ backgroundColor: C.panel2 }}>
              <Text style={st.small}>Taking over a vehicle someone else drove means a handover inspection: photos, checks and signatures. You then carry full responsibility for it.</Text>
            </Card>
          ) : null}
          <Button label={mode === 'driving' ? 'Next' : 'Confirm'} onPress={next} busy={checking} />
          <Button label="Scan again" kind="quiet" onPress={() => { setCode(''); setTyped(false); }} />
        </>
      ) : null}
    </Screen>
  );
}
