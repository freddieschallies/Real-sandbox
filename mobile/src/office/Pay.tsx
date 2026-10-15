// What someone is paid, on their profile: an hourly wage or a monthly salary, the overtime and Sunday /
// public holiday multiples, and (a technician) what an hour of him costs the company, for profit.
// Only for Accounts and the CEO, and whoever the CEO switches "Employees' pay" on for.
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, st } from '../ui.tsx';

interface Pay { wagePerHourCents: number | null; salaryCents: number | null; overtimeX: number; doubleX: number; costPerHourCents: number | null; note: string | null; updatedBy: string | null; updatedAt: string | null }
const rand = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2));
const cents = (t: string) => { const n = Number(t.replace(/[\sR]/g, '').replace(',', '.')); return t.trim() === '' || !Number.isFinite(n) ? null : Math.round(n * 100); };

export function PayCard({ userId, name, isTech }: { userId: string; name: string; isTech: boolean }) {
  const s = useStore();
  const [d, setD] = useState<{ pay: Pay; companyCostPerHourCents: number | null } | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [how, setHow] = useState<'hour' | 'month'>('hour');
  const [f, setF] = useState({ wage: '', salary: '', ot: '1.5', dt: '2', cost: '' });
  const load = async () => {
    const r = await s.ask({ method: 'GET', path: `/people/${userId}/pay` });
    if (r?.status !== 200) { setErr((r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.']); return; }
    const b = r.body as { pay: Pay; companyCostPerHourCents: number | null };
    setD(b); setHow(b.pay.salaryCents != null ? 'month' : 'hour');
    setF({ wage: rand(b.pay.wagePerHourCents), salary: rand(b.pay.salaryCents), ot: String(b.pay.overtimeX), dt: String(b.pay.doubleX), cost: rand(b.pay.costPerHourCents) });
  };
  useEffect(() => { load(); }, [userId]);
  if (!d) return err ? <Notice tone="bad" title="Pay" lines={err} /> : <Body quiet>Loading…</Body>;
  const save = async () => {
    setSaved(false); setErr(null);
    const json = { wagePerHourCents: how === 'hour' ? cents(f.wage) : null, salaryCents: how === 'month' ? cents(f.salary) : null, overtimeX: Number(f.ot.replace(',', '.')) || 1.5, doubleX: Number(f.dt.replace(',', '.')) || 2,
      ...(isTech ? { costPerHourCents: cents(f.cost) } : {}) };
    const r = await s.ask({ method: 'PUT', path: `/people/${userId}/pay`, json });
    if (r?.status === 200) { setSaved(true); load(); } else setErr((r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.']);
  };
  return (
    <>
      <Heading>Pay</Heading>
      <Card>
        <Text style={st.small}>Only Accounts and the CEO see this (and whoever the CEO switches "Employees' pay" on for). {name} does not see it in the app.</Text>
        <Label>Paid by</Label>
        <Choice options={['hour', 'month'] as const} value={how} onChange={setHow} labels={{ hour: 'The hour', month: 'A monthly salary' }} />
        {how === 'hour' ? <Field label="Wage per hour (R)" value={f.wage} onChangeText={t => setF(x => ({ ...x, wage: t }))} keyboardType="decimal-pad" placeholder="e.g. 85.00" />
          : <Field label="Salary per month (R)" value={f.salary} onChangeText={t => setF(x => ({ ...x, salary: t }))} keyboardType="decimal-pad" placeholder="e.g. 16500.00" />}
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          <View style={{ flex: 1, minWidth: 140 }}><Field label="Overtime × (Mon–Sat)" value={f.ot} onChangeText={t => setF(x => ({ ...x, ot: t }))} keyboardType="decimal-pad" /></View>
          <View style={{ flex: 1, minWidth: 140 }}><Field label="Sundays and public holidays ×" value={f.dt} onChangeText={t => setF(x => ({ ...x, dt: t }))} keyboardType="decimal-pad" /></View>
        </View>
        {isTech ? <Field label="What an hour of him costs the company (R, for profit)" value={f.cost} onChangeText={t => setF(x => ({ ...x, cost: t }))} keyboardType="decimal-pad"
          placeholder={d.companyCostPerHourCents != null ? `empty: the company rate R ${rand(d.companyCostPerHourCents)}` : 'empty: the company rate'} /> : null}
        <Text style={st.small}>His wages are worked out on his timesheets from these (normal hours, overtime, Sundays and public holidays).</Text>
        {err ? <Notice tone="bad" title="Not saved" lines={err} /> : null}
        {saved ? <Notice tone="good" title="Saved" /> : null}
        <Button label="Save pay" onPress={save} />
        {d.pay.updatedBy ? <Text style={st.small}>Last changed by {d.pay.updatedBy}{d.pay.updatedAt ? `, ${new Date(d.pay.updatedAt).toLocaleDateString('en-ZA')}` : ''}</Text> : null}
      </Card>
    </>
  );
}
