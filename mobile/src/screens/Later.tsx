// Continue later: the job stays open over days, but only with a proper progress note and a return date.
import React, { useEffect, useState } from 'react';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { nowIso } from '../device.ts';
import { J } from '../local.ts';
import { Body, Button, Choice, Field, Label, Notice, Screen } from '../ui.tsx';
import { SyncPill } from './SyncPill.tsx';

const REASONS = ['more_work_needed', 'waiting_for_parts', 'store_access', 'waiting_for_quote_approval', 'other'] as const;
const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

// What he filled in, kept while he goes off to make the parts report and comes back.
type Draft = { progress: string; reason?: J.UnfinishedReason; when?: string; manager: string; quote?: 'yes' | 'no' };
const drafts = new Map<string, Draft>();

export function Later({ jobId }: { jobId: string }) {
  const s = useStore();
  const nav = useNav();
  const v = s.cache.cards[jobId];
  const d0 = drafts.get(jobId);
  const visitStart0 = v?.visits.at(-1)?.goAt ?? v?.visits.at(-1)?.arrivedAt ?? '';
  const madeReport = (v?.parts_reports ?? []).some(r => r.created_at >= visitStart0);
  const [progress, setProgress] = useState(d0?.progress ?? '');
  const [reason, setReason] = useState<J.UnfinishedReason | undefined>(d0?.reason);
  const [when, setWhen] = useState<string | undefined>(d0?.when);
  const [manager, setManager] = useState(d0?.manager ?? v?.visits.at(-1)?.checkedInManager ?? '');
  const [reasons, setReasons] = useState<string[] | null>(null);
  const [quote, setQuote] = useState<'yes' | 'no' | undefined>(d0?.quote ?? (madeReport ? 'yes' : undefined));
  useEffect(() => { drafts.set(jobId, { progress, reason, when, manager, quote }); }, [jobId, progress, reason, when, manager, quote]);
  if (!v) return <Screen title="Continue later" onBack={nav.back}><Body quiet>Not found on the phone.</Body></Screen>;

  const days = [1, 2, 3, 7].map(n => ymd(new Date(Date.now() + n * 86_400_000)));
  const dayLabels = Object.fromEntries(days.map((d, i) => [d, ['Tomorrow', 'In 2 days', 'In 3 days', 'Next week'][i] + ` (${d.slice(5)})`]));

  // His department asks for the parts report when another quote is needed: made on this visit.
  const asks = !!v.parts_report_required;
  const visitStart = v.visits.at(-1)?.goAt ?? v.visits.at(-1)?.arrivedAt ?? '';
  const report = (v.parts_reports ?? []).find(r => r.created_at >= visitStart);
  const submit = () => {
    if (!reason) { setReasons(['why the job is not finished']); return; }
    if (asks && !quote) { setReasons(['whether another quote is needed for parts']); return; }
    if (asks && quote === 'yes' && !report) { setReasons(['the parts report first: tap "Make the parts report"']); return; }
    const body = { at: nowIso(), progress: progress.trim(), reason, plannedReturn: when ?? '', managerInformed: manager.trim(), ...(asks ? { quoteNeeded: quote === 'yes' } : {}) };
    const r = s.jobAction(jobId, `Continue later at ${v.store}`, c => J.continueLater(c, body),
      { method: 'POST', path: `/jobs/${jobId}/continue-later`, json: body });
    if (!r.ok) { setReasons(r.reasons); return; }
    drafts.delete(jobId);
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
      {asks ? (
        <>
          <Label>Is another quote needed (parts)?</Label>
          <Choice options={['yes', 'no'] as const} value={quote} onChange={setQuote} labels={{ yes: 'Yes, parts are needed', no: 'No' }} />
          {quote === 'yes' ? (report
            ? <Notice tone="good" title={`Parts report ${report.report_number} sent`} lines={[`${report.part_description}${report.quote_number ? ` · quote ${report.quote_number} is with the office` : ''}`]} />
            : <>
                <Body quiet>Before you leave: a short report the office turns into a quote. Photos of the machine, the serial tag and the part.</Body>
                <Button label="Make the parts report" onPress={() => nav.push({ name: 'partsReport', jobId })} />
              </>) : null}
        </>
      ) : null}
      <Label>Coming back</Label>
      <Choice options={days} value={when} onChange={setWhen} labels={dayLabels} />
      {v.visits.at(-1)?.place === 'workshop' ? null : <Field label="Store manager informed" value={manager} onChangeText={setManager} autoCapitalize="words" />}
      {reasons ? <Notice tone="bad" title="Not yet. Still needed:" lines={reasons} /> : null}
      <Button label="Leave site – continue later" onPress={submit} />
    </Screen>
  );
}
