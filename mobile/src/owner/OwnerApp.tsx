// The Real Sandbox owner's dashboard: every company using the app, how each is getting on (counts
// and yes/no only, never their customers, jobs, prices or people's details), adding a company,
// suspending one, a new setup code for a CEO who is locked out, and opening a company as tech
// support, only while that company's CEO allows it.
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Linking, Platform, Pressable, ScrollView, Share, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Field, Heading, Label, Notice, Pill, st } from '../ui.tsx';
import { PasswordField } from '../screens/Login.tsx';
import { C, S } from '../theme.ts';

// Whether the owner's screens are open instead of the sign-in, and the owner's own sign-in (kept in
// memory only: closing the app signs the owner out).
let open = false;
let owner: { token: string; name: string; until: number } | null = null;
const subs = new Set<() => void>();
export const ownerView = { set(v: boolean) { open = v; subs.forEach(f => f()); } };
export const useOwnerOpen = () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => open);

interface Company {
  id: string; name: string; active: boolean; created_at: string; suspended_at: string | null; suspended_reason: string | null;
  people: number; activeWeek: number; jobsMonth: number; lastActivity: string | null; setup: { done: number; total: number };
  whatsapp: { mode: string; connected: boolean } | null; pastel: boolean;
  ceo: { id: string; name: string; email: string; login: string; lastLogin: string | null } | null;
  support: { until: string; grantedBy: string; reason: string | null; enteredAt: string | null } | null;
}
interface Code { code: string; email: string; name: string; company: string; expiresAt: string; message: string }

const reasons = (r: { status: number; body: any }) => (r.body?.reasons?.length ? r.body.reasons : [r.body?.error ?? `The server said ${r.status}`]) as string[];
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Johannesburg' });
function ago(iso: string | null) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
/** Until when, said simply: "until 14:30" today, otherwise with the day. */
const until = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? `until ${time(iso)}` : `until ${day(iso)} ${time(iso)}`);

