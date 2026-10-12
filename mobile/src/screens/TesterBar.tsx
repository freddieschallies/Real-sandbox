// Only in the shared test build: switch between the technician, stock controller and mechanic apps.
// In the real app each person only ever sees the app for their own position.
import React, { useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useStore } from '../state.tsx';
import { C } from '../theme.ts';
import { realText as R } from '../demoReal.ts';

const ROLES = [
  { who: 'demo', level: 'technician', label: 'Technician', short: 'Tech' },
  { who: 'stock', level: 'stockroom', label: 'Stock controller', short: 'Stock' },
  { who: 'mech', level: 'mechanic', label: 'Mechanic', short: 'Mech' },
  { who: 'manager', level: 'management', label: 'Manager', short: 'Mgr' },
  { who: 'hr', level: 'hr', label: 'HR', short: 'HR' },
  { who: 'admin', level: 'admin', label: 'Admin', short: 'Admin' },
  { who: 'office', level: 'creator', label: 'CEO', short: 'CEO' },
] as const;

export function TesterBar() {
  const s = useStore();
  const [busy, setBusy] = useState(false);
  const narrow = useWindowDimensions().width < 520;
  const current = s.session?.user.level;
  const go = async (who: string) => {
    if (busy || s.waiting) return;
    setBusy(true);
    await s.signOut();
    await s.signIn('demo', '', who, 'demo');
    setBusy(false);
  };
  const duty = !!s.session?.user.fleetDuty;
  const toggleDuty = async () => {
    if (busy) return;
    setBusy(true);
    // What the CEO does for a small company with no mechanic of its own.
    await s.ask({ method: 'PUT', path: `/access/users/${s.session?.user.id}/fleet-duty`, json: { on: !duty } });
    await s.refresh();
    setBusy(false);
  };
  return (
    <View>
    {/* On a small phone the buttons wrap onto a second line, so every one stays on screen and taps land where they look. */}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#0B0C0E', borderBottomWidth: 1, borderBottomColor: C.line, flexWrap: narrow ? 'wrap' : 'nowrap', overflow: 'hidden' }}>
      {!narrow ? <Text style={{ color: C.quiet, fontSize: 12, fontWeight: '700', marginRight: 4 }}>VIEW AS</Text> : null}
      {ROLES.map(r => {
        const on = current === r.level;
        return (
          <Pressable key={r.who} onPress={() => !on && go(r.who)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={`View as ${r.label}`}
            style={{ paddingHorizontal: narrow ? 9 : 12, paddingVertical: 6, borderRadius: 16, backgroundColor: on ? C.accent : C.panel2, opacity: busy ? 0.5 : 1 }}>
            <Text style={{ color: on ? C.accentText : C.text, fontWeight: '700', fontSize: 13 }}>{narrow ? r.short : r.label}</Text>
          </Pressable>
        );
      })}
      {!narrow ? <View style={{ flex: 1 }} /> : null}
      <Pressable onPress={() => s.signOut()} accessibilityRole="button" accessibilityLabel="Back to the test guide" style={{ paddingHorizontal: 8, paddingVertical: 6 }}>
        <Text style={{ color: C.quiet, fontSize: 13, textDecorationLine: 'underline' }}>Guide</Text>
      </Pressable>
    </View>
    {current === 'stockroom' ? (
      <Pressable onPress={toggleDuty} accessibilityRole="switch" accessibilityState={{ checked: duty }} accessibilityLabel={R("Lindiwe also does the mechanic's work")}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#0B0C0E', borderBottomWidth: 1, borderBottomColor: C.line, opacity: busy ? 0.5 : 1 }}>
        <View style={{ width: 34, height: 20, borderRadius: 10, backgroundColor: duty ? C.good : C.panel2, justifyContent: 'center', paddingHorizontal: 2 }}>
          <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: '#FFF', alignSelf: duty ? 'flex-end' : 'flex-start' }} />
        </View>
        <Text style={{ color: C.quiet, fontSize: 12, flex: 1 }}>{R("Small company, no mechanic: the CEO also gives Lindiwe the mechanic's work")}</Text>
      </Pressable>
    ) : null}
    </View>
  );
}
