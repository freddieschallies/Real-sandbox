// Ending someone's employment (HR or the CEO) and HR's Terminated staff. The person comes off every
// list and their login stops; the record (when, why, what was still on their name, their staff
// record and profile) stays with HR and cannot be changed.
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { Avatar, ProfileDetails, ProfileTop, useProfile } from '../office/Profile.tsx';
import { StaffRecord } from '../staff/Staff.tsx';

const REASONS = { resigned: 'Resigned', dismissed: 'Dismissed', retrenched: 'Retrenched', contract_ended: 'Contract ended', retired: 'Retired', other: 'Other' } as const;
type Reason = keyof typeof REASONS;
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['no signal: try again'];
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const day = (s: string) => new Date(`${s}T12:00:00+02:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });

export interface Termination {
  date: string; reason?: string; note?: string | null; position?: string; department?: string | null; by?: string;
  on_name?: { kit: { kind: string; name: string; detail: string | null; qty: number }[]; stock: { code: string; description: string; qty: number }[] };
}

/** On a profile, for HR and the CEO: end this person's employment. */
export function EndEmployment({ id, name, done }: { id: string; name: string; done: () => void }) {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState<Reason | undefined>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  const first = name.split(' ')[0];
  if (!open) return <Button label={`End ${first}'s employment`} kind="quiet" onPress={() => setOpen(true)} />;
  return (
    <Card style={{ borderColor: C.bad }}>
      <Heading>End {first}'s employment</Heading>
      <Body quiet>{first} comes off every list and can no longer sign in. Their profile, staff record and what is still on their name move to Terminated staff, where HR keeps them. This cannot be undone here.</Body>
      <Field label="Last day (YYYY-MM-DD)" value={date} onChangeText={setDate} autoCapitalize="none" />
      <Label>Why</Label>
      <Choice options={Object.keys(REASONS) as Reason[]} value={reason} onChange={setReason} labels={REASONS} />
      <Field label={reason === 'other' ? 'What happened (needed)' : 'Note (optional)'} value={note} onChangeText={setNote} multiline />
      {err ? <Notice tone="bad" title="Not done" lines={err} /> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Button label={`End ${first}'s employment`} kind="danger" busy={busy} disabled={!reason || !/^\d{4}-\d{2}-\d{2}$/.test(date)} onPress={async () => {
          setBusy(true);
          const r = await s.ask({ method: 'POST', path: `/people/${id}/terminate`, json: { date, reason, note: note.trim() || undefined } });
          setBusy(false);
          if (r && r.status < 300) done(); else setErr(reasons(r));
        }} />
        <Button label="Cancel" kind="secondary" onPress={() => { setOpen(false); setErr(null); }} />
      </View>
    </Card>
  );
}

type Leaver = { id: string; full_name: string; photo_id: string | null; date: string; reasonLabel: string; note: string | null; position: string; department: string | null; by: string; items_on_name: number };

/** HR's Terminated staff, at the bottom of the People list. */
export function TerminatedStaff({ open }: { open: (id: string) => void }) {
  const s = useStore();
  const [list, setList] = useState<Leaver[] | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => { s.ask({ method: 'GET', path: '/people/terminated' }).then(r => { if (r?.status === 200) setList(r.body); }); }, []);
  if (!list) return null;
  return (
    <View style={{ gap: 6, marginTop: 8 }}>
      <Pressable onPress={() => setShown(v => !v)} accessibilityRole="button" accessibilityState={{ expanded: shown }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}>
        <Label>Terminated staff ({list.length})</Label>
        <Text style={st.small}>{shown ? '▴ hide' : '▾ show'}</Text>
      </Pressable>
      {shown && !list.length ? <Body quiet>Nobody yet. When HR ends someone's employment, their record is kept here.</Body> : null}
      {shown ? list.map(x => (
        <Pressable key={x.id} onPress={() => open(x.id)} accessibilityRole="button" accessibilityLabel={`Former ${x.full_name}`}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 56, borderRadius: 8, backgroundColor: pressed ? C.panel2 : C.panel, borderWidth: 1, borderColor: C.line, opacity: 0.9 })}>
          <Avatar id={x.photo_id} name={x.full_name} size={34} />
          <View style={{ flex: 1 }}>
            <Text style={[st.body, { fontWeight: '700' }]}>{x.full_name}</Text>
            <Text style={st.small}>{x.position}{x.department ? ` · ${x.department}` : ''} · left {day(x.date)} · {x.reasonLabel}</Text>
          </View>
          {x.items_on_name ? <Pill text={`${x.items_on_name} on name`} tone="warn" /> : null}
        </Pressable>
      )) : null}
    </View>
  );
}

/** A former employee's record, as HR keeps it. */
export function LeaverDetail({ id }: { id: string }) {
  const prof = useProfile(id);
  const p = prof.p as (typeof prof.p & { termination?: Termination | null }) | null;
  if (!p) return <Body quiet>Loading…</Body>;
  const t = p.termination;
  const on = t?.on_name;
  return (
    <>
      <ProfileTop p={p} reload={prof.load} />
      {t ? (
        <Card style={{ borderColor: C.bad }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Heading>Employment ended</Heading>
            <Pill text="Terminated staff" tone="bad" />
          </View>
          <Text style={st.body}>Last day {day(t.date)}{t.reason ? ` · ${REASONS[t.reason as Reason] ?? t.reason}` : ''}</Text>
          {t.position ? <Text style={st.small}>Was {t.position}{t.department ? ` in ${t.department}` : ''}{t.by ? ` · recorded by ${t.by}` : ''}</Text> : null}
          {t.note ? <Text style={st.small}>Note: {t.note}</Text> : null}
          {on ? (
            <>
              <Label>Still on their name when they left</Label>
              {!on.kit.length && !on.stock.length ? <Text style={st.small}>Nothing: all tools, PPE and stock were back.</Text> : null}
              {on.kit.map((k, i) => <Text key={`k${i}`} style={st.small}>• {k.kind === 'ppe' ? 'PPE' : 'Tool'}: {k.name}{k.detail ? ` (${k.detail})` : ''}{k.qty !== 1 ? ` ×${k.qty}` : ''}</Text>)}
              {on.stock.map((x, i) => <Text key={`s${i}`} style={st.small}>• Stock: {x.description} ×{x.qty}</Text>)}
            </>
          ) : null}
        </Card>
      ) : null}
      <ProfileDetails p={p} reload={prof.load} />
      {p.record?.read ? <StaffRecord userId={id} name={p.full_name} /> : null}
    </>
  );
}
