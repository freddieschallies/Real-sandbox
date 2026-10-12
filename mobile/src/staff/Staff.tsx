// Staff records (issues, warnings, commendations: CEO and HR only) and each person's tools and PPE
// (kept by the stockroom, visible to the office and to the person).
import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, Stepper, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { Avatar } from '../office/Profile.tsx';
import type { Holding } from '../stockroom/useStockroom.ts';

const day = (s: string) => new Date(s.length === 10 ? `${s}T12:00:00+02:00` : s).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['no signal: try again'];

// ---- Staff record -------------------------------------------------------------------------------

interface Entry { id: string; entry_type: string; typeLabel: string; happened_on: string; what_happened: string; action_taken: string | null; reason: string | null; corrects_entry_id: string | null; job_number: number | null; author: string; created_at: string }
interface Record_ {
  canWrite: boolean; types: { key: string; label: string; warning: boolean }[];
  summary: { issues: number; verbal: number; written: number; final: number; commendations: number };
  entries: Entry[]; deletions: { entry_happened_on: string; deleted_at: string; deleted_by: string }[];
}
const tone = (t: string): 'bad' | 'warn' | 'good' | 'quiet' => (t === 'final_written_warning' || t === 'written_warning' ? 'bad' : t === 'verbal_warning' ? 'warn' : t === 'commendation' ? 'good' : 'quiet');

