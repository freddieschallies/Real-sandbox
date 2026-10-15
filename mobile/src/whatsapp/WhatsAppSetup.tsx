// Setting up WhatsApp, made for someone who has never done it: first a choice in plain words (our own
// phone, or an official WhatsApp Business number), then a few numbered steps, each ticked when done, and a
// test at the end. Used on the Start-up page and under Settings.
import React, { useEffect, useRef, useState } from 'react';
import { Image, Platform, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Label, Notice, Pill, Select, Toggle, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { metaSignup } from './metaSignup.ts';

export interface WaSetup {
  chosen: boolean; mode: 'phone' | 'official'; state: string; connected: boolean; wanted: boolean; running: boolean; qrSvg: string | null; linkRequestedAt: string | null;
  number: string | null; groups: { jid: string; name: string }[]; groupJid: string | null; groupName: string | null; poGroupJid: string | null; poGroupName: string | null;
  testSentAt: string | null; testOkAt: string | null; breakdownsFromChats: boolean;
  official: { available: boolean; appId: string | null; configId: string | null; name: string | null };
  steps: { key: string; done: boolean }[]; done: boolean;
}
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.'];
const plus = (n: string | null) => (n ? `+${n}` : '');

export function WhatsAppSetup({ changed }: { changed?: () => void }) {
  const s = useStore();
  const [d, setD] = useState<WaSetup | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [noTest, setNoTest] = useState(false);
  const was = useRef<boolean | null>(null);
  const load = async () => {
    const r = await s.ask({ method: 'GET', path: '/whatsapp/setup' });
    if (r?.status === 200) { const x = r.body as WaSetup; setD(x); if (was.current !== null && was.current !== x.done) changed?.(); was.current = x.done; } else if (r && r.status !== 403) setErr(reasons(r));
  };
  // Quick while a QR code is on the way or on screen; slower once it is set up.
  const fast = !!d && (['starting', 'waiting_for_scan'].includes(d.state) || (d.mode === 'official' && d.connected && !d.testOkAt) || (!!d.testSentAt && !d.testOkAt));
  useEffect(() => { load(); const t = setInterval(load, fast ? 2500 : 10_000); return () => clearInterval(t); }, [fast]);
  if (!d) return err ? <Notice tone="bad" title="WhatsApp" lines={err} /> : <Body quiet>Loading…</Body>;

  const act = async (method: 'POST' | 'PUT', path: string, json: object = {}) => {
    setBusy(true); setErr(null);
    const r = await s.ask({ method, path, json });
    setBusy(false);
    if (r?.status === 200) { const b = r.body as Partial<WaSetup>; if (b && Array.isArray(b.steps)) setD(b as WaSetup); else await load(); changed?.(); return true; }
    setErr(reasons(r)); return false;
  };
  const nothingYet = !d.connected && !d.wanted && d.state !== 'starting';

  // ---- The choice ----
  if (nothingYet && (choosing || !d.chosen)) {
    return <Choose d={d} busy={busy} err={err} pick={async m => { if (await act('POST', '/whatsapp/mode', { mode: m })) setChoosing(false); }} />;
  }

  const head = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{d.mode === 'phone' ? 'WhatsApp: our own phone' : 'WhatsApp: official business number'}</Text>
      {d.done ? <Pill text="Connected" tone="good" /> : d.connected ? <Pill text="Almost done" tone="info" /> : <Pill text="Not connected yet" tone="warn" />}
    </View>
  );
  const done = d.done ? (
    <Notice tone="good" title={d.mode === 'phone' ? `Connected as ${plus(d.number)} in "${d.groupName}"` : `Connected: ${d.official.name ?? 'your business'} on ${plus(d.number)}`}
      lines={[d.mode === 'phone' ? 'Breakdowns posted in the group come into the app by themselves. Every chat shows in the WhatsApp tab.' : 'Messages to the number come into the app (Breakdowns and the WhatsApp tab). Give the number to your stores.']} />
  ) : null;

  return (
    <Card>
      {head}
      {done}
      {err ? <Notice tone="bad" title="Not done" lines={err} /> : null}
      {d.mode === 'phone' ? <PhoneSteps d={d} busy={busy} act={act} noTest={noTest} setNoTest={setNoTest} /> : <OfficialSteps d={d} busy={busy} act={act} setErr={setErr} />}
      {d.connected || d.wanted ? (
        <Button label="Disconnect WhatsApp" kind="quiet" onPress={() => act('POST', '/whatsapp/disconnect')} />
      ) : <Button label="Choose the other way instead" kind="quiet" onPress={() => setChoosing(true)} />}
    </Card>
  );
}

