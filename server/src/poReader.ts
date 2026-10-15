// Reads a purchase order posted in the WhatsApp group: a photo or PDF of the PO (Claude, when
// ANTHROPIC_API_KEY is set) and the message text; without the AI reader, the text by rules.
import { readPOByRules, type ReadPO } from './core/poRead.ts';

/** posted: a PO posted in the WhatsApp group; request: a technician's photo of what he needs (a quote, a list, a part's label). */
export type POReader = (input: { text: string; files: { mime: string; data: Buffer }[]; purpose?: 'posted' | 'request' }) => Promise<ReadPO & { readBy: 'ai' | 'rules' }>;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['isPurchaseOrder', 'poNumber', 'supplierName', 'jobNumber', 'technicianName', 'lines'],
  properties: {
    isPurchaseOrder: { type: 'boolean' },
    poNumber: { type: ['string', 'null'] }, supplierName: { type: ['string', 'null'] },
    jobNumber: { type: ['integer', 'null'], description: 'our job card number, if the PO or message mentions one' },
    technicianName: { type: ['string', 'null'], description: 'the technician collecting, if named' },
    lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['description', 'code', 'qty', 'unitPriceCents'],
      properties: { description: { type: 'string' }, code: { type: ['string', 'null'] }, qty: { type: 'number' }, unitPriceCents: { type: ['integer', 'null'], description: 'excl. VAT, in cents' } } } },
  },
};

export function claudePOReader(apiKey: string, model = process.env.INVOICE_MODEL ?? 'claude-sonnet-5-5'): POReader {
  return async ({ text, files, purpose = 'posted' }) => {
    if (!files.length) return { ...readPOByRules(text), readBy: 'rules' };
    const content: object[] = files.slice(0, 3).map(f => f.mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data.toString('base64') } });
    content.push({ type: 'text', text: purpose === 'request'
      ? `A technician at a South African maintenance company (refrigeration, catering equipment, electrical, plumbing) took this photo to ask for a purchase order: it may be a supplier's quote, a handwritten or typed list, a part's label or rating plate, or the part itself. He wrote: "${text.slice(0, 1000)}". Read the supplier if it shows, and each part to buy with its quantity (1 when not shown), the part or catalogue code if printed, and the price excl. VAT in cents if printed. Set isPurchaseOrder to true. poNumber, jobNumber and technicianName are null unless printed.`
      : `A South African maintenance company's purchase order to a supplier, posted in a WhatsApp group. The message said: "${text.slice(0, 2000)}". Read the PO number, the supplier, our job card number (from the PO or the message), the technician if named, and every line exactly as printed. Amounts in cents. If it is not a purchase order, set isPurchaseOrder to false.` });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return { ...readPOByRules(text), readBy: 'rules' };
    const body = await res.json() as { content: { type: string; text?: string }[] };
    const out = JSON.parse(body.content.find(b => b.type === 'text')?.text ?? '{}') as ReadPO & { isPurchaseOrder: boolean };
    if (!out.isPurchaseOrder) return { ...readPOByRules(text), readBy: 'rules' };
    const rules = readPOByRules(text);
    return { poNumber: out.poNumber ?? rules.poNumber, supplierName: out.supplierName ?? rules.supplierName, jobNumber: out.jobNumber ?? rules.jobNumber,
      technicianName: out.technicianName ?? rules.technicianName, lines: out.lines?.length ? out.lines.filter(l => l.qty > 0) : rules.lines, readBy: 'ai' };
  };
}

export function poReaderFromEnv(): POReader {
  const key = process.env.ANTHROPIC_API_KEY;
  return key ? claudePOReader(key) : async ({ text }) => ({ ...readPOByRules(text), readBy: 'rules' });
}
