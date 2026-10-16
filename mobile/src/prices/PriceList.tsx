// The price list: every part the company sells and its selling price (never what it cost), for when
// a client asks what a part costs. Search it the way you would the stock (codes, part of a name,
// typos); tap a part for its picture and price. The stock controller, Admin and the CEO put up the
// pictures of parts. The last
// list is kept on the phone, so it works without signal too.
import { ExportBar } from '../exportDoc.tsx';
import { escHtml, letterPage } from '../letterhead.tsx';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ItemPicture, Thumb } from '../ItemPicture.tsx';
import { Body, Button, Field, Notice, rand, st } from '../ui.tsx';
import { C, S } from '../theme.ts';
import { findStock } from '../../../server/src/core/stockSearch.ts';

export interface PriceItem {
  id: string; code: string; description: string; unit: string; priceCents: number | null;
  supplierCode?: string | null; pastelCode?: string | null; photoId: string | null; photoBy?: string | null; photoAt?: string | null;
}
export interface PriceListData { vatPct: number; items: PriceItem[]; at?: string; canPicture?: boolean }

const incl = (cents: number, vat: number) => Math.round(cents * (1 + vat / 100));
const day = (iso: string) => new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Johannesburg' });

export function usePriceList() {
  const s = useStore();
  const kept = s.cache.prices as PriceListData | undefined;
  const [d, setD] = useState<PriceListData | null>(kept ?? null);
  const [offline, setOffline] = useState(false);
  const load = async () => {
    const r = await s.ask({ method: 'GET', path: '/price-list' }).catch(() => null);
    if (r?.status === 200) {
      const v = { ...(r.body as PriceListData), at: new Date().toISOString() };
      setD(v); setOffline(false);
      s.patchCache(c => ({ ...c, prices: v }));
    } else setOffline(true);
  };
  useEffect(() => { load(); }, []);
  return { d, offline, load };
}

/** The technician's screen: the price list under a header with the way back. */
export function PriceListScreen({ itemId }: { itemId?: string }) {
  const nav = useNav();
  const ins = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: ins.top }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: S.pad, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line }}>
        <Pressable onPress={() => nav.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={10}><Text style={{ color: C.text, fontSize: 32 }}>‹</Text></Pressable>
        <Text style={{ color: C.text, fontSize: 20, fontWeight: '800' }}>Price list</Text>
      </View>
      <View style={{ flex: 1 }}><PriceList itemId={itemId} /></View>
    </View>
  );
}

