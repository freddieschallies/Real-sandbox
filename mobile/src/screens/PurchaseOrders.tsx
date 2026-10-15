// The technician's purchase orders for stock runs. A PO for a job lives on that job card; the others
// (sundries and van stock) on his main page. Ask for one by taking a photo of what is needed (a quote,
// a list, the part's label): the app reads it into the request, which he checks. Once approved, show
// the PO number at the counter and scan the supplier's slip against it.
import React, { useEffect, useState } from 'react';
import { Image, Pressable, Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso, takePhoto } from '../device.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, Screen, st } from '../ui.tsx';
import { PO_STATUS } from '../office/PurchaseOrders.tsx';
import { C } from '../theme.ts';

const VAN = 'van';
interface Line { stockItemId: string | null; description: string; qty: string }

export function PurchaseOrdersScreen({ jobId, ask }: { jobId?: string; ask?: boolean }) {
  const s = useStore();
  const nav = useNav();
  const [all, setList] = useState<any[] | null>(null);
  const [asking, setAsking] = useState(!!ask);
  const job = jobId ? (s.cache.today?.jobs ?? []).find(j => j.id === jobId) : null;
  // A job's POs on its job card; the main page has the sundries (no job).
  const list = all ? all.filter(p => (jobId ? p.job_id === jobId : !p.job_id)) : null;
  const [err, setErr] = useState<string[] | null>(null);
  const load = () => s.ask({ method: 'GET', path: '/me/purchase-orders' }).then(r => { if (r?.status === 200) setList(r.body as any[]); else setErr(['No signal: purchase orders need signal.']); });
  useEffect(() => { load(); }, []);
  if (asking) return <AskPO jobId={jobId} jobLabel={job ? `#${job.job_number} ${job.store}` : jobId ? 'this job' : null} done={id => { setAsking(false); load(); if (id) setErr(null); if (ask && !id) nav.back(); }} />;
  return (
    <Screen title={jobId ? 'Purchase orders for this job' : 'Purchase orders: sundries'} sub={jobId ? (job ? `#${job.job_number} ${job.store}` : undefined) : 'Sundries and van stock (POs for a job are on its job card)'} onBack={nav.back}>
      <Button label={jobId ? 'Ask for a PO for this job' : 'Ask for a PO for sundries'} onPress={() => setAsking(true)} />
      <Text style={st.small}>Take a photo of the list or quote and the app fills it in. The stock controller, admin, your manager or the CEO approves it. Then show the PO number at the supplier and scan their slip against it.</Text>
      {err ? <Notice tone="warn" title={err[0]} /> : null}
      {(list ?? []).map(p => {
        const stt = PO_STATUS[p.status] ?? { t: p.status, tone: 'quiet' as const };
        const ok = p.status === 'approved';
        return (
          <Card key={p.id} style={ok ? { borderColor: C.good, borderWidth: 2 } : undefined} accessibilityLabel={`My PO ${p.po_number}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ color: C.text, fontSize: ok ? 30 : 18, fontWeight: '800', flex: 1 }}>PO {p.external_number ?? p.po_number}</Text>
              <Pill text={stt.t} tone={stt.tone} />
            </View>
            <Text style={[st.body, { fontWeight: '700' }]}>{p.supplier_name}</Text>
            <Text style={st.small}>{p.job_number ? `Job ${p.job_number}${p.store ? `, ${p.store}` : ''}` : 'Sundries / van stock'}</Text>
            {(p.lines ?? []).map((l: any) => <Text key={l.lineNo} style={st.body}>{l.qty} × {l.description}</Text>)}
            {p.status === 'rejected' ? <Text style={[st.small, { color: C.bad }]}>Not approved{p.decided_by ? ` by ${p.decided_by}` : ''}: {p.decision_note}</Text> : null}
            {ok ? (
              <>
                <Text style={st.small}>{p.source === 'group' ? `Issued by the office${p.posted_by ? ` (${p.posted_by})` : ''}` : `Approved by ${p.decided_by}`}. Show this at {p.supplier_name}.</Text>
                <Button label="Scan the supplier's slip for this PO" onPress={() => nav.push({ name: 'invoice', jobId: p.job_id ?? undefined })} />
                <Button label="Cancel this PO" kind="quiet" onPress={async () => { await s.ask({ method: 'POST', path: `/me/purchase-orders/${p.id}/cancel`, json: {} }); load(); }} />
              </>
            ) : null}
            {p.status === 'requested' ? <Button label="Cancel" kind="quiet" onPress={async () => { await s.ask({ method: 'POST', path: `/me/purchase-orders/${p.id}/cancel`, json: {} }); load(); }} /> : null}
            {p.invoice ? <Text style={[st.small, { color: C.good }]}>Slip {p.invoice.invoiceNumber} booked: the parts are on {p.job_number ? `job ${p.job_number}` : 'your van'}. Use them on the job card, or send what is left back to the stockroom.</Text> : null}
          </Card>
        );
      })}
      {list && !list.length ? <Body quiet>{jobId ? 'No purchase orders for this job yet.' : 'No purchase orders for sundries yet.'}</Body> : null}
    </Screen>
  );
}

/** On a job card: its purchase orders (count and the latest), and asking for one for this job. */
export function JobPOs({ jobId, closed }: { jobId: string; closed: boolean }) {
  const s = useStore();
  const nav = useNav();
  const [list, setList] = useState<any[] | null>(null);
  useEffect(() => { s.ask({ method: 'GET', path: '/me/purchase-orders' }).then(r => { if (r?.status === 200) setList((r.body as any[]).filter(p => p.job_id === jobId)); }).catch(() => undefined); }, [jobId]);
  const open = (list ?? []).filter(p => ['requested', 'approved'].includes(p.status));
  return (
    <>
      <Heading>Purchase orders for this job</Heading>
      {(list ?? []).slice(0, 3).map(p => {
        const stt = PO_STATUS[p.status] ?? { t: p.status, tone: 'quiet' as const };
        return (
          <Card key={p.id} onPress={() => nav.push({ name: 'pos', jobId })} accessibilityLabel={`Job PO ${p.po_number}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>PO {p.external_number ?? p.po_number} · {p.supplier_name}</Text>
              <Pill text={stt.t} tone={stt.tone} />
            </View>
            <Text style={st.small}>{(p.lines ?? []).map((l: any) => `${l.qty} × ${l.description}`).join(', ')}</Text>
          </Card>
        );
      })}
      {list && !list.length ? <Body quiet>None yet. Need parts from a supplier for this job? Ask for a PO here.</Body> : null}
      {!closed ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button label="Ask for a PO" kind="secondary" onPress={() => nav.push({ name: 'pos', jobId, ask: true })} style={{ flex: 1 }} />
          {(list ?? []).length ? <Button label={`All (${list!.length})${open.length ? ` · ${open.length} open` : ''}`} kind="quiet" onPress={() => nav.push({ name: 'pos', jobId })} style={{ flex: 1 }} /> : null}
        </View>
      ) : null}
    </>
  );
}

