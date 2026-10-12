// Shown instead of the sign-in screen in the test build that is shared for people to try.
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Heading, Label, Notice, Screen, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { REAL, realText as R } from '../demoReal.ts';

const STEPS: [string, string[]][] = [
  ['As technician (Thabo)', [
    'Book stock for a job: "Book stock before you leave" on My day.',
    'Open the urgent FreshMart Meerensee job: Go, Arrived (manager + safety ticks), Start.',
    'Open the work item, fill it in: you cannot press Done until everything is there.',
    'Sign off with the store manager signing on the screen.',
    'My stock: scan a supplier invoice (any photo) and confirm the lines it reads; return the contactor that must go back.',
    'Vehicle: tap the licence disc, choose Driving and do the handover inspection; tick a problem to see it reach the mechanic.',
    'On the vehicle card: Report a fault, or Release vehicle (km and where you left it).',
    'Queries: Zanele (the office) asked about an access card; answer her. Or send another technician a question.',
    'My tools and PPE (on My day): what the stockroom has on his name.',
    'Timesheet (on My day): yesterday\'s timesheet, made by the app from his jobs: travel, work, paused and time not accounted for. Check it and submit it; time not accounted for needs a word.',
  ]],
  ['As stock controller (Lindiwe)', [
    'To issue: open Thabo\'s request, tick each item as you pick it, then issue it.',
    'To receive: count and tick what Thabo sent back.',
    'Stock: the whole inventory by item or technician; Live: every movement as it happens; Issued register.',
    'Stock: three separate categories, Stock (parts for jobs), Tools and PPE. Technicians book only stock onto jobs. Change an item\'s category on the part screen.',
    'People: open a technician to see his van against his department\'s list and put what is missing on his van in one go (Thabo is short of capacitors and a contactor). The flag closes when it is complete.',
    'People: open anyone to see their PPE, the stock they hold and their tools (names only, no personal details). Sipho\'s boots are due for replacement: issue him gloves from stock, take something back (it goes back into stock), or write it off as lost or damaged with a note.',
    'To order: fills by itself as items drop below their minimum (fuses and contactors are low). Mark one as ordered; receiving the delivery takes it off.',
    'Open a part (Stock → the part → Open part): add a photo of it, set its minimum and supplier, and see where it was last used.',
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
  ['As department manager (Pieter)', [
    'He runs the Refrigeration department: Thabo, Sipho and Nomvula work under him. He assigns jobs, checks job cards and answers flags for his technicians; quotes, invoices and the stockroom only if the CEO adds them.',
    'Team map: where Thabo, Sipho and Nomvula are right now (on site, driving, parked), with the vehicle, the job and who they are with. Tap a name for "Open in Maps" or the profile. Ayanda is in Plumbing, so he is not on Pieter\'s map; the CEO sees everyone.',
    'Van stock: his department\'s list of spares every technician must carry. Thabo and Nomvula are short (flagged); Sipho is complete. Add an item or raise a quantity and see who goes short; every change is kept.',
    'Timesheets: his own technicians\' daily timesheets, for a day, a week or a month.',
    'Flags: a van that is short of the list stays flagged until the stockroom tops it up, then closes by itself.',
  ]],
  ['As HR (Precious)', [
    'Timesheets: daily, weekly or monthly, for one person, a department or everyone, with every job and flag on each sheet, and normal time, overtime (1.5×) and double time (Sundays and public holidays). She sets the normal day (8 hours to start). Ayanda has not submitted his last days. Print or save as PDF (one page per sheet, on the letterhead), or download for Excel. In this test drive the browser may block the print window and the download; the real app saves them.',
    'People: set anyone\'s position (technician, admin, department manager, stock controller) and a technician\'s trade. Mechanic, HR, director and CEO stay with the CEO.',
    'Departments: every department with its manager and the technicians under him. Move a technician to another department, or give Plumbing a manager. Each person is in one department; a manager runs one department, so moving Pieter takes him off Refrigeration.',
    'Staff records: open anyone under People to add an issue or a warning, or delete one (a line keeps who deleted it and when).',
    'She does not see jobs, quotes or the stockroom, and does not see ID numbers or home addresses (those stay with the CEO).',
  ]],
  ['As the office admin (Zanele)', [
    'She only sees the work the CEO switched on for her. By default: jobs, quotes and invoices, and stores.',
    'Invoices: two closed jobs are waiting. Make the invoice from the job card (labour from the job timers, call-out, parts), price the lines, send it, print it.',
    'Quotes: a draft and a sent one. Price and send the draft; mark the sent one accepted and open the job for the work.',
    'Accounts (Pastel): give each client its Pastel customer code and set the line codes, then make a Pastel batch to import into Sage Pastel Partner.',
    'Jobs: open a job for any technician (Thabo sees it on his phone at once), edit anything on it (every change is written on the job and the technician is told), move it, or cancel it.',
    'Queries: send any technician a question (switch to Tech to see it on Thabo\'s My day and answer it).',
    'People: she can see everyone, but cannot change positions unless the CEO switches on "Positions and access" for her.',
    'Stores: add a store by pasting its point from Google Maps.',
    'Ask the CEO to give her the stockroom: a Stockroom tab appears at the top and she has the stock controller\'s full screens.',
  ]],
  ['As the CEO (Lilanie)', [
    'The company logo is in the header of every screen and on every quote, invoice and timesheet. Change it under Accounts → Company ("Change the logo"); each company sets its own.',
    'Everything: the office, plus Stockroom and Fleet tabs at the top to open those screens.',
    'People: open a person for their picture, the vehicle they are in, where they are, the job they are busy with and who with, contact details, and (CEO only) personal details. A dropdown sets their position and a technician\'s trade.',
    'Staff record: on Ayanda\'s profile, add an issue or a warning (a warning needs the action taken and the reason). Delete one: it goes, but a line says who deleted a record and when. HR does this too; give Zanele "HR" work to let her as well.',
    'Tools and PPE: each profile shows what the stockroom has on that person\'s name.',
    'Departments: the same screen HR has. Ayanda is in Plumbing, which has no manager yet.',
    'Today: jobs, flags, handovers to approve, daily checks, safety faults and stock on one screen. Flags and Handovers: resolve and approve.',
  ]],
];

export function TesterWelcome() {
  const s = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [reset, setReset] = useState(false);
  const go = async (who: 'demo' | 'stock' | 'mech' | 'office' | 'admin' | 'manager' | 'hr') => { setBusy(who); await s.signIn('demo', '', who, 'demo'); setBusy(null); };
  return (
    <Screen title="Real Sandbox" sub={`Test drive · ${REAL ? REAL.company.name : 'ZSP'} job cards and stock`}>
      <View style={{ gap: 6 }}>
        <Text style={{ color: C.accent, fontSize: 28, fontWeight: '800' }}>Try it as anyone in the company</Text>
        {REAL ? (
          <Notice tone="info" title={`${REAL.company.name}'s real staff and customers`} lines={[
            'The people, customers and company details are real, from Servcraft. The jobs, stock, vehicles and prices are examples.',
            'Every warning, flag and hour not accounted for is on the Example Tech, a made-up technician, so nothing here is about a real person.',
            'It all stays in this browser. Once in, the bar at the top switches between people; what one does, the others see.',
          ]} />
        ) : <Body quiet>Everything here is made up and stays in this browser. Once in, the bar at the top switches between them; what one does, the others see. (The real app only shows each person their own.)</Body>}
      </View>
      <Button label={R('Open as technician (Thabo)')} onPress={() => go('demo')} busy={busy === 'demo'} />
      <Button label={R('Open as stock controller (Lindiwe)')} kind="secondary" onPress={() => go('stock')} busy={busy === 'stock'} />
      <Button label={R('Open as mechanic (Bongani)')} kind="secondary" onPress={() => go('mech')} busy={busy === 'mech'} />
      <Button label={R('Open as department manager (Pieter)')} kind="secondary" onPress={() => go('manager')} busy={busy === 'manager'} />
      <Button label={R('Open as HR (Precious)')} kind="secondary" onPress={() => go('hr')} busy={busy === 'hr'} />
      <Button label={R('Open as office admin (Zanele)')} kind="secondary" onPress={() => go('admin')} busy={busy === 'admin'} />
      <Button label={R('Open as CEO (Lilanie)')} kind="secondary" onPress={() => go('office')} busy={busy === 'office'} />
      {STEPS.map(([title, lines]) => (
        <Card key={title}>
          <Heading>{R(title)}</Heading>
          {lines.map((l, i) => <Text key={i} style={[st.body, { color: C.text }]}>{i + 1}. {R(l)}</Text>)}
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
