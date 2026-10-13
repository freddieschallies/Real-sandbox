// Workshop repairs on the technician's phone: uplifting a machine to the workshop (photos, why, the
// store manager's signature), starting a visit in the workshop, leaving and collecting a loan machine,
// and handing the repaired machine back (on site, or collected by the client at the workshop).
// Photos and signatures are queued like every other job card action, so it all works without signal.
import React, { useEffect, useRef, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { SignaturePad, type SignaturePadHandle } from '../SignaturePad.tsx';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso, positionNow, takePhoto } from '../device.ts';
import { rememberPhoto, usePhotoUri } from '../photo.ts';
import { J, toCore } from '../local.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Screen, Toggle, st } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';
import { C } from '../theme.ts';
import type { CardView, LoanMachine, MachineMove } from '../types.ts';

type Shot = { id: string; uri: string };

/** Photos for one step: taken, shown, and queued for upload with the job. */
function usePhotos(jobId: string, kind: 'uplift' | 'loan' | 'delivery') {
  const s = useStore();
  const [shots, setShots] = useState<Shot[]>([]);
  const add = async () => {
    const p = await takePhoto();
    if (!p) return;
    const id = s.newId();
    rememberPhoto(s, id, p.uri);
    s.queue(`Photo (${kind})`, { method: 'POST', path: '/photos', upload: { fields: { kind, takenAt: nowIso(), id, jobId }, fileUri: p.uri, mime: p.mime } }, jobId);
    setShots(x => [...x, { id, uri: p.uri }]);
  };
  // A photo already queued stays queued (the server ignores ones not used); it just leaves this list.
  const remove = (id: string) => setShots(x => x.filter(y => y.id !== id));
  return { shots, add, remove };
}

function PhotoRow({ p, label, max = 6 }: { p: ReturnType<typeof usePhotos>; label: string; max?: number }) {
  return (
    <>
      {p.shots.map((x, n) => (
        <View key={x.id} style={{ gap: 4 }}>
          <Image source={{ uri: x.uri }} style={{ width: '100%', height: 200, borderRadius: 8, backgroundColor: '#000' }} resizeMode="contain" accessibilityLabel={`${label} ${n + 1}`} />
          <Pressable onPress={() => p.remove(x.id)} accessibilityRole="button" hitSlop={8}><Text style={{ color: C.bad, fontWeight: '700' }}>Remove this photo</Text></Pressable>
        </View>
      ))}
      <Button label={p.shots.length ? 'Add another photo' : 'Take the photo'} kind={p.shots.length ? 'secondary' : 'primary'} disabled={p.shots.length >= max} onPress={p.add} />
    </>
  );
}

/** The company's loan machines (needs signal once to load). */
function useLoanMachines() {
  const s = useStore();
  const [list, setList] = useState<LoanMachine[] | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    s.ask({ method: 'GET', path: '/loan-machines' }).then(r => { if (r?.status === 200) setList(r.body); else setOffline(true); }).catch(() => setOffline(true));
  }, []);
  return { list, offline };
}

/** Signs on the glass and queues the picture; returns its id, or null when nothing is signed. */
async function saveSignature(s: ReturnType<typeof useStore>, pad: SignaturePadHandle | null, jobId: string, label: string): Promise<string | null> {
  if (!pad?.signed()) return null;
  const uri = await pad.capture();
  const id = s.newId();
  s.queue(label, { method: 'POST', path: '/photos', upload: { fields: { kind: 'signature', takenAt: nowIso(), id, jobId }, fileUri: uri, mime: 'image/png' } }, jobId);
  return id;
}

const move = (m: Partial<MachineMove> & Pick<MachineMove, 'kind'>, by: string): MachineMove => ({
  id: `local-${Date.now()}`, place: 'site', at: nowIso(), note: null, person_name: null, photo_ids: [], signature_photo_id: null,
  loan_machine_id: null, loan_machine: null, loan_serial: null, by_name: by, ...m,
});

// ---- Uplift ------------------------------------------------------------------------------------

const UP_STEPS = ['photos', 'why', 'loan', 'sign'] as const;
type UpStep = typeof UP_STEPS[number];
const UP_TITLE: Record<UpStep, string> = { photos: 'Photos of the machine', why: 'Which machine, and why', loan: 'A loan machine?', sign: 'Store manager signs' };

