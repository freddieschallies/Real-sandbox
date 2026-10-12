// Shown instead of the sign-in screen in the test build that is shared for people to try.
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Heading, Label, Notice, Screen, st } from '../ui.tsx';
import { C } from '../theme.ts';

const STEPS: [string, string[]][] = [
  ['As technician (Thabo)', [
    'Book stock for a job: "Book stock before you leave" on My day.',
    'Open the urgent FreshMart Meerensee job: Go, Arrived (manager + safety ticks), Start.',
    'Open the work item, fill it in: you cannot press Done until everything is there.',
    'Sign off with the store manager signing on the screen.',
    'My stock: scan a supplier invoice (any photo) and confirm the lines it reads; return the contactor that must go back.',
    'Vehicle: type any code, choose Driving and do the handover inspection.',
  ]],
  ['As stock controller (Lindiwe)', [
    'To issue: open Thabo\'s request, tick each item as you pick it, then issue it.',
    'To receive: count and tick what Thabo sent back.',
    'Stockroom: receive a delivery; New items: give the invoice\'s new items a code.',
  ]],
];

export function TesterWelcome() {
  const s = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [reset, setReset] = useState(false);
  const go = async (who: 'demo' | 'stock') => { setBusy(who); await s.signIn('demo', '', who, 'demo'); setBusy(null); };
  return (
    <Screen title="Real Sandbox" sub="Test drive · ZSP job cards and stock">
      <View style={{ gap: 6 }}>
        <Text style={{ color: C.accent, fontSize: 28, fontWeight: '800' }}>Try it as either person</Text>
        <Body quiet>Everything here is made up and stays in this browser. Switch between the two with Sign out; what one does, the other sees.</Body>
      </View>
      <Button label="Open as technician" onPress={() => go('demo')} busy={busy === 'demo'} />
      <Button label="Open as stock controller" kind="secondary" onPress={() => go('stock')} busy={busy === 'stock'} />
      {STEPS.map(([title, lines]) => (
        <Card key={title}>
          <Heading>{title}</Heading>
          {lines.map((l, i) => <Text key={i} style={[st.body, { color: C.text }]}>{i + 1}. {l}</Text>)}
        </Card>
      ))}
      <Card>
        <Label>Good to know</Label>
        <Text style={st.small}>The real app runs on the technicians' phones and works without signal. Photos here come from a file picker; on a phone they use the camera. The tracker, the office dashboard and supplier invoice reading by AI are not part of this test.</Text>
      </Card>
      {reset ? <Notice tone="good" title="Demo data reset" lines={['Back to the start: same jobs, same stock.']} /> : null}
      <Button label="Start over with fresh demo data" kind="quiet" onPress={async () => { await s.resetDemo(); setReset(true); }} />
    </Screen>
  );
}
