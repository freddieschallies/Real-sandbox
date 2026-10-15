// Customers, for Accounts: every client with what it was invoiced, paid, credited and still owes; one
// client with every job, invoice, credit note and quote; and its statement (brought forward, every
// invoice, credit note and payment with the running balance, and the age analysis: current, 30, 60,
// 90 and 120 days), printed on the letterhead or emailed to the customer.
import { ClientRatesEditor } from './Books.tsx';
import React, { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import * as D from '../../../server/src/core/documents.ts';
import * as DB from '../../../server/src/core/debtors.ts';
import * as ST from '../../../server/src/core/statement.ts';
import { letterheadBottom, letterheadTop } from '../letterhead.tsx';
import { currentLogo } from '../brand.tsx';
import { Body, Button, Card, Choice, Field, Heading, Notice, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';

type Ans = { ok: true; body: any } | { ok: false; reasons: string[] };
const R = (c: number) => D.rand(c);
const day = (s: string | null | undefined) => (s ? new Date(`${s.slice(0, 10)}T12:00:00+02:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const INV: Record<string, { t: string; tone: 'info' | 'good' | 'warn' | 'bad' | 'quiet' }> = {
  draft: { t: 'Draft', tone: 'quiet' }, sent: { t: 'Sent, unpaid', tone: 'warn' }, paid: { t: 'Paid', tone: 'good' }, cancelled: { t: 'Cancelled', tone: 'quiet' },
};
const QUO: Record<string, { t: string; tone: 'info' | 'good' | 'warn' | 'bad' | 'quiet' }> = {
  draft: { t: 'Draft', tone: 'quiet' }, submitted: { t: 'To check', tone: 'info' }, sent: { t: 'Sent', tone: 'info' }, accepted: { t: 'Accepted', tone: 'good' }, declined: { t: 'Declined', tone: 'bad' }, cancelled: { t: 'Cancelled', tone: 'quiet' },
};

function useAsk() {
  const s = useStore();
  return async (method: 'GET' | 'POST', path: string, json?: object): Promise<Ans> => {
    const r = await s.ask({ method, path, json });
    if (r && r.status < 300) return { ok: true, body: r.body };
    return { ok: false, reasons: (r?.body as { reasons?: string[] })?.reasons ?? ['no signal: try again'] };
  };
}

export function CustomerList({ open, selected }: { open: (id: string) => void; selected: string | null }) {
  const ask = useAsk();
  const [list, setList] = useState<any[] | null>(null);
  const [find, setFind] = useState('');
  const [only, setOnly] = useState<'all' | 'owing' | 'open' | 'hold'>('all');
  useEffect(() => { ask('GET', '/office/clients').then(r => { if (r.ok) setList(r.body); }); }, []);
  if (!list) return <Body quiet>Loading…</Body>;
  const q = find.trim().toLowerCase();
  const shown = list.filter(c => (!q || `${c.name} ${c.pastel_code ?? ''} ${c.contact_name ?? ''}`.toLowerCase().includes(q))
    && (only === 'all' || (only === 'owing' ? c.owing > 0 : only === 'open' ? c.open_jobs > 0 : c.on_hold)));
  return (
    <>
      <Field label="Find a customer" value={find} onChangeText={setFind} placeholder="Name or Pastel code" />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {(['all', 'owing', 'open', 'hold'] as const).map(k => (
          <Button key={k} label={k === 'all' ? 'Everyone' : k === 'owing' ? 'Owes money' : k === 'open' ? 'Open jobs' : 'On hold'} kind={only === k ? 'primary' : 'secondary'} onPress={() => setOnly(k)} style={{ flexGrow: 1, flexBasis: 100, minHeight: 44 }} />
        ))}
      </View>
      {shown.map(c => (
        <Card key={c.id} onPress={() => open(c.id)} accessibilityLabel={`Customer ${c.name}`} style={selected === c.id ? { borderColor: C.accent, borderWidth: 2 } : c.on_hold ? { borderColor: C.bad } : undefined}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]} numberOfLines={1}>{c.name}</Text>
            {c.on_hold ? <Pill text="On hold" tone="bad" /> : null}
            {c.owing ? <Text style={[st.body, { fontWeight: '800', color: C.warn }]}>{R(c.owing)}</Text> : null}
          </View>
          <Text style={st.small}>
            {[c.pastel_code, `${c.stores} store${c.stores === 1 ? '' : 's'}`, `${c.jobs} job${c.jobs === 1 ? '' : 's'}${c.open_jobs ? ` (${c.open_jobs} open)` : ''}`,
              c.invoices ? `${c.invoices} invoice${c.invoices === 1 ? '' : 's'}, ${R(c.invoiced)}` : 'nothing invoiced yet', c.credited ? `credited ${R(c.credited)}` : ''].filter(Boolean).join(' · ')}
          </Text>
        </Card>
      ))}
      {!shown.length ? <Body quiet>No customer like that.</Body> : null}
    </>
  );
}

type Section = 'jobs' | 'invoices' | 'credits' | 'quotes' | 'statement' | 'rates';

export function CustomerDetail({ id, start = 'jobs', co, openJob, openInvoice, openQuote, openDebtor, canRates }: {
  id: string; start?: Section; co: any; canRates?: boolean; openJob: (id: string) => void; openInvoice: (id: string) => void; openQuote: (id: string) => void; openDebtor: (clientId: string) => void;
}) {
  const ask = useAsk();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const [show, setShow] = useState<Section>(start);
  useEffect(() => { ask('GET', `/office/clients/${encodeURIComponent(id)}`).then(r => { if (r.ok) setD(r.body); else setErr(r.reasons); }); }, [id]);
  if (!d) return err ? <Notice tone="bad" title="Could not open" lines={err} /> : <Body quiet>Loading…</Body>;
  const c = d.client, m = d.summary;
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontSize: 24, fontWeight: '800', flexShrink: 1 }}>{c.name}</Text>
        {c.on_hold ? <Pill text="Account on hold" tone="bad" /> : null}
        {c.own_rates ? <Pill text="Own rates" tone="info" /> : null}
      </View>
      <Text style={st.small}>{[c.pastel_code ? `Pastel ${c.pastel_code}` : null, c.contact_name, c.phone, c.email].filter(Boolean).join(' · ') || 'No contact details'}</Text>
      {c.on_hold ? <Notice tone="bad" title="On hold" lines={[c.hold_reason ?? '']} /> : null}
      <Card>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
          {[['Invoiced', m.invoiced], ['Paid', m.paid], ['Credited', m.credited], ['Owes', m.owing]].map(([t, v]) => (
            <View key={t as string} style={{ minWidth: 110, flexGrow: 1 }}>
              <Text style={st.small}>{t as string}</Text>
              <Text style={{ color: t === 'Owes' && (v as number) > 0 ? C.warn : C.text, fontSize: 18, fontWeight: '800' }}>{R(v as number)}</Text>
            </View>
          ))}
        </View>
        <Text style={st.small}>{m.jobs} job{m.jobs === 1 ? '' : 's'}{m.openJobs ? ` · ${m.openJobs} open` : ''}{m.toInvoice ? ` · ${m.toInvoice} to invoice` : ''} · {d.stores.length} store{d.stores.length === 1 ? '' : 's'}. Incl. VAT.</Text>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          <Button label="Statement" onPress={() => setShow('statement')} style={{ flexGrow: 1, flexBasis: 130 }} />
          <Button label="Debtors and hold" kind="secondary" onPress={() => openDebtor(c.id)} style={{ flexGrow: 1, flexBasis: 130 }} />
        </View>
      </Card>
      <Choice options={(canRates ? ['jobs', 'invoices', 'credits', 'quotes', 'statement', 'rates'] : ['jobs', 'invoices', 'credits', 'quotes', 'statement']) as Section[]} value={show} onChange={setShow}
        labels={{ jobs: `Jobs (${d.jobs.length})`, invoices: `Invoices (${d.invoices.length})`, credits: `Credit notes (${d.credits.length})`, quotes: `Quotes (${d.quotes.length})`, statement: 'Statement', rates: 'Rates and mark-up' }} />
      {show === 'rates' && canRates ? <ClientRatesEditor key={c.id} b={{ ask: ask as never }} client={{ id: c.id, name: c.name }} /> : null}
      {show === 'jobs' ? (
        <>
          {d.jobs.map((j: any) => (
            <Card key={j.id} onPress={() => openJob(j.id)} accessibilityLabel={`Customer job ${j.job_number}`}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={[st.body, { fontWeight: '800', flex: 1 }]} numberOfLines={1}>#{j.job_number} · {j.store}</Text>
                <Pill text={j.outcome.label} tone={j.outcome.tone} />
              </View>
              <Text style={st.small} numberOfLines={2}>{[day(j.scheduled_date), j.technician, j.fault_reported, j.invoice_number ? `invoice ${j.invoice_number}` : '', j.credited_cents ? `credited ${R(j.credited_cents)}` : '', j.client_order_ref ? `order ${j.client_order_ref}` : ''].filter(Boolean).join(' · ')}</Text>
            </Card>
          ))}
          {!d.jobs.length ? <Body quiet>No jobs yet.</Body> : null}
        </>
      ) : null}
      {show === 'invoices' ? (
        <>
          {d.invoices.map((i: any) => {
            const stt = INV[i.status] ?? { t: i.status, tone: 'quiet' as const };
            return (
              <Card key={i.id} onPress={() => openInvoice(i.id)} accessibilityLabel={`Customer invoice ${i.invoice_number}`}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={[st.body, { fontWeight: '800', flex: 1 }]} numberOfLines={1}>Invoice {i.invoice_number} · {R(i.total_cents)}</Text>
                  <Pill text={stt.t} tone={stt.tone} />
                </View>
                <Text style={st.small}>{[`job ${i.job_number}`, i.store, day(i.sent_at ?? i.created_at), i.status === 'sent' && i.due_date ? `due ${day(i.due_date)}` : '', i.paid_at ? `paid ${day(i.paid_at)}${i.paid_ref ? ` (${i.paid_ref})` : ''}` : '', i.credited_cents ? `credited ${R(i.credited_cents)}` : ''].filter(Boolean).join(' · ')}</Text>
              </Card>
            );
          })}
          {!d.invoices.length ? <Body quiet>No invoices yet.</Body> : null}
        </>
      ) : null}
      {show === 'credits' ? (
        <>
          {d.credits.map((x: any) => (
            <Card key={x.id} onPress={() => openInvoice(x.invoice_id)} accessibilityLabel={`Customer credit ${x.credit_number}`}>
              <Text style={[st.body, { fontWeight: '800' }]}>Credit note {x.credit_number} · {R(x.total_cents)}</Text>
              <Text style={st.small}>{[`invoice ${x.invoice_number}`, `job ${x.job_number}`, day(x.created_at), x.created_by, x.reason].filter(Boolean).join(' · ')}</Text>
            </Card>
          ))}
          {!d.credits.length ? <Body quiet>No credit notes.</Body> : null}
        </>
      ) : null}
      {show === 'quotes' ? (
        <>
          {d.quotes.map((q: any) => {
            const stt = QUO[q.status] ?? { t: q.status, tone: 'quiet' as const };
            return (
              <Card key={q.id} onPress={() => openQuote(q.id)} accessibilityLabel={`Customer quote ${q.quote_number}`}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={[st.body, { fontWeight: '800', flex: 1 }]} numberOfLines={1}>Quote {q.quote_number} · {R(q.total_cents)}</Text>
                  <Pill text={stt.t} tone={stt.tone} />
                </View>
                <Text style={st.small} numberOfLines={2}>{[q.title, q.store, q.job_number ? `job ${q.job_number}` : '', day(q.sent_at ?? q.created_at)].filter(Boolean).join(' · ')}</Text>
              </Card>
            );
          })}
          {!d.quotes.length ? <Body quiet>No quotes.</Body> : null}
        </>
      ) : null}
      {show === 'statement' ? <StatementPanel clientId={c.id} co={co} /> : null}
    </>
  );
}

/** The statement: choose the period, see it, print it on the letterhead, email it to the customer. */
export function StatementPanel({ clientId, co }: { clientId: string; co: any }) {
  const ask = useAsk();
  const [period, setPeriod] = useState<ST.StatementPeriod>('three');
  const [d, setD] = useState<any>(null);
  const [to, setTo] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [ans, setAns] = useState<{ ok: boolean; lines: string[]; title: string } | null>(null);
  const p = ST.periodDates(period, today());
  const load = () => ask('GET', `/office/clients/${encodeURIComponent(clientId)}/statement?${p.from ? `from=${p.from}&` : ''}to=${p.to}`).then(r => {
    if (r.ok) { setD(r.body); setTo(t => t ?? [r.body.client.email, ...r.body.storeEmails].filter(Boolean).filter((e: string, i: number, a: string[]) => a.indexOf(e) === i).slice(0, 3).join(', ')); }
    else setAns({ ok: false, title: 'Could not load the statement', lines: r.reasons });
  });
  useEffect(() => { load(); }, [clientId, period]);
  const s: ST.Statement | null = d?.statement ?? null;
  const company = { ...co, ...(d?.company ?? {}) };
  const print = () => {
    if (Platform.OS !== 'web' || !s) return;
    const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
    const plainHead = `<div class=bar></div><div class=head>${currentLogo() ? `<img src="${currentLogo()}" style="height:56px;background:#fff;padding:4px;border-radius:4px;margin-right:14px">` : ''}<div style="flex:1"><h1>${esc(company.trading_name || company.legal_name)}</h1>${company.trading_name ? `<div>${esc(company.legal_name)}</div>` : ''}</div></div>`;
    const plainFoot = `<div class=foot>${esc([company.address, company.phone, company.email].filter(Boolean).join(' · '))}<br>Reg. no. ${esc(company.reg_no || '–')} · VAT no. ${esc(company.vat_no || '–')}</div><div class=bar></div>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Statement ${esc(d.client.name)}</title><style>${ST.STATEMENT_CSS}</style></head><body>
${letterheadTop(plainHead)}${ST.statementHtml(s, d.client, company)}${letterheadBottom(plainFoot)}
<p class=noprint style="padding:12px 24px"><button onclick="print()">Print / save as PDF</button></p></body></html>`;
    const w = window.open('', '_blank');
    if (!w) { setAns({ ok: false, title: 'The browser blocked the print window', lines: ['Allow pop-ups for this page.'] }); return; }
    w.document.write(html); w.document.close();
  };
  const email = async () => {
    const list = (to ?? '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
    if (!list.length) { setAns({ ok: false, title: 'Who to send it to?', lines: ['Type the customer\'s email address.'] }); return; }
    setBusy(true);
    const r = await ask('POST', `/office/clients/${encodeURIComponent(clientId)}/statement/email`, { to: list, from: p.from, upTo: p.to, message: message.trim() || undefined });
    setBusy(false);
    setAns(r.ok ? { ok: true, title: `Sent to ${list.join(', ')}`, lines: [`Balance ${R(r.body.balance)}`] } : { ok: false, title: 'Not sent', lines: r.reasons });
    if (r.ok) { setMessage(''); load(); }
  };
  return (
    <>
      <Heading>Statement</Heading>
      <Choice options={ST.STATEMENT_PERIODS} value={period} onChange={v => { setPeriod(v); setAns(null); }} labels={ST.PERIOD_LABEL} />
      {!s ? <Body quiet>Loading…</Body> : (
        <>
          <Card>
            <Text style={st.small}>{s.from ? `${day(s.from)} to ${day(s.to)}` : `Everything to ${day(s.to)}`}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>{R(s.closing)}</Text>
              <Text style={st.small}>balance due{s.overdue ? ` · ${R(s.overdue)} past its due date` : ''}</Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {DB.AGE_BANDS.map(b => (
                <View key={b} style={{ flexGrow: 1, flexBasis: 90, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 8 }} accessibilityLabel={`Age ${DB.AGE_LABEL[b]}`}>
                  <Text style={st.small}>{DB.AGE_LABEL[b]}</Text>
                  <Text style={[st.body, { fontWeight: '800', color: s.ages[b] ? (b === 'current' ? C.text : b === 'd30' ? C.text : C.bad) : C.quiet }]}>{s.ages[b] ? R(s.ages[b]) : '–'}</Text>
                </View>
              ))}
            </View>
          </Card>
          <Card>
            {s.from ? <StRow date={s.from} ref_="" text="Balance brought forward" bal={s.opening} /> : null}
            {s.lines.map((l, i) => <StRow key={i} date={l.date} ref_={l.ref} text={l.description} debit={l.debitCents} credit={l.creditCents} bal={l.balanceCents} />)}
            {!s.lines.length ? <Text style={st.small}>Nothing in this period.</Text> : null}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 6, gap: 8, flexWrap: 'wrap' }}>
              <Text style={st.small}>Debits {R(s.debits)} · credits {R(s.credits)}</Text>
              <Text style={[st.body, { fontWeight: '800' }]}>Balance due {R(s.closing)}</Text>
            </View>
          </Card>
          {Platform.OS === 'web' ? <Button label="Print / save as PDF (letterhead)" kind="secondary" onPress={print} /> : null}
          <Card>
            <Text style={[st.body, { fontWeight: '800' }]}>Email it to the customer</Text>
            <Field label="To (separate with commas)" value={to ?? ''} onChangeText={setTo} placeholder="accounts@customer.co.za" autoCapitalize="none" keyboardType="email-address" />
            <Field label="Message (optional)" value={message} onChangeText={setMessage} placeholder="e.g. Please find your statement. Kindly settle the 90-day balance." multiline />
            {d.mailReady ? (d.canEmail ? <Button label="Send the statement" onPress={email} busy={busy} /> : <Text style={st.small}>Accounts sends statements.</Text>)
              : <Text style={st.small}>Email goes once the office server is set up (its email account). Until then print it or save it as PDF and attach it.</Text>}
            {(d.emails ?? []).map((e: any, i: number) => (
              <Text key={i} style={[st.small, { color: e.ok ? C.quiet : C.bad }]}>{e.ok ? 'Sent' : 'Failed'} {new Date(e.sent_at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} by {e.sent_by} to {(e.sent_to ?? []).join(', ')} · {R(e.balance_cents)}{e.error ? ` · ${e.error}` : ''}</Text>
            ))}
          </Card>
        </>
      )}
      {ans ? <Notice tone={ans.ok ? 'good' : 'bad'} title={ans.title} lines={ans.lines} /> : null}
    </>
  );
}

function StRow({ date, ref_, text, debit, credit, bal }: { date: string; ref_: string; text: string; debit?: number; credit?: number; bal: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line, alignItems: 'flex-start' }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[st.body, { fontWeight: '700' }]} numberOfLines={1}>{ref_ ? `${ref_} · ` : ''}{day(date)}</Text>
        <Text style={st.small} numberOfLines={2}>{text}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[st.body, { color: credit ? C.good : C.text }]}>{debit ? R(debit) : credit ? `−${R(credit)}` : ''}</Text>
        <Text style={st.small}>{R(bal)}</Text>
      </View>
    </View>
  );
}