/** Job → "Uplift to the workshop". */
export function UpliftScreen({ jobId }: { jobId: string }) {
  const s = useStore();
  const nav = useNav();
  const v = s.cache.cards[jobId];
  const photos = usePhotos(jobId, 'uplift');
  const loanPhotos = usePhotos(jobId, 'loan');
  const loans = useLoanMachines();
  const [step, setStep] = useState<UpStep>('photos');
  const [equipmentId, setEquipmentId] = useState<string | undefined>(v?.items.find(i => i.equipmentId)?.equipmentId);
  const [reason, setReason] = useState('');
  const [leaveLoan, setLeaveLoan] = useState<'yes' | 'no'>();
  const [loanId, setLoanId] = useState<string>();
  const [manager, setManager] = useState(v?.visits.at(-1)?.checkedInManager ?? '');
  const [reasons, setReasons] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const pad = useRef<SignaturePadHandle>(null);
  if (!v) return <Screen title="Uplift" onBack={nav.back}><Body quiet>Not found on the phone.</Body></Screen>;
  const i = UP_STEPS.indexOf(step);
  const available = (loans.list ?? []).filter(l => l.active && !l.out);
  const ready: Record<UpStep, boolean> = {
    photos: photos.shots.length > 0,
    why: J.isFullSentence(reason),
    loan: leaveLoan === 'no' || (leaveLoan === 'yes' && !!loanId && loanPhotos.shots.length > 0),
    sign: true,
  };
  const still: Record<UpStep, string> = {
    photos: 'Take a photo of the machine before it is loaded.',
    why: 'Say why it goes to the workshop (a full sentence).',
    loan: !leaveLoan ? 'Say whether you leave a loan machine.' : !loanId ? 'Choose the loan machine.' : 'Take a photo of the loan machine in place.',
    sign: '',
  };
  const me = s.session?.user.name ?? 'You';

  const submit = async () => {
    const missing: string[] = [];
    if (!manager.trim()) missing.push('the store manager who agreed');
    if (!pad.current?.signed()) missing.push("the store manager's signature");
    if (missing.length) { setReasons(missing); return; }
    const up = { at: nowIso(), reason: reason.trim(), managerName: manager.trim(), photos: photos.shots.length, signed: true };
    // Check the rules first, so a refusal leaves nothing behind.
    let pre = toCore(v);
    if (leaveLoan === 'yes') {
      const lo = J.loanOut(pre, { photos: loanPhotos.shots.length, managerName: manager, signed: true });
      if (!lo.ok) { setReasons(lo.reasons); return; }
      pre = lo.card;
    }
    const check = J.uplift(pre, up);
    if (!check.ok) { setReasons(check.reasons); return; }
    setBusy(true);
    try {
      const sig = await saveSignature(s, pad.current, jobId, 'Store manager signature (uplift)');
      if (leaveLoan === 'yes' && loanId) {
        const lm = available.find(x => x.id === loanId)!;
        const r = s.jobAction(jobId, `Loan machine left: ${lm.name}`, c => J.loanOut(c, { photos: loanPhotos.shots.length, managerName: manager, signed: true }),
          { method: 'POST', path: `/jobs/${jobId}/loan-out`, json: { at: nowIso(), loanMachineId: loanId, photoIds: loanPhotos.shots.map(x => x.id), managerName: manager.trim(), signaturePhotoId: sig } },
          view => ({ ...view, moves: [...(view.moves ?? []), move({ kind: 'loan_out', loan_machine_id: lm.id, loan_machine: lm.name, loan_serial: lm.serial, person_name: manager.trim(), photo_ids: loanPhotos.shots.map(x => x.id), signature_photo_id: sig }, me)],
            loans_out_list: [...(view.loans_out_list ?? []), { id: lm.id, name: lm.name, serial: lm.serial, since: nowIso() }] }));
        if (!r.ok) { setReasons(r.reasons); return; }
      }
      const r = s.jobAction(jobId, `Uplifted to the workshop from ${v.store}`, c => J.uplift(c, up),
        { method: 'POST', path: `/jobs/${jobId}/uplift`, json: { at: up.at, reason: up.reason, managerName: up.managerName, signaturePhotoId: sig, photoIds: photos.shots.map(x => x.id), ...(equipmentId ? { equipmentId } : {}) } },
        view => ({ ...view, moves: [...(view.moves ?? []), move({ kind: 'uplifted', note: up.reason, person_name: up.managerName, photo_ids: photos.shots.map(x => x.id), signature_photo_id: sig }, me)] }));
      if (!r.ok) { setReasons(r.reasons); return; }
      nav.back();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Uplift to the workshop" sub={`#${v.job_number} · ${v.store}`} onBack={() => (i > 0 ? setStep(UP_STEPS[i - 1]) : nav.back())} right={<SyncPill />}>
      <View style={{ flexDirection: 'row', gap: 4 }} accessibilityLabel={`Step ${i + 1} of ${UP_STEPS.length}`}>
        {UP_STEPS.map((x, n) => <View key={x} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: n <= i ? C.accent : C.line }} />)}
      </View>
      <Label>Step {i + 1} of {UP_STEPS.length}</Label>
      <Heading>{UP_TITLE[step]}</Heading>

      {step === 'photos' ? (
        <>
          <Body quiet>The machine as it is before you load it: all sides, and any damage. This protects you and the client.</Body>
          <PhotoRow p={photos} label="Machine before uplift" />
        </>
      ) : null}
      {step === 'why' ? (
        <>
          {v.equipment.length ? (
            <>
              <Label>Which machine</Label>
              <Choice options={v.equipment.map(e => e.id)} value={equipmentId} onChange={setEquipmentId} labels={Object.fromEntries(v.equipment.map(e => [e.id, `${e.description}${e.serial ? ` · ${e.serial}` : ''}`]))} />
            </>
          ) : null}
          <Field label="Why does it go to the workshop?" value={reason} onChangeText={setReason} multiline placeholder="e.g. Compressor bearings worn, needs to be stripped on the bench" hint="A full sentence. The client and the office see this." />
        </>
      ) : null}
      {step === 'loan' ? (
        <>
          <Body quiet>Leave one of our loan machines so the store can carry on while theirs is in the workshop.</Body>
          <Choice options={['yes', 'no'] as const} value={leaveLoan} onChange={setLeaveLoan} labels={{ yes: 'Yes, leave a loan machine', no: 'No loan machine' }} />
          {leaveLoan === 'yes' ? (
            <>
              {loans.offline ? <Notice tone="warn" title="The loan machine list needs signal" lines={['Try again with signal, or leave it now and add it later from the job card.']} /> : null}
              {loans.list && !available.length ? <Notice tone="warn" title="No loan machines free" lines={['All are out, or the office has not added any yet.']} /> : null}
              {available.length ? <Choice options={available.map(l => l.id)} value={loanId} onChange={setLoanId} labels={Object.fromEntries(available.map(l => [l.id, `${l.name}${l.serial ? ` · ${l.serial}` : ''}`]))} /> : null}
              {loanId ? <><Label>The loan machine in place</Label><PhotoRow p={loanPhotos} label="Loan machine" max={4} /></> : null}
            </>
          ) : null}
        </>
      ) : null}
      {step === 'sign' ? (
        <>
          <Card>
            <Label>The store manager signs for</Label>
            <Body>The machine{equipmentId ? `: ${v.equipment.find(e => e.id === equipmentId)?.description ?? ''}` : ''} goes to our workshop. {reason.trim()}</Body>
            {leaveLoan === 'yes' && loanId ? <Body>Loan machine left: {available.find(x => x.id === loanId)?.name}. It comes back when theirs is delivered.</Body> : null}
          </Card>
          <Field label="Store manager's name" value={manager} onChangeText={setManager} autoCapitalize="words" />
          {v.storeManagers.length ? <Choice options={v.storeManagers} value={manager} onChange={setManager} labels={Object.fromEntries(v.storeManagers.map(m => [m, m]))} /> : null}
          <Label>Signature</Label>
          <SignaturePad ref={pad} hint="Store manager signs here" height={200} />
        </>
      ) : null}

      {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}
      {step !== 'sign' ? (
        <>
          {!ready[step] ? <Text style={st.small}>{still[step]}</Text> : null}
          <Button label="Next" disabled={!ready[step]} onPress={() => { setReasons(null); setStep(UP_STEPS[i + 1]); }} />
        </>
      ) : <Button label="Uplift – machine goes to the workshop" onPress={submit} busy={busy} />}
    </Screen>
  );
}

