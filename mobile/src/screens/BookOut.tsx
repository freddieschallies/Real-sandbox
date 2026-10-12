// Book out from the stockroom for a job: goes on the technician's name at once, against that job.
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso } from '../device.ts';
import { Body, Button, Card, Field, Heading, Notice, Screen, Stepper, st } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';
import { C } from '../theme.ts';
import type { StockRequest } from '../types.ts';

export function BookOut({ jobId }: { jobId: string }) {
  const s = useStore();
  const nav = useNav();
  const card = s.cache.cards[jobId];
  const [q, setQ] = useState('');
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [reasons, setReasons] = useState<string[] | null>(null);
  const cat = s.cache.catalogue ?? [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = cat.filter(i => words.every(w => `${i.code} ${i.description}`.toLowerCase().includes(w))).slice(0, 40);
  const chosen = Object.entries(basket).filter(([, n]) => n > 0);

  const book = () => {
    if (!chosen.length) { setReasons(['choose at least one item']); return; }
    const id = s.newId();
    const at = nowIso();
    const lines = chosen.map(([stockItemId, qty]) => ({ stockItemId, qty }));
    s.queue(`Stock request for #${card?.job_number ?? ''} (${lines.length} item${lines.length > 1 ? 's' : ''})`,
      { method: 'POST', path: `/jobs/${jobId}/stock-out`, json: { id, at, lines } }, jobId);
    // Shown as requested straight away; it goes on his name only when the stock controller issues it.
    const req: StockRequest = {
      id, job_id: jobId, job_number: card?.job_number ?? null, store: card?.store ?? null, status: 'pending', requested_at: at, decided_at: null, note: null,
      lines: lines.map((l, i) => {
        const it = cat.find(x => x.id === l.stockItemId)!;
        return { lineId: `${id}-${i}`, stockItemId: it.id, code: it.code, description: it.description, unit: it.unit, qtyRequested: l.qty, qtyIssued: null, inStockroom: it.inStockroom };
      }),
    };
    s.patchCache(c => {
      const jobStock = (c.jobStock?.[jobId] ?? []).map(x => ({ ...x }));
      for (const l of req.lines) {
        const js = jobStock.find(x => x.stockItemId === l.stockItemId);
        if (js) js.requested += l.qtyRequested;
        else jobStock.push({ stockItemId: l.stockItemId, code: l.code, description: l.description, unit: l.unit, booked: 0, used: 0, returned: 0, onTechnician: 0, requested: l.qtyRequested });
      }
      return { ...c, requests: [req, ...(c.requests ?? [])], jobStock: { ...c.jobStock, [jobId]: jobStock } };
    });
    nav.back();
  };

  return (
    <Screen title="Book stock for this job" sub={card ? `#${card.job_number} · ${card.store}` : undefined} onBack={nav.back} right={<SyncPill />}
      footer={<Button label={chosen.length ? `Send request: ${chosen.length} item${chosen.length > 1 ? 's' : ''}` : 'Send request'} onPress={book} disabled={!chosen.length} />}>
      <Body quiet>The stock controller picks it and issues it to you. From then it is on your name for this job, until you use it on the job card or return it.</Body>
      {reasons ? <Notice tone="bad" title="Still needed:" lines={reasons} /> : null}
      <Field label="Search" value={q} onChangeText={setQ} placeholder="code or description" autoCorrect={false} />
      {!cat.length ? <Body quiet>The stockroom list isn't on the phone yet. It needs signal once.</Body> : null}
      {chosen.length ? <Heading>Chosen</Heading> : null}
      {shown.map(i => (
        <Card key={i.id} style={basket[i.id] ? { borderColor: C.accent } : undefined}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={[st.body, { fontWeight: '700' }]}>{i.description}</Text>
              <Text style={[st.small, i.inStockroom <= 0 && { color: C.bad }]}>{i.code} · {i.inStockroom} {i.unit} in stockroom</Text>
            </View>
            <Stepper value={basket[i.id] ?? 0} max={Math.max(0, i.inStockroom)} label={i.code} onChange={n => setBasket(b => ({ ...b, [i.id]: n }))} />
          </View>
        </Card>
      ))}
    </Screen>
  );
}