export function StaffRecord({ userId, name }: { userId: string; name: string }) {
  const s = useStore();
  const [r, setR] = useState<Record_ | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = async () => {
    const x = await s.ask({ method: 'GET', path: `/people/${userId}/record` });
    if (x?.status === 200) { setR(x.body); setErr(null); } else setErr(reasons(x).join('; '));
  };
  useEffect(() => { load(); }, [userId]);
  const first = name.split(' ')[0];
  if (err) return <Card><Label>Staff record</Label><Body quiet>{err}</Body></Card>;
  if (!r) return <Card><Label>Staff record</Label><Body quiet>Loading…</Body></Card>;
  const sm = r.summary;
  return (
    <Card>
      <Label>Staff record (only the CEO and HR see this)</Label>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Pill text={`${sm.issues} issue${sm.issues === 1 ? '' : 's'}`} tone="quiet" />
        {sm.verbal ? <Pill text={`${sm.verbal} verbal warning${sm.verbal > 1 ? 's' : ''}`} tone="warn" /> : null}
        {sm.written ? <Pill text={`${sm.written} written warning${sm.written > 1 ? 's' : ''}`} tone="bad" /> : null}
        {sm.final ? <Pill text={`${sm.final} final warning${sm.final > 1 ? 's' : ''}`} tone="bad" /> : null}
        {sm.commendations ? <Pill text={`${sm.commendations} commendation${sm.commendations > 1 ? 's' : ''}`} tone="good" /> : null}
      </View>
      {r.canWrite && !adding ? <Button label={`Add to ${first}'s record`} kind="secondary" onPress={() => setAdding(true)} /> : null}
      {adding ? <AddEntry userId={userId} types={r.types} done={() => { setAdding(false); load(); }} /> : null}
      {r.entries.map(e => (
        <View key={e.id} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingVertical: 10, gap: 4 }} accessibilityLabel={`Record ${e.typeLabel} ${e.happened_on}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pill text={e.typeLabel} tone={tone(e.entry_type)} />
            <Text style={[st.small, { flex: 1 }]}>{day(e.happened_on)}{e.job_number ? ` · job ${e.job_number}` : ''}</Text>
          </View>
          <Text style={st.body}>{e.what_happened}</Text>
          {e.action_taken ? <Text style={st.small}>Action taken: {e.action_taken}</Text> : null}
          {e.reason ? <Text style={st.small}>Reason: {e.reason}</Text> : null}
          <Text style={st.small}>Recorded by {e.author}, {day(e.created_at)}</Text>
          {r.canWrite ? (confirm === e.id ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button label="Yes, delete it" kind="danger" style={{ flex: 1 }} onPress={async () => {
                const x = await s.ask({ method: 'DELETE', path: `/people/${userId}/record/${e.id}` });
                setConfirm(null); if (x && x.status < 300) load(); else setErr(reasons(x).join('; '));
              }} />
              <Button label="Keep it" kind="quiet" style={{ flex: 1 }} onPress={() => setConfirm(null)} />
            </View>
          ) : (
            <Pressable onPress={() => setConfirm(e.id)} accessibilityRole="button" accessibilityLabel={`Delete record from ${e.happened_on}`}>
              <Text style={[st.small, { color: C.bad, textDecorationLine: 'underline' }]}>Delete this record</Text>
            </Pressable>
          )) : null}
        </View>
      ))}
      {!r.entries.length ? <Body quiet>Nothing on {first}'s record.</Body> : null}
      {r.deletions.map((d, i) => (
        <Text key={i} style={[st.small, { fontStyle: 'italic' }]}>A record from {day(d.entry_happened_on)} was deleted by {d.deleted_by} on {day(d.deleted_at)}.</Text>
      ))}
    </Card>
  );
}

function AddEntry({ userId, types, done }: { userId: string; types: Record_['types']; done: () => void }) {
  const s = useStore();
  const [type, setType] = useState<string>('observation');
  const [date, setDate] = useState(todayIso());
  const [what, setWhat] = useState('');
  const [action, setAction] = useState('');
  const [why, setWhy] = useState('');
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const warning = types.find(t => t.key === type)?.warning;
  return (
    <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 10 }}>
      <Heading>New record</Heading>
      <Choice options={types.map(t => t.key)} value={type} onChange={setType} labels={Object.fromEntries(types.map(t => [t.key, t.label]))} />
      <Field label="Date it happened (YYYY-MM-DD)" value={date} onChangeText={setDate} />
      <Field label="What happened" value={what} onChangeText={setWhat} multiline />
      {warning ? (
        <>
          <Field label="Action taken" value={action} onChangeText={setAction} placeholder="e.g. Written warning, valid 6 months" />
          <Field label="Reason" value={why} onChangeText={setWhy} multiline />
          <Text style={st.small}>A warning must say what was done and why (Code of Good Practice: Dismissal).</Text>
        </>
      ) : null}
      {err ? <Notice tone="bad" title="Not saved. Still needed:" lines={err} /> : null}
      <Button label="Save to the record" busy={busy} onPress={async () => {
        setBusy(true);
        const x = await s.ask({ method: 'POST', path: `/people/${userId}/record`, json: { type, happenedOn: date.trim() || undefined, whatHappened: what.trim(),
          ...(warning ? { actionTaken: action.trim() || undefined, reason: why.trim() || undefined } : {}) } });
        setBusy(false);
        if (x && x.status < 300) done(); else setErr(reasons(x));
      }} />
      <Button label="Cancel" kind="quiet" onPress={done} />
    </View>
  );
}

// ---- Tools and PPE ------------------------------------------------------------------------------

interface KitItem { id: string; kind: 'tool' | 'ppe'; name: string; detail: string | null; qty: number; stock_code: string | null; replace_by: string | null; issued_at: string; issued_by: string; status: string; closed_at: string | null; closed_by: string | null; close_note: string | null; due?: boolean }
interface Kit { held: KitItem[]; history: KitItem[]; dueForReplacement: number; canWrite: boolean }
interface StockPick { id: string; code: string; description: string; inStockroom: number; category?: string }

export function useKit(path: string) {
  const s = useStore();
  const [k, setK] = useState<Kit | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => { const x = await s.ask({ method: 'GET', path }); if (x?.status === 200) { setK(x.body); setErr(null); } else setErr(reasons(x).join('; ')); };
  useEffect(() => { load(); }, [path]);
  return { k, err, load };
}

export function KitCard({ userId, name, mine, onChange, between, title }: { userId: string; name: string; mine?: boolean; onChange?: () => void; between?: React.ReactNode; title?: string }) {
  const kit = useKit(mine ? '/me/kit' : `/people/${userId}/kit`);
  const { k, err } = kit;
  const load = () => { kit.load(); onChange?.(); };
  const [issuing, setIssuing] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const first = name.split(' ')[0];
  if (err) return <Card><Label>Tools and PPE</Label><Body quiet>{err}</Body></Card>;
  if (!k) return <Card><Label>Tools and PPE</Label><Body quiet>Loading…</Body></Card>;
  const group = (kind: 'tool' | 'ppe') => k.held.filter(i => i.kind === kind);
  const row = (i: KitItem) => (
    <View key={i.id} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingVertical: 8, gap: 2 }} accessibilityLabel={`Kit ${i.name}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.body, { fontWeight: '700', flex: 1 }]}>{i.name}{i.qty !== 1 ? ` × ${i.qty}` : ''}</Text>
        {i.due ? <Pill text="Replace now" tone="warn" /> : null}
      </View>
      <Text style={st.small}>{[i.detail, i.stock_code, `issued ${day(i.issued_at)} by ${i.issued_by}`, i.replace_by ? `replace by ${day(i.replace_by)}` : null].filter(Boolean).join(' · ')}</Text>
      {k.canWrite ? (closing === i.id ? <CloseKit item={i} done={() => { setClosing(null); load(); }} />
        : <Pressable onPress={() => setClosing(i.id)} accessibilityRole="button" accessibilityLabel={`Return ${i.name}`}><Text style={[st.small, { color: C.info, textDecorationLine: 'underline' }]}>Returned, lost or damaged…</Text></Pressable>) : null}
    </View>
  );
  return (
    <Card>
      <Label>{title ?? (mine ? 'My tools and PPE' : `Tools and PPE on ${first}'s name`)}</Label>
      {k.dueForReplacement ? <Notice tone="warn" title={`${k.dueForReplacement} item${k.dueForReplacement > 1 ? 's' : ''} due for replacement`} /> : null}
      <Text style={[st.body, { fontWeight: '800' }]}>PPE ({group('ppe').length})</Text>
      {group('ppe').map(row)}
      {!group('ppe').length ? <Body quiet>No PPE on record.</Body> : null}
      {between}
      <Text style={[st.body, { fontWeight: '800', marginTop: 6 }]}>Tools ({group('tool').length})</Text>
      {group('tool').map(row)}
      {!group('tool').length ? <Body quiet>No tools on record.</Body> : null}
      {k.canWrite && !issuing ? <Button label={`Issue a tool or PPE to ${first}`} kind="secondary" onPress={() => setIssuing(true)} /> : null}
      {issuing ? <IssueKit userId={userId} done={() => { setIssuing(false); load(); }} /> : null}
      {k.history.length ? (
        <Pressable onPress={() => setShowHistory(v => !v)} accessibilityRole="button"><Text style={[st.small, { textDecorationLine: 'underline' }]}>{showHistory ? 'Hide' : 'Show'} history ({k.history.length})</Text></Pressable>
      ) : null}
      {showHistory ? k.history.map(i => (
        <Text key={i.id} style={st.small}>{i.name}{i.qty !== 1 ? ` × ${i.qty}` : ''}: {i.status} {i.closed_at ? day(i.closed_at) : ''}{i.closed_by ? ` (${i.closed_by})` : ''}{i.close_note ? ` – ${i.close_note}` : ''}</Text>
      )) : null}
      {mine ? <Text style={st.small}>The stockroom keeps this list. Tell them if something is missing, broken or worn out.</Text> : null}
    </Card>
  );
}

