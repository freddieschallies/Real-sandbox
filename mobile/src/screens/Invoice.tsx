// Supplier invoice: photograph it, the system reads it, the technician checks the lines and confirms.
// Confirmed lines land on his name at once, against the job (or as van stock).
import React, { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso, takePhoto, type Photo } from '../device.ts';
import * as S from '../../../server/src/core/stock.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Screen, rand, st } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';
import { C } from '../theme.ts';
import type { ReadLine, SupplierInvoice } from '../types.ts';

const VAN = 'van';

function useJobChoices() {
  const s = useStore();
  const jobs = (s.cache.today?.jobs ?? []).filter(j => j.status !== 'closed');
  return {
    options: [...jobs.map(j => j.id), VAN],
    labels: { ...Object.fromEntries(jobs.map(j => [j.id, `#${j.job_number} ${j.store}`])), [VAN]: 'Van stock' } as Record<string, string>,
  };
}

export function Invoice({ invoiceId, jobId }: { invoiceId?: string; jobId?: string }) {
  const s = useStore();
  const inv = invoiceId ? s.cache.invoices?.find(i => i.id === invoiceId) : undefined;
  if (invoiceId && inv) return <ConfirmInvoice inv={inv} />;
  return <ScanInvoice jobId={jobId} />;
}

function ScanInvoice({ jobId }: { jobId?: string }) {
  const s = useStore();
  const nav = useNav();
  const jobs = useJobChoices();
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [forJob, setForJob] = useState<string>(jobId ?? jobs.options[0] ?? VAN);

  const send = () => {
    if (!photo) return;
    const photoId = s.newId();
    const id = s.newId();
    const at = nowIso();
    const job = forJob === VAN ? undefined : forJob;
    s.queue('Supplier invoice photo', { method: 'POST', path: '/photos', upload: { fields: { kind: 'supplier_slip', takenAt: at, id: photoId }, fileUri: photo.uri, mime: photo.mime } }, job);
    s.queue('Supplier invoice sent for reading', { method: 'POST', path: '/supplier-invoices', json: { id, photoId, jobId: job, at } }, job);
    const row: SupplierInvoice = {
      id, status: 'reading', job_id: job ?? null, supplier_name: null, invoice_number: null, invoice_date: null, total_cents: null,
      scanned_at: at, confirmed_at: null, read_result: null, read_error: null, localPhotoUri: photo.uri,
    };
    s.patchCache(c => ({ ...c, invoices: [row, ...(c.invoices ?? [])] }));
    nav.back();
  };

  return (
    <Screen title="Scan supplier invoice" onBack={nav.back} right={<SyncPill />}>
      <Body quiet>Photograph the whole invoice, flat and in good light. The lines are read for you; you only check them.</Body>
      {photo ? <Image source={{ uri: photo.uri }} style={{ width: '100%', aspectRatio: 3 / 4, borderRadius: 10, backgroundColor: C.panel2 }} resizeMode="contain" /> : null}
      <Button label={photo ? 'Retake photo' : 'Take photo of the invoice'} kind={photo ? 'quiet' : 'primary'} onPress={async () => { const p = await takePhoto('document'); if (p) setPhoto(p); }} />
      <Label>Bought for</Label>
      <Choice options={jobs.options} value={forJob} onChange={setForJob} labels={jobs.labels} />
      <Text style={st.small}>Stock for a job stays on your name until it is used on that job card or returned to the stockroom.</Text>
      <Button label="Send for reading" onPress={send} disabled={!photo} />
    </Screen>
  );
}

interface EditLine { description: string; supplierCode: string; qty: string; price: string }
const toEdit = (l: ReadLine): EditLine => ({
  description: l.description, supplierCode: l.supplierCode ?? '', qty: String(l.qty),
  price: l.unitPriceCents == null ? '' : (l.unitPriceCents / 100).toFixed(2),
});
const num = (t: string) => Number(t.replace(/\s/g, '').replace(',', '.'));

