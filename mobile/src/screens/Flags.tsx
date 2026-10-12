// Questions from the office. A flag is a question, not an accusation.
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { Body, Button, Card, Field, Pill, Screen, st } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';
import type { Flag } from '../types.ts';

const TITLE: Record<string, string> = {
  slow_to_site: 'Took long to reach site', not_started_on_site: 'On site but job not started', driving_without_job: 'Driving with no job open',
  off_route: 'Stop not on the route', open_card_24h: 'Job card open over 24 hours', timesheet_mismatch: 'Timesheet does not match',
  fuel_mismatch: 'Fuel entry looks wrong', arrived_outside_geofence: 'Arrived away from the store', manager_unavailable: 'Closed without signature',
  open_supply_run: 'Supply run', new_supplier: 'New supplier',
};

export function Flags() {
  const s = useStore();
  const nav = useNav();
  const flags = s.cache.flags;
  return (
    <Screen title="Questions" sub="Answer honestly; your supervisor reads this" onBack={nav.back} right={<SyncPill />}>
      {flags.length === 0 ? <Body quiet>Nothing to answer.</Body> : null}
      {flags.map(f => <FlagCard key={f.id} f={f} />)}
    </Screen>
  );
}

function FlagCard({ f }: { f: Flag }) {
  const s = useStore();
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answered = f.status !== 'open' || sent;
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pill text={answered ? 'Answered' : 'Needs your answer'} tone={answered ? 'good' : 'warn'} />
        <Text style={st.small}>{new Date(f.raised_at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</Text>
      </View>
      <Text style={[st.body, { fontWeight: '700' }]}>{TITLE[f.flag_type] ?? f.flag_type.replace(/_/g, ' ')}</Text>
      {f.question ? <Body>{f.question}</Body> : null}
      {f.explanation ? <Body quiet>Your answer: {f.explanation}</Body> : null}
      {sent && !f.explanation ? <Body quiet>Your answer: {text}</Body> : null}
      {!answered ? (
        <>
          <Field label="Your explanation" value={text} onChangeText={setText} multiline />
          {err ? <Text style={[st.small, { color: '#F0645A' }]}>{err}</Text> : null}
          <Button label="Send answer" onPress={() => {
            if (text.trim().length < 10) { setErr('give a proper explanation (at least a short sentence)'); return; }
            s.queue('Answer to a question from the office', { method: 'POST', path: `/flags/${f.id}/explain`, json: { explanation: text.trim() } });
            setSent(true);
          }} />
        </>
      ) : null}
    </Card>
  );
}
