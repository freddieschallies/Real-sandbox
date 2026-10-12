// HR's Departments screen: every department with its manager and the technicians under him, and
// anyone not in a department yet. Each technician and each department manager is in one department.
import React, { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Heading, Label, Notice, Pill, Select, Toggle, st } from '../ui.tsx';
import { C } from '../theme.ts';
import { DeptLogo } from './DeptLogo.tsx';
import { pickImage } from '../device.ts';
import { rememberPhoto } from '../photo.ts';

export interface DeptData {
  canManage: boolean;
  departments: { id: string; name: string; active?: boolean; logo_photo_id?: string | null; manager_id: string | null; manager: string | null; technicians: number; staff?: number; van_lines: number }[];
  /** The usual departments not set up yet (one switched off and removed, say), to add with a tap. */
  missing?: string[];
  managers: { id: string; full_name: string; login_level: string }[];
  members?: { id: string; full_name: string; login_level: string; trade: string | null; department_id: string | null }[];
}
const TRADE: Record<string, string> = { foodservice: 'Foodservice tech', plumber: 'Plumber', electrician: 'Electrician', assistant: 'Assistant' };
const POSITION: Record<string, string> = { management: 'Department manager', admin: 'Admin', hr: 'HR', stockroom: 'Stock controller', mechanic: 'Mechanic' };
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['no signal: try again'];

export function useDepartments() {
  const s = useStore();
  const [d, setD] = useState<DeptData | null>(null);
  const load = async () => { const r = await s.ask({ method: 'GET', path: '/departments' }); if (r?.status === 200) setD(r.body); };
  useEffect(() => { load(); }, []);
  return { d, load };
}

