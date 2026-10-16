// Ordering from suppliers: the stockroom's purchase orders (made from the order list), sent by email
// on the letterhead, by WhatsApp or printed, and received against the delivery; and the suppliers'
// contact details for sending them.
import { ExportBar } from '../exportDoc.tsx';
import React, { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import * as D from '../../../server/src/core/documents.ts';
import * as R from '../../../server/src/core/stockroom.ts';
import { Body, Button, Card, Field, Heading, Notice, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { letterheadBottom, letterheadTop } from '../letterhead.tsx';
import { currentLogo } from '../brand.tsx';
import { waNumber } from '../office/Logins.tsx';

export interface StockOrder {
  id: string; po_number: number; status: string; supplier_name: string; supplier_id: string | null; note: string | null; requested_at: string; sent_at: string | null; sent_to: string[] | null; sent_how: string | null;
  collected_at: string | null; made_by: string | null; sent_by: string | null; supplier_email: string | null; supplier_phone: string | null; supplier_contact: string | null; delivery_ref: string | null;
  lines: { lineNo: number; stockItemId: string | null; code: string | null; unit: string | null; description: string; qty: number; supplierCode: string | null; unitPriceCents: number | null }[] | null;
}
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.'];
const day = (iso: string) => new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });

export function useStockOrders() {
  const s = useStore();
  const [d, setD] = useState<{ orders: StockOrder[]; canEmail: boolean } | null>(null);
  const load = () => s.ask({ method: 'GET', path: '/stock/orders' }).then(r => { if (r?.status === 200) setD(r.body as never); }).catch(() => undefined);
  useEffect(() => { load(); }, []);
  return { d, load };
}

export function StockOrders({ so, changed, only }: { so: ReturnType<typeof useStockOrders>; changed: () => void; only?: string | null }) {
  const list = (so.d?.orders ?? []).filter(o => !only || o.id === only);
  if (!so.d) return <Body quiet>Loading the purchase orders…</Body>;
  const toSend = list.filter(o => !o.sent_at && o.status === 'approved');
  const waiting = list.filter(o => o.sent_at && o.status === 'approved');
  const done = list.filter(o => o.status === 'collected').slice(0, 10);
  return (
    <>
      <Heading>Purchase orders to suppliers</Heading>
      {!list.length ? <Body quiet>None yet: make one from the order list above.</Body> : null}
      {[...toSend, ...waiting, ...done].map(o => <OrderCard key={o.id} o={o} canEmail={so.d!.canEmail} changed={() => { so.load(); changed(); }} />)}
    </>
  );
}

