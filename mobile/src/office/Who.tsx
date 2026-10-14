// Who did what, for reference: which technician's jobs brought in the most invoices, who made each
// invoice, and who handed in each supplier invoice.
import React, { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import * as D from '../../../server/src/core/documents.ts';
import { Body, Card, Choice, Heading, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';

const R = (c: number) => D.rand(c);
const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

function Ranking({ title, rows, unit }: { title: string; rows: { name: string; count: number; valueCents: number }[]; unit: string }) {
  const top = rows[0]?.count ?? 0;
  return (
    <Card>
      <Text style={[st.body, { fontWeight: '800' }]}>{title}</Text>
      {rows.map((r, i) => (
        <View key={r.name} style={{ gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { width: 22, color: C.quiet }]}>{i + 1}.</Text>
            <Text style={[st.body, { flex: 1 }]} numberOfLines={1}>{r.name}</Text>
            <Text style={st.small}>{r.count} {unit}{r.count === 1 ? '' : 's'} · {R(r.valueCents)}</Text>
          </View>
          <View style={{ height: 6, marginLeft: 30, borderRadius: 3, backgroundColor: C.panel2 }}>
            <View style={{ height: 6, width: `${top ? Math.max(4, (r.count / top) * 100) : 0}%`, borderRadius: 3, backgroundColor: C.accent }} />
          </View>
        </View>
      ))}
      {!rows.length ? <Body quiet>Nothing in this time.</Body> : null}
    </Card>
  );
}

export function WhoView() {
  const s = useStore();
  const [range, setRange] = useState<'30' | '90' | 'year'>('90');
  const [side, setSide] = useState<'in' | 'out'>('in');
  const [q, setQ] = useState('');
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    const now = new Date();
    const from = range === 'year' ? `${now.getFullYear()}-01-01` : ymd(new Date(Date.now() - Number(range) * 86_400_000));
    s.ask({ method: 'GET', path: `/office/who?from=${from}&to=${ymd(now)}` }).then(r => { if (r?.status === 200) setD(r.body); });
  }, [range]);
  if (!d) return <Body quiet>Loading…</Body>;
  const t = q.trim().toLowerCase();
  const inRows = (d.moneyIn as any[]).filter(x => !t || `${x.number} ${x.client} ${x.store} ${x.made_by} ${x.technician} ${x.job_number}`.toLowerCase().includes(t));
  const outRows = (d.moneyOut as any[]).filter(x => !t || `${x.number} ${x.supplier} ${x.handed_in_by} ${x.job_number ?? ''} ${x.po_number ?? ''}`.toLowerCase().includes(t));
  return (
    <>
      <Text style={st.small}>For reference: who made each invoice, which technician's jobs brought them in, and who handed in each supplier invoice.</Text>
      <Choice options={['30', '90', 'year'] as const} value={range} onChange={setRange} labels={{ 30: 'Last 30 days', 90: 'Last 90 days', year: 'This year' }} />
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <View style={{ flexGrow: 1, flexBasis: 280 }}><Ranking title="Technicians: invoices from their jobs" rows={d.byTechnician} unit="invoice" /></View>
        <View style={{ flexGrow: 1, flexBasis: 280 }}><Ranking title="Office: invoices made" rows={d.byMaker} unit="invoice" /></View>
        <View style={{ flexGrow: 1, flexBasis: 280 }}><Ranking title="Supplier invoices handed in" rows={d.byHandedIn} unit="invoice" /></View>
      </View>
      <Heading>Every invoice</Heading>
      <Choice options={['in', 'out'] as const} value={side} onChange={setSide} labels={{ in: `Money in (${d.moneyIn.length})`, out: `Money out (${d.moneyOut.length})` }} />
      <TextInput value={q} onChangeText={setQ} placeholder="Search number, client, supplier, person, job" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search who did what" />
      {side === 'in' ? inRows.map(x => (
        <Card key={x.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]} numberOfLines={1}>INV {x.number} · {x.store}</Text>
            <Text style={[st.body, { fontWeight: '800' }]}>{R(x.ex_vat)}</Text>
          </View>
          <Text style={st.small}>{x.date} · {x.client} · job {x.job_number} · technician {x.technician} · made by {x.made_by}</Text>
        </Card>
      )) : outRows.map(x => (
        <Card key={x.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]} numberOfLines={1}>{x.supplier} · {x.number}</Text>
            {x.po_number ? <Pill text={`PO ${x.po_number}`} tone="info" /> : null}
            <Text style={[st.body, { fontWeight: '800' }]}>{x.total_cents != null ? R(x.total_cents) : '–'}</Text>
          </View>
          <Text style={st.small}>{x.date} · handed in by {x.handed_in_by ?? '?'}{x.source === 'office' ? ' (scanned in the office)' : ' (till slip)'}{x.job_number ? ` · job ${x.job_number}` : ''}</Text>
        </Card>
      ))}
      {(side === 'in' ? !inRows.length : !outRows.length) ? <Body quiet>Nothing here.</Body> : null}
    </>
  );
}
