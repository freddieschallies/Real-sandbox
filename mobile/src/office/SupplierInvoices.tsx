// Accounts: supplier invoices. Everything to check in one list: the technicians' till slips, and
// invoices the office scans itself, with the phone's camera or as a file (a PDF or a picture that came
// by email). A scan is read automatically; Accounts checks it next to the picture and taps
// "Save and approve". Approved invoices go to Pastel from Accounts → Pastel batch → Supplier invoices.
import React, { useEffect, useState } from 'react';
import { Image, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import { rememberPhoto, usePhotoUri } from '../photo.ts';
import { pickImage, takePhoto } from '../device.ts';
import * as D from '../../../server/src/core/documents.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';

type Ans = { ok: true; body: any } | { ok: false; reasons: string[] };
type View_ = 'to_check' | 'scanned' | 'queried' | 'approved' | 'in_pastel' | 'all';
const VIEW_LABEL: Record<View_, string> = { to_check: 'To check', scanned: 'Scanned', queried: 'Queried', approved: 'Approved', in_pastel: 'In Pastel', all: 'All' };
const R = (c: number | null | undefined) => (c == null ? '–' : D.rand(c));
const day = (s: string | null | undefined) => (s ? new Date(`${s.slice(0, 10)}T12:00:00+02:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
/** "1 234,50" or "1234.5" → cents; empty → null. */
const cents = (t: string): number | null => { const v = t.replace(/[\sR]/g, '').replace(',', '.'); if (!v) return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const money = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));

function useAsk() {
  const s = useStore();
  return async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, json?: object): Promise<Ans> => {
    const r = await s.ask({ method, path, json });
    if (r && r.status < 300) return { ok: true, body: r.body };
    return { ok: false, reasons: (r?.body as { reasons?: string[]; error?: string })?.reasons ?? [(r?.body as { error?: string })?.error ?? 'no signal: try again'] };
  };
}
function Reasons({ a }: { a: Ans | null }) { return a && !a.ok ? <Notice tone="bad" title="Not yet. Still needed:" lines={a.reasons} /> : null; }

/** A picture or PDF file from the computer (or a picture on the phone). */
function chooseFile(): Promise<File | null> {
  return new Promise(resolve => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') { resolve(null); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,image/jpeg,image/png,image/webp,.pdf';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

function where(x: any): { text: string; tone: 'info' | 'good' | 'warn' | 'bad' | 'quiet' } {
  if (x.pastel_batch_id) return { text: 'In Pastel', tone: 'good' };
  if (x.status === 'reading') return { text: 'Reading…', tone: 'info' };
  if (x.status === 'unreadable') return { text: 'Type it in', tone: 'warn' };
  if (x.status === 'to_confirm') return { text: 'Check and save', tone: 'warn' };
  if (x.check_status === 'approved') return { text: 'Approved', tone: 'good' };
  if (x.check_status === 'queried') return { text: 'Queried', tone: 'bad' };
  return { text: 'To check', tone: 'warn' };
}

export function SupplierInvoiceList({ open, selected, tick }: { open: (id: string) => void; selected: string | null; tick: number }) {
  const s = useStore();
  const ask = useAsk();
  const [view, setView] = useState<View_>('to_check');
  const [data, setData] = useState<{ counts: Record<string, number>; invoices: any[] } | null>(null);
  const [busy, setBusy] = useState<'photo' | 'file' | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const load = async () => { const r = await ask('GET', `/office/supplier-invoices?view=${view}`); if (r.ok) setData(r.body); };
  useEffect(() => { load(); }, [view, tick]);
  // A scan being read: look again in a moment.
  useEffect(() => {
    if (!data?.invoices.some(x => x.status === 'reading')) return;
    const t = setTimeout(load, 2500); return () => clearTimeout(t);
  }, [data]);
  const send = async (uri: string, mime: string, name: string, how: 'photo' | 'file') => {
    setBusy(how); setErr(null);
    const r = await s.ask({ method: 'POST', path: '/office/supplier-invoices/scan', upload: { fields: {}, fileUri: uri, mime, name } });
    setBusy(null);
    if (r?.status === 201) {
      const b = r.body as { id: string; photoId?: string };
      if (b.photoId) rememberPhoto(s, b.photoId, uri);
      setView('scanned'); open(b.id);
    } else setErr((r?.body as { reasons?: string[] })?.reasons ?? ['no signal: try again']);
  };
  const photo = async () => {
    const p = await takePhoto('document');
    if (p) await send(p.uri, p.mime, 'invoice.jpg', 'photo');
  };
  const file = async () => {
    if (Platform.OS === 'web') {
      const f = await chooseFile();
      if (f) await send(URL.createObjectURL(f), f.type || (f.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'), f.name, 'file');
      return;
    }
    const p = await pickImage('document');
    if (p) await send(p.uri, p.mime, 'invoice.jpg', 'file');
  };
  const c = data?.counts ?? {};
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Button label="Take a photo of an invoice" onPress={photo} busy={busy === 'photo'} style={{ flexGrow: 1, flexBasis: 200 }} />
        <Button label="Choose a file (PDF or picture)" kind="secondary" onPress={file} busy={busy === 'file'} style={{ flexGrow: 1, flexBasis: 200 }} />
      </View>
      <Text style={st.small}>It is read by itself in a few seconds. Check it next to the picture and tap "Save and approve". The technicians' till slips come in here by themselves.</Text>
      {err ? <Notice tone="bad" title="Not sent" lines={err} /> : null}
      <Choice options={['to_check', 'scanned', 'queried', 'approved', 'in_pastel', 'all'] as const} value={view} onChange={setView}
        labels={Object.fromEntries((Object.keys(VIEW_LABEL) as View_[]).map(k => [k, k === 'all' ? VIEW_LABEL[k] : `${VIEW_LABEL[k]}${c[k] ? ` (${c[k]})` : ''}`])) as Record<View_, string>} />
      {view === 'approved' && data?.invoices.length ? <Text style={st.small}>To Pastel: Accounts → Pastel batch → Supplier invoices.</Text> : null}
      {(data?.invoices ?? []).map(x => {
        const w = where(x);
        return (
          <Card key={x.id} onPress={() => open(x.id)} accessibilityLabel={`Supplier invoice ${x.invoice_number ?? 'being read'}`} style={selected === x.id ? { borderColor: C.accent, borderWidth: 2 } : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[st.body, { fontWeight: '800', flex: 1 }]} numberOfLines={1}>{x.supplier_name ?? 'Being read…'}{x.invoice_number ? ` · ${x.invoice_number}` : ''}</Text>
              <Pill text={w.text} tone={w.tone} />
            </View>
            <Text style={st.small}>
              {R(x.total_cents)} · {x.source === 'office' ? `scanned by ${x.added_by}` : `till slip, ${x.technician}${x.job_number ? `, job ${x.job_number}` : ''}`} · {day(x.invoice_date ?? x.scanned_at)}
              {x.delivery_ref ? ` · delivery ${x.delivery_ref}` : ''}
            </Text>
            {x.check_status === 'queried' && x.check_note ? <Text style={[st.small, { color: C.bad }]}>Query: {x.check_note}</Text> : null}
          </Card>
        );
      })}
      {data && !data.invoices.length ? <Body quiet>Nothing here.</Body> : null}
    </>
  );
}

/** The invoice's picture, or the PDF itself on a computer. */
function Picture({ id, mime }: { id: string | null; mime: string | null }) {
  const uri = usePhotoUri(id);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    // A PDF shows in a frame from a file link (a data: link may not be allowed).
    if (!uri || mime !== 'application/pdf' || Platform.OS !== 'web') { setOpen(null); return; }
    let url: string | null = null;
    fetch(uri).then(r => r.blob()).then(b => { url = URL.createObjectURL(new Blob([b], { type: 'application/pdf' })); setOpen(url); }).catch(() => setOpen(uri));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [uri, mime]);
  if (!id) return null;
  if (!uri) return <Body quiet>Loading the picture…</Body>;
  if (mime === 'application/pdf') {
    if (Platform.OS !== 'web') return <Body quiet>The PDF opens on a computer.</Body>;
    return (
      <View style={{ gap: 6 }}>
        {open ? React.createElement('iframe', { src: open, title: 'The supplier invoice', style: { width: '100%', height: 520, border: `1px solid ${C.line}`, borderRadius: 8, background: '#fff' } }) : null}
        <Button label="Open the PDF on its own" kind="quiet" onPress={() => { try { window.open(open ?? uri, '_blank'); } catch { /* the frame above shows it */ } }} />
      </View>
    );
  }
  return (
    <Pressable onPress={() => { if (Platform.OS === 'web') try { window.open(uri, '_blank'); } catch { /* shown here */ } }} accessibilityLabel="The supplier invoice picture">
      <Image source={{ uri }} style={{ width: '100%', aspectRatio: 0.72, borderRadius: 8, backgroundColor: '#fff' }} resizeMode="contain" />
    </Pressable>
  );
}

interface EditLine { description: string; qty: string; price: string; supplierCode: string | null }

export function SupplierInvoiceDetail({ id, changed }: { id: string; changed: () => void }) {
  const ask = useAsk();
  const [x, setX] = useState<any>(null);
  const [ans, setAns] = useState<Ans | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [f, setF] = useState<{ supplier: string; number: string; date: string; total: string; vat: string; deliveryId: string | null; lines: EditLine[] } | null>(null);
  const [note, setNote] = useState('');
  const [querying, setQuerying] = useState(false);
  const [code, setCode] = useState('');
  const load = async () => {
    const r = await ask('GET', `/office/supplier-invoices/${id}`);
    if (!r.ok) { setAns(r); return; }
    const v = r.body;
    setX(v);
    setCode(v.supplier_code ?? '');
    // The form: what was saved, or what was read.
    const rd = v.read;
    const lines: EditLine[] = (v.lines?.length ? v.lines.map((l: any) => ({ description: l.description, qty: String(l.qty), price: money(l.unit_price_cents), supplierCode: l.supplier_code }))
      : (rd?.lines ?? []).map((l: any) => ({ description: l.description, qty: String(l.qty), price: money(l.unitPriceCents), supplierCode: l.supplierCode ?? null })));
    setF({ supplier: v.supplier_name ?? rd?.supplierName ?? '', number: v.invoice_number ?? rd?.invoiceNumber ?? '', date: v.invoice_date ?? rd?.invoiceDate ?? '',
      total: money(v.total_cents ?? rd?.totalCents), vat: money(v.vat_cents ?? rd?.vatCents), deliveryId: v.delivery_id ?? (v.deliveries?.length === 1 && v.status !== 'confirmed' ? v.deliveries[0].id : null),
      lines: lines.length ? lines : [{ description: '', qty: '1', price: '', supplierCode: null }] });
  };
  useEffect(() => { load(); }, [id]);
  useEffect(() => {
    if (x?.status !== 'reading') return;
    const t = setTimeout(load, 2500); return () => clearTimeout(t);
  }, [x]);
  if (!x || !f) return ans ? <Reasons a={ans} /> : <Body quiet>Loading…</Body>;
  const w = where(x);
  const office = x.source === 'office';
  const editable = office && !x.pastel_batch_id && x.check_status !== 'approved' && x.status !== 'reading';
  const up = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const upLine = (i: number, p: Partial<EditLine>) => up({ lines: f.lines.map((l, n) => (n === i ? { ...l, ...p } : l)) });
  const totalC = cents(f.total), vatC = cents(f.vat);
  const linesC = f.lines.map(l => ({ qty: Number(l.qty.replace(',', '.')), unit: cents(l.price) }));
  const linesSum = linesC.every(l => l.unit != null && Number.isFinite(l.unit) && l.qty > 0) ? linesC.reduce((n, l) => n + Math.round(l.qty * (l.unit ?? 0)), 0) : null;
  const exVat = totalC != null && vatC != null ? totalC - vatC : null;
  const save = async (approve: boolean) => {
    setMsg(null);
    const bad = [!f.supplier.trim() ? 'the supplier' : '', !f.number.trim() ? 'the invoice number' : '', !(totalC && totalC > 0) ? 'the total (incl. VAT)' : '',
      vatC != null && Number.isNaN(vatC) ? 'the VAT as an amount' : '', ...f.lines.map((l, i) => (!l.description.trim() ? `line ${i + 1}: what it is` : !(Number(l.qty.replace(',', '.')) > 0) ? `line ${i + 1}: how many` : '')),
      f.date && !/^\d{4}-\d{2}-\d{2}$/.test(f.date) ? 'the date as YYYY-MM-DD' : ''].filter(Boolean);
    if (bad.length) { setAns({ ok: false, reasons: bad }); return; }
    const r = await ask('PUT', `/office/supplier-invoices/${id}`, {
      supplierName: f.supplier.trim(), invoiceNumber: f.number.trim(), invoiceDate: f.date || null, totalCents: totalC, vatCents: vatC, deliveryId: f.deliveryId,
      lines: f.lines.map(l => ({ description: l.description.trim(), qty: Number(l.qty.replace(',', '.')), unitPriceCents: cents(l.price), supplierCode: l.supplierCode })), approve,
    });
    setAns(r);
    if (r.ok) { setMsg(approve ? 'Saved and approved: it goes to Pastel with the next supplier invoice batch.' : 'Saved: it waits under To check.'); if (r.body.warning) setMsg(m => `${m} Note: ${r.body.warning}.`); changed(); load(); }
  };
  const check = async (action: 'approve' | 'query' | 'reopen') => {
    setMsg(null);
    const r = await ask('POST', `/office/supplier-invoices/${id}/check`, action === 'query' ? { action, note: note.trim() } : { action });
    setAns(r);
    if (r.ok) { setQuerying(false); setNote(''); setMsg(action === 'approve' ? 'Approved: it goes to Pastel with the next supplier invoice batch.' : action === 'query' ? 'Queried: whoever booked it is told.' : 'The approval is off: it waits under To check.'); changed(); load(); }
  };
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontSize: 24, fontWeight: '800', flexShrink: 1 }}>{x.supplier_name ?? 'Supplier invoice'}{x.invoice_number ? ` · ${x.invoice_number}` : ''}</Text>
        <Pill text={w.text} tone={w.tone} />
      </View>
      <Text style={st.small}>{office ? `Scanned by ${x.added_by}` : `Till slip from ${x.technician}${x.job_number ? `, bought for job ${x.job_number}` : ', van stock'}`}{x.checked_by ? ` · ${x.check_status === 'approved' ? 'approved' : 'checked'} by ${x.checked_by}` : ''}</Text>
      {x.status === 'reading' ? <Notice tone="info" title="Reading the invoice…" lines={['It takes a few seconds. You can scan the next one meanwhile.']} /> : null}
      {x.status === 'unreadable' ? <Notice tone="warn" title="It could not be read by itself" lines={[x.read_error ?? 'Type it in from the picture.']} /> : null}
      {x.check_status === 'queried' && x.check_note ? <Notice tone="bad" title="Queried" lines={[x.check_note]} /> : null}
      {x.changed_from_read ? <Text style={[st.small, { color: C.warn }]}>Changed from what was read (kept on record).</Text> : null}
      {msg ? <Notice tone="good" title={msg} /> : null}
      <Picture id={x.photo_id} mime={x.content_type} />

      {editable ? (
        <Card>
          <Field label="Supplier" value={f.supplier} onChangeText={t => up({ supplier: t })} />
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <View style={{ flexGrow: 1, flexBasis: 160 }}><Field label="Invoice number" value={f.number} onChangeText={t => up({ number: t })} autoCapitalize="characters" /></View>
            <View style={{ flexGrow: 1, flexBasis: 160 }}><Field label="Date (YYYY-MM-DD)" value={f.date} onChangeText={t => up({ date: t })} /></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <View style={{ flexGrow: 1, flexBasis: 160 }}><Field label="Total incl. VAT (R)" value={f.total} onChangeText={t => up({ total: t })} keyboardType="decimal-pad" /></View>
            <View style={{ flexGrow: 1, flexBasis: 160 }}><Field label="VAT (R; 0 if none)" value={f.vat} onChangeText={t => up({ vat: t })} keyboardType="decimal-pad" /></View>
          </View>
          <Label>Lines (prices excl. VAT)</Label>
          {f.lines.map((l, i) => (
            <View key={i} style={{ gap: 6, borderTopWidth: i ? 1 : 0, borderTopColor: C.line, paddingTop: i ? 8 : 0 }}>
              <TextInput value={l.description} onChangeText={t => upLine(i, { description: t })} placeholder="What it is" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel={`Line ${i + 1} description`} />
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <TextInput value={l.qty} onChangeText={t => upLine(i, { qty: t })} keyboardType="decimal-pad" placeholder="Qty" placeholderTextColor={C.quiet} style={[st.input, { width: 80 }]} accessibilityLabel={`Line ${i + 1} quantity`} />
                <Text style={st.small}>×</Text>
                <TextInput value={l.price} onChangeText={t => upLine(i, { price: t })} keyboardType="decimal-pad" placeholder="Price R" placeholderTextColor={C.quiet} style={[st.input, { flex: 1 }]} accessibilityLabel={`Line ${i + 1} price`} />
                <Button label="✕" kind="quiet" onPress={() => up({ lines: f.lines.filter((_, n) => n !== i) })} style={{ minHeight: 40, paddingHorizontal: 10 }} />
              </View>
            </View>
          ))}
          <Button label="+ Line" kind="quiet" onPress={() => up({ lines: [...f.lines, { description: '', qty: '1', price: '', supplierCode: null }] })} />
          {linesSum !== null && exVat !== null ? (
            <Text style={[st.small, Math.abs(linesSum - exVat) > 100 ? { color: C.warn } : null]}>
              Lines add up to {R(linesSum)}; the invoice excl. VAT is {R(exVat)}.{Math.abs(linesSum - exVat) > 100 ? ' They differ: Pastel then gets one line for the whole invoice.' : ' ✓'}
            </Text>
          ) : null}
          {x.deliveries?.length ? (
            <>
              <Label>Did the goods come in?</Label>
              {x.deliveries.map((d: any) => (
                <Pressable key={d.id} onPress={() => up({ deliveryId: f.deliveryId === d.id ? null : d.id })} accessibilityRole="checkbox" accessibilityState={{ checked: f.deliveryId === d.id }}
                  style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', padding: 10, borderWidth: 1, borderColor: f.deliveryId === d.id ? C.good : C.line, borderRadius: 8 }}>
                  <Text style={{ color: f.deliveryId === d.id ? C.good : C.quiet, fontSize: 18 }}>{f.deliveryId === d.id ? '☑' : '☐'}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={st.body}>Delivery {d.reference}, {day(d.date)}, received by {d.received_by}</Text>
                    <Text style={st.small}>{(d.lines ?? []).map((l: any) => `${l.qty} × ${l.description}`).join(', ')}</Text>
                  </View>
                </Pressable>
              ))}
            </>
          ) : null}
          <Reasons a={ans} />
          <Button label="Save and approve" onPress={() => save(true)} />
          <Button label="Save, check later" kind="secondary" onPress={() => save(false)} />
          {x.status !== 'confirmed' ? <Button label="Take it off (wrong file)" kind="quiet" onPress={async () => { const r = await ask('DELETE', `/office/supplier-invoices/${id}`); setAns(r); if (r.ok) changed(); }} /> : null}
        </Card>
      ) : x.status === 'confirmed' ? (
        <Card>
          <Text style={st.body}>Invoice date {day(x.invoice_date)} · total {R(x.total_cents)}{x.vat_cents != null ? ` (VAT ${R(x.vat_cents)})` : ''}</Text>
          {(x.lines ?? []).map((l: any) => <Text key={l.line_no} style={st.small}>{l.qty} × {l.description}{l.unit_price_cents != null ? ` @ ${R(l.unit_price_cents)}` : ''}{l.stock_code ? ` · ${l.stock_code}` : ''}</Text>)}
          {x.delivery_ref ? <Text style={[st.small, { color: C.good }]}>Goods came in on delivery {x.delivery_ref} ({day(x.delivery_date)}).</Text> : null}
        </Card>
      ) : null}

      {x.status === 'confirmed' && !x.pastel_batch_id ? (
        <>
          <Reasons a={editable ? null : ans} />
          {x.check_status !== 'approved' && !editable ? <Button label="Approve" onPress={() => check('approve')} /> : null}
          {x.check_status !== 'queried' ? (
            querying ? (
              <Card>
                <Field label={`What is wrong? (${office ? x.added_by : x.technician} is told)`} value={note} onChangeText={setNote} placeholder="e.g. The price of the valve is not what we agreed" />
                <Button label="Send the query" kind="danger" disabled={note.trim().length < 5} onPress={() => check('query')} />
                <Button label="Cancel" kind="quiet" onPress={() => setQuerying(false)} />
              </Card>
            ) : <Button label="Query it" kind="secondary" onPress={() => setQuerying(true)} />
          ) : null}
          {x.check_status !== 'to_check' ? <Button label={x.check_status === 'approved' ? 'Take the approval off' : 'Back to To check'} kind="quiet" onPress={() => check('reopen')} /> : null}
        </>
      ) : null}

      {x.supplier_id && x.status === 'confirmed' ? (
        <Card>
          <Label>Pastel supplier code</Label>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <TextInput value={code} onChangeText={t => setCode(t.toUpperCase())} maxLength={6} autoCapitalize="characters" placeholder="CODE" placeholderTextColor={C.quiet} style={[st.input, { width: 130 }]} accessibilityLabel="Pastel supplier code" />
            <Button label="Save" kind="quiet" onPress={async () => { const r = await ask('PUT', `/pastel/suppliers/${encodeURIComponent(x.supplier_id)}`, { code: code || null }); setAns(r); if (r.ok) { setMsg(`${x.supplier_name}: Pastel code ${r.body.code ?? 'taken off'}.`); load(); } }} />
          </View>
          <Text style={st.small}>The supplier's account code in Pastel (up to 6 characters). Kept for every invoice from {x.supplier_name}.</Text>
        </Card>
      ) : null}
    </>
  );
}