// ---- Loan machines on their own ----------------------------------------------------------------

/** Job → "Leave a loan machine" or "Collect the loan machine". */
export function LoanScreen({ jobId, mode }: { jobId: string; mode: 'out' | 'back' }) {
  const s = useStore();
  const nav = useNav();
  const v = s.cache.cards[jobId];
  const photos = usePhotos(jobId, 'loan');
  const loans = useLoanMachines();
  const [loanId, setLoanId] = useState<string | undefined>(mode === 'back' ? v?.loans_out_list?.[0]?.id : undefined);
  const [manager, setManager] = useState(v?.visits.at(-1)?.checkedInManager ?? '');
  const [note, setNote] = useState('');
  const [reasons, setReasons] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const pad = useRef<SignaturePadHandle>(null);
  if (!v) return <Screen title="Loan machine" onBack={nav.back}><Body quiet>Not found on the phone.</Body></Screen>;
  const choices = mode === 'out' ? (loans.list ?? []).filter(l => l.active && !l.out).map(l => ({ id: l.id, name: l.name, serial: l.serial })) : (v.loans_out_list ?? []);
  const me = s.session?.user.name ?? 'You';

  const submit = async () => {
    const lm = choices.find(x => x.id === loanId);
    if (!lm) { setReasons(['choose the loan machine']); return; }
    if (mode === 'back') {
      const r = s.jobAction(jobId, `Loan machine collected: ${lm.name}`, c => J.loanBack(c, { photos: photos.shots.length }),
        { method: 'POST', path: `/jobs/${jobId}/loan-back`, json: { at: nowIso(), loanMachineId: lm.id, photoIds: photos.shots.map(x => x.id), ...(note.trim() ? { note: note.trim() } : {}) } },
        view => ({ ...view, moves: [...(view.moves ?? []), move({ kind: 'loan_back', loan_machine_id: lm.id, loan_machine: lm.name, loan_serial: lm.serial, note: note.trim() || null, photo_ids: photos.shots.map(x => x.id) }, me)],
          loans_out_list: (view.loans_out_list ?? []).filter(x => x.id !== lm.id) }));
      if (!r.ok) { setReasons(r.reasons); return; }
      nav.back();
      return;
    }
    const pre = J.loanOut(toCore(v), { photos: photos.shots.length, managerName: manager, signed: !!pad.current?.signed() });
    if (!pre.ok) { setReasons(pre.reasons); return; }
    setBusy(true);
    try {
      const sig = await saveSignature(s, pad.current, jobId, 'Store manager signature (loan machine)');
      const r = s.jobAction(jobId, `Loan machine left: ${lm.name}`, c => J.loanOut(c, { photos: photos.shots.length, managerName: manager, signed: true }),
        { method: 'POST', path: `/jobs/${jobId}/loan-out`, json: { at: nowIso(), loanMachineId: lm.id, photoIds: photos.shots.map(x => x.id), managerName: manager.trim(), signaturePhotoId: sig } },
        view => ({ ...view, moves: [...(view.moves ?? []), move({ kind: 'loan_out', loan_machine_id: lm.id, loan_machine: lm.name, loan_serial: lm.serial, person_name: manager.trim(), photo_ids: photos.shots.map(x => x.id), signature_photo_id: sig }, me)],
          loans_out_list: [...(view.loans_out_list ?? []), { id: lm.id, name: lm.name, serial: lm.serial, since: nowIso() }] }));
      if (!r.ok) { setReasons(r.reasons); return; }
      nav.back();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={mode === 'out' ? 'Leave a loan machine' : 'Collect the loan machine'} sub={`#${v.job_number} · ${v.store}`} onBack={nav.back} right={<SyncPill />}>
      {mode === 'out' && loans.offline ? <Notice tone="warn" title="The loan machine list needs signal" /> : null}
      {mode === 'out' && loans.list && !choices.length ? <Notice tone="warn" title="No loan machines free" lines={['All are out, or the office has not added any yet.']} /> : null}
      <Label>Which loan machine</Label>
      {choices.length ? <Choice options={choices.map(l => l.id)} value={loanId} onChange={setLoanId} labels={Object.fromEntries(choices.map(l => [l.id, `${l.name}${l.serial ? ` · ${l.serial}` : ''}`]))} /> : null}
      <Label>{mode === 'out' ? 'The loan machine in place' : 'The loan machine as you collect it'}</Label>
      <PhotoRow p={photos} label="Loan machine" max={4} />
      {mode === 'out' ? (
        <>
          <Field label="Store manager's name" value={manager} onChangeText={setManager} autoCapitalize="words" />
          <Label>Signature</Label>
          <SignaturePad ref={pad} hint="Store manager signs for the loan machine" height={180} />
        </>
      ) : <Field label="Its condition (optional)" value={note} onChangeText={setNote} multiline placeholder="e.g. Working, clean, no damage" />}
      {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}
      <Button label={mode === 'out' ? 'Leave the loan machine' : 'Collected'} onPress={submit} busy={busy} />
    </Screen>
  );
}

// ---- Delivery back -----------------------------------------------------------------------------

/** Job → "Deliver the machine back" (on site) or "The client collects it here" (in the workshop). */
export function DeliverScreen({ jobId }: { jobId: string }) {
  const s = useStore();
  const nav = useNav();
  const v = s.cache.cards[jobId];
  const photos = usePhotos(jobId, 'delivery');
  const atWorkshop = v?.visits.at(-1)?.place === 'workshop';
  const [who, setWho] = useState(atWorkshop ? '' : v?.visits.at(-1)?.checkedInManager ?? '');
  const [note, setNote] = useState('');
  const [reasons, setReasons] = useState<string[] | null>(null);
  if (!v) return <Screen title="Delivery" onBack={nav.back}><Body quiet>Not found on the phone.</Body></Screen>;
  const me = s.session?.user.name ?? 'You';
  const submit = () => {
    const r = s.jobAction(jobId, atWorkshop ? 'Collected by the client at the workshop' : `Machine delivered back to ${v.store}`, c => J.deliver(c, { photos: photos.shots.length, receivedBy: who }),
      { method: 'POST', path: `/jobs/${jobId}/deliver`, json: { at: nowIso(), photoIds: photos.shots.map(x => x.id), receivedBy: who.trim(), ...(note.trim() ? { note: note.trim() } : {}) } },
      view => ({ ...view, moves: [...(view.moves ?? []), move({ kind: 'delivered', place: atWorkshop ? 'workshop' : 'site', person_name: who.trim(), note: note.trim() || null, photo_ids: photos.shots.map(x => x.id) }, me)] }));
    if (!r.ok) { setReasons(r.reasons); return; }
    nav.back();
  };
  return (
    <Screen title={atWorkshop ? 'Collected at the workshop' : 'Deliver the machine back'} sub={`#${v.job_number} · ${v.store}`} onBack={nav.back} right={<SyncPill />}>
      <Body quiet>{atWorkshop ? 'The client fetches the repaired machine here. A photo of it as it goes, and who took it.' : 'The repaired machine back in place: a photo of it installed, and who received it. Then test it and finish the job card as usual.'}</Body>
      <PhotoRow p={photos} label={atWorkshop ? 'Machine collected' : 'Machine back in place'} max={4} />
      <Field label={atWorkshop ? 'Who collected it?' : 'Who received it?'} value={who} onChangeText={setWho} autoCapitalize="words" />
      {!atWorkshop && v.storeManagers.length ? <Choice options={v.storeManagers} value={who} onChange={setWho} labels={Object.fromEntries(v.storeManagers.map(m => [m, m]))} /> : null}
      <Field label="Note (optional)" value={note} onChangeText={setNote} multiline />
      {(v.loans_out ?? 0) > 0 && !atWorkshop ? <Notice tone="warn" title="Collect the loan machine too" lines={(v.loans_out_list ?? []).map(l => l.name)} /> : null}
      {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}
      <Button label={atWorkshop ? 'Collected' : 'Delivered back'} onPress={submit} />
    </Screen>
  );
}

// ---- On the job card ---------------------------------------------------------------------------

/** Start a visit in the workshop: two safety ticks, checked against the workshop's location. */
export function WorkshopStartForm({ v, onRefused }: { v: CardView; onRefused: (r: string[] | null) => void }) {
  const s = useStore();
  const [areaSafe, setAreaSafe] = useState(false);
  const [isolated, setIsolated] = useState(false);
  const [outside, setOutside] = useState(false);
  const [outsideReason, setOutsideReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!v.workshop) return <Notice tone="warn" title="The workshop is not set yet" lines={['The office sets where the workshop is (Settings, Workshop).']} />;
  const submit = async () => {
    setBusy(true);
    // The demo pretends you are standing in the workshop.
    const position = s.session?.mode === 'demo' ? { lat: v.workshop!.lat, lng: v.workshop!.lng } : await positionNow();
    setBusy(false);
    const input = { at: nowIso(), safety: { areaSafe, isolated }, outsideReason: outsideReason || undefined };
    const r = s.jobAction(v.id, `Started in the workshop`, c => J.startAtWorkshop(c, { ...input, position: position ?? undefined }),
      { method: 'POST', path: `/jobs/${v.id}/workshop-start`, json: { ...input, position: position ?? undefined } });
    if (r.ok) { onRefused(null); return; }
    if (r.reasons.some(x => x.startsWith('you are not at the workshop'))) setOutside(true);
    onRefused(r.reasons);
  };
  return (
    <Card>
      <Heading>In the workshop</Heading>
      <Body quiet>{v.workshop.name}{v.workshop.address ? ` · ${v.workshop.address}` : ''}</Body>
      <Label>Safety</Label>
      <Toggle label="Work area is safe" value={areaSafe} onChange={setAreaSafe} />
      <Toggle label="Power / gas / water isolated where needed" value={isolated} onChange={setIsolated} />
      {outside ? <Field label="You are not at the workshop. Why?" value={outsideReason} onChangeText={setOutsideReason} multiline hint="Your supervisor sees this." /> : null}
      <Button label="Start at the workshop" onPress={submit} busy={busy} />
    </Card>
  );
}

const MOVE_LABEL: Record<MachineMove['kind'], string> = { uplifted: 'Uplifted to the workshop', delivered: 'Delivered back', loan_out: 'Loan machine left', loan_back: 'Loan machine collected' };
const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function MoveThumb({ id }: { id: string }) {
  const uri = usePhotoUri(id);
  return uri ? <Image source={{ uri }} style={{ width: 72, height: 72, borderRadius: 6, backgroundColor: '#000' }} accessibilityLabel="Photo" /> : <View style={{ width: 72, height: 72, borderRadius: 6, backgroundColor: C.line }} />;
}

/** Where the machine is and its moves, for the technician and the office. */
export function MachineMoves({ v }: { v: CardView }) {
  const moves = v.moves ?? [];
  const at = v.machine_at;
  if (!moves.length && at !== 'workshop') return null;
  return (
    <Card>
      <Label>The machine</Label>
      <Text style={[st.body, { fontWeight: '700', color: at === 'workshop' ? C.warn : C.text }]}>
        {at === 'workshop' ? (v.ready_to_deliver ? 'Repaired: in the workshop, ready to go back' : 'In the workshop') : moves.some(m => m.kind === 'delivered') ? 'Back with the client' : 'On site'}
      </Text>
      {(v.loans_out_list ?? []).map(l => <Text key={l.id} style={[st.small, { color: C.warn }]}>Loan machine at the client: {l.name}{l.serial ? ` · ${l.serial}` : ''}</Text>)}
      {moves.map(m => (
        <View key={m.id} style={{ gap: 4, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8 }}>
          <Text style={[st.body, { fontWeight: '700' }]}>{MOVE_LABEL[m.kind]}{m.loan_machine ? `: ${m.loan_machine}` : ''}{m.kind === 'delivered' && m.place === 'workshop' ? ' (collected at the workshop)' : ''}</Text>
          <Text style={st.small}>{when(m.at)} · {m.by_name}{m.person_name ? ` · ${m.kind === 'delivered' ? 'received by' : 'signed by'} ${m.person_name}` : ''}</Text>
          {m.note ? <Text style={st.small}>{m.note}</Text> : null}
          {m.photo_ids.length || m.signature_photo_id ? (
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {m.photo_ids.map(p => <MoveThumb key={p} id={p} />)}
              {m.signature_photo_id ? <MoveThumb id={m.signature_photo_id} /> : null}
            </View>
          ) : null}
        </View>
      ))}
    </Card>
  );
}
