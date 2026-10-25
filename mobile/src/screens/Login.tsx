// Signing in. Everyone has their own login: their email and a password only they know. The first
// time (or after forgetting the password) they use the one-time setup code the office (HR or the
// CEO) gave them and choose their own password. On their own phone they stay signed in for 30 days.
import React, { useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Field, Label, Notice, Screen, Toggle, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { passwordProblem } from '../password.ts';
import { OwnerApp, ownerView, useOwnerOpen } from '../owner/OwnerApp.tsx';

/** Built into the company's own app, so nobody types the server address. */
// The web app served by the server itself (the online server) talks to the address it was opened on.
const SAME_ORIGIN = process.env.EXPO_PUBLIC_SAME_ORIGIN === '1' && Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : '';
const SERVER = (process.env.EXPO_PUBLIC_SERVER_URL || SAME_ORIGIN).replace(/\/+$/, '');

export { passwordProblem };

export function PasswordField({ label, value, onChangeText, hint, autoComplete = 'password' }: { label: string; value: string; onChangeText: (v: string) => void; hint?: string; autoComplete?: 'password' | 'new-password' | 'current-password' }) {
  const [show, setShow] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Label>{label}</Label>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <TextInput value={value} onChangeText={onChangeText} secureTextEntry={!show} autoCapitalize="none" autoCorrect={false} autoComplete={autoComplete}
          accessibilityLabel={label} placeholderTextColor={C.quiet} style={[st.input, { flex: 1 }]} />
        <Pressable onPress={() => setShow(x => !x)} accessibilityRole="button" accessibilityLabel={show ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} hitSlop={8}
          style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 10 }}>
          <Text style={{ color: C.accent, fontWeight: '700' }}>{show ? 'Hide' : 'Show'}</Text>
        </Pressable>
      </View>
      {hint ? <Text style={st.hint}>{hint}</Text> : null}
    </View>
  );
}

