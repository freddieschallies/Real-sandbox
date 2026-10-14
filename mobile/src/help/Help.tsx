// "How to use the app": a quiet link low on every front page that opens step-by-step guides for this
// person's own work (and the ones for everyone). Find a guide by typing what you want to do.
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../state.tsx';
import { hasAll } from '../../../server/src/core/search.ts';
import { st } from '../ui.tsx';
import { C } from '../theme.ts';
import { guidesFor } from './guides.ts';

/** The link, low on the page. */
export function HelpLink({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="How to use the app"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: C.line, borderStyle: 'dashed', marginTop: 8 }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: C.panel2 }}>
        <Text style={{ color: C.text, fontWeight: '900', fontSize: 16 }}>?</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[st.body, { fontWeight: '800' }]}>How to use the app</Text>
        <Text style={st.small}>Step-by-step guides for your work</Text>
      </View>
      <Text style={{ color: C.quiet, fontSize: 20 }}>›</Text>
    </Pressable>
  );
}

export function HelpPanel({ close }: { close: () => void }) {
  const s = useStore();
  const ins = useSafeAreaInsets();
  const level = s.session?.user.level ?? 'technician';
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const all = guidesFor(level);
  const list = q.trim() ? all.filter(g => hasAll(`${g.title} ${g.steps.join(' ')}`, q)) : all;
  return (
    <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 50, backgroundColor: C.bg }} accessibilityViewIsModal>
      <View style={{ paddingTop: ins.top + 8, paddingHorizontal: 12, paddingBottom: 10, gap: 8, borderBottomWidth: 2, borderBottomColor: C.accent, backgroundColor: C.panel }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close help" hitSlop={10}><Text style={{ color: C.text, fontSize: 32 }}>‹</Text></Pressable>
          <Text style={{ color: C.text, fontSize: 20, fontWeight: '800', flex: 1 }}>How to use the app</Text>
        </View>
        <TextInput value={q} onChangeText={setQ} placeholder="What do you want to do? e.g. invoice, fuel, password" placeholderTextColor={C.quiet} accessibilityLabel="Find a guide"
          autoCorrect={false} style={[st.input, { fontSize: 16 }]} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 8, paddingBottom: 60 + ins.bottom }} keyboardShouldPersistTaps="handled">
        {list.map(g => {
          const on = open === g.id || (!!q.trim() && list.length === 1);
          return (
            <View key={g.id} style={{ borderRadius: 10, borderWidth: 1, borderColor: on ? C.accent : C.line, backgroundColor: C.panel }}>
              <Pressable onPress={() => setOpen(on ? null : g.id)} accessibilityRole="button" accessibilityLabel={`Guide ${g.title}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14 }}>
                <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{g.title}</Text>
                <Text style={{ color: C.quiet, fontSize: 18 }}>{on ? '▾' : '›'}</Text>
              </Pressable>
              {on ? (
                <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 10 }}>
                  {g.steps.map((x, i) => (
                    <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
                      <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: C.accent }}>
                        <Text style={{ color: C.accentText, fontWeight: '900' }}>{i + 1}</Text>
                      </View>
                      <Text style={[st.body, { flex: 1 }]}>{x}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
        {!list.length ? <Text style={[st.body, { padding: 8 }]}>No guide for that yet. Try another word.</Text> : null}
        <Text style={[st.small, { padding: 8 }]}>{level === 'technician' ? 'Still stuck? Ask the office under Queries on My day.' : 'Still stuck? Ask the CEO or Admin.'}</Text>
      </ScrollView>
    </View>
  );
}