function AskPO({ jobId, jobLabel, done }: { jobId?: string; jobLabel: string | null; done: (id?: string) => void }) {
  const s = useStore();
  const catalogue = s.cache.catalogue ?? [];
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [supplier, setSupplier] = useState('');
  const forJob = jobId ?? VAN;
  const [lines, setLines] = useState<Line[]>([{ stockItemId: null, description: '', qty: '1' }]);
  const [photo, setPhoto] = useState<{ id: string; uri: string } | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [find, setFind] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  useEffect(() => { s.ask({ method: 'GET', path: '/suppliers' }).then(r => { if (r?.status === 200) setSuppliers(r.body as { id: string; name: string }[]); }); }, []);
  const known = suppliers.find(x => x.name.toLowerCase() === supplier.trim().toLowerCase());
  const matches = supplier.trim() && !known ? suppliers.filter(x => x.name.toLowerCase().includes(supplier.trim().toLowerCase())).slice(0, 5) : [];
  const set = (i: number, p: Partial<Line>) => setLines(ls => ls.map((l, n) => (n === i ? { ...l, ...p } : l)));
  const send = async () => {
    const bad = [supplier.trim().length < 2 ? 'the supplier' : '', ...lines.map((l, i) => (l.description.trim().length < 2 ? `line ${i + 1}: what it is` : !(Number(l.qty.replace(',', '.')) > 0) ? `line ${i + 1}: how many` : ''))].filter(Boolean);
    if (bad.length) { setErr(bad); return; }
    setBusy(true);
    const r = await s.ask({ method: 'POST', path: '/purchase-orders', json: {
      ...(known ? { supplierId: known.id } : { supplierName: supplier.trim() }), jobId: forJob === VAN ? null : forJob, note: note.trim() || undefined, photoId: photo?.id ?? undefined,
      lines: lines.map(l => ({ stockItemId: l.stockItemId, description: l.description.trim(), qty: Number(l.qty.replace(',', '.')) })),
    } });
    setBusy(false);
    if (r?.status === 201) done((r.body as { id: string }).id);
    else setErr((r?.body as { reasons?: string[] })?.reasons ?? ['No signal: a purchase order needs signal.']);
  };
  // A photo of what is needed: the app reads it and fills in the supplier and the parts (he checks them).
  const fromPhoto = async () => {
    setErr(null);
    const p = await takePhoto();
    if (!p) return;
    const id = s.newId();
    setPhoto({ id, uri: p.uri }); setReading('Sending the photo…');
    const up = await s.ask({ method: 'POST', path: '/photos', upload: { fields: { kind: 'po_request', takenAt: nowIso(), id }, fileUri: p.uri, mime: p.mime } });
    if (!up || up.status >= 300) { setReading(null); setPhoto(null); setErr(['No signal: the photo needs signal. Type the parts instead, or try again.']); return; }
    setReading('Reading the photo…');
    const r = await s.ask({ method: 'POST', path: '/purchase-orders/read', json: { photoId: id, note: note.trim() || undefined } });
    setReading(null);
    const b = r?.status === 200 ? r.body as { supplierName: string | null; lines: { description: string; qty: number; stockItemId: string | null }[] } : null;
    if (!b || !b.lines.length) { setErr(['The app could not read the parts from the photo: type them below (the photo still goes with the request).']); return; }
    if (b.supplierName && !supplier.trim()) setSupplier(b.supplierName);
    setLines(b.lines.map(l => ({ stockItemId: l.stockItemId, description: l.description, qty: String(l.qty) })));
  };
  return (
    <Screen title={jobLabel ? 'A PO for this job' : 'A PO for sundries'} sub={jobLabel ?? 'Sundries and van stock'} onBack={() => done()}>
      <Button label={photo ? 'Take the photo again' : '📷 Take a photo of the list or quote'} kind={photo ? 'secondary' : 'primary'} busy={!!reading} onPress={fromPhoto} />
      {reading ? <Text style={st.small}>{reading}</Text> : null}
      {photo ? <Image source={{ uri: photo.uri }} style={{ width: '100%', height: 180, borderRadius: 8, backgroundColor: '#000' }} resizeMode="contain" accessibilityLabel="The photo of what is needed" /> : null}
      {photo && !reading ? <Text style={st.small}>Check what the app read below, and fix anything that is wrong.</Text> : <Text style={st.small}>Or type it in:</Text>}
      <Field label="Supplier" value={supplier} onChangeText={setSupplier} placeholder="e.g. Voltex Richards Bay" />
      {matches.map(x => (
        <Pressable key={x.id} onPress={() => setSupplier(x.name)} accessibilityRole="button" accessibilityLabel={`Supplier ${x.name}`} style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: C.line }}>
          <Text style={st.body}>{x.name}</Text>
        </Pressable>
      ))}
      {supplier.trim().length >= 2 && !known && !matches.length ? <Text style={st.small}>A new supplier: the office is told.</Text> : null}
      <Text style={st.small}>For: {jobLabel ?? 'sundries / van stock (a PO for a job is asked for on its job card)'}</Text>
      <Heading>Parts</Heading>
      {lines.map((l, i) => {
        const hits = find === i && l.description.trim().length >= 2 ? catalogue.filter(c => `${c.code} ${c.description}`.toLowerCase().includes(l.description.trim().toLowerCase())).slice(0, 5) : [];
        return (
          <Card key={i}>
            <TextInput value={l.description} onChangeText={t => { set(i, { description: t, stockItemId: null }); setFind(i); }} placeholder="What it is (type to find the stock item)" placeholderTextColor={C.quiet}
              style={st.input} accessibilityLabel={`Part ${i + 1}`} />
            {hits.map(h => (
              <Pressable key={h.id} onPress={() => { set(i, { description: h.description, stockItemId: h.id }); setFind(null); }} accessibilityRole="button" accessibilityLabel={`Item ${h.code}`}
                style={{ padding: 8, borderRadius: 6, borderWidth: 1, borderColor: C.line }}>
                <Text style={st.small}>{h.code} · {h.description}</Text>
              </Pressable>
            ))}
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Text style={st.body}>How many</Text>
              <TextInput value={l.qty} onChangeText={t => set(i, { qty: t })} keyboardType="decimal-pad" style={[st.input, { width: 90 }]} accessibilityLabel={`Part ${i + 1} quantity`} />
              <View style={{ flex: 1 }} />
              {lines.length > 1 ? <Button label="Remove" kind="quiet" onPress={() => setLines(ls => ls.filter((_, n) => n !== i))} /> : null}
            </View>
            {l.stockItemId ? <Text style={[st.small, { color: C.good }]}>Stock item</Text> : null}
          </Card>
        );
      })}
      <Button label="+ Another part" kind="secondary" onPress={() => setLines(ls => [...ls, { stockItemId: null, description: '', qty: '1' }])} />
      <Field label="Note (optional)" value={note} onChangeText={setNote} placeholder="e.g. Needed today for the bakery fridge" />
      {err ? <Notice tone="bad" title="Still needed:" lines={err} /> : null}
      <Button label="Send for approval" onPress={send} busy={busy} />
    </Screen>
  );
}
