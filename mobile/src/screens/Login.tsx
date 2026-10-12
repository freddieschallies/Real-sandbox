import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Field, Notice, Screen, st } from '../ui.tsx';
import { C } from '../theme.ts';

export function Login() {
  const s = useStore();
  const [server, setServer] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'demo' | 'server' | null>(null);
  const [error, setError] = useState<string[] | null>(null);

  const go = async (mode: 'demo' | 'server') => {
    setBusy(mode); setError(null);
    const url = server.trim().replace(/\/+$/, '');
    const r = mode === 'demo' ? await s.signIn('demo', '', 'demo', 'demo') : await s.signIn('server', url, email.trim(), password);
    setBusy(null);
    if (!r.ok) setError(r.reasons);
  };

  return (
    <Screen title="Real Sandbox" sub="Job cards and vehicles">
      <View style={{ gap: 6, marginVertical: 8 }}>
        <Text style={{ color: C.accent, fontSize: 30, fontWeight: '800' }}>Sign in</Text>
        <Body quiet>Use the email and password the office gave you.</Body>
      </View>
      {error ? <Notice tone="bad" title="Could not sign in" lines={error} /> : null}
      <Field label="Server address" value={server} onChangeText={setServer} placeholder="https://jobs.yourcompany.co.za"
        autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" />
      <Button label="Sign in" onPress={() => go('server')} busy={busy === 'server'} disabled={!server.trim() || !email.trim() || !password} />
      <View style={{ height: 1, backgroundColor: C.line, marginVertical: 12 }} />
      <Text style={st.small}>No server yet? Try the app with made-up jobs. Nothing you do in the demo is sent anywhere.</Text>
      <Button label="Try the demo" kind="secondary" onPress={() => go('demo')} busy={busy === 'demo'} />
    </Screen>
  );
}
