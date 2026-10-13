// Settings → Photo storage (the CEO): how much space the company's photos take on the server.
// Photos are made smaller on the phone before they are sent; this shows it is working.
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useStore } from './state.tsx';
import { Body, Card, Heading, Label, st } from './ui.tsx';
import { C } from './theme.ts';
import { PROFILES } from './compress.ts';

interface Storage { photos: number; bytes: number; photos30: number; bytes30: number; over1mb: number; averageBytes: number; kinds: { kind: string; photos: number; bytes: number }[]; demo?: boolean }
export const mb = (b: number) => (b >= 1_000_000_000 ? `${(b / 1_000_000_000).toFixed(2)} GB` : b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.round(b / 1000)} KB`);

export function StorageSettings() {
  const s = useStore();
  const [d, setD] = useState<Storage | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => { s.ask({ method: 'GET', path: '/company/storage' }).then(r => { if (r?.status === 200) setD(r.body); setShown(r?.status === 200); }).catch(() => {}); }, []);
  if (!shown || !d) return null;
  const box = (label: string, value: string, warn = false) => (
    <View style={{ flex: 1, minWidth: 130, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: warn ? C.warn : C.line }}>
      <Text style={st.small}>{label}</Text>
      <Text style={{ color: warn ? C.warn : C.text, fontSize: 20, fontWeight: '800' }}>{value}</Text>
    </View>
  );
  return (
    <View style={{ gap: 12, maxWidth: 820 }}>
      <Heading>Photo storage</Heading>
      <Card>
        <Body quiet>Every photo is made smaller on the phone before it is sent: job photos to {PROFILES.photo.maxEdge} px (about {Math.round(PROFILES.photo.targetBytes / 1000)} KB at most), invoices and slips to {PROFILES.document.maxEdge} px so they stay readable. The server refuses anything over 4 MB.{d.demo ? ' In this test drive the figures are for the photos taken here.' : ''}</Body>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {box('Photos kept', String(d.photos))}{box('Space used', mb(d.bytes))}{box('Average photo', d.photos ? mb(d.averageBytes) : '–', d.averageBytes > 600_000)}
          {box('Last 30 days', `${d.photos30} · ${mb(d.bytes30)}`)}{box('Over 1 MB', String(d.over1mb), d.over1mb > 0)}
        </View>
        {d.kinds.length ? <Label>By kind</Label> : null}
        {d.kinds.map(k => (
          <View key={k.kind} style={{ flexDirection: 'row', gap: 8, paddingVertical: 4, borderTopWidth: 1, borderTopColor: C.line }}>
            <Text style={[st.body, { flex: 1 }]}>{k.kind.replace(/_/g, ' ')}</Text>
            <Text style={st.small}>{k.photos} · {mb(k.bytes)}</Text>
          </View>
        ))}
      </Card>
    </View>
  );
}
