// The office's Breakdowns queue: every breakdown email (customers and the call centre's logged calls)
// and every message in the WhatsApp breakdowns group, read by the app for the store, the fault and
// the call log number. One tap opens the job already filled in: check it, pick the technician. The
// same call from email and WhatsApp becomes one job. Nothing leaves the queue until someone logs it,
// adds it to a job already open, or marks it "not a job".
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Platform, Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Field, Heading, Label, Notice, Pill, Select, Toggle, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { Thumb } from '../ItemPicture.tsx';
import { usePhotoUri } from '../photo.ts';
import type { OfficeHook } from './useOffice.ts';

export interface Bd {
  id: string; channel: 'email' | 'whatsapp'; received_at: string; sender_name: string | null; sender: string | null; subject: string | null; body: string;
  photo_ids: string[]; attachments: string[]; kind: 'breakdown' | 'inquiry' | 'other'; read_by: 'ai' | 'rules';
  store_id: string | null; store: string | null; client: string | null; store_text: string | null; fault: string | null; call_ref: string | null; urgent: boolean;
  status: 'new' | 'logged' | 'merged' | 'ignored'; job_id: string | null; job_number: number | null; handled_by: string | null; handled_at: string | null; note: string | null;
  escalated_at: string | null; same: { id: string; job_number: number; status: string; store: string; why: 'call_ref' | 'store' } | null;
}
interface Post { text: string; reason: string; created_at: string; sent_at: string | null; error: string | null }
export interface BdList { items: Bd[]; canSettings: boolean; whatsapp: { state: string; group_name: string | null } | null; inboxes: { address: string; last_checked_at: string | null; last_error: string | null }[]; posts?: Post[] }