export function OwnerApp({ mode, baseUrl, back }: { mode: 'demo' | 'server'; baseUrl: string; back: () => void }) {
  const s = useStore();
  const ins = useSafeAreaInsets();
  const [server, setServer] = useState(baseUrl);
  const url = server.trim().replace(/\/+$/, '');
  const [me, setMe] = useState(() => (owner && owner.until > Date.now() ? owner : null));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const [data, setData] = useState<{ owner: string; companies: Company[]; demo?: boolean } | null>(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);

  const call = (method: 'GET' | 'POST' | 'PATCH', path: string, json?: object, token = me?.token) => s.platform(mode, url, { method, path, json }, token);
  const signOut = () => { owner = null; setMe(null); setData(null); back(); };
  const load = async (token = me?.token) => {
    if (!token) return;
    const r = await call('GET', '/platform/dashboard', undefined, token);
    if (r.status === 401) { owner = null; setMe(null); setErr(['Signed out: sign in again.']); return; }
    if (r.status !== 200) { setErr(reasons(r)); return; }
    setErr(null); setData(r.body);
  };
  const signIn = async (e = email.trim(), p = password) => {
    setBusy('signin'); setErr(null);
    const r = await call('POST', '/platform/login', { email: e, password: p }, undefined);
    setBusy(null);
    if (r.status !== 200) { setErr(r.status === 401 ? ['Wrong email or password.'] : reasons(r)); return; }
    owner = { token: r.body.token, name: r.body.name, until: Date.now() + 8 * 3_600_000 };
    setMe(owner); setPassword('');
    await load(owner.token);
  };
  // The test drive opens straight away: there is no owner password in it.
  useEffect(() => { if (me) load(); else if (mode === 'demo') signIn('owner@demo', 'demo'); }, []);
  useEffect(() => { if (!me) return; const t = setInterval(() => load(), 60_000); return () => clearInterval(t); }, [me?.token]);

  const header = (
    <View style={{ backgroundColor: '#0E1A2B', paddingTop: ins.top, borderBottomWidth: 4, borderBottomColor: C.accent }}>
      <View style={{ paddingHorizontal: S.pad, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <View style={{ flex: 1, minWidth: 180 }}>
          <Text style={{ color: '#EAF1FB', fontSize: 22, fontWeight: '800' }}>Real Sandbox · Owner</Text>
          <Text style={{ color: '#EAF1FB', opacity: 0.75 }}>{me ? `${me.name} · every company using the app` : 'Sign in to see the companies using the app'}</Text>
        </View>
        {me ? <Pressable onPress={() => load()} accessibilityRole="button" hitSlop={8} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#EAF1FB' }}>
          <Text style={{ color: '#EAF1FB', fontWeight: '700' }}>Refresh</Text></Pressable> : null}
        <Pressable onPress={me ? signOut : back} accessibilityRole="button" hitSlop={8}><Text style={{ color: '#EAF1FB' }}>{me ? 'Sign out' : 'Back'}</Text></Pressable>
      </View>
    </View>
  );

  if (!me) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {header}
        <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, maxWidth: 520, width: '100%', alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
          <Text style={{ color: C.accent, fontSize: 28, fontWeight: '800' }}>Owner sign-in</Text>
          <Body quiet>For Real Sandbox only: your own owner login, not a company's. You see each company as numbers; you open a company only when its CEO lets support in.</Body>
          {err ? <Notice tone="bad" title="Could not sign in" lines={err} /> : null}
          {mode === 'demo' ? <Body quiet>Opening the test drive's dashboard…</Body> : (
            <>
              {!baseUrl ? <Field label="Server address" value={server} onChangeText={setServer} placeholder="https://jobs.realsandbox.co.za" autoCapitalize="none" autoCorrect={false} keyboardType="url" /> : null}
              <Field label="Owner email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" />
              <PasswordField label="Password" value={password} onChangeText={setPassword} autoComplete="current-password" />
              <Button label="Sign in" onPress={() => signIn()} busy={busy === 'signin'} disabled={!url || !email.trim() || !password} />
              <Text style={st.small}>Signed out after 8 hours, and when the app is closed.</Text>
            </>
          )}
          <Button label="Back to the sign-in" kind="quiet" onPress={back} />
        </ScrollView>
      </View>
    );
  }

  const all = data?.companies ?? [];
  const shown = q.trim() ? all.filter(c => c.name.toLowerCase().includes(q.trim().toLowerCase())) : all;
  const active = all.filter(c => c.active);
  const sum = (f: (c: Company) => number) => active.reduce((n, c) => n + f(c), 0);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {header}
      <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 60, maxWidth: 1280, width: '100%', alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
        {data?.demo ? <Notice tone="info" title="Test drive" lines={["Your test-drive company is real to the test drive; the other companies are made up to show how the dashboard looks with several.",
          'To try support: open as the CEO, Settings → Real Sandbox support → "Let support in", then come back here and tap "Open as support".']} /> : null}
        {err ? <Notice tone="bad" title="Could not load" lines={err} /> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: S.gap }}>
          <Tile label="Companies" value={String(active.length)} sub={all.length > active.length ? `${all.length - active.length} suspended` : 'all active'} />
          <Tile label="People on the app" value={String(sum(c => c.people))} sub={`${sum(c => c.activeWeek)} signed in this week`} />
          <Tile label="Jobs this month" value={String(sum(c => c.jobsMonth))} sub="all companies" />
          <Tile label="Support open now" value={String(all.filter(c => c.support).length)} sub="CEOs who let you in" tone={all.some(c => c.support) ? 'good' : 'quiet'} />
        </View>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {all.length > 4 ? <View style={{ flexGrow: 1, flexBasis: 240 }}><Field label="Find a company" value={q} onChangeText={setQ} autoCorrect={false} /></View> : <View style={{ flex: 1 }} />}
          <Button label={adding ? 'Close' : '+ Add a company'} kind={adding ? 'quiet' : 'primary'} onPress={() => setAdding(a => !a)} />
        </View>
        {adding ? <AddCompany call={call} demo={!!data?.demo} done={() => load()} /> : null}
        {!data ? <Body quiet>Loading…</Body> : !shown.length ? <Body quiet>{q ? 'No company by that name.' : 'No companies yet: add the first one.'}</Body> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: S.gap }}>
          {shown.map(c => <CompanyCard key={c.id} c={c} call={call} demo={!!data?.demo} changed={() => load()}
            enter={async () => {
              const r = await call('POST', `/platform/companies/${c.id}/enter`);
              if (r.status !== 200) return reasons(r);
              ownerView.set(false);
              await s.signInWith(mode, url, r.body);
              return null;
            }} />)}
        </View>
        <Text style={st.small}>Numbers only: you never see a company's customers, jobs, prices or people's details here. Opening a company needs its CEO to let support in (Settings → Real Sandbox support) and ends when they say, or when the time they chose runs out. Everything support does is in their history as "Support: {me.name.split(' ')[0]}".</Text>
      </ScrollView>
    </View>
  );
}

function Tile({ label, value, sub, tone = 'quiet' }: { label: string; value: string; sub?: string; tone?: 'quiet' | 'good' }) {
  return (
    <Card style={{ flexGrow: 1, flexBasis: 160, borderColor: tone === 'good' ? C.good : C.line, borderWidth: tone === 'good' ? 2 : 1 }}>
      <Label>{label}</Label>
      <Text style={{ color: C.text, fontSize: 30, fontWeight: '800' }}>{value}</Text>
      {sub ? <Text style={st.small}>{sub}</Text> : null}
    </Card>
  );
}