/** `demo`: the test drive, where the people the office added sign in with what they chose (nothing leaves the browser). */
export function Login({ demo, back }: { demo?: boolean; back?: () => void } = {}) {
  const s = useStore();
  const [mode, setMode] = useState<'signin' | 'setup'>('signin');
  const [server, setServer] = useState(SERVER);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPw, setNewPw] = useState('');
  const [again, setAgain] = useState('');
  // On a phone the person keeps it signed in; on a shared office computer they can switch it off.
  const [remember, setRemember] = useState(Platform.OS !== 'web' || !!demo);
  const [busy, setBusy] = useState<'demo' | 'stock' | 'mech' | 'office' | 'server' | null>(null);
  const [error, setError] = useState<string[] | null>(null);
  const url = server.trim().replace(/\/+$/, '');
  const where: 'demo' | 'server' = demo ? 'demo' : 'server';

  const signIn = async () => {
    setBusy('server'); setError(null);
    const r = await s.signIn(where, url, email.trim(), password, { remember });
    setBusy(null);
    if (!r.ok) setError(r.reasons);
  };
  const weak = newPw ? passwordProblem(newPw, email.trim()) : null;
  const setUp = async () => {
    if (weak) { setError([weak]); return; }
    if (newPw !== again) { setError(['The two passwords are not the same.']); return; }
    setBusy('server'); setError(null);
    const r = await s.signIn(where, url, email.trim(), newPw, { remember, setupCode: code.trim() });
    setBusy(null);
    if (!r.ok) setError(r.reasons);
  };
  const tryDemo = async (who: 'demo' | 'stock' | 'mech' | 'office') => {
    setBusy(who); setError(null);
    const r = await s.signIn('demo', '', who, 'demo');
    setBusy(null);
    if (!r.ok) setError(r.reasons);
  };
  const needServer = !demo && !SERVER;
  const owner = useOwnerOpen();
  if (owner) return <OwnerApp mode={where} baseUrl={demo ? '' : SERVER} back={() => ownerView.set(false)} />;

  return (
    <Screen title="Real Sandbox" sub="Job cards and vehicles">
      {back ? <Button label="Back to the test guide" kind="quiet" onPress={back} /> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
        <Button label="Sign in" kind={mode === 'signin' ? 'primary' : 'secondary'} onPress={() => { setMode('signin'); setError(null); }} style={{ flex: 1 }} />
        <Button label="I have a setup code" kind={mode === 'setup' ? 'primary' : 'secondary'} onPress={() => { setMode('setup'); setError(null); }} style={{ flex: 1 }} />
      </View>
      <View style={{ gap: 6, marginVertical: 8 }}>
        <Text style={{ color: C.accent, fontSize: 30, fontWeight: '800' }}>{mode === 'signin' ? 'Sign in' : 'Choose your password'}</Text>
        <Body quiet>{mode === 'signin'
          ? 'Your own email and the password you chose. Never share it: everything you do is under your name.'
          : 'First time, or forgot your password? Use the setup code the office gave you and choose your own password. Nobody else, not even the office, will know it.'}</Body>
      </View>
      {error ? <Notice tone="bad" title={mode === 'signin' ? 'Could not sign in' : 'Could not set your password'} lines={error} /> : null}
      {needServer ? <Field label="Server address" value={server} onChangeText={setServer} placeholder="https://jobs.yourcompany.co.za"
        autoCapitalize="none" autoCorrect={false} keyboardType="url" /> : null}
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" />
      {mode === 'signin' ? (
        <>
          <PasswordField label="Password" value={password} onChangeText={setPassword} autoComplete="current-password" />
          <Toggle label="Keep me signed in on this phone (30 days)" value={remember} onChange={setRemember} />
          {!remember ? <Text style={st.small}>Signed out after 12 hours. Turn this off on a computer other people use.</Text> : null}
          <Button label="Sign in" onPress={signIn} busy={busy === 'server'} disabled={(needServer && !url) || !email.trim() || !password} />
          <Text style={st.small}>Forgot your password, or want a new one? Ask Admin or the CEO for a setup code, then tap "I have a setup code".</Text>
        </>
      ) : (
        <>
          <Field label="Setup code" value={code} onChangeText={t => setCode(t.toUpperCase())} placeholder="ABCD-EFGH" autoCapitalize="characters" autoCorrect={false}
            hint="From the office. It works once, for 7 days." />
          <PasswordField label="New password" value={newPw} onChangeText={setNewPw} autoComplete="new-password"
            hint={weak ?? (newPw ? 'Good.' : 'At least 8 characters, letters and numbers. Not your email.')} />
          <PasswordField label="New password again" value={again} onChangeText={setAgain} autoComplete="new-password"
            hint={again && again !== newPw ? 'Not the same as above.' : undefined} />
          <Toggle label="Keep me signed in on this phone (30 days)" value={remember} onChange={setRemember} />
          <Button label="Save my password and sign in" onPress={setUp} busy={busy === 'server'} disabled={(needServer && !url) || !email.trim() || code.trim().length < 8 || !newPw || !again} />
        </>
      )}
      {!demo && !SERVER ? (
        <>
          <View style={{ height: 1, backgroundColor: C.line, marginVertical: 12 }} />
          <Text style={st.small}>No server yet? Try the app with made-up jobs. Nothing you do in the demo is sent anywhere.</Text>
          <Button label="Try the demo as technician" kind="secondary" onPress={() => tryDemo('demo')} busy={busy === 'demo'} />
          <Button label="Try the demo as stock controller" kind="secondary" onPress={() => tryDemo('stock')} busy={busy === 'stock'} />
          <Button label="Try the demo as mechanic" kind="secondary" onPress={() => tryDemo('mech')} busy={busy === 'mech'} />
          <Button label="Try the demo as the office" kind="secondary" onPress={() => tryDemo('office')} busy={busy === 'office'} />
        </>
      ) : null}
      {!demo ? <Button label="Real Sandbox owner sign-in" kind="quiet" onPress={() => ownerView.set(true)} /> : null}
    </Screen>
  );
}
