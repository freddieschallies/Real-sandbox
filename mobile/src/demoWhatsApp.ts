// The test drive's WhatsApp: the guided set-up (the QR code is "scanned" by itself after a few seconds;
// Meta's window for the official number is pretended) and the WhatsApp tab with a few chats. The
// breakdowns group shows what the Breakdowns queue got from it and the app's own lines. Nothing is sent.
import type { DemoBdState, DemoBreakdowns } from './demoBreakdowns.ts';

type Res = { ok: true; body: unknown } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown): Res => ({ ok: true, body });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const now = () => new Date().toISOString();
const since = (iso: string | null) => (iso ? Date.now() - Date.parse(iso) : Infinity);

interface DemoChat { id: string; jid: string; name: string; is_group: boolean; readAt: string; last_in_at: string | null }
interface DemoMsg {
  id: string; chatId: string; from_me: boolean; sender: string | null; sender_name: string | null; at: string; text: string;
  status: 'received' | 'queued' | 'sent' | 'failed'; sent_by: string | null; breakdown_id: string | null;
}
export interface DemoWaState {
  setup: { chosen: boolean; mode: 'phone' | 'official'; wanted: boolean; linkRequestedAt: string | null; qrAt: string | null; expired: boolean;
    testSentAt: string | null; testOkAt: string | null; officialName: string | null; officialAt: string | null; breakdownsFromChats: boolean; groups: { jid: string; name: string }[] };
  chats: DemoChat[]; msgs: DemoMsg[]; seq: number;
}

export function seedWhatsApp(bd: DemoBdState, company: string): DemoWaState {
  const chats: DemoChat[] = [
    { id: 'chat-group', jid: 'g-breakdowns', name: bd.whatsapp.group_name ?? `${company} Breakdowns`, is_group: true, readAt: ago(10), last_in_at: null },
    { id: 'chat-spar', jid: '27725550188@s', name: 'Sipho (store manager)', is_group: false, readAt: ago(60), last_in_at: ago(7) },
    { id: 'chat-cc', jid: '27115550123@s', name: 'Call centre', is_group: false, readAt: ago(30), last_in_at: ago(35) },
    { id: 'chat-staff', jid: 'g-staff', name: `${company} Staff`, is_group: true, readAt: ago(120), last_in_at: null },
  ];
  const m = (id: string, chatId: string, min: number, text: string, from: { name: string; num: string } | null, sentBy: string | null = null): DemoMsg =>
    ({ id, chatId, from_me: !from, sender: from?.num ?? null, sender_name: from?.name ?? null, at: ago(min), text, status: from ? 'received' : 'sent', sent_by: sentBy, breakdown_id: null });
  const sipho = { name: 'Sipho (store manager)', num: '27725550188' };
  const msgs: DemoMsg[] = [
    m('wa-1', 'chat-spar', 95, 'Morning, thanks for the quick service on the ice machine last week 👍', sipho),
    m('wa-2', 'chat-spar', 94, 'Pleasure, shout if anything else comes up.\n— Office', null, 'Office'),
    m('wa-3', 'chat-spar', 7, 'Hi, our walk-in freezer is showing -8 and rising. Can someone come today?', sipho),
    m('wa-4', 'chat-cc', 36, 'Good day, please confirm you received call CC-784512 for the ice machine.', { name: 'Call centre', num: '27115550123' }),
    m('wa-5', 'chat-cc', 34, 'Received, the technician is on the way.\n— Office', null, 'Office'),
    m('wa-6', 'chat-staff', 180, 'Toolbox talk Monday 07:00 at the workshop.', { name: 'Workshop', num: '27720000111' }),
  ];
  return {
    setup: { chosen: true, mode: 'phone', wanted: true, linkRequestedAt: ago(60 * 24 * 7), qrAt: null, expired: false, testSentAt: ago(60 * 24 * 7), testOkAt: ago(60 * 24 * 7),
      officialName: null, officialAt: null, breakdownsFromChats: true, groups: bd.whatsapp.groups },
    chats, msgs, seq: 10,
  };
}

export class DemoWhatsApp {
  constructor(public s: DemoWaState, private bd: DemoBreakdowns, private company: string, private me: string) {}
  private get w() { return this.bd.s.whatsapp; }

  /** Moves the pretend link along: the code shows after a moment, and is "scanned" a few seconds later. */
  private tick() {
    const st = this.s.setup;
    if (st.mode === 'phone' && this.w.state === 'starting' && since(st.linkRequestedAt) > 2500) { this.w.state = 'waiting_for_scan'; st.qrAt = now(); }
    if (st.mode === 'phone' && this.w.state === 'waiting_for_scan' && since(st.qrAt) > 9000) {
      this.w.state = 'connected'; this.w.number = '27720000000'; this.w.groups = st.groups;
    }
    if (st.mode === 'official' && this.w.state === 'connected' && !st.testOkAt && since(st.officialAt) > 6000) {
      // "Send it a message from your own phone": it arrives.
      const chat = this.chat('27820000001@s', 'You (test)', false);
      this.s.msgs.push({ id: `wa-${++this.s.seq}`, chatId: chat.id, from_me: false, sender: '27820000001', sender_name: 'You (test)', at: now(), text: 'Hi 👋', status: 'received', sent_by: null, breakdown_id: null });
      chat.last_in_at = now();
      st.testOkAt = now();
    }
    // Replies "sent" a moment later; a person answers a reply now and then.
    for (const m of this.s.msgs) if (m.status === 'queued' && since(m.at) > 1500) m.status = 'sent';
  }