type Call = (method: 'GET' | 'POST' | 'PATCH', path: string, json?: object) => Promise<{ status: number; body: any }>;

function CompanyCard({ c, call, demo, changed, enter }: { c: Company; call: Call; demo: boolean; changed: () => void; enter: () => Promise<string[] | null> }) {
  const { width } = useWindowDimensions();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const [code, setCode] = useState<Code | null>(null);
  const [suspending, setSuspending] = useState(false);
  const [why, setWhy] = useState('');
  const run = async (k: string, fn: () => Promise<string[] | null>) => { setBusy(k); setErr(null); const e = await fn(); setBusy(null); if (e) setErr(e); };
  const pct = c.setup.total ? Math.round((c.setup.done / c.setup.total) * 100) : 0;
  const quiet = c.lastActivity && Date.now() - Date.parse(c.lastActivity) > 7 * 86_400_000;
  const loginText = !c.ceo ? null : c.ceo.login === 'locked' ? { t: 'Locked out', tone: 'bad' as const } : c.ceo.login === 'none' ? { t: 'No login yet', tone: 'warn' as const }
    : c.ceo.login === 'code' ? { t: 'Setup code waiting', tone: 'info' as const } : { t: 'Signs in', tone: 'good' as const };
  return (
    <Card style={{ flexGrow: 1, flexBasis: width >= 900 ? 380 : 300, maxWidth: width >= 900 ? 620 : undefined, gap: 10, borderColor: c.support ? C.good : !c.active ? C.bad : C.line, borderWidth: c.support || !c.active ? 2 : 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontSize: 20, fontWeight: '800', flex: 1, minWidth: 160 }}>{c.name}</Text>
        {!c.active ? <Pill text="Suspended" tone="bad" /> : quiet ? <Pill text="Quiet for a week" tone="warn" /> : <Pill text="Active" tone="good" />}
      </View>
      {!c.active && c.suspended_reason ? <Text style={st.small}>Suspended {c.suspended_at ? day(c.suspended_at) : ''}: {c.suspended_reason}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
        <Stat label="People" value={`${c.people}`} sub={`${c.activeWeek} this week`} />
        <Stat label="Jobs this month" value={`${c.jobsMonth}`} />
        <Stat label="Last activity" value={ago(c.lastActivity)} />
        <Stat label="Using since" value={day(c.created_at)} />
      </View>
      <View style={{ gap: 4 }}>
        <Text style={st.small}>Start-up: {c.setup.done} of {c.setup.total} done</Text>
        <View style={{ height: 8, borderRadius: 4, backgroundColor: C.panel2, overflow: 'hidden' }}><View style={{ width: `${pct}%`, height: 8, backgroundColor: pct === 100 ? C.good : C.accent }} /></View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Pill text={c.whatsapp?.connected ? `WhatsApp: ${c.whatsapp.mode === 'official' ? 'official number' : 'own phone'}` : c.whatsapp ? 'WhatsApp: not connected' : 'WhatsApp: not set up'} tone={c.whatsapp?.connected ? 'good' : 'quiet'} />
        <Pill text={c.pastel ? 'Pastel: set up' : 'Pastel: not yet'} tone={c.pastel ? 'good' : 'quiet'} />
      </View>
      {c.ceo ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={[st.body, { flex: 1, minWidth: 180 }]}>CEO: <Text style={{ fontWeight: '800' }}>{c.ceo.name}</Text>{c.ceo.email ? ` · ${c.ceo.email}` : ''}</Text>
          {loginText ? <Pill text={loginText.t} tone={loginText.tone} /> : null}
        </View>
      ) : <Text style={st.small}>No CEO login.</Text>}

      {c.support ? (
        <Notice tone="good" title={`Support allowed ${until(c.support.until)}`} lines={[`By ${c.support.grantedBy}${c.support.reason ? `: "${c.support.reason}"` : ''}.`,
          c.support.enteredAt ? `You opened it at ${time(c.support.enteredAt)}.` : 'Not opened yet.']} />
      ) : <Text style={st.small}>Support: not allowed now. When the CEO needs help, they tap Settings → Real Sandbox support → "Let support in".</Text>}

      {err ? <Notice tone="bad" title="Could not do that" lines={err} /> : null}
      {code ? <CodeCard code={code} demo={demo} close={() => setCode(null)} /> : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {c.support && c.active ? <Button label="Open as support" onPress={() => run('enter', enter)} busy={busy === 'enter'} style={{ flexGrow: 1 }} /> : null}
        {c.active && c.ceo ? <Button label="New CEO setup code" kind="secondary" busy={busy === 'code'} style={{ flexGrow: 1 }}
          onPress={() => run('code', async () => { const r = await call('POST', `/platform/companies/${c.id}/ceo-code`); if (r.status !== 200) return reasons(r); setCode(r.body); changed(); return null; })} /> : null}
        {c.active ? <Button label={suspending ? 'Keep it active' : 'Suspend…'} kind="quiet" onPress={() => { setSuspending(x => !x); setWhy(''); }} />
          : <Button label="Reactivate" kind="secondary" busy={busy === 'on'} onPress={() => run('on', async () => { const r = await call('PATCH', `/platform/companies/${c.id}`, { active: true }); if (r.status !== 200) return reasons(r); changed(); return null; })} />}
      </View>
      {suspending && c.active ? (
        <View style={{ gap: 8 }}>
          <Field label="Why (the company sees this)" value={why} onChangeText={setWhy} placeholder="e.g. Account overdue" />
          <Text style={st.small}>Nobody in {c.name} can sign in or sync while it is suspended. Nothing is deleted; reactivate it any time.</Text>
          <Button label={`Suspend ${c.name}`} kind="danger" disabled={!why.trim()} busy={busy === 'off'}
            onPress={() => run('off', async () => { const r = await call('PATCH', `/platform/companies/${c.id}`, { active: false, reason: why.trim() }); if (r.status !== 200) return reasons(r); setSuspending(false); changed(); return null; })} />
        </View>
      ) : null}
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={{ minWidth: 110 }}>
      <Text style={st.small}>{label}</Text>
      <Text style={{ color: C.text, fontSize: 17, fontWeight: '800' }}>{value}</Text>
      {sub ? <Text style={st.small}>{sub}</Text> : null}
    </View>
  );
}

function CodeCard({ code, demo, close }: { code: Code; demo: boolean; close: () => void }) {
  const [done, setDone] = useState<string | null>(null);
  const first = code.name.split(' ')[0];
  const share = async () => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(code.message); setDone(`Copied: paste it in a message to ${first}.`); return; }
      await Share.share({ message: code.message });
    } catch { setDone('Could not copy: write the code down instead.'); }
  };
  return (
    <Card style={{ borderColor: C.accent, borderWidth: 2 }}>
      <Label>Setup code for {code.name}</Label>
      <Text selectable style={{ color: C.text, fontSize: 32, fontWeight: '800', letterSpacing: 3 }} accessibilityLabel={`Setup code ${code.code}`}>{code.code}</Text>
      <Text style={st.small}>With the email {code.email}. Works once, until {day(code.expiresAt)}. {first} chooses a new password with it; the old one stops working. Shown only now.</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {!demo ? <Button label="WhatsApp" onPress={() => Linking.openURL(`https://wa.me/?text=${encodeURIComponent(code.message)}`).catch(() => setDone('WhatsApp did not open: copy the message instead.'))} style={{ flexGrow: 1 }} /> : null}
        <Button label={Platform.OS === 'web' ? 'Copy the message' : 'Share…'} kind="secondary" onPress={share} style={{ flexGrow: 1 }} />
        <Button label="Done" kind="quiet" onPress={close} />
      </View>
      <Text selectable style={[st.small, { color: C.text }]}>{code.message}</Text>
      {done ? <Text style={[st.small, { color: C.good }]}>{done}</Text> : null}
      {demo ? <Text style={st.small}>Test drive: don't send it to anyone. It only works in this browser.</Text> : null}
    </Card>
  );
}

