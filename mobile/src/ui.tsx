import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, S } from './theme.ts';

export function Screen({ title, sub, onBack, right, children, footer }: {
  title: string; sub?: string; onBack?: () => void; right?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode;
}) {
  const ins = useSafeAreaInsets();
  return (
    <View style={[st.screen, { paddingTop: ins.top }]}>
      <View style={st.header}>
        {onBack ? (
          <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" style={st.back} hitSlop={8}>
            <Text style={st.backText}>‹</Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }}>
          <Text style={st.title} numberOfLines={1}>{title}</Text>
          {sub ? <Text style={st.sub} numberOfLines={1}>{sub}</Text> : null}
        </View>
        {right}
      </View>
      <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: S.pad * 2 }} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
      {footer ? <View style={[st.footer, { paddingBottom: Math.max(ins.bottom, S.pad) }]}>{footer}</View> : null}
    </View>
  );
}

type Kind = 'primary' | 'secondary' | 'danger' | 'quiet';
export function Button({ label, onPress, kind = 'primary', disabled, busy, style }: {
  label: string; onPress: () => void; kind?: Kind; disabled?: boolean; busy?: boolean; style?: ViewStyle;
}) {
  const bg = { primary: C.accent, secondary: C.panel2, danger: C.badBg, quiet: 'transparent' }[kind];
  const fg = { primary: C.accentText, secondary: C.text, danger: C.bad, quiet: C.quiet }[kind];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy) }}
      style={({ pressed }) => [st.button, { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }, kind === 'quiet' && { borderWidth: 1, borderColor: C.line }, style]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[st.buttonText, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

export function Card({ children, style, onPress, accessibilityLabel }: { children: React.ReactNode; style?: ViewStyle; onPress?: () => void; accessibilityLabel?: string }) {
  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [st.card, style, pressed && { backgroundColor: C.panel2 }]}>
        {children}
      </Pressable>
    );
  }
  return <View style={[st.card, style]}>{children}</View>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={st.label}>{children}</Text>;
}

export function Body({ children, quiet, style, numberOfLines }: { children: React.ReactNode; quiet?: boolean; style?: object; numberOfLines?: number }) {
  return <Text numberOfLines={numberOfLines} style={[st.body, quiet && { color: C.quiet }, style]}>{children}</Text>;
}

export function Heading({ children }: { children: React.ReactNode }) {
  return <Text style={st.heading}>{children}</Text>;
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Label>{label}</Label>
      <TextInput
        placeholderTextColor={C.quiet}
        style={[st.input, props.multiline && { minHeight: 110, textAlignVertical: 'top', paddingTop: 14 }]}
        accessibilityLabel={label}
        {...props}
      />
      {hint ? <Text style={st.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable onPress={() => onChange(!value)} accessibilityRole="switch" accessibilityState={{ checked: value }} style={st.toggleRow}>
      <Text style={[st.body, { flex: 1 }]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: C.accent, false: C.line }} thumbColor={C.text} />
    </Pressable>
  );
}

export function Choice<T extends string>({ options, value, onChange, labels }: {
  options: readonly T[]; value?: T; onChange: (v: T) => void; labels?: Partial<Record<T, string>>;
}) {
  return (
    <View style={st.choices}>
      {options.map(o => {
        const on = o === value;
        return (
          <Pressable key={o} onPress={() => onChange(o)} accessibilityRole="radio" accessibilityState={{ selected: on }}
            style={[st.choice, on && { backgroundColor: C.accent, borderColor: C.accent }]}>
            <Text style={[st.choiceText, on && { color: C.accentText, fontWeight: '700' }]}>{labels?.[o] ?? o.replace(/_/g, ' ')}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Pill({ text, tone = 'info' }: { text: string; tone?: 'info' | 'good' | 'warn' | 'bad' | 'quiet' }) {
  const map = { info: [C.infoBg, C.info], good: [C.goodBg, C.good], warn: [C.warnBg, C.warn], bad: [C.badBg, C.bad], quiet: [C.panel2, C.quiet] }[tone];
  return (
    <View style={[st.pill, { backgroundColor: map[0] }]}>
      <Text style={[st.pillText, { color: map[1] }]}>{text}</Text>
    </View>
  );
}

export function Notice({ tone = 'warn', title, lines }: { tone?: 'warn' | 'bad' | 'good' | 'info'; title: string; lines?: string[] }) {
  const map = { info: [C.infoBg, C.info], good: [C.goodBg, C.good], warn: [C.warnBg, C.warn], bad: [C.badBg, C.bad] }[tone];
  return (
    <View style={[st.notice, { backgroundColor: map[0], borderColor: map[1] }]} accessibilityRole="alert">
      <Text style={[st.body, { fontWeight: '700', color: C.text }]}>{title}</Text>
      {lines?.map((l, i) => <Text key={i} style={[st.small, { color: C.text }]}>• {l}</Text>)}
    </View>
  );
}

export const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: S.pad, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line, minHeight: 64 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -8 },
  backText: { color: C.text, fontSize: 36, lineHeight: 38 },
  title: { color: C.text, fontSize: S.title, fontWeight: '700' },
  sub: { color: C.quiet, fontSize: S.small },
  footer: { padding: S.pad, gap: 10, borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.bg },
  button: { minHeight: S.touch, borderRadius: S.radius, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  buttonText: { fontSize: 18, fontWeight: '700' },
  card: { backgroundColor: C.panel, borderRadius: S.radius, padding: S.pad, gap: 8, borderWidth: 1, borderColor: C.line },
  label: { color: C.quiet, fontSize: S.small, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  body: { color: C.text, fontSize: S.body, lineHeight: 24 },
  small: { color: C.quiet, fontSize: S.small, lineHeight: 20 },
  heading: { color: C.text, fontSize: 19, fontWeight: '700', marginTop: 8 },
  hint: { color: C.quiet, fontSize: 13 },
  input: { backgroundColor: C.panel2, color: C.text, fontSize: S.body, borderRadius: S.radius, paddingHorizontal: 14, minHeight: S.touch, borderWidth: 1, borderColor: C.line },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: S.touch },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { minHeight: 48, paddingHorizontal: 14, borderRadius: 24, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', backgroundColor: C.panel2 },
  choiceText: { color: C.text, fontSize: 16, textTransform: 'capitalize' },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, alignSelf: 'flex-start' },
  pillText: { fontSize: 13, fontWeight: '700' },
  notice: { borderRadius: S.radius, padding: 14, gap: 4, borderLeftWidth: 4 },
});
