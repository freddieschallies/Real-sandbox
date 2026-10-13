// What a breakdown message says: is it a breakdown, which store, what is wrong, the call centre's
// log number, is it urgent. These rules always work; when an AI reader is set up it reads the
// message instead and the rules are the fall-back. The office checks it either way before a job
// is logged.

export interface StoreRef { id: string; name: string; client: string; address?: string | null }
export interface BreakdownRead {
  kind: 'breakdown' | 'inquiry' | 'other';
  storeId: string | null; storeText: string | null; fault: string | null; callRef: string | null; urgent: boolean;
}

const BREAKDOWN = /\b(break\s?down|broken|not working|isn'?t working|not cooling|no cooling|not heating|not freezing|warm|leak(ing|s)?|tripp?(ing|ed|s)?|fault(y)?|faulty|error|alarm|no power|won'?t (start|switch on|turn on)|stopped|not making ice|blocked|burst|smok(e|ing)|noise|noisy|defrost|iced up|repair|call\s?out|callout|logged a call|call logged|please attend|attend to|send (a )?tech)/i;
const URGENT = /\b(urgent|asap|emergency|immediately|critical|priority 1|p1|stock (at risk|loss)|losing stock|food spoil|after hours)\b/i;
const OTHER = /\b(statement|remittance|proof of payment|payment|invoice attached|newsletter|unsubscribe|promotion|special offer|webinar|password reset|verify your|receipt for)\b/i;
const INQUIRY = /\b(quote|quotation|pricing|price list|how much|availability|enquiry|inquiry|service plan|maintenance plan)\b/i;

// The call centre's log number: "Log no: 784512", "Call ref 12-4455", "Ticket #INC0012345", "WO 55123".
const REF = /\b(?:call\s*(?:ref(?:erence)?|no\.?|number|nr\.?|log)|log(?:ged call)?|ref(?:erence)?|ticket|incident|case|work\s*order|wo|order|po)\s*(?:no\.?|number|nr\.?|#|ref\.?|id)?\s*[:#=\-]?\s*([A-Z]{0,6}[-/]?\d[A-Z0-9\-/]{2,19})\b/i;

/** Words in store names that say nothing about which branch it is. */
const GENERIC = new Set(['the', 'and', 'store', 'shop', 'branch', 'centre', 'center', 'mall', 'pty', 'ltd', 'cc', 'express', 'super', 'superspar', 'kwikspar', 'spar', 'pick', 'n', 'pay', 'boxer', 'shoprite', 'checkers', 'hyper', 'freshmart', 'deli', 'restaurant', 'hotel', 'rb', 'richards', 'bay']);
const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

/** The store the message is about: the store whose branch words appear in it (with the client's name as a tie-break). */
export function guessStore(text: string, stores: StoreRef[]): { store: StoreRef | null; text: string | null } {
  const t = ` ${words(text).join(' ')} `;
  let best: { s: StoreRef; score: number } | null = null;
  let tie = false;
  for (const s of stores) {
    // The words that say which branch it is (a client's name often holds the branch too, so those count).
    let own = [...new Set(words(s.name).filter(w => !GENERIC.has(w) && w.length >= 3))];
    if (!own.length) own = [...new Set(words(s.name).filter(w => w.length >= 3))];
    if (!own.length) continue;
    const hits = own.filter(w => t.includes(` ${w} `)).length;
    if (!hits) continue;
    const client = words(s.client).some(w => w.length >= 3 && t.includes(` ${w} `)) ? 0.5 : 0;
    // The store's whole name as written beats a store that only shares the suburb.
    const whole = t.includes(` ${words(s.name).join(' ')} `) ? 2 : 0;
    const score = hits / own.length + hits * 0.25 + client + whole;
    if (!best || score > best.score) { best = { s, score }; tie = false; } else if (score === best.score) tie = true;
  }
  if (!best || tie) {
    const m = text.match(/\b(?:store|branch|site|at)\s*[:\-]?\s*([A-Z][\w'&-]*(?:\s+[A-Z][\w'&-]*){0,4})/);
    return { store: null, text: m ? m[1].trim() : null };
  }
  return { store: best.s, text: null };
}

