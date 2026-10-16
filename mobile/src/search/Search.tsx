// Search from the front page: a magnifying-glass button in the header opens a search over the screens
// and tabs this person can open, and over what they may see (job cards, stores, customers, stock and
// prices, quotes, invoices, purchase orders, supplier invoices, people, vehicles). Tap a result to go
// straight to it. Without signal, the phone searches what it already has (today's jobs, the stock list).
import React, { useEffect, useRef, useState } from 'react';
import { findStock } from '../../../server/src/core/stockSearch.ts';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../state.tsx';
import * as S from '../../../server/src/core/search.ts';
import { Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';

export interface SearchPlace { key: string; label: string; open: () => void }
export type Openers = Partial<Record<S.SearchKind, (id: string) => void>>;
type Groups = S.SearchResult['groups'];

/** The magnifying glass, drawn (no icon font needed), in the header's colour. */
export function SearchButton({ color, onPress }: { color: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Search" hitSlop={8}
      style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: color, opacity: 0.9 }}>
      <View style={{ width: 18, height: 18 }}>
        <View style={{ position: 'absolute', left: 0, top: 0, width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: color }} />
        <View style={{ position: 'absolute', left: 11, top: 10, width: 2.5, height: 8, borderRadius: 1, backgroundColor: color, transform: [{ rotate: '-45deg' }] }} />
      </View>
    </Pressable>
  );
}

/** What the phone can search without signal: today's jobs and the stock list (no prices). */
export function localSearch(q: string, jobs: { id: string; job_number: number; store: string; fault_reported?: string; status?: string }[], stock: { id: string; code: string; description: string; unit?: string }[]): Groups {
  const out: Groups = [];
  const j = jobs.filter(x => S.hasAll(`${x.job_number} ${x.store} ${x.fault_reported ?? ''}`, q)).slice(0, S.PER_KIND)
    .map(x => ({ kind: 'job' as const, id: x.id, title: `Job ${x.job_number} · ${x.store}`, sub: x.fault_reported ?? '' }));
  if (j.length) out.push({ kind: 'job', label: S.KIND_LABEL.job, hits: j });
  const s = findStock(stock, q, { limit: 8 })
    .map(x => ({ kind: 'stock' as const, id: x.id, title: `${x.code} · ${x.description}`, sub: x.unit ?? '' }));
  if (s.length) out.push({ kind: 'stock', label: S.KIND_LABEL.stock, hits: s });
  return out;
}

export function SearchPanel({ places, open, close, local, hint }: {
  places: SearchPlace[]; open: Openers; close: () => void; local?: (q: string) => Groups; hint?: string;
}) {
  const s = useStore();
  const ins = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<Groups>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'offline'>('idle');
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const text = q.trim();
    if (text.length < S.MIN_CHARS) { setGroups([]); setState('idle'); return; }
    setState('loading');
    const t = setTimeout(async () => {
      const r = await s.ask({ method: 'GET', path: `/search?q=${encodeURIComponent(text)}` }).catch(() => null);
      if (n !== seq.current) return;
      if (r?.status === 200) { setGroups((r.body as S.SearchResult).groups); setState('done'); }
      else { setGroups(local ? local(text) : []); setState('offline'); }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const go = S.wordsOf(q).length ? S.matchPlaces(places, q).slice(0, 8) : [];
  const row = { paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: C.line, gap: 2 } as const;
  const nothing = q.trim().length >= S.MIN_CHARS && state !== 'loading' && !go.length && !groups.some(g => g.hits.length);
  return (
    <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 50, backgroundColor: C.bg }} accessibilityViewIsModal>
      <View style={{ paddingTop: ins.top + 8, paddingHorizontal: 12, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 2, borderBottomColor: C.accent, backgroundColor: C.panel }}>
        <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close search" hitSlop={10}><Text style={{ color: C.text, fontSize: 32 }}>‹</Text></Pressable>
        <TextInput value={q} onChangeText={setQ} autoFocus placeholder="Search: a job no., store, part code or name, screen…" placeholderTextColor={C.quiet} accessibilityLabel="Search for"
          autoCorrect={false} autoCapitalize="none" returnKeyType="search" style={[st.input, { flex: 1, fontSize: 17 }]} />
        {q ? <Pressable onPress={() => setQ('')} accessibilityRole="button" accessibilityLabel="Clear" hitSlop={10}><Text style={{ color: C.quiet, fontSize: 22 }}>×</Text></Pressable> : null}
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 60 + ins.bottom }}>
        {!q.trim() ? (
          <View style={{ padding: 16, gap: 8 }}>
            <Text style={st.body}>Type anything: a job number, a store or customer, a part code, a supplier, a person, or what you want to do.</Text>
            <Text style={st.small}>Parts: the code with or without the dash (valve01), part of the name (inlet valv), a size or rating (25A, 2.5mm, R404), or the word you use for it (gasket finds the door seals). Small spelling mistakes are fine. You see how many are in the stockroom and on whose van.</Text>
            <Text style={st.small}>{hint ?? 'For example: 10220, Spar, valve, prices, timesheet, purchase order.'}</Text>
          </View>
        ) : null}
        {go.length ? (
          <View>
            <Text style={[st.small, { paddingHorizontal: 12, paddingTop: 12, fontWeight: '800', letterSpacing: 0.5 }]}>GO TO</Text>
            {go.map(p => (
              <Pressable key={p.key} onPress={() => { close(); p.open(); }} accessibilityRole="button" accessibilityLabel={`Go to ${p.label}`} style={[row, { flexDirection: 'row', alignItems: 'center' }]}>
                <Text style={[st.body, { flex: 1, fontWeight: '800' }]}>{p.label}</Text>
                <Text style={{ color: C.accent, fontSize: 20, fontWeight: '800' }}>›</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {state === 'loading' ? <Text style={[st.small, { padding: 12 }]}>Searching…</Text> : null}
        {state === 'offline' ? <Text style={[st.small, { padding: 12, color: C.warn }]}>No signal: only what is on this phone is searched.</Text> : null}
        {groups.map(g => (
          <View key={g.kind}>
            <Text style={[st.small, { paddingHorizontal: 12, paddingTop: 12, fontWeight: '800', letterSpacing: 0.5 }]}>{g.label.toUpperCase()}</Text>
            {g.hits.map(h => {
              const to = open[h.kind];
              const body = (
                <>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={[st.body, { flex: 1, fontWeight: '800' }]} numberOfLines={1}>{h.title}</Text>
                    {h.price ? <Text style={[st.body, { fontWeight: '800', color: C.accent }]}>{h.price}</Text> : null}
                    {to ? <Text style={{ color: C.accent, fontSize: 20, fontWeight: '800' }}>›</Text> : null}
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {h.sub ? <Text style={[st.small, { flexShrink: 1 }]} numberOfLines={2}>{h.sub}</Text> : null}
                    {h.badge ? <Pill text={h.badge.text} tone={h.badge.tone} /> : null}
                  </View>
                </>
              );
              return to ? (
                <Pressable key={h.id} onPress={() => { close(); to(h.id); }} accessibilityRole="button" accessibilityLabel={`Result ${h.title}`} style={row}>{body}</Pressable>
              ) : <View key={h.id} style={row} accessibilityLabel={`Result ${h.title}`}>{body}</View>;
            })}
          </View>
        ))}
        {nothing ? <Text style={[st.body, { padding: 16 }]}>Nothing found for “{q.trim()}”. Try fewer words, the part code, or just the start of the name.</Text> : null}
      </ScrollView>
    </View>
  );
}
