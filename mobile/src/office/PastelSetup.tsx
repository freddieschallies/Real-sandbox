// Setting up Sage Pastel, made for someone who is not a bookkeeper. Give the app Pastel's own lists and it
// matches the codes itself; tick what it is sure of, choose for the few it is not; check where labour,
// call-outs and travel go; the financial year and VAT; then a practice import that changes nothing.
// Shown at the top of Accounts → Pastel until it is done (and from the Start-up page).
import React, { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Choice, Field, Label, Notice, Pill, Select, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { chooseFile } from './Stores.tsx';

type How = 'has' | 'sure' | 'check' | 'none' | 'unknown';
interface Match { id: string; name: string; current: string | null; code: string | null; codeName: string | null; how: How }
interface Entry { code: string; name: string }
type ListInfo = { count: number; filename: string | null; uploadedAt: string } | null;
interface Setup {
  steps: { key: string; done: boolean }[]; done: boolean; books: boolean;
  lists: { customers: ListInfo; suppliers: ListInfo; accounts: ListInfo; items: ListInfo };
  customers: Match[]; suppliers: Match[]; items: Match[]; itemsTotal: number;
  pastel: { customers: Entry[]; suppliers: Entry[]; accounts: Entry[]; items: Entry[] };
  lineNeed: string[]; lineNames: Record<string, string>; suggest: Record<string, { code: string; lineType: 4 | 6; name: string }>; missingLines: string[];
  settings: { yearStartMonth: number; taxType: string; codes: Record<string, { code: string; lineType: 4 | 6 }>; store?: string | null };
  vatNo: string | null; setupDoneAt: string | null; practiceNote: string | null;
}
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TITLES: Record<string, string> = {
  customers: 'Your customers in Pastel', suppliers: 'Your suppliers in Pastel', lines: 'Where labour, call-outs and travel go',
  year: 'Financial year and VAT', items: 'Stock items in Pastel', practice: 'A practice import',
};
const FROM_PASTEL: Record<string, string> = {
  customers: 'In Pastel: File → Import/Export → Customers → Export. It saves a file in your Pastel company folder. (A Customer Listing report saved to Excel works too.)',
  suppliers: 'In Pastel: File → Import/Export → Suppliers → Export. (A Supplier Listing saved to Excel works too.)',
  accounts: 'In Pastel: File → Import/Export → General Ledger accounts → Export. (The Chart of Accounts report saved to Excel works too.)',
  items: 'In Pastel: File → Import/Export → Inventory items → Export. (An Inventory Listing saved to Excel works too.)',
};

export function usePastelSetup(on = true) {
  const s = useStore();
  const [d, setD] = useState<Setup | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const load = async () => {
    if (!on) return;
    const r = await s.ask({ method: 'GET', path: '/pastel/setup' });
    if (r?.status === 200) { setD(r.body as Setup); setErr(null); } else if (r && r.status !== 403) setErr(reasons(r));
  };
  useEffect(() => { load(); }, [on]);
  return { d, setD, err, load };
}

export function PastelSetup({ changed, startOpen }: { changed?: () => void; startOpen?: boolean }) {
  const s = useStore();
  const { d, setD, err, load } = usePastelSetup();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ans, setAns] = useState<string[] | null>(null);
  const [shown, setShown] = useState(!!startOpen);
  if (!d) return err ? <Notice tone="bad" title="Pastel set-up" lines={err} /> : <Body quiet>Loading…</Body>;
  const doneCount = d.steps.filter(x => x.done).length;
  if (d.done && !shown) {
    return (
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>Pastel is set up</Text>
          <Pill text="Done" tone="good" />
        </View>
        <Text style={st.small}>New customers, suppliers or stock: bring Pastel's list in again here and the app matches the new ones.</Text>
        <Button label="Open the Pastel set-up" kind="quiet" onPress={() => setShown(true)} />
      </Card>
    );
  }
  const first = d.steps.find(x => !x.done)?.key ?? null;
  const cur = open ?? first;
  const got = (b: unknown) => { setD(b as Setup); changed?.(); };
  const send = async (path: string, json: object, key: string) => {
    setBusy(key); setAns(null);
    const r = await s.ask({ method: 'POST', path, json });
    setBusy(null);
    if (r?.status === 200) { got(r.body); return r.body; } setAns(reasons(r)); return null;
  };
  const upload = async (kind: string, sample = false) => {
    setAns(null);
    if (sample) {
      setBusy(kind);
      const r = await s.ask({ method: 'POST', path: `/pastel/lists?kind=${kind}`, json: {} });
      setBusy(null);
      if (r?.status === 200) got(r.body); else setAns(reasons(r));
      return;
    }
    const f = await chooseFile('.csv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if (!f) { if (Platform.OS !== 'web') setAns(['Do the Pastel set-up on a computer: Pastel\'s files are on the computer.']); return; }
    setBusy(kind);
    const r = await s.ask({ method: 'POST', path: `/pastel/lists?kind=${kind}`, upload: { fields: {}, fileUri: URL.createObjectURL(f), mime: f.type || 'text/plain', name: f.name } });
    setBusy(null);
    if (r?.status === 200) got(r.body); else setAns(reasons(r));
  };
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={[st.body, { fontWeight: '900', fontSize: 18, flex: 1 }]}>Set up Pastel</Text>
        <Pill text={`${doneCount} of ${d.steps.length} done`} tone={d.done ? 'good' : 'info'} />
      </View>
      <Text style={st.small}>You give the app Pastel's own lists and it matches the codes itself: nobody types account codes. About 15 minutes, once.</Text>
      {ans ? <Notice tone="bad" title="Not done" lines={ans} /> : null}
      {d.steps.map((x, i) => (
        <View key={x.key} style={{ gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.line }}>
          <Button label={`${x.done ? '✓' : i + 1}  ${TITLES[x.key]}${x.key === 'items' && !d.itemsTotal ? ' (no stock items yet)' : ''}`} kind={cur === x.key ? 'secondary' : 'quiet'}
            onPress={() => setOpen(cur === x.key ? '' : x.key)} style={{ alignItems: 'flex-start' }} />
          {cur === x.key ? (
            <View style={{ gap: 8 }}>
              {x.key === 'customers' ? <MatchStep kind="customers" what="customer" list={d.lists.customers} matches={d.customers} entries={d.pastel.customers} busy={busy} upload={upload}
                save={rows => send('/pastel/codes', { clients: rows }, 'save-customers')} /> : null}
              {x.key === 'suppliers' ? <MatchStep kind="suppliers" what="supplier" list={d.lists.suppliers} matches={d.suppliers} entries={d.pastel.suppliers} busy={busy} upload={upload}
                save={rows => send('/pastel/codes', { suppliers: rows }, 'save-suppliers')} /> : null}
              {x.key === 'lines' ? <LinesStep d={d} busy={busy} upload={upload} saved={() => load()} setAns={setAns} /> : null}
              {x.key === 'year' ? <YearStep d={d} saved={() => { load(); changed?.(); }} setAns={setAns} /> : null}
              {x.key === 'items' ? (d.itemsTotal ? <MatchStep kind="items" what="stock item" list={d.lists.items} matches={d.items} entries={d.pastel.items} busy={busy} upload={upload}
                save={rows => send('/pastel/codes', { items: rows }, 'save-items')} /> : <Body quiet>No stock items in the app yet: nothing to match. This is ticked by itself.</Body>) : null}
              {x.key === 'practice' ? <PracticeStep d={d} busy={busy} send={send} setAns={setAns} /> : null}
            </View>
          ) : null}
        </View>
      ))}
      {d.done ? <Notice tone="good" title="Pastel is set up" lines={['From now on: Accounts → Pastel → "Make Pastel batch", then import that file in Pastel the same way as the practice.']} /> : null}
    </Card>
  );
}