export function findCallRef(text: string): string | null {
  const m = text.match(REF);
  return m && (m[1].match(/\d/g) ?? []).length >= 4 ? m[1].toUpperCase().replace(/[-/]$/, '') : null;
}

/** The fault in one line: the first sentence that sounds like a fault, or the subject. */
export function findFault(subject: string, body: string): string | null {
  // A call centre's form says it outright: "Fault: ...", "Problem: ...".
  const labelled = body.match(/^\s*(?:fault|problem|issue|fault description|description|complaint|nature of (?:the )?(?:fault|call))\s*[:\-]\s*(.{4,300})$/im);
  if (labelled) return labelled[1].trim();
  const lines = `${body}`.split(/\n|(?<=[.!?])\s+/)
    .map(l => l.trim().replace(/^(?:please|kindly)\s+(?:attend|assist|send (?:a |someone|a tech\w*))(?:\s+to)?(?:\s+the following(?:\s+call)?)?\s*[:.\-]?\s*/i, ''))
    .filter(l => l.length >= 6 && l.length <= 300 && !/^(regards|thanks|thank you)\b/i.test(l));
  const hit = lines.find(l => BREAKDOWN.test(l) && !/^(dear|hi|hello|good (morning|day|afternoon))\b/i.test(l));
  const s = subject.replace(/^((re|fw|fwd)\s*:\s*)+/i, '').trim();
  return (hit ?? (BREAKDOWN.test(s) ? s : lines[0] ?? s) ?? null)?.slice(0, 300) || null;
}

export function readByRules(subject: string, body: string, stores: StoreRef[]): BreakdownRead {
  const all = `${subject}\n${body}`;
  const ref = findCallRef(all);
  const kind: BreakdownRead['kind'] = BREAKDOWN.test(all) || (ref && /\b(call|log)/i.test(all)) ? 'breakdown'
    : OTHER.test(all) ? 'other' : INQUIRY.test(all) ? 'inquiry' : 'other';
  const g = guessStore(all, stores);
  // "Spar Arboretum: cold room not cooling" → the fault without the store's name in front.
  let fault = kind === 'breakdown' ? findFault(subject, body) : null;
  if (fault && g.store && fault.toLowerCase().startsWith(g.store.name.toLowerCase())) fault = fault.slice(g.store.name.length).replace(/^\s*[:,\-–]\s*/, '') || fault;
  if (fault) fault = fault.charAt(0).toUpperCase() + fault.slice(1);
  return { kind, storeId: g.store?.id ?? null, storeText: g.store ? null : g.text, fault, callRef: ref, urgent: kind === 'breakdown' && URGENT.test(all) };
}

/** The line the app's WhatsApp number posts in the group. */
export function groupLine(p: { kind: 'new' | 'logged' | 'merged' | 'on_site' | 'done'; store?: string | null; fault?: string | null; callRef?: string | null; jobNumber?: number | null; tech?: string | null; urgent?: boolean; via?: 'email' | 'whatsapp' }): string {
  const ref = p.callRef ? ` · Call log ${p.callRef}` : '';
  const store = p.store ?? 'Store not known yet';
  switch (p.kind) {
    case 'new': return `${p.urgent ? '🔴 URGENT ' : '🆕 '}New breakdown${p.via === 'email' ? ' (email)' : ''}\n${store}\n${p.fault ?? ''}${ref}`.trim();
    case 'logged': return `✅ Job #${p.jobNumber} logged · ${store}${ref}${p.tech ? `\nTechnician: ${p.tech}` : ''}`;
    case 'merged': return `➕ Added to job #${p.jobNumber} · ${store}${ref}`;
    case 'on_site': return `📍 Job #${p.jobNumber} · ${p.tech ?? 'Technician'} is on site at ${store}`;
    case 'done': return `🏁 Job #${p.jobNumber} done · ${store}`;
  }
}
