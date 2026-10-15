// The CEO's start-up page for a new company: one checklist, in order, each step done right here or
// one tap away. Company details, logo and letterhead, departments, employees with their roles (many
// at once), their logins (setup codes to send by WhatsApp), rates, customers and stores, stock, vehicles.
import React, { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, Share, Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Field, Label, Notice, Pill, Select, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { CompanyForm, LogoPicker, useBooks } from './Books.tsx';
import { LetterheadSettings } from '../letterhead.tsx';
import { waNumber } from './Logins.tsx';
import { NumbersForm } from './Numbers.tsx';
import { WhatsAppSetup } from '../whatsapp/WhatsAppSetup.tsx';
import { PastelSetup } from './PastelSetup.tsx';

type Go = 'departments' | 'accounts' | 'stores' | 'importcustomers' | 'newstore' | 'people';
interface Step { key: string; title: string; why: string; optional: boolean; done: boolean; detail: string }
interface Person { id: string; full_name: string; login_level: string; email: string | null; phone: string | null; department: string | null; login: string }
interface Setup {
  company: string; steps: Step[]; done: number; total: number; dismissed: boolean; people: Person[];
  departments: { id: string; name: string }[]; roles: { level: string; label: string; help: string }[]; trades: { key: string; label: string }[];
}
type Row = { name: string; email: string; phone: string; role: string; dept: string | null; trade: string | null };
const blank = (): Row => ({ name: '', email: '', phone: '', role: 'technician', dept: null, trade: null });
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.'];
const LOGIN: Record<string, { t: string; tone: 'good' | 'info' | 'warn' | 'bad' | 'quiet' }> = {
  on: { t: 'Signs in', tone: 'good' }, code: { t: 'Code sent', tone: 'info' }, locked: { t: 'Locked', tone: 'bad' }, stopped: { t: 'Stopped', tone: 'bad' }, none: { t: 'No login yet', tone: 'warn' },
};

export function useSetup(enabled: boolean) {
  const s = useStore();
  const [d, setD] = useState<Setup | null>(null);
  const load = () => (enabled ? s.ask({ method: 'GET', path: '/setup' }).then(r => { if (r?.status === 200) setD(r.body as Setup); }).catch(() => undefined) : Promise.resolve());
  useEffect(() => { load(); }, [enabled]);
  return { d, load, setD };
}

export function StartUp({ go, setup }: { go: (where: Go) => void; setup: ReturnType<typeof useSetup> }) {
  const s = useStore();
  const { d, load, setD } = setup;
  const [open, setOpen] = useState<string | null>(null);
  if (!d) return <Body quiet>Loading…</Body>;
  const firstOpen = d.steps.find(x => !x.done)?.key ?? null;
  const shown = open ?? firstOpen;
  const put = async (json: object) => { const r = await s.ask({ method: 'PUT', path: '/setup', json }); if (r?.status === 200) setD({ ...d, ...(r.body as Partial<Setup>) }); };
  return (
    <>
      <Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>Start-up: {d.company}</Text>
      <Text style={st.body}>Set the company up in this order. Each step is done right here, or one tap away. Come back any time.</Text>
      <View style={{ height: 10, borderRadius: 5, backgroundColor: C.panel2, overflow: 'hidden' }} accessibilityLabel={`${d.done} of ${d.total} done`}>
        <View style={{ width: `${Math.round((d.done / d.total) * 100)}%`, height: 10, backgroundColor: C.good }} />
      </View>
      <Text style={st.small}>{d.done} of {d.total} done</Text>
      {d.steps.map((x, i) => (
        <Card key={x.key} accessibilityLabel={`Step ${x.title}`} style={shown === x.key ? { borderColor: C.accent, borderWidth: 2 } : undefined}>
          <Pressable onPress={() => setOpen(shown === x.key ? '' : x.key)} accessibilityRole="button" accessibilityLabel={`${i + 1}. ${x.title}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: x.done ? C.good : C.panel2 }}>
              <Text style={{ color: x.done ? '#FFFFFF' : C.text, fontWeight: '900' }}>{x.done ? '✓' : i + 1}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[st.body, { fontWeight: '800' }]}>{x.title}{x.optional ? ' (if you want)' : ''}</Text>
              <Text style={st.small} numberOfLines={shown === x.key ? undefined : 1}>{x.detail}</Text>
            </View>
            <Text style={{ color: C.quiet, fontSize: 18 }}>{shown === x.key ? '▾' : '›'}</Text>
          </Pressable>
          {shown === x.key ? (
            <View style={{ gap: 10 }}>
              <Text style={st.small}>{x.why}</Text>
              {x.key === 'policy' ? <Text style={st.body}>Published. A new version can be published by the CEO later; everyone accepts it again at their next sign-in.</Text> : null}
              {x.key === 'numbers' ? <NumbersForm changed={load} /> : null}
              {x.key === 'company' || x.key === 'rates' ? <CompanyStep done={() => { load(); setOpen(null); }} /> : null}
              {x.key === 'branding' ? <><LogoPicker /><LetterheadSettings /><Button label="Done: check again" kind="secondary" onPress={load} /></> : null}
              {x.key === 'departments' ? (
                <>
                  <Text style={st.body}>{d.departments.map(dd => dd.name).join(', ') || 'None yet'}</Text>
                  <Text style={st.small}>Switch off the ones you don't have, add your own, and give each its manager under Departments.</Text>
                  <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                    <Button label="Open Departments" kind="secondary" onPress={() => go('departments')} style={{ flexGrow: 1 }} />
                    <Button label={x.done ? 'Checked' : 'These are right'} disabled={x.done} onPress={() => put({ departmentsChecked: true })} style={{ flexGrow: 1 }} />
                  </View>
                </>
              ) : null}
              {x.key === 'people' ? <PeopleStep d={d} changed={load} /> : null}
              {x.key === 'logins' ? <LoginsStep d={d} changed={load} /> : null}
              {x.key === 'customers' ? (
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Button label="Bring them in from a spreadsheet" onPress={() => go('importcustomers')} style={{ flexGrow: 1 }} />
                  <Button label="Add one store" kind="secondary" onPress={() => go('newstore')} style={{ flexGrow: 1 }} />
                </View>
              ) : null}
              {x.key === 'whatsapp' ? <WhatsAppSetup changed={load} /> : null}
              {x.key === 'pastel' ? <PastelSetup changed={load} startOpen /> : null}
              {(x.key === 'whatsapp' || x.key === 'pastel') && !(x.done && x.detail !== 'Skipped') ? (
                <Button label={x.detail === 'Skipped' ? 'Don\'t skip it' : 'Skip this for now'} kind="quiet" onPress={() => put(x.detail === 'Skipped' ? { unskip: x.key } : { skip: x.key })} />
              ) : null}
              {x.key === 'stock' || x.key === 'vehicles' ? (
                <>
                  <Text style={st.body}>{x.key === 'stock' ? 'The stock controller adds the items in the Stockroom (Stock → a delivery, or New items), with their prices.' : 'Add the vehicles in the Fleet (the mechanic, or you under Fleet), then print their QR codes for the dashboards.'}</Text>
                  <Button label={d.steps.find(y => y.key === x.key)?.detail === 'Skipped' ? 'Don\'t skip it' : 'Skip this for now'} kind="secondary"
                    onPress={() => put(x.detail === 'Skipped' ? { unskip: x.key } : { skip: x.key })} />
                </>
              ) : null}
            </View>
          ) : null}
        </Card>
      ))}
      <Card>
        {d.done === d.total ? <Notice tone="good" title="All set up" lines={['Everyone can start working. This page stays under Settings → Start-up checklist.']} /> : null}
        <Button label={d.dismissed ? 'Show this page first again' : 'Put this page away (Settings → Start-up checklist)'} kind="quiet" onPress={() => put({ dismissed: !d.dismissed })} />
      </Card>
    </>
  );
}

function CompanyStep({ done }: { done: () => void }) {
  const b = useBooks();
  if (!b.company) return <Body quiet>Loading…</Body>;
  return <CompanyForm b={b} done={done} />;
}

/** Many employees at once: name, email, cell, role, department (and trade for a technician). */
function PeopleStep({ d, changed }: { d: Setup; changed: () => void }) {
  const s = useStore();
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; name: string; position?: string; reasons?: string[] }[] | null>(null);
  const [roles, setRoles] = useState(false);
  const set = (i: number, p: Partial<Row>) => setRows(r => r.map((x, n) => (n === i ? { ...x, ...p } : x)));
  const add = async () => {
    const list = rows.filter(r => r.name.trim());
    if (!list.length) { setRes([{ ok: false, name: 'Nobody', reasons: ['type at least one name'] }]); return; }
    setBusy(true);
    const r = await s.ask({ method: 'POST', path: '/setup/people', json: { people: list.map(x => ({ fullName: x.name.trim(), position: x.role, ...(x.email.trim() ? { email: x.email.trim() } : {}),
      ...(x.phone.trim() ? { phone: x.phone.trim() } : {}), ...(x.dept ? { departmentId: x.dept } : {}), ...(x.role === 'technician' && x.trade ? { trade: x.trade } : {}) })) } });
    setBusy(false);
    if (r?.status === 200) {
      const out = (r.body as { results: { ok: boolean; name: string; position?: string; reasons?: string[] }[] }).results;
      setRes(out);
      setRows(rows.filter(x => x.name.trim() && out.some(o => !o.ok && o.name === x.name.trim())).concat(out.every(o => o.ok) ? [blank()] : []));
      changed();
    } else setRes([{ ok: false, name: 'Not added', reasons: reasons(r) }]);
  };
  return (
    <View style={{ gap: 10 }}>
      <Pressable onPress={() => setRoles(v => !v)} accessibilityRole="button"><Text style={[st.small, { color: C.info, textDecorationLine: 'underline' }]}>{roles ? 'Hide' : 'What does each role do?'}</Text></Pressable>
      {roles ? (
        <View style={{ gap: 4 }}>
          {d.roles.map(r => <Text key={r.level} style={st.small}><Text style={{ fontWeight: '800', color: C.text }}>{r.label}: </Text>{r.help}</Text>)}
        </View>
      ) : null}
      {rows.map((r, i) => (
        <View key={i} style={{ gap: 6, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: C.line }} accessibilityLabel={`New person ${i + 1}`}>
          <Field label={`Person ${i + 1}: name and surname`} value={r.name} onChangeText={t => set(i, { name: t })} autoCapitalize="words" />
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <View style={{ flexGrow: 1, flexBasis: 200 }}><Field label="Email (they sign in with it)" value={r.email} onChangeText={t => set(i, { email: t })} autoCapitalize="none" keyboardType="email-address" /></View>
            <View style={{ flexGrow: 1, flexBasis: 140 }}><Field label="Cell (for WhatsApp)" value={r.phone} onChangeText={t => set(i, { phone: t })} keyboardType="phone-pad" /></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <View style={{ flexGrow: 1, flexBasis: 180 }}><Select label="Role" value={r.role} options={d.roles.map(x => ({ value: x.level, label: x.label }))} onChange={v => set(i, { role: v, trade: v === 'technician' ? r.trade : null })} /></View>
            {d.departments.length && ['technician', 'management', 'mechanic'].includes(r.role) ? (
              <View style={{ flexGrow: 1, flexBasis: 180 }}><Select label="Department" value={r.dept} placeholder="Not yet" options={d.departments.map(x => ({ value: x.id, label: x.name }))} onChange={v => set(i, { dept: v })} /></View>
            ) : null}
            {r.role === 'technician' ? <View style={{ flexGrow: 1, flexBasis: 160 }}><Select label="Trade" value={r.trade} placeholder="Not set" options={d.trades.map(x => ({ value: x.key, label: x.label }))} onChange={v => set(i, { trade: v })} /></View> : null}
          </View>
          <Text style={st.small}>{d.roles.find(x => x.level === r.role)?.help}</Text>
          {rows.length > 1 ? <Button label="Remove this row" kind="quiet" onPress={() => setRows(x => x.filter((_, n) => n !== i))} /> : null}
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Button label="+ Another person" kind="secondary" onPress={() => setRows(x => [...x, { ...blank(), role: x.at(-1)?.role ?? 'technician', dept: x.at(-1)?.dept ?? null }])} style={{ flexGrow: 1 }} />
        <Button label={`Add ${rows.filter(r => r.name.trim()).length > 1 ? `these ${rows.filter(r => r.name.trim()).length} people` : 'this person'}`} busy={busy} onPress={add} style={{ flexGrow: 1 }} />
      </View>
      {res ? (
        <View style={{ gap: 4 }}>
          {res.map((x, i) => <Text key={i} style={[st.small, { color: x.ok ? C.good : C.bad }]}>{x.ok ? `✓ ${x.name} added as ${x.position}` : `✗ ${x.name}: ${(x.reasons ?? []).join('; ')}`}</Text>)}
        </View>
      ) : null}
      {d.people.length ? (
        <View style={{ gap: 2 }}>
          <Label>Everyone so far ({d.people.length})</Label>
          {d.people.map(p => (
            <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <Text style={[st.body, { flex: 1 }]} numberOfLines={1}>{p.full_name}</Text>
              <Text style={st.small}>{d.roles.find(r => r.level === p.login_level)?.label ?? p.login_level}{p.department ? ` · ${p.department}` : ''}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Setup codes for everyone without a login: each person's message, to copy or send by WhatsApp. Shown once. */
function LoginsStep({ d, changed }: { d: Setup; changed: () => void }) {
  const s = useStore();
  const demo = s.session?.mode === 'demo';
  const waiting = d.people.filter(p => p.login === 'none' && p.email);
  const [pick, setPick] = useState<string[]>(waiting.map(p => p.id));
  const waitingKey = waiting.map(p => p.id).join();
  useEffect(() => { setPick(waiting.map(p => p.id)); }, [waitingKey]);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<{ ok: boolean; userId: string; name: string; phone?: string | null; message?: string; reasons?: string[] }[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const make = async () => {
    setBusy(true);
    const r = await s.ask({ method: 'POST', path: '/setup/codes', json: { userIds: pick } });
    setBusy(false);
    if (r?.status === 200) { setCodes((r.body as { codes: typeof codes }).codes); changed(); } else setCodes([{ ok: false, userId: '', name: 'Not made', reasons: reasons(r) }]);
  };
  const copy = async (c: { userId: string; message?: string }) => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(c.message ?? '');
      else await Share.share({ message: c.message ?? '' });
      setCopied(c.userId);
    } catch { setCopied(null); }
  };
  return (
    <View style={{ gap: 8 }}>
      <Text style={st.small}>Each person gets a one-time setup code. They open the app, tap "I have a setup code", and choose their own password: nobody else ever knows it.</Text>
      {d.people.map(p => {
        const can = p.login === 'none' && !!p.email;
        const on = pick.includes(p.id);
        const l = LOGIN[p.login] ?? LOGIN.none;
        return (
          <Pressable key={p.id} disabled={!can} onPress={() => setPick(x => (on ? x.filter(y => y !== p.id) : [...x, p.id]))} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: !can }} accessibilityLabel={`Code for ${p.full_name}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line, opacity: can || p.login !== 'none' ? 1 : 0.7 }}>
            <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: can ? (on ? C.accent : C.line) : 'transparent', backgroundColor: can && on ? C.accent : 'transparent' }} />
            <Text style={[st.body, { flex: 1 }]} numberOfLines={1}>{p.full_name}</Text>
            {!p.email ? <Text style={[st.small, { color: C.warn }]}>No email</Text> : <Pill text={l.t} tone={l.tone} />}
          </Pressable>
        );
      })}
      <Button label={pick.length ? `Make setup codes for ${pick.length} ${pick.length === 1 ? 'person' : 'people'}` : 'Everyone with an email has a login'} disabled={!pick.length} busy={busy} onPress={make} />
      {d.people.some(p => !p.email) ? <Text style={st.small}>Someone without an email can't get a login yet: add their email under People (it is what they sign in with).</Text> : null}
      {codes ? (
        <View style={{ gap: 8 }}>
          <Notice tone="warn" title="Send these now: each code is shown only once" lines={['Lost one? Make a new code for that person under People → their name → Login.']} />
          {codes.map(c => c.ok ? (
            <Card key={c.userId}>
              <Text style={[st.body, { fontWeight: '800' }]}>{c.name}</Text>
              <TextInput value={c.message} editable={false} multiline style={[st.input, { minHeight: 120, fontSize: 13 }]} accessibilityLabel={`Message for ${c.name}`} />
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Button label={copied === c.userId ? 'Copied' : 'Copy the message'} kind="secondary" onPress={() => copy(c)} style={{ flexGrow: 1 }} />
                {!demo && waNumber(c.phone) ? <Button label="Send by WhatsApp" onPress={() => Linking.openURL(`https://wa.me/${waNumber(c.phone)}?text=${encodeURIComponent(c.message ?? '')}`)} style={{ flexGrow: 1 }} /> : null}
              </View>
            </Card>
          ) : <Text key={c.userId || c.name} style={[st.small, { color: C.bad }]}>✗ {c.name}: {(c.reasons ?? []).join('; ')}</Text>)}
        </View>
      ) : null}
    </View>
  );
}

