// The History (the Creator only): every change anyone made to the company's records, who and when,
// kept for good for in case of fraud. Nobody can change or delete it; the check shows whether
// anything was ever taken out or altered behind the app.
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Choice, Field, Notice, Pill, Select, st } from '../ui.tsx';
import { C, S } from '../theme.ts';

interface Entry { id: string; at: string; who: string; whoId: string | null; what: string; kind: string; op: 'add' | 'change' | 'delete'; opLabel: string; name: string; changes: { field: string; from: string; to: string }[] }
interface List { entries: Entry[]; people: { id: string; name: string; n: number }[]; kinds: { key: string; label: string; n: number }[]; since: string | null; total: number; more: number | null }
interface Detail extends Entry { fields: { field: string; before: string; after: string; changed: boolean }[]; fingerprint: string; record: Entry[] }

const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const TONE = { add: 'good', change: 'info', delete: 'bad' } as const;
type Days = 'today' | '7' | '30' | 'all';

export function HistoryPage() {
  const s = useStore();
  const [q, setQ] = useState('');
  const [days, setDays] = useState<Days>('7');
  const [who, setWho] = useState<string>('all');
  const [what, setWhat] = useState<string>('all');
  const [op, setOp] = useState<'all' | 'add' | 'change' | 'delete'>('all');
  const [d, setD] = useState<List | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; checked: number; problem: string | null; badAt: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [w, setW] = useState(0);
  const wide = w >= 900;

  const query = (before?: number | null) => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (days !== 'all') p.set('days', days === 'today' ? '1' : days);
    if (who !== 'all') p.set('who', who);
    if (what !== 'all') p.set('what', what);
    if (op !== 'all') p.set('op', op);
    if (before) p.set('before', String(before));
    return `/history?${p.toString()}`;
  };
  const load = async (more = false) => {
    const r = await s.ask({ method: 'GET', path: query(more ? d?.more : null) });
    if (!r) { setErr(['Needs signal.']); return; }
    if (r.status !== 200) { setErr(r.body?.reasons ?? [r.body?.error ?? 'Could not load']); return; }
    setErr(null);
    const b = r.body as List;
    setD(more && d ? { ...b, entries: [...d.entries, ...b.entries] } : b);
  };
  useEffect(() => { const t = setTimeout(() => load(), 300); return () => clearTimeout(t); }, [q, days, who, what, op]);
  const runCheck = async () => {
    setChecking(true);
    const r = await s.ask({ method: 'POST', path: '/history/check' });
    setChecking(false);
    if (r?.status === 200) setCheck(r.body);
    else setErr(r?.body?.reasons ?? ['Needs signal.']);
  };

  const list = (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: 10, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
      <Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>History</Text>
      <Text style={st.small}>Every change anyone made, who made it and when: added, changed and deleted, with what it was before. It is kept for good: nobody can change or delete it, not even you. Only you (the Creator) see this.</Text>
      <Card style={{ gap: 8 }}>
        <Text style={[st.body, { fontWeight: '800' }]}>Is everything still there?</Text>
        <Text style={st.small}>Each entry has its own fingerprint, and the entries are chained together, so if anyone took one out or changed one (even outside the app), the check shows where.</Text>
        <Button label="Check the history" kind="secondary" busy={checking} onPress={runCheck} />
        {check ? (check.ok
          ? <Notice tone="good" title={`All ${check.checked.toLocaleString('en-ZA')} entries are complete and unchanged`} lines={d?.since ? [`Kept since ${when(d.since)}.`] : []} />
          : <Notice tone="bad" title="The history was tampered with" lines={[`${check.problem ?? 'Something is wrong'}${check.badAt ? ` (around ${when(check.badAt)})` : ''}.`, 'Contact Real Sandbox support and your accountant: this is how fraud is found.']} />) : null}
      </Card>
      <Field label="Search" value={q} onChangeText={setQ} placeholder="A name, job or invoice number, part, amount…" autoCorrect={false} autoCapitalize="none" />
      <Choice options={['today', '7', '30', 'all'] as const} value={days} onChange={setDays} labels={{ today: 'Today', 7: '7 days', 30: '30 days', all: 'All' }} />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <View style={{ flexGrow: 1, flexBasis: 200 }}><Select label="Who" value={who} onChange={setWho} options={[{ value: 'all', label: 'Everyone' }, ...(d?.people ?? []).map(p => ({ value: p.id, label: `${p.name} (${p.n})` }))]} /></View>
        <View style={{ flexGrow: 1, flexBasis: 200 }}><Select label="What" value={what} onChange={setWhat} options={[{ value: 'all', label: 'Everything' }, ...(d?.kinds ?? []).map(k => ({ value: k.key, label: `${k.label} (${k.n})` }))]} /></View>
      </View>
      <Choice options={['all', 'add', 'change', 'delete'] as const} value={op} onChange={setOp} labels={{ all: 'All', add: 'Added', change: 'Changed', delete: 'Deleted' }} />
      {err ? <Notice tone="bad" title="Could not load" lines={err} /> : null}
      {!d ? <Body quiet>Loading…</Body> : !d.entries.length ? <Body quiet>Nothing found.</Body> : null}
      {d?.entries.map(e => (
        <Pressable key={e.id} onPress={() => setSel(e.id)} accessibilityRole="button" accessibilityLabel={`Entry ${e.opLabel} ${e.what} ${e.name}`}
          style={{ padding: 10, borderRadius: 10, borderWidth: 1, borderColor: sel === e.id && wide ? C.accent : C.line, backgroundColor: C.panel, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Pill text={e.opLabel} tone={TONE[e.op]} />
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]} numberOfLines={1}>{e.what}{e.name ? ` · ${e.name}` : ''}</Text>
          </View>
          <Text style={st.small}>{when(e.at)} · {e.who}</Text>
          {e.changes.slice(0, 3).map((c, i) => (
            <Text key={i} style={[st.small, { color: C.text }]} numberOfLines={1}>
              {c.field}: {e.op === 'change' ? `${c.from} → ${c.to}` : e.op === 'add' ? c.to : c.from}
            </Text>
          ))}
        </Pressable>
      ))}
      {d?.more ? <Button label="Show older" kind="quiet" onPress={() => load(true)} /> : null}
      {d ? <Text style={st.small}>{d.total.toLocaleString('en-ZA')} entries{d.since ? ` since ${when(d.since)}` : ''}.</Text> : null}
    </ScrollView>
  );
  const detail = sel ? <EntryDetail key={sel} id={sel} open={setSel} close={() => setSel(null)} back={!wide} /> : null;
  return (
    <View style={{ flex: 1 }} onLayout={e => setW(e.nativeEvent.layout.width)}>
      {wide ? (
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ width: 520, borderRightWidth: 1, borderRightColor: C.line }}>{list}</View>
          <View style={{ flex: 1 }}>{detail ?? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Body quiet>Choose an entry to see everything about it.</Body></View>}</View>
        </View>
      ) : detail ?? list}
    </View>
  );
}

