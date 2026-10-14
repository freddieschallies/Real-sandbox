// The technician's purchase orders for stock runs: ask for one (the supplier, the parts, the job or
// the van), and once approved show the PO number at the counter and scan the supplier's slip against
// it. The parts then go on the job, where they are used or sent back to the stockroom.
import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, Screen, st } from '../ui.tsx';
import { PO_STATUS } from '../office/PurchaseOrders.tsx';
import { C } from '../theme.ts';

const VAN = 'van';
interface Line { stockItemId: string | null; description: string; qty: string }

export function PurchaseOrdersScreen() {
  const s = useStore();
  const nav = useNav();
  const [list, setList] = useState<any[] | null>(null);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  const load = () => s.ask({ method: 'GET', path: '/me/purchase-orders' }).then(r => { if (r?.status === 200) setList(r.body as any[]); else setErr(['No signal: purchase orders need signal.']); });
  useEffect(() => { load(); }, []);
  if (asking) return <AskPO done={id => { setAsking(false); load(); if (id) setErr(null); }} />;
  return (
    <Screen title="Purchase orders" sub="For stock runs" onBack={nav.back}>
      <Button label="Ask for a purchase order" onPress={() => setAsking(true)} />
      <Text style={st.small}>The stock controller, admin, your manager or the CEO approves it. Then show the PO number at the supplier and scan their slip against it.</Text>
      {err ? <Notice tone="warn" title={err[0]} /> : null}
      {(list ?? []).map(p => {
        const stt = PO_STATUS[p.status] ?? { t: p.status, tone: 'quiet' as const };
        const ok = p.status === 'approved';
        return (
          <Card key={p.id} style={ok ? { borderColor: C.good, borderWidth: 2 } : undefined} accessibilityLabel={`My PO ${p.po_number}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ color: C.text, fontSize: ok ? 30 : 18, fontWeight: '800', flex: 1 }}>PO {p.po_number}</Text>
              <Pill text={stt.t} tone={stt.tone} />
            </View>
            <Text style={[st.body, { fontWeight: '700' }]}>{p.supplier_name}</Text>
            <Text style={st.small}>{p.job_number ? `Job ${p.job_number}${p.store ? `, ${p.store}` : ''}` : 'Van stock'}</Text>
            {(p.lines ?? []).map((l: any) => <Text key={l.lineNo} style={st.body}>{l.qty} × {l.description}</Text>)}
            {p.status === 'rejected' ? <Text style={[st.small, { color: C.bad }]}>Not approved{p.decided_by ? ` by ${p.decided_by}` : ''}: {p.decision_note}</Text> : null}
            {ok ? (
              <>
                <Text style={st.small}>Approved by {p.decided_by}. Show this at {p.supplier_name}.</Text>
                <Button label="Scan the supplier's slip for this PO" onPress={() => nav.push({ name: 'invoice', jobId: p.job_id ?? undefined })} />
                <Button label="Cancel this PO" kind="quiet" onPress={async () => { await s.ask({ method: 'POST', path: `/me/purchase-orders/${p.id}/cancel`, json: {} }); load(); }} />
              </>
            ) : null}
            {p.status === 'requested' ? <Button label="Cancel" kind="quiet" onPress={async () => { await s.ask({ method: 'POST', path: `/me/purchase-orders/${p.id}/cancel`, json: {} }); load(); }} /> : null}
            {p.invoice ? <Text style={[st.small, { color: C.good }]}>Slip {p.invoice.invoiceNumber} booked: the parts are on {p.job_number ? `job ${p.job_number}` : 'your van'}. Use them on the job card, or send what is left back to the stockroom.</Text> : null}
          </Card>
        );
      })}
      {list && !list.length ? <Body quiet>No purchase orders yet.</Body> : null}
    </Screen>
  );
}

function AskPO({ done }: { done: (id?: string) => void }) {
  const s = useStore();
  const jobsToday = (s.cache.today?.jobs ?? []).filter(j => j.status !== 'closed');
  const catalogue = s.cache.catalogue ?? [];
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [supplier, setSupplier] = useState('');
  const [forJob, setForJob] = useState<string>(jobsToday[0]?.id ?? VAN);
  const [lines, setLines] = useState<Line[]>([{ stockItemId: null, description: '', qty: '1' }]);
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
      ...(known ? { supplierId: known.id } : { supplierName: supplier.trim() }), jobId: forJob === VAN ? null : forJob, note: note.trim() || undefined,
      lines: lines.map(l => ({ stockItemId: l.stockItemId, description: l.description.trim(), qty: Number(l.qty.replace(',', '.')) })),
    } });
    setBusy(false);
    if (r?.status === 201) done((r.body as { id: string }).id);
    else setErr((r?.body as { reasons?: string[] })?.reasons ?? ['No signal: a purchase order needs signal.']);
  };
  return (
    <Screen title="Ask for a purchase order" onBack={() => done()}>
      <Field label="Supplier" value={supplier} onChangeText={setSupplier} placeholder="e.g. Voltex Richards Bay" />
      {matches.map(x => (
        <Pressable key={x.id} onPress={() => setSupplier(x.name)} accessibilityRole="button" accessibilityLabel={`Supplier ${x.name}`} style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: C.line }}>
          <Text style={st.body}>{x.name}</Text>
        </Pressable>
      ))}
      {supplier.trim().length >= 2 && !known && !matches.length ? <Text style={st.small}>A new supplier: the office is told.</Text> : null}
      <Label>For</Label>
      <Choice options={[...jobsToday.map(j => j.id), VAN]} value={forJob} onChange={setForJob} labels={{ ...Object.fromEntries(jobsToday.map(j => [j.id, `#${j.job_number} ${j.store}`])), [VAN]: 'Van stock' }} />
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