function OrderCard({ o, canEmail, changed }: { o: StockOrder; canEmail: boolean; changed: () => void }) {
  const s = useStore();
  const demo = s.session?.mode === 'demo';
  const [open, setOpen] = useState(!o.sent_at && o.status === 'approved');
  const [to, setTo] = useState(o.supplier_email ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [why, setWhy] = useState('');
  const lines = o.lines ?? [];
  const total = R.poTotal(lines.map(l => ({ ...l, code: l.code, supplierCode: l.supplierCode })));
  const status = o.status === 'collected' ? { t: `Received${o.delivery_ref ? ` (${o.delivery_ref})` : ''}`, tone: 'good' as const }
    : o.sent_at ? { t: `Sent ${o.sent_how === 'email' ? `by email` : o.sent_how === 'whatsapp' ? 'by WhatsApp' : o.sent_how === 'printed' ? 'printed' : 'by phone'}: waiting`, tone: 'info' as const }
    : { t: 'Not sent yet', tone: 'warn' as const };
  const doc = async () => {
    const r = await s.ask({ method: 'GET', path: `/stock/orders/${o.id}` });
    return r?.status === 200 ? (r.body as { doc: R.PoDoc; text: string }) : null;
  };
  const sent = async (how: 'whatsapp' | 'printed' | 'phone', toWho?: string) => {
    const r = await s.ask({ method: 'POST', path: `/stock/orders/${o.id}/sent`, json: { how, ...(toWho ? { to: toWho } : {}) } });
    if (r && r.status < 300) { setMsg({ ok: true, text: 'Marked as sent: it waits for the delivery.' }); changed(); } else setMsg({ ok: false, text: reasons(r).join('; ') });
  };
  return (
    <Card accessibilityLabel={`PO ${o.po_number}`}>
      <Pressable onPress={() => setOpen(v => !v)} accessibilityRole="button" style={{ gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>PO {o.po_number} · {o.supplier_name}</Text>
          <Pill text={status.t} tone={status.tone} />
        </View>
        <Text style={st.small}>{lines.length} item{lines.length === 1 ? '' : 's'}{total ? ` · about ${D.rand(total)} excl. VAT` : ''} · {day(o.requested_at)}{o.made_by ? ` · ${o.made_by}` : ''}{o.sent_to?.length ? ` · to ${o.sent_to.join(', ')}` : ''}</Text>
      </Pressable>
      {open ? (
        <View style={{ gap: 8 }}>
          {lines.map(l => <Text key={l.lineNo} style={st.body}>{l.qty} {l.unit ?? ''} × {l.description}{l.supplierCode ? ` (their code ${l.supplierCode})` : ''}{l.unitPriceCents != null ? ` · ${D.rand(l.unitPriceCents)}` : ''}</Text>)}
          {o.note ? <Text style={st.small}>Note: {o.note}</Text> : null}
          {o.status === 'approved' ? (
            <>
              <ExportBar title={`Purchase order ${o.po_number}: PDF, WhatsApp to the supplier`} phone={o.supplier_phone} noEmail
                make={async () => { const x = await doc(); return x ? { kind: 'purchase_order' as const, title: `Purchase order ${o.po_number} – ${o.supplier_name}`, ref: `PO ${o.po_number}`, html: poPageHtml(x.doc) } : null; }}
                onSent={how => { if (how === 'whatsapp' && !o.sent_at) sent('whatsapp', o.supplier_phone ?? undefined); }} />
              {canEmail ? (
                <View style={{ gap: 6 }}>
                  <Field label="Supplier's email" value={to} onChangeText={setTo} autoCapitalize="none" keyboardType="email-address" placeholder="orders@supplier.co.za" />
                  <Button label={o.sent_how === 'email' ? 'Email it again' : 'Email the purchase order'} busy={busy} disabled={!to.includes('@')} onPress={async () => {
                    setBusy(true);
                    const r = await s.ask({ method: 'POST', path: `/stock/orders/${o.id}/email`, json: { to: to.split(/[,;\s]+/).filter(Boolean) } });
                    setBusy(false);
                    if (r && r.status < 300) { setMsg({ ok: true, text: `Emailed to ${to}` }); changed(); } else setMsg({ ok: false, text: reasons(r).join('; ') });
                  }} />
                </View>
              ) : <Text style={st.small}>Email goes once the office server's email is set up; until then WhatsApp or print it.</Text>}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {!o.sent_at ? <Button label="I sent it another way" kind="quiet" onPress={() => sent('phone')} style={{ flexGrow: 1 }} /> : null}
              </View>
              {!o.supplier_phone ? <Text style={st.small}>Add the supplier's cell number under Suppliers to send it by WhatsApp.</Text> : null}
              {cancelling ? (
                <>
                  <Field label="Why is it cancelled?" value={why} onChangeText={setWhy} />
                  <Button label="Cancel the purchase order" kind="danger" disabled={why.trim().length < 3} onPress={async () => {
                    const r = await s.ask({ method: 'POST', path: `/stock/orders/${o.id}/cancel`, json: { note: why.trim() } });
                    if (r && r.status < 300) changed(); else setMsg({ ok: false, text: reasons(r).join('; ') });
                  }} />
                </>
              ) : <Button label="Cancel it" kind="quiet" onPress={() => setCancelling(true)} />}
              <Text style={st.small}>When the goods arrive: Stock → "Receive a delivery" and choose PO {o.po_number}.</Text>
            </>
          ) : null}
          {msg ? <Notice tone={msg.ok ? 'good' : 'bad'} title={msg.text} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

export function poPageHtml(doc: R.PoDoc): string {
  const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const plainHead = `<div class=bar></div><div class=head>${currentLogo() ? `<img src="${currentLogo()}" style="height:56px;background:#fff;padding:4px;border-radius:4px;margin-right:14px">` : ''}<div style="flex:1"><h1>${esc(doc.company.name)}</h1></div></div>`;
  const plainFoot = `<div class=foot>${esc([doc.company.address, doc.company.phone, doc.company.email].filter(Boolean).join(' · '))}</div><div class=bar></div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Purchase order ${doc.number}</title><style>${R.PO_CSS}</style></head><body>
${letterheadTop(plainHead)}${R.poHtml(doc)}${letterheadBottom(plainFoot)}<p class=noprint style="padding:12px 24px"><button onclick="print()">Print / save as PDF</button></p></body></html>`;
  return html;
}

/** Suppliers and their contact details (email for purchase orders, cell for WhatsApp). */
export function SupplierList() {
  const s = useStore();
  const [list, setList] = useState<{ id: string; name: string; email: string | null; phone: string | null; contact_name: string | null; last_order: string | null; usual_items: number }[] | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [f, setF] = useState({ email: '', phone: '', contact: '' });
  const [err, setErr] = useState<string[] | null>(null);
  const [q, setQ] = useState('');
  const load = () => s.ask({ method: 'GET', path: '/stock/suppliers' }).then(r => { if (r?.status === 200) setList(r.body as never); });
  useEffect(() => { load(); }, []);
  if (!list) return <Body quiet>Loading…</Body>;
  const shown = list.filter(x => !q.trim() || x.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <Heading>Suppliers</Heading>
      <Text style={st.small}>Their email and cell number, so purchase orders go straight to them. New suppliers are added by themselves from deliveries, slips and purchase orders.</Text>
      <Field label="Find a supplier" value={q} onChangeText={setQ} />
      {shown.map(x => (
        <Card key={x.id} accessibilityLabel={`Supplier ${x.name}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{x.name}</Text>
            {!x.email && !x.phone ? <Pill text="No contact yet" tone="warn" /> : null}
          </View>
          <Text style={st.small}>{[x.contact_name, x.email, x.phone].filter(Boolean).join(' · ') || 'No contact details'}{x.usual_items ? ` · usual supplier of ${x.usual_items} item${x.usual_items === 1 ? '' : 's'}` : ''}{x.last_order ? ` · last PO ${day(x.last_order)}` : ''}</Text>
          {edit === x.id ? (
            <View style={{ gap: 6 }}>
              <Field label="Contact person" value={f.contact} onChangeText={t => setF(v => ({ ...v, contact: t }))} />
              <Field label="Email for orders" value={f.email} onChangeText={t => setF(v => ({ ...v, email: t }))} autoCapitalize="none" keyboardType="email-address" />
              <Field label="Cell (WhatsApp)" value={f.phone} onChangeText={t => setF(v => ({ ...v, phone: t }))} keyboardType="phone-pad" />
              {err ? <Notice tone="bad" title="Not saved" lines={err} /> : null}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button label="Save" onPress={async () => {
                  const r = await s.ask({ method: 'PUT', path: `/stock/suppliers/${x.id}`, json: { email: f.email.trim(), phone: f.phone.trim(), contactName: f.contact.trim() } });
                  if (r && r.status < 300) { setEdit(null); setErr(null); load(); } else setErr(reasons(r));
                }} style={{ flex: 1 }} />
                <Button label="Cancel" kind="quiet" onPress={() => setEdit(null)} style={{ flex: 1 }} />
              </View>
            </View>
          ) : <Button label="Contact details" kind="quiet" onPress={() => { setEdit(x.id); setF({ email: x.email ?? '', phone: x.phone ?? '', contact: x.contact_name ?? '' }); }} />}
        </Card>
      ))}
      {!shown.length ? <Body quiet>No suppliers yet.</Body> : null}
    </>
  );
}