function UploadRow({ kind, list, busy, upload }: { kind: string; list: ListInfo; busy: string | null; upload: (k: string, sample?: boolean) => void }) {
  const demo = useStore().session?.mode === 'demo';
  return (
    <View style={{ gap: 6 }}>
      <Text style={st.body}>{FROM_PASTEL[kind]}</Text>
      <Button label={list ? `Bring in a newer list (now: ${list.count} from ${list.filename ?? 'Pastel'})` : 'Choose the file from Pastel'} kind={list ? 'secondary' : 'primary'} busy={busy === kind} onPress={() => upload(kind)} />
      {demo && !list ? <Button label="Use a sample file (test drive)" kind="quiet" onPress={() => upload(kind, true)} /> : null}
    </View>
  );
}

const HOW: Record<How, { text: string; tone: 'good' | 'info' | 'warn' | 'bad' | 'quiet' }> = {
  has: { text: 'Matched', tone: 'good' }, sure: { text: 'Found', tone: 'good' }, check: { text: 'Check', tone: 'warn' }, none: { text: 'Not found', tone: 'bad' }, unknown: { text: 'Not in Pastel', tone: 'bad' },
};

function MatchStep({ kind, what, list, matches, entries, busy, upload, save }: { kind: string; what: string; list: ListInfo; matches: Match[]; entries: Entry[]; busy: string | null; upload: (k: string, sample?: boolean) => void; save: (rows: { id: string; code: string | null }[]) => Promise<unknown> }) {
  const [pick, setPick] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setPick(Object.fromEntries(matches.filter(m => m.how === 'sure' || m.how === 'check').map(m => [m.id, m.code ?? '']))); }, [matches]);
  if (!list) return <UploadRow kind={kind} list={list} busy={busy} upload={upload} />;
  const count = (h: How) => matches.filter(m => m.how === h).length;
  const todo = matches.filter(m => m.how !== 'has');
  const rows = showAll ? matches : todo;
  const opts = [{ value: '', label: 'Not in Pastel yet' }, ...entries.map(e => ({ value: e.code, label: `${e.code} · ${e.name}` }))];
  return (
    <>
      <UploadRow kind={kind} list={list} busy={busy} upload={upload} />
      <Text style={[st.body, { fontWeight: '700' }]}>
        {matches.length} {what}s here: {count('has')} matched, {count('sure')} found by name{count('check') ? `, ${count('check')} to check` : ''}{count('none') + count('unknown') ? `, ${count('none') + count('unknown')} not found` : ''}.
      </Text>
      {rows.slice(0, 200).map(m => (
        <View key={m.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <View style={{ flex: 1, minWidth: 160 }}>
            <Text style={[st.body, { fontWeight: '700' }]}>{m.name}</Text>
            <View style={{ flexDirection: 'row', gap: 6 }}><Pill text={HOW[m.how].text} tone={HOW[m.how].tone} />{m.how === 'check' && m.codeName ? <Text style={st.small}>Pastel: {m.codeName}?</Text> : null}</View>
          </View>
          {m.how === 'has' && pick[m.id] === undefined ? <Text style={[st.body, { width: 220 }]}>{m.code} · {m.codeName ?? ''}</Text> : (
            <View style={{ width: 260 }}>
              <Select label={`Pastel ${what} for ${m.name}`} value={pick[m.id] ?? ''} options={opts} onChange={v => setPick(p => ({ ...p, [m.id]: v }))} />
            </View>
          )}
        </View>
      ))}
      {!todo.length && !showAll ? <Notice tone="good" title={`Every ${what} is matched`} /> : null}
      {matches.length - todo.length ? <Button label={showAll ? 'Show only the ones to do' : `Show all ${matches.length}`} kind="quiet" onPress={() => setShowAll(!showAll)} /> : null}
      {count('none') + count('unknown') ? <Text style={st.small}>"Not found": add it in Pastel first (then bring the list in again), or choose it here if it has another name in Pastel.</Text> : null}
      {todo.length ? (
        <Button label={`Save ${Object.values(pick).filter(Boolean).length} code${Object.values(pick).filter(Boolean).length === 1 ? '' : 's'}`} busy={busy === `save-${kind}`} disabled={!Object.values(pick).some(Boolean)}
          onPress={() => save(Object.entries(pick).filter(([id, code]) => code || matches.find(m => m.id === id)?.current).map(([id, code]) => ({ id, code: code || null })))} />
      ) : null}
    </>
  );
}

