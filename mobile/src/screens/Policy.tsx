// The monitoring policy, accepted once before the app can be used (and again when a new version is published).
import React, { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
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

  // A new company has none yet: the CEO publishes the usual one (with the company's name), changing it first if they want.
  const [none, setNone] = useState<{ canPublish: boolean; draft: string | null } | null>(null);
  const [draft, setDraft] = useState('');
  const fetchIt = async () => {
    setFailed(false);
    const r = await s.ask({ method: 'GET', path: '/policy/current' }).catch(() => null);
    const body = r?.body as { code?: string; canPublish?: boolean; draft?: string | null } | undefined;
    if (r?.status === 200) { setPolicy(r.body as P); setNone(null); }
    else if (r?.status === 404 && body?.code === 'no_policy') { setNone({ canPublish: !!body.canPublish, draft: body.draft ?? null }); setDraft(body.draft ?? ''); }
    else { const p = await s.policy(); if (p) setPolicy(p); else setFailed(true); }
  };
  const publish = async () => {
    setBusy(true); setError(null);
    const r = await s.ask({ method: 'POST', path: '/policy/publish', json: { body: draft.trim() } });
    setBusy(false);
    if (r && r.status < 300) { setAtEnd(false); await fetchIt(); } else setError((r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.']);
  };
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
          <Text style={st.sub}>{policy ? `Version ${policy.version} · read to the end` : none ? 'Not published yet' : 'Loading…'}</Text>
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
        {none && none.canPublish ? (
          <>
            <Notice tone="info" title="Welcome. First, your company's monitoring policy" lines={['Everyone reads and accepts it once before they use the app. This is the usual one with your company\'s name: change anything you want, then publish it. You accept it next, like everyone else.']} />
            <TextInput value={draft} onChangeText={setDraft} multiline accessibilityLabel="Policy text" style={[st.input, { minHeight: 380, textAlignVertical: 'top' }]} />
          </>
        ) : null}
        {none && !none.canPublish ? <Notice tone="warn" title="Your company's monitoring policy is not published yet" lines={['The CEO publishes it when they first sign in. Try again later.']} /> : null}
      </ScrollView>
      <View style={[st.footer, { paddingBottom: Math.max(ins.bottom, S.pad) }]}>
        {error ? <Notice tone="bad" title={none ? 'Not published' : 'Not accepted'} lines={error} /> : null}
        {none?.canPublish ? <Button label="Publish this policy for everyone" onPress={publish} busy={busy} disabled={draft.trim().length < 200} /> : null}
        {!none ? <Button label={atEnd ? 'I have read and accept this policy' : 'Scroll to the end to accept'} onPress={accept} disabled={!policy || !atEnd} busy={busy} /> : null}
        <Button label="Sign out" kind="quiet" onPress={s.signOut} />
      </View>
    </View>
  );
}
