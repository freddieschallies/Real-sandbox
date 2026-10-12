// Store manager sign-off. A signature on the glass, or "manager unavailable" with who he spoke to.
import React, { useRef, useState } from 'react';
import { PanResponder, Platform, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso } from '../device.ts';
import { J, toCore } from '../local.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Screen, st } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';
import { C } from '../theme.ts';

export function SignOff({ jobId }: { jobId: string }) {
  const s = useStore();
  const nav = useNav();
  const v = s.cache.cards[jobId];
  const [how, setHow] = useState<'signature' | 'unavailable'>('signature');
  const [manager, setManager] = useState(v?.visits.at(-1)?.checkedInManager ?? '');
  const [reason, setReason] = useState('');
  const [spokeTo, setSpokeTo] = useState('');
  const [paths, setPaths] = useState<string[]>([]);
  const [reasons, setReasons] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const pad = useRef<View>(null);
  const live = useRef('');

  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: e => { const { locationX: x, locationY: y } = e.nativeEvent; live.current = `M${x.toFixed(1)},${y.toFixed(1)}`; setPaths(p => [...p, live.current]); },
    onPanResponderMove: e => {
      const { locationX: x, locationY: y } = e.nativeEvent;
      live.current += ` L${x.toFixed(1)},${y.toFixed(1)}`;
      setPaths(p => [...p.slice(0, -1), live.current]);
    },
  })).current;

  if (!v) return <Screen title="Sign-off" onBack={nav.back}><Body quiet>Not found on the phone.</Body></Screen>;

  const close = (signOff: object, label: string, localSignOff: J.SignOff) => {
    const r = s.jobAction(jobId, label, c => J.close(c, localSignOff, nowIso()),
      { method: 'POST', path: `/jobs/${jobId}/close`, json: { at: nowIso(), signOff } },
      view => ({ ...view, manager_name: localSignOff.signature ? localSignOff.managerName : null }));
    if (!r.ok) { setReasons(r.reasons); return; }
    nav.reset();
  };

  const signed = async () => {
    const missing: string[] = [];
    if (!manager.trim()) missing.push('store manager name');
    if (paths.join('').length < 60) missing.push('signature');
    if (missing.length) { setReasons(missing); return; }
    // Check the rules before saving the picture, so a refused sign-off leaves nothing behind.
    const pre = J.close(toCore(v), { signature: true, managerName: manager }, nowIso());
    if (!pre.ok) { setReasons(pre.reasons); return; }
    setBusy(true);
    try {
      const uri = await captureRef(pad, { format: 'png', quality: 1, result: Platform.OS === 'web' ? 'data-uri' : 'tmpfile' });
      const photoId = s.newId();
      s.queue('Manager signature', { method: 'POST', path: '/photos', upload: { fields: { kind: 'signature', takenAt: nowIso(), id: photoId, jobId }, fileUri: uri, mime: 'image/png' } }, jobId);
      close({ signature: true, managerName: manager.trim(), signaturePhotoId: photoId }, `Signed off by ${manager.trim()}`, { signature: true, managerName: manager.trim() });
    } catch {
      setReasons(['could not save the signature picture; try again']);
    } finally {
      setBusy(false);
    }
  };

  const unsigned = () => close({ signature: false, reason: reason.trim(), spokeTo: spokeTo.trim() }, 'Closed: manager unavailable',
    { signature: false, reason: reason.trim(), spokeTo: spokeTo.trim() });

  return (
    <Screen title="Sign-off" sub={`#${v.job_number} · ${v.store}`} onBack={nav.back} right={<SyncPill />}>
      <Card>
        <Label>Summary for the manager</Label>
        {v.items.map(it => (
          <View key={it.id} style={{ gap: 2 }}>
            <Text style={[st.body, { fontWeight: '700' }]}>{it.title}</Text>
            {it.did ? <Text style={st.small}>{it.did}</Text> : null}
            {it.outcome && it.outcome !== 'complete' ? <Text style={[st.small, { color: C.warn }]}>{it.outcome.replace(/_/g, ' ')}: {it.stillNeeded}</Text> : null}
          </View>
        ))}
        <Text style={st.small}>Time on site: {v.jobMinutes} min</Text>
      </Card>
      {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}
      <Choice options={['signature', 'unavailable'] as const} value={how} onChange={setHow}
        labels={{ signature: 'Manager signs', unavailable: 'Manager unavailable' }} />

      {how === 'signature' ? (
        <>
          <Field label="Manager's name" value={manager} onChangeText={setManager} autoCapitalize="words" />
          {v.storeManagers.length ? <Choice options={v.storeManagers} value={manager} onChange={setManager} labels={Object.fromEntries(v.storeManagers.map(m => [m, m]))} /> : null}
          <Label>Signature</Label>
          <View ref={pad} collapsable={false} {...responder.panHandlers}
            style={{ height: 220, backgroundColor: '#FFFFFF', borderRadius: 10, overflow: 'hidden' }}>
            <Svg width="100%" height="100%">
              {paths.map((d, i) => <Path key={i} d={d} stroke="#111" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />)}
            </Svg>
            {paths.length === 0 ? <Text pointerEvents="none" style={{ position: 'absolute', bottom: 12, left: 14, color: '#888' }}>Manager signs here</Text> : null}
          </View>
          <Button label="Clear signature" kind="quiet" onPress={() => setPaths([])} />
          <Button label="Close job – signed" onPress={signed} busy={busy} />
        </>
      ) : (
        <>
          <Heading>Manager unavailable</Heading>
          <Body quiet>The job closes without a signature. Your after photos are the evidence, and the office is told.</Body>
          <Field label="Why is the manager unavailable?" value={reason} onChangeText={setReason} multiline />
          <Field label="Who did you speak to instead?" value={spokeTo} onChangeText={setSpokeTo} autoCapitalize="words" />
          <Button label="Close job – unsigned" onPress={unsigned} />
        </>
      )}
    </Screen>
  );
}
