// Assistants and casual labour on a job: people who work with the technician but have no app and no job
// cards of their own. The lead technician ticks who is with him today (their time follows his time on
// site) and adds a new casual worker by name; it works without signal and sends when there is signal.
// The office adds or corrects afterwards: a day and the hours. Who is charged and paid: server routes/crew.ts.
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { randomUUID, useStore } from '../state.tsx';
import { Body, Button, Card, Field, Heading, Notice, Select, st } from '../ui.tsx';
import { C } from '../theme.ts';

export type CrewKind = 'assistant' | 'casual';
export const KIND: Record<CrewKind, string> = { assistant: 'Assistant', casual: 'Casual labour' };
export interface CrewMember { id: string; full_name: string; kind: CrewKind; phone?: string | null; active: boolean; note?: string | null; lastDay: string | null; addedBy: string; dayRateCents?: number | null; hourRateCents?: number | null }
interface Entry { id: string; memberId: string; name: string; kind: CrewKind; workDate: string; minutes: number; typed: boolean; running: boolean; source: 'site' | 'office'; note: string | null; addedBy: string; canRemove: boolean; waiting?: boolean }
interface Crew { crew: Entry[]; office: boolean; today: string; hours: number }

const sast = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const hm = (m: number) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
const dayName = (d: string) => new Date(`${d}T12:00:00+02:00`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
const reasons = (r: { status: number; body: any } | null) => (r ? (r.body?.reasons ?? [`The server said ${r.status}`]) : ['No signal']) as string[];

export function useCrewMembers(all = false) {
  const s = useStore();
  const kept = s.cache.crew?.members as { members: CrewMember[]; canEdit: boolean; canPay: boolean } | undefined;
  const [d, setD] = useState(all ? null : kept ?? null);
  const load = async () => {
    const r = await s.ask({ method: 'GET', path: `/crew-members${all ? '?all=1' : ''}` }).catch(() => null);
    if (r?.status === 200) { setD(r.body); if (!all) s.patchCache(c => ({ ...c, crew: { ...c.crew, members: r.body } })); }
  };
  useEffect(() => { load(); }, []);
  return { d, load, setD };
}

export function JobCrew({ jobId, tech, closed }: { jobId: string; tech?: boolean; closed?: boolean }) {
  const s = useStore();
  const kept = s.cache.crew?.jobs?.[jobId] as Crew | undefined;
  const [d, setD] = useState<Crew | null>(kept ?? null);
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<null | 'new' | 'office'>(null);
  const [name, setName] = useState(''); const [phone, setPhone] = useState('');
  const [member, setMember] = useState<string | null>(null);
  const [day, setDay] = useState(sast()); const [hours, setHours] = useState('');
  const { d: list, load: loadList, setD: setList } = useCrewMembers();
  const keep = (v: Crew) => { setD(v); s.patchCache(c => ({ ...c, crew: { ...c.crew, jobs: { ...(c.crew?.jobs ?? {}), [jobId]: v } } })); };
  const load = async () => {
    const r = await s.ask({ method: 'GET', path: `/jobs/${jobId}/crew` }).catch(() => null);
    if (r?.status === 200) keep(r.body as Crew); else if (r && r.status !== 200) setErr(reasons(r));
  };
  useEffect(() => { load(); }, [jobId]);
  if (!d && !list) return null;
  const crew = d?.crew ?? [];
  const today = d?.today ?? sast();
  const here = new Set(crew.filter(x => x.workDate === today).map(x => x.memberId));

  /** On site: ask now; no signal, it waits on the phone and sends by itself. */
  const addToday = async (m: { id: string; full_name: string; kind: CrewKind }, newOne?: { phone?: string }) => {
    setErr(null); setBusy(true);
    const entryId = randomUUID();
    const memberReq = newOne ? { method: 'POST' as const, path: '/crew-members', json: { id: m.id, fullName: m.full_name, kind: 'casual', ...(newOne.phone ? { phone: newOne.phone } : {}) } } : null;
    const crewReq = { method: 'POST' as const, path: `/jobs/${jobId}/crew`, json: { id: entryId, memberId: m.id } };
    let mr = memberReq ? await s.ask(memberReq).catch(() => null) : { status: 200, body: { id: m.id } };
    if (mr && mr.status < 300 && mr.body?.id && mr.body.id !== m.id) m = { ...m, id: mr.body.id };
    const r = mr ? await s.ask({ ...crewReq, json: { ...crewReq.json, memberId: m.id } }).catch(() => null) : null;
    setBusy(false);
    if (r && r.status < 300) { setAdding(null); setName(''); setPhone(''); load(); if (newOne) loadList(); return; }
    if (r || (mr && mr.status >= 300)) { setErr(reasons(r ?? mr)); return; }
    // No signal: queue both, show them as waiting.
    if (memberReq) s.queue(`Casual worker ${m.full_name}`, memberReq);
    s.queue(`${m.full_name} on the job`, crewReq);
    const waiting: Entry = { id: entryId, memberId: m.id, name: m.full_name, kind: m.kind, workDate: today, minutes: 0, typed: false, running: true, source: 'site', note: null, addedBy: 'you', canRemove: false, waiting: true };
    keep({ ...(d ?? { office: false, today, hours: 0, crew: [] }), crew: [...crew, waiting] });
    if (newOne && list) setList({ ...list, members: [...list.members, { id: m.id, full_name: m.full_name, kind: 'casual', active: true, lastDay: today, addedBy: 'you' }] });
    setAdding(null); setName(''); setPhone('');
  };
  const addOffice = async () => {
    const h = Number(hours.replace(',', '.'));
    if (!member) return setErr(['choose who']);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return setErr(['the day as 2026-10-16']);
    if (!(h > 0 && h <= 24)) return setErr(['how many hours they worked, e.g. 7.5']);
    setBusy(true); setErr(null);
    const r = await s.ask({ method: 'POST', path: `/jobs/${jobId}/crew`, json: { memberId: member, workDate: day, hours: h } }).catch(() => null);
    setBusy(false);
    if (r && r.status < 300) { setAdding(null); setMember(null); setHours(''); load(); } else setErr(reasons(r));
  };
  const remove = async (e: Entry) => {
    setBusy(true);
    const r = await s.ask({ method: 'POST', path: `/job-crew/${e.id}/remove` }).catch(() => null);
    setBusy(false);
    if (r && r.status < 300) load(); else setErr(reasons(r));
  };
  const others = (list?.members ?? []).filter(m => m.active && !here.has(m.id));
  const isOffice = !tech && !!d?.office;

  return (
    <Card>
      <Heading>{tech ? 'Who is with you' : 'Assistants and casual labour'}</Heading>
      <Text style={st.small}>{tech ? 'Assistants and casual workers on this job today (they have no app). Their time follows yours on site.'
        : 'People without the app who worked on this job. Their hours go on the invoice at the assistant rate.'}</Text>
      {crew.length ? crew.map(e => (
        <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.line }}>
          <View style={{ flex: 1 }}>
            <Text style={[st.body, { fontWeight: '700' }]}>{e.name}</Text>
            <Text style={st.small}>{KIND[e.kind]} · {dayName(e.workDate)} · {e.waiting ? 'waiting for signal to send' : e.typed ? `${hm(e.minutes)} (typed by the office)` : !e.minutes && !e.running ? 'time starts when the technician arrives' : e.running ? `${hm(e.minutes)} so far, with the technician` : `${hm(e.minutes)} with the technician`}{isOffice ? ` · added by ${e.addedBy}${e.source === 'site' ? ' on site' : ''}` : ''}</Text>
          </View>
          {e.canRemove && !closed ? <Button label="Take off" kind="quiet" disabled={busy} onPress={() => remove(e)} /> : null}
        </View>
      )) : <Body quiet>{tech ? 'Nobody yet. Working alone? Leave it.' : 'Nobody added.'}</Body>}
      {crew.length && !tech ? <Text style={[st.small, { fontWeight: '700' }]}>{d?.hours ?? 0} hours together</Text> : null}
      {err ? <Notice tone="bad" title="Not added" lines={err} /> : null}
      {!closed && tech ? (
        <>
          {others.length ? <Text style={[st.small, { fontWeight: '800', letterSpacing: 0.5 }]}>TAP WHO IS WITH YOU</Text> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {others.map(m => (
              <Pressable key={m.id} disabled={busy} onPress={() => addToday(m)} accessibilityRole="button" accessibilityLabel={`With me: ${m.full_name}`}
                style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: C.accent, backgroundColor: C.panel }}>
                <Text style={{ color: C.text, fontWeight: '700' }}>+ {m.full_name} <Text style={{ color: C.quiet, fontWeight: '400' }}>{m.kind === 'casual' ? 'casual' : 'assistant'}</Text></Text>
              </Pressable>
            ))}
          </View>
          {adding === 'new' ? (
            <View style={{ gap: 8 }}>
              <Field label="Casual worker's name and surname" value={name} onChangeText={setName} autoCapitalize="words" />
              <Field label="Phone number (if he has one)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
              <Button label="Add – he is with me today" busy={busy} disabled={name.trim().length < 2} onPress={() => addToday({ id: randomUUID(), full_name: name.trim(), kind: 'casual' }, { phone: phone.trim() || undefined })} />
              <Button label="Cancel" kind="quiet" onPress={() => setAdding(null)} />
            </View>
          ) : <Button label="+ Casual worker not on the list" kind="secondary" onPress={() => { setAdding('new'); setErr(null); }} />}
        </>
      ) : null}
      {!closed && isOffice ? (adding === 'office' ? (
        <View style={{ gap: 8 }}>
          <Select label="Who" value={member} onChange={setMember} options={(list?.members ?? []).filter(m => m.active).map(m => ({ value: m.id, label: `${m.full_name} (${KIND[m.kind].toLowerCase()})` }))} />
          <Field label="Day (YYYY-MM-DD)" value={day} onChangeText={setDay} autoCapitalize="none" />
          <Field label="Hours worked on this job" value={hours} onChangeText={setHours} keyboardType="decimal-pad" placeholder="e.g. 7.5" />
          <Button label="Add to the job" busy={busy} onPress={addOffice} />
          <Button label="Cancel" kind="quiet" onPress={() => setAdding(null)} />
          <Text style={st.small}>Someone new? Add him under People → Assistants and casual labour first.</Text>
        </View>
      ) : <Button label="+ Add an assistant or casual worker" kind="secondary" onPress={() => { setAdding('office'); setErr(null); }} />) : null}
    </Card>
  );
}