  private chat(jid: string, name: string, isGroup: boolean) {
    let c = this.s.chats.find(x => x.jid === jid);
    if (!c) { c = { id: `chat-${++this.s.seq}`, jid, name, is_group: isGroup, readAt: new Date(0).toISOString(), last_in_at: null }; this.s.chats.push(c); }
    return c;
  }

  setup() {
    this.tick();
    const st = this.s.setup, w = this.w;
    const connected = w.state === 'connected';
    const steps = st.mode === 'phone'
      ? [{ key: 'phone', done: connected || st.wanted }, { key: 'link', done: connected }, { key: 'group', done: connected && !!w.group_jid }, { key: 'test', done: !!st.testOkAt }]
      : [{ key: 'number', done: connected }, { key: 'test', done: !!st.testOkAt }];
    return {
      chosen: st.chosen, mode: st.mode, state: w.state, connected, wanted: st.wanted, running: true,
      qrSvg: w.state === 'waiting_for_scan' ? demoQr(Math.floor(Date.now() / 4000)) : null, linkRequestedAt: st.linkRequestedAt,
      number: connected ? w.number : null, groups: connected && st.mode === 'phone' ? w.groups : [], groupJid: w.group_jid, groupName: w.group_name,
      poGroupJid: w.po_group_jid ?? null, poGroupName: w.po_group_name ?? null, testSentAt: st.testSentAt, testOkAt: st.testOkAt, breakdownsFromChats: st.breakdownsFromChats,
      official: { available: true, appId: 'demo', configId: 'demo', name: st.officialName }, steps, done: steps.every(x => x.done),
    };
  }
  mode(m: 'phone' | 'official'): Res {
    const st = this.s.setup;
    if (st.mode !== m && (this.w.state === 'connected' || st.wanted)) return bad(409, 'disconnect the number you have first, then choose the other way');
    Object.assign(st, { chosen: true, mode: m });
    return good(this.setup());
  }
  link(): Res {
    const st = this.s.setup;
    if (st.mode !== 'phone') return bad(409, 'this company uses the official number');
    if (this.w.state === 'connected') return good(this.setup());
    Object.assign(st, { wanted: true, linkRequestedAt: now(), qrAt: null, expired: false });
    this.w.state = 'starting';
    return good(this.setup());
  }
  disconnect(): Res {
    const st = this.s.setup;
    Object.assign(st, { wanted: false, testSentAt: null, testOkAt: null, officialName: null, officialAt: null, linkRequestedAt: null });
    Object.assign(this.w, { state: 'not_linked', group_jid: null, group_name: null, po_group_jid: null, po_group_name: null, groups: [] });
    return good(this.setup());
  }
  official(): Res {
    Object.assign(this.s.setup, { chosen: true, mode: 'official', officialName: `${this.company} Service`, officialAt: now(), wanted: false });
    Object.assign(this.w, { state: 'connected', number: '27875550101' });
    return good(this.setup());
  }
  test(): Res {
    if (this.w.state !== 'connected') return bad(409, 'link the number first');
    if (this.s.setup.mode === 'official') return bad(409, 'with the official number: send it a WhatsApp from your own phone; it shows here when it arrives');
    if (!this.w.group_jid) return bad(409, 'choose the breakdowns group first');
    this.bd.s.posts.unshift({ text: '✅ Real Sandbox is connected to this group. Breakdowns posted here now come into the app by themselves.', reason: 'test', created_at: now(), sent_at: now(), error: null });
    this.s.setup.testSentAt = now();
    return good(this.setup());
  }
  testOk(): Res { this.s.setup.testOkAt = now(); return good(this.setup()); }
  settings(b: { breakdownsFromChats?: boolean }): Res { this.s.setup.breakdownsFromChats = !!b.breakdownsFromChats; return good(this.setup()); }

  // ---- The WhatsApp tab ----

  /** The breakdowns group's messages: what came into Breakdowns from it, and the app's own lines. */
  private groupMsgs(): DemoMsg[] {
    const g = this.s.chats.find(c => c.jid === 'g-breakdowns');
    if (!g) return [];
    const fromQueue = this.bd.s.items.filter(b => b.channel === 'whatsapp' && !this.s.msgs.some(m => m.breakdown_id === b.id && m.chatId !== g.id))
      .map(b => ({ id: `wa-bd-${b.id}`, chatId: g.id, from_me: false, sender: b.sender, sender_name: b.sender_name, at: b.received_at, text: b.body, status: 'received' as const, sent_by: null, breakdown_id: b.id }));
    const posts = this.bd.s.posts.filter(p => p.sent_at).map((p, i) => ({ id: `wa-post-${p.created_at}-${i}`, chatId: g.id, from_me: true, sender: null, sender_name: null, at: p.sent_at!, text: p.text, status: 'sent' as const, sent_by: null, breakdown_id: null }));
    return [...fromQueue, ...posts];
  }
  private all(chatId: string) {
    const t = now();
    // A pretend reply shows once its time has come.
    return [...this.s.msgs.filter(m => m.chatId === chatId && (m.from_me || m.at <= t)), ...(this.s.chats.find(c => c.id === chatId)?.jid === 'g-breakdowns' ? this.groupMsgs() : [])].sort((a, b) => a.at.localeCompare(b.at));
  }
  private mayWrite(c: DemoChat) { return this.s.setup.mode !== 'official' || c.is_group || since(c.last_in_at) < 24 * 3600_000; }

