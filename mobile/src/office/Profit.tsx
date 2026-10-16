// What the jobs made: invoiced (less credit notes) against what they cost (technicians' time on site
// and driving, km, parts at cost, items bought). Per client, technician, month, and job by job,
// worst first, so the jobs that lose money stand out. For the CEO and Accounts.
import { ExportBar } from '../exportDoc.tsx';
import { escHtml, letterPage } from '../letterhead.tsx';
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import * as D from '../../../server/src/core/documents.ts';
import type { JobProfit, ProfitGroup } from '../../../server/src/core/profit.ts';
import { Body, Card, Choice, Notice, Pill, st } from '../ui.tsx';
import { C } from '../theme.ts';

const R = (c: number) => D.rand(c);
const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
type Range = '30' | '90' | 'year';
type By = 'client' | 'technician' | 'month' | 'jobs';
const MONTH = (k: string) => new Date(`${k}-15T12:00:00+02:00`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });

function Money({ label, cents, tone }: { label: string; cents: number; tone?: 'good' | 'bad' }) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 130 }}>
      <Text style={st.small}>{label}</Text>
      <Text style={{ fontSize: 20, fontWeight: '800', color: tone ? C[tone] : C.text }}>{R(cents)}</Text>
    </View>
  );
}

function Margin({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  return <Pill text={`${pct}%`} tone={pct < 0 ? 'bad' : pct < 15 ? 'warn' : 'good'} />;
}

export function ProfitView({ openJob }: { openJob: (jobId: string) => void }) {
  const s = useStore();
  const [range, setRange] = useState<Range>('90');
  const [by, setBy] = useState<By>('client');
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    const now = new Date();
    const from = range === 'year' ? `${now.getFullYear()}-01-01` : ymd(new Date(Date.now() - Number(range) * 86_400_000));
    s.ask({ method: 'GET', path: `/office/profit?from=${from}&to=${ymd(now)}` }).then(r => { if (r?.status === 200) setD(r.body); });
  }, [range]);
  if (!d) return <Body quiet>Working it out…</Body>;
  const t = d.totals;
  const groups: ProfitGroup[] = by === 'client' ? d.byClient : by === 'technician' ? d.byTechnician : by === 'month' ? d.byMonth : [];
  const jobs: JobProfit[] = [...d.jobs].sort((a: JobProfit, b: JobProfit) => (a.profitCents ?? Infinity) - (b.profitCents ?? Infinity));
  return (
    <>
      <Choice options={['30', '90', 'year'] as const} value={range} onChange={setRange} labels={{ 30: 'Last 30 days', 90: 'Last 90 days', year: 'This year' }} />
      {!d.ratesSet ? <Notice tone="warn" title="Set what the work costs us first" lines={['Accounts → Company details and rates (the CEO): what an hour of a technician costs, and what a km costs. Until then labour and travel count as nothing.']} /> : null}
      <Card>
        <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
          <Money label="Invoiced (excl. VAT, less credits)" cents={t.revenueCents} />
          <Money label="Cost" cents={t.costCents} />
          <Money label="Profit" cents={t.profitCents} tone={t.profitCents < 0 ? 'bad' : 'good'} />
        </View>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Margin pct={t.marginPct} />
          <Text style={st.small}>{t.jobs} job{t.jobs === 1 ? '' : 's'} closed and invoiced (or at no charge){t.notInvoiced ? ` · ${t.notInvoiced} closed, not invoiced yet (not counted)` : ''}</Text>
        </View>
        <Text style={st.small}>Cost: technicians' hours on site and driving at {R(d.rates.labourCostPerHourCents)} an hour, km at {R(d.rates.vehicleCostPerKmCents)}, parts at their latest cost, and items bought for the job.</Text>
      </Card>
      <ExportBar title="Export this profit report" make={() => {
        const e = escHtml, rr = (c: number | null) => (c == null ? '–' : R(c)), pct = (x: number | null) => (x == null ? '–' : `${x}%`);
        const grp = (title: string, list: ProfitGroup[], month = false) => `<h3>${title}</h3><table><tr><th>${month ? 'Month' : title.replace('By ', '')}</th><th class=r>Jobs</th><th class=r>Invoiced</th><th class=r>Cost</th><th class=r>Profit</th><th class=r>Margin</th></tr>${list.map(g => `<tr><td>${e(month ? MONTH(g.key) : g.key)}</td><td class=r>${g.jobs}</td><td class=r>${rr(g.revenueCents)}</td><td class=r>${rr(g.costCents)}</td><td class="r ${g.profitCents < 0 ? 'bad' : ''}">${rr(g.profitCents)}</td><td class=r>${pct(g.marginPct)}</td></tr>`).join('')}</table>`;
        const label = range === 'year' ? 'This year' : `Last ${range} days`;
        const body = `<h2>Profit · ${e(label)}</h2><p><b>Invoiced</b> ${rr(t.revenueCents)} · <b>Cost</b> ${rr(t.costCents)} · <b>Profit</b> ${rr(t.profitCents)} · <b>Margin</b> ${pct(t.marginPct)} · ${t.jobs} jobs${t.notInvoiced ? ` (${t.notInvoiced} closed, not invoiced yet)` : ''}</p>
${grp('By client', d.byClient)}${grp('By technician', d.byTechnician)}${grp('By month', d.byMonth, true)}
<h3>Job by job</h3><table><tr><th>Job</th><th>Client / store</th><th>Technician</th><th class=r>Invoiced</th><th class=r>Labour</th><th class=r>Travel</th><th class=r>Parts</th><th class=r>Profit</th></tr>${jobs.map(j => `<tr><td>${j.jobNumber}</td><td>${e(j.client)}<br><span class=muted>${e(j.store)}</span></td><td>${e(j.technician)}</td><td class=r>${j.noCharge ? 'No charge' : rr(j.revenueCents)}</td><td class=r>${rr(j.labourCostCents)}</td><td class=r>${rr(j.travelCostCents)}</td><td class=r>${rr(j.partsCostCents + j.boughtOutCents)}</td><td class="r ${(j.profitCents ?? 0) < 0 ? 'bad' : ''}">${rr(j.profitCents)}</td></tr>`).join('')}</table>`;
        return { kind: 'profit', title: `Profit report – ${label}`, html: letterPage({ title: `Profit report – ${label}`, label: 'PROFIT REPORT', company: s.session?.company.name ?? '', body, landscape: true }) };
      }} />
      <Choice options={['client', 'technician', 'month', 'jobs'] as const} value={by} onChange={setBy} labels={{ client: 'By client', technician: 'By technician', month: 'By month', jobs: 'Job by job' }} />
      {by !== 'jobs' ? groups.map(g => (
        <Card key={g.key}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]} numberOfLines={1}>{by === 'month' ? MONTH(g.key) : g.key}</Text>
            <Margin pct={g.marginPct} />
          </View>
          <Text style={st.small}>{g.jobs} job{g.jobs === 1 ? '' : 's'}{g.noCharge ? ` (${g.noCharge} at no charge)` : ''} · invoiced {R(g.revenueCents)} · cost {R(g.costCents)}</Text>
          <Text style={[st.body, { fontWeight: '800', color: g.profitCents < 0 ? C.bad : C.good }]}>Profit {R(g.profitCents)}</Text>
        </Card>
      )) : jobs.map(j => (
        <Card key={j.jobId} onPress={() => openJob(j.jobId)} accessibilityLabel={`Profit on job ${j.jobNumber}`}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={[st.body, { fontWeight: '800', flex: 1 }]} numberOfLines={1}>#{j.jobNumber} · {j.store}</Text>
            {j.profitCents === null ? <Pill text="Not invoiced" tone="quiet" /> : j.noCharge ? <Pill text="No charge" tone="warn" /> : <Margin pct={j.marginPct} />}
          </View>
          <Text style={st.small}>
            {j.client} · {j.technician} · closed {j.closed}
          </Text>
          <Text style={st.small}>
            Invoiced {j.revenueCents === null ? '–' : R(j.noCharge ? 0 : j.revenueCents)} · labour {R(j.labourCostCents)} ({Math.round(j.labourMinutes / 6) / 10} h) · travel {R(j.travelCostCents)} ({j.km} km{j.kmEstimated ? ', estimated' : ''}) · parts {R(j.partsCostCents)}{j.boughtOutCents ? ` · bought ${R(j.boughtOutCents)}` : ''}
          </Text>
          {j.partsWithoutCost ? <Text style={[st.small, { color: C.warn }]}>{j.partsWithoutCost} part{j.partsWithoutCost === 1 ? ' has' : 's have'} no cost yet (comes from an approved supplier invoice).</Text> : null}
          {j.profitCents !== null ? <Text style={[st.body, { fontWeight: '800', color: j.profitCents < 0 ? C.bad : C.good }]}>Profit {R(j.profitCents)}</Text> : null}
        </Card>
      ))}
      {(by === 'jobs' ? !jobs.length : !groups.length) ? <Body quiet>No closed jobs in this time.</Body> : null}
    </>
  );
}
