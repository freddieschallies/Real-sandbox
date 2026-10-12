// The monitoring policy, accepted once before the app can be used (and again when a new version is published).
import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../state.tsx';
import { Button, Notice, st } from '../ui.tsx';
import { C, S } from '../theme.ts';
import type { Policy as P } from '../types.ts';

export function Policy() {
  const s = useStore();
  const ins = useSafeAreaInsets();
  const [policy, setPolicy] = useState<P | null>(null);
  const [failed, setFailed] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string[] | null>(null);

  const fetchIt = async () => { setFailed(false); const p = await s.policy(); if (p) setPolicy(p); else setFailed(true); };
  useEffect(() => { fetchIt(); }, []);

  const accept = async () => {
    if (!policy) return;
    setBusy(true);
    const r = await s.acknowledge(policy.id);
    setBusy(false);
    if (!r.ok) setError(r.reasons);
  };

  return (
    <View style={[st.screen, { paddingTop: ins.top }]}>
      <View style={st.header}>
        <View style={{ flex: 1 }}>
          <Text style={st.title}>Monitoring policy</Text>
          <Text style={st.sub}>{policy ? `Version ${policy.version} · read to the end` : 'Loading…'}</Text>
        </View>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: S.pad, gap: S.gap }}
        onScroll={e => {
          const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
          if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 40) setAtEnd(true);
        }}
        onContentSizeChange={(_w, h) => { if (h < 700) setAtEnd(true); }}
        scrollEventThrottle={100}
      >
        {failed ? <Notice tone="warn" title="Could not load the policy" lines={['Reading and accepting the policy needs signal.']} /> : null}
        {failed ? <Button label="Try again" kind="secondary" onPress={fetchIt} /> : null}
        {policy ? <Text style={[st.body, { color: C.text }]}>{policy.body}</Text> : null}
      </ScrollView>
      <View style={[st.footer, { paddingBottom: Math.max(ins.bottom, S.pad) }]}>
        {error ? <Notice tone="bad" title="Not accepted" lines={error} /> : null}
        <Button label={atEnd ? 'I have read and accept this policy' : 'Scroll to the end to accept'} onPress={accept} disabled={!policy || !atEnd} busy={busy} />
        <Button label="Sign out" kind="quiet" onPress={s.signOut} />
      </View>
    </View>
  );
}
