// The company's letterhead, given by the CEO: a picture for the top of every page and one for the
// bottom. Everything the app prints or emails uses it (reports, quotes, invoices, timesheets). A new
// company starts without one and gets the plain layout with its logo and details.
import React, { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { useStore } from './state.tsx';
import { usePhotoUri, rememberPhoto } from './photo.ts';
import { pickImage, nowIso } from './device.ts';
import { Body, Button, Card, Heading, Label, Notice, st } from './ui.tsx';
import { C } from './theme.ts';

type LH = { headerPhotoId: string | null; footerPhotoId: string | null; canEdit: boolean };
const cache = new Map<string, LH>();
const listeners = new Set<() => void>();
let current: { header: string | null; footer: string | null } = { header: null, footer: null };
export function letterheadChanged() { cache.clear(); listeners.forEach(f => f()); }

/** Loads the letterhead (keep it mounted where printing happens) and returns it. */
export function useLetterhead() {
  const s = useStore();
  const key = s.session ? `${s.session.company.id}|${s.session.user.id}` : '';
  const [d, setD] = useState<LH | null>(cache.get(key) ?? null);
  const [tick, setTick] = useState(0);
  useEffect(() => { const f = () => setTick(t => t + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  useEffect(() => {
    if (!key) return;
    const hit = cache.get(key);
    if (hit) { setD(hit); return; }
    s.ask({ method: 'GET', path: '/company/letterhead' }).then(r => { if (r?.status === 200) { cache.set(key, r.body); setD(r.body); } }).catch(() => {});
  }, [key, tick]);
  const header = usePhotoUri(d?.headerPhotoId ?? null);
  const footer = usePhotoUri(d?.footerPhotoId ?? null);
  current = { header: d?.headerPhotoId ? header : null, footer: d?.footerPhotoId ? footer : null };
  return { header: current.header, footer: current.footer, canEdit: !!d?.canEdit, ids: d };
}

/** For printouts: the letterhead's top, or the plain heading given. */
export const letterheadTop = (plain: string) => (current.header ? `<img src="${current.header}" style="width:100%;display:block">` : plain);
/** The letterhead's bottom, or the plain footer given. */
export const letterheadBottom = (plain: string) => (current.footer ? `<img src="${current.footer}" style="width:100%;display:block;margin-top:16px">` : plain);

/** Settings → Letterhead (the CEO). */
export function LetterheadSettings() {
  const s = useStore();
  const lh = useLetterhead();
  const [msg, setMsg] = useState<string | null>(null);
  if (!lh.canEdit) return null;
  const set = async (part: 'header' | 'footer', remove = false) => {
    let id: string | null = null;
    if (!remove) {
      const p = await pickImage();
      if (!p) return;
      id = s.newId();
      rememberPhoto(s, id, p.uri);
      const up = await s.ask({ method: 'POST', path: '/photos', upload: { fields: { kind: 'letterhead', takenAt: nowIso(), id }, fileUri: p.uri, mime: p.mime } });
      if (!up || up.status >= 300) { setMsg('The picture could not be sent: try again with signal.'); return; }
    }
    const r = await s.ask({ method: 'PUT', path: '/company/letterhead', json: part === 'header' ? { headerPhotoId: id } : { footerPhotoId: id } });
    if (r && r.status < 300) { letterheadChanged(); setMsg(remove ? `The ${part === 'header' ? 'top' : 'bottom'} of the letterhead is removed.` : `Saved: every report, quote, invoice and timesheet now uses it.`); }
    else setMsg('Not saved: needs signal.');
  };
  const part = (which: 'header' | 'footer', uri: string | null) => (
    <View style={{ gap: 8 }}>
      <Label>{which === 'header' ? 'Top of the page' : 'Bottom of the page'}</Label>
      {uri ? <View style={{ backgroundColor: '#FFFFFF', borderRadius: 6, padding: 4 }}><Image source={{ uri }} style={{ width: '100%', height: 90 }} resizeMode="contain" accessibilityLabel={`Letterhead ${which}`} /></View>
        : <Text style={st.small}>None yet: {which === 'header' ? 'the company logo and name show instead.' : 'the company details show instead.'}</Text>}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Button label={uri ? 'Change' : 'Add a picture'} kind="secondary" onPress={() => set(which)} />
        {uri ? <Button label="Remove" kind="quiet" onPress={() => set(which, true)} /> : null}
      </View>
    </View>
  );
  return (
    <View style={{ gap: 12, maxWidth: 820 }}>
      <Heading>Letterhead</Heading>
      <Card>
        <Body quiet>The company's letterhead for everything the app prints or emails: reports, quotes, invoices and timesheets. Use a picture of the top and one of the bottom of your letterhead (a wide image, like a scan of the page edge). Each company sets its own.</Body>
        {part('header', lh.header)}
        <View style={{ borderTopWidth: 1, borderTopColor: C.line }} />
        {part('footer', lh.footer)}
      </Card>
      {msg ? <Notice tone={msg.startsWith('Not') || msg.includes('could not') ? 'bad' : 'good'} title={msg} /> : null}
    </View>
  );
}
