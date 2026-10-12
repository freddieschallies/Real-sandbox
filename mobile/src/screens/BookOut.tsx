// Book out from the stockroom for a job: goes on the technician's name at once, against that job.
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso } from '../device.ts';
import { Body, Button, Card, Field, Heading, Notice, Screen, Stepper, st } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';
import { C } from '../theme.ts';
import type { InventoryLine } from '../types.ts';

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
    const lines = chosen.map(([stockItemId, qty]) => ({ stockItemId, qty }));
    s.queue(`Booked out ${lines.length} item${lines.length > 1 ? 's' : ''} for #${card?.job_number ?? ''}`,
      { method: 'POST', path: `/jobs/${jobId}/stock-out`, json: { at: nowIso(), lines } }, jobId);
    // Show it on the phone straight away; the office confirms when the request arrives.
    s.patchCache(c => {
      const inventory = (c.inventory ?? []).map(x => ({ ...x }));
      const jobStock = (c.jobStock?.[jobId] ?? []).map(x => ({ ...x }));
      const stock = c.stock.map(x => ({ ...x }));
      for (const l of lines) {
        const it = cat.find(x => x.id === l.stockItemId)!;
        const h = inventory.find(x => x.stockItemId === l.stockItemId && x.holdingJobId === jobId);
        if (h) h.qty += l.qty;
        else inventory.push({ stockItemId: it.id, code: it.code, description: it.description, unit: it.unit, needsReview: false, holdingJobId: jobId,
          jobNumber: card?.job_number ?? null, jobStatus: card?.status ?? null, store: card?.store ?? null, qty: l.qty, pendingReturn: 0, mustReturn: false } as InventoryLine);
        const js = jobStock.find(x => x.stockItemId === l.stockItemId);
        if (js) { js.booked += l.qty; js.onTechnician += l.qty; }
        else jobStock.push({ stockItemId: it.id, code: it.code, description: it.description, unit: it.unit, booked: l.qty, used: 0, returned: 0, onTechnician: l.qty });
        const st = stock.find(x => x.id === l.stockItemId);
        if (st) st.qty += l.qty; else stock.push({ id: it.id, code: it.code, description: it.description, unit: it.unit, qty: l.qty });
      }
      return {
        ...c, inventory, stock, jobStock: { ...c.jobStock, [jobId]: jobStock },
        catalogue: (c.catalogue ?? []).map(x => ({ ...x, inStockroom: x.inStockroom - (basket[x.id] ?? 0) })),
      };
    });
    nav.back();
  };

  return (
    <Screen title="Book out from stockroom" sub={card ? `For #${card.job_number} · ${card.store}` : undefined} onBack={nav.back} right={<SyncPill />}
      footer={<Button label={chosen.length ? `Book out ${chosen.length} item${chosen.length > 1 ? 's' : ''}` : 'Book out'} onPress={book} disabled={!chosen.length} />}>
      <Body quiet>What you book out goes on your name for this job until you use it on the job card or the stock controller confirms you returned it.</Body>
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
