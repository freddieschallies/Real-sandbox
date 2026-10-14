// Stores and customers. A company brings in its own customer list (CSV or Excel, from Servcraft or
// anywhere); the app works out the columns, the office checks them, and every site's address is found
// on the map by the server. A pin that only found the suburb (or came from a technician's first
// Arrived) is marked "check the pin"; the office confirms it, looks it up again, or pastes the point.
import React, { useMemo, useState } from 'react';
import { Linking, Platform, Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Choice, Field, Heading, Label, Notice, Pill, Select, st } from '../ui.tsx';
import { C } from '../theme.ts';
import type { OfficeHook, Store } from './useOffice.ts';

const PIN: Record<string, { text: string; tone: 'good' | 'warn' | 'info' | 'bad' } | null> = {
  ok: null, check: { text: 'Check the pin', tone: 'warn' }, looking: { text: 'Finding it on the map…', tone: 'info' }, not_found: { text: 'No pin', tone: 'bad' },
};
type PinFilter = 'all' | 'check' | 'none';
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['Needs signal: try again.'];
const mapsUrl = (s: { lat: number | null; lng: number | null; address?: string | null; name: string }) =>
  s.lat != null && s.lng != null ? `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.name} ${s.address ?? ''}`)}`;
/** "-28.7465, 32.0584" pasted from Google Maps. */
export const pointFrom = (t: string) => { const m = t.match(/(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)/); return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null; };

export function StoreList({ o, add, open, importIt, canEdit }: { o: OfficeHook; add?: () => void; open: (id: string) => void; importIt?: () => void; canEdit: boolean }) {
  const [q, setQ] = useState('');
  const [f, setF] = useState<PinFilter>('all');
  const stores = o.d.stores;
  const check = stores.filter(s => s.pin_status === 'check').length;
  const none = stores.filter(s => s.pin_status === 'not_found' || s.pin_status === 'looking').length;
  const list = useMemo(() => stores
    .filter(s => f === 'all' || (f === 'check' ? s.pin_status === 'check' : s.pin_status === 'not_found' || s.pin_status === 'looking'))
    .filter(s => !q.trim() || `${s.client} ${s.name} ${s.address ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())), [stores, q, f]);
  return (
    <>
      {canEdit ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {importIt ? <Button label="Bring in customers" kind="secondary" onPress={importIt} style={{ flex: 1 }} /> : null}
          {add ? <Button label="Add a store" kind="secondary" onPress={add} style={{ flex: 1 }} /> : null}
        </View>
      ) : null}
      {check || none ? (
        <Choice options={['all', 'check', 'none'] as const} value={f} onChange={setF}
          labels={{ all: `All (${stores.length})`, check: `Check the pin (${check})`, none: `No pin yet (${none})` }} />
      ) : null}
      <TextInput value={q} onChangeText={setQ} placeholder="Search client or store" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search stores" />
      {!list.length ? <Body quiet>{stores.length ? 'None match.' : 'No stores yet: bring in your customer list, or add a store.'}</Body> : null}
      {list.slice(0, 300).map(s => (
        <StoreCard key={s.id} s={s} onPress={() => open(s.id)} />
      ))}
      {list.length > 300 ? <Text style={st.small}>{list.length - 300} more: search to find them.</Text> : null}
    </>
  );
}

function StoreCard({ s, onPress }: { s: Store; onPress: () => void }) {
  const p = PIN[s.pin_status ?? 'ok'];
  return (
    <Card onPress={onPress} accessibilityLabel={`Store ${s.name}`}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Text style={[st.body, { fontWeight: '800', flex: 1 }]}>{s.name}</Text>
        {s.client_on_hold ? <Pill text="On hold" tone="bad" /> : null}
        {p ? <Pill text={p.text} tone={p.tone} /> : null}
        {s.open_jobs ? <Pill text={`${s.open_jobs} open`} tone="info" /> : null}
      </View>
      <Text style={st.small}>{s.client}{s.address ? ` · ${s.address}` : ' · no address'}</Text>
    </Card>
  );
}

