// What is waiting to be sent, and what the office refused.
import React from 'react';
import { useStore } from '../state.tsx';
import { useNav } from '../nav.tsx';
import { Body, Button, Card, Heading, Notice, Screen } from '../ui.tsx';

export function Sync() {
  const s = useStore();
  const nav = useNav();
  const last = s.lastSentAt ? new Date(s.lastSentAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }) : 'not yet';
  return (
    <Screen title="Sending to the office" onBack={nav.back}>
      <Body quiet>{s.online ? 'Signal: yes' : 'Signal: no'} · last sent {last}</Body>
      {s.blocked ? (
        <Card>
          <Notice tone="bad" title={`Refused: ${s.blocked.entry.label}`} lines={s.blocked.reasons} />
          <Body quiet>Nothing after this can be sent until it is sorted. If you discard it, the changes after it on the same job are discarded too and the job card is reloaded from the office.</Body>
          <Button label="Discard and reload" kind="danger" onPress={s.discardBlocked} />
        </Card>
      ) : null}
      <Heading>{s.waiting ? `${s.waiting} waiting` : 'Everything has been sent'}</Heading>
      <Button label="Send now" kind="secondary" onPress={s.syncNow} busy={s.syncing} disabled={!s.waiting || !!s.blocked} />
    </Screen>
  );
}
