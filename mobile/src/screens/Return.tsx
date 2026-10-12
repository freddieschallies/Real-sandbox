// Returning stock: it stays on the technician's name until the stock controller confirms it arrived.
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso } from '../device.ts';
import { Body, Button, Card, Heading, Notice, Pill, Screen, Stepper, st } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';
import { C } from '../theme.ts';
import type { InventoryLine, StockReturn } from '../types.ts';

const key = (l: InventoryLine) => `${l.stockItemId}:${l.holdingJobId ?? 'van'}`;
const free = (l: InventoryLine) => Math.max(0, Math.round((l.qty - l.pendingReturn) * 100) / 100);

export function Return() {
  const s = useStore();
  const nav = useNav();
  const lines = (s.cache.inventory ?? []).filter(l => free(l) > 0);
  // What must go back is filled in already; anything else he chooses.
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(lines.filter(l => l.mustReturn).map(l => [key(l), free(l)])));
  const chosen = lines.filter(l => (qty[key(l)] ?? 0) > 0);

  const send = () => {
    const id = s.newId();
    const body = { id, at: nowIso(), lines: chosen.map(l => ({ stockItemId: l.stockItemId, holdingJobId: l.holdingJobId, qty: qty[key(l)] })) };
    s.queue(`Stock return: ${chosen.length} line${chosen.length > 1 ? 's' : ''}`, { method: 'POST', path: '/me/returns', json: body });
    const ret: StockReturn = {
      id, status: 'pending', requested_at: body.at, received_at: null, note: null,
      lines: chosen.map((l, i) => ({ lineId: `${id}-${i}`, stockItemId: l.stockItemId, code: l.code, description: l.description, holdingJobId: l.holdingJobId, jobNumber: l.jobNumber, qty: qty[key(l)], qtyReceived: null })),
    };
    s.patchCache(c => ({
      ...c,
      returns: [ret, ...(c.returns ?? [])],
      inventory: (c.inventory ?? []).map(l => ({ ...l, pendingReturn: l.pendingReturn + (qty[key(l)] ?? 0) })),
      stock: c.stock.map(x => ({ ...x, qty: x.qty - chosen.filter(l => l.stockItemId === x.id).reduce((n, l) => n + qty[key(l)], 0) })),
    }));
    nav.back();
  };

  const group = (title: string, ls: InventoryLine[]) => ls.length ? (
    <>
      <Heading>{title}</Heading>
      {ls.map(l => (
        <Card key={key(l)} style={l.mustReturn ? { borderLeftWidth: 5, borderLeftColor: C.bad } : undefined}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={[st.body, { fontWeight: '700' }]}>{l.description}</Text>
              <Text style={st.small}>{l.code} · {free(l)} {l.unit} on you{l.jobNumber ? ` · job #${l.jobNumber}` : ''}</Text>
              {l.mustReturn ? <Pill text="Must go back" tone="bad" /> : null}
            </View>
            <Stepper value={qty[key(l)] ?? 0} max={free(l)} label={l.code} onChange={n => setQty(q => ({ ...q, [key(l)]: n }))} />
          </View>
        </Card>
      ))}
    </>
  ) : null;

  return (
    <Screen title="Return to stockroom" onBack={nav.back} right={<SyncPill />}
      footer={<Button label={chosen.length ? `Send back ${chosen.length} line${chosen.length > 1 ? 's' : ''}` : 'Send back'} onPress={send} disabled={!chosen.length} />}>
      <Notice tone="info" title="It stays on your name until the stock controller confirms" lines={['Hand it over at the stockroom. Anything that doesn\'t arrive stays on your name and you are asked about it.']} />
      {!lines.length ? <Body quiet>Nothing on your name to return.</Body> : null}
      {group('Must go back', lines.filter(l => l.mustReturn))}
      {group('For open jobs', lines.filter(l => l.holdingJobId && !l.mustReturn))}
      {group('Van stock', lines.filter(l => !l.holdingJobId))}
    </Screen>
  );
}
