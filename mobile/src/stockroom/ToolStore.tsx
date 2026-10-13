// The stockroom's tool store: shared tools and step ladders, each with a serial number and a QR code
// sticker. Scan a sticker (camera, a handheld scanner, or type the code or serial) to find the tool.
// Book out: to a person, for one of their open jobs, and they sign for it on this screen. Sign back:
// its condition, and the person returning it signs. A tool not back the morning after its job is done
// is flagged to the person.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { CodeScanner } from '../CodeScanner.tsx';
import { ItemPicture, Thumb } from '../ItemPicture.tsx';
import { useStore } from '../state.tsx';
import { nowIso } from '../device.ts';
import { SignaturePad, type SignaturePadHandle } from '../SignaturePad.tsx';
import { Barcode, printStickers } from '../barcode.tsx';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, Select, st } from '../ui.tsx';
import { C } from '../theme.ts';

export interface StoreTool {
  id: string; name: string; kind: 'tool' | 'ladder' | 'equipment'; serial: string | null; barcode: string; notes: string | null; condition: 'good' | 'damaged' | 'lost'; active: boolean; photo_id?: string | null;
  out: null | { bookingId: string; userId: string; userName: string; jobId: string | null; jobNumber: number | null; jobStatus: string | null; outAt: string; outBy: string; outByStandIn?: string | null; note: string | null; due: string; overdue: boolean };
}
interface Data { tools: StoreTool[]; people: { id: string; full_name: string; login_level: string }[]; jobs: { id: string; job_number: number; store: string; fault_reported: string; people: string[] }[] }
interface Hist { id: string; out_at: string; returned_at: string | null; return_condition: string | null; return_note: string | null; out_note: string | null; user_name: string; job_number: number | null; out_by: string; returned_by: string | null; out_by_stand_in?: string | null; returned_by_stand_in?: string | null }

