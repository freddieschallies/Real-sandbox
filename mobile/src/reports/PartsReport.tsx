// The parts report. When a technician cannot finish because a part is needed and another quote is
// needed, he goes through these steps before he leaves site, each one done before the next opens:
// the whole machine or site, the serial tag (typed too if it is hard to read), the part needed, and
// more photos if he thinks they help. It becomes a draft quote for the office, and the report can be
// printed or emailed to the client on the company's letterhead.
import React, { useEffect, useMemo, useState } from 'react';
import { Image, Platform, Pressable, Text, View } from 'react-native';
import { useNav } from '../nav.tsx';
import { useStore } from '../state.tsx';
import { nowIso, takePhoto } from '../device.ts';
import { rememberPhoto, usePhotoUri } from '../photo.ts';
import { Body, Button, Card, Field, Heading, Label, Notice, Screen, Stepper, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { currentLogo } from '../brand.tsx';
import { letterheadBottom, letterheadTop, useLetterhead } from '../letterhead.tsx';

type Shot = { id: string; uri: string };
type Step = 'machine' | 'serial' | 'part' | 'extra' | 'review';
const STEPS: { key: Step; title: string; help: string }[] = [
  { key: 'machine', title: 'The whole machine or site', help: 'Step back and take the whole machine (or the area) so the office and the client see what it is and where.' },
  { key: 'serial', title: 'The serial tag', help: 'A clear photo of the rating plate or serial tag. If it is faded or hard to read, type the serial number too.' },
  { key: 'part', title: 'The part needed', help: 'A photo of the part that has failed (or where it goes), and what the part is.' },
  { key: 'extra', title: 'More photos (if they help)', help: 'Anything else the office or the client should see. You can skip this.' },
  { key: 'review', title: 'Check and send', help: 'This goes to the office as a quote to price and send to the client.' },
];
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['Needs signal: the photos and the report go when you have signal.'];

function Thumb({ uri, label }: { uri: string; label: string }) {
  return <Image source={{ uri }} style={{ width: '100%', height: 220, borderRadius: 8, backgroundColor: '#000' }} resizeMode="contain" accessibilityLabel={label} />;
}

/** Job → Continue later → "Make the parts report". */
export function PartsReportScreen({ jobId }: { jobId: string }) {
  const s = useStore();
  const nav = useNav();
  const v = s.cache.cards[jobId];
  const reportId = useMemo(() => s.newId(), []);
  const [step, setStep] = useState<Step>('machine');
  const [machine, setMachine] = useState<Shot | null>(null);
  const [serial, setSerial] = useState<Shot | null>(null);
  const [serialText, setSerialText] = useState('');
  const [part, setPart] = useState<Shot | null>(null);
  const [partDesc, setPartDesc] = useState('');
  const [qty, setQty] = useState(1);
  const [extras, setExtras] = useState<Shot[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  const i = STEPS.findIndex(x => x.key === step);

  const shoot = async (kind: string): Promise<Shot | null> => {
    setErr(null);
    const p = await takePhoto();
    if (!p) return null;
    const id = s.newId();
    rememberPhoto(s, id, p.uri);
    setBusy(true);
    const up = await s.ask({ method: 'POST', path: '/photos', upload: { fields: { kind, takenAt: nowIso(), id, jobId }, fileUri: p.uri, mime: p.mime } });
    setBusy(false);
    if (!up || up.status >= 300) { setErr(reasons(up)); return null; }
    return { id, uri: p.uri };
  };
  const ready: Record<Step, boolean> = {
    machine: !!machine, serial: !!serial, part: !!part && partDesc.trim().length >= 2 && qty > 0, extra: true, review: true,
  };
  const still: Record<Step, string> = {
    machine: 'Take the photo of the whole machine or site.', serial: 'Take the photo of the serial tag.',
    part: !part ? 'Take the photo of the part.' : 'Say what the part is.', extra: '', review: '',
  };
  const submit = async () => {
    setBusy(true); setErr(null);
    const r = await s.ask({ method: 'POST', path: `/jobs/${jobId}/parts-report`, json: {
      id: reportId, at: nowIso(), machinePhotoId: machine!.id, serialPhotoId: serial!.id, serialText: serialText.trim() || undefined,
      partPhotoId: part!.id, partDescription: partDesc.trim(), partQty: qty, extraPhotoIds: extras.map(x => x.id), notes: notes.trim() || undefined } });
    setBusy(false);
    if (r && r.status < 300) { await s.loadCard(jobId); nav.back(); } else setErr(reasons(r));
  };

  return (
    <Screen title="Parts report" sub={v ? `#${v.job_number} · ${v.store}` : undefined} onBack={() => (i > 0 ? setStep(STEPS[i - 1].key) : nav.back())}>
      <View style={{ flexDirection: 'row', gap: 4 }} accessibilityLabel={`Step ${i + 1} of ${STEPS.length}`}>
        {STEPS.map((x, n) => <View key={x.key} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: n <= i ? C.accent : C.line }} />)}
      </View>
      <Label>Step {i + 1} of {STEPS.length}</Label>
      <Heading>{STEPS[i].title}</Heading>
      <Body quiet>{STEPS[i].help}</Body>

      {step === 'machine' ? (
        <>
          {machine ? <Thumb uri={machine.uri} label="The machine or site" /> : null}
          <Button label={machine ? 'Take it again' : 'Take the photo'} kind={machine ? 'secondary' : 'primary'} busy={busy} onPress={async () => { const x = await shoot('report_machine'); if (x) setMachine(x); }} />
        </>
      ) : null}
      {step === 'serial' ? (
        <>
          {serial ? <Thumb uri={serial.uri} label="The serial tag" /> : null}
          <Button label={serial ? 'Take it again' : 'Take the photo'} kind={serial ? 'secondary' : 'primary'} busy={busy} onPress={async () => { const x = await shoot('report_serial'); if (x) setSerial(x); }} />
          <Field label="Serial number (type it if the tag is hard to read)" value={serialText} onChangeText={setSerialText} autoCapitalize="characters" placeholder="e.g. E11SI2201" />
        </>
      ) : null}
      {step === 'part' ? (
        <>
          {part ? <Thumb uri={part.uri} label="The part needed" /> : null}
          <Button label={part ? 'Take it again' : 'Take the photo'} kind={part ? 'secondary' : 'primary'} busy={busy} onPress={async () => { const x = await shoot('report_part'); if (x) setPart(x); }} />
          <Field label="What part is needed?" value={partDesc} onChangeText={setPartDesc} placeholder="e.g. Heating element 9 kW, Rational part 87.00.534" />
          <Label>How many</Label>
          <Stepper value={qty} onChange={setQty} label="parts needed" />
        </>
      ) : null}
      {step === 'extra' ? (
        <>
          {extras.map((x, n) => (
            <View key={x.id} style={{ gap: 4 }}>
              <Thumb uri={x.uri} label={`Extra photo ${n + 1}`} />
              <Pressable onPress={() => setExtras(e => e.filter(y => y.id !== x.id))} accessibilityRole="button" hitSlop={8}><Text style={{ color: C.bad, fontWeight: '700' }}>Remove this photo</Text></Pressable>
            </View>
          ))}
          <Button label="Add a photo" kind="secondary" busy={busy} disabled={extras.length >= 8} onPress={async () => { const x = await shoot('report_extra'); if (x) setExtras(e => [...e, x]); }} />
          <Field label="What you found (optional)" value={notes} onChangeText={setNotes} multiline placeholder="What is wrong and what it needs" />
        </>
      ) : null}
      {step === 'review' ? (
        <Card>
          <Text style={st.body}>Machine or site: photo ✓</Text>
          <Text style={st.body}>Serial tag: photo ✓{serialText.trim() ? ` · ${serialText.trim()}` : ''}</Text>
          <Text style={st.body}>Part: {partDesc.trim()}{qty !== 1 ? ` ×${qty}` : ''} · photo ✓</Text>
          <Text style={st.body}>More photos: {extras.length}</Text>
          {notes.trim() ? <Text style={st.small}>{notes.trim()}</Text> : null}
        </Card>
      ) : null}

      {err ? <Notice tone="bad" title="Not yet" lines={err} /> : null}
      {step !== 'review' ? (
        <>
          <Button label={step === 'extra' && !extras.length ? 'Skip, no more photos' : 'Next'} disabled={!ready[step] || busy} onPress={() => setStep(STEPS[i + 1].key)} />
          {!ready[step] ? <Text style={st.small}>{still[step]}</Text> : null}
        </>
      ) : <Button label="Send the report to the office" busy={busy} onPress={submit} />}
    </Screen>
  );
}