function IssueKit({ userId, done }: { userId: string; done: () => void }) {
  const s = useStore();
  const [kind, setKind] = useState<'ppe' | 'tool'>('ppe');
  const [items, setItems] = useState<StockPick[]>([]);
  const [pick, setPick] = useState<StockPick | null>(null);
  const [find, setFind] = useState('');
  const [name, setName] = useState('');
  const [detail, setDetail] = useState('');
  const [qty, setQty] = useState(1);
  const [replaceBy, setReplaceBy] = useState('');
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { s.ask({ method: 'GET', path: '/stock/stockroom' }).then(r => { if (r?.status === 200) setItems(r.body); }); }, []);
  const words = find.toLowerCase().split(/\s+/).filter(Boolean);
  const list = items.filter(i => (i.category ?? 'stock') === kind && words.every(w => `${i.code} ${i.description}`.toLowerCase().includes(w))).slice(0, 12);
  return (
    <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 10 }}>
      <Heading>Issue</Heading>
      <Choice options={['ppe', 'tool'] as const} value={kind} onChange={k => { setKind(k); setPick(null); }} labels={{ ppe: 'PPE', tool: 'Tool' }} />
      <Label>From the stockroom's {kind === 'ppe' ? 'PPE' : 'tools'}</Label>
      <TextInput value={find} onChangeText={setFind} placeholder="Search" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search stock" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {list.map(i => (
          <Pressable key={i.id} onPress={() => setPick(pick?.id === i.id ? null : i)} accessibilityRole="radio" accessibilityState={{ checked: pick?.id === i.id }}
            style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 2, borderColor: pick?.id === i.id ? C.accent : C.line, opacity: i.inStockroom > 0 ? 1 : 0.5 }}>
            <Text style={{ color: C.text }}>{i.description} ({i.inStockroom})</Text>
          </Pressable>
        ))}
      </View>
      {!list.length ? <Text style={st.small}>No {kind === 'ppe' ? 'PPE' : 'tools'} in the stockroom yet. Type what it is below, or set an item's category to {kind === 'ppe' ? 'PPE' : 'Tool'} in the Stock tab.</Text> : null}
      {!pick ? <Field label="Or type what it is (not from stock)" value={name} onChangeText={setName} placeholder={kind === 'ppe' ? 'e.g. Safety harness' : 'e.g. Fluke multimeter'} /> : null}
      <Field label={kind === 'ppe' ? 'Size or make' : 'Serial number or make'} value={detail} onChangeText={setDetail} />
      <Stepper label="How many" value={qty} onChange={setQty} />
      <Field label="Replace by (YYYY-MM-DD, optional)" value={replaceBy} onChangeText={setReplaceBy} />
      {err ? <Notice tone="bad" title="Not issued" lines={err} /> : null}
      <Button label="Issue" busy={busy} onPress={async () => {
        setBusy(true);
        const x = await s.ask({ method: 'POST', path: `/people/${userId}/kit`, json: { kind, qty, ...(pick ? { stockItemId: pick.id } : { name: name.trim() }), ...(detail.trim() ? { detail: detail.trim() } : {}), ...(replaceBy.trim() ? { replaceBy: replaceBy.trim() } : {}) } });
        setBusy(false);
        if (x && x.status < 300) done(); else setErr(reasons(x));
      }} />
      <Button label="Cancel" kind="quiet" onPress={done} />
    </View>
  );
}

