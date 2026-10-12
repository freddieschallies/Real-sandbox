// The technician's quotes. He quotes on one of his jobs that is not finished, or starts a new quote
// for a store and can link a job card for reference. He picks the work and the parts; prices come
// from the price list (things to buy at his estimate). It goes to the office to check, price and send.
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useNav } from '../nav.tsx';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, Screen, Select, Stepper, rand, st } from '../ui.tsx';
import { C } from '../theme.ts';

type Opts = { stores: { id: string; name: string; address: string | null; client: string }[]; jobs: { id: string; job_number: number; status: string; store: string; open: boolean }[] };
type Mine = { id: string; quote_number: number; status: string; title: string; created_at: string; job_number: number | null; reference_job_number: number | null; store: string; ex_vat_cents: number };
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['Needs signal: try again when you have signal.'];
const STATUS: Record<string, { text: string; tone: 'info' | 'good' | 'warn' | 'bad' | 'quiet' }> = {
  draft: { text: 'With the office', tone: 'info' }, sent: { text: 'Sent to the client', tone: 'warn' }, accepted: { text: 'Accepted', tone: 'good' },
  declined: { text: 'Declined', tone: 'bad' }, cancelled: { text: 'Cancelled', tone: 'quiet' },
};

/** My day → Quotes: what he submitted, and a new one. */
export function MyQuotesScreen() {
  const s = useStore();
  const nav = useNav();
  const [list, setList] = useState<Mine[] | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  useEffect(() => { s.ask({ method: 'GET', path: '/me/quotes' }).then(r => { if (r?.status === 200) setList(r.body); else setErr(reasons(r)); }); }, []);
  return (
    <Screen title="Quotes" sub="Quote work you found on site" onBack={nav.back}>
      <Button label="New quote" onPress={() => nav.push({ name: 'quote' })} />
      <Text style={st.small}>To quote on a job you are busy with, open the job and tap "Submit a quote for this job".</Text>
      {err ? <Notice tone="warn" title="Could not load" lines={err} /> : null}
      {list && !list.length ? <Body quiet>You have not submitted a quote yet.</Body> : null}
      {list?.map(q => (
        <Card key={q.id} accessibilityLabel={`Quote ${q.quote_number}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>Q{q.quote_number} · {q.title}</Text>
            <Pill text={STATUS[q.status]?.text ?? q.status} tone={STATUS[q.status]?.tone ?? 'quiet'} />
          </View>
          <Text style={st.small}>{q.store}{q.job_number ? ` · job ${q.job_number}` : ''}{q.reference_job_number ? ` · see job card ${q.reference_job_number}` : ''} · {new Date(q.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}{q.ex_vat_cents ? ` · ${rand(q.ex_vat_cents)} excl. VAT so far` : ''}</Text>
        </Card>
      ))}
    </Screen>
  );
}

/** A new quote: on a job (jobId), or for a store with an optional job card for reference. */
export function TechQuoteScreen({ jobId }: { jobId?: string }) {
  const s = useStore();
  const nav = useNav();
  const [o, setO] = useState<Opts | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const [mode, setMode] = useState<'job' | 'new'>(jobId ? 'job' : 'new');
  const [job, setJob] = useState<string | undefined>(jobId);
  const [store, setStore] = useState<string | undefined>();
  const [ref, setRef] = useState<string>('');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [hours, setHours] = useState(0);
  const [parts, setParts] = useState<{ stockItemId: string; qty: number }[]>([]);
  const [pick, setPick] = useState<string | undefined>();
  const [pickQty, setPickQty] = useState(1);
  const [buy, setBuy] = useState<{ description: string; qty: number; estimatedPriceCents: number }[]>([]);
  const [bDesc, setBDesc] = useState('');
  const [bQty, setBQty] = useState(1);
  const [bPrice, setBPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ n: number; unpriced: string[] } | null>(null);
  useEffect(() => { s.ask({ method: 'GET', path: '/me/quote-options' }).then(r => { if (r?.status === 200) setO(r.body); else setErr(reasons(r)); }); }, []);
  const catalogue = s.cache.catalogue ?? [];
  const partName = (id: string) => catalogue.find(c => c.id === id)?.description ?? 'Part';

  if (done) {
    return (
      <Screen title="Quote submitted" onBack={() => nav.back()}>
        <Notice tone="good" title={`Quote ${done.n} is with the office`} lines={['They check it, price it and send it to the client. You see what happens to it under Quotes.',
          ...(done.unpriced.length ? [`No price on the list yet for: ${done.unpriced.join(', ')}. The office fills it in.`] : [])]} />
        <Button label="Back" onPress={() => nav.back()} />
      </Screen>
    );
  }
  const open = o?.jobs.filter(j => j.open) ?? [];
  const cur = o?.jobs.find(j => j.id === job);
  const ready = title.trim().length >= 3 && (hours > 0 || parts.length > 0 || buy.length > 0) && (mode === 'job' ? !!job : !!store);
  const submit = async () => {
    setBusy(true); setErr(null);
    const r = await s.ask({ method: 'POST', path: '/me/quotes', json: {
      ...(mode === 'job' ? { jobId: job } : { storeId: store, referenceJobId: ref || undefined }),
      title: title.trim(), notes: notes.trim() || undefined, labourHours: hours, stockLines: parts, boughtOutLines: buy } });
    setBusy(false);
    if (r && r.status < 300) setDone({ n: r.body.quoteNumber, unpriced: r.body.unpriced ?? [] }); else setErr(reasons(r));
  };
  return (
    <Screen title={jobId && cur ? `Quote · job ${cur.job_number}` : 'New quote'} sub={jobId && cur ? cur.store : 'Goes to the office to price and send'} onBack={nav.back}>
      {!o && !err ? <Body quiet>Loading…</Body> : null}
      {o ? (
        <>
          {!jobId ? (
            <Choice options={['new', 'job'] as const} value={mode} onChange={setMode} labels={{ new: 'New, for a store', job: 'On one of my open jobs' }} />
          ) : null}
          {mode === 'job' ? (
            jobId ? null : open.length ? (
              <Select label="Which job" value={job} onChange={setJob} options={open.map(j => ({ value: j.id, label: `#${j.job_number} · ${j.store}` }))} />
            ) : <Notice tone="info" title="No open jobs" lines={['Start a new quote for the store instead; you can link a job card for reference.']} />
          ) : (
            <>
              <Select label="Store" value={store} onChange={setStore} placeholder="Choose the store" options={o.stores.map(x => ({ value: x.id, label: `${x.name}${x.client && x.client !== x.name ? ` (${x.client})` : ''}` }))} />
              <Select label="Job card for reference (optional)" value={ref} onChange={setRef} placeholder="None"
                options={[{ value: '', label: 'None' }, ...o.jobs.map(j => ({ value: j.id, label: `#${j.job_number} · ${j.store} · ${j.open ? 'open' : 'finished'}` }))]} />
            </>
          )}
          <Field label="What is the quote for?" value={title} onChangeText={setTitle} placeholder="e.g. Replace the cold room door seal" />
          <Field label="What you found (optional)" value={notes} onChangeText={setNotes} multiline placeholder="What is wrong, what it needs, anything the office should know" />

          <Heading>The work</Heading>
          <Card>
            <Label>Labour (hours)</Label>
            <Stepper value={hours} onChange={setHours} step={0.5} max={500} label="labour hours" />
          </Card>
          <Card>
            <Label>Parts from stock</Label>
            {parts.map((p, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 6 }}>
                <Text style={[st.body, { flex: 1 }]}>{partName(p.stockItemId)} ×{p.qty}</Text>
                <Pressable onPress={() => setParts(x => x.filter((_, j) => j !== i))} accessibilityRole="button" accessibilityLabel={`Remove ${partName(p.stockItemId)}`} hitSlop={8}><Text style={{ color: C.bad, fontWeight: '700' }}>Remove</Text></Pressable>
              </View>
            ))}
            <Select label="Part" value={pick} onChange={setPick} placeholder="Choose a part" options={catalogue.map(c => ({ value: c.id, label: `${c.code} · ${c.description}` }))} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
              <Stepper value={pickQty} onChange={setPickQty} label="quantity" />
              <Button label="Add part" kind="secondary" disabled={!pick || pickQty <= 0} onPress={() => { setParts(x => [...x, { stockItemId: pick!, qty: pickQty }]); setPick(undefined); setPickQty(1); }} />
            </View>
            <Text style={st.small}>Prices come from the company's price list.</Text>
          </Card>
          <Card>
            <Label>Things to buy</Label>
            {buy.map((x, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 6 }}>
                <Text style={[st.body, { flex: 1 }]}>{x.description} ×{x.qty}{x.estimatedPriceCents ? ` · about ${rand(x.estimatedPriceCents)} each` : ''}</Text>
                <Pressable onPress={() => setBuy(b => b.filter((_, j) => j !== i))} accessibilityRole="button" accessibilityLabel={`Remove ${x.description}`} hitSlop={8}><Text style={{ color: C.bad, fontWeight: '700' }}>Remove</Text></Pressable>
              </View>
            ))}
            <Field label="Item" value={bDesc} onChangeText={setBDesc} placeholder="e.g. Door gasket 1.8 m" />
            <Field label="Rough price each, R (optional)" value={bPrice} onChangeText={setBPrice} keyboardType="decimal-pad" placeholder="e.g. 850" />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
              <Stepper value={bQty} onChange={setBQty} label="quantity to buy" />
              <Button label="Add item" kind="secondary" disabled={bDesc.trim().length < 2 || bQty <= 0} onPress={() => {
                setBuy(b => [...b, { description: bDesc.trim(), qty: bQty, estimatedPriceCents: Math.max(0, Math.round((Number(bPrice.replace(',', '.')) || 0) * 100)) }]);
                setBDesc(''); setBPrice(''); setBQty(1);
              }} />
            </View>
          </Card>
          {err ? <Notice tone="bad" title="Not submitted" lines={err} /> : null}
          <Button label="Submit the quote to the office" onPress={submit} busy={busy} disabled={!ready} />
          {!ready ? <Text style={st.small}>Needed: {[mode === 'job' ? (!job ? 'the job' : null) : (!store ? 'the store' : null), title.trim().length < 3 ? 'what it is for' : null, !(hours > 0 || parts.length || buy.length) ? 'the work (hours, parts or things to buy)' : null].filter(Boolean).join(', ')}.</Text> : null}
        </>
      ) : null}
      {err && !o ? <Notice tone="warn" title="Needs signal" lines={err} /> : null}
    </Screen>
  );
}