function LinesStep({ d, busy, upload, saved, setAns }: { d: Setup; busy: string | null; upload: (k: string, sample?: boolean) => void; saved: () => void; setAns: (a: string[] | null) => void }) {
  const s = useStore();
  const start = () => Object.fromEntries(d.lineNeed.map(k => {
    const cur = d.settings.codes[k] ?? d.suggest[k] ?? (k === 'other' ? d.settings.codes.bought_out ?? d.suggest.bought_out : undefined);
    return [k, cur ? `${cur.lineType}|${cur.code}` : ''];
  }));
  const [v, setV] = useState<Record<string, string>>(start);
  const [typing, setTyping] = useState(false);
  useEffect(() => { setV(start()); }, [d.lists.accounts?.uploadedAt, d.lists.items?.uploadedAt]);
  const opts = [{ value: '', label: 'Choose…' }, ...d.pastel.items.map(e => ({ value: `4|${e.code}`, label: `Item ${e.code} · ${e.name}` })), ...d.pastel.accounts.map(e => ({ value: `6|${e.code}`, label: `GL ${e.code} · ${e.name}` }))];
  const save = async () => {
    const codes = Object.fromEntries(Object.entries(v).filter(([, x]) => x).map(([k, x]) => { const [t, ...c] = x.split('|'); return [k, { code: c.join('|').trim(), lineType: Number(t) as 4 | 6 }]; }));
    const r = await s.ask({ method: 'PUT', path: '/pastel/settings', json: { yearStartMonth: d.settings.yearStartMonth, taxType: d.settings.taxType, store: d.settings.store ?? null, codes } });
    if (r?.status === 200) { setAns(null); saved(); } else setAns(reasons(r));
  };
  const noLists = !d.lists.accounts && !d.lists.items;
  return (
    <>
      <Text style={st.body}>Each line on an invoice goes to an item or a GL account in Pastel. Bring in Pastel's GL accounts (and its inventory items, if labour and call-outs are items in your Pastel), and the app suggests where each goes.</Text>
      <UploadRow kind="accounts" list={d.lists.accounts} busy={busy} upload={upload} />
      <UploadRow kind="items" list={d.lists.items} busy={busy} upload={upload} />
      {noLists && !typing ? <Button label="I know the codes: type them instead" kind="quiet" onPress={() => setTyping(true)} /> : null}
      {d.lineNeed.map(k => (
        <View key={k}>
          {noLists || typing ? (
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <View style={{ flex: 1, minWidth: 180 }}><Field label={d.lineNames[k]} value={(v[k] ?? '').split('|').slice(1).join('|')} onChangeText={t => setV(x => ({ ...x, [k]: `${(x[k] ?? '6|').split('|')[0] || '6'}|${t}` }))} placeholder="Pastel code" /></View>
              <Choice options={['4', '6'] as const} value={((v[k] ?? '6|').split('|')[0] || '6') as '4' | '6'} onChange={t => setV(x => ({ ...x, [k]: `${t}|${(x[k] ?? '').split('|').slice(1).join('|')}` }))} labels={{ 4: 'Item', 6: 'GL account' }} />
            </View>
          ) : <Select label={d.lineNames[k]} value={v[k] ?? ''} options={opts} onChange={x => setV(y => ({ ...y, [k]: x }))} />}
        </View>
      ))}
      {!noLists || typing ? <Button label="These are right" disabled={d.lineNeed.some(k => !(v[k] ?? '').split('|')[1])} onPress={save} /> : null}
      <Text style={st.small}>Stock lines go to each part's own item code (the next steps check those).</Text>
    </>
  );
}

