// Documents on a job card. The office adds forms and papers for site (e.g. another company's own
// service form); the technician opens them and gets them to the client to print on site: a link on
// WhatsApp, an email with the file attached, or download; then brings back the filled-in form.
import React, { useEffect, useState } from 'react';
import { Linking, Platform, Share, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Field, Heading, Notice, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { chooseFile } from '../office/Stores.tsx';
import { nowIso, pickImage, takePhoto } from '../device.ts';

interface Doc {
  id: string; name: string; kind: 'for_site' | 'filled_in'; contentType: string; bytes: number | null; note: string | null;
  addedBy: string; addedAt: string; canRemove: boolean; sent: { how: 'email' | 'link'; to: string | null; at: string; by: string; ok: boolean }[];
  /** Test drive only: the file itself. */ dataUrl?: string;
}
interface Docs { documents: Doc[]; canAdd: boolean; canEmail: boolean; storeEmail: string | null; linkDays: number; demo?: boolean }

const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp,.txt,application/pdf,image/*';
const when = (iso: string) => new Date(iso).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const typeName = (t: string) => (/pdf/.test(t) ? 'PDF' : /word|msword/.test(t) ? 'Word' : /sheet|excel/.test(t) ? 'Excel' : /image/.test(t) ? 'Picture' : 'File');
const reasons = (r: { status: number; body: any } | null) => (r ? (r.body?.reasons ?? [r.body?.error ?? `The server said ${r.status}`]) : ['No signal: try again when there is signal.']) as string[];

export function JobDocuments({ jobId, tech, closed }: { jobId: string; tech?: boolean; closed?: boolean }) {
  const s = useStore();
  const [d, setD] = useState<Docs | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    const r = await s.ask({ method: 'GET', path: `/jobs/${jobId}/documents` }).catch(() => null);
    if (r?.status === 200) { setD(r.body as Docs); setErr(null); } else if (r) setErr(reasons(r));
  };
  useEffect(() => { load(); }, [jobId]);

  const send = async (fileUri: string, mime: string, name: string, kind: 'for_site' | 'filled_in', title?: string) => {
    setBusy('add'); setErr(null);
    const r = await s.ask({ method: 'POST', path: `/jobs/${jobId}/documents`, upload: { fields: { kind, ...(title ? { name: title } : {}) }, fileUri, mime, name } }).catch(() => null);
    setBusy(null);
    if (r?.status === 201) load(); else setErr(reasons(r));
  };
  const addFile = async (kind: 'for_site' | 'filled_in') => {
    if (Platform.OS === 'web') {
      const f = await chooseFile(ACCEPT);
      const first = d?.documents.find(x => x.kind === 'for_site');
      if (f) await send(URL.createObjectURL(f), f.type || 'application/octet-stream', f.name, kind, kind === 'filled_in' && first ? `${first.name} (filled in)` : undefined);
      return;
    }
    const p = await pickImage('document');
    if (p) await send(p.uri, p.mime, `document-${Date.now()}.jpg`, kind);
  };
  const photoBack = async () => {
    const p = await takePhoto('document');
    if (!p) return;
    const forSite = d?.documents.find(x => x.kind === 'for_site');
    await send(p.uri, p.mime, `filled-in-${Date.now()}.jpg`, 'filled_in', forSite ? `${forSite.name} (filled in)` : `Filled-in form ${nowIso().slice(0, 10)}`);
  };

  if (!d) return err ? <Notice tone="warn" title="Documents need signal" lines={err} /> : null;
  const forSite = d.documents.filter(x => x.kind === 'for_site');
  const back = d.documents.filter(x => x.kind === 'filled_in');
  if (tech && !d.documents.length && closed) return null;
  return (
    <View style={{ gap: 10 }}>
      <Heading>Documents for this job</Heading>
      {!d.documents.length ? <Body quiet>{d.canAdd ? 'None yet. Add a form or paper the technician needs on site, e.g. the client\'s own service form.' : 'None for this job.'}</Body> : null}
      {err ? <Notice tone="bad" title="Could not do that" lines={err} /> : null}
      {forSite.length && tech ? <Text style={st.small}>The client prints these on site: send a link on WhatsApp, email it, or open it to download. Fill it in, have it signed, and bring it back below.</Text> : null}
      {forSite.map(x => <DocCard key={x.id} x={x} d={d} changed={load} />)}
      {back.length ? <Text style={[st.small, { fontWeight: '800', letterSpacing: 0.5 }]}>FILLED IN AND BROUGHT BACK</Text> : null}
      {back.map(x => <DocCard key={x.id} x={x} d={d} changed={load} />)}
      {!closed ? (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {d.canAdd ? <Button label="+ Add a document" kind="secondary" busy={busy === 'add'} onPress={() => addFile('for_site')} style={{ flexGrow: 1 }} /> : null}
          {tech || forSite.length ? <Button label={Platform.OS === 'web' ? 'Add the filled-in form (file)' : 'Photo of the filled-in form'} kind={tech ? 'secondary' : 'quiet'} busy={busy === 'add' && !d.canAdd}
            onPress={() => (Platform.OS === 'web' ? addFile('filled_in') : photoBack())} style={{ flexGrow: 1 }} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function DocCard({ x, d, changed }: { x: Doc; d: Docs; changed: () => void }) {
  const s = useStore();
  const [emailing, setEmailing] = useState(false);
  const [to, setTo] = useState(d.storeEmail ?? '');
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const demo = s.session?.mode === 'demo' || !!d.demo;

  /** The file as something the browser can open (signed-in fetch, never the login in an address). */
  const blobUrl = async (): Promise<string | null> => {
    // (The test drive keeps the file itself; browsers only open it as a file, not as an address.)
    if (x.dataUrl) return URL.createObjectURL(await (await fetch(x.dataUrl)).blob());
    const sess = s.session;
    if (!sess || sess.mode !== 'server') return null;
    const r = await fetch(`${sess.baseUrl.replace(/\/+$/, '')}/job-documents/${x.id}/file`, { headers: { authorization: `Bearer ${sess.token}` } }).catch(() => null);
    if (!r?.ok) return null;
    return URL.createObjectURL(await r.blob());
  };
  const link = async (): Promise<{ url: string; message: string } | null> => {
    const r = await s.ask({ method: 'POST', path: `/job-documents/${x.id}/link` }).catch(() => null);
    if (r?.status !== 200) { setMsg({ tone: 'bad', text: reasons(r).join(' ') }); return null; }
    return r.body as { url: string; message: string };
  };
  const open = async (download: boolean) => {
    setBusy(download ? 'down' : 'open'); setMsg(null);
    if (Platform.OS === 'web') {
      const u = await blobUrl();
      setBusy(null);
      if (!u) { setMsg({ tone: 'bad', text: 'Could not open it: needs signal.' }); return; }
      const a = document.createElement('a');
      a.href = u; a.target = '_blank'; a.rel = 'noopener';
      if (download) a.download = x.name;
      document.body.appendChild(a); a.click(); a.remove();
      return;
    }
    // On a phone the link opens in the browser, which prints, saves or shares it.
    const l = await link();
    setBusy(null);
    if (l) Linking.openURL(l.url).catch(() => setMsg({ tone: 'bad', text: 'Could not open the browser.' }));
  };
  const whatsapp = async () => {
    setBusy('wa'); setMsg(null);
    const l = await link();
    setBusy(null);
    if (!l) return;
    if (demo) { setMsg({ tone: 'info', text: 'Test drive: in the real app WhatsApp opens with a link to this document; the client taps it to open and print it (it works for a week).' }); changed(); return; }
    Linking.openURL(`https://wa.me/?text=${encodeURIComponent(l.message)}`).catch(() => setMsg({ tone: 'bad', text: 'WhatsApp did not open: use Share instead.' }));
    changed();
  };
  const share = async () => {
    setBusy('share'); setMsg(null);
    const l = await link();
    setBusy(null);
    if (!l) return;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) { await navigator.clipboard.writeText(l.message); setMsg({ tone: 'good', text: 'The link is copied: paste it in a message.' }); }
      else await Share.share({ message: l.message });
    } catch { setMsg({ tone: 'bad', text: 'Could not share: try WhatsApp or email.' }); }
    changed();
  };
  const email = async () => {
    const list = to.split(/[,;\s]+/).map(t => t.trim()).filter(Boolean);
    if (!list.length) { setMsg({ tone: 'bad', text: 'Type the email address.' }); return; }
    setBusy('email'); setMsg(null);
    const r = await s.ask({ method: 'POST', path: `/job-documents/${x.id}/email`, json: { to: list } }).catch(() => null);
    setBusy(null);
    if (r?.status === 200) { setMsg({ tone: 'good', text: r.body?.demo ? `Test drive: in the real app it is emailed to ${list.join(', ')} with the document attached.` : `Emailed to ${list.join(', ')} with the document attached.` }); setEmailing(false); changed(); }
    else setMsg({ tone: 'bad', text: reasons(r).join(' ') });
  };
  const remove = async () => {
    const r = await s.ask({ method: 'POST', path: `/job-documents/${x.id}/remove`, json: {} }).catch(() => null);
    if (r?.status === 200) changed(); else setMsg({ tone: 'bad', text: reasons(r).join(' ') });
  };
  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={[st.body, { fontWeight: '800', flex: 1, minWidth: 160 }]}>{x.name}</Text>
        <Pill text={typeName(x.contentType)} tone="quiet" />
        {x.kind === 'filled_in' ? <Pill text="Filled in" tone="good" /> : null}
      </View>
      <Text style={st.small}>Added by {x.addedBy}, {when(x.addedAt)}{x.note ? ` · ${x.note}` : ''}</Text>
      {x.sent.length ? <Text style={st.small}>{x.sent.slice(0, 3).map(t => `${t.how === 'email' ? `Emailed to ${t.to}` : 'Link sent'} by ${t.by}, ${when(t.at)}${t.ok ? '' : ' (failed)'}`).join(' · ')}</Text> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Button label="Open" kind="secondary" busy={busy === 'open'} onPress={() => open(false)} style={{ flexGrow: 1 }} />
        <Button label="WhatsApp" kind="secondary" busy={busy === 'wa'} onPress={whatsapp} style={{ flexGrow: 1 }} />
        <Button label="Email" kind="secondary" onPress={() => { setEmailing(e => !e); setMsg(null); }} style={{ flexGrow: 1 }} />
        {Platform.OS === 'web' ? <Button label="Download" kind="quiet" busy={busy === 'down'} onPress={() => open(true)} style={{ flexGrow: 1 }} />
          : <Button label="Share…" kind="quiet" busy={busy === 'share'} onPress={share} style={{ flexGrow: 1 }} />}
      </View>
      {emailing ? (
        <View style={{ gap: 8 }}>
          <Field label="Email it to (e.g. the store, to print)" value={to} onChangeText={setTo} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholder="manager@store.co.za" />
          {d.canEmail ? <Button label="Send it with the document attached" busy={busy === 'email'} onPress={email} />
            : <Notice tone="warn" title="Email is not set up on the server yet" lines={['Use WhatsApp, or Download and attach it to an email yourself.']} />}
        </View>
      ) : null}
      {msg ? <Text style={[st.small, { color: msg.tone === 'good' ? C.good : msg.tone === 'bad' ? C.bad : C.text }]}>{msg.text}</Text> : null}
      {x.canRemove ? (removing
        ? <View style={{ flexDirection: 'row', gap: 8 }}><Button label="Take it off the job" kind="danger" onPress={remove} style={{ flex: 1 }} /><Button label="Keep it" kind="quiet" onPress={() => setRemoving(false)} style={{ flex: 1 }} /></View>
        : <Button label="Take off the job…" kind="quiet" onPress={() => setRemoving(true)} />) : null}
    </Card>
  );
}
