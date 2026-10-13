// HR and the CEO: add a person, and look after each person's own login. The office gives a one-time
// setup code (to send by WhatsApp); the person chooses their own password with it, so nobody in the
// office ever knows it. A new code when they forget it; sign them out of every phone when one is
// lost; stop the login when they must not get in.
import React, { useEffect, useState } from 'react';
import { Linking, Platform, Share, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Field, Heading, Label, Notice, Pill, Select, st } from '../ui.tsx';
import { C } from '../theme.ts';

export interface LoginInfo {
  email: string | null; state: 'on' | 'code' | 'stopped' | 'none'; hasPassword: boolean; passwordSetAt: string | null; lastSignIn: string | null;
  locked: boolean; lockedUntil: string | null; codeWaiting: { issued_at: string; expires_at: string; issued_by: string } | null; left: boolean;
  canManage: boolean; mine: boolean; codeDays: number; history: { at: string; change: string; by: string }[];
}
interface NewCode { code: string; expiresAt: string; email: string; message: string }

const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['Needs signal: try again.'];
const day = (iso: string) => new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** The People list's word for someone's login, or null when it is simply on. */
export const LOGIN_PILL: Record<string, { text: string; tone: 'quiet' | 'info' | 'bad' } | null> = {
  on: null, none: { text: 'No login yet', tone: 'quiet' }, code: { text: 'Setup code sent', tone: 'info' }, stopped: { text: 'Login stopped', tone: 'bad' }, locked: { text: 'Locked', tone: 'bad' },
};

/** South African cell number to WhatsApp's international form: 072 555 0106 → 27725550106. */
export function waNumber(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('0')) return `27${d.slice(1)}`;
  if (d.length === 11 && d.startsWith('27')) return d;
  return null;
}

