// The WhatsApp tab: the app's WhatsApp number, live. Every chat (the breakdowns group, stores, call
// centres, staff) with the newest first; open one to read it and reply from the app (the reply is signed
// with the person's name). A message that is a breakdown goes into the Breakdowns queue with one tap.
import React, { useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useStore } from '../state.tsx';
import { Body, Button, Notice, Pill, st } from '../ui.tsx';
import { C, S } from '../theme.ts';
import { usePhotoUri } from '../photo.ts';
import { WhatsAppSetup } from './WhatsAppSetup.tsx';

export interface Chat {
  id: string; jid: string; name: string; is_group: boolean; last_at: string | null; last_text: string | null; unread: number;
  breakdowns_group: boolean; po_group: boolean; mayWrite: boolean;
}
interface Msg {
  id: string; from_me: boolean; sender: string | null; sender_name: string | null; at: string; text: string; photo_ids: string[]; attachments: string[];
  status: 'received' | 'queued' | 'sent' | 'failed'; error: string | null; sent_by: string | null; breakdown_id: string | null;
}
interface Chats { link: { mode: 'phone' | 'official'; connected: boolean; number: string | null; running: boolean }; canSetup: boolean; chats: Chat[]; unread: number }

const time = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
};
const reasons = (r: { status: number; body: unknown } | null | undefined) => (r?.body as { reasons?: string[] })?.reasons ?? ['No signal: try again.'];

/** How many unread, for the tab's count (checked every 20 seconds). */
export function useWhatsAppUnread(on: boolean) {
  const s = useStore();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const f = () => s.ask({ method: 'GET', path: '/whatsapp/chats' }).then(r => { if (r?.status === 200) setN((r.body as Chats).unread); }).catch(() => undefined);
    f(); const t = setInterval(f, 20_000); return () => clearInterval(t);
  }, [on]);
  return n;
}

