// "How to use the app": a quiet link low on every front page that opens step-by-step guides for this
// person's own work (and the ones for everyone). Find a guide by typing what you want to do.
import React, { useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../state.tsx';
import { hasAll } from '../../../server/src/core/search.ts';
import { st } from '../ui.tsx';
import { C } from '../theme.ts';
import { guidesFor } from './guides.ts';

/** The instruction video for each position (made with a made-up company, no real data). */
export const VIDEOS: { file: string; title: string; levels: string[]; minutes: number }[] = [
  { file: 'technician', title: 'Technicians', levels: ['technician'], minutes: 5 },
  { file: 'stock-controller', title: 'The stock controller', levels: ['stockroom'], minutes: 3 },
  { file: 'mechanic', title: 'The mechanic', levels: ['mechanic'], minutes: 2 },
  { file: 'department-manager', title: 'Department managers', levels: ['management'], minutes: 2 },
  { file: 'hr', title: 'HR', levels: ['hr'], minutes: 2 },
  { file: 'admin', title: 'The office (Admin)', levels: ['admin'], minutes: 3 },
  { file: 'accounts', title: 'Accounts', levels: ['accounts'], minutes: 3 },
  { file: 'ceo', title: 'The CEO', levels: ['director', 'creator'], minutes: 3 },
];
/** Where the videos are: the company's server, or next to the test drive. */
export function videoUrl(s: { session: { mode: string; baseUrl: string } | null }, file: string) {
  return s.session?.mode === 'server' ? `${s.session.baseUrl.replace(/\/+$/, '')}/help/videos/${file}.mp4` : `videos/${file}.mp4`;
}

/** The video for this person's position, played right here (on a phone it opens in the video player). */
function VideoCard({ v }: { v: (typeof VIDEOS)[number] }) {
  const s = useStore();
  const [play, setPlay] = useState(false);
  const url = videoUrl(s, v.file);
  return (
    <View style={{ borderRadius: 10, borderWidth: 2, borderColor: C.accent, backgroundColor: C.panel, overflow: 'hidden' }}>
      {play && Platform.OS === 'web'
        ? React.createElement('video', { src: url, controls: true, autoPlay: true, playsInline: true, style: { width: '100%', maxHeight: 520, background: '#000', display: 'block' } })
        : (
          <Pressable onPress={() => (Platform.OS === 'web' ? setPlay(true) : Linking.openURL(url))} accessibilityRole="button" accessibilityLabel={`Watch the video: ${v.title}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: C.accentText, fontSize: 20, fontWeight: '900' }}>▶</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[st.body, { fontWeight: '800' }]}>Watch the video: {v.title}</Text>
              <Text style={st.small}>About {v.minutes} minutes, with captions (no sound needed)</Text>
            </View>
          </Pressable>
        )}
    </View>
  );
}

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
        <Text style={st.small}>Guides and a video for your work</Text>
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
        {!q.trim() ? VIDEOS.filter(v => v.levels.includes(level)).map(v => <VideoCard key={v.file} v={v} />) : null}
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
        {!q.trim() && ['director', 'creator', 'admin', 'hr'].includes(level) ? (
          <View style={{ gap: 8, marginTop: 8 }}>
            <Text style={[st.small, { fontWeight: '800', letterSpacing: 0.5, paddingHorizontal: 4 }]}>THE VIDEOS FOR EVERY POSITION (FOR NEW PEOPLE)</Text>
            {VIDEOS.filter(v => !v.levels.includes(level)).map(v => <VideoCard key={v.file} v={v} />)}
          </View>
        ) : null}
        <Text style={[st.small, { padding: 8 }]}>{level === 'technician' ? 'Still stuck? Ask the office under Queries on My day.' : 'Still stuck? Ask the CEO or Admin.'}</Text>
      </ScrollView>
    </View>
  );
}