function YearStep({ d, saved, setAns }: { d: Setup; saved: () => void; setAns: (a: string[] | null) => void }) {
  const s = useStore();
  const [month, setMonth] = useState(String(d.settings.yearStartMonth));
  const [vat, setVat] = useState<'yes' | 'no'>(d.settings.taxType === '00' ? 'no' : 'yes');
  const [tax, setTax] = useState(d.settings.taxType === '00' ? '01' : d.settings.taxType);
  const [more, setMore] = useState(false);
  const save = async () => {
    const r = await s.ask({ method: 'PUT', path: '/pastel/settings', json: { yearStartMonth: Number(month), taxType: vat === 'yes' ? tax.trim() || '01' : '00', store: d.settings.store ?? null, codes: d.settings.codes } });
    if (r?.status === 200) { setAns(null); saved(); } else setAns(reasons(r));
  };
  return (
    <>
      <Label>Your financial year starts in</Label>
      <Choice options={MONTHS.map((_, i) => String(i + 1))} value={month} onChange={setMonth} labels={Object.fromEntries(MONTHS.map((m, i) => [String(i + 1), m.slice(0, 3)]))} />
      <Text style={st.small}>Most South African companies start in March (year end in February). It is the first month of the year in Pastel.</Text>
      <Label>Is the company registered for VAT?</Label>
      <Choice options={['yes', 'no'] as const} value={vat} onChange={setVat} labels={{ yes: d.vatNo ? `Yes (VAT ${d.vatNo})` : 'Yes', no: 'No' }} />
      {vat === 'yes' ? (more ? <Field label="Pastel tax type for 15% VAT (usually 01)" value={tax} onChangeText={setTax} maxLength={2} keyboardType="number-pad" />
        : <Button label="Our Pastel uses another tax type than 01" kind="quiet" onPress={() => setMore(true)} />) : null}
      <Button label="These are right" onPress={save} />
    </>
  );
}

