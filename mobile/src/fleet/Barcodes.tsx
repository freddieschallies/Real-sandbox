// The mechanic's Barcodes tab: each vehicle's sticker code, shown as a barcode, printed as stickers,
// changed for a new one (when a sticker is lost or damaged: the old one stops working at once), or
// set to the code of a sticker already in the vehicle. Technicians scan it to drive the vehicle.
import React, { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Field, Heading, Notice, st } from '../ui.tsx';
import { Barcode, printStickers } from '../barcode.tsx';

interface Row { id: string; registration: string; description: string | null; make: string | null; model: string | null; barcode: string }
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons?.join('; ') ?? 'Needs signal: try again.';

export function VehicleBarcodes() {
  const s = useStore();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [q, setQ] = useState('');
  const load = () => s.ask({ method: 'GET', path: '/fleet/barcodes' }).then(r => { if (r?.status === 200) { setRows(r.body.vehicles); setCanEdit(r.body.canEdit); } else setMsg({ tone: 'bad', text: reasons(r) }); });
  useEffect(() => { load(); }, []);
  const company = s.session?.company.name ?? '';
  const sticker = (v: Row) => ({ title: v.registration, sub: [v.make, v.model].filter(Boolean).join(' ') || v.description, code: v.barcode, foot: 'Scan with the job card app to drive this vehicle' });
  const print = (list: Row[]) => setMsg(printStickers('Vehicle stickers', company, list.map(sticker)) ? null : { tone: 'bad', text: Platform.OS === 'web' ? 'The browser blocked the print window: allow pop-ups for this site.' : 'Print the stickers from the office computer (or show the barcode on this screen to scan).' });
  const list = (rows ?? []).filter(v => !q.trim() || `${v.registration} ${v.make ?? ''} ${v.model ?? ''} ${v.barcode}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <Heading>Vehicle barcodes</Heading>
      <Body quiet>Each vehicle's sticker. Technicians scan it (or the licence disc) to drive the vehicle. Print the stickers, put one inside the windscreen or on the dashboard.</Body>
      {rows?.length ? <Button label={`Print all stickers (${rows.length})`} onPress={() => print(rows)} /> : null}
      <Field label="Find a vehicle" value={q} onChangeText={setQ} placeholder="Registration, make or code" />
      {msg ? <Notice tone={msg.tone} title={msg.text} /> : null}
      {!rows ? <Body quiet>Loading…</Body> : null}
      {list.map(v => <VehicleCode key={v.id} v={v} canEdit={canEdit} print={() => print([v])} changed={(t, text) => { setMsg({ tone: t, text }); if (t === 'good') load(); }} />)}
    </>
  );
}

function VehicleCode({ v, canEdit, print, changed }: { v: Row; canEdit: boolean; print: () => void; changed: (tone: 'good' | 'bad', text: string) => void }) {
  const s = useStore();
  const [mode, setMode] = useState<'none' | 'confirm' | 'type'>('none');
  const [code, setCode] = useState('');
  const set = async (body: object) => {
    const r = await s.ask({ method: 'POST', path: `/fleet/vehicles/${v.id}/barcode`, json: body });
    if (r && r.status < 300) { setMode('none'); setCode(''); changed('good', `${v.registration}: code ${r.body.barcode}. Print the new sticker: the old one (${r.body.previous}) no longer works.`); }
    else changed('bad', reasons(r));
  };
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <Text style={[st.body, { fontWeight: '800', fontSize: 18 }]}>{v.registration}</Text>
        <Text style={[st.small, { flex: 1 }]}>{[v.make, v.model].filter(Boolean).join(' ') || v.description}</Text>
      </View>
      <Barcode value={v.barcode} />
      <Text style={[st.body, { fontFamily: Platform.OS === 'web' ? 'monospace' : undefined, letterSpacing: 1 }]}>{v.barcode}</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Button label="Print sticker" kind="secondary" onPress={print} style={{ flexGrow: 1 }} />
        {canEdit ? <Button label="New code" kind="quiet" onPress={() => setMode(mode === 'confirm' ? 'none' : 'confirm')} style={{ flexGrow: 1 }} /> : null}
        {canEdit ? <Button label="Use the sticker in it" kind="quiet" onPress={() => setMode(mode === 'type' ? 'none' : 'type')} style={{ flexGrow: 1 }} /> : null}
      </View>
      {mode === 'confirm' ? (
        <View style={{ gap: 6 }}>
          <Text style={st.small}>A new code for {v.registration}: the sticker in it now stops working at once. Use this when a sticker is lost, damaged or the vehicle changed hands.</Text>
          <Button label="Yes, make a new code" onPress={() => set({})} />
        </View>
      ) : null}
      {mode === 'type' ? (
        <View style={{ gap: 6 }}>
          <Field label="The code on the sticker already in the vehicle" value={code} onChangeText={t => setCode(t.toUpperCase())} autoCapitalize="characters" placeholder="e.g. ZSP-V07" />
          <Button label="Save the code" disabled={code.trim().length < 3} onPress={() => set({ code: code.trim() })} />
        </View>
      ) : null}
    </Card>
  );
}
