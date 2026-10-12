// Continue later: the job stays open over days, but only with a proper progress note and a return date.
import React, { useState } from 'react';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso } from '../device.ts';
import { J } from '../local.ts';
import { Body, Button, Choice, Field, Label, Notice, Screen } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';

const REASONS = ['more_work_needed', 'waiting_for_parts', 'store_access', 'waiting_for_quote_approval', 'other'] as const;
const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

export function Later({ jobId }: { jobId: string }) {
  const s = useStore();
  const nav = useNav();
  const v = s.cache.cards[jobId];
  const [progress, setProgress] = useState('');
  const [reason, setReason] = useState<J.UnfinishedReason>();
  const [when, setWhen] = useState<string>();
  const [manager, setManager] = useState(v?.visits.at(-1)?.checkedInManager ?? '');
  const [reasons, setReasons] = useState<string[] | null>(null);
  if (!v) return <Screen title="Continue later" onBack={nav.back}><Body quiet>Not found on the phone.</Body></Screen>;

  const days = [1, 2, 3, 7].map(n => ymd(new Date(Date.now() + n * 86_400_000)));
  const dayLabels = Object.fromEntries(days.map((d, i) => [d, ['Tomorrow', 'In 2 days', 'In 3 days', 'Next week'][i] + ` (${d.slice(5)})`]));

  const submit = () => {
    if (!reason) { setReasons(['why the job is not finished']); return; }
    const body = { at: nowIso(), progress: progress.trim(), reason, plannedReturn: when ?? '', managerInformed: manager.trim() };
    const r = s.jobAction(jobId, `Continue later at ${v.store}`, c => J.continueLater(c, body),
      { method: 'POST', path: `/jobs/${jobId}/continue-later`, json: body });
    if (!r.ok) { setReasons(r.reasons); return; }
    nav.reset();
  };

  return (
    <Screen title="Continue later" sub={`#${v.job_number} · ${v.store}`} onBack={nav.back} right={<SyncPill />}>
      <Body quiet>The job stays open. Without Continue later, a job card open for more than 24 hours is flagged.</Body>
      {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}
      <Field label="Progress so far" value={progress} onChangeText={setProgress} multiline
        hint="A full sentence: what is done and what is left." />
      <Label>Why not finished?</Label>
      <Choice options={REASONS} value={reason} onChange={setReason} />
      <Label>Coming back</Label>
      <Choice options={days} value={when} onChange={setWhen} labels={dayLabels} />
      <Field label="Store manager informed" value={manager} onChangeText={setManager} autoCapitalize="words" />
      {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}
      <Button label="Leave site – continue later" onPress={submit} />
    </Screen>
  );
}