type Report = {
  id: string; report_number: number; created_at: string; job_number: number; fault_reported: string; store: string; store_address: string | null; store_email: string | null;
  client: string; technician: string; quote_number: number | null; machine_photo_id: string; serial_photo_id: string; serial_text: string | null; part_photo_id: string;
  part_description: string; part_qty: number; extra_photo_ids: string[]; notes: string | null;
};

/** A report: on screen, printed on the letterhead, or emailed. For the office and the technician who made it. */
export function PartsReportView({ id }: { id: string }) {
  const s = useStore();
  const lh = useLetterhead();
  const [d, setD] = useState<{ report: Report; emails: { sent_to: string[]; sent_at: string; ok: boolean; error: string | null; sent_by: string }[]; canEmail: boolean } | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const load = async () => { const r = await s.ask({ method: 'GET', path: `/parts-reports/${id}` }); if (r?.status === 200) { setD(r.body); setTo(t => t || r.body.report.store_email || ''); } else setErr(reasons(r)); };
  useEffect(() => { load(); }, [id]);
  const r = d?.report;
  const machine = usePhotoUri(r?.machine_photo_id), serial = usePhotoUri(r?.serial_photo_id), part = usePhotoUri(r?.part_photo_id);
  const ex = [0, 1, 2, 3, 4, 5, 6, 7].map(n => r?.extra_photo_ids?.[n] ?? null);
  const e0 = usePhotoUri(ex[0]), e1 = usePhotoUri(ex[1]), e2 = usePhotoUri(ex[2]), e3 = usePhotoUri(ex[3]), e4 = usePhotoUri(ex[4]), e5 = usePhotoUri(ex[5]), e6 = usePhotoUri(ex[6]), e7 = usePhotoUri(ex[7]);
  const extras = [e0, e1, e2, e3, e4, e5, e6, e7].filter((u, n) => !!ex[n] && !!u) as string[];
  if (err && !d) return <Notice tone="warn" title="Could not load the report" lines={err} />;
  if (!r) return <Body quiet>Loading…</Body>;
  const when = new Date(r.created_at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const photo = (uri: string | null, label: string, note?: string | null) => (
    <View style={{ gap: 4 }}>
      <Label>{label}</Label>
      {note ? <Text style={st.body}>{note}</Text> : null}
      {uri ? <Image source={{ uri }} style={{ width: '100%', height: 240, borderRadius: 8, backgroundColor: '#000' }} resizeMode="contain" accessibilityLabel={label} /> : <Text style={st.small}>Loading the photo…</Text>}
    </View>
  );
  const print = () => {
    if (Platform.OS !== 'web') return;
    const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const img = (u: string | null, t: string, n?: string | null) => (u ? `<div class=ph><b>${esc(t)}</b>${n ? `<div>${esc(n)}</div>` : ''}<img src="${u}"></div>` : '');
    const plainHead = `<div class=bar></div><div class=head>${currentLogo() ? `<img src="${currentLogo()}" style="height:52px;background:#fff;padding:4px;border-radius:4px;margin-right:12px">` : ''}<h1>${esc(s.session?.company.name)}</h1><div class=t>SITE REPORT</div></div>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Site report ${r.report_number}</title><style>body{font:13px Arial,sans-serif;margin:0;color:#111}.bar{height:8px;background:#E8701A}
.head{background:#111;color:#fff;padding:12px 22px;display:flex;align-items:center}.head h1{margin:0;font-size:20px;flex:1}.head .t{color:#E8701A;font-weight:900}.body{padding:16px 22px}
.ph{margin:12px 0;page-break-inside:avoid}.ph img{display:block;max-width:100%;max-height:420px;border:1px solid #ccc;margin-top:4px}@media print{.noprint{display:none}}</style></head><body>
${letterheadTop(plainHead)}<div class=body><h2 style="margin:0 0 4px">Site report ${r.report_number}</h2>
<div>${esc(r.client)} · ${esc(r.store)}${r.store_address ? `, ${esc(r.store_address)}` : ''}<br>Job ${r.job_number} · ${esc(when)} · Technician: ${esc(r.technician)}${r.quote_number ? ` · Quote ${r.quote_number}` : ''}</div>
<p><b>Fault reported:</b> ${esc(r.fault_reported)}</p>${r.notes ? `<p><b>What we found:</b> ${esc(r.notes)}</p>` : ''}
${img(machine, 'The machine / site')}${img(serial, 'Serial tag', r.serial_text ? `Serial number: ${r.serial_text}` : null)}${img(part, 'Part needed', `${r.part_description}${r.part_qty !== 1 ? ` ×${r.part_qty}` : ''}`)}
${extras.map((u, n) => img(u, `More (${n + 1})`)).join('')}</div>${letterheadBottom('<div class=bar></div>')}
<p class=noprint style="padding:12px 22px"><button onclick="print()">Print / save as PDF</button></p></body></html>`;
    const w = window.open('', '_blank');
    if (!w) { setDone('The browser blocked the print window: allow pop-ups for this site.'); return; }
    w.document.write(html); w.document.close();
  };
  const send = async () => {
    setBusy(true); setDone(null); setErr(null);
    const list = to.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
    const x = await s.ask({ method: 'POST', path: `/parts-reports/${id}/email`, json: { to: list, message: msg.trim() || undefined } });
    setBusy(false);
    if (x && x.status < 300) { setDone(`Emailed to ${list.join(', ')}${(x.body as { demo?: boolean }).demo ? ' (test drive: no email really goes out)' : ''}.`); load(); } else setErr(reasons(x));
  };
  return (
    <View style={{ gap: 12 }}>
      <Heading>Site report {r.report_number}</Heading>
      <Text style={st.small}>{r.client} · {r.store} · job {r.job_number} · {when} · {r.technician}{r.quote_number ? ` · quote ${r.quote_number}` : ''}</Text>
      <Text style={st.body}>Fault: {r.fault_reported}</Text>
      {r.notes ? <Text style={st.body}>Found: {r.notes}</Text> : null}
      {photo(machine, 'The machine / site')}
      {photo(serial, 'Serial tag', r.serial_text ? `Serial number: ${r.serial_text}` : null)}
      {photo(part, 'Part needed', `${r.part_description}${r.part_qty !== 1 ? ` ×${r.part_qty}` : ''}`)}
      {extras.map((u, n) => <View key={n}>{photo(u, `More (${n + 1})`)}</View>)}
      {Platform.OS === 'web' ? <Button label="Print / save as PDF" kind="secondary" onPress={print} /> : null}
      <Card>
        <Label>Email it{lh.header ? ' (on the company letterhead)' : ''}</Label>
        {!d.canEmail ? <Text style={st.small}>Email is not set up on the server yet: print or save it as PDF and attach it, until it is.</Text> : null}
        <Field label="To (separate several with commas)" value={to} onChangeText={setTo} autoCapitalize="none" keyboardType="email-address" placeholder="client@example.co.za" />
        <Field label="Message (optional)" value={msg} onChangeText={setMsg} multiline placeholder="Good day, please see the report on the machine below. The quote for the part follows." />
        <Button label="Email the report" disabled={!d.canEmail || !to.trim()} busy={busy} onPress={send} />
        {d.emails.map((m, n) => <Text key={n} style={st.small}>{m.ok ? 'Sent' : 'Failed'} to {m.sent_to.join(', ')} · {new Date(m.sent_at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {m.sent_by}{m.error ? ` · ${m.error}` : ''}</Text>)}
      </Card>
      {done ? <Notice tone={done.startsWith('The browser') ? 'warn' : 'good'} title={done} /> : null}
      {err ? <Notice tone="bad" title="Not sent" lines={err} /> : null}
    </View>
  );
}

/** The reports on one job, to open (office job card, and the technician's job screen). */
export function JobReports({ jobId, open }: { jobId: string; open: (id: string) => void }) {
  const s = useStore();
  const [list, setList] = useState<{ id: string; report_number: number; created_at: string; part_description: string; quote_number: number | null; created_by: string }[] | null>(null);
  useEffect(() => { s.ask({ method: 'GET', path: `/jobs/${jobId}/parts-reports` }).then(r => { if (r?.status === 200) setList(r.body); }); }, [jobId]);
  if (!list?.length) return null;
  return (
    <Card>
      <Label>Parts reports ({list.length})</Label>
      {list.map(x => (
        <Pressable key={x.id} onPress={() => open(x.id)} accessibilityRole="button" accessibilityLabel={`Report ${x.report_number}`}
          style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.line }}>
          <Text style={[st.body, { fontWeight: '700' }]}>Report {x.report_number}: {x.part_description}</Text>
          <Text style={st.small}>{x.created_by} · {new Date(x.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}{x.quote_number ? ` · quote ${x.quote_number}` : ''}</Text>
        </Pressable>
      ))}
    </Card>
  );
}

/** The technician opens one of his reports (to print or email it too). */
export function ReportScreen({ id }: { id: string }) {
  const nav = useNav();
  return <Screen title="Site report" onBack={nav.back}><PartsReportView id={id} /></Screen>;
}