export function WhatsAppTab({ openBreakdown }: { openBreakdown?: (id: string) => void }) {
  const s = useStore();
  const wide = useWindowDimensions().width >= 900;
  const [d, setD] = useState<Chats | null>(null);
  const [err, setErr] = useState<string[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const load = async () => {
    const r = await s.ask({ method: 'GET', path: '/whatsapp/chats' });
    if (r?.status === 200) { setD(r.body as Chats); setErr(null); } else setErr(reasons(r));
  };
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);
  if (!d) return <View style={{ padding: S.pad }}>{err ? <Notice tone="bad" title="WhatsApp" lines={err} /> : <Body quiet>Loading…</Body>}</View>;

  if (!d.link.connected && !d.chats.length) {
    return (
      <ScrollView contentContainerStyle={{ padding: S.pad, gap: S.gap, paddingBottom: 40, maxWidth: 900 }}>
        <Text style={{ color: C.text, fontSize: 24, fontWeight: '800' }}>WhatsApp</Text>
        {d.canSetup ? <WhatsAppSetup changed={load} /> : <Notice tone="info" title="WhatsApp is not connected yet" lines={['The CEO connects it under Settings (or on the Start-up page). Then every chat shows here.']} />}
      </ScrollView>
    );
  }
  const shown = d.chats.filter(c => !q.trim() || `${c.name} ${c.last_text ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const chat = d.chats.find(c => c.id === open) ?? null;
  const list = (
    <ScrollView contentContainerStyle={{ padding: S.pad, gap: 6, paddingBottom: 40 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: C.text, fontSize: 24, fontWeight: '800', flex: 1 }}>WhatsApp</Text>
        <Pill text={d.link.connected ? `${d.link.number ? `+${d.link.number}` : 'Connected'}` : 'Not connected'} tone={d.link.connected ? 'good' : 'bad'} />
      </View>
      {!d.link.connected ? <Notice tone="warn" title="WhatsApp is not connected" lines={[d.canSetup ? 'Settings → WhatsApp to link it again. The chats below are what came in before.' : 'Tell the CEO: it is linked again under Settings.']} /> : null}
      <TextInput value={q} onChangeText={setQ} placeholder="Search chats" placeholderTextColor={C.quiet} style={st.input} accessibilityLabel="Search chats" />
      {shown.map(c => (
        <Pressable key={c.id} onPress={() => setOpen(c.id)} accessibilityRole="button" accessibilityLabel={`Chat ${c.name}`}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 10, backgroundColor: open === c.id ? C.panel2 : pressed ? C.panel2 : C.panel, borderWidth: 1, borderColor: open === c.id ? C.accent : C.line })}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.breakdowns_group ? C.accent : C.panel2, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: c.breakdowns_group ? '#FFF' : C.text, fontWeight: '900' }}>{c.is_group ? '👥' : c.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?'}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text numberOfLines={1} style={[st.body, { fontWeight: c.unread ? '900' : '700', flex: 1 }]}>{c.name}</Text>
              <Text style={[st.small, { color: c.unread ? C.good : C.quiet }]}>{time(c.last_at)}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text numberOfLines={1} style={[st.small, { flex: 1 }]}>{c.breakdowns_group ? '🔧 ' : c.po_group ? '🧾 ' : ''}{c.last_text ?? ''}</Text>
              {c.unread ? <View style={{ minWidth: 22, height: 22, borderRadius: 11, backgroundColor: C.good, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}><Text style={{ color: '#FFF', fontWeight: '900', fontSize: 12 }}>{c.unread}</Text></View> : null}
            </View>
          </View>
        </Pressable>
      ))}
      {!shown.length ? <Body quiet>{q ? 'No chat matches.' : 'No messages yet: they show here as they come in.'}</Body> : null}
      {d.link.mode === 'phone' ? <Text style={st.small}>The app's own phone number. Messages from the last few minutes before it was linked are not shown.</Text> : <Text style={st.small}>Your official WhatsApp number. You can reply within 24 hours of someone's last message.</Text>}
    </ScrollView>
  );
  const convo = chat ? <Conversation key={chat.id} chat={chat} canWrite={d.link.connected} back={() => setOpen(null)} wide={wide} changed={load} openBreakdown={openBreakdown} /> : null;
  if (!wide) return <View style={{ flex: 1 }}>{convo ?? list}</View>;
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <View style={{ width: 380, borderRightWidth: 1, borderRightColor: C.line }}>{list}</View>
      <View style={{ flex: 1 }}>{convo ?? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Body quiet>Choose a chat.</Body></View>}</View>
    </View>
  );
}

function Conversation({ chat, canWrite, back, wide, changed, openBreakdown }: { chat: Chat; canWrite: boolean; back: () => void; wide: boolean; changed: () => void; openBreakdown?: (id: string) => void }) {
  const s = useStore();
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string[] | null>(null);
  const [mayWrite, setMayWrite] = useState(chat.mayWrite);
  const scroll = useRef<ScrollView>(null);
  const last = useRef<string>('');
  const load = async () => {
    const r = await s.ask({ method: 'GET', path: `/whatsapp/chats/${chat.id}/messages` });
    if (r?.status === 200) {
      const b = r.body as { chat: { mayWrite: boolean }; messages: Msg[] };
      setMsgs(b.messages); setMayWrite(b.chat.mayWrite);
      const key = b.messages.map(m => `${m.id}${m.status}`).join();
      if (key !== last.current) { last.current = key; setTimeout(() => scroll.current?.scrollToEnd({ animated: false }), 50); }
    }
  };
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [chat.id]);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr(null);
    const r = await s.ask({ method: 'POST', path: `/whatsapp/chats/${chat.id}/messages`, json: { text: text.trim() } });
    setBusy(false);
    if (r?.status === 200) { setText(''); load(); changed(); } else setErr(reasons(r));
  };
  const toBreakdown = async (m: Msg) => {
    const r = await s.ask({ method: 'POST', path: `/whatsapp/messages/${m.id}/breakdown`, json: {} });
    if (r?.status === 200) { load(); const id = (r.body as { breakdownId: string | null }).breakdownId; if (id && openBreakdown) openBreakdown(id); } else setErr(reasons(r));
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: S.pad, borderBottomWidth: 1, borderBottomColor: C.line }}>
        {!wide ? <Pressable onPress={back} accessibilityRole="button" accessibilityLabel="Back to the chats" hitSlop={10}><Text style={{ color: C.text, fontSize: 30 }}>‹</Text></Pressable> : null}
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[st.body, { fontWeight: '900', fontSize: 18 }]}>{chat.name}</Text>
          <Text style={st.small}>{chat.breakdowns_group ? 'Breakdowns group: messages here also go into Breakdowns' : chat.po_group ? 'Purchase orders group' : chat.is_group ? 'Group' : `+${chat.jid.split('@')[0]}`}</Text>
        </View>
      </View>
      <ScrollView ref={scroll} contentContainerStyle={{ padding: S.pad, gap: 8, paddingBottom: 20 }}>
        {!msgs ? <Body quiet>Loading…</Body> : null}
        {msgs?.map(m => <Bubble key={m.id} m={m} group={chat.is_group} toBreakdown={!m.from_me && !chat.breakdowns_group && !chat.po_group ? () => toBreakdown(m) : undefined} openBreakdown={openBreakdown} />)}
        {msgs && !msgs.length ? <Body quiet>No messages yet.</Body> : null}
      </ScrollView>
      {err ? <View style={{ paddingHorizontal: S.pad }}><Notice tone="bad" title="Not sent" lines={err} /></View> : null}
      {!canWrite ? <View style={{ padding: S.pad }}><Notice tone="warn" title="WhatsApp is not connected" lines={['Replies can be sent again once it is linked.']} /></View>
        : !mayWrite ? <View style={{ padding: S.pad }}><Notice tone="info" title="Over 24 hours since their last message" lines={['WhatsApp only lets an official number reply within 24 hours. Ask them to send a message, or phone them.']} /></View>
          : (
            <View style={{ flexDirection: 'row', gap: 8, padding: S.pad, borderTopWidth: 1, borderTopColor: C.line, alignItems: 'flex-end' }}>
              <TextInput value={text} onChangeText={setText} placeholder="Type a reply" placeholderTextColor={C.quiet} multiline accessibilityLabel="Reply"
                style={[st.input, { flex: 1, minHeight: 48, maxHeight: 140 }]} />
              <Button label="Send" busy={busy} disabled={!text.trim()} onPress={send} />
            </View>
          )}
    </View>
  );
}

function Bubble({ m, group, toBreakdown, openBreakdown }: { m: Msg; group: boolean; toBreakdown?: () => void; openBreakdown?: (id: string) => void }) {
  return (
    <View style={{ alignSelf: m.from_me ? 'flex-end' : 'flex-start', maxWidth: '85%', gap: 4 }}>
      <View style={{ backgroundColor: m.from_me ? C.accent : C.panel2, borderRadius: 12, padding: 10, gap: 6 }}>
        {group && !m.from_me ? <Text style={{ color: C.info, fontWeight: '800', fontSize: 13 }}>{m.sender_name ?? (m.sender ? `+${m.sender}` : '')}</Text> : null}
        {m.photo_ids.map(id => <Photo key={id} id={id} />)}
        {m.text ? <Text selectable style={{ color: m.from_me ? '#FFF' : C.text, fontSize: 15 }}>{m.text}</Text> : null}
        {m.attachments.map(a => <Text key={a} style={{ color: m.from_me ? '#FFF' : C.quiet, fontStyle: 'italic' }}>{a[0].toUpperCase() + a.slice(1)} (open WhatsApp on the phone to see it)</Text>)}
        <Text style={{ color: m.from_me ? '#FFFFFFCC' : C.quiet, fontSize: 11, alignSelf: 'flex-end' }}>
          {time(m.at)}{m.from_me ? (m.status === 'queued' ? ' · sending…' : m.status === 'failed' ? ' · not sent' : ' ✓') : ''}{m.sent_by ? ` · ${m.sent_by}` : ''}
        </Text>
      </View>
      {m.status === 'failed' ? <Text style={[st.small, { color: C.bad }]}>Not sent: {m.error ?? 'try again'}</Text> : null}
      {m.breakdown_id ? (
        <Pressable onPress={openBreakdown ? () => openBreakdown(m.breakdown_id!) : undefined} accessibilityRole="button"><Text style={[st.small, { color: C.good }]}>✓ In Breakdowns</Text></Pressable>
      ) : toBreakdown ? (
        <Pressable onPress={toBreakdown} accessibilityRole="button" accessibilityLabel="Make it a breakdown"><Text style={[st.small, { color: C.info, fontWeight: '700' }]}>Make it a breakdown</Text></Pressable>
      ) : null}
    </View>
  );
}

function Photo({ id }: { id: string }) {
  const uri = usePhotoUri(id);
  return uri ? <Image source={{ uri }} style={{ width: 240, height: 180, borderRadius: 8, backgroundColor: '#000' }} resizeMode="cover" accessibilityLabel="Photo" />
    : <View style={{ width: 240, height: 60, borderRadius: 8, backgroundColor: C.panel, alignItems: 'center', justifyContent: 'center' }}><Text style={st.small}>📷 Photo</Text></View>;
}
