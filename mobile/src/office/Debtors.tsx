// Debtors: who owes what and for how long (current, 30, 60, 90 and 120 days and more, by invoice
// date, the way Pastel shows it), and accounts on hold. An invoice counts until it is marked paid
// (Invoices → the invoice → Paid); credit notes come off.
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import * as D from '../../../server/src/core/documents.ts';
import * as DB from '../../../server/src/core/debtors.ts';
import { Body, Button, Card, Field, Heading, Label, Notice, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';

type Ans = { ok: true; body: any } | { ok: false; reasons: string[] };
const R = (c: number) => D.rand(c);
const day = (s: string | null | undefined) => (s ? new Date(`${s.slice(0, 10)}T12:00:00+02:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
const TONE: Record<DB.AgeBand, 'good' | 'info' | 'warn' | 'bad'> = { current: 'good', d30: 'info', d60: 'warn', d90: 'bad', d120: 'bad' };

function useAsk() {
  const s = useStore();
  return async (method: 'GET' | 'POST', path: string, json?: object): Promise<Ans> => {
    const r = await s.ask({ method, path, json });
    if (r && r.status < 300) return { ok: true, body: r.body };
    return { ok: false, reasons: (r?.body as { reasons?: string[] })?.reasons ?? ['no signal: try again'] };
  };
}

/** The five ages, one line each, with what is owed in each. */
function Bands({ bands }: { bands: Record<DB.AgeBand, number> }) {
  return (
    <View style={{ gap: 2 }}>
      {DB.AGE_BANDS.map(b => (
        <View key={b} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: bands[b] ? C[TONE[b]] : C.line }} />
          <Text style={[st.body, { flex: 1 }]}>{DB.AGE_LABEL[b]}</Text>
          <Text style={[st.body, { fontWeight: '800', color: bands[b] ? C.text : C.quiet }]}>{bands[b] ? R(bands[b]) : '–'}</Text>
        </View>
      ))}
    </View>
  );
}

export function DebtorList({ open, selected, tick }: { open: (clientId: string) => void; selected: string | null; tick: number }) {
  const ask = useAsk();
  const [d, setD] = useState<any>(null);
  const [only, setOnly] = useState<'all' | 'over60' | 'hold'>('all');
  useEffect(() => { ask('GET', '/office/debtors').then(r => { if (r.ok) setD(r.body); }); }, [tick]);
  if (!d) return <Body quiet>Loading…</Body>;
  const list = (d.clients as any[]).filter(c => only === 'all' || (only === 'hold' ? c.onHold : c.bands.d60 + c.bands.d90 + c.bands.d120 > 0));
  return (
    <>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>{R(d.totals.total)}</Text>
          <Text style={st.small}>owed to the company (incl. VAT){d.totals.overdue ? ` · ${R(d.totals.overdue)} past its due date` : ''}</Text>
        </View>
        <Bands bands={d.totals} />
      </Card>
      <Text style={st.small}>Counted until an invoice is marked paid (Invoices → the invoice → Paid). Credit notes come off.</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {(['all', 'over60', 'hold'] as const).map(k => (
          <Button key={k} label={k === 'all' ? 'Everyone' : k === 'over60' ? '60 days and older' : 'On hold'} kind={only === k ? 'primary' : 'secondary'} onPress={() => setOnly(k)} style={{ flexGrow: 1, flexBasis: 110, minHeight: 44 }} />
        ))}
      </View>
      {list.map(c => (
        <Card key={c.clientId} onPress={() => open(c.clientId)} accessibilityLabel={`Debtor ${c.client}`} style={selected === c.clientId ? { borderColor: C.accent, borderWidth: 2 } : c.onHold ? { borderColor: C.bad } : undefined}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]} numberOfLines={1}>{c.client}</Text>
            {c.onHold ? <Pill text="On hold" tone="bad" /> : null}
            <Text style={[st.body, { fontWeight: '800' }]}>{c.total ? R(c.total) : '–'}</Text>
          </View>
          <Text style={st.small}>
            {c.invoices ? `${c.invoices} invoice${c.invoices === 1 ? '' : 's'} · oldest ${c.oldestDays} days` : 'Nothing owed'}{c.overdue ? ` · ${R(c.overdue)} overdue` : ''}{c.pastelCode ? ` · ${c.pastelCode}` : ''}
          </Text>
          {c.total ? (
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {DB.AGE_BANDS.filter(b => c.bands[b]).map(b => <Pill key={b} text={`${DB.AGE_LABEL[b]}: ${R(c.bands[b])}`} tone={TONE[b]} />)}
            </View>
          ) : null}
        </Card>
      ))}
      {!list.length ? <Body quiet>{only === 'hold' ? 'No accounts on hold.' : 'Nobody owes anything.'}</Body> : null}
    </>
  );
}

export function DebtorDetail({ id, changed, openInvoice }: { id: string; changed: () => void; openInvoice: (invoiceId: string) => void }) {
  const ask = useAsk();
  const [d, setD] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [holding, setHolding] = useState(false);
  const [ans, setAns] = useState<Ans | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => ask('GET', `/office/debtors/${encodeURIComponent(id)}`).then(r => { if (r.ok) setD(r.body); else setAns(r); });
  useEffect(() => { load(); }, [id]);
  if (!d) return ans && !ans.ok ? <Notice tone="bad" title="Could not open" lines={ans.reasons} /> : <Body quiet>Loading…</Body>;
  const c = d.client;
  const hold = async (on: boolean) => {
    setMsg(null);
    const r = await ask('POST', `/office/clients/${encodeURIComponent(id)}/hold`, on ? { on, reason: reason.trim() } : { on });
    setAns(r);
    if (r.ok) { setHolding(false); setReason(''); setMsg(on ? `${c.name} is on hold: opening a job for it now warns first.` : `${c.name} is off hold.`); changed(); load(); }
  };
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontSize: 24, fontWeight: '800', flexShrink: 1 }}>{c.name}</Text>
        {c.on_hold ? <Pill text="Account on hold" tone="bad" /> : null}
      </View>
      <Text style={st.small}>{[c.pastel_code ? `Pastel ${c.pastel_code}` : null, c.contact_name, c.phone, c.email].filter(Boolean).join(' · ') || 'No contact details'}</Text>
      {msg ? <Notice tone="good" title={msg} /> : null}
      {c.on_hold ? <Notice tone="bad" title="On hold" lines={[c.hold_reason ?? '', `${c.hold_by ?? ''}${c.hold_at ? `, ${day(c.hold_at)}` : ''}`].filter(Boolean)} /> : null}
      {d.summary ? (
        <Card>
          <Text style={[st.body, { fontWeight: '800' }]}>Owes {R(d.summary.total)}{d.summary.overdue ? ` · ${R(d.summary.overdue)} overdue` : ''}</Text>
          <Bands bands={d.summary.bands} />
        </Card>
      ) : <Body quiet>Nothing owed.</Body>}
      {d.invoices.length ? <Heading>Unpaid invoices</Heading> : null}
      {d.invoices.map((i: any) => (
        <Card key={i.id} onPress={() => openInvoice(i.id)} accessibilityLabel={`Invoice ${i.number}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>INV {i.number}{i.store ? ` · ${i.store}` : ''}</Text>
            <Pill text={DB.AGE_LABEL[i.band as DB.AgeBand]} tone={TONE[i.band as DB.AgeBand]} />
          </View>
          <Text style={st.small}>
            {day(i.date)} · {i.days} days · {R(i.owing)}{i.creditedCents ? ` (after ${R(i.creditedCents)} credited)` : ''}{i.jobNumber ? ` · job ${i.jobNumber}` : ''}
            {i.overdueDays ? ` · ${i.overdueDays} days past due` : i.due ? ` · due ${day(i.due)}` : ''}
          </Text>
        </Card>
      ))}
      {d.canHold ? (
        c.on_hold ? <Button label="Take the account off hold" onPress={() => hold(false)} />
          : holding ? (
            <Card style={{ borderColor: C.bad }}>
              <Field label="Why is the account on hold? (the office sees this when opening a job)" value={reason} onChangeText={setReason} placeholder="e.g. Nothing paid since July: speak to Accounts first" />
              {ans && !ans.ok ? <Notice tone="bad" title="Not yet" lines={ans.reasons} /> : null}
              <Button label="Put on hold" kind="danger" disabled={reason.trim().length < 3} onPress={() => hold(true)} />
              <Button label="Cancel" kind="quiet" onPress={() => setHolding(false)} />
            </Card>
          ) : <Button label="Put the account on hold" kind="secondary" onPress={() => setHolding(true)} />
      ) : <Text style={st.small}>The CEO and Accounts put an account on hold.</Text>}
      {d.history.length ? (
        <>
          <Label>On hold record</Label>
          <Card>
            {d.history.map((h: any, n: number) => (
              <Text key={n} style={st.small}>{day(h.at)} · {h.job_number ? `Job ${h.job_number} opened anyway` : h.on_hold ? `On hold: ${h.reason}` : 'Off hold'} · {h.by}</Text>
            ))}
          </Card>
        </>
      ) : null}
    </>
  );
}