function PracticeStep({ d, busy, send, setAns }: { d: Setup; busy: string | null; send: (path: string, json: object, key: string) => Promise<unknown>; setAns: (a: string[] | null) => void }) {
  const s = useStore();
  const [file, setFile] = useState<{ filename: string; file: string; where: string; customer: string; number: string; real: boolean } | null>(null);
  const [bad, setBad] = useState(false);
  const [note, setNote] = useState(d.practiceNote ?? '');
  const ready = d.steps.filter(x => x.key !== 'practice' && x.key !== 'items').every(x => x.done);
  const make = async () => {
    const r = await s.ask({ method: 'POST', path: '/pastel/practice', json: {} });
    if (r?.status !== 200) { setAns(reasons(r)); return; }
    const f = r.body as NonNullable<typeof file>;
    setFile(f); setAns(null);
    if (Platform.OS === 'web') {
      try { const url = URL.createObjectURL(new Blob([f.file], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = f.filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); } catch { /* shown below to copy */ }
    }
  };
  if (!ready) return <Body quiet>Do the steps above first.</Body>;
  return (
    <>
      <Text style={st.body}>One invoice, to import in Pastel and look at. Nothing is marked as sent to Pastel here, so it can be tried as often as you like.</Text>
      <Button label={file ? 'Make the practice file again' : 'Make the practice file'} onPress={make} />
      {file ? (
        <Card>
          <Text style={[st.body, { fontWeight: '800' }]}>{file.filename} {Platform.OS === 'web' ? '(downloaded)' : ''}</Text>
          <Text style={st.body}>1. In Pastel: {file.where}, and choose this file.</Text>
          <Text style={st.body}>2. Pastel shows a new invoice for customer {file.customer}{file.real ? ` (your invoice ${file.number})` : ' marked "Practice"'}. Open it and check the lines and amounts.</Text>
          <Text style={st.body}>3. Then delete it in Pastel (do not update it){file.real ? ': the real one goes with the next batch' : ''}.</Text>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button label="It worked" busy={busy === 'done'} onPress={() => send('/pastel/setup/done', { worked: true }, 'done')} style={{ flexGrow: 1 }} />
            <Button label="It did not work" kind="secondary" onPress={() => setBad(true)} style={{ flexGrow: 1 }} />
          </View>
          {bad ? (
            <>
              <Field label="What did Pastel say?" value={note} onChangeText={setNote} placeholder="e.g. Invalid customer account" multiline />
              <Notice tone="info" title="Common reasons" lines={['"Invalid account": that customer\'s code is not in Pastel (step 1).', '"Invalid item" or "GL account": a line code is wrong (step 3, or a stock item\'s code).', '"Period": the financial year month is wrong (step 4).']} />
              <Button label="Keep this for support" kind="secondary" disabled={note.trim().length < 3} onPress={() => send('/pastel/setup/done', { worked: false, note: note.trim() }, 'note')} />
            </>
          ) : null}
          <Text selectable style={{ color: C.text, fontFamily: Platform.OS === 'web' ? 'monospace' : undefined, fontSize: 11, backgroundColor: C.panel2, padding: 8, borderRadius: 6 }}>{file.file}</Text>
        </Card>
      ) : null}
      {d.practiceNote ? <Text style={st.small}>Last time Pastel said: {d.practiceNote}</Text> : null}
    </>
  );
}
