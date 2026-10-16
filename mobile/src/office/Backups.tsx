// Settings → Backups (the CEO): when the company's data was last backed up, on the office server and in
// the cloud, and the space the company takes.
import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { useStore } from '../state.tsx';
import { Card, Heading, Notice, st } from '../ui.tsx';
import { size, type Backup } from '../owner/OwnerApp.tsx';

export function BackupSettings() {
  const s = useStore();
  const [d, setD] = useState<{ backup: Backup; storage: { dbBytes: number; photoBytes: number; documentBytes: number; pdfBytes: number; totalBytes: number; files: number }; demo?: boolean } | null>(null);
  useEffect(() => { s.ask({ method: 'GET', path: '/company/backup' }).then(r => { if (r?.status === 200) setD(r.body); }).catch(() => {}); }, []);
  if (!d) return null;
  const b = d.backup, x = d.storage;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' }) : 'never');
  return (
    <Card>
      <Heading>Backups</Heading>
      <Text style={st.small}>Every day at 01:30 all your records, documents and photos are copied on the office server, and an encrypted copy goes to the cloud. Nothing is ever lost if a phone, the office PC or its disk is.</Text>
      {b.state === 'ok' ? <Notice tone={b.cloud.configured && b.cloud.ok ? 'good' : 'warn'} title={`Last backup: ${when(b.at)}`} lines={[b.cloud.configured ? (b.cloud.ok ? `Also in the cloud (encrypted), ${when(b.cloud.lastOkAt)}.` : 'The cloud copy did not go through: Real Sandbox support has been told.') : 'Not in the cloud yet: it is being set up on the office server.']} />
        : <Notice tone={b.state === 'none' ? 'warn' : 'bad'} title={b.state === 'none' ? 'No backup yet' : b.state === 'late' ? `No backup for ${Math.round(b.ageHours ?? 0)} hours` : 'The last backup had a problem'} lines={b.state === 'none' ? ['It starts once the office server is set up.'] : ['Real Sandbox support can see this too. Is the office server on?']} />}
      <Text style={st.small}>Your company takes {size(x.totalBytes)}: records {size(x.dbBytes)}, photos {size(x.photoBytes)}, documents {size(x.documentBytes)}, PDFs made {size(x.pdfBytes)}.{d.demo ? ' (Test drive: made-up numbers.)' : ''}</Text>
    </Card>
  );
}