const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['Needs signal: try again.'];
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.floor(m / 60)} h ${m % 60} min ago` : new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
};
const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const KIND: Record<Bd['kind'], string> = { breakdown: 'Breakdown', inquiry: 'Question or quote', other: 'Probably not a breakdown' };
const where = (b: Bd) => b.store ?? (b.store_text ? `${b.store_text} (not matched)` : 'Store not clear');

export function useBreakdowns(view: 'open' | 'done', tick = 0) {
  const s = useStore();
  const [d, setD] = useState<BdList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await s.ask({ method: 'GET', path: `/breakdowns?view=${view}` });
    if (r?.status === 200) { setD(r.body as BdList); setErr(null); } else if (r) setErr(reasons(r).join('; '));
  }, [view]);
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, [load, tick]);
  return { d, err, load };
}

export function BreakdownList({ view, setView, open, selected, tick }: { view: 'open' | 'done'; setView: (v: 'open' | 'done') => void; open: (b: Bd) => void; selected: string | null; tick: number }) {
  const s = useStore();
  const { d, err, load } = useBreakdowns(view, tick);
  const [sim, setSim] = useState<string | null>(null);
  const items = d?.items ?? [];
  const real = items.filter(b => b.kind === 'breakdown');
  const rest = items.filter(b => b.kind !== 'breakdown');
  const demo = s.session?.mode === 'demo';
  const simulate = async (channel: 'email' | 'whatsapp') => {
    const r = await s.ask({ method: 'POST', path: '/demo/breakdowns/simulate', json: { channel } });
    setSim(r?.status === 200 ? (channel === 'email' ? 'A pretend breakdown email arrived.' : 'A pretend message was posted in the group.') : reasons(r).join('; '));
    load();
  };
  const card = (b: Bd) => {
    const long = b.status === 'new' && b.kind === 'breakdown' && Date.now() - Date.parse(b.received_at) > 15 * 60_000;
    return (
      <Card key={b.id} onPress={() => open(b)} accessibilityLabel={`Breakdown ${where(b)}`} style={selected === b.id ? { borderColor: C.accent, borderWidth: 2 } : undefined}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={st.small}>{b.channel === 'email' ? '✉️ Email' : '💬 WhatsApp'}</Text>
          {b.urgent ? <Pill text="Urgent" tone="bad" /> : null}
          {b.status === 'new' && b.same ? <Pill text={`Already job #${b.same.job_number}?`} tone="warn" /> : null}
          {b.status !== 'new' ? <Pill text={b.status === 'ignored' ? 'Not a job' : `Job #${b.job_number}${b.status === 'merged' ? ' (added)' : ''}`} tone={b.status === 'ignored' ? 'quiet' : 'good'} /> : null}
          <View style={{ flex: 1 }} />
          <Text style={[st.small, long ? { color: C.bad, fontWeight: '800' } : null]}>{ago(b.received_at)}</Text>
        </View>
        <Text style={[st.body, { fontWeight: '800' }]} numberOfLines={1}>{where(b)}</Text>
        <Text style={st.body} numberOfLines={2}>{b.fault ?? b.subject ?? b.body.slice(0, 120)}</Text>
        <Text style={st.small} numberOfLines={1}>{[b.call_ref ? `Call log ${b.call_ref}` : null, b.sender_name ?? b.sender, b.photo_ids.length ? `${b.photo_ids.length} picture${b.photo_ids.length > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ')}</Text>
      </Card>
    );
  };
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label={`Waiting${view === 'open' && d ? ` (${items.length})` : ''}`} kind={view === 'open' ? 'primary' : 'secondary'} onPress={() => setView('open')} style={{ flex: 1 }} />
        <Button label="Handled" kind={view === 'done' ? 'primary' : 'secondary'} onPress={() => setView('done')} style={{ flex: 1 }} />
      </View>
      {d ? (
        <Text style={st.small}>
          {d.inboxes.length ? `Reading ${d.inboxes.map(i => i.address).join(', ')}` : 'No inbox connected yet'}
          {d.whatsapp?.state === 'connected' && d.whatsapp.group_name ? ` · WhatsApp: ${d.whatsapp.group_name}` : ' · WhatsApp not linked'}
          {d.canSettings ? ' (Settings → Breakdowns)' : ''}
        </Text>
      ) : null}
      {d?.inboxes.some(i => i.last_error) ? <Notice tone="bad" title="An inbox could not be read" lines={d.inboxes.filter(i => i.last_error).map(i => `${i.address}: ${i.last_error}`)} /> : null}
      {err ? <Notice tone="bad" title="Could not load" lines={[err]} /> : null}
      {demo ? (
        <Card>
          <Label>Test drive</Label>
          <Text style={st.small}>Pretend a breakdown comes in, to see the pop-up and the queue.</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label="Send a breakdown email" kind="secondary" onPress={() => simulate('email')} style={{ flex: 1 }} />
            <Button label="Post in the WhatsApp group" kind="secondary" onPress={() => simulate('whatsapp')} style={{ flex: 1 }} />
          </View>
          {sim ? <Text style={st.small}>{sim}</Text> : null}
        </Card>
      ) : null}
      {!d && !err ? <Body quiet>Loading…</Body> : null}
      {d && !items.length ? <Body quiet>{view === 'open' ? 'Nothing waiting. New breakdown emails and group messages show here.' : 'Nothing handled in the last two weeks.'}</Body> : null}
      {real.length ? <><Label>{view === 'open' ? `Breakdowns waiting (${real.length})` : 'Breakdowns'}</Label>{real.map(card)}</> : null}
      {rest.length ? <><Label>{view === 'open' ? `Probably not breakdowns (${rest.length})` : 'Other messages'}</Label>{rest.map(card)}</> : null}
      {view === 'open' && d?.posts?.length ? (
        <Card>
          <Label>What the app posted in the WhatsApp group</Label>
          {d.posts.map((p, i) => (
            <View key={i} style={{ paddingVertical: 6, borderTopWidth: i ? 1 : 0, borderTopColor: C.line }}>
              <Text style={st.body}>{p.text}</Text>
              <Text style={[st.small, p.error && !p.sent_at ? { color: C.bad } : null]}>{p.sent_at ? `Posted ${ago(p.sent_at)}` : p.error ? `Not posted yet: ${p.error}` : 'Waiting for the WhatsApp link'}</Text>
            </View>
          ))}
        </Card>
      ) : null}
    </>
  );
}

function Picture({ id }: { id: string }) {
  const uri = usePhotoUri(id);
  return uri ? <Image source={{ uri }} style={{ width: '100%', aspectRatio: 4 / 3, borderRadius: 8, backgroundColor: '#000' }} resizeMode="contain" accessibilityLabel="Picture that came with the breakdown" /> : <Thumb photoId={id} label="Picture" size={88} />;
}

/** One message: what it says, what the app read from it, and what to do with it. */
export function BreakdownDetail({ b, o, logIt, done }: { b: Bd; o: OfficeHook; logIt: (b: Bd) => void; done: (jobId?: string) => void }) {
  const s = useStore();
  const [ignore, setIgnore] = useState(false);
  const [note, setNote] = useState('');
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const act = async (path: string, json: object, after: (body: { jobId?: string }) => void) => {
    setBusy(path); setErr(null);
    const r = await s.ask({ method: 'POST', path, json });
    setBusy(null);
    if (r && r.status < 300) after(r.body as { jobId?: string }); else setErr(reasons(r));
  };
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Heading>{where(b)}</Heading>
        {b.urgent ? <Pill text="Urgent" tone="bad" /> : null}
        <Pill text={KIND[b.kind]} tone={b.kind === 'breakdown' ? 'warn' : 'quiet'} />
      </View>
      <Text style={st.small}>{b.channel === 'email' ? '✉️ Email' : '💬 WhatsApp group'} · {when(b.received_at)} ({ago(b.received_at)}) · from {b.sender_name ? `${b.sender_name}${b.sender ? ` (${b.sender})` : ''}` : b.sender ?? 'unknown'}</Text>

      <Card>
        <Label>What the app read{b.read_by === 'ai' ? '' : ' (simple rules: check it)'}</Label>
        <Text style={st.body}><Text style={{ fontWeight: '800' }}>Store: </Text>{b.store ? `${b.store}${b.client ? ` (${b.client})` : ''}` : b.store_text ? `"${b.store_text}": not one of the stores yet` : 'not clear: pick it when you log the job'}</Text>
        <Text style={st.body}><Text style={{ fontWeight: '800' }}>Fault: </Text>{b.fault ?? '–'}</Text>
        <Text style={st.body}><Text style={{ fontWeight: '800' }}>Call log number: </Text>{b.call_ref ?? 'none in the message'}</Text>
      </Card>

      {b.status === 'new' && b.same ? (
        <Notice tone="warn" title={`Already job #${b.same.job_number}?`} lines={[b.same.why === 'call_ref' ? `Job #${b.same.job_number} has the same call log number (${b.call_ref}).` : `Job #${b.same.job_number} at ${b.same.store} was opened in the last two days and is still open.`, 'A reminder or a second message about the same call: add it to that job instead of opening another.']} />
      ) : null}

      {b.status === 'new' ? (
        <View style={{ gap: 8 }}>
          {b.same ? <Button label={`Add to job #${b.same.job_number}`} busy={busy === `/breakdowns/${b.id}/merge`} onPress={() => act(`/breakdowns/${b.id}/merge`, { jobId: b.same!.id }, () => done(b.same!.id))} /> : null}
          <Button label={b.same ? 'No, log it as a new job' : 'Log it as a job'} kind={b.same ? 'secondary' : 'primary'} onPress={() => logIt(b)} />
          {!ignore ? <Button label="Not a job" kind="quiet" onPress={() => setIgnore(true)} /> : (
            <Card>
              <Field label={b.kind === 'breakdown' ? 'Why is it not a job?' : 'Note (optional)'} value={note} onChangeText={setNote} placeholder={b.kind === 'breakdown' ? 'e.g. already fixed, not our client, duplicate' : 'e.g. statement for accounts'} />
              {b.sender ? <Toggle label={`Always leave out messages from ${b.sender}`} value={always} onChange={setAlways} /> : null}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button label="Cancel" kind="quiet" onPress={() => setIgnore(false)} style={{ flex: 1 }} />
                <Button label="Not a job" busy={busy === `/breakdowns/${b.id}/ignore`} onPress={() => act(`/breakdowns/${b.id}/ignore`, { note: note.trim() || undefined, alwaysIgnoreSender: always }, () => done())} style={{ flex: 1 }} />
              </View>
            </Card>
          )}
        </View>
      ) : (
        <Card>
          <Text style={st.body}>{b.status === 'ignored' ? 'Marked not a job' : b.status === 'merged' ? `Added to job #${b.job_number}` : `Logged as job #${b.job_number}`}{b.handled_by ? ` by ${b.handled_by}` : ''}{b.handled_at ? `, ${when(b.handled_at)}` : ''}.</Text>
          {b.note ? <Text style={st.small}>{b.note}</Text> : null}
          {b.job_id ? <Button label={`Open job #${b.job_number}`} kind="secondary" onPress={() => done(b.job_id!)} /> : null}
          {b.status === 'ignored' ? <Button label="Back in the queue" kind="quiet" onPress={() => act(`/breakdowns/${b.id}/reopen`, {}, () => done())} /> : null}
        </Card>
      )}
      {err ? <Notice tone="bad" title="Not done" lines={err} /> : null}

      <Label>The message</Label>
      <Card>
        {b.subject ? <Text style={[st.body, { fontWeight: '800' }]}>{b.subject}</Text> : null}
        <Text selectable style={st.body}>{b.body || '(no text)'}</Text>
        {b.attachments.length ? <Text style={st.small}>Also attached: {b.attachments.join(', ')}</Text> : null}
      </Card>
      {b.photo_ids.map(id => <Picture key={id} id={id} />)}
    </>
  );
}

