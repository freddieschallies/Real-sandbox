// The office's QR codes tab: every sticker in the company, to print: the vehicles (the mechanic's
// codes) and the tool store's tools and ladders (the stockroom's codes). The admin prints them; new
// codes are made by the mechanic (vehicles) and the stock controller (tools).
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Barcode, printStickers } from '../barcode.tsx';
import { Thumb } from '../ItemPicture.tsx';
import { Body, Button, Card, Choice, Heading, Notice, st } from '../ui.tsx';
import { C } from '../theme.ts';

interface Data {
  vehicles: { id: string; registration: string; description: string | null; make: string | null; model: string | null; barcode: string; photo_id?: string | null }[];
  tools: { id: string; name: string; kind: 'tool' | 'ladder' | 'equipment'; serial: string | null; barcode: string; condition: string; photo_id?: string | null }[];
}
type Item = { key: string; title: string; sub: string | null; code: string; foot: string; photo?: string | null };

export function PrintBarcodes() {
  const s = useStore();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [what, setWhat] = useState<'vehicles' | 'tools' | 'ladders'>('vehicles');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => { s.ask({ method: 'GET', path: '/barcodes' }).then(r => { if (r?.status === 200) setD(r.body); else setErr((r?.body as { reasons?: string[] })?.reasons?.join('; ') ?? 'Needs signal.'); }); }, []);
  useEffect(() => setPicked(new Set()), [what]);
  const company = s.session?.company.name ?? '';
  const items: Item[] = !d ? [] : what === 'vehicles'
    ? d.vehicles.map(v => ({ key: v.id, title: v.registration, sub: [v.make, v.model].filter(Boolean).join(' ') || v.description, code: v.barcode, foot: 'Scan with the job card app to drive this vehicle', photo: v.photo_id }))
    : d.tools.filter(t => what === 'tools' || t.kind === 'ladder').map(t => ({ key: t.id, title: t.name, sub: t.serial ? `S/N ${t.serial}` : null, code: t.barcode, foot: 'Stockroom: sign it out and back in', photo: t.photo_id }));
  const chosen = picked.size ? items.filter(i => picked.has(i.key)) : items;
  const [msg, setMsg] = useState<string | null>(null);
  const print = (list: Item[]) => setMsg(printStickers(what === 'vehicles' ? 'Vehicle stickers' : 'Tool store stickers', company, list) ? null
    : Platform.OS === 'web' ? 'The browser blocked the print window: allow pop-ups for this site.' : 'Print from the office computer.');
  const toggle = (k: string) => setPicked(p => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <>
      <Heading>QR code stickers</Heading>
      <Body quiet>Print the stickers: three across on A4, sticker paper or plain paper under clear tape. Phones scan them with the job card app, or the phone's browser. New codes are made by the mechanic (vehicles) and the stock controller (tools).</Body>
      <Choice options={['vehicles', 'tools', 'ladders'] as const} value={what} onChange={setWhat} labels={{ vehicles: `Vehicles${d ? ` (${d.vehicles.length})` : ''}`, tools: `Tools and ladders${d ? ` (${d.tools.length})` : ''}`, ladders: 'Ladders only' }} />
      {err ? <Notice tone="bad" title="Could not load" lines={[err]} /> : null}
      {!d && !err ? <Body quiet>Loading…</Body> : null}
      {items.length ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Button label={picked.size ? `Print the ${picked.size} ticked` : `Print all ${items.length}`} onPress={() => print(chosen)} style={{ flexGrow: 1 }} />
          {picked.size ? <Button label="Clear ticks" kind="quiet" onPress={() => setPicked(new Set())} style={{ flexGrow: 1 }} /> : null}
        </View>
      ) : d ? <Body quiet>Nothing to print here yet.</Body> : null}
      {msg ? <Notice tone="bad" title={msg} /> : null}
      <Text style={st.small}>Tick stickers to print only those (a lost or damaged one), or print them all.</Text>
      {items.map(i => (
        <Card key={i.key}>
          <Pressable onPress={() => toggle(i.key)} accessibilityRole="checkbox" accessibilityState={{ checked: picked.has(i.key) }} accessibilityLabel={`Tick ${i.title}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 24, height: 24, borderRadius: 4, borderWidth: 2, borderColor: picked.has(i.key) ? C.accent : C.line, backgroundColor: picked.has(i.key) ? C.accent : 'transparent' }} />
            <Thumb photoId={i.photo} label={i.title} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={[st.body, { fontWeight: '800' }]}>{i.title}</Text>
              {i.sub ? <Text style={st.small}>{i.sub}</Text> : null}
            </View>
          </Pressable>
          <Barcode value={i.code} size={110} />
          <Text style={st.small}>{i.code}</Text>
          <Button label="Print this one" kind="quiet" onPress={() => print([i])} />
        </Card>
      ))}
    </>
  );
}
