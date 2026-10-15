// Real Sandbox support: the CEO lets support into the company for a set time (Settings), sees when
// support is in (the band at the top), and ends it whenever they like. Support itself sees whose
// company it is in, until when, and finishes from the same band.
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Choice, Field, Heading, Notice, st } from '../ui.tsx';
import { ownerView } from '../owner/OwnerApp.tsx';
import { C } from '../theme.ts';

interface Grant { id: string; until: string; grantedAt: string; reason: string | null; enteredAt: string | null; enteredBy: string | null; grantedBy: string; endedAt?: string | null; endedBy?: string | null }
interface SupportView { active: Grant | null; canGrant: boolean; hours: number[]; history: Grant[]; isSupport: boolean }

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'Africa/Johannesburg' });
const until = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? `until ${time(iso)}` : `until ${day(iso)}, ${time(iso)}`);
const HOURS: Record<string, string> = { 1: '1 hour', 4: '4 hours', 24: 'A day', 72: '3 days' };

// Everyone on the page hears when support access changes (the band and the Settings card together).
const subs = new Set<() => void>();
const changed = () => subs.forEach(f => f());

function useSupport(on: boolean) {
  const s = useStore();
  const [v, setV] = useState<SupportView | null>(null);
  const load = () => s.ask({ method: 'GET', path: '/support' }).then(r => { if (r?.status === 200) setV(r.body as SupportView); }).catch(() => undefined);
  useEffect(() => {
    if (!on) return;
    load();
    subs.add(load);
    const t = setInterval(load, 60_000);
    return () => { subs.delete(load); clearInterval(t); };
  }, [on]);
  return { v, load };
}

/** The band under the office header: support is in (for the CEO), or you are support (for the owner). */
export function SupportBanner({ ceo }: { ceo: boolean }) {
  const s = useStore();
  const isSupport = !!s.session?.support;
  const { v } = useSupport(ceo || isSupport);
  const [busy, setBusy] = useState(false);
  if (isSupport) {
    const finish = async () => {
      setBusy(true);
      await s.ask({ method: 'POST', path: '/support/end' }).catch(() => null);
      setBusy(false);
      ownerView.set(true);
      await s.signOut();
    };
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#123D2A', flexWrap: 'wrap' }}>
        <Text style={{ color: '#CFF5DF', flex: 1, minWidth: 220, fontWeight: '700' }}>
          You are in {s.session?.company.name} as Real Sandbox support {until(v?.active?.until ?? s.session!.support!.until)}. Everything you do shows in their history as "{s.session?.user.name}".
        </Text>
        <Pressable onPress={finish} accessibilityRole="button" accessibilityLabel="Finish support and go back to the owner dashboard"
          style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#CFF5DF' }}>
          <Text style={{ color: '#0B2A1C', fontWeight: '800' }}>{busy ? '…' : 'Finish and go back'}</Text>
        </Pressable>
      </View>
    );
  }
  const g = v?.active;
  if (!ceo || !g) return null;
  const end = async () => { setBusy(true); await s.ask({ method: 'POST', path: '/support/end' }).catch(() => null); setBusy(false); changed(); };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#123D2A', flexWrap: 'wrap' }}>
      <Text style={{ color: '#CFF5DF', flex: 1, minWidth: 220, fontWeight: '700' }}>
        {g.enteredAt ? `Real Sandbox support (${g.enteredBy ?? 'support'}) is in your company` : 'Real Sandbox support may open your company'} {until(g.until)}. You can end it now.
      </Text>
      <Pressable onPress={end} accessibilityRole="button" accessibilityLabel="End support access now"
        style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#CFF5DF' }}>
        <Text style={{ color: '#0B2A1C', fontWeight: '800' }}>{busy ? '…' : 'End now'}</Text>
      </Pressable>
    </View>
  );
}

/** Settings → Real Sandbox support (the CEO). */
export function SupportSettings() {
  const s = useStore();
  const { v, load } = useSupport(true);
  const [hours, setHours] = useState('4');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  if (!v || !v.canGrant) return null;
  const act = async (path: string, json?: object) => {
    setBusy(true); setErr(null);
    const r = await s.ask({ method: 'POST', path, json });
    setBusy(false);
    if (!r) { setErr(['Needs signal.']); return; }
    if (r.status !== 200) { setErr(r.body?.reasons ?? [r.body?.error ?? 'Something went wrong']); return; }
    setReason(''); load(); changed();
  };
  const g = v.active;
  return (
    <Card style={{ gap: 10 }}>
      <Heading>Real Sandbox support</Heading>
      <Body quiet>Stuck, or something looks wrong? Let Real Sandbox (who make the app) into your company for a while. They can then see and change what you can, to sort it out. Everything they do is in your history under "Support". They can't get in any other way, and you can end it any time.</Body>
      {err ? <Notice tone="bad" title="Could not do that" lines={err} /> : null}
      {g ? (
        <>
          <Notice tone="good" title={`Support is allowed ${until(g.until)}`} lines={[
            `Allowed by ${g.grantedBy} at ${time(g.grantedAt)}${g.reason ? `: "${g.reason}"` : ''}.`,
            g.enteredAt ? `${g.enteredBy ?? 'Support'} opened your company at ${time(g.enteredAt)}.` : 'Support has not opened it yet. Tell them it is ready (call or WhatsApp them).',
          ]} />
          <Button label="End support access now" kind="danger" onPress={() => act('/support/end')} busy={busy} />
        </>
      ) : (
        <>
          <Text style={st.small}>For how long</Text>
          <Choice options={v.hours.map(String)} value={hours} onChange={setHours} labels={Object.fromEntries(v.hours.map(h => [String(h), HOURS[h] ?? `${h} hours`]))} />
          <Field label="What do you need help with? (optional)" value={reason} onChangeText={setReason} placeholder="e.g. The Pastel import gives an error" />
          <Button label="Let support in" onPress={() => act('/support/grant', { hours: Number(hours), reason: reason.trim() || undefined })} busy={busy} />
        </>
      )}
      {v.history.filter(h => h.id !== g?.id).length ? (
        <View style={{ gap: 4 }}>
          <Text style={st.small}>Before</Text>
          {v.history.filter(h => h.id !== g?.id).slice(0, 5).map(h => (
            <Text key={h.id} style={st.small}>
              {day(h.grantedAt)}: {h.grantedBy} allowed {Math.round((Date.parse(h.until) - Date.parse(h.grantedAt)) / 3_600_000)} h{h.reason ? ` ("${h.reason}")` : ''}
              {h.enteredAt ? `; ${h.enteredBy ?? 'support'} came in at ${time(h.enteredAt)}` : '; support did not come in'}
              {h.endedAt ? `; ended ${time(h.endedAt)}${h.endedBy ? ` by ${h.endedBy}` : ''}` : ''}.
            </Text>
          ))}
        </View>
      ) : null}
      <Text style={[st.small, { color: C.quiet }]}>Locked out of your own login? Phone Real Sandbox: they can send you a new setup code without coming in.</Text>
    </Card>
  );
}