/** The pop-up: a new breakdown came in. Shows on every office screen for whoever opens jobs, with a sound. */
export function BreakdownAlert({ open }: { open: (id: string) => void }) {
  const s = useStore();
  const [n, setN] = useState<{ breakdowns: number; latest: { id: string; store: string | null; fault: string | null; urgent: boolean; channel: string } | null } | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    let gone = false;
    const poll = async () => {
      const r = await s.ask({ method: 'GET', path: '/breakdowns/count' });
      if (gone || r?.status !== 200) return;
      const body = r.body as typeof n;
      setN(body);
      const id = body?.latest?.id ?? null;
      if (id && id !== seen.current) { seen.current = id; setShown(id); beep(); }
    };
    poll();
    const t = setInterval(poll, 15_000);
    return () => { gone = true; clearInterval(t); };
  }, []);
  if (!n?.latest || shown !== n.latest.id) return null;
  const l = n.latest;
  return (
    <View accessibilityRole="alert" style={{ position: 'absolute', top: 12, left: 12, right: 12, zIndex: 50, alignItems: 'center' }} pointerEvents="box-none">
      <View style={{ maxWidth: 560, width: '100%', backgroundColor: l.urgent ? '#7A1E14' : '#1F3D63', borderRadius: 12, padding: 14, gap: 8, borderWidth: 2, borderColor: l.urgent ? '#FF8A7A' : '#7FB2FF', shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12, elevation: 8 }}>
        <Text style={{ color: '#FFF', fontWeight: '800', fontSize: 17 }}>{l.urgent ? '🔴 Urgent breakdown' : '🆕 New breakdown'} ({l.channel === 'email' ? 'email' : 'WhatsApp'}){n.breakdowns > 1 ? ` · ${n.breakdowns} waiting` : ''}</Text>
        <Text style={{ color: '#FFF', fontSize: 16 }} numberOfLines={1}>{l.store ?? 'Store not clear'}</Text>
        {l.fault ? <Text style={{ color: '#E6EEF8' }} numberOfLines={2}>{l.fault}</Text> : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable onPress={() => { setShown(null); open(l.id); }} accessibilityRole="button" style={{ flex: 1, backgroundColor: '#FFF', borderRadius: 8, padding: 10, alignItems: 'center' }}>
            <Text style={{ color: '#111', fontWeight: '800' }}>Open it</Text>
          </Pressable>
          <Pressable onPress={() => setShown(null)} accessibilityRole="button" style={{ flex: 1, borderColor: '#FFF', borderWidth: 1, borderRadius: 8, padding: 10, alignItems: 'center' }}>
            <Text style={{ color: '#FFF', fontWeight: '700' }}>Later</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** Two short tones (on a computer; phones use their own notification sound). */
function beep() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  try {
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.25].forEach((t, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = i ? 1046 : 784; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.22);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.24);
    });
  } catch { /* no sound allowed yet */ }
}

