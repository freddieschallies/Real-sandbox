// Stock take of the stockroom: start one (everything, or stock, tools or PPE), count each item (what
// the app expects shows only once it is counted), see the differences and what they are worth, and
// sign off: the stockroom is corrected and Accounts and the CEO are told. A blank count sheet prints
// for counting on paper; the results print for the file.
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import * as D from '../../../server/src/core/documents.ts';
import type { TakeSummary } from '../../../server/src/core/stockroom.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { letterheadBottom, letterheadTop } from '../letterhead.tsx';
import { Thumb } from './Parts.tsx';

interface Item { id: string; code: string; description: string; unit: string; category: string; photoId: string | null; costCents: number | null; counted: number | null; expected: number | null; live: number; note: string | null; countedBy: string | null; diff: number | null }
interface Take { id: string; label: string; category: string | null; started_at: string; started_by: string; signed_off_at: string | null; signed_off_by: string | null; signoff_note: string | null; cancelled_at: string | null }
interface ListRow { id: string; label: string; started_at: string; started_by: string; signed_off_at: string | null; signed_off_by: string | null; cancelled_at: string | null; counted: number; differences: number; net_cents: number }
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.'];
const day = (iso: string) => new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const n = (x: number) => String(Math.round(x * 100) / 100);

export function StockTakeTab() {
  const s = useStore();
  const [list, setList] = useState<{ open: ListRow | null; past: ListRow[] } | null>(null);
  const [view, setView] = useState<string | null>(null);
  const [cat, setCat] = useState<'all' | 'stock' | 'tool' | 'ppe'>('stock');
  const [err, setErr] = useState<string[] | null>(null);
  const load = () => s.ask({ method: 'GET', path: '/stock/stocktakes' }).then(r => { if (r?.status === 200) setList(r.body as never); else setErr(reasons(r)); });
  useEffect(() => { load(); }, []);
  if (view) return <TakeView id={view} close={() => { setView(null); load(); }} />;
  if (!list) return err ? <Notice tone="bad" title="Could not load" lines={err} /> : <Body quiet>Loading…</Body>;
  if (list.open) return <TakeView id={list.open.id} close={() => load()} />;
  return (
    <>
      <Heading>Stock take</Heading>
      <Text style={st.body}>Count what is on the shelves. The app shows what it expected only after you count each item, then you see the differences and sign it off: the stockroom is corrected.</Text>
      <Card>
        <Label>What to count</Label>
        <Choice options={['stock', 'tool', 'ppe', 'all'] as const} value={cat} onChange={setCat} labels={{ stock: 'Stock (parts)', tool: 'Tools', ppe: 'PPE', all: 'Everything' }} />
        {err ? <Notice tone="bad" title="Not started" lines={err} /> : null}
        <Button label="Start a stock take" onPress={async () => {
          const r = await s.ask({ method: 'POST', path: '/stock/stocktakes', json: cat === 'all' ? {} : { category: cat } });
          if (r && r.status < 300) { setErr(null); load(); } else setErr(reasons(r));
        }} />
      </Card>
      <Heading>Earlier stock takes</Heading>
      {list.past.map(t => (
        <Card key={t.id} onPress={() => setView(t.id)} accessibilityLabel={`Stock take ${day(t.started_at)}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{t.label} · {day(t.started_at)}</Text>
            {t.cancelled_at ? <Pill text="Cancelled" tone="quiet" /> : <Pill text={t.differences ? `${t.differences} differ` : 'All correct'} tone={t.differences ? 'warn' : 'good'} />}
          </View>
          <Text style={st.small}>{t.counted} counted · {t.signed_off_by ? `signed off by ${t.signed_off_by}` : `started by ${t.started_by}`}{t.net_cents ? ` · ${t.net_cents < 0 ? `${D.rand(-t.net_cents)} short` : `${D.rand(t.net_cents)} over`}` : ''}</Text>
        </Card>
      ))}
      {!list.past.length ? <Body quiet>None yet.</Body> : null}
    </>
  );
}

function TakeView({ id, close }: { id: string; close: () => void }) {
  const s = useStore();
  const [d, setD] = useState<{ take: Take; items: Item[]; summary: TakeSummary } | null>(null);
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'todo' | 'diff' | 'all'>('todo');
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [signing, setSigning] = useState(false);
  const [note, setNote] = useState('');
  const [partial, setPartial] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => s.ask({ method: 'GET', path: `/stock/stocktakes/${id}` }).then(r => { if (r?.status === 200) setD(r.body as never); else setErr(reasons(r)); });
  useEffect(() => { load(); }, [id]);
  if (!d) return err ? <Notice tone="bad" title="Could not load" lines={err} /> : <Body quiet>Loading…</Body>;
  const t = d.take, sm = d.summary;
  const open = !t.signed_off_at && !t.cancelled_at;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = d.items.filter(i => words.every(w => `${i.code} ${i.description}`.toLowerCase().includes(w)))
    .filter(i => !open || show === 'all' || (show === 'todo' ? i.counted === null : i.diff));
  const count = async (i: Item) => {
    const v = Number((typed[i.id] ?? '').replace(',', '.'));
    if (!(typed[i.id] ?? '').trim() || !(v >= 0)) return;
    const r = await s.ask({ method: 'PUT', path: `/stock/stocktakes/${id}/count`, json: { stockItemId: i.id, counted: v } });
    if (r && r.status < 300) { setTyped(x => { const y = { ...x }; delete y[i.id]; return y; }); setErr(null); load(); } else setErr(reasons(r));
  };
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontSize: 22, fontWeight: '800', flex: 1 }}>Stock take: {t.label}</Text>
        {open ? <Pill text="Counting" tone="info" /> : t.cancelled_at ? <Pill text="Cancelled" tone="quiet" /> : <Pill text="Signed off" tone="good" />}
      </View>
      <Text style={st.small}>Started {day(t.started_at)} by {t.started_by}{t.signed_off_at ? ` · signed off ${day(t.signed_off_at)} by ${t.signed_off_by}` : ''}</Text>
      <Card>
        <View style={{ height: 10, borderRadius: 5, backgroundColor: C.panel2, overflow: 'hidden' }}>
          <View style={{ width: `${sm.items ? Math.round((sm.counted / sm.items) * 100) : 0}%`, height: 10, backgroundColor: C.good }} />
        </View>
        <Text style={[st.body, { fontWeight: '800' }]}>{sm.counted} of {sm.items} counted{sm.differences ? ` · ${sm.differences} differ` : ''}</Text>
        {sm.differences ? <Text style={st.small}>{sm.short} short{sm.lossCents ? ` (${D.rand(sm.lossCents)})` : ''} · {sm.over} over{sm.gainCents ? ` (${D.rand(sm.gainCents)})` : ''}{sm.noCost ? ` · ${sm.noCost} with no cost price` : ''}</Text> : null}
        {t.signoff_note ? <Text style={st.small}>Why: {t.signoff_note}</Text> : null}
      </Card>
      {Platform.OS === 'web' ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {open ? <Button label="Print a count sheet" kind="secondary" onPress={() => printTake(t, d.items, false)} style={{ flexGrow: 1 }} /> : null}
          <Button label="Print the results" kind="secondary" onPress={() => printTake(t, d.items, true, sm)} style={{ flexGrow: 1 }} />
        </View>
      ) : null}
      {open ? (
        <>
          <TextInput value={q} onChangeText={setQ} placeholder="Find an item: code or name" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Find an item to count" />
          <Choice options={['todo', 'diff', 'all'] as const} value={show} onChange={setShow} labels={{ todo: `To count (${sm.left})`, diff: `Differences (${sm.differences})`, all: 'All' }} />
        </>
      ) : null}
      {err ? <Notice tone="bad" title="Not saved" lines={err} /> : null}
      {shown.slice(0, 200).map(i => (
        <Card key={i.id} accessibilityLabel={`Count ${i.code}`} style={i.diff ? { borderColor: i.diff < 0 ? C.bad : C.warn } : undefined}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <Thumb id={i.photoId} size={44} />
            <View style={{ flex: 1 }}>
              <Text style={[st.body, { fontWeight: '800' }]} numberOfLines={2}>{i.description}</Text>
              <Text style={st.small}>{i.code} · {i.unit}</Text>
              {i.counted !== null ? (
                <Text style={[st.small, { color: i.diff ? (i.diff < 0 ? C.bad : C.warn) : C.good }]}>
                  Counted {n(i.counted)} · expected {n(i.expected ?? 0)}{i.diff ? ` · ${i.diff > 0 ? '+' : ''}${n(i.diff)}${i.costCents ? ` (${D.rand(Math.abs(i.diff * i.costCents))})` : ''}` : ' · correct'}{i.countedBy ? ` · ${i.countedBy}` : ''}
                </Text>
              ) : null}
            </View>
            {open ? (
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                <TextInput value={typed[i.id] ?? ''} onChangeText={v => setTyped(x => ({ ...x, [i.id]: v }))} onSubmitEditing={() => count(i)} keyboardType="decimal-pad" placeholder={i.counted !== null ? n(i.counted) : 'Count'}
                  placeholderTextColor={C.quiet} accessibilityLabel={`Counted ${i.code}`} style={[st.input, { width: 80, textAlign: 'center', fontSize: 18 }]} />
                <Button label="✓" onPress={() => count(i)} disabled={!(typed[i.id] ?? '').trim()} style={{ minWidth: 48 }} />
              </View>
            ) : null}
          </View>
        </Card>
      ))}
      {open && !shown.length ? <Body quiet>{show === 'todo' ? 'Everything is counted.' : show === 'diff' ? 'No differences.' : 'Nothing found.'}</Body> : null}
      {open ? (
        signing ? (
          <Card>
            <Text style={[st.body, { fontWeight: '800' }]}>Sign off</Text>
            {sm.left ? (
              <Pressable onPress={() => setPartial(v => !v)} accessibilityRole="checkbox" accessibilityState={{ checked: partial }} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: partial ? C.accent : C.line, backgroundColor: partial ? C.accent : 'transparent' }} />
                <Text style={[st.body, { flex: 1 }]}>{sm.left} not counted: sign off only what was counted (the rest stays as it is)</Text>
              </Pressable>
            ) : null}
            {sm.differences ? <Field label="Why do the counts differ?" value={note} onChangeText={setNote} placeholder="e.g. used on jobs and not booked out; damaged; miscounted at the last stock take" multiline /> : null}
            <Text style={st.small}>Every difference corrects the stockroom{sm.differences ? `: ${sm.short} short, ${sm.over} over` : ''}. Accounts and the CEO are told.</Text>
            <Button label="Sign off the stock take" busy={busy} disabled={(!!sm.left && !partial) || (!!sm.differences && note.trim().length < 5)} onPress={async () => {
              setBusy(true);
              const r = await s.ask({ method: 'POST', path: `/stock/stocktakes/${id}/sign-off`, json: { partial, ...(note.trim() ? { note: note.trim() } : {}) } });
              setBusy(false);
              if (r && r.status < 300) { setSigning(false); setErr(null); load(); } else setErr(reasons(r));
            }} />
            <Button label="Not yet" kind="quiet" onPress={() => setSigning(false)} />
          </Card>
        ) : (
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button label="Sign off the stock take" disabled={!sm.counted} onPress={() => setSigning(true)} style={{ flexGrow: 1 }} />
            <Button label="Cancel it" kind="quiet" onPress={async () => { await s.ask({ method: 'POST', path: `/stock/stocktakes/${id}/cancel`, json: {} }); close(); }} style={{ flexGrow: 1 }} />
          </View>
        )
      ) : <Button label="Back to stock takes" kind="quiet" onPress={close} />}
    </>
  );
}

/** A count sheet (blank, for counting on paper) or the results, on the letterhead. */
function printTake(t: Take, items: Item[], results: boolean, sm?: TakeSummary) {
  if (Platform.OS !== 'web') return;
  const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const list = results ? items.filter(i => i.counted !== null) : items;
  const rows = list.map(i => results
    ? `<tr><td>${esc(i.code)}</td><td>${esc(i.description)}</td><td class=r>${n(i.expected ?? 0)}</td><td class=r>${n(i.counted ?? 0)}</td><td class="r${i.diff ? ' bad' : ''}">${i.diff ? `${i.diff > 0 ? '+' : ''}${n(i.diff)}` : ''}</td><td class=r>${i.diff && i.costCents ? D.rand(i.diff * i.costCents) : ''}</td></tr>`
    : `<tr><td>${esc(i.code)}</td><td>${esc(i.description)}</td><td>${esc(i.unit)}</td><td style="width:120px;border-bottom:1px solid #111"></td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Stock take ${esc(t.label)}</title><style>body{font:12px Arial,sans-serif;margin:0;color:#111}.bar{height:8px;background:#E8701A}.body{padding:14px 20px}
table{width:100%;border-collapse:collapse;margin-top:10px}th{text-align:left;border-top:2px solid #111;border-bottom:1px solid #ccc;padding:5px 4px}td{border-bottom:1px solid #eee;padding:7px 4px}.r{text-align:right}.bad{color:#B00020}@media print{.noprint{display:none}}</style></head><body>
${letterheadTop('<div class=bar></div>')}<div class=body><h2 style="margin:4px 0">${results ? 'Stock take results' : 'Stock take count sheet'}: ${esc(t.label)}</h2>
<div>Started ${esc(day(t.started_at))} by ${esc(t.started_by)}${t.signed_off_at ? ` · signed off ${esc(day(t.signed_off_at))} by ${esc(t.signed_off_by)}` : ''}</div>
${results && sm ? `<p><b>${sm.counted} counted, ${sm.differences} differ</b>${sm.lossCents ? ` · ${D.rand(sm.lossCents)} short` : ''}${sm.gainCents ? ` · ${D.rand(sm.gainCents)} over` : ''}${t.signoff_note ? `<br>Why: ${esc(t.signoff_note)}` : ''}</p>` : ''}
<table><tr>${results ? '<th>Code</th><th>Item</th><th class=r>Expected</th><th class=r>Counted</th><th class=r>Difference</th><th class=r>Value</th>' : '<th>Code</th><th>Item</th><th>Unit</th><th>Counted</th>'}</tr>${rows}</table>
<p style="margin-top:24px">Counted by: ____________________ &nbsp;&nbsp; Checked by: ____________________</p></div>${letterheadBottom('<div class=bar></div>')}
<p class=noprint style="padding:10px 20px"><button onclick="print()">Print / save as PDF</button></p></body></html>`;
  try { const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); } } catch { /* blocked */ }
}
