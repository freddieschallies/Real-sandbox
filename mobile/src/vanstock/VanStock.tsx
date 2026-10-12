// Van stock: the department manager's list (bill of quantities) of spares every technician in his
// department must carry, each technician's van against it, and the stockroom topping vans up.
import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Heading, Label, Notice, Pill, Select, Stepper, st } from '../ui.tsx';
import { C } from '../theme.ts';

interface VanLine { stockItemId: string; code: string; description: string; unit: string; need: number; have: number; short: number }
export interface VanReport {
  technicianId: string; name: string; departmentId: string | null; department: string | null; manager: string | null;
  hasList: boolean; complete: boolean; shortLines: number; lines: VanLine[];
  extra: { stockItemId: string; code: string; description: string; unit: string; have: number }[]; canIssue: boolean;
}
interface ListDept {
  id: string; name: string; manager: string | null; canEdit: boolean;
  lines: { stockItemId: string; code: string; description: string; unit: string; qty: number }[];
  techs: { id: string; full_name: string; complete: boolean; shortLines: number }[];
}
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['no signal: try again'];
const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function VanPill({ complete, shortLines, hasList = true }: { complete: boolean; shortLines: number; hasList?: boolean }) {
  if (!hasList) return <Pill text="No van list" tone="quiet" />;
  return complete ? <Pill text="Van complete" tone="good" /> : <Pill text={`Van short: ${shortLines} line${shortLines > 1 ? 's' : ''}`} tone="bad" />;
}

/** One technician's van against his department's list; the stockroom can top it up here. */
export function VanCard({ userId, mine, onChange }: { userId: string; mine?: boolean; onChange?: () => void }) {
  const s = useStore();
  const [r, setR] = useState<VanReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; lines: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [extra, setExtra] = useState(false);
  const load = async () => {
    const x = await s.ask({ method: 'GET', path: mine ? '/me/van' : `/van-stock/technicians/${userId}` });
    if (x?.status === 200) { setR(x.body); setErr(null); setQty(Object.fromEntries((x.body as VanReport).lines.filter(l => l.short > 0).map(l => [l.stockItemId, l.short]))); }
    else setErr(reasons(x).join('; '));
  };
  useEffect(() => { load(); }, [userId]);
  if (err) return <Card><Label>Van stock</Label><Body quiet>{err}</Body></Card>;
  if (!r) return <Card><Label>Van stock</Label><Body quiet>Loading…</Body></Card>;
  const first = r.name?.split(' ')[0] ?? '';
  const toIssue = Object.entries(qty).filter(([, n]) => n > 0).map(([stockItemId, n]) => ({ stockItemId, qty: n }));
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[st.label, { flex: 1 }]}>{mine ? 'My van stock' : 'Van stock'}{r.department ? ` · ${r.department} list` : ''}</Text>
        <VanPill complete={r.complete} shortLines={r.shortLines} hasList={r.hasList} />
      </View>
      {!r.department ? <Body quiet>{mine ? 'You are' : `${first} is`} not in a department yet, so there is no van stock list. The CEO puts technicians under a department manager.</Body>
        : !r.hasList ? <Body quiet>{r.manager ?? 'The department manager'} has not set the {r.department} van stock list yet.</Body> : null}
      {r.lines.map(l => (
        <View key={l.stockItemId} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingVertical: 8, gap: 6 }} accessibilityLabel={`Van ${l.code}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={[st.body, { fontWeight: '700' }]}>{l.description}</Text>
              <Text style={st.small}>{l.code} · must carry {l.need} {l.unit}</Text>
            </View>
            <Text style={{ color: l.short > 0 ? C.bad : C.good, fontSize: 20, fontWeight: '800' }}>{l.have}/{l.need}</Text>
          </View>
          {l.short > 0 && r.canIssue ? <Stepper label={`Put on ${first}'s van`} value={qty[l.stockItemId] ?? 0} onChange={n => setQty(q => ({ ...q, [l.stockItemId]: n }))} /> : null}
        </View>
      ))}
      {r.canIssue && toIssue.length ? (
        <Button label={`Put ${toIssue.reduce((n, l) => n + l.qty, 0)} on ${first}'s van`} busy={busy} onPress={async () => {
          setBusy(true);
          const x = await s.ask({ method: 'POST', path: `/van-stock/technicians/${userId}/issue`, json: { lines: toIssue } });
          setBusy(false);
          if (x && x.status < 300) { setMsg({ tone: 'good', lines: [(x.body as VanReport).complete ? 'His van is complete. The flag is closed.' : 'Issued. Still short of some lines.'] }); load(); onChange?.(); }
          else setMsg({ tone: 'bad', lines: reasons(x) });
        }} />
      ) : null}
      {msg ? <Notice tone={msg.tone} title={msg.tone === 'good' ? 'Done' : 'Not issued'} lines={msg.lines} /> : null}
      {!r.complete && !r.canIssue && r.hasList ? <Text style={st.small}>Flagged until it is complete. The stockroom tops it up{mine ? '; or book it out for a job.' : '.'}</Text> : null}
      {r.extra.length ? (
        <Pressable onPress={() => setExtra(v => !v)} accessibilityRole="button"><Text style={[st.small, { textDecorationLine: 'underline' }]}>{extra ? 'Hide' : 'Show'} other van stock, not on the list ({r.extra.length})</Text></Pressable>
      ) : null}
      {extra ? r.extra.map(e => <Text key={e.stockItemId} style={st.small}>{e.description} ({e.code}): {e.have} {e.unit}</Text>) : null}
    </Card>
  );
}

