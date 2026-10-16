// Purchase orders the technicians ask for on their stock runs: approve (or say no, with why). The
// stock controller, admin, the department manager (his own team) and the CEO approve; Accounts sees
// them. Once approved the PO number is on the technician's phone; he scans the slip against it.
import { ExportBar } from '../exportDoc.tsx';
import { techPoHtml } from '../jobs/poPage.ts';
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import * as D from '../../../server/src/core/documents.ts';
import { Body, Button, Card, Choice, Field, Notice, Pill, Select, st } from '../ui.tsx';
import { Picture } from './SupplierInvoices.tsx';
import { C } from '../theme.ts';

type View_ = 'requested' | 'approved' | 'collected' | 'all';
export const PO_STATUS: Record<string, { t: string; tone: 'info' | 'good' | 'warn' | 'bad' | 'quiet' }> = {
  requested: { t: 'Waiting for approval', tone: 'warn' }, approved: { t: 'Approved', tone: 'good' }, rejected: { t: 'Not approved', tone: 'bad' },
  collected: { t: 'Collected', tone: 'info' }, cancelled: { t: 'Cancelled', tone: 'quiet' },
};
const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function PurchaseOrderList() {
  const s = useStore();
  const [view, setView] = useState<View_>('requested');
  const [d, setD] = useState<any>(null);
  const [noFor, setNoFor] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [jobs, setJobs] = useState<{ id: string; label: string }[]>([]);
  const [showDoc, setShowDoc] = useState<string | null>(null);
  const [sim, setSim] = useState<string | null>(null);
  const demo = s.session?.mode === 'demo';
  useEffect(() => {
    s.ask({ method: 'GET', path: '/jobs' }).then(r => {
      if (r?.status === 200) setJobs((r.body as any[]).filter(j => j.status !== 'closed' && j.status !== 'cancelled').map(j => ({ id: j.id, label: `#${j.job_number} ${j.store} (${j.lead_technician})` })));
    }).catch(() => undefined);
  }, []);
  const link = async (id: string, jobId: string) => {
    const r = await s.ask({ method: 'PUT', path: `/purchase-orders/${id}`, json: { jobId } });
    if (r?.status === 200) { setMsg({ ok: true, text: 'Linked: the technician has the PO on his phone.' }); load(); }
    else setMsg({ ok: false, text: (r?.body as { reasons?: string[] })?.reasons?.join('; ') ?? 'No signal: try again.' });
  };
  const load = () => s.ask({ method: 'GET', path: `/purchase-orders?view=${view}` }).then(r => { if (r?.status === 200) setD(r.body); });
  useEffect(() => { load(); }, [view]);
  const decide = async (id: string, approve: boolean) => {
    const r = await s.ask({ method: 'POST', path: `/purchase-orders/${id}/decide`, json: approve ? { approve } : { approve, note: note.trim() } });
    if (r?.status === 200) { setMsg({ ok: true, text: approve ? 'Approved: the PO number is on the technician\'s phone.' : 'Not approved: the technician is told why.' }); setNoFor(null); setNote(''); load(); }
    else setMsg({ ok: false, text: (r?.body as { reasons?: string[] })?.reasons?.join('; ') ?? 'No signal: try again.' });
  };
  const c = d?.counts ?? {};
  return (
    <>
      <Choice options={['requested', 'approved', 'collected', 'all'] as const} value={view} onChange={v => { setView(v); setMsg(null); }}
        labels={{ requested: `To approve${c.requested ? ` (${c.requested})` : ''}`, approved: `Approved${c.approved ? ` (${c.approved})` : ''}`, collected: 'Collected', all: 'All' }} />
      <Text style={st.small}>Pastel: approved POs go into Pastel through the direct link once the office server is set up. A PO made in Pastel and posted in the purchase orders WhatsApp group comes in here by itself.</Text>
      {demo ? (
        <Card>
          <Text style={st.small}>Test drive: pretend admin posted a PO from Pastel in the purchase orders group.</Text>
          <Button label="Post a PO in the group" kind="secondary" onPress={async () => { const r = await s.ask({ method: 'POST', path: '/demo/pos/simulate', json: {} }); setSim(r?.status === 201 ? 'Posted: it was read and added (see Approved).' : 'Could not.'); load(); }} />
          {sim ? <Text style={st.small}>{sim}</Text> : null}
        </Card>
      ) : null}
      {msg ? <Notice tone={msg.ok ? 'good' : 'bad'} title={msg.text} /> : null}
      {!d ? <Body quiet>Loading…</Body> : null}
      {(d?.orders ?? []).map((p: any) => {
        const stt = PO_STATUS[p.status] ?? { t: p.status, tone: 'quiet' as const };
        return (
          <Card key={p.id} accessibilityLabel={`PO ${p.po_number}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[st.body, { fontWeight: '800', flex: 1 }]} numberOfLines={1}>PO {p.external_number ?? p.po_number} · {p.supplier_name}</Text>
              {p.source === 'group' ? <Pill text="From the group" tone="info" /> : null}
              <Pill text={stt.t} tone={stt.tone} />
            </View>
            <Text style={st.small}>{p.source === 'group' ? `Posted by ${p.posted_by ?? 'someone'} · ${p.technician ?? 'no technician yet'}` : p.technician} · {when(p.requested_at)} · {p.job_number ? `job ${p.job_number}${p.store ? `, ${p.store}` : ''}` : p.source === 'group' ? 'no job yet' : 'for his van'}</Text>
            {p.source === 'group' && (!p.job_id || !p.technician_id) && ['requested', 'approved'].includes(p.status) ? (
              <View style={{ gap: 6 }}>
                <Notice tone="warn" title="Which job is it for?" lines={['The PO did not say. Link it: the job\'s technician gets it on his phone.']} />
                <Select label="Job" value={null} placeholder="Choose the job" options={jobs.map(j => ({ value: j.id, label: j.label }))} onChange={v => link(p.id, v)} />
              </View>
            ) : null}
            {p.photo_id ? (showDoc === p.id ? <Picture id={p.photo_id} mime={p.photo_mime ?? null} /> : <Button label={p.source === "group" ? "See the PO as posted" : "See the photo he sent"} kind="quiet" onPress={() => setShowDoc(p.id)} />) : null}
            {(p.lines ?? []).map((l: any) => <Text key={l.lineNo} style={st.body}>{l.qty} × {l.description}{l.code ? ` (${l.code})` : ''}</Text>)}
            {p.note ? <Text style={st.small}>Note: {p.note}</Text> : null}
            {p.decided_by ? <Text style={st.small}>{p.status === 'rejected' ? 'Not approved' : 'Approved'} by {p.decided_by}{p.decision_note ? `: ${p.decision_note}` : ''}</Text> : null}
            {['approved', 'collected'].includes(p.status) ? <ExportBar title={`PO ${p.external_number ?? p.po_number}: PDF, WhatsApp or email`} make={() => ({ kind: 'purchase_order', title: `Purchase order ${p.external_number ?? p.po_number} – ${p.supplier_name}`, ref: `PO ${p.po_number}`, html: techPoHtml(p, s.session?.company.name ?? '') })} /> : null}
            {p.invoice ? <Text style={[st.small, { color: C.good }]}>Slip {p.invoice.invoiceNumber}{p.invoice.totalCents != null ? `, ${D.rand(p.invoice.totalCents)}` : ''}: the parts are on {p.job_number ? `job ${p.job_number}` : 'his van'}.</Text> : null}
            {p.canDecide ? (
              noFor === p.id ? (
                <>
                  <Field label="Why not? (the technician is told)" value={note} onChangeText={setNote} placeholder="e.g. Take the valve from the stockroom" />
                  <Button label="Don't approve" kind="danger" disabled={note.trim().length < 3} onPress={() => decide(p.id, false)} />
                  <Button label="Cancel" kind="quiet" onPress={() => setNoFor(null)} />
                </>
              ) : (
                <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
                  <Button label="Approve" onPress={() => decide(p.id, true)} style={{ flexGrow: 1, flexBasis: 130 }} />
                  <Button label="No" kind="secondary" onPress={() => { setNoFor(p.id); setNote(''); }} style={{ flexGrow: 1, flexBasis: 130 }} />
                </View>
              )
            ) : null}
          </Card>
        );
      })}
      {d && !d.orders.length ? <Body quiet>{view === 'requested' ? 'Nothing waiting for approval.' : 'Nothing here.'}</Body> : null}
    </>
  );
}
