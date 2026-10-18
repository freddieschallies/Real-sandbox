// Dark or light (each person, on their device) and the company's colour theme (the director's).
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useStore } from './state.tsx';
import { load, save } from './storage.ts';
import { ACCENT_KEYS, accentColours, C, onThemeChange, setTheme, themeNow, type Accent, type Mode } from './theme.ts';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, st } from './ui.tsx';
import { brandChanged, useBrand } from './brand.tsx';

const KEY = 'rs.mode';

/** At the top of the app: loads this device's dark/light choice and redraws everything when the theme changes. */
export function ThemeRoot({ children }: { children: (mode: Mode) => React.ReactNode }) {
  const [, setV] = useState(0);
  useEffect(() => onThemeChange(() => setV(v => v + 1)), []);
  useEffect(() => { load<Mode>(KEY, 'dark').then(m => setTheme({ mode: m === 'light' ? 'light' : 'dark' })); }, []);
  return <>{children(themeNow().mode)}</>;
}

export function setMode(m: Mode) { setTheme({ mode: m }); save(KEY, m); }

/** A small sun/moon button for the headers. */
export function ModeToggle({ color = '#F7F3EC' }: { color?: string }) {
  const light = themeNow().mode === 'light';
  return (
    <Pressable onPress={() => setMode(light ? 'dark' : 'light')} accessibilityRole="button" accessibilityLabel={light ? 'Switch to dark mode' : 'Switch to light mode'} hitSlop={8}
      style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: color, opacity: 0.9 }}>
      <Text style={{ color, fontSize: 18 }}>{light ? '☾' : '☀'}</Text>
    </Pressable>
  );
}

/** Settings → Appearance (everyone) and Colour theme (the director). */
export function ThemeSettings() {
  const s = useStore();
  const brand = useBrand();
  const [msg, setMsg] = useState<string | null>(null);
  const now = themeNow();
  const [own, setOwn] = useState(now.accent.startsWith('#') ? now.accent : '');
  const ownHex = own.startsWith('#') ? own.toUpperCase() : `#${own.toUpperCase()}`;
  const ownOk = /^#[0-9A-F]{6}$/.test(ownHex);
  const pick = async (a: Accent) => {
    const r = await s.ask({ method: 'PUT', path: '/company/theme', json: { accent: a } });
    if (r && r.status < 300) { setTheme({ accent: a }); brandChanged(); setMsg(`${accentColours(a).label}${a.startsWith('#') ? ` (${a})` : ''} for everyone in the company.`); }
    else setMsg('Not saved: needs signal.');
  };
  return (
    <View style={{ gap: 12, maxWidth: 820 }}>
      <Heading>Appearance</Heading>
      <Card>
        <Label>On this device</Label>
        <Choice options={['dark', 'light'] as const} value={now.mode} onChange={m => setMode(m)} labels={{ dark: 'Dark', light: 'Light' }} />
        <Text style={st.small}>Dark is easier on the eyes at night and saves battery; light is easier to read in bright sun. Each person chooses their own.</Text>
      </Card>
      {brand.canTheme ? (
        <>
          <Heading>Colour theme</Heading>
          <Card>
            <Body quiet>The colour of buttons, tabs and highlights in everyone's app. Only the director chooses it. Each colour is made a little lighter on dark screens and darker on light screens, so the writing on buttons stays easy to read.</Body>
            <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
              {ACCENT_KEYS.map(a => <Swatch key={a} a={a} on={now.accent === a} pick={() => pick(a)} />)}
            </View>
            <Label>Or your own colour (e.g. from your logo)</Label>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <View style={{ flexGrow: 1, flexBasis: 180 }}>
                <Field label="Colour code" value={own} onChangeText={t => setOwn(t.trim())} placeholder="#7A1FA2" autoCapitalize="characters" autoCorrect={false} hint="Six letters and numbers after #, as on your logo or letterhead design." />
              </View>
              {ownOk ? (
                <View style={{ flexDirection: 'row', gap: 6, paddingBottom: 6 }} accessibilityLabel="How it looks">
                  <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: accentColours(ownHex as Accent).dark, borderWidth: 1, borderColor: C.line }} />
                  <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: accentColours(ownHex as Accent).light, borderWidth: 1, borderColor: C.line }} />
                </View>
              ) : null}
              <Button label="Use our colour" kind="secondary" disabled={!ownOk} onPress={() => pick(ownHex as Accent)} />
            </View>
            {own && !ownOk ? <Text style={[st.small, { color: C.warn }]}>A colour code is # and six letters or numbers, e.g. #7A1FA2.</Text> : null}
            {now.accent.startsWith('#') ? <Text style={st.small}>In use: your own colour {now.accent}.</Text> : null}
          </Card>
          {msg ? <Notice tone={msg.startsWith('Not') ? 'bad' : 'good'} title={msg} /> : null}
        </>
      ) : null}
    </View>
  );
}

/** One ready-made colour: its dot (as it looks on this screen) and name. */
function Swatch({ a, on, pick }: { a: Accent; on: boolean; pick: () => void }) {
  const c = accentColours(a);
  const m = themeNow().mode;
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={c.label} onPress={pick}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 52, borderRadius: 26, borderWidth: on ? 3 : 1, borderColor: on ? C.text : C.line, backgroundColor: C.panel2, flexGrow: 1, flexBasis: 150 }}>
      <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: c[m] }} />
      <Text style={[st.body, { fontWeight: on ? '800' : '600' }]}>{c.label}</Text>
      {on ? <Text style={{ color: C.text, marginLeft: 'auto', fontWeight: '800' }}>✓</Text> : null}
    </Pressable>
  );
}
