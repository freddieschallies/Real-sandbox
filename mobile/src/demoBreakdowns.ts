// The test drive's Breakdowns queue: a few emails and WhatsApp group messages, read the same way the
// server reads them, a pretend Gmail inbox and a pretend linked WhatsApp group. Nothing is sent.
import { groupLine, readByRules, type StoreRef } from '../../server/src/core/breakdownRead.ts';

export interface DemoBd {
  id: string; channel: 'email' | 'whatsapp'; received_at: string; sender_name: string | null; sender: string | null; subject: string | null; body: string;
  photo_ids: string[]; attachments: string[]; kind: 'breakdown' | 'inquiry' | 'other'; read_by: 'ai' | 'rules';
  store_id: string | null; store_text: string | null; fault: string | null; call_ref: string | null; urgent: boolean;
  status: 'new' | 'logged' | 'merged' | 'ignored'; job_id: string | null; handled_by: string | null; handled_at: string | null; note: string | null;
}
export interface DemoBdState {
  items: DemoBd[]; posts: { text: string; reason: string; created_at: string; sent_at: string | null; error: string | null }[];
  settings: { post_new: boolean; post_logged: boolean; post_on_site: boolean; post_done: boolean; escalate_after_min: number; ignore_senders: string[] };
  inboxes: { id: string; address: string; active: boolean; last_checked_at: string | null; last_error: string | null }[];
  whatsapp: { state: string; number: string; groups: { jid: string; name: string }[]; group_jid: string | null; group_name: string | null; po_group_jid?: string | null; po_group_name?: string | null };
  fromQueue: { jobId: string; storeId: string; at: string }[];
  seq: number;
}

type Res = { ok: true; body: unknown } | { ok: false; status: number; reasons: string[] };
const good = (body: unknown): Res => ({ ok: true, body });
const bad = (status: number, ...reasons: string[]): Res => ({ ok: false, status, reasons });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** The jobs and stores the queue needs from the rest of the demo. */
export interface BdSources {
  stores: () => (StoreRef & { address?: string | null })[];
  jobs: () => { id: string; job_number: number; status: string; store_id: string | null; store: string; client_order_ref: string | null; lead: string }[];
}

export function seedBreakdowns(stores: (StoreRef & { address?: string | null })[], company: string): DemoBdState {
  const by = (id: string) => stores.find(s => s.id === id) ?? stores[0];
  const m = by('meerensee'), a = by('arboretum'), e = by('esikhawini');
  const mk = (o: Omit<DemoBd, 'kind' | 'read_by' | 'store_id' | 'store_text' | 'fault' | 'call_ref' | 'urgent' | 'status' | 'job_id' | 'handled_by' | 'handled_at' | 'note' | 'photo_ids' | 'attachments'> & { attachments?: string[] }): DemoBd => {
    const r = readByRules(o.subject ?? '', o.body, stores);
    return { ...o, photo_ids: [], attachments: o.attachments ?? [], kind: r.kind, read_by: 'rules', store_id: r.storeId, store_text: r.storeText, fault: r.fault, call_ref: r.callRef, urgent: r.urgent, status: 'new', job_id: null, handled_by: null, handled_at: null, note: null };
  };
  const items = [
    mk({ id: 'bd-1', channel: 'email', received_at: ago(26), sender_name: 'Call Centre', sender: 'calls@callcentre.demo', subject: 'Call logged: Ref CC-784512',
      body: `Good day\n\nPlease attend to the following call.\nStore: ${m.name}\nEquipment: Ice machine\nFault: Ice machine not making ice\nPriority: Urgent, stock at risk\nCall ref: CC-784512\n\nRegards\nCall Centre` }),
    mk({ id: 'bd-2', channel: 'whatsapp', received_at: ago(19), sender_name: 'Front desk', sender: '27725550100', subject: null,
      body: `${m.name} ice machine down again, call ref CC-784512. Store manager phoned too.` }),
    mk({ id: 'bd-3', channel: 'email', received_at: ago(9), sender_name: 'Store manager', sender: 'manager@store.demo', subject: 'Cold room not cooling',
      body: `Hi\n\nOur cold room at ${a.name} is at 9 degrees and rising, the fans are running but it is not cooling. Please send someone today.\n\nThanks` }),
    mk({ id: 'bd-4', channel: 'whatsapp', received_at: ago(4), sender_name: 'Front desk', sender: '27725550100', subject: null,
      body: `${e.name}: combi oven showing an error, not heating. Store asking for a time.` }),
    mk({ id: 'bd-5', channel: 'email', received_at: ago(40), sender_name: 'Accounts', sender: 'accounts@supplier.demo', subject: 'Statement: September',
      body: 'Good day, please find your statement for September attached. Kindly send remittance once paid.', attachments: ['Statement-September.pdf'] }),
  ];
  return {
    items, posts: [{ text: groupLine({ kind: 'new', via: 'email', store: m.name, fault: 'Ice machine not making ice', callRef: 'CC-784512', urgent: true }), reason: 'new', created_at: ago(26), sent_at: ago(26), error: null },
      { text: groupLine({ kind: 'new', via: 'email', store: a.name, fault: items[2].fault, callRef: null }), reason: 'new', created_at: ago(9), sent_at: ago(9), error: null }],
    settings: { post_new: true, post_logged: true, post_on_site: false, post_done: false, escalate_after_min: 15, ignore_senders: [] },
    inboxes: [{ id: 'inbox-1', address: 'breakdowns@yourcompany.demo', active: true, last_checked_at: ago(0.5), last_error: null }],
    whatsapp: { state: 'connected', number: '27720000000', groups: [{ jid: 'g-breakdowns', name: `${company} Breakdowns` }, { jid: 'g-staff', name: `${company} Staff` }, { jid: 'g-pos', name: `${company} Purchase orders` }], group_jid: 'g-breakdowns', group_name: `${company} Breakdowns` },
    fromQueue: [], seq: 6,
  };
}