export function AddPerson({ positions, trades, done }: { positions: { level: string; label: string }[]; trades: { key: string; label: string }[]; done: (id: string | null) => void }) {
  const s = useStore();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [position, setPosition] = useState<string | null>(positions.find(p => p.level === 'technician')?.level ?? positions[0]?.level ?? null);
  const [trade, setTrade] = useState<string | null>(null);
  const [dept, setDept] = useState<string | null>(null);
  const [depts, setDepts] = useState<{ id: string; name: string; active?: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  useEffect(() => { s.ask({ method: 'GET', path: '/departments' }).then(r => { if (r?.status === 200) setDepts(((r.body as { departments: { id: string; name: string; active?: boolean }[] }).departments ?? []).filter(d => d.active !== false)); }).catch(() => undefined); }, []);
  const save = async () => {
    if (name.trim().split(/\s+/).length < 2) { setErr(['Their name and surname.']); return; }
    if (!position) { setErr(['Their position.']); return; }
    setBusy(true); setErr(null);
    const r = await s.ask({ method: 'POST', path: '/people', json: {
      fullName: name.trim(), position, ...(email.trim() ? { email: email.trim() } : {}), ...(phone.trim() ? { phone: phone.trim() } : {}),
      ...(position === 'technician' && trade ? { trade } : {}), ...(dept ? { departmentId: dept } : {}),
    } });
    setBusy(false);
    if (r && r.status < 300) done((r.body as { id: string }).id); else setErr(reasons(r));
  };
  return (
    <>
      <Heading>Add a person</Heading>
      <Body quiet>Then give them a setup code under Login: they choose their own password with it.</Body>
      <Field label="Name and surname" value={name} onChangeText={setName} autoCapitalize="words" />
      <Field label="Email (what they sign in with)" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
        hint="Their own email. Without one they cannot get a login yet." />
      <Field label="Cell number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" hint="To send the setup code by WhatsApp." />
      <Select label="Position" value={position} options={positions.map(p => ({ value: p.level, label: p.label }))} onChange={setPosition} />
      {position === 'technician' ? <Select label="Trade" value={trade} placeholder="Not set" options={trades.map(t => ({ value: t.key, label: t.label }))} onChange={setTrade} /> : null}
      {depts.length ? <Select label="Department" value={dept} placeholder="Not yet" options={depts.map(d => ({ value: d.id, label: d.name }))} onChange={setDept} /> : null}
      {err ? <Notice tone="bad" title="Not added" lines={err} /> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Cancel" kind="quiet" onPress={() => done(null)} style={{ flex: 1 }} />
        <Button label="Add" onPress={save} busy={busy} style={{ flex: 1 }} />
      </View>
    </>
  );
}

/** One person's login, on their profile. Only HR and the CEO see it. */
export function LoginCard({ userId, name, phone, changed }: { userId: string; name: string; phone?: string | null; changed?: () => void }) {
  const s = useStore();
  const first = name.split(' ')[0];
  const [info, setInfo] = useState<LoginInfo | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const [code, setCode] = useState<NewCode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'stop' | 'signout' | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const load = () => s.ask({ method: 'GET', path: `/people/${userId}/login` }).then(r => { if (r?.status === 200) setInfo(r.body as LoginInfo); else setErr(reasons(r)); }).catch(() => setErr(['Needs signal.']));
  useEffect(() => { setInfo(null); setCode(null); setDone(null); load(); }, [userId]);
  const act = async (what: 'code' | 'stop' | 'allow' | 'sign-out', label: string) => {
    setBusy(what); setErr(null); setDone(null);
    const r = await s.ask({ method: 'POST', path: `/people/${userId}/login/${what}`, json: {} });
    setBusy(null); setConfirm(null);
    if (r && r.status < 300) {
      if (what === 'code') setCode(r.body as NewCode); else { setCode(null); setDone(label); }
      load(); changed?.();
    } else setErr(reasons(r));
  };
  if (!info) return <><Heading>Login</Heading>{err ? <Notice tone="bad" title="Could not load" lines={err} /> : <Body quiet>Loading…</Body>}</>;
  // The test drive never opens a real person's chat: the code only works in this browser.
  const demo = s.session?.mode === 'demo';
  const wa = demo ? null : waNumber(phone);
  const share = async () => {
    if (!code) return;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(code.message); setDone('Copied: paste it in a message to him.'); return; }
      await Share.share({ message: code.message });
    } catch { setDone('Could not copy: write the code down instead.'); }
  };
  const state = info.locked ? { text: 'Locked: too many wrong passwords', tone: 'bad' as const }
    : info.state === 'on' ? { text: 'Signs in with own password', tone: 'good' as const }
    : info.state === 'code' ? { text: 'Setup code waiting', tone: 'info' as const }
    : info.state === 'stopped' ? { text: 'Login stopped', tone: 'bad' as const } : { text: 'No login yet', tone: 'quiet' as const };
  return (
    <>
      <Heading>Login</Heading>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{info.email ?? 'No email yet'}</Text>
          <Pill text={state.text} tone={state.tone} />
        </View>
        <Text style={st.small}>
          {info.lastSignIn ? `Last signed in ${day(info.lastSignIn)}` : 'Never signed in'}
          {info.passwordSetAt && info.hasPassword ? ` · password chosen ${day(info.passwordSetAt)}` : ''}
          {info.locked && info.lockedUntil ? ` · locked until ${day(info.lockedUntil)}` : ''}
        </Text>
        {info.codeWaiting && !code ? <Text style={st.small}>Setup code given by {info.codeWaiting.issued_by} on {day(info.codeWaiting.issued_at)}, works until {day(info.codeWaiting.expires_at)}. It is shown only once: give a new one if it was lost.</Text> : null}
        {!info.email && info.canManage ? <Notice tone="warn" title={`${first} needs an email first`} lines={['It is what he signs in with: add it under the contact details above.']} /> : null}
        {info.mine ? <Text style={st.small}>Your own: change your password at the bottom of the menu.</Text> : null}
        {!info.canManage && !info.mine && !info.left ? <Text style={st.small}>Only the CEO looks after this person's login.</Text> : null}
      </Card>

      {code ? (
        <Card style={{ borderColor: C.accent, borderWidth: 2 }}>
          <Label>Setup code for {first}</Label>
          <Text selectable style={{ color: C.text, fontSize: 34, fontWeight: '800', letterSpacing: 3 }} accessibilityLabel={`Setup code ${code.code}`}>{code.code}</Text>
          <Text style={st.small}>With his email {code.email}. Works once, until {day(code.expiresAt)}. Shown only now: the app keeps only a scrambled copy, so nobody can read it back.</Text>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button label={wa ? `WhatsApp ${first}` : 'WhatsApp'} onPress={() => Linking.openURL(`https://wa.me/${wa ?? ''}?text=${encodeURIComponent(code.message)}`).catch(() => setDone('WhatsApp did not open: copy the message instead.'))} style={{ flexGrow: 1 }} />
            <Button label={Platform.OS === 'web' ? 'Copy the message' : 'Share…'} kind="secondary" onPress={share} style={{ flexGrow: 1 }} />
          </View>
          <Text selectable style={[st.small, { color: C.text }]}>{code.message}</Text>
          {demo ? <Text style={st.small}>Test drive: don't send it to anyone. Use it yourself: Back to the test guide → "Sign in with your own login" → "I have a setup code".</Text> : null}
        </Card>
      ) : null}
      {done ? <Notice tone="good" title={done} /> : null}
      {err ? <Notice tone="bad" title="Not done" lines={err} /> : null}

      {info.canManage ? (
        <View style={{ gap: 8 }}>
          {info.email ? (
            <Button label={info.hasPassword ? `Reset ${first}'s password (new setup code${info.locked ? ', also unlocks it' : ''})` : info.state === 'code' ? 'Give a new setup code' : `Give ${first} a setup code`}
              kind={info.hasPassword ? 'secondary' : 'primary'} busy={busy === 'code'} onPress={() => act('code', '')} />
          ) : null}
          {info.state === 'stopped' && info.hasPassword ? <Button label="Allow the login again" kind="secondary" busy={busy === 'allow'} onPress={() => act('allow', `${first} can sign in again with his own password.`)} /> : null}
          {info.state === 'on' ? (
            confirm === 'signout' ? (
              <Card>
                <Body>Sign {first} out on every phone and computer? His password stays the same; he signs in again with it. For a lost or changed phone.</Body>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Button label="Cancel" kind="quiet" onPress={() => setConfirm(null)} style={{ flex: 1 }} />
                  <Button label="Sign him out" busy={busy === 'sign-out'} onPress={() => act('sign-out', `${first} is signed out everywhere.`)} style={{ flex: 1 }} />
                </View>
              </Card>
            ) : <Button label="Sign out of every phone (lost phone)" kind="quiet" onPress={() => setConfirm('signout')} />
          ) : null}
          {info.state === 'on' || info.state === 'code' ? (
            confirm === 'stop' ? (
              <Card>
                <Body>Stop {first}'s login? He is signed out at once and cannot sign in until it is allowed again. His work and records stay.</Body>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Button label="Cancel" kind="quiet" onPress={() => setConfirm(null)} style={{ flex: 1 }} />
                  <Button label="Stop the login" busy={busy === 'stop'} onPress={() => act('stop', `${first}'s login is stopped.`)} style={{ flex: 1 }} />
                </View>
              </Card>
            ) : <Button label="Stop the login" kind="quiet" onPress={() => setConfirm('stop')} />
          ) : null}
        </View>
      ) : null}

      {info.history.length ? (
        <Card>
          <Label>Login log</Label>
          {info.history.map((h, i) => <Text key={i} style={st.small}>{day(h.at)} · {h.change}{h.by !== name ? ` (${h.by})` : ''}</Text>)}
        </Card>
      ) : null}
    </>
  );
}