export function StoreDetail({ id, o, canEdit, done }: { id: string; o: OfficeHook; canEdit: boolean; done: () => void }) {
  const s0 = o.d.stores.find(x => x.id === id);
  const st0 = useStore();
  const [name, setName] = useState(s0?.name ?? '');
  const [address, setAddress] = useState(s0?.address ?? '');
  const [branch, setBranch] = useState(s0?.branch_code ?? '');
  const [phone, setPhone] = useState(s0?.phone ?? '');
  const [email, setEmail] = useState(s0?.email ?? '');
  const [where, setWhere] = useState('');
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; lines: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!s0) return <Body quiet>Not found.</Body>;
  const s = s0;
  const p = PIN[s.pin_status ?? 'ok'];
  const point = where.trim() ? pointFrom(where) : null;
  const call = async (method: 'PUT' | 'POST', path: string, json: object, good: string) => {
    setBusy(true); setMsg(null);
    const r = await st0.ask({ method, path, json });
    setBusy(false);
    if (r && r.status < 300) { setMsg({ tone: 'good', lines: [good] }); setWhere(''); o.load(); } else setMsg({ tone: 'bad', lines: reasons(r) });
  };
  const save = () => {
    if (where.trim() && !point) { setMsg({ tone: 'bad', lines: ['Paste the point from Google Maps, like -28.7465, 32.0584'] }); return; }
    call('PUT', `/office/stores/${s.id}`, {
      ...(name.trim() !== s.name ? { name: name.trim() } : {}), ...(address.trim() !== (s.address ?? '') ? { address: address.trim() } : {}),
      ...(branch.trim() !== (s.branch_code ?? '') ? { branchCode: branch.trim() } : {}), ...(phone.trim() !== (s.phone ?? '') ? { phone: phone.trim() } : {}),
      ...(email.trim() !== (s.email ?? '') ? { email: email.trim() } : {}), ...(point ? point : {}),
    }, point ? 'Saved: the pin is set.' : address.trim() !== (s.address ?? '') && s.pin_source !== 'manual' ? 'Saved: the new address is being found on the map.' : 'Saved.');
  };
  return (
    <>
      <Heading>{s.name}</Heading>
      <Text style={st.small}>{s.client}{s.open_jobs ? ` · ${s.open_jobs} open job${s.open_jobs > 1 ? 's' : ''}` : ''}</Text>
      <Card>
        <Label>Map pin</Label>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={[st.body, { fontWeight: '700', flex: 1 }]}>{s.lat != null ? `${s.lat.toFixed(5)}, ${s.lng!.toFixed(5)}` : 'Not on the map yet'}</Text>
          {p ? <Pill text={p.text} tone={p.tone} /> : <Pill text="Pinned" tone="good" />}
        </View>
        {s.pin_note ? <Text style={st.small}>{s.pin_note}</Text> : null}
        <Text style={st.small}>The technician's Arrived is checked within {s.geofence_m ?? 150} m of this pin.{s.lat == null ? ' Until it has a pin, Arrived is not checked, and the first technician to arrive there suggests the pin.' : ''}</Text>
        <Button label={s.lat != null ? 'Open in Google Maps to check it' : 'Search for it in Google Maps'} kind="secondary" onPress={() => Linking.openURL(mapsUrl(s)).catch(() => undefined)} />
        {canEdit ? (
          <View style={{ gap: 8 }}>
            {s.pin_status === 'check' ? <Button label="The pin is right" busy={busy} onPress={() => call('POST', `/office/stores/${s.id}/pin`, { action: 'confirm' }, 'The pin is confirmed.')} /> : null}
            {s.pin_status !== 'looking' ? <Button label="Look it up on the map again" kind="quiet" onPress={() => call('POST', `/office/stores/${s.id}/pin`, { action: 'lookup' }, 'Being found on the map again (within a minute or two).')} /> : null}
            <Field label="Or set the pin: paste the point from Google Maps" value={where} onChangeText={setWhere} placeholder="-28.7465, 32.0584"
              hint={point ? `Latitude ${point.lat}, longitude ${point.lng}: Save to use it.` : 'In Google Maps, right-click the store and click the numbers to copy them.'} />
          </View>
        ) : null}
      </Card>
      {canEdit ? (
        <Card>
          <Label>Details</Label>
          <Field label="Store name" value={name} onChangeText={setName} />
          <Field label="Address" value={address} onChangeText={setAddress} multiline hint="A new address is found on the map again (unless the pin was set by hand)." />
          <Field label="Branch / store code" value={branch} onChangeText={setBranch} />
          <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
        </Card>
      ) : <Card><Text style={st.body}>{s.address ?? 'No address'}</Text></Card>}
      {msg ? <Notice tone={msg.tone} title={msg.tone === 'good' ? msg.lines[0] : 'Not saved'} lines={msg.tone === 'good' ? undefined : msg.lines} /> : null}
      {canEdit ? <Button label="Save" busy={busy} onPress={save} /> : null}
      <Button label="Back" kind="quiet" onPress={done} />
    </>
  );
}