/** The manager's (and CEO's) van stock lists: one per department, with every technician's van. */
export function VanLists({ openTech }: { openTech?: (id: string) => void }) {
  const s = useStore();
  const [d, setD] = useState<ListDept[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => { const x = await s.ask({ method: 'GET', path: '/van-stock' }); if (x?.status === 200) { setD(x.body.departments); setErr(null); } else setErr(reasons(x).join('; ')); };
  useEffect(() => { load(); }, []);
  if (err) return <Body quiet>{err}</Body>;
  if (!d) return <Body quiet>Loading…</Body>;
  return (
    <>
      <Text style={st.small}>The spares every technician in the department must carry. A van short of its list is flagged until the stockroom tops it up.</Text>
      {d.map(x => <DeptList key={x.id} d={x} reload={load} openTech={openTech} />)}
      {!d.length ? <Body quiet>No departments yet. The CEO sets them up under People.</Body> : null}
    </>
  );
}

function DeptList({ d, reload, openTech }: { d: ListDept; reload: () => void; openTech?: (id: string) => void }) {
  const s = useStore();
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  const [hist, setHist] = useState<{ changed_at: string; by: string; description: string; old_qty: number | null; new_qty: number | null }[] | null>(null);
  const set = async (stockItemId: string, qty: number) => {
    const x = await s.ask({ method: 'PUT', path: `/van-stock/departments/${d.id}/items/${stockItemId}`, json: { qty } });
    if (x && x.status < 300) { setErr(null); reload(); } else setErr(reasons(x));
  };
  const short = d.techs.filter(t => !t.complete);
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.text, fontSize: 20, fontWeight: '800' }}>{d.name}</Text>
          <Text style={st.small}>{d.manager ? `Manager: ${d.manager}` : 'No manager yet'} · {d.techs.length} technician{d.techs.length === 1 ? '' : 's'}</Text>
        </View>
        {d.lines.length ? (short.length ? <Pill text={`${short.length} van${short.length > 1 ? 's' : ''} short`} tone="bad" /> : <Pill text="All vans complete" tone="good" />) : null}
      </View>
      <Label>Technicians</Label>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {d.techs.map(t => (
          <Pressable key={t.id} onPress={() => openTech?.(t.id)} accessibilityRole="button" accessibilityLabel={`Van of ${t.full_name}`}
            style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 2, borderColor: !d.lines.length ? C.line : t.complete ? C.good : C.bad }}>
            <Text style={{ color: C.text, fontWeight: '700' }}>{t.full_name}{d.lines.length && !t.complete ? ` · ${t.shortLines} short` : ''}</Text>
          </Pressable>
        ))}
        {!d.techs.length ? <Text style={st.small}>No technicians in {d.name} yet.</Text> : null}
      </View>
      <Label>Van stock list ({d.lines.length} item{d.lines.length === 1 ? '' : 's'})</Label>
      {d.lines.map(l => (
        <View key={l.stockItemId} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderTopColor: C.line, paddingVertical: 6 }} accessibilityLabel={`List ${l.code}`}>
          <View style={{ flex: 1 }}>
            <Text style={[st.body, { fontWeight: '700' }]}>{l.description}</Text>
            <Text style={st.small}>{l.code} · {l.unit}</Text>
          </View>
          {d.canEdit ? <Stepper label={`How many ${l.code}`} value={l.qty} onChange={n => set(l.stockItemId, n)} /> : <Text style={{ color: C.text, fontSize: 20, fontWeight: '800' }}>{l.qty}</Text>}
        </View>
      ))}
      {!d.lines.length ? <Body quiet>{d.canEdit ? 'Add the spares every technician in this department must carry.' : 'No list yet.'}</Body> : null}
      {err ? <Notice tone="bad" title="Not saved" lines={err} /> : null}
      {d.canEdit && !adding ? <Button label="Add an item to the list" kind="secondary" onPress={() => setAdding(true)} /> : null}
      {adding ? <AddLine have={d.lines.map(l => l.stockItemId)} done={async (id, n) => { if (id) await set(id, n); setAdding(false); }} /> : null}
      {d.canEdit ? <Text style={st.small}>Setting an item to 0 takes it off the list. Every change is kept.</Text> : null}
      <Pressable onPress={async () => { if (hist) { setHist(null); return; } const x = await s.ask({ method: 'GET', path: `/van-stock/departments/${d.id}/changes` }); if (x?.status === 200) setHist(x.body); }} accessibilityRole="button">
        <Text style={[st.small, { textDecorationLine: 'underline' }]}>{hist ? 'Hide changes' : 'Show changes to the list'}</Text>
      </Pressable>
      {hist ? hist.map((h, i) => <Text key={i} style={st.small}>{when(h.changed_at)} · {h.by}: {h.description} {h.old_qty ?? 0} → {h.new_qty ?? 0}</Text>) : null}
      {hist && !hist.length ? <Text style={st.small}>No changes yet.</Text> : null}
    </Card>
  );
}