const PRETEND = [
  { fault: 'Bottle fridge not cooling, drinks warm', ref: (n: number) => `CC-${790000 + n}`, urgent: false },
  { fault: 'Freezer alarm, temperature going up, stock at risk: urgent', ref: () => null, urgent: true },
  { fault: 'Pie warmer tripping the breaker', ref: (n: number) => `${880000 + n}`, urgent: false },
];
export class DemoBreakdowns {
  constructor(public s: DemoBdState, private src: BdSources) {}

  private view(b: DemoBd) {
    const store = b.store_id ? this.src.stores().find(x => x.id === b.store_id) : undefined;
    const job = b.job_id ? this.src.jobs().find(j => j.id === b.job_id) : undefined;
    return { ...b, store: store?.name ?? null, client: store?.client ?? null, job_number: job?.job_number ?? null, escalated_at: null, same: b.status === 'new' ? this.same(b) : null };
  }

  /** An open job this may already be: the same call log number, or a job logged from the queue at the same store in the last two days. */
  same(b: { call_ref: string | null; store_id: string | null }) {
    const jobs = this.src.jobs();
    if (b.call_ref) {
      const j = jobs.find(x => x.client_order_ref && x.client_order_ref.toUpperCase() === b.call_ref!.toUpperCase() && x.status !== 'cancelled');
      if (j) return { id: j.id, job_number: j.job_number, status: j.status, store: j.store, why: 'call_ref' as const };
    }
    if (b.store_id) {
      const q = this.s.fromQueue.filter(x => x.storeId === b.store_id && Date.now() - Date.parse(x.at) < 2 * 86_400_000).map(x => jobs.find(j => j.id === x.jobId)).find(j => j && !['closed', 'cancelled'].includes(j.status));
      if (q) return { id: q.id, job_number: q.job_number, status: q.status, store: q.store, why: 'store' as const };
    }
    return null;
  }

  count() {
    const open = this.s.items.filter(b => b.status === 'new');
    const latest = open.filter(b => b.kind === 'breakdown').sort((x, y) => y.received_at.localeCompare(x.received_at))[0];
    return { breakdowns: open.filter(b => b.kind === 'breakdown').length, other: open.filter(b => b.kind !== 'breakdown').length,
      latest: latest ? { id: latest.id, at: latest.received_at, store: this.view(latest).store ?? latest.store_text, fault: latest.fault, urgent: latest.urgent, channel: latest.channel } : null };
  }

  list(view: 'open' | 'done', canSettings: boolean) {
    const items = view === 'open'
      ? this.s.items.filter(b => b.status === 'new').sort((x, y) => Number(y.kind === 'breakdown') - Number(x.kind === 'breakdown') || Number(y.urgent) - Number(x.urgent) || x.received_at.localeCompare(y.received_at))
      : this.s.items.filter(b => b.status !== 'new').sort((x, y) => (y.handled_at ?? '').localeCompare(x.handled_at ?? ''));
    return { items: items.map(b => this.view(b)), canSettings, whatsapp: { state: this.s.whatsapp.state, group_name: this.s.whatsapp.group_name }, inboxes: this.s.inboxes.filter(i => i.active), posts: this.s.posts.slice(0, 10) };
  }

  private post(reason: string, text: string) {
    if (!this.s.whatsapp.group_jid) return;
    this.s.posts.unshift({ text, reason, created_at: new Date().toISOString(), sent_at: new Date().toISOString(), error: null });
    this.s.posts = this.s.posts.slice(0, 50);
  }