/** The list and, on a computer, the chosen part beside it; on a phone the part opens on its own. */
export function PriceList({ itemId, back }: { itemId?: string; back?: () => void }) {
  const s = useStore();
  const { d, offline, load } = usePriceList();
  // Side by side only when there is room where it is shown (the technician's app keeps phone width on a computer).
  const [boxW, setBoxW] = useState(useWindowDimensions().width);
  const wide = boxW >= 900;
  const measure = (e: { nativeEvent: { layout: { width: number } } }) => setBoxW(e.nativeEvent.layout.width);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(itemId ?? null);
  if (!d) return <View style={{ padding: S.pad }} onLayout={measure}>{offline ? <Notice tone="warn" title="The price list needs signal the first time" lines={['Once it has loaded it stays on this phone for when there is no signal.']} /> : <Body quiet>Loading the price list…</Body>}</View>;
  const shown = findStock(d.items, q, { limit: q.trim() ? 60 : undefined });
  const chosen = sel ? d.items.find(i => i.id === sel) ?? null : null;

  const list = (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: 8, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
      <Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>Price list</Text>
      <Text style={st.small}>Every part and what the client pays for it. For when a client asks what a part costs. Prices are set by the office.</Text>
      <Field label="Find a part" value={q} onChangeText={setQ} placeholder="Code or name, e.g. valve, 25A, R404, gasket" autoCorrect={false} autoCapitalize="none" />
      {offline ? <Text style={[st.small, { color: C.warn }]}>No signal: this is the list from {d.at ? day(d.at) : 'earlier'}.</Text> : null}
      <Text style={st.small}>{q.trim() ? `${shown.length} part${shown.length === 1 ? '' : 's'} found, best match first` : `${d.items.length} parts · prices excl. VAT, with VAT (${d.vatPct}%) under`}</Text>
      {shown.map(i => (
        <Pressable key={i.id} onPress={() => setSel(i.id)} accessibilityRole="button" accessibilityLabel={`Part ${i.code} ${i.description}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: sel === i.id && wide ? C.accent : C.line, backgroundColor: C.panel }}>
          <Thumb photoId={i.photoId} label={i.description} size={52} />
          <View style={{ flex: 1 }}>
            <Text style={[st.body, { fontWeight: '800' }]} numberOfLines={2}>{i.description}</Text>
            <Text style={st.small}>{i.code} · per {i.unit}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            {i.priceCents != null ? (
              <>
                <Text style={{ color: C.accent, fontSize: 17, fontWeight: '800' }}>{rand(i.priceCents)}</Text>
                <Text style={st.small}>{rand(incl(i.priceCents, d.vatPct))} incl.</Text>
              </>
            ) : <Text style={[st.small, { color: C.warn }]}>No price yet</Text>}
          </View>
        </Pressable>
      ))}
      {shown.length ? <ExportBar title={q.trim() ? `Export these ${shown.length} parts` : 'Export the whole price list'} make={() => {
        const e = escHtml;
        const day = new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
        const rows = shown.map(i => `<tr><td>${e(i.code)}</td><td>${e(i.description)}</td><td>${e(i.unit)}</td><td class=r>${i.priceCents != null ? rand(i.priceCents) : '–'}</td><td class=r>${i.priceCents != null ? rand(incl(i.priceCents, d.vatPct)) : '–'}</td></tr>`).join('');
        const body = `<h2>Price list · ${e(day)}</h2>${q.trim() ? `<p class=muted>Parts matching “${e(q.trim())}”</p>` : ''}<table><tr><th>Code</th><th>Part</th><th>Unit</th><th class=r>Excl. VAT</th><th class=r>Incl. VAT (${d.vatPct}%)</th></tr>${rows}</table><p class=muted>Prices may change; a client with its own mark-up may pay a little differently on the invoice.</p>`;
        return { kind: 'price_list', title: `Price list – ${day}`, html: letterPage({ title: `Price list – ${day}`, label: 'PRICE LIST', company: s.session?.company.name ?? '', body }) };
      }} /> : null}
      {!shown.length ? <Body quiet>No part fits “{q.trim()}”. Try the code, or just the start of the name.</Body> : null}
      {back ? <Button label="Back" kind="quiet" onPress={back} /> : null}
    </ScrollView>
  );
  const detail = chosen ? <PartPrice key={chosen.id} it={chosen} vat={d.vatPct} canPicture={!!d.canPicture} changed={load} close={() => setSel(null)} showClose={!wide} /> : null;
  if (wide) {
    return (
      <View style={{ flex: 1, flexDirection: 'row' }} onLayout={measure}>
        <View style={{ width: 520, borderRightWidth: 1, borderRightColor: C.line }}>{list}</View>
        <View style={{ flex: 1 }}>{detail ?? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Body quiet>Choose a part for its picture and price.</Body></View>}</View>
      </View>
    );
  }
  return <View style={{ flex: 1 }} onLayout={measure}>{detail ?? list}</View>;
}

function PartPrice({ it, vat, canPicture, changed, close, showClose }: { it: PriceItem; vat: number; canPicture: boolean; changed: () => void; close: () => void; showClose: boolean }) {
  const s = useStore();
  const [photo, setPhoto] = useState(it.photoId);
  const [saved, setSaved] = useState(false);
  return (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: 12, paddingBottom: 60, maxWidth: 760 }}>
      {showClose ? <Button label="‹ Back to the price list" kind="quiet" onPress={close} /> : null}
      <Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>{it.description}</Text>
      <Text style={st.small}>Code {it.code}{it.supplierCode ? ` · supplier code ${it.supplierCode}` : ''}{it.pastelCode && it.pastelCode !== it.code ? ` · Pastel ${it.pastelCode}` : ''} · per {it.unit}</Text>
      <View style={{ padding: 14, borderRadius: 12, backgroundColor: C.panel, borderWidth: 2, borderColor: C.accent, gap: 2 }}>
        {it.priceCents != null ? (
          <>
            <Text style={{ color: C.accent, fontSize: 34, fontWeight: '800' }}>{rand(it.priceCents)} <Text style={{ fontSize: 18 }}>excl. VAT</Text></Text>
            <Text style={[st.body, { fontWeight: '700' }]}>{rand(incl(it.priceCents, vat))} incl. VAT ({vat}%)</Text>
            <Text style={st.small}>The usual price per {it.unit}. A client with its own mark-up may pay a little differently on the invoice.</Text>
          </>
        ) : <Text style={[st.body, { color: C.warn, fontWeight: '700' }]}>No price set yet: ask the office.</Text>}
      </View>
      <Text style={[st.small, { fontWeight: '800', letterSpacing: 0.5 }]}>PICTURE FOR REFERENCE</Text>
      <ItemPicture photoId={photo} kind="stock_item" label={it.description} canEdit={canPicture}
        save={async id => {
          const r = await s.ask({ method: 'PUT', path: `/price-list/${it.id}/photo`, json: { photoId: id } });
          if (!r || r.status >= 300) return (r?.body as { reasons?: string[] })?.reasons?.[0] ?? 'Not saved: try again with signal.';
          setPhoto(id); setSaved(true); changed();
          return null;
        }} />
      {saved ? <Text style={[st.small, { color: C.good }]}>Picture saved: everyone sees it now.</Text>
        : it.photoBy && it.photoAt ? <Text style={st.small}>Picture by {it.photoBy}, {day(it.photoAt)}.</Text>
        : <Text style={st.small}>{canPicture ? 'No picture yet? Take one of the part (or its box or label) so the next person knows it by sight.' : 'No picture yet: the stock controller, Admin or the CEO adds one.'}</Text>}
    </ScrollView>
  );
}