function Choose({ d, busy, err, pick }: { d: WaSetup; busy: boolean; err: string[] | null; pick: (m: 'phone' | 'official') => void }) {
  const Way = ({ title, why, good, bad, label, onPress, disabled, tag }: { title: string; why: string; good: string[]; bad: string[]; label: string; onPress: () => void; disabled?: boolean; tag?: string }) => (
    <Card style={{ flexGrow: 1, flexBasis: 280, borderWidth: 2, borderColor: disabled ? C.line : C.accent, opacity: disabled ? 0.7 : 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.body, { fontWeight: '900', fontSize: 18, flex: 1 }]}>{title}</Text>
        {tag ? <Pill text={tag} tone="quiet" /> : null}
      </View>
      <Text style={st.body}>{why}</Text>
      {good.map(x => <Text key={x} style={[st.small, { color: C.good }]}>✓ {x}</Text>)}
      {bad.map(x => <Text key={x} style={[st.small, { color: C.warn }]}>• {x}</Text>)}
      <Button label={label} onPress={onPress} disabled={disabled || busy} />
    </Card>
  );
  return (
    <>
      <Text style={[st.body, { fontWeight: '800' }]}>How should the app get its WhatsApp number?</Text>
      <Text style={st.small}>Choose one. You can change later.</Text>
      {err ? <Notice tone="bad" title="Not done" lines={err} /> : null}
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Way title="Our own phone" why="Best if your breakdowns already come in a WhatsApp group. The app joins that group like WhatsApp Web."
          good={['Works in your existing groups', 'Free', 'Set up in 5 minutes: scan one code']}
          bad={['Needs a cheap phone and SIM, kept switched on', 'Not WhatsApp\'s official system: WhatsApp could block the number']}
          label="Use our own phone" onPress={() => pick('phone')} />
        <Way title="Official business number" why="No phone needed. Stores send breakdowns straight to your business number."
          good={['No phone to look after', 'WhatsApp\'s official system: no blocking', 'Can be a number you already have (even a landline)']}
          bad={['Cannot be in your existing groups', 'WhatsApp charges for messages your business starts (replies within 24 hours are free)']}
          label={d.official.available ? 'Use an official number' : 'Coming soon'} disabled={!d.official.available} tag={d.official.available ? undefined : 'Coming soon'} onPress={() => pick('official')} />
      </View>
    </>
  );
}

