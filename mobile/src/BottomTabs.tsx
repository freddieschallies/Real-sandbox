// The tab bar at the bottom of the phone screens. Up to five tabs show as they are; with more, four
// show and the rest go in a "More" menu, so the labels stay readable. The CEO or an admin chooses,
// per position, which tabs are pinned to the bar (Settings → Phone menus).
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { C } from './theme.ts';
import { arrangeTabs } from '../../server/src/core/phoneMenu.ts';

export interface TabDef<T extends string> { key: T; label: string; short?: string; count?: number }

export function BottomTabs<T extends string>({ tabs, current, onSelect, accent, bottom, pinned, onArrange }: {
  tabs: TabDef<T>[]; current: T; onSelect: (k: T) => void; accent: string; bottom: number;
  /** The tabs pinned to the bar for this position; null = automatic. */ pinned?: string[] | null;
  /** For whoever arranges the menus: a shortcut at the bottom of More. */ onArrange?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { bar: shown, more: rest } = arrangeTabs(tabs, pinned);
  const many = rest.length > 0;
  const inRest = rest.find(t => t.key === current);
  const restCount = rest.reduce((n, t) => n + (t.count ?? 0), 0);
  const pick = (k: T) => { setOpen(false); onSelect(k); };
  const tabStyle = (on: boolean) => ({ flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const, paddingVertical: 10, paddingHorizontal: 2, minHeight: 58, borderTopWidth: 3, borderTopColor: on ? accent : 'transparent' });
  return (
    <View style={{ position: 'relative' }}>
      {open ? (
        <>
          <Pressable onPress={() => setOpen(false)} accessibilityLabel="Close the menu" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: -2000 }} />
          <View accessibilityRole="menu" style={{ position: 'absolute', right: 8, bottom: 62 + bottom, minWidth: 230, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, borderRadius: 12, paddingVertical: 6, elevation: 8, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12 }}>
            {rest.map(t => (
              <Pressable key={t.key} onPress={() => pick(t.key)} accessibilityRole="tab" accessibilityState={{ selected: current === t.key }} accessibilityLabel={t.label}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, backgroundColor: current === t.key ? C.panel2 : 'transparent', borderLeftWidth: 3, borderLeftColor: current === t.key ? accent : 'transparent' }}>
                <Text style={{ color: C.text, fontSize: 16, fontWeight: current === t.key ? '800' : '600', flex: 1 }}>{t.label}</Text>
                {t.count ? <Text style={{ color: C.warn, fontWeight: '800', fontSize: 15 }}>{t.count}</Text> : null}
              </Pressable>
            ))}
            {onArrange ? (
              <Pressable onPress={() => { setOpen(false); onArrange(); }} accessibilityRole="button" accessibilityLabel="Choose what is pinned to the bottom"
                style={{ paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.line, marginTop: 4 }}>
                <Text style={{ color: C.quiet, fontSize: 14, fontWeight: '700' }}>Choose what's pinned…</Text>
              </Pressable>
            ) : null}
          </View>
        </>
      ) : null}
      <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line, paddingBottom: bottom, backgroundColor: C.panel }}>
        {shown.map(t => (
          <Pressable key={t.key} onPress={() => pick(t.key)} accessibilityRole="tab" accessibilityState={{ selected: current === t.key }} accessibilityLabel={t.label} style={tabStyle(current === t.key)}>
            <Text numberOfLines={1} style={{ color: current === t.key ? C.text : C.quiet, fontWeight: '700', fontSize: 13 }}>{t.short ?? t.label}</Text>
            {t.count ? <Text style={{ color: C.warn, fontWeight: '800' }}>{t.count}</Text> : null}
          </Pressable>
        ))}
        {many ? (
          <Pressable onPress={() => setOpen(o => !o)} accessibilityRole="button" accessibilityLabel={`More: ${rest.map(t => t.label).join(', ')}`} accessibilityState={{ expanded: open }} style={tabStyle(!!inRest)}>
            <Text numberOfLines={1} style={{ color: inRest || open ? C.text : C.quiet, fontWeight: '700', fontSize: 13 }}>{inRest ? (inRest.short ?? inRest.label) : 'More'} {open ? '▴' : '▾'}</Text>
            {restCount && !inRest ? <Text style={{ color: C.warn, fontWeight: '800' }}>{restCount}</Text> : null}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