function AddLine({ have, done }: { have: string[]; done: (id: string | null, qty: number) => void }) {
  const s = useStore();
  const [items, setItems] = useState<{ id: string; code: string; description: string; unit: string }[]>([]);
  const [find, setFind] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  useEffect(() => { s.ask({ method: 'GET', path: '/stock/catalogue' }).then(r => { if (r?.status === 200) setItems(r.body); }); }, []);
  const words = find.toLowerCase().split(/\s+/).filter(Boolean);
  const list = items.filter(i => !have.includes(i.id) && words.every(w => `${i.code} ${i.description}`.toLowerCase().includes(w))).slice(0, 15);
  return (
    <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8 }}>
      <Heading>Add to the list</Heading>
      <TextInput value={find} onChangeText={setFind} placeholder="Search stock" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search stock" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {list.map(i => (
          <Pressable key={i.id} onPress={() => setPick(i.id)} accessibilityRole="radio" accessibilityState={{ checked: pick === i.id }}
            style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 2, borderColor: pick === i.id ? C.accent : C.line }}>
            <Text style={{ color: C.text }}>{i.description}</Text>
          </Pressable>
        ))}
      </View>
      <Stepper label="Each technician carries" value={qty} onChange={setQty} />
      <Button label="Add" disabled={!pick || qty <= 0} onPress={() => done(pick, qty)} />
      <Button label="Cancel" kind="quiet" onPress={() => done(null, 0)} />
    </View>
  );
}

