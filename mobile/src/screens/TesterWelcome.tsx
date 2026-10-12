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
    'Vehicle: tap the licence disc, choose Driving and do the handover inspection; tick a problem to see it reach the mechanic.',
    'On the vehicle card: Report a fault, or Release vehicle (km and where you left it).',
  ]],
  ['As stock controller (Lindiwe)', [
    'To issue: open Thabo\'s request, tick each item as you pick it, then issue it.',
    'To receive: count and tick what Thabo sent back.',
    'Stock: the whole inventory by item or technician; Live: every movement as it happens; Issued register.',
    'Workshop: what the mechanic keeps and the minimums. Issue oil from the stockroom to the workshop, set which oil the daily checks use, take stock back.',
    'Small company with no mechanic? Turn on the switch under the top bar: the CEO gives Lindiwe the mechanic\'s work too, and she switches between "My work" and "Fleet".',
  ]],
  ['As mechanic (Bongani)', [
    'Vehicles: five vans; one in the workshop, one off the road, one with an expired licence disc.',
    'Daily checks: odometer, oil, water and tyres on each vehicle in service. Oil added must be noted in litres; ND 503-221 already needed oil twice this week, so top it up again and see it flagged.',
    'Faults: Thabo\'s reports and handover problems land here, worst first.',
    'Open ND 412-778, start a job card for the windscreen crack, fill it in and complete it.',
    'Take ND 412-778 off the road (Status), then sign in as Thabo and try to drive it: it is refused.',
    'Map: where every vehicle is (moving, parked, no signal). Tap a vehicle for the driver and "Open in Maps".',
    'Bookings: book a vehicle in for a service or repair (driver is told), move or cancel it, and open the job card when it arrives.',
    'Stock: his own workshop stock (oil, coolant, filters, pads). Dip the oil drum: a little short is allowed and recorded; a lot short goes to the office. Note a spill straight away. Parts on a job card can come from it.',
    'Techs: Thabo\'s phone is broken, so put him in a vehicle yourself (or take it off his name). Switch to Tech to see it on his My day.',
  ]],
  ['As the office admin (Zanele)', [
    'She only sees the work the CEO switched on for her. By default: jobs and stores (quotes and invoices come next).',
    'Jobs: open a job for any technician (Thabo sees it on his phone at once), edit anything on it (every change is written on the job and the technician is told), move it, or cancel it.',
    'Stores: add a store by pasting its point from Google Maps.',
    'Ask the CEO to give her the stockroom: a Stockroom tab appears at the top and she has the stock controller\'s full screens.',
  ]],
  ['As the CEO (Lilanie)', [
    'Everything: the office, plus Stockroom and Fleet tabs at the top to open those screens.',
    'People: set each person\'s position and switch their work on or off: jobs, quotes and invoices, stores, stockroom, fleet, flags and approvals, prices.',
    'Today: jobs, flags, handovers to approve, daily checks, safety faults and stock on one screen. Flags and Handovers: resolve and approve.',
  ]],
];

export function TesterWelcome() {
  const s = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [reset, setReset] = useState(false);
  const go = async (who: 'demo' | 'stock' | 'mech' | 'office' | 'admin') => { setBusy(who); await s.signIn('demo', '', who, 'demo'); setBusy(null); };
  return (
    <Screen title="Real Sandbox" sub="Test drive · ZSP job cards and stock">
      <View style={{ gap: 6 }}>
        <Text style={{ color: C.accent, fontSize: 28, fontWeight: '800' }}>Try it as any of the five</Text>
        <Body quiet>Everything here is made up and stays in this browser. Once in, the bar at the top switches between them; what one does, the others see. (The real app only shows each person their own.)</Body>
      </View>
      <Button label="Open as technician" onPress={() => go('demo')} busy={busy === 'demo'} />
      <Button label="Open as stock controller" kind="secondary" onPress={() => go('stock')} busy={busy === 'stock'} />
      <Button label="Open as mechanic" kind="secondary" onPress={() => go('mech')} busy={busy === 'mech'} />
      <Button label="Open as office admin (Zanele)" kind="secondary" onPress={() => go('admin')} busy={busy === 'admin'} />
      <Button label="Open as CEO (Lilanie)" kind="secondary" onPress={() => go('office')} busy={busy === 'office'} />
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