const KIND: Record<StoreTool['kind'], string> = { tool: 'Tool', ladder: 'Ladder', equipment: 'Equipment' };
const FILTERS = ['all', 'out', 'late', 'in', 'ladder'] as const;
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons?.join('; ') ?? 'Needs signal: try again.';
const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function ToolStore() {
  const s = useStore();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState<(typeof FILTERS)[number]>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [camera, setCamera] = useState(false);
  const load = async () => { const r = await s.ask({ method: 'GET', path: '/tool-store' }); if (r?.status === 200) { setD(r.body); setErr(null); } else setErr(reasons(r)); };
  useEffect(() => { load(); }, []);
  const find = async (raw: string) => {
    const c = raw.trim();
    if (c.length < 2) return;
    const r = await s.ask({ method: 'GET', path: `/tool-store/find?code=${encodeURIComponent(c)}` });
    if (r?.status === 200) { setOpen(r.body.id); setF('all'); setCode(''); setMsg(null); } else setMsg({ tone: 'bad', text: reasons(r) });
  };
  const tools = d?.tools ?? [];
  const list = tools.filter(t => f === 'all' ? t.active || !!t.out : f === 'out' ? !!t.out : f === 'late' ? !!t.out?.overdue : f === 'in' ? t.active && !t.out : t.kind === 'ladder' && t.active)
    .sort((a, b) => Number(b.id === open) - Number(a.id === open)); // the one just scanned on top
  const company = s.session?.company.name ?? '';
  const sticker = (t: StoreTool) => ({ title: t.name, sub: t.serial ? `S/N ${t.serial}` : null, code: t.barcode, foot: 'Stockroom: sign it out and back in' });
  const print = (ts: StoreTool[]) => setMsg(printStickers('Tool store stickers', company, ts.map(sticker)) ? null : { tone: 'bad', text: Platform.OS === 'web' ? 'The browser blocked the print window: allow pop-ups for this site.' : 'Print stickers from the office computer.' });
  const late = tools.filter(t => t.out?.overdue).length;

  return (
    <>
      <Heading>Tool store</Heading>
      <Body quiet>The stockroom's own tools and step ladders. Book one out to a person for a job (they sign for it here) and sign it back in when the job is done.</Body>
      <Card>
        <Label>Scan a sticker, or type its code or serial number</Label>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput value={code} onChangeText={setCode} onSubmitEditing={() => find(code)} placeholder="T-… or serial number" placeholderTextColor={C.quiet}
            autoCapitalize="characters" style={[st.input, { flex: 1, minWidth: 0 }]} accessibilityLabel="Tool code" returnKeyType="search" />
          <Button label="Find" onPress={() => find(code)} style={{ width: 90 }} />
        </View>
        <Button label={camera ? 'Close the camera' : 'Scan with the camera'} kind="secondary" onPress={() => setCamera(!camera)} />
        {Platform.OS === 'web' ? <Text style={st.small}>On a computer, a handheld scanner types the code here by itself.</Text> : null}
        {camera ? <CodeScanner onCode={c => { setCamera(false); find(c); }} height={240} hint="Hold the tool's sticker inside the box" /> : null}
      </Card>
      {msg ? <Notice tone={msg.tone} title={msg.text} /> : null}
      {err ? <Notice tone="bad" title="Could not load" lines={[err]} /> : null}
      {d ? <Text style={st.small}>{tools.filter(t => t.active).length} tools · {tools.filter(t => t.out).length} out{late ? ` · ${late} late` : ''}</Text> : <Body quiet>Loading…</Body>}
      <Choice options={FILTERS} value={f} onChange={setF} labels={{ all: 'All', out: 'Out', late: `Late${late ? ` (${late})` : ''}`, in: 'In the stockroom', ladder: 'Ladders' }} />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Button label="Add a tool or ladder" kind="secondary" onPress={() => setAdding(!adding)} style={{ flexGrow: 1 }} />
        {tools.length ? <Button label="Print all stickers" kind="quiet" onPress={() => print(tools.filter(t => t.active))} style={{ flexGrow: 1 }} /> : null}
      </View>
      {adding ? <AddTool done={(t, text) => { setAdding(false); if (t) { setOpen(t.id); setMsg({ tone: 'good', text }); } load(); }} /> : null}
      {list.map(t => (
        <Card key={t.id} style={open === t.id ? { borderColor: C.accent, borderWidth: 2 } : t.out?.overdue ? { borderColor: C.bad } : undefined}>
          <Pressable onPress={() => setOpen(open === t.id ? null : t.id)} accessibilityRole="button" accessibilityLabel={`Tool ${t.name}`} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Thumb photoId={t.photo_id} label={t.name} size={40} />
              <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{t.name}</Text>
              <Pill text={KIND[t.kind]} tone="quiet" />
              {t.condition !== 'good' ? <Pill text={t.condition === 'lost' ? 'Lost' : 'Damaged'} tone="bad" /> : null}
              {!t.active ? <Pill text="Retired" tone="quiet" /> : t.out ? <Pill text={t.out.overdue ? 'Late' : 'Out'} tone={t.out.overdue ? 'bad' : 'warn'} /> : <Pill text="In" tone="good" />}
            </View>
            <Text style={st.small}>{t.serial ? `S/N ${t.serial} · ` : ''}{t.barcode}</Text>
            {t.out ? <Text style={[st.small, { color: t.out.overdue ? C.bad : C.text }]}>With {t.out.userName}{t.out.jobNumber ? ` · job ${t.out.jobNumber}${t.out.jobStatus === 'closed' ? ' (done)' : ''}` : ''} · since {when(t.out.outAt)}{t.out.outByStandIn ? ` · booked out by ${t.out.outBy} (${t.out.outByStandIn}, standing in)` : ''} · due back {t.out.due}{t.out.overdue ? ' · LATE' : ''}</Text> : null}
          </Pressable>
          {open === t.id && d ? <ToolPanel t={t} d={d} print={() => print([t])} changed={(tone, text) => { setMsg({ tone, text }); load(); }} /> : null}
        </Card>
      ))}
      {d && !list.length ? <Body quiet>Nothing here.</Body> : null}
    </>
  );
}

/** One tool: its sticker, book out or sign back, its history, and editing. */
function ToolPanel({ t, d, print, changed }: { t: StoreTool; d: Data; print: () => void; changed: (tone: 'good' | 'bad', text: string) => void }) {
  const s = useStore();
  const [hist, setHist] = useState<Hist[] | null>(null);
  const [panel, setPanel] = useState<'none' | 'edit'>('none');
  useEffect(() => { s.ask({ method: 'GET', path: `/tool-store/${t.id}/history` }).then(r => r?.status === 200 && setHist(r.body)); }, [t.id, t.out?.bookingId]);
  const put = async (body: object, ok: string) => {
    const r = await s.ask({ method: 'PUT', path: `/tool-store/${t.id}`, json: body });
    if (r && r.status < 300) { setPanel('none'); changed('good', ok); } else changed('bad', reasons(r));
  };
  return (
    <View style={{ gap: 10, marginTop: 6 }}>
      <ItemPicture photoId={t.photo_id} kind="tool" label={t.name} canEdit save={async pid => { const r = await s.ask({ method: 'PUT', path: `/tool-store/${t.id}`, json: { photoId: pid } }); if (r && r.status < 300) { changed('good', `Picture of ${t.name} saved.`); return null; } return reasons(r); }} />
      <Barcode value={t.barcode} size={120} />
      {t.notes ? <Text style={st.small}>{t.notes}</Text> : null}
      {t.active && t.condition !== 'lost' ? (t.out ? <SignBack t={t} changed={changed} /> : <BookOut t={t} d={d} changed={changed} />) : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Button label="Print sticker" kind="secondary" onPress={print} style={{ flexGrow: 1 }} />
        <Button label="Edit" kind="quiet" onPress={() => setPanel(panel === 'edit' ? 'none' : 'edit')} style={{ flexGrow: 1 }} />
      </View>
      {panel === 'edit' ? <EditTool t={t} save={put} /> : null}
      <Label>History</Label>
      {!hist ? <Body quiet>Loading…</Body> : !hist.length ? <Body quiet>Never booked out yet.</Body> : hist.slice(0, 12).map(h => (
        <View key={h.id} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingTop: 6 }}>
          <Text style={st.body}>{h.user_name}{h.job_number ? ` · job ${h.job_number}` : ''}</Text>
          <Text style={st.small}>Out {when(h.out_at)} (by {h.out_by}{h.out_by_stand_in ? `, ${h.out_by_stand_in}, standing in` : ''}){h.returned_at ? ` · back ${when(h.returned_at)} (${h.returned_by}${h.returned_by_stand_in ? `, ${h.returned_by_stand_in}, standing in` : ''}) · ${h.return_condition}${h.return_note ? `: ${h.return_note}` : ''}` : ' · still out'}</Text>
        </View>
      ))}
    </View>
  );
}

