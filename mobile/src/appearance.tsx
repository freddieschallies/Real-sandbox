// Dark or light (each person, on their device) and the company's colour theme (the director's).
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useStore } from './state.tsx';
import { load, save } from './storage.ts';
import { ACCENTS, C, onThemeChange, setTheme, themeNow, type Accent, type Mode } from './theme.ts';
import { Body, Card, Choice, Heading, Label, Notice, st } from './ui.tsx';
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
            <Body quiet>The colour of buttons, tabs and highlights in everyone's app. Only the director chooses it.</Body>
            <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
              {(Object.keys(ACCENTS) as Accent[]).map(a => {
                const on = now.accent === a;
                return (
                  <Pressable key={a} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={ACCENTS[a].label}
                    onPress={async () => {
                      const r = await s.ask({ method: 'PUT', path: '/company/theme', json: { accent: a } });
                      if (r && r.status < 300) { setTheme({ accent: a }); brandChanged(); setMsg(`${ACCENTS[a].label} for everyone in the company.`); }
                      else setMsg('Not saved: needs signal.');
                    }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 52, borderRadius: 26, borderWidth: on ? 3 : 1, borderColor: on ? C.text : C.line, backgroundColor: C.panel2 }}>
                    <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: ACCENTS[a][now.mode] }} />
                    <Text style={[st.body, { fontWeight: on ? '800' : '600' }]}>{ACCENTS[a].label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Card>
          {msg ? <Notice tone={msg.startsWith('Not') ? 'bad' : 'good'} title={msg} /> : null}
        </>
      ) : null}
    </View>
  );
}