function CloseKit({ item, done }: { item: KitItem; done: () => void }) {
  const s = useStore();
  const [status, setStatus] = useState<'returned' | 'lost' | 'damaged'>('returned');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string[] | null>(null);
  return (
    <View style={{ gap: 8, paddingTop: 6 }}>
      <Choice options={['returned', 'lost', 'damaged'] as const} value={status} onChange={setStatus} labels={{ returned: 'Returned', lost: 'Lost', damaged: 'Damaged' }} />
      <Field label={status === 'returned' ? 'Note (optional)' : `How was it ${status}?`} value={note} onChangeText={setNote} />
      {status === 'returned' && item.stock_code ? <Text style={st.small}>It goes back into the stockroom.</Text> : null}
      {err ? <Notice tone="bad" title="Not saved" lines={err} /> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label="Save" style={{ flex: 1 }} onPress={async () => {
          const x = await s.ask({ method: 'POST', path: `/kit/${item.id}/close`, json: { status, ...(note.trim() ? { note: note.trim() } : {}) } });
          if (x && x.status < 300) done(); else setErr(reasons(x));
        }} />
        <Button label="Cancel" kind="quiet" style={{ flex: 1 }} onPress={done} />
      </View>
    </View>
  );
}

/** The stockroom's People tab: names with their PPE, stock and tools. Nothing personal. */
export interface StockPerson { id: string; full_name: string; login_level: string; position: string; tradeLabel: string | null; photo_id: string | null; tools: number; ppe: number; stock: number; due: number }
export function KitPeople({ open, selected, tick = 0 }: { open: (p: StockPerson) => void; selected: string | null; tick?: number }) {
  const s = useStore();
  const [list, setList] = useState<StockPerson[] | null>(null);
  const [find, setFind] = useState('');
  useEffect(() => { s.ask({ method: 'GET', path: '/kit/people' }).then(r => { if (r?.status === 200) setList(r.body); }); }, [selected, tick]);
  const words = find.toLowerCase().split(/\s+/).filter(Boolean);
  return (
    <>
      <TextInput value={find} onChangeText={setFind} placeholder="Search name" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search people" />
      {(list ?? []).filter(p => words.every(w => `${p.full_name} ${p.position} ${p.tradeLabel ?? ''}`.toLowerCase().includes(w))).map(p => (
        <Card key={p.id} onPress={() => open(p)} accessibilityLabel={`Person ${p.full_name}`} style={selected === p.id ? { borderColor: C.accent, borderWidth: 2 } : undefined}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Avatar id={p.photo_id} name={p.full_name} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={[st.body, { fontWeight: '700' }]}>{p.full_name}</Text>
              <Text style={st.small}>{p.tradeLabel ?? p.position} · {p.ppe} PPE · {p.stock} stock · {p.tools} tool{p.tools === 1 ? '' : 's'}</Text>
            </View>
            {p.due ? <Pill text={`${p.due} to replace`} tone="warn" /> : null}
          </View>
        </Card>
      ))}
      {!list ? <Body quiet>Loading…</Body> : null}
    </>
  );
}

/** One person as the stockroom sees them: name, PPE, the stock they hold, tools. */
export function StockPersonView({ p, holdings, onChange }: { p: StockPerson; holdings: Holding[]; onChange?: () => void }) {
  const mine = holdings.filter(h => h.technicianId === p.id || h.technician === p.full_name);
  const back = mine.filter(h => h.mustReturn);
  const stock = (
    <>
      <Text style={[st.body, { fontWeight: '800', marginTop: 6 }]}>Stock ({mine.reduce((n, h) => n + h.qty, 0)})</Text>
      {back.length ? <Notice tone="bad" title={`${back.reduce((n, h) => n + h.qty, 0)} to bring back`} lines={['Left over from closed jobs.']} /> : null}
      {mine.map((h, i) => (
        <View key={i} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingVertical: 8, flexDirection: 'row', gap: 8, alignItems: 'center' }} accessibilityLabel={`Stock ${h.code}`}>
          <View style={{ flex: 1 }}>
            <Text style={[st.body, { fontWeight: '700' }]}>{h.description}</Text>
            <Text style={st.small}>{h.code} · {h.jobNumber ? `job ${h.jobNumber}${h.store ? `, ${h.store}` : ''}` : 'van stock'}{h.pendingReturn ? ` · ${h.pendingReturn} on the way back` : ''}</Text>
          </View>
          {h.mustReturn ? <Pill text="Bring back" tone="bad" /> : null}
          <Text style={{ color: C.text, fontSize: 20, fontWeight: '800' }}>{h.qty}</Text>
        </View>
      ))}
      {!mine.length ? <Body quiet>No stock on {p.full_name.split(' ')[0]}.</Body> : null}
    </>
  );
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
        <Avatar id={p.photo_id} name={p.full_name} size={72} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>{p.full_name}</Text>
          <Text style={st.body}>{[p.position, p.tradeLabel].filter(Boolean).join(' · ')}</Text>
        </View>
      </View>
      <KitCard userId={p.id} name={p.full_name} title="PPE, stock and tools" between={stock} onChange={onChange} />
    </>
  );
}