async function signatureUpload(s: ReturnType<typeof useStore>, pad: SignaturePadHandle | null): Promise<string | null> {
  if (!pad?.signed()) return null;
  const uri = await pad.capture();
  const id = s.newId();
  const r = await s.ask({ method: 'POST', path: '/photos', upload: { fields: { kind: 'tool_signature', takenAt: nowIso(), id }, fileUri: uri, mime: 'image/png' } });
  return r && r.status < 300 ? id : null;
}

function BookOut({ t, d, changed }: { t: StoreTool; d: Data; changed: (tone: 'good' | 'bad', text: string) => void }) {
  const s = useStore();
  const [who, setWho] = useState('');
  const [job, setJob] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pad = useRef<SignaturePadHandle>(null);
  const jobs = useMemo(() => d.jobs.filter(j => j.people.includes(who)), [who, d.jobs]);
  const name = d.people.find(p => p.id === who)?.full_name ?? '';
  useEffect(() => { setJob(jobs.length === 1 ? jobs[0].id : ''); }, [who]);
  const go = async () => {
    if (!who) { setErr('Who is taking it?'); return; }
    if (!pad.current?.signed()) { setErr(`${name.split(' ')[0]} signs for it first.`); return; }
    setBusy(true); setErr(null);
    const sig = await signatureUpload(s, pad.current);
    if (!sig) { setBusy(false); setErr('The signature could not be sent: needs signal.'); return; }
    const r = await s.ask({ method: 'POST', path: `/tool-store/${t.id}/book-out`, json: { userId: who, ...(job ? { jobId: job } : {}), signaturePhotoId: sig, ...(note.trim() ? { note: note.trim() } : {}) } });
    setBusy(false);
    if (r && r.status < 300) changed('good', `${t.name} booked out to ${name}${job ? ` for job ${d.jobs.find(j => j.id === job)?.job_number}` : ''}.`);
    else setErr(reasons(r));
  };
  return (
    <View style={{ gap: 8, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 10 }}>
      <Text style={[st.body, { fontWeight: '800' }]}>Book out</Text>
      <Select label="To" value={who} onChange={setWho} options={[{ value: '', label: 'Choose a person…' }, ...d.people.map(p => ({ value: p.id, label: p.full_name }))]} />
      {who ? (
        <Select label="For the job" value={job} onChange={setJob} options={[{ value: '', label: jobs.length ? 'No job (back the same day)' : 'No open jobs: back the same day' }, ...jobs.map(j => ({ value: j.id, label: `#${j.job_number} · ${j.store}` }))]} />
      ) : null}
      <Field label="Note (optional)" value={note} onChangeText={setNote} placeholder="e.g. with the extension bar" />
      {who ? <><Label>{name} signs for it</Label><SignaturePad ref={pad} hint={`${name.split(' ')[0]} signs here`} height={150} /></> : null}
      {err ? <Notice tone="bad" title={err} /> : null}
      <Button label="Book out" onPress={go} busy={busy} disabled={!who} />
    </View>
  );
}

