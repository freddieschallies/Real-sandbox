// Change my own password: only the admin and the CEO, under Settings. Everyone else asks them for a
// new setup code. Every other phone signed in as me is signed out; this one stays in.
import React, { useState } from 'react';
import { View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Heading, Notice } from '../ui.tsx';
import { PasswordField, passwordProblem } from './Login.tsx';

/** Settings → My password (admin and CEO). */
export function MyPasswordSettings() {
  return (
    <Card>
      <Heading>My password</Heading>
      <Body quiet>Technicians and the rest of the team do not change passwords themselves: under People, open the person, then Login → Reset password (a new setup code to send them).</Body>
      <ChangePassword />
    </Card>
  );
}

export function ChangePassword() {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  if (!s.session) return null;
  if (!open) return <>{msg?.tone === 'good' ? <Notice tone="good" title={msg.text} /> : null}<Button label="Change my password" kind="quiet" onPress={() => { setOpen(true); setMsg(null); }} /></>;
  const weak = pw ? passwordProblem(pw, '') : null;
  const save = async () => {
    if (weak) { setMsg({ tone: 'bad', text: weak }); return; }
    if (pw !== again) { setMsg({ tone: 'bad', text: 'The two new passwords are not the same.' }); return; }
    setBusy(true);
    const r = await s.ask({ method: 'POST', path: '/me/password', json: { current, password: pw } });
    setBusy(false);
    if (r?.status === 200) {
      await s.replaceToken((r.body as { token: string }).token);
      setCurrent(''); setPw(''); setAgain(''); setOpen(false);
      setMsg({ tone: 'good', text: 'Password changed. Any other phone signed in as you is signed out.' });
    } else setMsg({ tone: 'bad', text: (r?.body as { reasons?: string[] })?.reasons?.[0] ?? 'Needs signal: try again.' });
  };
  return (
    <Card>
      <Heading>Change my password</Heading>
      <PasswordField label="Current password" value={current} onChangeText={setCurrent} autoComplete="current-password" />
      <PasswordField label="New password" value={pw} onChangeText={setPw} autoComplete="new-password" hint={weak ?? 'At least 8 characters, letters and numbers. Not your email.'} />
      <PasswordField label="New password again" value={again} onChangeText={setAgain} autoComplete="new-password" hint={again && again !== pw ? 'Not the same as above.' : undefined} />
      {msg ? <Notice tone={msg.tone} title={msg.text} /> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Cancel" kind="quiet" onPress={() => setOpen(false)} style={{ flex: 1 }} />
        <Button label="Change it" onPress={save} busy={busy} disabled={!current || !pw || !again} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}
