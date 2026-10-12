// My day: the vehicle he's in, flags to answer, and today's jobs in the order they matter.
import React, { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { Body, Button, Card, Label, Notice, Pill, Toggle, st } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';
import { C, S } from '../theme.ts';
import type { TodayJob } from '../types.ts';

const STATUS: Record<TodayJob['status'], { text: string; tone: 'info' | 'good' | 'warn' | 'quiet' }> = {
  assigned: { text: 'Not started', tone: 'quiet' },
  in_progress: { text: 'In progress', tone: 'info' },
  continue_later: { text: 'Continue later', tone: 'warn' },
  closed: { text: 'Closed', tone: 'good' },
};
const TYPE: Record<string, string> = {
  breakdown: 'Breakdown', planned_maintenance: 'Planned maintenance', installation: 'Installation', quote_visit: 'Quote visit', follow_up: 'Follow-up',
};
const rank = (j: TodayJob) => (j.status === 'closed' ? 9 : j.status === 'in_progress' ? 0 : j.priority === 'urgent' ? 1 : j.carried_over ? 2 : 3);

export function Day() {
  const s = useStore();
  const nav = useNav();
  const ins = useSafeAreaInsets();
  const [pulling, setPulling] = useState(false);
  useEffect(() => { s.refresh(); }, []);

  const t = s.cache.today;
  const jobs = [...(t?.jobs ?? [])].sort((a, b) => rank(a) - rank(b));
  const open = s.cache.flags.filter(f => f.status === 'open');
  const dateText = new Date().toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <View style={[st.screen, { paddingTop: ins.top }]}>
      <View style={st.header}>
        <View style={{ flex: 1 }}>
          <Text style={st.title} numberOfLines={1}>{s.session?.user.name ?? 'My day'}</Text>
          <Text style={st.sub}>{dateText}</Text>
        </View>
        <SyncPill />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: S.pad * 3 }}
        refreshControl={<RefreshControl refreshing={pulling} tintColor={C.text}
          onRefresh={async () => { setPulling(true); await s.syncNow(); await s.refresh(); setPulling(false); }} />}
      >
        {s.blocked ? (
          <Card onPress={() => nav.push({ name: 'sync' })} style={{ borderColor: C.bad }}>
            <Notice tone="bad" title="The office refused something you sent" lines={[s.blocked.entry.label, 'Tap to see why and fix it.']} />
          </Card>
        ) : null}

        <Card onPress={() => nav.push({ name: 'scan' })} accessibilityLabel="Vehicle">
          <Label>Vehicle</Label>
          {t?.vehicle ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text style={{ color: C.text, fontSize: S.big, fontWeight: '800', letterSpacing: 1 }}>{t.vehicle.registration}</Text>
              <Pill text={t.vehicle.mode === 'driving' ? 'Driving' : 'Riding along'} tone={t.vehicle.mode === 'driving' ? 'info' : 'quiet'} />
            </View>
          ) : (
            <Body>Not scanned into a vehicle. Tap to scan the barcode.</Body>
          )}
        </Card>

        {open.length ? (
          <Card onPress={() => nav.push({ name: 'flags' })} style={{ borderColor: C.warn }}>
            <Notice tone="warn" title={`${open.length} question${open.length > 1 ? 's' : ''} from the office`} lines={['Tap to answer. Your explanation goes to your supervisor.']} />
          </Card>
        ) : null}

        <Text style={st.heading}>Today's jobs</Text>
        {!t ? <Body quiet>{s.online ? 'Loading…' : 'No signal and nothing saved on the phone yet.'}</Body> : null}
        {t && jobs.length === 0 ? <Body quiet>No jobs assigned to you today.</Body> : null}
        {jobs.map(j => (
          <Card key={j.id} onPress={() => nav.push({ name: 'job', jobId: j.id })} accessibilityLabel={`Job ${j.job_number} at ${j.store}`}
            style={j.priority === 'urgent' && j.status !== 'closed' ? { borderLeftWidth: 5, borderLeftColor: C.bad } : undefined}>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Text style={{ color: C.quiet, fontWeight: '700' }}>#{j.job_number}</Text>
              <Pill text={STATUS[j.status].text} tone={STATUS[j.status].tone} />
              {j.priority === 'urgent' ? <Pill text="Urgent" tone="bad" /> : null}
              {j.carried_over ? <Pill text="From earlier" tone="warn" /> : null}
            </View>
            <Text style={{ color: C.text, fontSize: 20, fontWeight: '700' }}>{j.store}</Text>
            <Body quiet>{TYPE[j.job_type] ?? j.job_type}{j.address ? ` · ${j.address}` : ''}</Body>
            <Body numberOfLines={2}>{j.fault_reported}</Body>
          </Card>
        ))}

        <Text style={st.heading}>Other</Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button label="Fuel" kind="secondary" onPress={() => nav.push({ name: 'fuel' })} style={{ flex: 1 }} />
          <Button label="Questions" kind="secondary" onPress={() => nav.push({ name: 'flags' })} style={{ flex: 1 }} />
        </View>

        {s.session?.mode === 'demo' ? (
          <Card>
            <Label>Demo</Label>
            <Toggle label="Pretend there is no signal" value={s.demoNoSignal} onChange={s.setDemoNoSignal} />
            <Text style={st.small}>Work saves on the phone and sends when you switch this off.</Text>
          </Card>
        ) : null}
        <Button label="Sign out" kind="quiet" onPress={s.signOut} disabled={s.waiting > 0} />
        {s.waiting > 0 ? <Text style={st.small}>You can sign out once everything waiting has been sent.</Text> : null}
      </ScrollView>
    </View>
  );
}