function AddCompany({ call, demo, done }: { call: Call; demo: boolean; done: () => void }) {
  const [name, setName] = useState('');
  const [ceo, setCeo] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  const [code, setCode] = useState<Code | null>(null);
  const add = async () => {
    setBusy(true); setErr(null);
    const r = await call('POST', '/platform/companies', { name: name.trim(), creator: { name: ceo.trim(), email: email.trim() } });
    setBusy(false);
    if (r.status !== 201 && r.status !== 200) { setErr(reasons(r)); return; }
    if (r.body.code) setCode({ ...r.body.code, name: ceo.trim(), company: name.trim() });
    setName(''); setCeo(''); setEmail('');
    done();
  };
  return (
    <Card style={{ gap: 10 }}>
      <Heading>Add a company</Heading>
      <Body quiet>The company and its CEO. The CEO gets a setup code, signs in, chooses their own password and goes through the start-up checklist (departments, people, WhatsApp, Pastel).</Body>
      {err ? <Notice tone="bad" title="Could not add it" lines={err} /> : null}
      <Field label="Company name" value={name} onChangeText={setName} />
      <Field label="CEO's full name" value={ceo} onChangeText={setCeo} />
      <Field label="CEO's email (what they sign in with)" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
      <Button label="Add the company" onPress={add} busy={busy} disabled={name.trim().length < 2 || ceo.trim().length < 2 || !email.includes('@')} />
      {code ? <CodeCard code={code} demo={demo} close={() => setCode(null)} /> : null}
    </Card>
  );
}
