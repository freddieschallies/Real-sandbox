// Queries: the office or a technician asks any technician something at any time, and the answer
// comes back in the same conversation. Used in the technician's app and in the office.
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Field, Heading, Label, Notice, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';

export interface QMessage { id: string; from: string; name: string; body: string; at: string }
export interface Query {
  id: string; subject: string; created_at: string; job_id: string | null; job_number: number | null;
  from_user: string; from_name: string; to_user: string; to_name: string; messages: QMessage[]; unread: number; waitingForAnswer: boolean; lastAt: string;
}
const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function useQueries() {
  const s = useStore();
  const [list, setList] = useState<Query[]>([]);
  const [unread, setUnread] = useState(0);
  const [people, setPeople] = useState<{ id: string; full_name: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    const r = await s.ask({ method: 'GET', path: '/me/queries' });
    if (r?.status === 200) { setList(r.body.queries); setUnread(r.body.unread); setLoaded(true); }
  }, [s]);
  const loadPeople = useCallback(async () => {
    const r = await s.ask({ method: 'GET', path: '/queries/people' });
    if (r?.status === 200) setPeople(r.body);
  }, [s]);
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, []);
  const post = async (path: string, json: object): Promise<string[] | null> => {
    const r = await s.ask({ method: 'POST', path, json });
    if (r && r.status < 300) { await load(); return null; }
    return (r?.body as { reasons?: string[] })?.reasons ?? ['no signal: try again'];
  };
  return { list, unread, people, loaded, load, loadPeople, post, me: s.session?.user.id ?? '' };
}
export type QueriesHook = ReturnType<typeof useQueries>;

export function QueryList({ q, open, ask }: { q: QueriesHook; open: (id: string) => void; ask?: () => void }) {
  return (
    <>
      {ask ? <Button label="Send a query to a technician" onPress={ask} /> : null}
      {q.list.map(x => {
        const mine = x.from_user === q.me;
        const last = x.messages.at(-1);
        return (
          <Card key={x.id} onPress={() => open(x.id)} accessibilityLabel={`Query ${x.subject}`} style={x.unread ? { borderColor: C.accent, borderWidth: 2 } : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[st.body, { fontWeight: '800', flex: 1 }]} numberOfLines={1}>{x.subject}</Text>
              {x.unread ? <Pill text={`${x.unread} new`} tone="warn" /> : x.waitingForAnswer ? <Pill text="Waiting for answer" tone="quiet" /> : null}
            </View>
            <Text style={st.small}>{mine ? `To ${x.to_name}` : `From ${x.from_name}`}{x.job_number ? ` · job ${x.job_number}` : ''} · {when(x.lastAt)}</Text>
            {last ? <Body numberOfLines={2}>{last.from === q.me ? 'You: ' : ''}{last.body}</Body> : null}
          </Card>
        );
      })}
      {q.loaded && !q.list.length ? <Body quiet>No queries yet.</Body> : null}
      {!q.loaded ? <Body quiet>Loading…</Body> : null}
    </>
  );
}

export function QueryThread({ q, id }: { q: QueriesHook; id: string }) {
  const x = q.list.find(y => y.id === id);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (x?.unread) q.post(`/queries/${id}/read`, {}); }, [id, x?.unread]);
  if (!x) return <Body quiet>Not found.</Body>;
  const other = x.from_user === q.me ? x.to_name : x.from_name;
  return (
    <>
      <Text style={{ color: C.text, fontSize: 22, fontWeight: '800' }}>{x.subject}</Text>
      <Text style={st.small}>{x.from_name} → {x.to_name}{x.job_number ? ` · job ${x.job_number}` : ''}</Text>
      {x.messages.map(m => {
        const mine = m.from === q.me;
        return (
          <View key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '88%', backgroundColor: mine ? '#3A2A1A' : C.panel, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: mine ? C.accent : C.line, gap: 4 }}>
            <Text style={[st.small, { fontWeight: '700' }]}>{mine ? 'You' : m.name} · {when(m.at)}</Text>
            <Text style={st.body}>{m.body}</Text>
          </View>
        );
      })}
      <Field label={`Reply to ${other}`} value={text} onChangeText={setText} multiline />
      {err ? <Notice tone="bad" title="Not sent" lines={err} /> : null}
      <Button label="Send" busy={busy} disabled={!text.trim()} onPress={async () => {
        setBusy(true); const r = await q.post(`/queries/${id}/messages`, { body: text.trim() }); setBusy(false);
        setErr(r); if (!r) setText('');
      }} />
      <Text style={st.small}>Messages are kept on record and cannot be changed.</Text>
    </>
  );
}

export function NewQuery({ q, done, jobs }: { q: QueriesHook; done: (id?: string) => void; jobs?: { id: string; label: string }[] }) {
  const [to, setTo] = useState<string>();
  const [jobId, setJobId] = useState<string>();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [find, setFind] = useState('');
  useEffect(() => { q.loadPeople(); }, []);
  const people = q.people.filter(p => !find.trim() || p.full_name.toLowerCase().includes(find.trim().toLowerCase()));
  return (
    <>
      <Heading>Send a query</Heading>
      <Label>To which technician</Label>
      {q.people.length > 6 ? <TextInput value={find} onChangeText={setFind} placeholder="Search name" placeholderTextColor={C.quiet} style={st.input} /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {people.map(p => (
          <Pressable key={p.id} onPress={() => setTo(p.id)} accessibilityRole="radio" accessibilityState={{ checked: to === p.id }} accessibilityLabel={`To ${p.full_name}`}
            style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, borderWidth: 2, borderColor: to === p.id ? C.accent : C.line, backgroundColor: to === p.id ? C.panel2 : 'transparent' }}>
            <Text style={{ color: C.text, fontWeight: '700' }}>{p.full_name}</Text>
          </Pressable>
        ))}
      </View>
      {jobs?.length ? (
        <>
          <Label>About a job (optional)</Label>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {jobs.map(j => (
              <Pressable key={j.id} onPress={() => setJobId(jobId === j.id ? undefined : j.id)} accessibilityRole="checkbox" accessibilityState={{ checked: jobId === j.id }}
                style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: jobId === j.id ? C.accent : C.line }}>
                <Text style={{ color: C.text }}>{j.label}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      <Field label="What is it about?" value={subject} onChangeText={setSubject} placeholder="e.g. Harbour Deli access card" />
      <Field label="Your question" value={body} onChangeText={setBody} multiline />
      {err ? <Notice tone="bad" title="Not yet. Still needed:" lines={err} /> : null}
      <Button label="Send query" busy={busy} onPress={async () => {
        const missing = [!to ? 'which technician' : null, subject.trim().length < 3 ? 'what it is about' : null, body.trim().length < 2 ? 'the question' : null].filter(Boolean) as string[];
        if (missing.length) { setErr(missing); return; }
        setBusy(true);
        const r = await q.post('/queries', { toUserId: to, subject: subject.trim(), body: body.trim(), ...(jobId ? { jobId } : {}) });
        setBusy(false); setErr(r);
        if (!r) done();
      }} />
      <Button label="Cancel" kind="quiet" onPress={() => done()} />
    </>
  );
}