/** On a person's profile: which department he is in (under which manager), or which he manages. */
export function DepartmentCard({ userId, departmentId, level, name, canManage, team, reload }: {
  userId: string; departmentId: string | null; level: string; name: string; canManage: boolean; team: { id: string; full_name: string; department: string }[]; reload: () => void;
}) {
  const s = useStore();
  const [d, setD] = useState<{ departments: { id: string; name: string; manager_id: string | null; manager: string | null; technicians: number }[]; managers: { id: string; full_name: string }[] } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; lines: string[] } | null>(null);
  const load = async () => { const x = await s.ask({ method: 'GET', path: '/departments' }); if (x?.status === 200) setD(x.body); };
  useEffect(() => { load(); }, [userId]);
  const first = name.split(' ')[0];
  const isManager = ['management', 'director', 'creator'].includes(level);
  const after = async (x: { status: number; body: unknown } | null | undefined, ok: string) => {
    if (x && x.status < 300) { setMsg({ tone: 'good', lines: [ok] }); await load(); reload(); } else setMsg({ tone: 'bad', lines: reasons(x) });
  };
  if (!d) return null;
  const managed = d.departments.filter(x => x.manager_id === userId);
  return (
    <Card>
      <Label>{isManager ? 'Department' : 'Works under'}</Label>
      {level === 'technician' ? (
        canManage ? (
          <Select label="Department and manager" value={departmentId ?? undefined} placeholder="Not in a department yet"
            options={d.departments.map(x => ({ value: x.id, label: `${x.name}${x.manager ? ` · ${x.manager}` : ' · no manager yet'}` }))}
            onChange={async v => after(await s.ask({ method: 'PUT', path: `/access/users/${userId}/department`, json: { departmentId: v } }), `${first} now works in ${d.departments.find(x => x.id === v)?.name}`)} />
        ) : (() => { const cur = d.departments.find(x => x.id === departmentId); return <Text style={st.body}>{cur ? `${cur.name}${cur.manager ? `, under ${cur.manager}` : ''}` : 'Not in a department yet'}</Text>; })()
      ) : null}
      {isManager ? (
        <>
          {managed.length ? managed.map(x => <Text key={x.id} style={st.body}>Runs {x.name} ({x.technicians} technician{x.technicians === 1 ? '' : 's'})</Text>) : <Body quiet>{first} does not run a department yet.</Body>}
          {team.length ? <Text style={st.small}>Technicians under {first}: {team.map(t => t.full_name).join(', ')}</Text> : null}
          {canManage && level === 'management' ? (
            <Select label="Runs department" value={managed[0]?.id ?? ''} placeholder="None yet"
              options={[...d.departments.map(x => ({ value: x.id, label: `${x.name}${x.manager && x.manager_id !== userId ? ` (now ${x.manager})` : ''}` })), { value: '', label: 'None' }]}
              onChange={async v => {
                const x = await s.ask({ method: 'PUT', path: `/access/users/${userId}/department`, json: { departmentId: v || null } });
                const rep = (x?.body as { replaced?: string | null })?.replaced;
                await after(x, v ? `${first} now runs ${d.departments.find(y => y.id === v)?.name}${rep ? `; ${rep} no longer does` : ''}` : `${first} runs no department now`);
              }} />
          ) : null}
          {canManage ? <Text style={st.small}>A department manager runs one department. Set up departments on the Departments tab.</Text> : null}
        </>
      ) : null}
      {msg ? <Notice tone={msg.tone} title={msg.tone === 'good' ? 'Saved' : 'Not saved'} lines={msg.lines} /> : null}
    </Card>
  );
}