function SignBack({ t, changed }: { t: StoreTool; changed: (tone: 'good' | 'bad', text: string) => void }) {
  const s = useStore();
  const [cond, setCond] = useState<'good' | 'damaged' | 'lost'>('good');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pad = useRef<SignaturePadHandle>(null);
  const who = t.out!.userName;
  const go = async () => {
    if (cond !== 'good' && note.trim().length < 5) { setErr(`Say what happened (${cond}).`); return; }
    if (!pad.current?.signed()) { setErr('The signature first.'); return; }
    setBusy(true); setErr(null);
    const sig = await signatureUpload(s, pad.current);
    if (!sig) { setBusy(false); setErr('The signature could not be sent: needs signal.'); return; }
    const r = await s.ask({ method: 'POST', path: `/tool-store/${t.id}/return`, json: { condition: cond, signaturePhotoId: sig, ...(note.trim() ? { note: note.trim() } : {}) } });
    setBusy(false);
    if (r && r.status < 300) changed('good', `${t.name} signed back in from ${who}${cond !== 'good' ? ` (${cond})` : ''}.`);
    else setErr(reasons(r));
  };
  return (
    <View style={{ gap: 8, borderWidth: 1, borderColor: t.out?.overdue ? C.bad : C.line, borderRadius: 8, padding: 10 }}>
      <Text style={[st.body, { fontWeight: '800' }]}>Sign back in from {who}</Text>
      <Label>Condition</Label>
      <Choice options={['good', 'damaged', 'lost'] as const} value={cond} onChange={setCond} labels={{ good: 'Good', damaged: 'Damaged', lost: 'Lost' }} />
      {cond !== 'good' ? <Field label="What happened?" value={note} onChangeText={setNote} multiline /> : <Field label="Note (optional)" value={note} onChangeText={setNote} />}
      <Label>{who} signs it back</Label>
      <SignaturePad ref={pad} hint={`${who.split(' ')[0]} signs here`} height={150} />
      {err ? <Notice tone="bad" title={err} /> : null}
      <Button label="Signed back in" onPress={go} busy={busy} />
    </View>
  );
}

function AddTool({ done }: { done: (t: StoreTool | null, text: string) => void }) {
  const s = useStore();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<StoreTool['kind']>('tool');
  const [serial, setSerial] = useState('');
  const [sticker, setSticker] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (name.trim().length < 2) { setErr('What it is, e.g. "Step ladder 2.4 m".'); return; }
    const r = await s.ask({ method: 'POST', path: '/tool-store', json: { name: name.trim(), kind, ...(serial.trim() ? { serial: serial.trim() } : {}), ...(sticker.trim() ? { barcode: sticker.trim() } : {}) } });
    if (r && r.status < 300) done(r.body, `${r.body.name} added with code ${r.body.barcode}: print its sticker.`); else setErr(reasons(r));
  };
  return (
    <Card>
      <Field label="What it is" value={name} onChangeText={setName} placeholder="e.g. Step ladder 2.4 m, Core drill, Vacuum pump" />
      <Choice options={['tool', 'ladder', 'equipment'] as const} value={kind} onChange={setKind} labels={KIND} />
      <Field label="Serial number" value={serial} onChangeText={setSerial} autoCapitalize="characters" placeholder="From its plate, or your own asset number" />
      <Field label="Code of a sticker already on it (optional)" value={sticker} onChangeText={t => setSticker(t.toUpperCase())} autoCapitalize="characters" hint="Leave empty: the app makes a code and you print the sticker." />
      {err ? <Notice tone="bad" title={err} /> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Cancel" kind="quiet" onPress={() => done(null, '')} style={{ flex: 1 }} />
        <Button label="Add" onPress={save} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

function EditTool({ t, save }: { t: StoreTool; save: (body: object, ok: string) => void }) {
  const [name, setName] = useState(t.name);
  const [serial, setSerial] = useState(t.serial ?? '');
  const [notes, setNotes] = useState(t.notes ?? '');
  return (
    <View style={{ gap: 8 }}>
      <Field label="What it is" value={name} onChangeText={setName} />
      <Field label="Serial number" value={serial} onChangeText={setSerial} autoCapitalize="characters" />
      <Field label="Notes" value={notes} onChangeText={setNotes} multiline />
      <Button label="Save" onPress={() => save({ name: name.trim(), serial: serial.trim(), notes: notes.trim() }, `${name.trim()} saved.`)} />
      {t.condition === 'damaged' ? <Button label="Repaired: mark it good" kind="secondary" onPress={() => save({ condition: 'good' }, `${t.name} is back in use.`)} /> : null}
      <Button label="New sticker code (the old sticker stops working)" kind="quiet" onPress={() => save({ newBarcode: true }, `${t.name} has a new code: print its sticker.`)} />
      {!t.out ? <Button label={t.active ? 'Retire (no longer in the tool store)' : 'Put back in the tool store'} kind="quiet" onPress={() => save({ active: !t.active }, t.active ? `${t.name} retired.` : `${t.name} is back in the tool store.`)} /> : null}
    </View>
  );
}
