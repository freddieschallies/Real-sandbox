// Reading a breakdown message with Claude (when ANTHROPIC_API_KEY is set): which of the company's
// stores, the fault in one line, the call log number, urgent or not, and whether it is a breakdown at
// all. Without a key, or if reading fails, the rules in core/breakdownRead.ts do it.
import { readByRules, type BreakdownRead, type StoreRef } from './core/breakdownRead.ts';

export type BreakdownReader = (m: { subject: string; body: string; sender: string | null; pdfs?: Buffer[] }, stores: StoreRef[]) => Promise<BreakdownRead & { readBy: 'ai' | 'rules' }>;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'storeNumber', 'storeText', 'fault', 'callRef', 'urgent'],
  properties: {
    kind: { type: 'string', enum: ['breakdown', 'inquiry', 'other'], description: 'breakdown: equipment at a store needs a technician. inquiry: a question or quote request. other: anything else (statements, payments, adverts, chit-chat, thank-yous).' },
    storeNumber: { type: ['integer', 'null'], description: 'the number of the store in the list, or null if not clearly one of them' },
    storeText: { type: ['string', 'null'], description: 'the store as written in the message, when it is not in the list' },
    fault: { type: ['string', 'null'], description: 'what is wrong, in one short line (equipment + problem), in English' },
    callRef: { type: ['string', 'null'], description: "the client's or call centre's log / call / reference / ticket number, exactly as written" },
    urgent: { type: 'boolean', description: 'true if they say urgent, stock at risk, store cannot trade, or similar' },
  },
};

export function claudeBreakdownReader(apiKey: string, model = process.env.BREAKDOWN_MODEL ?? 'claude-haiku-5-5'): BreakdownReader {
  return async (m, stores) => {
    const list = stores.slice(0, 600).map((s, i) => `${i + 1}. ${s.client} | ${s.name}${s.address ? ` | ${s.address}` : ''}`).join('\n');
    const prompt = `A refrigeration, catering-equipment, electrical and plumbing maintenance company in South Africa receives breakdown calls by email and WhatsApp (from clients' stores and from call centres that log calls).
Read the message below and fill in the fields. Use the store list; only give a storeNumber when the message clearly means that store. Do not invent a log number.

Stores:
${list}

From: ${m.sender ?? 'unknown'}
Subject: ${m.subject || '(none)'}
Message:
${m.body.slice(0, 6000)}`;
    try {
      const content: object[] = (m.pdfs ?? []).slice(0, 2).map(p => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.toString('base64') } }));
      content.push({ type: 'text', text: prompt });
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 600, messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`reading failed (${res.status})`);
      const body = await res.json() as { content: { type: string; text?: string }[] };
      const out = JSON.parse(body.content.find(b => b.type === 'text')?.text ?? '{}') as { kind: BreakdownRead['kind']; storeNumber: number | null; storeText: string | null; fault: string | null; callRef: string | null; urgent: boolean };
      const store = out.storeNumber ? stores[out.storeNumber - 1] : undefined;
      return { kind: out.kind, storeId: store?.id ?? null, storeText: store ? null : out.storeText, fault: out.fault, callRef: out.callRef?.trim() || null, urgent: !!out.urgent, readBy: 'ai' };
    } catch {
      return { ...readByRules(m.subject, m.body, stores), readBy: 'rules' };
    }
  };
}

export const rulesReader: BreakdownReader = async (m, stores) => ({ ...readByRules(m.subject, m.body, stores), readBy: 'rules' });

export function breakdownReaderFromEnv(): BreakdownReader {
  const key = process.env.ANTHROPIC_API_KEY;
  return key ? claudeBreakdownReader(key) : rulesReader;
}
