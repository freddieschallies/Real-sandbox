// Everything on my name: what must go back, what is for which job, my van stock,
// invoices to check, and returns the stock controller hasn't confirmed yet.
import React, { useEffect } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { Body, Button, Card, Heading, Notice, Pill, Screen, rand, st } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';
import { C } from '../theme.ts';
import type { InventoryLine } from '../types.ts';

export function MyStock() {
  const s = useStore();
  const nav = useNav();
  const inv = s.cache.inventory ?? [];
  const invoices = s.cache.invoices ?? [];
  const returns = s.cache.returns ?? [];
  const busy = invoices.some(i => i.status === 'reading') || returns.some(r => r.status === 'pending');

  useEffect(() => { s.refresh(); }, []);
  // While an invoice is being read or a return is waiting, look again every few seconds.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => { s.refresh(); }, 5000);
    return () => clearInterval(t);
  }, [busy]);

  const mustGo = inv.filter(l => l.mustReturn);
  const forJobs = inv.filter(l => l.holdingJobId && !l.mustReturn);
  const van = inv.filter(l => !l.holdingJobId);
  const toCheck = invoices.filter(i => i.status === 'to_confirm' || i.status === 'unreadable');
  const reading = invoices.filter(i => i.status === 'reading');
  const pending = returns.filter(r => r.status === 'pending');
  const jobs = [...new Set(forJobs.map(l => l.holdingJobId))];

  return (
    <Screen title="My stock" sub="Everything on your name" onBack={nav.back} right={<SyncPill />}>
      {mustGo.length ? <Notice tone="bad" title={`${mustGo.length} item${mustGo.length > 1 ? 's' : ''} must go back to the stockroom`} lines={['The job is closed and this was not used. It stays on your name until the stock controller confirms it is back.']} /> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Scan invoice" onPress={() => nav.push({ name: 'invoice' })} style={{ flex: 1 }} />
        <Button label="Return stock" kind="secondary" onPress={() => nav.push({ name: 'return' })} style={{ flex: 1 }} />
      </View>

      {toCheck.map(i => (
        <Card key={i.id} onPress={() => nav.push({ name: 'invoice', invoiceId: i.id })} style={{ borderColor: C.warn }}>
          <Notice tone="warn" title={i.status === 'unreadable' ? 'Invoice could not be read: type the lines' : 'Invoice read: check and confirm'}
            lines={[`${i.read_result?.supplierName ?? i.supplier_name ?? 'Supplier'} ${i.read_result?.invoiceNumber ?? ''}`.trim() + ` · ${i.read_result?.lines.length ?? 0} lines · ${rand(i.read_result?.totalCents)}`]} />
        </Card>
      ))}
      {reading.map(i => <Card key={i.id}><Body quiet>Reading a supplier invoice… you'll be asked to check it.</Body></Card>)}

      {mustGo.length ? <><Heading>Must go back</Heading>{mustGo.map(l => <Line key={key(l)} l={l} />)}</> : null}

      {pending.length ? (
        <>
          <Heading>Sent back, waiting for the stock controller</Heading>
          {pending.map(r => (
            <Card key={r.id}>
              <Text style={st.small}>Sent {new Date(r.requested_at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</Text>
              {r.lines.map(l => <Body key={l.lineId}>{l.qty} × {l.code} {l.description}{l.jobNumber ? ` (#${l.jobNumber})` : ''}</Body>)}
              <Text style={st.small}>Still on your name until confirmed.</Text>
            </Card>
          ))}
        </>
      ) : null}

      {jobs.map(j => {
        const lines = forJobs.filter(l => l.holdingJobId === j);
        return (
          <React.Fragment key={j}>
            <Heading>For job #{lines[0].jobNumber}{lines[0].store ? ` · ${lines[0].store}` : ''}</Heading>
            {lines.map(l => <Line key={key(l)} l={l} />)}
          </React.Fragment>
        );
      })}

      <Heading>Van stock</Heading>
      {van.length ? van.map(l => <Line key={key(l)} l={l} />) : <Body quiet>No van stock on your name.</Body>}
      {!s.online && !inv.length ? <Body quiet>No signal: showing what was saved on the phone.</Body> : null}
    </Screen>
  );
}

const key = (l: InventoryLine) => `${l.stockItemId}:${l.holdingJobId ?? 'van'}`;

function Line({ l }: { l: InventoryLine }) {
  return (
    <Card style={l.mustReturn ? { borderLeftWidth: 5, borderLeftColor: C.bad } : undefined}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={{ color: C.text, fontSize: 22, fontWeight: '800', minWidth: 44 }}>{l.qty}</Text>
        <View style={{ flex: 1 }}>
          <Text style={[st.body, { fontWeight: '700' }]}>{l.description}</Text>
          <Text style={st.small}>{l.code} · {l.unit}{l.holdingJobId && l.jobNumber ? ` · job #${l.jobNumber}` : ''}</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {l.mustReturn ? <Pill text="Return" tone="bad" /> : null}
        {l.pendingReturn ? <Pill text={`${l.pendingReturn} on its way back`} tone="warn" /> : null}
        {l.needsReview ? <Pill text="New item" tone="quiet" /> : null}
      </View>
    </Card>
  );
}