// ---- Bring in customers ------------------------------------------------------------------------------

interface Upload { id: string; filename: string | null; headers: string[]; rows: number; guess: Record<string, number>; fields: Record<string, string>; samples: string[][] }
interface Preview { customers: number; newCustomers: number; sites: number; newSites: number; withAddress: number; withPin: number; skipped: { line: number; reason: string }[]; preview: { line: number; client: string; store: string; address: string | null }[] }
interface Result { customersNew: number; customersUpdated: number; sitesNew: number; sitesUpdated: number; toFind: number; pinnedFromFile: number; skipped: { line: number; reason: string }[] }

/** A file chosen on a computer (the office does this on a computer, not a phone). */
function chooseFile(): Promise<File | null> {
  return new Promise(resolve => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') { resolve(null); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

const MAIN = ['client', 'store', 'address', 'address2', 'suburb', 'city', 'province', 'postal'];

export function ImportCustomers({ o, done }: { o: OfficeHook; done: () => void }) {
  const s = useStore();
  const [up, setUp] = useState<Upload | null>(null);
  const [map, setMap] = useState<Record<string, number>>({});
  const [pre, setPre] = useState<Preview | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  const [more, setMore] = useState(false);
  const pick = async () => {
    setErr(null);
    const f = await chooseFile();
    if (!f) { if (Platform.OS !== 'web') setErr(['Bring in customers on a computer: the file is on the computer.']); return; }
    setBusy(true);
    const r = await s.ask({ method: 'POST', path: '/office/customers/import', upload: { fields: {}, fileUri: URL.createObjectURL(f), mime: f.type || 'application/octet-stream', name: f.name } });
    setBusy(false);
    if (r?.status === 200) { const u = r.body as Upload; setUp(u); setMap(u.guess); setPre(null); } else setErr(reasons(r));
  };
  const check = async () => {
    if (!up) return;
    setBusy(true); setErr(null);
    const r = await s.ask({ method: 'POST', path: `/office/customers/import/${up.id}/preview`, json: { mapping: map } });
    setBusy(false);
    if (r?.status === 200) setPre(r.body as Preview); else setErr(reasons(r));
  };
  const apply = async () => {
    if (!up) return;
    setBusy(true); setErr(null);
    const r = await s.ask({ method: 'POST', path: `/office/customers/import/${up.id}/apply`, json: { mapping: map } });
    setBusy(false);
    if (r?.status === 200) { setRes(r.body as Result); o.load(); } else setErr(reasons(r));
  };
  if (res) {
    return (
      <>
        <Heading>Customers brought in</Heading>
        <Notice tone="good" title={`${res.customersNew} new customer${res.customersNew === 1 ? '' : 's'}, ${res.sitesNew} new site${res.sitesNew === 1 ? '' : 's'}`} lines={[
          `${res.customersUpdated} customer${res.customersUpdated === 1 ? '' : 's'} and ${res.sitesUpdated} site${res.sitesUpdated === 1 ? '' : 's'} already here were filled in.`,
          res.toFind ? `${res.toFind} site${res.toFind === 1 ? ' is' : 's are'} being found on the map now, a few a minute: watch Stores (Check the pin / No pin yet).` : 'Every site has its pin.',
          ...(res.pinnedFromFile ? [`${res.pinnedFromFile} had a map point in the file and use it as it is.`] : []),
          ...(res.skipped.length ? [`${res.skipped.length} row${res.skipped.length === 1 ? '' : 's'} left out (no customer name).`] : []),
        ]} />
        <Button label="Back to Stores" onPress={done} />
      </>
    );
  }
  const options = [{ value: '-1', label: 'Not in the file' }, ...(up?.headers ?? []).map((h, i) => ({ value: String(i), label: h }))];
  const set = (f: string, v: string) => { setPre(null); setMap(m => { const n = { ...m }; if (v === '-1') delete n[f]; else n[f] = Number(v); return n; }); };
  return (
    <>
      <Heading>Bring in customers</Heading>
      <Body quiet>Your customer list as a CSV or Excel file (export it from Servcraft, or save your own list). One row per site: the customer, the site or store, and its address. The app finds every address on the map.</Body>
      {!up ? <Button label="Choose the file" busy={busy} onPress={pick} /> : (
        <>
          <Card>
            <Text style={[st.body, { fontWeight: '800' }]}>{up.filename ?? 'The file'}: {up.rows} row{up.rows === 1 ? '' : 's'}</Text>
            <Text style={st.small}>The app guessed which column is which: check them, and change any that are wrong.</Text>
          </Card>
          {Object.entries(up.fields).filter(([f]) => more || MAIN.includes(f) || map[f] !== undefined).map(([f, label]) => (
            <View key={f} style={{ gap: 4 }}>
              <Select label={f === 'client' ? `${label} (needed)` : label} value={map[f] === undefined ? '-1' : String(map[f])} options={options} onChange={v => set(f, v)} />
              {map[f] !== undefined && up.samples[map[f]]?.length ? <Text style={st.small}>e.g. {up.samples[map[f]].join(' · ')}</Text> : null}
            </View>
          ))}
          {!more ? <Button label="More columns (codes, contact, phone, email, map point)" kind="quiet" onPress={() => setMore(true)} /> : null}
          <Button label="Check what will come in" kind="secondary" busy={busy && !pre} disabled={map.client === undefined} onPress={check} />
          {pre ? (
            <Card>
              <Text style={st.body}>{pre.customers} customer{pre.customers === 1 ? '' : 's'} ({pre.newCustomers} new) · {pre.sites} site{pre.sites === 1 ? '' : 's'} ({pre.newSites} new)</Text>
              <Text style={st.small}>{pre.withAddress} with an address{pre.withPin ? ` · ${pre.withPin} with a map point in the file` : ''}{pre.sites - pre.withAddress > 0 ? ` · ${pre.sites - pre.withAddress} without an address (found by name, or pinned by hand)` : ''}</Text>
              {pre.preview.map(r => <Text key={r.line} style={st.small}>• {r.client} · {r.store}{r.address ? ` · ${r.address}` : ''}</Text>)}
              {pre.skipped.length ? <Text style={[st.small, { color: C.warn }]}>{pre.skipped.length} row{pre.skipped.length === 1 ? '' : 's'} left out: {pre.skipped.slice(0, 5).map(x => `row ${x.line} (${x.reason})`).join(', ')}{pre.skipped.length > 5 ? '…' : ''}</Text> : null}
              <Button label={`Bring in ${pre.sites} site${pre.sites === 1 ? '' : 's'}`} busy={busy} onPress={apply} />
            </Card>
          ) : null}
          <Button label="Choose another file" kind="quiet" onPress={() => { setUp(null); setPre(null); }} />
        </>
      )}
      {err ? <Notice tone="bad" title="Not brought in" lines={err} /> : null}
      <Button label="Cancel" kind="quiet" onPress={done} />
    </>
  );
}