function Step({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children?: React.ReactNode }) {
  return (
    <View style={{ gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.line }} accessibilityLabel={`Step ${n}: ${title}${done ? ', done' : ''}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: done ? C.good : active ? C.accent : C.panel2 }}>
          <Text style={{ color: done || active ? '#FFFFFF' : C.text, fontWeight: '900' }}>{done ? '✓' : n}</Text>
        </View>
        <Text style={[st.body, { fontWeight: '800', flex: 1, color: done || active ? C.text : C.quiet }]}>{title}</Text>
      </View>
      {active ? <View style={{ gap: 8, paddingLeft: 38 }}>{children}</View> : null}
    </View>
  );
}

type Act = (method: 'POST' | 'PUT', path: string, json?: object) => Promise<boolean>;

function PhoneSteps({ d, busy, act, noTest, setNoTest }: { d: WaSetup; busy: boolean; act: Act; noTest: boolean; setNoTest: (v: boolean) => void }) {
  const demo = useStore().session?.mode === 'demo';
  const ready = d.connected || d.wanted;
  const step = !ready ? 1 : !d.connected ? 2 : !d.groupJid ? 3 : !d.testOkAt ? 4 : 0;
  const qrUri = d.qrSvg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(d.qrSvg)}` : null;
  const waiting = d.state === 'starting' && d.linkRequestedAt && Date.now() - new Date(d.linkRequestedAt).getTime() > 45_000;
  return (
    <>
      <Step n={1} title="Get the phone ready" done={ready} active={step === 1}>
        <Text style={st.body}>• A cheap Android phone with a new SIM (any network), used only for this.</Text>
        <Text style={st.body}>• Install WhatsApp on it and set it up with that SIM's number.</Text>
        <Text style={st.body}>• Add that number to your breakdowns WhatsApp group (from the phone of whoever runs the group).</Text>
        <Text style={st.body}>• Keep it charged and switched on, with Wi-Fi or data.</Text>
        <Button label="The phone is ready: show the code" busy={busy} onPress={() => act('POST', '/whatsapp/link')} />
      </Step>
      <Step n={2} title="Scan the code with that phone" done={d.connected} active={step === 2}>
        {d.state === 'waiting_for_scan' && qrUri ? (
          <>
            <Text style={st.body}>On that phone: open WhatsApp → tap ⋮ (top right) → <Text style={{ fontWeight: '800' }}>Linked devices</Text> → <Text style={{ fontWeight: '800' }}>Link a device</Text>, and point it at this code.</Text>
            {Platform.OS === 'web' ? <Image source={{ uri: qrUri }} style={{ width: 260, height: 260, backgroundColor: '#FFF', borderRadius: 8, alignSelf: 'center' }} accessibilityLabel="QR code to link the WhatsApp number" />
              : <Notice tone="info" title="Open this on a computer" lines={['The code must be on another screen than the phone that scans it.']} />}
            <Text style={st.small}>The code changes every few seconds by itself; that is normal.</Text>
            {demo ? <Text style={[st.small, { color: C.info }]}>In the test drive the code is not real: it links by itself in a few seconds.</Text> : null}
          </>
        ) : d.state === 'qr_expired' ? (
          <>
            <Notice tone="warn" title="The code timed out" lines={['Nobody scanned it for a few minutes. Get the phone ready, then:']} />
            <Button label="Show a new code" busy={busy} onPress={() => act('POST', '/whatsapp/link')} />
          </>
        ) : waiting || (!d.running && d.state !== 'starting') ? (
          <>
            <Notice tone="bad" title="The WhatsApp link is not answering" lines={['The server part that shows the code is not running. Ask Real Sandbox support to switch it on, then:']} />
            <Button label="Try again" busy={busy} onPress={() => act('POST', '/whatsapp/link')} />
          </>
        ) : <Text style={st.body}>Getting the code ready… (a few seconds)</Text>}
      </Step>
      <Step n={3} title="Choose the breakdowns group" done={!!d.groupJid && d.connected} active={step === 3}>
        {d.groups.length ? (
          <Select label="The breakdowns group" value={d.groupJid} placeholder="Choose the group" options={d.groups.map(g => ({ value: g.jid, label: g.name }))}
            onChange={jid => act('PUT', '/breakdowns/whatsapp/group', { jid })} />
        ) : <Notice tone="info" title="The number is in no group yet" lines={['Add it to the breakdowns group from the phone of whoever runs the group. It shows here by itself within a minute.']} />}
      </Step>
      <Step n={4} title="Send a test" done={!!d.testOkAt} active={step === 4}>
        {!d.testSentAt ? <Button label={`Send a test to "${d.groupName ?? 'the group'}"`} busy={busy} onPress={() => act('POST', '/whatsapp/test')} /> : (
          <>
            <Text style={st.body}>Look in "{d.groupName}": did "✅ Real Sandbox is connected…" arrive?</Text>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Button label="Yes, it is there" busy={busy} onPress={() => act('POST', '/whatsapp/test/ok')} style={{ flexGrow: 1 }} />
              <Button label="No" kind="secondary" onPress={() => setNoTest(true)} style={{ flexGrow: 1 }} />
            </View>
            {noTest ? <Notice tone="warn" title="Give it a minute" lines={['It is sent within a few seconds when the phone has signal. Check the phone is on, with Wi-Fi or data, then send the test again.']} /> : null}
            {noTest ? <Button label="Send the test again" kind="secondary" busy={busy} onPress={() => { setNoTest(false); act('POST', '/whatsapp/test'); }} /> : null}
          </>
        )}
      </Step>
      {d.connected && d.groups.length && d.groupJid ? (
        <View style={{ gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.line }}>
          <Label>Also (if you want)</Label>
          {d.groupJid ? <Select label="Change the breakdowns group" value={d.groupJid} options={d.groups.map(g => ({ value: g.jid, label: g.name }))} onChange={jid => act('PUT', '/breakdowns/whatsapp/group', { jid })} /> : null}
          <Select label="A purchase orders group" value={d.poGroupJid} placeholder="None" options={[{ value: '', label: 'None' }, ...d.groups.filter(g => g.jid !== d.groupJid).map(g => ({ value: g.jid, label: g.name }))]}
            onChange={v => act('PUT', '/breakdowns/whatsapp/group', { kind: 'pos', jid: v || null })} />
          <Text style={st.small}>A PO made outside the app (in Pastel) and posted in that group is added by itself, on its job.</Text>
        </View>
      ) : null}
    </>
  );
}

function OfficialSteps({ d, busy, act, setErr }: { d: WaSetup; busy: boolean; act: Act; setErr: (e: string[] | null) => void }) {
  const s = useStore();
  const [opening, setOpening] = useState(false);
  const step = !d.connected ? 1 : !d.testOkAt ? 2 : 0;
  const connect = async () => {
    setErr(null); setOpening(true);
    try {
      const demo = s.session?.mode === 'demo';
      const got = demo ? { code: 'demo-code-1234', phoneNumberId: '1000000001', wabaId: '2000000002' } : await metaSignup(d.official.appId!, d.official.configId!);
      await act('POST', '/whatsapp/official', got);
    } catch (e) { setErr([(e as Error).message]); }
    setOpening(false);
  };
  return (
    <>
      <Step n={1} title="Connect your number" done={d.connected} active={step === 1}>
        <Text style={st.body}>Have ready:</Text>
        <Text style={st.body}>• A phone number that is not on WhatsApp yet: a new SIM, or your office landline (WhatsApp can phone it with the code).</Text>
        <Text style={st.body}>• Your company's Facebook login (or make one in the window).</Text>
        <Text style={st.body}>Then tap the button: WhatsApp's own window opens. Choose your business, add the number, and type the code WhatsApp sends.</Text>
        {Platform.OS === 'web' ? <Button label="Connect with WhatsApp" busy={busy || opening} onPress={connect} /> : <Notice tone="info" title="Open this on a computer" lines={['WhatsApp\'s sign-up window opens in a web browser.']} />}
        {s.session?.mode === 'demo' ? <Text style={st.small}>In the test drive, WhatsApp's window is pretended.</Text> : null}
      </Step>
      <Step n={2} title="Send it a message" done={!!d.testOkAt} active={step === 2}>
        <Text style={st.body}>From your own phone, send "Hi" on WhatsApp to <Text style={{ fontWeight: '800' }}>{plus(d.number)}</Text>. This ticks itself when it arrives.</Text>
        <Text style={st.small}>Waiting for it…</Text>
      </Step>
      {d.connected ? (
        <View style={{ gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.line }}>
          <Toggle label="Messages to this number come into Breakdowns" value={d.breakdownsFromChats} onChange={v => act('PUT', '/whatsapp/settings', { breakdownsFromChats: v })} />
          <Text style={st.small}>Give the number to your stores and call centres. The office reads and replies in the WhatsApp tab. WhatsApp only allows a reply within 24 hours of their last message.</Text>
        </View>
      ) : null}
    </>
  );
}
