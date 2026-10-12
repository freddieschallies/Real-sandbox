// Settings → Phone menus. The CEO or an admin chooses, per position, which tabs are pinned to the
// bottom of the phone screen (up to four); the rest go under More. On a computer every tab shows
// down the side, so this is about the phone only.
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Choice, Heading, Label, Notice, Pill } from '../ui.tsx';
import { C } from '../theme.ts';
import { arrangeTabs } from '../../../server/src/core/phoneMenu.ts';
import { menuChanged } from '../menu.tsx';

type Pos = { level: string; label: string; app: string; tabs: { key: string; label: string }[]; usual: string[]; pinned: string[] | null; updatedAt: string | null };
type Data = { maxPinned: number; positions: Pos[] };

export function PhoneMenus({ start }: { start?: string }) {
  const s = useStore();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [level, setLevel] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string[] | null | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const load = async () => {
    const r = await s.ask({ method: 'GET', path: '/phone-menus' });
    if (r?.status === 200) { setD(r.body); setErr(null); setLevel(l => l ?? (r.body.positions.some((p: Pos) => p.level === start) ? start! : r.body.positions[0]?.level ?? null)); }
    else setErr((r?.body as { reasons?: string[] })?.reasons?.join('; ') ?? 'Needs signal to load.');
  };
  useEffect(() => { load(); }, []);

  if (err) return <Notice tone="warn" title="Phone menus" lines={[err]} />;
  if (!d || !level) return <Body quiet>Loading…</Body>;
  const p = d.positions.find(x => x.level === level)!;
  const max = d.maxPinned;
  const labelOf = (k: string) => p.tabs.find(t => t.key === k)?.label ?? k;
  const usual = p.tabs.filter(t => p.usual.includes(t.key));
  const extra = p.tabs.filter(t => !p.usual.includes(t.key));
  const draft = drafts[level];
  const changed = draft !== undefined;
  // What is pinned now: the draft, or what is saved, or (automatic) what the bar shows by itself.
  const auto = arrangeTabs(usual, null).bar.map(t => t.key).slice(0, max);
  const pinned = draft === undefined ? p.pinned : draft;
  const base = pinned ?? auto;
  const set = (next: string[] | null) => { setSaved(null); setDrafts(x => ({ ...x, [level]: next })); };
  const pin = (k: string) => base.length < max && set([...base, k]);
  const unpin = (k: string) => set(base.filter(x => x !== k));
  const move = (k: string, by: -1 | 1) => {
    const i = base.indexOf(k), j = i + by;
    if (j < 0 || j >= base.length) return;
    const n = [...base]; [n[i], n[j]] = [n[j], n[i]]; set(n);
  };
  const previewTabs = [...usual, ...extra.filter(t => base.includes(t.key))];
  const prev = arrangeTabs(previewTabs, pinned);

  const save = async () => {
    setBusy(true);
    const r = await s.ask({ method: 'PUT', path: `/phone-menus/${level}`, json: { pinned } });
    setBusy(false);
    if (r?.status === 200) {
      setDrafts(x => { const y = { ...x }; delete y[level]; return y; });
      setSaved(pinned ? `Saved. ${p.label} now has ${pinned.map(labelOf).join(', ')} at the bottom.` : `Saved. ${p.label} is back on the automatic menu.`);
      menuChanged();
      await load();
    } else setSaved(`Not saved: ${(r?.body as { reasons?: string[] })?.reasons?.join('; ') ?? 'needs signal'}.`);
  };

  const row = (t: { key: string; label: string }, dim: boolean) => {
    const i = base.indexOf(t.key);
    const on = i >= 0;
    return (
      <View key={t.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line, opacity: dim && !on ? 0.65 : 1 }}>
        <Text style={{ color: on ? C.text : C.quiet, fontWeight: on ? '800' : '600', fontSize: 16, flex: 1 }}>{on ? `${i + 1}. ` : ''}{t.label}</Text>
        {on ? (
          <>
            <Small label="▲" a11y={`Move ${t.label} left`} onPress={() => move(t.key, -1)} disabled={i === 0} />
            <Small label="▼" a11y={`Move ${t.label} right`} onPress={() => move(t.key, 1)} disabled={i === base.length - 1} />
            <Small label="Unpin" a11y={`Unpin ${t.label}`} onPress={() => unpin(t.key)} />
          </>
        ) : <Small label="Pin" a11y={`Pin ${t.label}`} onPress={() => pin(t.key)} disabled={base.length >= max} />}
      </View>
    );
  };

  return (
    <View style={{ gap: 12, maxWidth: 820 }}>
      <Heading>Phone menus</Heading>
      <Body quiet>Choose which tabs sit at the bottom of the phone screen for each position, up to {max}. The rest go under More. On a computer every tab shows down the side.</Body>
      <Choice options={d.positions.map(x => x.level)} value={level} onChange={l => { setLevel(l); setSaved(null); }} labels={Object.fromEntries(d.positions.map(x => [x.level, x.label]))} />
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Label>{p.label}'s phone</Label>
          <View style={{ flex: 1 }} />
          {pinned === null ? <Pill text="Automatic" tone="quiet" /> : changed ? <Pill text="Not saved yet" tone="warn" /> : <Pill text="Chosen" tone="good" />}
        </View>
        <View accessibilityLabel={`Preview: ${prev.bar.map(t => t.label).join(', ')}${prev.more.length ? ', More' : ''}`}
          style={{ flexDirection: 'row', borderWidth: 1, borderColor: C.line, borderRadius: 10, overflow: 'hidden', backgroundColor: C.panel, marginTop: 8 }}>
          {[...prev.bar.map(t => t.label), ...(prev.more.length ? ['More ▾'] : [])].map((l, i) => (
            <View key={l + i} style={{ flex: 1, paddingVertical: 12, alignItems: 'center', borderLeftWidth: i ? 1 : 0, borderLeftColor: C.line }}>
              <Text numberOfLines={1} style={{ color: C.text, fontWeight: '700', fontSize: 13 }}>{l}</Text>
            </View>
          ))}
        </View>
        <Body quiet style={{ marginTop: 6 }}>{prev.more.length ? `Under More: ${prev.more.map(t => t.label).join(', ')}` : 'Nothing under More: every tab fits on the bar.'}</Body>
      </Card>
      <Card>
        <Label>Tabs a {p.label.toLowerCase()} has</Label>
        {usual.map(t => row(t, false))}
        {extra.length ? (
          <>
            <Body quiet style={{ marginTop: 12 }}>Only for someone you gave that work as well:</Body>
            {extra.map(t => row(t, true))}
          </>
        ) : null}
        <Body quiet style={{ marginTop: 8 }}>{base.length >= max ? `${max} pinned is the most: unpin one to pin another.` : !base.length ? 'Pin at least one tab, or go back to automatic.' : `${base.length} of ${max} pinned.`} A pinned tab someone doesn't have is skipped for them.</Body>
      </Card>
      {saved ? <Notice tone={saved.startsWith('Not saved') ? 'bad' : 'good'} title={saved} /> : null}
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Button label="Save" onPress={save} disabled={!changed || (!!pinned && !pinned.length)} busy={busy} />
        {changed ? <Button label="Undo changes" kind="secondary" onPress={() => setDrafts(x => { const y = { ...x }; delete y[level]; return y; })} /> : null}
        {pinned !== null ? <Button label="Back to automatic" kind="quiet" onPress={() => set(null)} /> : null}
      </View>
    </View>
  );
}

function Small({ label, onPress, disabled, a11y }: { label: string; onPress: () => void; disabled?: boolean; a11y: string }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ disabled: !!disabled }} hitSlop={4}
      style={{ minWidth: 44, minHeight: 40, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.panel2, opacity: disabled ? 0.35 : 1 }}>
      <Text style={{ color: C.text, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}
