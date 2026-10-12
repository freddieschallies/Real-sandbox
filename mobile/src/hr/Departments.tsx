// HR's Departments screen: every department with its manager and the technicians under him, and
// anyone not in a department yet. Each technician and each department manager is in one department.
import React, { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Card, Heading, Label, Notice, Pill, Select, st } from '../ui.tsx';
import { C } from '../theme.ts';

export interface DeptData {
  canManage: boolean;
  departments: { id: string; name: string; manager_id: string | null; manager: string | null; technicians: number; van_lines: number }[];
  managers: { id: string; full_name: string; login_level: string }[];
  members?: { id: string; full_name: string; login_level: string; trade: string | null; department_id: string | null }[];
}
const TRADE: Record<string, string> = { foodservice: 'Foodservice tech', plumber: 'Plumber', electrician: 'Electrician', assistant: 'Assistant' };
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
  if (!d) return <Body quiet>Loading…</Body>;
  const members = d.members ?? [];
  const managers = members.filter(m => m.login_level === 'management');
  const deptOptions = [...d.departments.map(x => ({ value: x.id, label: x.name })), { value: '', label: 'Not in a department' }];
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
        <Text style={st.small}>{m.login_level === 'management' ? 'Department manager' : m.trade ? TRADE[m.trade] : 'Technician'}</Text>
      </View>
      {d.canManage ? (
        <View style={{ width: 220 }}>
          <Select label={`Department of ${m.full_name}`} value={m.department_id ?? ''} options={deptOptions} onChange={v => move(m.id, v, m.full_name)} />
        </View>
      ) : null}
    </View>
  );
  const nobody = members.filter(m => !m.department_id || !d.departments.some(x => x.id === m.department_id));
  return (
    <>
      <Text style={st.small}>Each technician works in one department, under its manager. Each department manager runs one department.</Text>
      {msg ? <Notice tone={msg.tone} title={msg.tone === 'good' ? 'Saved' : 'Not saved'} lines={msg.lines} /> : null}
      {d.departments.map(x => {
        const techs = members.filter(m => m.department_id === x.id && m.login_level === 'technician');
        return (
          <Card key={x.id} accessibilityLabel={`Department ${x.name}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ color: C.text, fontSize: 20, fontWeight: '800', flex: 1 }}>{x.name}</Text>
              {!x.manager_id ? <Pill text="No manager" tone="warn" /> : null}
            </View>
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
        <Card>
          <Label>New department</Label>
          <TextInput value={name} onChangeText={setName} placeholder="e.g. Electrical" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="New department name" />
          <Button label="Add department" kind="secondary" disabled={name.trim().length < 2} onPress={async () => {
            const r = await s.ask({ method: 'POST', path: '/departments', json: { name: name.trim() } });
            if (r && r.status < 300) { setMsg({ tone: 'good', lines: [`${name.trim()} department added. Give it a manager and technicians.`] }); setName(''); load(); } else setMsg({ tone: 'bad', lines: reasons(r) });
          }} />
        </Card>
      ) : null}
    </>
  );
}