export function DepartmentsBoard({ openPerson }: { openPerson?: (id: string) => void }) {
  const s = useStore();
  const { d, load } = useDepartments();
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; lines: string[] } | null>(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  if (!d) return <Body quiet>Loading…</Body>;
  const members = d.members ?? [];
  // Switched-off departments only show in the list of departments the business has.
  const on = d.departments.filter(x => x.active !== false);
  const add = async (n: string) => {
    const r = await s.ask({ method: 'POST', path: '/departments', json: { name: n } });
    if (r && r.status < 300) { setMsg({ tone: 'good', lines: [`${n} department switched on. Give it a manager and technicians.`] }); load(); return true; }
    setMsg({ tone: 'bad', lines: reasons(r) }); return false;
  };
  const change = async (x: DeptData['departments'][number], json: { name?: string; logoPhotoId?: string }, done: string) => {
    const r = await s.ask({ method: 'PUT', path: `/departments/${x.id}`, json });
    if (r && r.status < 300) { setMsg({ tone: 'good', lines: [done] }); load(); return true; }
    setMsg({ tone: 'bad', lines: reasons(r) }); return false;
  };
  const newLogo = async (x: DeptData['departments'][number]) => {
    const p = await pickImage();
    if (!p) return;
    const id = s.newId();
    rememberPhoto(s, id, p.uri);
    const up = await s.ask({ method: 'POST', path: '/photos', upload: { fields: { kind: 'logo', takenAt: new Date().toISOString(), id }, fileUri: p.uri, mime: p.mime } });
    if (!up || up.status >= 300) { setMsg({ tone: 'bad', lines: ['The logo could not be sent: try again with signal.'] }); return; }
    await change(x, { logoPhotoId: id }, `${x.name} has a new logo.`);
  };
  const toggle = async (x: DeptData['departments'][number], v: boolean) => {
    const r = await s.ask({ method: 'PUT', path: `/departments/${x.id}`, json: { active: v } });
    if (r && r.status < 300) { setMsg({ tone: 'good', lines: [v ? `${x.name} switched on.` : `${x.name} switched off. Its van stock list is kept if you switch it on again.`] }); load(); }
    else setMsg({ tone: 'bad', lines: reasons(r) });
  };
  const managers = members.filter(m => m.login_level === 'management');
  const deptOptions = [...on.map(x => ({ value: x.id, label: x.name })), { value: '', label: 'Not in a department' }];
  const move = async (id: string, departmentId: string, who: string) => {
    const r = await s.ask({ method: 'PUT', path: `/access/users/${id}/department`, json: { departmentId: departmentId || null } });
    const dep = d.departments.find(x => x.id === departmentId)?.name;
    const replaced = (r?.body as { replaced?: string | null })?.replaced;
    if (r && r.status < 300) {
      setMsg({ tone: 'good', lines: [dep ? `${who} is now in ${dep}.` : `${who} is not in a department now.`, ...(replaced ? [`${replaced} no longer manages ${dep}; give him a department.`] : [])] });
      load();
    } else setMsg({ tone: 'bad', lines: reasons(r) });
  };
  const person = (m: NonNullable<DeptData['members']>[number]) => (
    <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderTopColor: C.line, paddingVertical: 6 }}>
      <View style={{ flex: 1 }}>
        <Text style={[st.body, { fontWeight: '700' }]} onPress={openPerson ? () => openPerson(m.id) : undefined}>{m.full_name}</Text>
        <Text style={st.small}>{POSITION[m.login_level] ?? (m.trade ? TRADE[m.trade] : 'Technician')}</Text>
      </View>
      {d.canManage ? (
        <View style={{ width: 220 }}>
          <Select label={`Department of ${m.full_name}`} value={m.department_id ?? ''} options={deptOptions} onChange={v => move(m.id, v, m.full_name)} />
        </View>
      ) : null}
    </View>
  );
  const nobody = members.filter(m => !m.department_id || !on.some(x => x.id === m.department_id));
  return (
    <>
      <Text style={st.small}>Each technician works in one department, under its manager. Each department manager runs one department. The office staff go in Admin.</Text>
      {msg ? <Notice tone={msg.tone} title={msg.tone === 'good' ? 'Saved' : 'Not saved'} lines={msg.lines} /> : null}
      {on.map(x => {
        const techs = members.filter(m => m.department_id === x.id && m.login_level === 'technician');
        // The office staff in it (Admin, usually): admins, HR, the stock controller, the mechanic.
        const office = members.filter(m => m.department_id === x.id && !['technician', 'management'].includes(m.login_level));
        return (
          <Card key={x.id} accessibilityLabel={`Department ${x.name}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <DeptLogo name={x.name} photoId={x.logo_photo_id} size={40} />
              <Text style={{ color: C.text, fontSize: 20, fontWeight: '800', flex: 1 }}>{x.name}</Text>
              {!x.manager_id ? <Pill text="No manager" tone="warn" /> : null}
              {d.canManage ? <Button label="Edit" kind="quiet" onPress={() => setEditing(editing === x.id ? null : x.id)} /> : null}
            </View>
            {d.canManage && editing === x.id ? <EditDept x={x} rename={n => change(x, { name: n }, `${x.name} is now called ${n}, everywhere.`)} logo={() => newLogo(x)} /> : null}
            {d.canManage ? (
              <Select label={`Manager of ${x.name}`} value={x.manager_id ?? ''} placeholder="No manager yet"
                options={[...managers.map(m => ({ value: m.id, label: `${m.full_name}${m.department_id && m.department_id !== x.id ? ` (now ${d.departments.find(y => y.id === m.department_id)?.name ?? 'elsewhere'})` : ''}` })), { value: '', label: 'No manager' }]}
                onChange={async v => {
                  const r = await s.ask({ method: 'PUT', path: `/departments/${x.id}`, json: { managerId: v || null } });
                  const replaced = (r?.body as { replaced?: string | null })?.replaced;
                  if (r && r.status < 300) { setMsg({ tone: 'good', lines: [v ? `${managers.find(m => m.id === v)?.full_name} now manages ${x.name}.` : `${x.name} has no manager now.`, ...(replaced ? [`${replaced} no longer manages it; give him a department.`] : [])] }); load(); }
                  else setMsg({ tone: 'bad', lines: reasons(r) });
                }} />
            ) : <Text style={st.body}>Manager: {x.manager ?? 'none yet'}</Text>}
            <Label>Technicians ({techs.length})</Label>
            {techs.map(person)}
            {!techs.length ? <Body quiet>No technicians in {x.name} yet.</Body> : null}
            {office.length ? <><Label>Staff ({office.length})</Label>{office.map(person)}</> : null}
          </Card>
        );
      })}
      {nobody.length ? (
        <Card style={{ borderColor: C.warn }}>
          <Heading>Not in a department ({nobody.length})</Heading>
          {nobody.map(person)}
        </Card>
      ) : null}
      {d.canManage ? (
        <Card accessibilityLabel="Departments this business has">
          <Heading>Departments this business has</Heading>
          <Body quiet>Switch off a department the business doesn't do; move its people out first. Its van stock list is kept for if you switch it on again.</Body>
          {d.departments.map(x => (
            <View key={x.id} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingTop: 4 }}>
              <Toggle label={`${x.name}${x.active !== false ? ` · ${x.staff ?? x.technicians} ${(x.staff ?? x.technicians) === 1 ? 'person' : 'people'}` : ' · off'}`} value={x.active !== false} onChange={v => toggle(x, v)} />
            </View>
          ))}
          {(d.missing ?? []).length ? (
            <>
              <Label>Also usual</Label>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {(d.missing ?? []).map(n => <Button key={n} label={`Add ${n}`} kind="secondary" onPress={() => add(n)} />)}
              </View>
            </>
          ) : null}
          <Label>Your own department</Label>
          <TextInput value={name} onChangeText={setName} placeholder="e.g. Gas installations" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="New department name" />
          <Button label="Add department" kind="secondary" disabled={name.trim().length < 2} onPress={async () => { if (await add(name.trim())) setName(''); }} />
        </Card>
      ) : null}
    </>
  );
}

/** HR or the CEO renames a department or changes its logo; it changes in every list and screen. */
function EditDept({ x, rename, logo }: { x: DeptData['departments'][number]; rename: (n: string) => Promise<boolean>; logo: () => void }) {
  const [n, setN] = useState(x.name);
  return (
    <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8 }}>
      <Label>Name</Label>
      <TextInput value={n} onChangeText={setN} style={st.input} accessibilityLabel={`New name for ${x.name}`} placeholderTextColor={C.quiet} />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Button label="Save name" kind="secondary" disabled={n.trim().length < 2 || n.trim() === x.name} onPress={() => rename(n.trim())} />
        <Button label={x.logo_photo_id ? 'Change the logo' : 'Add a logo'} kind="secondary" onPress={logo} />
      </View>
    </View>
  );
}