function ConfirmInvoice({ inv }: { inv: SupplierInvoice }) {
  const s = useStore();
  const nav = useNav();
  const jobs = useJobChoices();
  const r = inv.read_result;
  const [supplier, setSupplier] = useState(r?.supplierName ?? inv.supplier_name ?? '');
  const [number, setNumber] = useState(r?.invoiceNumber ?? inv.invoice_number ?? '');
  const [total, setTotal] = useState(r?.totalCents != null ? (r.totalCents / 100).toFixed(2) : '');
  const [lines, setLines] = useState<EditLine[]>(r?.lines.length ? r.lines.map(toEdit) : [{ description: '', supplierCode: '', qty: '1', price: '' }]);
  const [forJob, setForJob] = useState<string>(inv.job_id ?? VAN);
  const [reasons, setReasons] = useState<string[] | null>(null);
  const setLine = (i: number, p: Partial<EditLine>) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const out = lines.map(l => ({
    description: l.description.trim(), supplierCode: l.supplierCode.trim() || null, qty: num(l.qty),
    unitPriceCents: l.price.trim() === '' ? null : Math.round(num(l.price) * 100),
  }));
  const linesTotal = S.linesTotalCents(out);
  const vat = r?.vatCents ?? null;
  const totalCents = total.trim() === '' ? null : Math.round(num(total) * 100);
  const mismatch = linesTotal != null && totalCents != null && vat != null && Math.abs(linesTotal + vat - totalCents) > 100;
  const photoUri = inv.localPhotoUri ?? (s.session?.mode === 'server' && inv.photo_id ? `${s.session.baseUrl}/photos/${inv.photo_id}` : undefined);

  const confirm = () => {
    const body = { supplierName: supplier.trim(), invoiceNumber: number.trim(), totalCents, lines: out };
    const problems = S.invoiceProblems(body);
    if (problems.length) { setReasons(problems); return; }
    const job = forJob === VAN ? null : forJob;
    s.queue(`Invoice ${body.invoiceNumber} from ${body.supplierName} confirmed`,
      { method: 'POST', path: `/supplier-invoices/${inv.id}/confirm`, json: { ...body, jobId: job, at: nowIso() } }, job ?? undefined);
    s.patchCache(c => ({ ...c, invoices: (c.invoices ?? []).map(i => (i.id === inv.id ? { ...i, status: 'confirmed', supplier_name: body.supplierName, invoice_number: body.invoiceNumber } : i)) }));
    nav.back();
  };

  return (
    <Screen title="Check the invoice" sub="Fix anything that was read wrong" onBack={nav.back} right={<SyncPill />}>
      {inv.status === 'unreadable' ? <Notice tone="warn" title="The photo could not be read" lines={['Type the lines from the invoice.']} /> : null}
      {reasons ? <Notice tone="bad" title="Still needed:" lines={reasons} /> : null}
      {photoUri ? <Image source={{ uri: photoUri, headers: s.session?.token ? { authorization: `Bearer ${s.session.token}` } : undefined }}
        style={{ width: '100%', aspectRatio: 3 / 4, borderRadius: 10, backgroundColor: C.panel2 }} resizeMode="contain" /> : null}
      <Field label="Supplier" value={supplier} onChangeText={setSupplier} />
      <Field label="Invoice number" value={number} onChangeText={setNumber} autoCapitalize="characters" />

      <Heading>Lines</Heading>
      {lines.map((l, i) => (
        <Card key={i}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Label>Line {i + 1}</Label>
            <View style={{ flex: 1 }} />
            <Pressable onPress={() => setLines(ls => ls.filter((_, j) => j !== i))} accessibilityRole="button" accessibilityLabel={`Remove line ${i + 1}`} hitSlop={8}>
              <Text style={{ color: C.bad, fontWeight: '700' }}>Remove</Text>
            </Pressable>
          </View>
          <Field label="Description" value={l.description} onChangeText={t => setLine(i, { description: t })} />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label="Qty" value={l.qty} onChangeText={t => setLine(i, { qty: t })} keyboardType="decimal-pad" /></View>
            <View style={{ flex: 1.4 }}><Field label="Unit price excl. VAT (R)" value={l.price} onChangeText={t => setLine(i, { price: t })} keyboardType="decimal-pad" /></View>
          </View>
          {l.supplierCode ? <Text style={st.small}>Supplier code {l.supplierCode}</Text> : null}
        </Card>
      ))}
      <Button label="+ Add a line" kind="secondary" onPress={() => setLines(ls => [...ls, { description: '', supplierCode: '', qty: '1', price: '' }])} />

      <Field label="Invoice total incl. VAT (R)" value={total} onChangeText={setTotal} keyboardType="decimal-pad" />
      <Text style={st.small}>Lines {rand(linesTotal)}{vat != null ? ` + VAT ${rand(vat)}` : ''}</Text>
      {mismatch ? <Notice tone="warn" title="The lines don't add up to the total" lines={['Check for a missed line or a wrong quantity.']} /> : null}

      <Label>Bought for</Label>
      <Choice options={jobs.options} value={forJob} onChange={setForJob} labels={jobs.labels} />
      <Text style={st.small}>Everything confirmed here goes on your name. Anything you change from what was read is recorded.</Text>
      <Button label="Confirm – put it on my name" onPress={confirm} />
    </Screen>
  );
}
