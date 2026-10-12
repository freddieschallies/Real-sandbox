// One person's profile: picture, what they are doing right now (vehicle, where, which job, with whom),
// contact details, and personal details for whoever manages access.
import React, { useEffect, useState } from 'react';
import { Image, Linking, Pressable, Text, View } from 'react-native';
import { useStore } from '../state.tsx';
import { nowIso, takePhoto } from '../device.ts';
import { rememberPhoto, usePhotoUri } from '../photo.ts';
import { Body, Button, Card, Field, Heading, Label, Notice, st } from '../ui.tsx';
import { C } from '../theme.ts';

export interface Profile {
  id: string; full_name: string; position: string; login_level: string; tradeLabel: string | null; department: string | null; photo_id: string | null;
  now: {
    vehicle: { registration: string; mode: 'driving' | 'riding_along'; since: string } | null;
    job: { id: string; number: number; status: string; store: string; fault: string; lead: boolean; startedAt: string | null } | null;
    with: string[];
    location: { source: string; lat: number; lng: number; moving: boolean; speedKmh: number | null; minutesAgo: number | null } | null;
  };
  contact: { phone: string | null; email: string | null; emergency_name: string | null; emergency_phone: string | null };
  personal: { id_number: string | null; date_of_birth: string | null; home_address: string | null; start_date: string | null; notes: string | null } | null;
  canEdit: boolean;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
const day = (s: string | null) => (s ? new Date(`${s}T12:00:00+02:00`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }) : '–');
const ago = (m: number | null) => (m == null ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`);

export function Avatar({ id, name, size = 88 }: { id: string | null | undefined; name: string; size?: number }) {
  const uri = usePhotoUri(id);
  const initials = name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return uri ? <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: C.panel2 }} accessibilityLabel={`Picture of ${name}`} />
    : <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: C.panel2, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: C.quiet, fontSize: size / 2.8, fontWeight: '800' }}>{initials}</Text>
      </View>;
}

function Row({ label, value, onPress }: { label: string; value: string | null | undefined; onPress?: () => void }) {
  const v = value || '–';
  return (
    <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line }}>
      <Text style={[st.small, { width: 130 }]}>{label}</Text>
      {onPress && value ? <Pressable onPress={onPress} accessibilityRole="link"><Text style={[st.body, { color: C.info, textDecorationLine: 'underline' }]}>{v}</Text></Pressable>
        : <Text style={[st.body, { flex: 1 }]}>{v}</Text>}
    </View>
  );
}

export function useProfile(id: string) {
  const s = useStore();
  const [p, setP] = useState<Profile | null>(null);
  const load = async () => { const r = await s.ask({ method: 'GET', path: `/people/${id}` }); if (r?.status === 200) setP(r.body); };
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [id]);
  return { p, load };
}

export function ProfileTop({ p, reload }: { p: Profile; reload: () => void }) {
  const s = useStore();
  const n = p.now;
  const changePhoto = async () => {
    const ph = await takePhoto();
    if (!ph) return;
    const id = s.newId();
    rememberPhoto(s, id, ph.uri);
    s.queue(`Picture of ${p.full_name}`, { method: 'POST', path: '/photos', upload: { fields: { kind: 'profile', takenAt: nowIso(), id }, fileUri: ph.uri, mime: ph.mime } });
    s.queue(`Picture on ${p.full_name}'s profile`, { method: 'PUT', path: `/people/${p.id}/profile`, json: { photoId: id } });
    setTimeout(reload, 800);
  };
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
        <Avatar id={p.photo_id} name={p.full_name} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: C.text, fontSize: 26, fontWeight: '800' }}>{p.full_name}</Text>
          <Text style={st.body}>{[p.position, p.tradeLabel].filter(Boolean).join(' · ')}</Text>
          {p.department ? <Text style={st.small}>{p.department}</Text> : null}
          {p.canEdit ? <Pressable onPress={changePhoto} accessibilityRole="button"><Text style={[st.small, { color: C.info, textDecorationLine: 'underline' }]}>{p.photo_id ? 'Change picture' : 'Add a picture'}</Text></Pressable> : null}
        </View>
      </View>
      {p.login_level === 'technician' || n.vehicle || n.job ? (
        <Card>
          <Label>Right now</Label>
          <Row label="Vehicle" value={n.vehicle ? `${n.vehicle.registration} · ${n.vehicle.mode === 'driving' ? 'driving' : 'riding along'} since ${time(n.vehicle.since)}` : 'Not in a vehicle'} />
          <Row label="Where" value={n.location ? `${n.location.source === 'on site' ? `On site at ${n.job?.store}` : n.location.moving ? `Moving${n.location.speedKmh ? `, ${n.location.speedKmh} km/h` : ''}` : 'Parked'}${n.location.minutesAgo != null ? ` · ${ago(n.location.minutesAgo)}` : ''}` : 'Unknown'}
            onPress={n.location ? () => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${n.location!.lat},${n.location!.lng}`).catch(() => undefined) : undefined} />
          <Row label="Busy with" value={n.job ? `Job ${n.job.number}, ${n.job.store}${n.job.status === 'in_progress' ? ' (working now)' : n.job.status === 'continue_later' ? ' (continue later)' : ' (next)'}` : 'No open job'} />
          {n.job ? <Text style={[st.small, { paddingVertical: 4 }]}>{n.job.fault}</Text> : null}
          <Row label="With" value={n.with.length ? n.with.join(', ') : 'Nobody else'} />
        </Card>
      ) : null}
    </>
  );
}

export function ProfileDetails({ p, reload }: { p: Profile; reload: () => void }) {
  const s = useStore();
  const [edit, setEdit] = useState(false);
  const c = p.contact;
  const x = p.personal;
  const [f, setF] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string[] | null>(null);
  const start = () => {
    setF({ phone: c.phone ?? '', email: c.email ?? '', emergencyName: c.emergency_name ?? '', emergencyPhone: c.emergency_phone ?? '',
      idNumber: x?.id_number ?? '', dateOfBirth: x?.date_of_birth ?? '', homeAddress: x?.home_address ?? '', startDate: x?.start_date ?? '', notes: x?.notes ?? '' });
    setEdit(true); setErr(null);
  };
  const tel = (n: string | null) => (n ? () => Linking.openURL(`tel:${n.replace(/\s/g, '')}`).catch(() => undefined) : undefined);
  if (edit) {
    const fld = (k: string, label: string, extra: object = {}) => <Field key={k} label={label} value={f[k]} onChangeText={t => setF(v => ({ ...v, [k]: t }))} {...extra} />;
    return (
      <Card>
        <Heading>Edit {p.full_name.split(' ')[0]}'s details</Heading>
        {fld('phone', 'Phone', { keyboardType: 'phone-pad' })}{fld('email', 'Email', { keyboardType: 'email-address', autoCapitalize: 'none' })}
        {fld('emergencyName', 'Emergency contact (name)')}{fld('emergencyPhone', 'Emergency contact (phone)', { keyboardType: 'phone-pad' })}
        {fld('idNumber', 'ID number')}{fld('dateOfBirth', 'Date of birth (YYYY-MM-DD)')}{fld('homeAddress', 'Home address', { multiline: true })}
        {fld('startDate', 'Started at the company (YYYY-MM-DD)')}{fld('notes', 'Notes', { multiline: true })}
        {err ? <Notice tone="bad" title="Not saved" lines={err} /> : null}
        <Button label="Save" onPress={async () => {
          const r = await s.ask({ method: 'PUT', path: `/people/${p.id}/profile`, json: { phone: f.phone.trim() || null, email: f.email.trim() || '', emergencyName: f.emergencyName.trim() || null,
            emergencyPhone: f.emergencyPhone.trim() || null, idNumber: f.idNumber.trim() || null, dateOfBirth: f.dateOfBirth.trim() || null, homeAddress: f.homeAddress.trim() || null,
            startDate: f.startDate.trim() || null, notes: f.notes.trim() || null } });
          if (r && r.status < 300) { setEdit(false); reload(); } else setErr((r?.body as { reasons?: string[] })?.reasons ?? ['no signal: try again']);
        }} />
        <Button label="Cancel" kind="quiet" onPress={() => setEdit(false)} />
      </Card>
    );
  }
  return (
    <>
      <Card>
        <Label>Contact</Label>
        <Row label="Phone" value={c.phone} onPress={tel(c.phone)} />
        <Row label="Email" value={c.email} onPress={c.email ? () => Linking.openURL(`mailto:${c.email}`).catch(() => undefined) : undefined} />
        <Row label="Emergency contact" value={c.emergency_name ? `${c.emergency_name}${c.emergency_phone ? `, ${c.emergency_phone}` : ''}` : null} onPress={tel(c.emergency_phone)} />
      </Card>
      {x ? (
        <Card>
          <Label>Personal (only people who manage access see this)</Label>
          <Row label="ID number" value={x.id_number} />
          <Row label="Date of birth" value={x.date_of_birth ? day(x.date_of_birth) : null} />
          <Row label="Home address" value={x.home_address} />
          <Row label="Started" value={x.start_date ? day(x.start_date) : null} />
          {x.notes ? <Body>{x.notes}</Body> : null}
        </Card>
      ) : <Text style={st.small}>Personal details are only shown to the CEO, or someone the CEO gives "Positions and access".</Text>}
      {p.canEdit ? <Button label="Edit contact and personal details" kind="secondary" onPress={start} /> : null}
    </>
  );
}
