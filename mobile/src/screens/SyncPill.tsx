import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { C } from '../theme.ts';

/** Always visible: tells the technician whether his work has reached the office. */
export function SyncPill() {
  const s = useStore();
  const nav = useNav();
  let text = 'All sent';
  let fg = C.good, bg = C.goodBg;
  if (s.blocked) { text = 'Needs you'; fg = C.bad; bg = C.badBg; }
  else if (s.waiting && !s.online) { text = `No signal · ${s.waiting} waiting`; fg = C.warn; bg = C.warnBg; }
  else if (s.waiting) { text = `Sending ${s.waiting}…`; fg = C.info; bg = C.infoBg; }
  else if (!s.online) { text = 'No signal'; fg = C.warn; bg = C.warnBg; }
  return (
    <Pressable onPress={() => nav.push({ name: 'sync' })} accessibilityRole="button" accessibilityLabel={`Sync status: ${text}`} hitSlop={6}>
      <View style={{ backgroundColor: bg, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: fg }} />
        <Text style={{ color: fg, fontWeight: '700', fontSize: 14 }}>{text}</Text>
      </View>
    </Pressable>
  );
}