  /** After the job is made (by the demo's own New job): mark it logged, add the same call from the other channel, tell the group. */
  logged(id: string, job: { id: string; job_number: number; store_id: string; store: string; lead: string; ref: string | null }, by: string): Res {
    const b = this.s.items.find(x => x.id === id);
    if (!b) return bad(404, 'no such breakdown');
    Object.assign(b, { status: 'logged', job_id: job.id, handled_by: by, handled_at: new Date().toISOString(), store_id: b.store_id ?? job.store_id });
    const ref = job.ref ?? b.call_ref;
    let merged = 0;
    if (ref) for (const o of this.s.items.filter(x => x.status === 'new' && x.call_ref && x.call_ref.toUpperCase() === ref.toUpperCase())) {
      Object.assign(o, { status: 'merged', job_id: job.id, handled_by: by, handled_at: new Date().toISOString(), note: 'Same call log number' }); merged++;
    }
    this.s.fromQueue.push({ jobId: job.id, storeId: job.store_id, at: new Date().toISOString() });
    if (this.s.settings.post_logged) this.post('logged', groupLine({ kind: 'logged', jobNumber: job.job_number, store: job.store, callRef: ref, tech: job.lead }));
    return good({ jobId: job.id, jobNumber: job.job_number, merged });
  }

  check(id: string): Res | null {
    const b = this.s.items.find(x => x.id === id);
    if (!b) return bad(404, 'no such breakdown');
    if (b.status !== 'new') return bad(409, 'this one was already handled');
    return null;
  }

  merge(id: string, jobId: string, by: string): Res {
    const c = this.check(id); if (c) return c;
    const j = this.src.jobs().find(x => x.id === jobId);
    if (!j) return bad(404, 'no such job');
    const b = this.s.items.find(x => x.id === id)!;
    Object.assign(b, { status: 'merged', job_id: jobId, handled_by: by, handled_at: new Date().toISOString() });
    if (this.s.settings.post_logged) this.post('merged', groupLine({ kind: 'merged', jobNumber: j.job_number, store: j.store, callRef: b.call_ref }));
    return good({ id, jobId, jobNumber: j.job_number });
  }

  ignore(id: string, by: string, note?: string, always?: boolean): Res {
    const c = this.check(id); if (c) return c;
    const b = this.s.items.find(x => x.id === id)!;
    if (b.kind === 'breakdown' && (!note || note.trim().length < 3)) return bad(400, 'it reads like a breakdown: say why it is not a job (e.g. "already fixed", "not our client")');
    Object.assign(b, { status: 'ignored', handled_by: by, handled_at: new Date().toISOString(), note: note?.trim() || null });
    if (always && b.sender && !this.s.settings.ignore_senders.includes(b.sender)) this.s.settings.ignore_senders.push(b.sender.toLowerCase());
    return good({ id, status: 'ignored' });
  }

  reopen(id: string): Res {
    const b = this.s.items.find(x => x.id === id);
    if (!b || b.status !== 'ignored') return bad(409, 'only a message marked "not a job" goes back in the queue');
    Object.assign(b, { status: 'new', handled_by: null, handled_at: null, note: null });
    return good({ id, status: 'new' });
  }

  /** A message from a WhatsApp chat (not the group) made into a breakdown in the WhatsApp tab. */
  fromChat(body: string, senderName: string | null, sender: string | null, at: string): string {
    const stores = this.src.stores();
    const r = readByRules('', body, stores);
    const id = `bd-${++this.s.seq}`;
    this.s.items.push({ id, channel: 'whatsapp', received_at: at, sender_name: senderName, sender, subject: null, body, photo_ids: [], attachments: [], kind: r.kind === 'other' ? 'breakdown' : r.kind,
      read_by: 'rules', store_id: r.storeId, store_text: r.storeText, fault: r.fault ?? body.slice(0, 120), call_ref: r.callRef, urgent: r.urgent, status: 'new', job_id: null, handled_by: null, handled_at: null, note: null });
    return id;
  }

