// Carry on the numbering from the previous system: the next job card, invoice, quote, credit note and
// purchase order numbers. The CEO or Accounts sets them; never at or below a number already used.
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Field, Notice, st } from '../ui.tsx';
import { C } from '../theme.ts';

interface Num { kind: string; label: string; next: number; highestUsed: number | null }

export function NumbersForm({ changed }: { changed?: () => void }) {
  const s = useStore();
  const [d, setD] = useState<{ numbers: Num[]; checked: boolean } | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [ans, setAns] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => s.ask({ method: 'GET', path: '/setup/numbers' }).then(r => {
    if (r?.status === 200) { const b = r.body as { numbers: Num[]; checked: boolean }; setD(b); setF(Object.fromEntries(b.numbers.map(n => [n.kind, String(n.next)]))); }
    else setAns({ ok: false, lines: (r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.'] });
  });
  useEffect(() => { load(); }, []);
  if (!d) return ans ? <Notice tone="bad" title="Could not load" lines={ans.lines} /> : <Body quiet>Loading…</Body>;
  const save = async () => {
    const next = Object.fromEntries(d.numbers.filter(n => String(n.next) !== (f[n.kind] ?? '').trim()).map(n => [n.kind, Number((f[n.kind] ?? '').replace(/\s/g, ''))]));
    setBusy(true);
    const r = await s.ask({ method: 'PUT', path: '/setup/numbers', json: { next, checked: true } });
    setBusy(false);
    if (r && r.status < 300) { const b = r.body as { numbers: Num[]; checked: boolean }; setD(b); setF(Object.fromEntries(b.numbers.map(n => [n.kind, String(n.next)]))); setAns({ ok: true, lines: ['Saved: the next ones get these numbers.'] }); changed?.(); }
    else setAns({ ok: false, lines: (r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.'] });
  };
  return (
    <Card>
      <Text style={st.small}>Type the next number for each, carrying on from your previous system (e.g. your last invoice was 48000: type 48001). A number can't be at or below one already used here.</Text>
      {d.numbers.map(n => (
        <View key={n.kind} style={{ gap: 2 }}>
          <Field label={`Next ${n.label.toLowerCase().replace(/s$/, '')} number`} value={f[n.kind] ?? ''} onChangeText={t => setF(x => ({ ...x, [n.kind]: t }))} keyboardType="number-pad" />
          <Text style={[st.small, { color: C.quiet }]}>{n.highestUsed ? `Highest used here so far: ${n.highestUsed}` : 'None made here yet'}</Text>
        </View>
      ))}
      {ans ? <Notice tone={ans.ok ? 'good' : 'bad'} title={ans.ok ? 'Saved' : 'Not saved'} lines={ans.lines} /> : null}
      <Button label={d.checked ? 'Save the numbers' : 'These numbers are right'} busy={busy} onPress={save} />
    </Card>
  );
}
