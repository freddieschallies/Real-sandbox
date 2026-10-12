// Quotes, invoices and the link to Sage Pastel Partner, for whoever the CEO gave quotes and invoices.
// A quote or invoice is made here on the company letterhead, sent, and then exported in an import
// batch for Pastel, so the books stay in Pastel.
import { BrandLogo, brandChanged, currentLogo, useBrand } from '../brand.tsx';
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import { rememberPhoto } from '../photo.ts';
import { nowIso, pickImage } from '../device.ts';
import * as D from '../../../server/src/core/documents.ts';
import * as P from '../../../server/src/core/pastel.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';

type Line = D.DocLine & { id?: string };
type Ans = { ok: true; body: any } | { ok: false; reasons: string[] };
const R = (c: number) => D.rand(c);
const day = (s: string | null | undefined) => (s ? new Date(`${s.slice(0, 10)}T12:00:00+02:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
const STATUS: Record<string, { t: string; tone: 'info' | 'good' | 'warn' | 'bad' | 'quiet' }> = {
  draft: { t: 'Draft', tone: 'quiet' }, sent: { t: 'Sent', tone: 'info' }, accepted: { t: 'Accepted', tone: 'good' }, declined: { t: 'Declined', tone: 'bad' },
  paid: { t: 'Paid', tone: 'good' }, cancelled: { t: 'Cancelled', tone: 'quiet' },
};
const K = { stripe: '#E8701A' };

export function useBooks() {
  const s = useStore();
  const ask = useCallback(async (method: 'GET' | 'POST' | 'PUT', path: string, json?: object): Promise<Ans> => {
    const r = await s.ask({ method, path, json });
    if (r && r.status < 300) return { ok: true, body: r.body };
    return { ok: false, reasons: (r?.body as { reasons?: string[] })?.reasons ?? ['no signal: try again'] };
  }, [s]);
  const [quotes, setQuotes] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [toInvoice, setToInvoice] = useState<any[]>([]);
  const [company, setCompany] = useState<{ profile: any; rates: Record<string, number>; rateKeys: { key: string; label: string }[] } | null>(null);
  const load = useCallback(async () => {
    const [q, i, t, c] = await Promise.all([ask('GET', '/quotes'), ask('GET', '/invoices'), ask('GET', '/office/to-invoice'), ask('GET', '/office/company')]);
    if (q.ok) setQuotes(q.body); if (i.ok) setInvoices(i.body); if (t.ok) setToInvoice(t.body); if (c.ok) setCompany(c.body);
  }, [ask]);
  useEffect(() => { load(); }, []);
  const act = async (method: 'POST' | 'PUT', path: string, json: object) => { const r = await ask(method, path, json); if (r.ok) await load(); return r; };
  return { quotes, invoices, toInvoice, company, load, ask, act };
}
export type Books = ReturnType<typeof useBooks>;

function Reasons({ a }: { a: Ans | null }) { return a && !a.ok ? <Notice tone="bad" title="Not yet. Still needed:" lines={a.reasons} /> : null; }

// ---- Lines ----------------------------------------------------------------------------------

const KINDS = ['labour', 'call_out', 'travel', 'stock', 'bought_out', 'other'] as const;
function LinesEditor({ lines, set, rates }: { lines: Line[]; set: (l: Line[]) => void; rates: Record<string, number> }) {
  const up = (i: number, p: Partial<Line>) => set(lines.map((l, n) => (n === i ? { ...l, ...p } : l)));
  const priceFor = (k: D.LineKind) => (k === 'labour' ? rates.labour_per_hour : k === 'call_out' ? rates.call_out : k === 'travel' ? rates.travel_per_km : 0) ?? 0;
  return (
    <View style={{ gap: 10 }}>
      {lines.map((l, i) => (
        <Card key={i} style={!(l.unitPriceCents > 0) ? { borderColor: C.warn } : undefined}>
          <Choice options={KINDS} value={l.kind} onChange={k => up(i, { kind: k, unitPriceCents: l.unitPriceCents || priceFor(k), description: l.description || D.KIND_LABEL[k] })} labels={D.KIND_LABEL} />
          <Field label="Description" value={l.description} onChangeText={t => up(i, { description: t })} />
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-end' }}>
            <View style={{ flex: 1 }}><Field label={l.kind === 'labour' ? 'Hours' : l.kind === 'travel' ? 'Km' : 'Qty'} value={String(l.qty)} onChangeText={t => up(i, { qty: Number(t.replace(',', '.')) || 0 })} keyboardType="decimal-pad" /></View>
            <View style={{ flex: 1 }}><Field label="Price each excl. VAT (R)" value={l.unitPriceCents ? (l.unitPriceCents / 100).toFixed(2) : ''} onChangeText={t => up(i, { unitPriceCents: Math.round((Number(t.replace(',', '.')) || 0) * 100) })} keyboardType="decimal-pad" /></View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[st.body, { flex: 1, fontWeight: '700' }]}>{R(D.lineTotal(l))}</Text>
            <Button label="Remove" kind="quiet" onPress={() => set(lines.filter((_, n) => n !== i))} style={{ minHeight: 40 }} />
          </View>
        </Card>
      ))}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {(['labour', 'call_out', 'stock', 'other'] as const).map(k => (
          <Button key={k} label={`+ ${D.KIND_LABEL[k]}`} kind="secondary" onPress={() => set([...lines, { kind: k, description: k === 'stock' ? '' : D.KIND_LABEL[k], qty: 1, unitPriceCents: priceFor(k) }])} style={{ flexGrow: 1, flexBasis: 110, minHeight: 44 }} />
        ))}
      </View>
    </View>
  );
}

// ---- The document on the letterhead -------------------------------------------------------------

export function Paper({ kind, doc, lines, totals, company }: { kind: 'quote' | 'invoice'; doc: any; lines: Line[]; totals: { exVatCents: number; vatCents: number; totalCents: number }; company: any }) {
  const co = company ?? {};
  const cell = { color: '#111', fontSize: 13 } as const;
  return (
    <View style={{ backgroundColor: '#FFFFFF', borderRadius: 6, overflow: 'hidden' }}>
      <View style={{ height: 10, backgroundColor: K.stripe }} />
      <View style={{ backgroundColor: '#111111', paddingHorizontal: 20, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 16 }}>
        <BrandLogo height={44} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#FFFFFF', fontSize: 22, fontWeight: '900', letterSpacing: 1 }}>{co.trading_name || co.legal_name || 'Company name'}</Text>
          {co.trading_name && co.legal_name ? <Text style={{ color: '#DDD', fontSize: 12 }}>{co.legal_name}</Text> : null}
        </View>
        <Text style={{ color: K.stripe, fontSize: 20, fontWeight: '900' }}>{kind === 'quote' ? 'QUOTATION' : 'TAX INVOICE'}</Text>
      </View>
      <View style={{ padding: 20, gap: 14 }}>
        <View style={{ flexDirection: 'row', gap: 20, flexWrap: 'wrap' }}>
          <View style={{ flex: 1, minWidth: 200, gap: 2 }}>
            <Text style={[cell, { fontWeight: '800' }]}>{kind === 'quote' ? 'Quote for' : 'Invoice to'}</Text>
            <Text style={cell}>{doc.client}</Text>
            <Text style={cell}>{doc.store}</Text>
            {doc.store_address ? <Text style={cell}>{doc.store_address}</Text> : null}
          </View>
          <View style={{ minWidth: 200, gap: 2 }}>
            <Text style={cell}><Text style={{ fontWeight: '800' }}>{kind === 'quote' ? 'Quote no.' : 'Invoice no.'} </Text>{kind === 'quote' ? doc.quote_number : doc.invoice_number}</Text>
            <Text style={cell}><Text style={{ fontWeight: '800' }}>Date </Text>{day(doc.sent_at ?? doc.created_at)}</Text>
            {kind === 'quote' ? <Text style={cell}><Text style={{ fontWeight: '800' }}>Valid until </Text>{day(doc.valid_until)}</Text> : <Text style={cell}><Text style={{ fontWeight: '800' }}>Due </Text>{day(doc.due_date)}</Text>}
            {doc.client_ref ? <Text style={cell}><Text style={{ fontWeight: '800' }}>Your order no. </Text>{doc.client_ref}</Text> : null}
            {doc.job_number ? <Text style={cell}><Text style={{ fontWeight: '800' }}>Job </Text>{doc.job_number}</Text> : null}
          </View>
        </View>
        {kind === 'quote' && doc.title ? <Text style={[cell, { fontSize: 15, fontWeight: '800' }]}>{doc.title}</Text> : null}
        <View style={{ borderTopWidth: 2, borderTopColor: '#111' }}>
          <View style={{ flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#CCC' }}>
            <Text style={[cell, { flex: 1, fontWeight: '800' }]}>Description</Text>
            <Text style={[cell, { width: 60, textAlign: 'right', fontWeight: '800' }]}>Qty</Text>
            <Text style={[cell, { width: 100, textAlign: 'right', fontWeight: '800' }]}>Price</Text>
            <Text style={[cell, { width: 110, textAlign: 'right', fontWeight: '800' }]}>Total</Text>
          </View>
          {lines.map((l, i) => (
            <View key={i} style={{ flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#EEE' }}>
              <Text style={[cell, { flex: 1 }]}>{l.description}</Text>
              <Text style={[cell, { width: 60, textAlign: 'right' }]}>{l.qty}</Text>
              <Text style={[cell, { width: 100, textAlign: 'right' }]}>{R(l.unitPriceCents)}</Text>
              <Text style={[cell, { width: 110, textAlign: 'right' }]}>{R(D.lineTotal(l))}</Text>
            </View>
          ))}
          <View style={{ alignItems: 'flex-end', paddingTop: 8, gap: 2 }}>
            <Text style={cell}>Total excl. VAT  {R(totals.exVatCents)}</Text>
            <Text style={cell}>VAT {doc.vat_pct ?? co.vat_pct ?? 15}%  {R(totals.vatCents)}</Text>
            <Text style={[cell, { fontSize: 16, fontWeight: '900' }]}>Total  {R(totals.totalCents)}</Text>
          </View>
        </View>
        {doc.notes ? <Text style={cell}>{doc.notes}</Text> : null}
        {(kind === 'quote' ? co.quote_terms : co.invoice_terms) ? <Text style={[cell, { color: '#444' }]}>{kind === 'quote' ? co.quote_terms : co.invoice_terms}</Text> : null}
        {kind === 'invoice' && co.bank_details ? <Text style={cell}><Text style={{ fontWeight: '800' }}>Banking details: </Text>{co.bank_details}</Text> : null}
      </View>
      <View style={{ backgroundColor: '#111111', paddingHorizontal: 20, paddingVertical: 10, gap: 2 }}>
        <Text style={{ color: '#EEE', fontSize: 11 }}>{[co.address, co.phone, co.email].filter(Boolean).join(' · ') || 'Address · phone · email (set in Accounts)'}</Text>
        <Text style={{ color: '#EEE', fontSize: 11 }}>Reg. no. {co.reg_no || '–'} · VAT no. {co.vat_no || '–'}</Text>
      </View>
      <View style={{ height: 6, backgroundColor: K.stripe }} />
    </View>
  );
}

/** Print or save as PDF (in a browser). */
function printDoc(kind: 'quote' | 'invoice', doc: any, lines: Line[], totals: any, co: any) {
  if (Platform.OS !== 'web') return false;
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const rows = lines.map(l => `<tr><td>${esc(l.description)}</td><td class=r>${l.qty}</td><td class=r>${R(l.unitPriceCents)}</td><td class=r>${R(D.lineTotal(l))}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${kind === 'quote' ? 'Quote' : 'Invoice'} ${kind === 'quote' ? doc.quote_number : doc.invoice_number}</title>
<style>body{font:13px Arial,sans-serif;margin:0;color:#111}.bar{height:10px;background:#E8701A}.head{background:#111;color:#fff;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
.head h1{margin:0;font-size:22px;letter-spacing:1px}.head .t{color:#E8701A;font-weight:900;font-size:20px}.body{padding:20px 24px}.two{display:flex;justify-content:space-between;gap:20px}
table{width:100%;border-collapse:collapse;margin-top:14px}th{text-align:left;border-top:2px solid #111;border-bottom:1px solid #ccc;padding:6px 4px}td{border-bottom:1px solid #eee;padding:6px 4px}.r{text-align:right}
.tot{text-align:right;margin-top:8px}.tot b{font-size:16px}.foot{background:#111;color:#eee;font-size:11px;padding:10px 24px}@media print{.noprint{display:none}}</style></head><body>
<div class=bar></div><div class=head>${currentLogo() ? `<img src="${currentLogo()}" style="height:56px;background:#fff;padding:4px;border-radius:4px;margin-right:14px">` : ''}<div style="flex:1"><h1>${esc(co.trading_name || co.legal_name)}</h1>${co.trading_name ? `<div>${esc(co.legal_name)}</div>` : ''}</div><div class=t>${kind === 'quote' ? 'QUOTATION' : 'TAX INVOICE'}</div></div>
<div class=body><div class=two><div><b>${kind === 'quote' ? 'Quote for' : 'Invoice to'}</b><br>${esc(doc.client)}<br>${esc(doc.store)}<br>${esc(doc.store_address)}</div>
<div><b>${kind === 'quote' ? 'Quote no.' : 'Invoice no.'}</b> ${kind === 'quote' ? doc.quote_number : doc.invoice_number}<br><b>Date</b> ${day(doc.sent_at ?? doc.created_at)}<br>
${kind === 'quote' ? `<b>Valid until</b> ${day(doc.valid_until)}` : `<b>Due</b> ${day(doc.due_date)}`}${doc.client_ref ? `<br><b>Your order no.</b> ${esc(doc.client_ref)}` : ''}${doc.job_number ? `<br><b>Job</b> ${doc.job_number}` : ''}</div></div>
${kind === 'quote' && doc.title ? `<h3>${esc(doc.title)}</h3>` : ''}<table><tr><th>Description</th><th class=r>Qty</th><th class=r>Price</th><th class=r>Total</th></tr>${rows}</table>
<div class=tot>Total excl. VAT ${R(totals.exVatCents)}<br>VAT ${doc.vat_pct ?? 15}% ${R(totals.vatCents)}<br><b>Total ${R(totals.totalCents)}</b></div>
${doc.notes ? `<p>${esc(doc.notes)}</p>` : ''}<p>${esc(kind === 'quote' ? co.quote_terms : co.invoice_terms)}</p>${kind === 'invoice' && co.bank_details ? `<p><b>Banking details:</b> ${esc(co.bank_details)}</p>` : ''}</div>
<div class=foot>${esc([co.address, co.phone, co.email].filter(Boolean).join(' · '))}<br>Reg. no. ${esc(co.reg_no || '–')} · VAT no. ${esc(co.vat_no || '–')}</div><div class=bar></div>
<p class=noprint style="padding:12px 24px"><button onclick="print()">Print / save as PDF</button></p></body></html>`;
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(html); w.document.close();
  return true;
}

// ---- Quotes -------------------------------------------------------------------------------------

export function QuoteList({ b, open, add }: { b: Books; open: (id: string) => void; add: () => void }) {
  const [f, setF] = useState<'open' | 'all'>('open');
  const list = b.quotes.filter(q => f === 'all' || q.status === 'draft' || q.status === 'sent');
  return (
    <>
      <Button label="New quote" onPress={add} />
      <Choice options={['open', 'all'] as const} value={f} onChange={setF} labels={{ open: 'Drafts and sent', all: 'All quotes' }} />
      {list.map(q => (
        <Card key={q.id} onPress={() => open(q.id)} accessibilityLabel={`Quote ${q.quote_number}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800' }]}>Q{q.quote_number}</Text>
            <Text style={[st.body, { flex: 1 }]} numberOfLines={1}>{q.store}</Text>
            <Pill text={STATUS[q.status]?.t ?? q.status} tone={STATUS[q.status]?.tone ?? 'quiet'} />
          </View>
          <Body numberOfLines={1}>{q.title}</Body>
          <Text style={st.small}>{q.client}{q.job_number ? ` · job ${q.job_number}` : ''} · {R(q.total_cents)} incl. VAT{q.status === 'sent' && q.valid_until ? ` · valid until ${day(q.valid_until)}` : ''}</Text>
        </Card>
      ))}
      {!list.length ? <Body quiet>No quotes here.</Body> : null}
    </>
  );
}

export function NewQuote({ b, stores, jobs, done }: { b: Books; stores: { id: string; name: string; client: string }[]; jobs: { id: string; label: string }[]; done: (id?: string) => void }) {
  const [forWhat, setFor] = useState<'store' | 'job'>('store');
  const [storeId, setStore] = useState<string>();
  const [jobId, setJob] = useState<string>();
  const [q, setQ] = useState('');
  const [title, setTitle] = useState('');
  const [ans, setAns] = useState<Ans | null>(null);
  const shown = stores.filter(s => !q.trim() || `${s.client} ${s.name}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8);
  return (
    <>
      <Heading>New quote</Heading>
      <Choice options={['store', 'job'] as const} value={forWhat} onChange={setFor} labels={{ store: 'For a store', job: 'For an open job' }} />
      {forWhat === 'store' ? (
        <>
          <TextInput value={q} onChangeText={setQ} placeholder="Search client or store" placeholderTextColor={C.quiet} style={st.input} />
          {shown.map(s => (
            <Pressable key={s.id} onPress={() => setStore(s.id)} accessibilityRole="radio" accessibilityState={{ checked: storeId === s.id }}
              style={{ padding: 12, borderRadius: 8, borderWidth: 2, borderColor: storeId === s.id ? C.accent : C.line }}>
              <Text style={[st.body, { fontWeight: '700' }]}>{s.name}</Text><Text style={st.small}>{s.client}</Text>
            </Pressable>
          ))}
        </>
      ) : <Choice options={jobs.map(j => j.id)} value={jobId} onChange={setJob} labels={Object.fromEntries(jobs.map(j => [j.id, j.label]))} />}
      <Field label="What is the quote for?" value={title} onChangeText={setTitle} placeholder="e.g. Replace both oven door seals" />
      <Reasons a={ans} />
      <Button label="Make draft quote" onPress={async () => {
        const r = await b.act('POST', '/quotes', { ...(forWhat === 'store' ? { storeId } : { jobId }), title: title.trim(), lines: [] });
        setAns(r); if (r.ok) done(r.body.id);
      }} />
      <Button label="Cancel" kind="quiet" onPress={() => done()} />
    </>
  );
}

export function QuoteDetail({ b, id, techs }: { b: Books; id: string; techs: { id: string; full_name: string }[] }) {
  const [d, setD] = useState<any>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [ref, setRef] = useState('');
  const [ans, setAns] = useState<Ans | null>(null);
  const [panel, setPanel] = useState<'none' | 'accept' | 'decline' | 'cancel'>('none');
  const [note, setNote] = useState('');
  const [jobDate, setJobDate] = useState<string>();
  const [lead, setLead] = useState<string>();
  const load = async () => {
    const r = await b.ask('GET', `/quotes/${id}`);
    if (r.ok) { setD(r.body); setLines(r.body.lines); setTitle(r.body.quote.title); setNotes(r.body.quote.notes ?? ''); setRef(r.body.quote.client_ref ?? ''); }
  };
  useEffect(() => { load(); }, [id]);
  if (!d) return <Body quiet>Loading…</Body>;
  const q = d.quote;
  const draft = q.status === 'draft';
  const totals = D.totals(lines, q.vat_pct);
  const save = async () => { const r = await b.act('PUT', `/quotes/${id}`, { title: title.trim(), notes: notes.trim() || null, clientRef: ref.trim() || null, lines }); setAns(r); if (r.ok) await load(); return r; };
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() + i * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }));
  const doThen = async (path: string, json: object) => { const r = await b.act('POST', path, json); setAns(r); if (r.ok) { setPanel('none'); await load(); } };
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontSize: 26, fontWeight: '800' }}>Quote {q.quote_number}</Text>
        <Pill text={STATUS[q.status]?.t ?? q.status} tone={STATUS[q.status]?.tone ?? 'quiet'} />
        {q.pastel_batch_id ? <Pill text="In Pastel" tone="good" /> : null}
      </View>
      <Text style={st.small}>{q.client} · {q.store}{q.job_number ? ` · job ${q.job_number}` : ''} · made by {q.created_by_name}</Text>
      {q.resulting_job_number ? <Notice tone="good" title={`Accepted: job ${q.resulting_job_number} opened`} lines={q.decision_note ? [q.decision_note] : []} /> : null}
      {q.status === 'declined' ? <Notice tone="bad" title="Declined" lines={[q.decision_note ?? '']} /> : null}
      {draft ? (
        <>
          <Field label="What the quote is for" value={title} onChangeText={setTitle} />
          <LinesEditor lines={lines} set={setLines} rates={b.company?.rates ?? {}} />
          <Field label="Client's order number (optional)" value={ref} onChangeText={setRef} />
          <Field label="Note on the quote (optional)" value={notes} onChangeText={setNotes} multiline />
          <Text style={[st.body, { fontWeight: '800', textAlign: 'right' }]}>Excl. VAT {R(totals.exVatCents)} · VAT {R(totals.vatCents)} · Total {R(totals.totalCents)}</Text>
          <Reasons a={ans} />
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <Button label="Save draft" kind="secondary" onPress={save} style={{ flexGrow: 1, flexBasis: 140 }} />
            <Button label="Send quote" onPress={async () => { const r = await save(); if (r.ok) await doThen(`/quotes/${id}/send`, {}); }} style={{ flexGrow: 1, flexBasis: 140 }} />
          </View>
          <Text style={st.small}>Once sent it is locked. It is valid for {b.company?.profile?.quote_valid_days ?? 30} days.</Text>
        </>
      ) : null}
      {q.status === 'sent' ? (
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          <Button label="Client accepted" onPress={() => setPanel('accept')} style={{ flexGrow: 1, flexBasis: 140 }} />
          <Button label="Client declined" kind="secondary" onPress={() => setPanel('decline')} style={{ flexGrow: 1, flexBasis: 140 }} />
          <Button label="Cancel quote" kind="quiet" onPress={() => setPanel('cancel')} style={{ flexGrow: 1, flexBasis: 140 }} />
        </View>
      ) : null}
      {panel === 'accept' ? (
        <Card style={{ borderColor: C.good }}>
          <Field label="Client's order number" value={ref} onChangeText={setRef} />
          <Label>Open the job for the work now? (optional)</Label>
          <Choice options={techs.map(t => t.id)} value={lead} onChange={setLead} labels={Object.fromEntries(techs.map(t => [t.id, t.full_name]))} />
          {lead ? <Choice options={days} value={jobDate} onChange={setJobDate} labels={Object.fromEntries(days.map(x => [x, day(x)]))} /> : null}
          <Reasons a={ans} />
          <Button label={lead ? 'Accepted: open the job' : 'Mark accepted'} disabled={!!lead && !jobDate}
            onPress={() => doThen(`/quotes/${id}/accept`, { clientRef: ref.trim() || undefined, ...(lead && jobDate ? { newJob: { scheduledDate: jobDate, leadTechnicianId: lead } } : {}) })} />
        </Card>
      ) : null}
      {panel === 'decline' || panel === 'cancel' ? (
        <Card>
          <Field label={panel === 'decline' ? 'What did the client say?' : 'Why is it cancelled?'} value={note} onChangeText={setNote} />
          <Reasons a={ans} />
          <Button label={panel === 'decline' ? 'Mark declined' : 'Cancel quote'} kind="danger" onPress={() => doThen(`/quotes/${id}/${panel}`, { note: note.trim() })} />
        </Card>
      ) : null}
      {draft ? null : <Reasons a={ans} />}
      <Heading>As the client sees it</Heading>
      <Paper kind="quote" doc={{ ...q, title, notes, client_ref: ref }} lines={lines} totals={totals} company={d.company ?? b.company?.profile} />
      {Platform.OS === 'web' ? <Button label="Print / save as PDF" kind="secondary" onPress={() => { if (!printDoc('quote', { ...q, title, notes, client_ref: ref }, lines, totals, d.company ?? b.company?.profile ?? {})) setAns({ ok: false, reasons: ['the browser blocked the print window: allow pop-ups'] }); }} /> : null}
      {draft ? <Button label="Throw away this draft" kind="quiet" onPress={() => doThen(`/quotes/${id}/cancel`, { note: 'Draft thrown away' })} /> : null}
    </>
  );
}

// ---- Invoices -------------------------------------------------------------------------------------

export function InvoiceList({ b, open }: { b: Books; open: (id: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [ans, setAns] = useState<Ans | null>(null);
  const [f, setF] = useState<'open' | 'all'>('open');
  const list = b.invoices.filter(i => f === 'all' || i.status === 'draft' || i.status === 'sent');
  return (
    <>
      <Heading>Closed jobs to invoice ({b.toInvoice.length})</Heading>
      {b.toInvoice.map(j => (
        <Card key={j.id} style={{ borderLeftWidth: 5, borderLeftColor: C.warn }}>
          <Text style={[st.body, { fontWeight: '800' }]}>Job {j.job_number} · {j.store}</Text>
          <Text style={st.small}>{j.client} · closed {day(j.closed_at)} · {j.lead_technician}{j.client_order_ref ? ` · order ${j.client_order_ref}` : ''}</Text>
          <Body numberOfLines={1}>{j.fault_reported}</Body>
          <Button label="Make invoice from the job card" busy={busy === j.id} onPress={async () => { setBusy(j.id); const r = await b.act('POST', '/invoices', { jobId: j.id }); setBusy(null); setAns(r); if (r.ok) open(r.body.id); }} style={{ minHeight: 44 }} />
        </Card>
      ))}
      {!b.toInvoice.length ? <Body quiet>Every closed job has an invoice.</Body> : null}
      <Reasons a={ans} />
      <Heading>Invoices</Heading>
      <Choice options={['open', 'all'] as const} value={f} onChange={setF} labels={{ open: 'Drafts and unpaid', all: 'All invoices' }} />
      {list.map(i => (
        <Card key={i.id} onPress={() => open(i.id)} accessibilityLabel={`Invoice ${i.invoice_number}`} style={i.overdue ? { borderColor: C.bad } : undefined}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800' }]}>INV{i.invoice_number}</Text>
            <Text style={[st.body, { flex: 1 }]} numberOfLines={1}>{i.store}</Text>
            {i.overdue ? <Pill text="Overdue" tone="bad" /> : <Pill text={STATUS[i.status]?.t ?? i.status} tone={STATUS[i.status]?.tone ?? 'quiet'} />}
          </View>
          <Text style={st.small}>{i.client} · job {i.job_number} · {R(i.total_cents)} incl. VAT{i.status === 'sent' ? ` · due ${day(i.due_date)}` : ''}</Text>
        </Card>
      ))}
      {!list.length ? <Body quiet>No invoices here.</Body> : null}
    </>
  );
}

export function InvoiceDetail({ b, id }: { b: Books; id: string }) {
  const [d, setD] = useState<any>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [notes, setNotes] = useState('');
  const [ref, setRef] = useState('');
  const [ans, setAns] = useState<Ans | null>(null);
  const [panel, setPanel] = useState<'none' | 'paid' | 'cancel'>('none');
  const [note, setNote] = useState('');
  const load = async () => {
    const r = await b.ask('GET', `/invoices/${id}`);
    if (r.ok) { setD(r.body); setLines(r.body.lines); setNotes(r.body.invoice.notes ?? ''); setRef(r.body.invoice.client_ref ?? ''); }
  };
  useEffect(() => { load(); }, [id]);
  if (!d) return <Body quiet>Loading…</Body>;
  const i = d.invoice;
  const draft = i.status === 'draft';
  const totals = D.totals(lines, i.vat_pct);
  const missing = D.missingToSend({ lines });
  const save = async () => { const r = await b.act('PUT', `/invoices/${id}`, { notes: notes.trim() || null, clientRef: ref.trim() || null, lines }); setAns(r); if (r.ok) await load(); return r; };
  const doThen = async (path: string, json: object) => { const r = await b.act('POST', path, json); setAns(r); if (r.ok) { setPanel('none'); await load(); } };
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontSize: 26, fontWeight: '800' }}>Invoice {i.invoice_number}</Text>
        <Pill text={STATUS[i.status]?.t ?? i.status} tone={STATUS[i.status]?.tone ?? 'quiet'} />
        {i.pastel_batch_id ? <Pill text="In Pastel" tone="good" /> : null}
      </View>
      <Text style={st.small}>{i.client} · {i.store} · job {i.job_number}{i.job_closed ? `, closed ${day(i.job_closed)}` : ''}</Text>
      <Text style={st.small}>{i.fault_reported}</Text>
      {i.status === 'paid' ? <Notice tone="good" title={`Paid ${day(i.paid_at)}`} lines={[`Reference: ${i.paid_ref}`]} /> : null}
      {i.status === 'cancelled' ? <Notice tone="warn" title="Cancelled" lines={[i.cancel_note ?? '']} /> : null}
      {draft ? (
        <>
          <Text style={st.small}>Drafted from the job card: labour from the job timers (per quarter hour), the call-out, and the parts used. Check and price every line.</Text>
          <LinesEditor lines={lines} set={setLines} rates={b.company?.rates ?? {}} />
          <Field label="Client's order number" value={ref} onChangeText={setRef} />
          <Field label="Note on the invoice (optional)" value={notes} onChangeText={setNotes} multiline />
          <Text style={[st.body, { fontWeight: '800', textAlign: 'right' }]}>Excl. VAT {R(totals.exVatCents)} · VAT {R(totals.vatCents)} · Total {R(totals.totalCents)}</Text>
          {missing.length ? <Notice tone="warn" title="Before it can be sent" lines={missing} /> : null}
          <Reasons a={ans} />
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <Button label="Save draft" kind="secondary" onPress={save} style={{ flexGrow: 1, flexBasis: 140 }} />
            <Button label="Send invoice" onPress={async () => { const r = await save(); if (r.ok) await doThen(`/invoices/${id}/send`, {}); }} style={{ flexGrow: 1, flexBasis: 140 }} />
          </View>
          <Text style={st.small}>Once sent it is locked; it is due in {b.company?.profile?.invoice_due_days ?? 30} days. A mistake after sending: cancel it and make a new one.</Text>
        </>
      ) : null}
      {i.status === 'sent' ? (
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          <Button label="Mark paid" onPress={() => setPanel('paid')} style={{ flexGrow: 1, flexBasis: 140 }} />
          <Button label="Cancel invoice" kind="secondary" onPress={() => setPanel('cancel')} style={{ flexGrow: 1, flexBasis: 140 }} />
        </View>
      ) : null}
      {panel !== 'none' ? (
        <Card>
          <Field label={panel === 'paid' ? 'Payment reference (e.g. EFT 22831)' : 'Why is it cancelled?'} value={note} onChangeText={setNote} />
          <Reasons a={ans} />
          <Button label={panel === 'paid' ? 'Mark paid' : 'Cancel invoice'} kind={panel === 'paid' ? 'primary' : 'danger'}
            onPress={() => doThen(`/invoices/${id}/${panel}`, panel === 'paid' ? { ref: note.trim() } : { note: note.trim() })} />
        </Card>
      ) : null}
      {draft ? null : <Reasons a={ans} />}
      <Heading>As the client sees it</Heading>
      <Paper kind="invoice" doc={{ ...i, notes, client_ref: ref }} lines={lines} totals={totals} company={d.company ?? b.company?.profile} />
      {Platform.OS === 'web' ? <Button label="Print / save as PDF" kind="secondary" onPress={() => { if (!printDoc('invoice', { ...i, notes, client_ref: ref }, lines, totals, d.company ?? b.company?.profile ?? {})) setAns({ ok: false, reasons: ['the browser blocked the print window: allow pop-ups'] }); }} /> : null}
      {draft ? <Button label="Throw away this draft" kind="quiet" onPress={() => doThen(`/invoices/${id}/cancel`, { note: 'Draft thrown away' })} /> : null}
    </>
  );
}

// ---- Accounts: Sage Pastel and the company's details ----------------------------------------------

export function Accounts({ b, canPrices }: { b: Books; canPrices: boolean }) {
  const [kind, setKind] = useState<'invoice' | 'quote'>('invoice');
  const [ready, setReady] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [settings, setSettings] = useState<P.PastelSettings | null>(null);
  const [made, setMade] = useState<any>(null);
  const [ans, setAns] = useState<Ans | null>(null);
  const [panel, setPanel] = useState<'none' | 'codes' | 'clients' | 'company'>('none');
  const load = async () => {
    const [r, bt, cl, s] = await Promise.all([b.ask('GET', `/pastel/ready?kind=${kind}`), b.ask('GET', '/pastel/batches'), b.ask('GET', '/pastel/clients'), b.ask('GET', '/pastel/settings')]);
    if (r.ok) setReady(r.body); if (bt.ok) setBatches(bt.body); if (cl.ok) setClients(cl.body); if (s.ok) setSettings(s.body.settings);
  };
  useEffect(() => { load(); }, [kind]);
  const good = ready.filter(x => !x.problems.length);
  const download = (name: string, text: string) => {
    if (Platform.OS !== 'web') return;
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { /* the file is shown below to copy */ }
  };
  return (
    <>
      <Notice tone="info" title="Sage Pastel Partner" lines={[
        'Sent quotes and invoices go into Pastel in an import batch: make the batch here, then in Pastel open Process, Customers, Invoices (or Quotations), start a batch and choose Import.',
        'Each quote or invoice goes into one batch only, so nothing is imported twice.',
      ]} />
      <Choice options={['invoice', 'quote'] as const} value={kind} onChange={k => { setKind(k); setMade(null); }} labels={{ invoice: 'Invoices', quote: 'Quotes' }} />
      <Heading>Waiting to go to Pastel ({ready.length})</Heading>
      {ready.map(x => (
        <Card key={x.id} style={x.problems.length ? { borderColor: C.warn } : undefined}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{kind === 'invoice' ? 'INV' : 'Q'}{x.number} · {x.store}</Text>
            {x.problems.length ? <Pill text="Needs codes" tone="warn" /> : <Pill text="Ready" tone="good" />}
          </View>
          <Text style={st.small}>{day(x.date)} · customer {x.customerCode ?? '?'} · {x.lines} line{x.lines === 1 ? '' : 's'}</Text>
          {x.problems.length ? <Text style={[st.small, { color: C.warn }]}>Still needed: {x.problems.join('; ')}</Text> : null}
        </Card>
      ))}
      {!ready.length ? <Body quiet>Nothing waiting.</Body> : null}
      <Reasons a={ans} />
      <Button label={`Make Pastel batch (${good.length})`} disabled={!good.length} onPress={async () => {
        const r = await b.ask('POST', '/pastel/batches', { kind });
        setAns(r); if (r.ok) { setMade(r.body); download(r.body.filename, r.body.file); await load(); }
      }} />
      {made ? (
        <Card style={{ borderColor: C.good }}>
          <Text style={[st.body, { fontWeight: '800' }]}>{made.filename}</Text>
          <Text style={st.small}>{made.numbers.length} {kind}{made.numbers.length === 1 ? '' : 's'}: {made.numbers.join(', ')}{made.skipped.length ? ` · ${made.skipped.length} skipped (need codes)` : ''}</Text>
          <Button label="Download the file again" kind="secondary" onPress={() => download(made.filename, made.file)} />
          <Text selectable style={{ color: C.text, fontFamily: Platform.OS === 'web' ? 'monospace' : undefined, fontSize: 11, backgroundColor: C.panel2, padding: 8, borderRadius: 6 }}>{made.file}</Text>
        </Card>
      ) : null}
      {batches.length ? (
        <>
          <Heading>Batches made</Heading>
          {batches.slice(0, 10).map(x => <Text key={x.id} style={st.small}>{new Date(x.created_at).toLocaleString('en-ZA')} · {x.kind}s {x.numbers.join(', ')} · {x.created_by}</Text>)}
        </>
      ) : null}

      <Heading>Pastel setup</Heading>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Button label="Customer codes" kind="secondary" onPress={() => setPanel(panel === 'clients' ? 'none' : 'clients')} style={{ flexGrow: 1, flexBasis: 140 }} />
        <Button label="Line codes and VAT" kind="secondary" onPress={() => setPanel(panel === 'codes' ? 'none' : 'codes')} style={{ flexGrow: 1, flexBasis: 140 }} />
        {canPrices ? <Button label="Company details and rates" kind="secondary" onPress={() => setPanel(panel === 'company' ? 'none' : 'company')} style={{ flexGrow: 1, flexBasis: 140 }} /> : null}
      </View>
      {panel === 'clients' ? <ClientCodes b={b} clients={clients} reload={load} /> : null}
      {panel === 'codes' && settings ? <LineCodes b={b} s={settings} done={() => { setPanel('none'); load(); }} /> : null}
      {panel === 'company' ? <CompanyForm b={b} done={() => setPanel('none')} /> : null}
    </>
  );
}

function ClientCodes({ b, clients, reload }: { b: Books; clients: any[]; reload: () => void }) {
  const [codes, setCodes] = useState<Record<string, string>>(() => Object.fromEntries(clients.map(c => [c.id, c.pastel_code ?? ''])));
  const [ans, setAns] = useState<Ans | null>(null);
  return (
    <Card>
      <Text style={st.small}>Each client's account code in Pastel (up to 6 characters, as on the customer in Pastel).</Text>
      {clients.map(c => (
        <View key={c.id} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <Text style={[st.body, { flex: 1 }]}>{c.name} <Text style={st.small}>({c.stores} store{c.stores === 1 ? '' : 's'})</Text></Text>
          <TextInput value={codes[c.id] ?? ''} onChangeText={t => setCodes(x => ({ ...x, [c.id]: t.toUpperCase() }))} maxLength={6} autoCapitalize="characters" accessibilityLabel={`Pastel code for ${c.name}`}
            placeholder="CODE" placeholderTextColor={C.quiet} style={[st.input, { width: 120 }]} />
          <Button label="Save" kind="quiet" onPress={async () => { const r = await b.ask('PUT', `/pastel/clients/${encodeURIComponent(c.id)}`, { code: codes[c.id] || null }); setAns(r); if (r.ok) reload(); }} style={{ minHeight: 44 }} />
        </View>
      ))}
      <Reasons a={ans} />
    </Card>
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function LineCodes({ b, s, done }: { b: Books; s: P.PastelSettings; done: () => void }) {
  const [month, setMonth] = useState(String(s.yearStartMonth));
  const [tax, setTax] = useState(s.taxType);
  const [store, setStore] = useState(s.store ?? '');
  const [codes, setCodes] = useState<Record<string, { code: string; lineType: 4 | 6 }>>(() => Object.fromEntries((['labour', 'call_out', 'travel', 'bought_out', 'other'] as const).map(k => [k, s.codes[k] ?? { code: '', lineType: k === 'labour' || k === 'call_out' ? 4 : 6 }])));
  const [ans, setAns] = useState<Ans | null>(null);
  return (
    <Card>
      <Label>Financial year starts in</Label>
      <Choice options={MONTHS.map((_, i) => String(i + 1))} value={month} onChange={setMonth} labels={Object.fromEntries(MONTHS.map((m, i) => [String(i + 1), m.slice(0, 3)]))} />
      <Field label="Pastel tax type for VAT (usually 01)" value={tax} onChangeText={setTax} maxLength={2} keyboardType="number-pad" />
      <Field label="Pastel store code (only if Pastel uses more than one store)" value={store} onChangeText={setStore} maxLength={3} />
      <Text style={st.small}>Stock lines use the part's own code (the stockroom code must be the Pastel item code). The other lines go to these Pastel codes:</Text>
      {(['labour', 'call_out', 'travel', 'bought_out', 'other'] as const).map(k => (
        <View key={k} style={{ gap: 6 }}>
          <Label>{D.KIND_LABEL[k]}</Label>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <TextInput value={codes[k].code} onChangeText={t => setCodes(c => ({ ...c, [k]: { ...c[k], code: t } }))} maxLength={15} accessibilityLabel={`Pastel code for ${D.KIND_LABEL[k]}`}
              placeholder={codes[k].lineType === 4 ? 'item code' : 'GL account'} placeholderTextColor={C.quiet} style={[st.input, { width: 160 }]} />
            <Choice options={['4', '6'] as const} value={String(codes[k].lineType) as '4' | '6'} onChange={v => setCodes(c => ({ ...c, [k]: { ...c[k], lineType: Number(v) as 4 | 6 } }))} labels={{ 4: 'Item', 6: 'GL account' }} />
          </View>
        </View>
      ))}
      <Reasons a={ans} />
      <Button label="Save Pastel codes" onPress={async () => {
        const r = await b.ask('PUT', '/pastel/settings', { yearStartMonth: Number(month), taxType: tax.trim(), store: store.trim() || null,
          codes: Object.fromEntries(Object.entries(codes).filter(([, v]) => v.code.trim()).map(([k, v]) => [k, { code: v.code.trim(), lineType: v.lineType }])) });
        setAns(r); if (r.ok) done();
      }} />
    </Card>
  );
}

function CompanyForm({ b, done }: { b: Books; done: () => void }) {
  const p = b.company?.profile ?? {};
  const [f, setF] = useState<Record<string, string>>({
    legalName: p.legal_name ?? '', tradingName: p.trading_name ?? '', regNo: p.reg_no ?? '', vatNo: p.vat_no ?? '', address: p.address ?? '', phone: p.phone ?? '', email: p.email ?? '',
    bankDetails: p.bank_details ?? '', quoteTerms: p.quote_terms ?? '', invoiceTerms: p.invoice_terms ?? '', vatPct: String(p.vat_pct ?? 15), quoteValidDays: String(p.quote_valid_days ?? 30), invoiceDueDays: String(p.invoice_due_days ?? 30),
  });
  const [rates, setRates] = useState<Record<string, string>>(() => Object.fromEntries((b.company?.rateKeys ?? []).map(k => [k.key, k.key.endsWith('_pct') ? String(b.company?.rates[k.key] ?? '') : b.company?.rates[k.key] != null ? (b.company!.rates[k.key] / 100).toFixed(2) : ''])));
  const [ans, setAns] = useState<Ans | null>(null);
  const field = (k: string, label: string, multiline = false) => <Field key={k} label={label} value={f[k]} onChangeText={t => setF(x => ({ ...x, [k]: t }))} multiline={multiline} />;
  return (
    <Card>
      <Text style={st.small}>Printed on every quote and invoice (the letterhead), and the rates that new lines start from.</Text>
      <LogoPicker />
      {field('legalName', 'Registered name')}{field('tradingName', 'Trading name')}{field('regNo', 'Registration number')}{field('vatNo', 'VAT number')}
      {field('address', 'Address')}{field('phone', 'Phone')}{field('email', 'Email')}{field('bankDetails', 'Banking details (on invoices)', true)}
      {field('quoteTerms', 'Terms on quotes', true)}{field('invoiceTerms', 'Terms on invoices', true)}
      {field('vatPct', 'VAT %')}{field('quoteValidDays', 'Quotes valid for (days)')}{field('invoiceDueDays', 'Invoices due in (days)')}
      <Heading>Rates</Heading>
      {(b.company?.rateKeys ?? []).map(k => <Field key={k.key} label={k.label} value={rates[k.key] ?? ''} onChangeText={t => setRates(x => ({ ...x, [k.key]: t }))} keyboardType="decimal-pad" />)}
      <Reasons a={ans} />
      <Button label="Save" onPress={async () => {
        const r1 = await b.act('PUT', '/office/company', { legalName: f.legalName.trim(), tradingName: f.tradingName.trim() || null, regNo: f.regNo.trim() || null, vatNo: f.vatNo.trim() || null,
          address: f.address.trim() || null, phone: f.phone.trim() || null, email: f.email.trim() || '', bankDetails: f.bankDetails.trim() || null, quoteTerms: f.quoteTerms.trim() || null,
          invoiceTerms: f.invoiceTerms.trim() || null, vatPct: Number(f.vatPct) || 15, quoteValidDays: Number(f.quoteValidDays) || 30, invoiceDueDays: Number(f.invoiceDueDays) || 30 });
        if (!r1.ok) { setAns(r1); return; }
        const r2 = await b.act('PUT', '/office/rates', Object.fromEntries(Object.entries(rates).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, k.endsWith('_pct') ? Math.round(Number(v)) : Math.round(Number(v.replace(',', '.')) * 100)])));
        setAns(r2); if (r2.ok) done();
      }} />
    </Card>
  );
}

/** The company logo: shown in the app's header and on every letterhead. */
function LogoPicker() {
  const s = useStore();
  const { logo } = useBrand();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <View style={{ gap: 8 }}>
      <Label>Company logo</Label>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {logo ? <BrandLogo height={48} /> : <Text style={st.small}>No logo yet: the company name shows on its own.</Text>}
        <Button label={logo ? 'Change the logo' : 'Add the logo'} kind="secondary" onPress={async () => {
          const p = await pickImage();
          if (!p) return;
          const id = s.newId();
          rememberPhoto(s, id, p.uri);
          const up = await s.ask({ method: 'POST', path: '/photos', upload: { fields: { kind: 'logo', takenAt: nowIso(), id }, fileUri: p.uri, mime: p.mime } });
          if (!up || up.status >= 300) { setMsg('The logo could not be sent: try again with signal.'); return; }
          const cur = (await s.ask({ method: 'GET', path: '/office/company' }))?.body?.profile ?? {};
          const r = await s.ask({ method: 'PUT', path: '/office/company', json: { legalName: cur.legal_name ?? s.session?.company.name ?? 'Company', tradingName: cur.trading_name ?? null, regNo: cur.reg_no ?? null,
            vatNo: cur.vat_no ?? null, address: cur.address ?? null, phone: cur.phone ?? null, email: cur.email ?? '', bankDetails: cur.bank_details ?? null, quoteTerms: cur.quote_terms ?? null,
            invoiceTerms: cur.invoice_terms ?? null, vatPct: Number(cur.vat_pct ?? 15), quoteValidDays: Number(cur.quote_valid_days ?? 30), invoiceDueDays: Number(cur.invoice_due_days ?? 30), logoPhotoId: id } });
          setMsg(r && r.status < 300 ? 'Logo saved: it shows for everyone in the company.' : ((r?.body as { reasons?: string[] })?.reasons ?? ['not saved']).join('; '));
          brandChanged();
        }} />
      </View>
      {msg ? <Text style={st.small}>{msg}</Text> : null}
    </View>
  );
}