// ---- The CEO's settings ----------------------------------------------------------------------------

interface SettingsData {
  settings: { post_new: boolean; post_logged: boolean; post_on_site: boolean; post_done: boolean; escalate_after_min: number; ignore_senders: string[] };
  inboxes: { id: string; address: string; active: boolean; last_checked_at: string | null; last_error: string | null }[];
  whatsapp: { state: string; qr_svg?: string | null; number?: string | null; groups: { jid: string; name: string }[]; group_jid?: string | null; group_name?: string | null; po_group_jid?: string | null; po_group_name?: string | null; running?: boolean };
  posts: Post[]; ai: boolean; companyId?: string;
}

export function BreakdownSettings() {
  const s = useStore();
  const [d, setD] = useState<SettingsData | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [pass, setPass] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async () => { const r = await s.ask({ method: 'GET', path: '/breakdowns/settings' }); if (r?.status === 200) setD(r.body as SettingsData); else if (r && r.status !== 403) setErr(reasons(r)); };
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, []);
  if (!d) return err ? <Notice tone="bad" title="Breakdowns settings" lines={err} /> : null;
  const save = async (patch: Partial<SettingsData['settings']>) => {
    const n = { ...d.settings, ...patch };
    const r = await s.ask({ method: 'PUT', path: '/breakdowns/settings', json: { postNew: n.post_new, postLogged: n.post_logged, postOnSite: n.post_on_site, postDone: n.post_done, escalateAfterMin: n.escalate_after_min, ignoreSenders: n.ignore_senders } });
    if (r?.status === 200) { setD({ ...d, settings: r.body as SettingsData['settings'] }); setErr(null); } else setErr(reasons(r));
  };
  const add = async () => {
    setBusy(true); setErr(null); setOk(null);
    const r = await s.ask({ method: 'POST', path: '/breakdowns/inboxes', json: { address: address.trim(), appPassword: pass } });
    setBusy(false);
    if (r?.status === 200) { setOk(`${address.trim()} is connected: new emails come in within a minute.`); setAddress(''); setPass(''); setAdding(false); load(); } else setErr(reasons(r));
  };
  const remove = async (id: string) => { const r = await s.ask({ method: 'DELETE', path: `/breakdowns/inboxes/${id}` }); if (r && r.status < 300) load(); else setErr(reasons(r)); };
  const group = async (jid: string) => { const r = await s.ask({ method: 'PUT', path: '/breakdowns/whatsapp/group', json: { jid } }); if (r?.status === 200) load(); else setErr(reasons(r)); };
  const poGroup = async (jid: string | null) => { const r = await s.ask({ method: 'PUT', path: '/breakdowns/whatsapp/group', json: { kind: 'pos', jid } }); if (r?.status === 200) load(); else setErr(reasons(r)); };
  const w = d.whatsapp;
  const qrUri = w.qr_svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(w.qr_svg)}` : null;
  return (
    <>
      <Heading>Breakdowns: email and WhatsApp</Heading>
      <Body quiet>Breakdown emails and messages in the WhatsApp breakdowns group come into the Breakdowns queue, read for the store, fault and call log number.{d.ai ? '' : ' (AI reading is not switched on: simple rules read them; the office checks before logging.)'}</Body>
      {err ? <Notice tone="bad" title="Not done" lines={err} /> : null}
      {ok ? <Notice tone="good" title={ok} /> : null}

      <Card>
        <Label>Gmail inboxes</Label>
        {!d.inboxes.filter(i => i.active).length ? <Body quiet>None yet.</Body> : null}
        {d.inboxes.filter(i => i.active).map(i => (
          <View key={i.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.line }}>
            <View style={{ flex: 1 }}>
              <Text style={[st.body, { fontWeight: '700' }]}>{i.address}</Text>
              <Text style={[st.small, i.last_error ? { color: C.bad } : null]}>{i.last_error ? `Problem: ${i.last_error}` : i.last_checked_at ? `Checked ${ago(i.last_checked_at)}` : 'Not checked yet'}</Text>
            </View>
            <Button label="Disconnect" kind="quiet" onPress={() => remove(i.id)} />
          </View>
        ))}
        {!adding ? <Button label="Connect a Gmail inbox" kind="secondary" onPress={() => setAdding(true)} /> : (
          <View style={{ gap: 8 }}>
            <Text style={st.small}>The app only reads: it never deletes, moves or marks emails as read. In the Gmail account: Google account → Security → turn on 2-Step Verification → App passwords → make one called "Real Sandbox" and type its 16 letters here. The app password is kept scrambled and never shown again; delete it in Google to stop the app reading.</Text>
            <Field label="Gmail address" value={address} onChangeText={setAddress} autoCapitalize="none" keyboardType="email-address" placeholder="breakdowns@gmail.com" />
            <Field label="App password (16 letters)" value={pass} onChangeText={setPass} autoCapitalize="none" autoCorrect={false} secureTextEntry />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button label="Cancel" kind="quiet" onPress={() => setAdding(false)} style={{ flex: 1 }} />
              <Button label="Check and connect" busy={busy} disabled={!address.trim() || pass.replace(/\s/g, '').length < 8} onPress={add} style={{ flex: 1 }} />
            </View>
          </View>
        )}
      </Card>

      <Card>
        <Label>The app's WhatsApp number</Label>
        {w.state === 'connected' ? (
          <>
            <Text style={st.body}>Linked{w.number ? ` as +${w.number}` : ''}{w.running === false ? ': but the link has not reported in for a while (is it running on the server?)' : '.'}</Text>
            <Select label="The breakdowns group" value={w.group_jid ?? null} placeholder="Choose the group" options={w.groups.map(g => ({ value: g.jid, label: g.name }))} onChange={group} />
            {!w.groups.length ? <Text style={st.small}>The number is in no groups yet: add it to the breakdowns group on a phone.</Text> : null}
            <Select label="The purchase orders group (optional)" value={w.po_group_jid ?? null} placeholder="None" options={[{ value: '', label: 'None' }, ...w.groups.filter(g => g.jid !== w.group_jid).map(g => ({ value: g.jid, label: g.name }))]} onChange={v => poGroup(v || null)} />
            <Text style={st.small}>A PO made outside the app (in Pastel) and posted in this group is read and added by itself: on its job, for the job's technician, with the stock items, like the app's own.</Text>
          </>
        ) : w.state === 'waiting_for_scan' && qrUri ? (
          <>
            <Text style={st.body}>On the ZSP phone: WhatsApp → ⋮ → Linked devices → Link a device, and scan this code.</Text>
            {Platform.OS === 'web' ? <Image source={{ uri: qrUri }} style={{ width: 264, height: 264, backgroundColor: '#FFF', borderRadius: 8 }} accessibilityLabel="QR code to link the WhatsApp number" /> : <Text style={st.small}>Open this screen on a computer to scan the code.</Text>}
          </>
        ) : (
          <>
            <Text style={st.body}>{w.state === 'logged_out' ? 'The number was unlinked on the phone.' : 'Not linked yet.'}</Text>
            <Text style={st.small}>The WhatsApp link runs next to the server ("whatsapp" in the server set-up). Once it runs, a QR code shows here to scan with the ZSP phone.{d.companyId ? ` Its company id: ${d.companyId}` : ''}</Text>
          </>
        )}
        <Text style={st.small}>Use a phone and SIM only for this. It is not WhatsApp's official business system (that one cannot join an existing group), so WhatsApp could block the number: if that happens, the group and the email side keep working.</Text>
      </Card>

      <Card>
        <Label>What the app posts in the group</Label>
        <Toggle label="New breakdowns that came by email" value={d.settings.post_new} onChange={v => save({ post_new: v })} />
        <Toggle label="Job logged, with the technician" value={d.settings.post_logged} onChange={v => save({ post_logged: v })} />
        <Toggle label="Technician on site" value={d.settings.post_on_site} onChange={v => save({ post_on_site: v })} />
        <Toggle label="Job done" value={d.settings.post_done} onChange={v => save({ post_done: v })} />
        <Select label="Tell the CEO when a breakdown waits longer than" value={String(d.settings.escalate_after_min)} options={['10', '15', '20', '30', '45', '60'].map(m => ({ value: m, label: `${m} minutes` }))} onChange={v => save({ escalate_after_min: Number(v) })} />
      </Card>

      {d.settings.ignore_senders.length ? (
        <Card>
          <Label>Always left out</Label>
          {d.settings.ignore_senders.map(x => (
            <View key={x} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[st.body, { flex: 1 }]}>{x}</Text>
              <Button label="Take off" kind="quiet" onPress={() => save({ ignore_senders: d.settings.ignore_senders.filter(y => y !== x) })} />
            </View>
          ))}
        </Card>
      ) : null}
    </>
  );
}


/** A breakdown opened from the pop-up (only its id known yet) or from the list. */
export function BreakdownById({ id, b, o, logIt, done }: { id: string; b?: Bd; o: OfficeHook; logIt: (b: Bd) => void; done: (jobId?: string) => void }) {
  const s = useStore();
  const [item, setItem] = useState<Bd | null>(b ?? null);
  useEffect(() => {
    (async () => {
      for (const view of ['open', 'done'] as const) {
        const r = await s.ask({ method: 'GET', path: `/breakdowns?view=${view}` });
        const hit = (r?.body as BdList | undefined)?.items?.find(x => x.id === id);
        if (hit) { setItem(hit); return; }
      }
    })();
  }, [id]);
  return item ? <BreakdownDetail b={item} o={o} logIt={logIt} done={done} /> : <Body quiet>Loading…</Body>;
}
