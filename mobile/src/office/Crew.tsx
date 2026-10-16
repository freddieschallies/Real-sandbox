// Assistants and casual labour with no app: the office's list of them (People tab), with the day rate
// for casual workers and the hour rate they cost (Accounts and the CEO only), and the casual labour to
// pay for a week (Timesheets and Accounts). Who was on which job is on the job card (jobs/JobCrew.tsx).
import { ExportBar } from '../exportDoc.tsx';
import { escHtml, letterPage } from '../letterhead.tsx';
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, rand, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { KIND, useCrewMembers, type CrewKind, type CrewMember } from '../jobs/JobCrew.tsx';

const reasons = (r: { status: number; body: any } | null) => (r ? (r.body?.reasons ?? [`The server said ${r.status}`]) : ['No signal: try again with signal.']) as string[];
const toCents = (t: string) => { const n = Number(t.replace(/[R\s,]/g, '')); return t.trim() === '' ? null : Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN; };
const fromCents = (c?: number | null) => (c == null ? '' : String(c / 100));
const sast = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const dayName = (d: string) => new Date(`${d}T12:00:00+02:00`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });

/** People tab: the assistants and casual workers who have no app. */
export function CrewPeople() {
  const { d, load } = useCrewMembers(true);
  const [edit, setEdit] = useState<string | 'new' | null>(null);
  const [showOld, setShowOld] = useState(false);
  if (!d || !d.canEdit) return null;
  const shown = d.members.filter(m => showOld || m.active);
  return (
    <View style={{ gap: 6, marginTop: 8 }}>
      <Label>Assistants and casual labour – no app ({d.members.filter(m => m.active).length})</Label>
      <Text style={st.small}>People who work with the technicians but do not use the app. The technician ticks them on the job card; their hours go on the invoice at the assistant rate.{d.canPay ? ' Casual workers are paid a day rate.' : ''}</Text>
      {shown.map(m => edit === m.id ? <CrewForm key={m.id} m={m} canPay={d.canPay} done={() => { setEdit(null); load(); }} /> : (
        <Card key={m.id} onPress={() => setEdit(m.id)} accessibilityLabel={`Crew ${m.full_name}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '700', flex: 1 }]}>{m.full_name}</Text>
            {!m.active ? <Pill text="Not working with us" tone="quiet" /> : null}
            <Pill text={KIND[m.kind]} tone={m.kind === 'casual' ? 'warn' : 'info'} />
          </View>
          <Text style={st.small}>{[m.phone, m.lastDay ? `last on a job ${dayName(m.lastDay)}` : 'not on a job yet', d.canPay ? (m.kind === 'casual' ? (m.dayRateCents != null ? `${rand(m.dayRateCents)} a day` : 'no day rate yet') : m.hourRateCents != null ? `costs ${rand(m.hourRateCents)} an hour` : null) : null, `added by ${m.addedBy}`].filter(Boolean).join(' · ')}</Text>
        </Card>
      ))}
      {edit === 'new' ? <CrewForm canPay={d.canPay} done={() => { setEdit(null); load(); }} /> : <Button label="+ Add an assistant or casual worker" kind="secondary" onPress={() => setEdit('new')} />}
      {d.members.some(m => !m.active) ? <Button label={showOld ? 'Hide people no longer with us' : 'Show people no longer with us'} kind="quiet" onPress={() => setShowOld(!showOld)} /> : null}
    </View>
  );
}

function CrewForm({ m, canPay, done }: { m?: CrewMember; canPay: boolean; done: () => void }) {
  const s = useStore();
  const [name, setName] = useState(m?.full_name ?? '');
  const [phone, setPhone] = useState(m?.phone ?? '');
  const [kind, setKind] = useState<CrewKind>(m?.kind ?? 'casual');
  const [day, setDay] = useState(fromCents(m?.dayRateCents));
  const [hour, setHour] = useState(fromCents(m?.hourRateCents));
  const [note, setNote] = useState(m?.note ?? '');
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (active?: boolean) => {
    const dc = toCents(day), hc = toCents(hour);
    if (Number.isNaN(dc) || Number.isNaN(hc)) return setErr(['rates in rand, e.g. 350']);
    setBusy(true); setErr(null);
    const body = { fullName: name.trim(), phone: phone.trim() || (m ? null : undefined), kind, note: note.trim() || (m ? null : undefined), ...(canPay ? { dayRateCents: dc, hourRateCents: hc } : {}), ...(active !== undefined ? { active } : {}) };
    const r = await s.ask(m ? { method: 'PATCH', path: `/crew-members/${m.id}`, json: body } : { method: 'POST', path: '/crew-members', json: body }).catch(() => null);
    setBusy(false);
    if (r && r.status < 300) done(); else setErr(reasons(r));
  };
  return (
    <Card>
      <Heading>{m ? m.full_name : 'Someone new without the app'}</Heading>
      <Field label="Name and surname" value={name} onChangeText={setName} autoCapitalize="words" />
      <Field label="Phone number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <Choice options={['assistant', 'casual'] as const} value={kind} onChange={setKind} labels={{ assistant: 'Assistant (works with us)', casual: 'Casual labour (when needed)' }} />
      {canPay ? (
        <>
          {kind === 'casual' ? <Field label="Day rate (R)" value={day} onChangeText={setDay} keyboardType="decimal-pad" hint="Paid for every day he works, however many jobs." /> : null}
          <Field label={kind === 'casual' ? 'Or an hour rate instead (R, optional)' : 'What he costs per hour (R), for profit per job'} value={hour} onChangeText={setHour} keyboardType="decimal-pad" hint={kind === 'assistant' ? 'Assistants are paid with the wages; this is only for profit per job.' : undefined} />
        </>
      ) : <Text style={st.small}>Accounts or the CEO sets the rates.</Text>}
      <Field label="Note (optional)" value={note} onChangeText={setNote} />
      {err ? <Notice tone="bad" title="Not saved" lines={err} /> : null}
      <Button label={m ? 'Save' : 'Add'} busy={busy} disabled={name.trim().length < 2} onPress={() => save()} />
      {m ? <Button label={m.active ? 'No longer works with us' : 'Works with us again'} kind="quiet" onPress={() => save(!m.active)} /> : null}
      <Button label="Cancel" kind="quiet" onPress={done} />
    </Card>
  );
}

interface PayRow { memberId: string; name: string; phone: string | null; days: string[]; dayCount: number; dayRateCents: number | null; amountCents: number | null; jobs: number[]; paid: { from: string; to: string; amountCents: number; at: string; by: string }[] }

/** Timesheets and Accounts: what the casual workers are owed for a week, and marking it paid. */
export function CasualPay() {
  const s = useStore();
  const [to, setTo] = useState(sast());
  const from = sast(new Date(Date.parse(`${to}T12:00:00+02:00`) - 6 * 86_400_000));
  const [d, setD] = useState<{ casuals: PayRow[]; totalCents: number; noRate: number } | null>(null);
  const [no, setNo] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  const load = async () => {
    const r = await s.ask({ method: 'GET', path: `/crew/pay?from=${from}&to=${to}` }).catch(() => null);
    if (r?.status === 200) setD(r.body); else if (r?.status === 403) setNo(true);
  };
  useEffect(() => { load(); }, [to]);
  if (no) return null;
  const week = (n: number) => setTo(sast(new Date(Date.parse(`${to}T12:00:00+02:00`) + n * 7 * 86_400_000)));
  const pay = async (p: PayRow) => {
    setErr(null);
    const r = await s.ask({ method: 'POST', path: '/crew/pay', json: { memberId: p.memberId, from, to } }).catch(() => null);
    if (r && r.status < 300) load(); else setErr(reasons(r));
  };
  return (
    <Card>
      <Heading>Casual labour to pay</Heading>
      <Text style={st.small}>A day rate for every day a casual worker was on a job, from the job cards. {dayName(from)} – {dayName(to)}.</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label="‹ Week before" kind="quiet" onPress={() => week(-1)} />
        {to < sast() ? <Button label="Week after ›" kind="quiet" onPress={() => week(1)} /> : null}
      </View>
      {!d ? <Body quiet>Loading…</Body> : !d.casuals.length ? <Body quiet>No casual labour on jobs this week.</Body> : d.casuals.map(p => {
        const paid = p.paid.length > 0;
        return (
          <View key={p.memberId} style={{ gap: 4, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.line }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[st.body, { fontWeight: '700', flex: 1 }]}>{p.name}</Text>
              <Text style={{ color: C.accent, fontWeight: '800', fontSize: 17 }}>{p.amountCents != null ? rand(p.amountCents) : '–'}</Text>
            </View>
            <Text style={st.small}>{p.dayCount} day{p.dayCount === 1 ? '' : 's'} ({p.days.map(dayName).join(', ')}){p.dayRateCents != null ? ` × ${rand(p.dayRateCents)}` : ''} · job{p.jobs.length === 1 ? '' : 's'} {p.jobs.join(', ')}{p.phone ? ` · ${p.phone}` : ''}</Text>
            {p.dayRateCents == null ? <Text style={[st.small, { color: C.warn }]}>No day rate yet: set it under People → Assistants and casual labour.</Text> : null}
            {paid ? <Text style={[st.small, { color: C.good }]}>Paid {p.paid.map(x => `${rand(x.amountCents)} by ${x.by}`).join('; ')}</Text>
              : p.dayRateCents != null ? <Button label={`Mark ${p.name.split(' ')[0]} paid`} kind="secondary" onPress={() => pay(p)} /> : null}
          </View>
        );
      })}
      {d && d.casuals.length ? <Text style={[st.body, { fontWeight: '800' }]}>Together: {rand(d.totalCents)}{d.noRate ? ` (and ${d.noRate} without a day rate)` : ''}</Text> : null}
      {d && d.casuals.length ? <ExportBar title="Export the pay list" make={() => {
        const e = escHtml;
        const rows = d.casuals.map(p => `<tr><td>${e(p.name)}${p.phone ? `<br><span class=muted>${e(p.phone)}</span>` : ''}</td><td>${p.days.map(dayName).join(', ')}</td><td class=r>${p.dayCount}</td><td class=r>${p.dayRateCents != null ? rand(p.dayRateCents) : '–'}</td><td class=r><b>${p.amountCents != null ? rand(p.amountCents) : 'no rate'}</b></td><td>${p.paid.length ? `Paid by ${e(p.paid[0].by)}` : ''}</td><td style="width:150px;border-bottom:1px solid #111"></td></tr>`).join('');
        const body = `<h2>Casual labour to pay · ${dayName(from)} – ${dayName(to)}</h2><table><tr><th>Name</th><th>Days worked</th><th class=r>Days</th><th class=r>Day rate</th><th class=r>Amount</th><th>Paid</th><th>Signed for</th></tr>${rows}</table><p><b>Together: ${rand(d.totalCents)}</b></p>`;
        return { kind: 'crew', title: `Casual labour to pay – ${from} to ${to}`, html: letterPage({ title: `Casual labour to pay – ${from} to ${to}`, label: 'CASUAL LABOUR', company: s.session?.company.name ?? '', body }) };
      }} /> : null}
      {err ? <Notice tone="bad" title="Not marked paid" lines={err} /> : null}
    </Card>
  );
}