function EntryDetail({ id, open, close, back }: { id: string; open: (id: string) => void; close: () => void; back: boolean }) {
  const s = useStore();
  const [d, setD] = useState<Detail | null>(null);
  useEffect(() => { s.ask({ method: 'GET', path: `/history/${id}` }).then(r => { if (r?.status === 200) setD(r.body as Detail); }); }, [id]);
  if (!d) return <View style={{ padding: S.pad }}><Body quiet>Loading…</Body></View>;
  return (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: 10, paddingBottom: 60, maxWidth: 860 }}>
      {back ? <Button label="‹ Back to the history" kind="quiet" onPress={close} /> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Pill text={d.opLabel} tone={TONE[d.op]} />
        <Text style={{ color: C.text, fontSize: 22, fontWeight: '800', flex: 1 }}>{d.what}{d.name ? ` · ${d.name}` : ''}</Text>
      </View>
      <Text style={st.body}>{when(d.at)} by <Text style={{ fontWeight: '800' }}>{d.who}</Text></Text>
      <Card style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Text style={[st.small, { flex: 1, fontWeight: '800' }]}>FIELD</Text>
          {d.op !== 'add' ? <Text style={[st.small, { flex: 1.3, fontWeight: '800' }]}>BEFORE</Text> : null}
          {d.op !== 'delete' ? <Text style={[st.small, { flex: 1.3, fontWeight: '800' }]}>{d.op === 'add' ? 'WHAT WAS ADDED' : 'AFTER'}</Text> : null}
        </View>
        {d.fields.map((f, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 8, paddingVertical: 4, borderTopWidth: 1, borderTopColor: C.line, backgroundColor: f.changed && d.op === 'change' ? 'rgba(240,122,26,0.12)' : 'transparent' }}>
            <Text style={[st.small, { flex: 1 }]}>{f.field}</Text>
            {d.op !== 'add' ? <Text selectable style={[st.small, { flex: 1.3, color: C.text }]}>{f.before}</Text> : null}
            {d.op !== 'delete' ? <Text selectable style={[st.small, { flex: 1.3, color: C.text, fontWeight: f.changed && d.op === 'change' ? '800' : '400' }]}>{f.after}</Text> : null}
          </View>
        ))}
      </Card>
      {d.record.length > 1 ? (
        <>
          <Text style={[st.small, { fontWeight: '800', letterSpacing: 0.5 }]}>EVERYTHING THAT HAPPENED TO THIS {d.what.toUpperCase()}</Text>
          {d.record.map(e => (
            <Pressable key={e.id} onPress={() => open(e.id)} accessibilityRole="button" style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <Pill text={e.opLabel} tone={TONE[e.op]} />
              <Text style={[st.small, { flex: 1, color: e.id === d.id ? C.accent : C.text }]}>{when(e.at)} · {e.who}{e.changes[0] && e.op === 'change' ? ` · ${e.changes[0].field}: ${e.changes[0].from} → ${e.changes[0].to}` : ''}</Text>
            </Pressable>
          ))}
        </>
      ) : null}
      <Text selectable style={[st.small, { color: C.quiet }]}>Fingerprint {d.fingerprint.slice(0, 16)}…</Text>
    </ScrollView>
  );
}