  chats(canSetup: boolean) {
    this.tick();
    const visible = this.s.setup.mode === 'official' ? this.s.chats.filter(c => !c.is_group) : this.s.chats;
    const rows = visible.map(c => {
      const ms = this.all(c.id);
      const last = ms.at(-1);
      return { id: c.id, jid: c.jid, name: c.name, is_group: c.is_group, last_at: last?.at ?? null, last_text: last ? last.text.split('\n')[0].slice(0, 160) : null,
        unread: ms.filter(m => !m.from_me && m.at > c.readAt).length, breakdowns_group: c.jid === this.w.group_jid, po_group: c.jid === this.w.po_group_jid, mayWrite: this.mayWrite(c) };
    }).sort((a, b) => (b.last_at ?? '').localeCompare(a.last_at ?? ''));
    return { link: { mode: this.s.setup.mode, connected: this.w.state === 'connected', number: this.w.state === 'connected' ? this.w.number : null, running: true }, canSetup, chats: rows, unread: rows.reduce((n, c) => n + c.unread, 0) };
  }
  messages(chatId: string): Res {
    this.tick();
    const c = this.s.chats.find(x => x.id === chatId);
    if (!c) return bad(404, 'no such chat');
    c.readAt = now();
    const ms = this.all(chatId).map(m => ({ id: m.id, from_me: m.from_me, sender: m.sender, sender_name: m.sender_name, at: m.at, text: m.text, photo_ids: [], attachments: [], status: m.status, error: null, sent_by: m.sent_by, breakdown_id: m.breakdown_id }));
    return good({ chat: { id: c.id, jid: c.jid, name: c.name, is_group: c.is_group, mayWrite: this.mayWrite(c) }, messages: ms.slice(-60), more: ms.length > 60 });
  }
  reply(chatId: string, text: string): Res {
    const c = this.s.chats.find(x => x.id === chatId);
    if (!c) return bad(404, 'no such chat');
    if (!text?.trim()) return bad(400, 'type the message');
    if (this.w.state !== 'connected') return bad(409, 'WhatsApp is not connected: the CEO links it under Settings');
    if (!this.mayWrite(c)) return bad(409, 'WhatsApp only lets the official number write within 24 hours of their last message: ask them to send a message first, or phone them');
    const id = `wa-${++this.s.seq}`;
    this.s.msgs.push({ id, chatId, from_me: true, sender: null, sender_name: null, at: now(), text: `${text.trim()}\n— ${this.me}`, status: 'queued', sent_by: this.me, breakdown_id: null });
    // A person answers a few seconds later (the test drive's pretend reply).
    if (!c.is_group) {
      const at = new Date(Date.now() + 6000).toISOString();
      this.s.msgs.push({ id: `wa-${++this.s.seq}`, chatId, from_me: false, sender: c.jid.split('@')[0], sender_name: c.name, at, text: 'Thank you 👍', status: 'received', sent_by: null, breakdown_id: null });
      c.last_in_at = at;
    }
    return good({ id });
  }
  toBreakdown(msgId: string): Res {
    const m = this.s.msgs.find(x => x.id === msgId);
    if (!m) { const g = this.groupMsgs().find(x => x.id === msgId); return g?.breakdown_id ? good({ breakdownId: g.breakdown_id }) : bad(404, 'no such message'); }
    if (m.breakdown_id) return good({ breakdownId: m.breakdown_id });
    if (m.from_me) return bad(400, 'that is the office\'s own message');
    m.breakdown_id = this.bd.fromChat(m.text, m.sender_name, m.sender, m.at);
    return good({ breakdownId: m.breakdown_id });
  }
}

/** A QR-like picture for the test drive (not a real code: nothing to scan). */
export function demoQr(seed: number): string {
  let x = (seed * 2654435761) >>> 0;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const n = 29, cells: string[] = [];
  const dark = (r: number, c: number) => {
    for (const [fr, fc] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      if (r >= fr && r < fr + 7 && c >= fc && c < fc + 7) { const a = r - fr, b = c - fc; return a === 0 || a === 6 || b === 0 || b === 6 || (a >= 2 && a <= 4 && b >= 2 && b <= 4); }
    }
    return rnd() < 0.48;
  };
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) cells.push(`<rect x="${c + 2}" y="${r + 2}" width="1" height="1"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${cells.join('')}</g></svg>`;
}