  /** The test drive's "a breakdown comes in" buttons. */
  simulate(channel: 'email' | 'whatsapp'): Res {
    const stores = this.src.stores();
    const n = ++this.s.seq;
    const store = stores[n % stores.length];
    const p = PRETEND[n % PRETEND.length];
    const ref = p.ref(n);
    const email = channel === 'email';
    const sender = email ? (ref ? 'calls@callcentre.demo' : 'manager@store.demo') : '27725550100';
    const subject = email ? (ref ? `Call logged: Ref ${ref}` : 'Urgent: breakdown') : null;
    const body = email
      ? (ref ? `Good day\n\nPlease attend to the following call.\nStore: ${store.name}\nFault: ${p.fault}\nCall ref: ${ref}\n\nCall Centre` : `Hi\n\n${store.name}: ${p.fault}. Please send someone.\n\nThanks`)
      : `${store.name}: ${p.fault}${ref ? `. Log no ${ref}` : ''}`;
    if (email && this.s.settings.ignore_senders.includes(sender)) return bad(409, 'that sender is on the "always leave out" list (Settings → Breakdowns)');
    const r = readByRules(subject ?? '', body, stores);
    const b: DemoBd = { id: `bd-${n}`, channel, received_at: new Date().toISOString(), sender_name: email ? (ref ? 'Call Centre' : 'Store manager') : 'Front desk', sender,
      subject, body, photo_ids: [], attachments: [], kind: r.kind, read_by: 'rules', store_id: r.storeId, store_text: r.storeText,
      fault: r.fault, call_ref: r.callRef, urgent: r.urgent, status: 'new', job_id: null, handled_by: null, handled_at: null, note: null };
    this.s.items.push(b);
    if (channel === 'email' && b.kind === 'breakdown' && this.s.settings.post_new) this.post('new', groupLine({ kind: 'new', via: 'email', store: store.name, fault: b.fault, callRef: b.call_ref, urgent: b.urgent }));
    if (this.s.inboxes[0]) this.s.inboxes[0].last_checked_at = new Date().toISOString();
    return good({ id: b.id });
  }

  settings(companyId: string) {
    return { settings: this.s.settings, inboxes: this.s.inboxes, whatsapp: { ...this.s.whatsapp, qr_svg: null, running: true }, posts: this.s.posts.slice(0, 20), ai: false, companyId };
  }
  saveSettings(b: { postNew?: boolean; postLogged?: boolean; postOnSite?: boolean; postDone?: boolean; escalateAfterMin?: number; ignoreSenders?: string[] }): Res {
    const m = Number(b.escalateAfterMin);
    if (!(m >= 5 && m <= 240)) return bad(400, 'between 5 and 240 minutes');
    this.s.settings = { post_new: !!b.postNew, post_logged: !!b.postLogged, post_on_site: !!b.postOnSite, post_done: !!b.postDone, escalate_after_min: m, ignore_senders: [...new Set((b.ignoreSenders ?? []).map(x => x.toLowerCase()))] };
    return good(this.s.settings);
  }
  addInbox(address: string, appPassword: string): Res {
    const a = (address ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) return bad(400, 'a Gmail address');
    const p = (appPassword ?? '').replace(/\s+/g, '');
    if (this.s.inboxes.some(i => i.active && i.address === a)) return bad(409, `${a} is already connected`);
    if (!/^[a-z]{16}$/i.test(p)) return bad(400, `could not sign in to ${a}: Gmail refused the email address or app password`, 'Use an app password: Google account → Security → 2-Step Verification → App passwords. (Test drive: any 16 letters work.)');
    this.s.inboxes.push({ id: `inbox-${Date.now()}`, address: a, active: true, last_checked_at: null, last_error: null });
    return good({ address: a });
  }
  removeInbox(id: string): Res {
    const i = this.s.inboxes.find(x => x.id === id);
    if (!i) return bad(404, 'no such inbox');
    i.active = false;
    return good({ id, active: false });
  }
  chooseGroup(jid: string): Res {
    const g = this.s.whatsapp.groups.find(x => x.jid === jid);
    if (!g) return bad(400, 'the app\'s number is not in that group');
    this.s.whatsapp.group_jid = g.jid; this.s.whatsapp.group_name = g.name;
    return good({ groupJid: g.jid, groupName: g.name });
  }
  /** The purchase orders group (POs made in Pastel, read and added by themselves); null: none. */
  choosePOGroup(jid: string | null): Res {
    if (!jid) { this.s.whatsapp.po_group_jid = null; this.s.whatsapp.po_group_name = null; return good({ poGroupJid: null }); }
    const g = this.s.whatsapp.groups.find(x => x.jid === jid);
    if (!g) return bad(400, 'the app\'s number is not in that group');
    if (g.jid === this.s.whatsapp.group_jid) return bad(409, 'that is the breakdowns group: choose a group for purchase orders only');
    this.s.whatsapp.po_group_jid = g.jid; this.s.whatsapp.po_group_name = g.name;
    return good({ poGroupJid: g.jid, poGroupName: g.name });
  }
  /** A job from the queue: the technician on site or the job done, posted when switched on. */
  jobUpdate(jobId: string, kind: 'on_site' | 'done') {
    if (kind === 'on_site' ? !this.s.settings.post_on_site : !this.s.settings.post_done) return;
    if (!this.s.items.some(b => b.job_id === jobId)) return;
    const j = this.src.jobs().find(x => x.id === jobId);
    if (j) this.post(kind, groupLine({ kind, jobNumber: j.job_number, store: j.store, tech: j.lead }));
  }
}
