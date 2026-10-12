// Reads a photographed supplier invoice into lines. Uses Claude (vision) when ANTHROPIC_API_KEY is set;
// without it, invoices still work: the technician types the lines from the photo.
// The technician always checks what was read before it counts, and any change he makes is recorded.

export interface ReadInvoice {
  supplierName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;      // YYYY-MM-DD
  totalCents: number | null;       // amount payable, VAT included
  vatCents: number | null;
  lines: { description: string; supplierCode: string | null; qty: number; unitPriceCents: number | null }[];
}

export type InvoiceReader = (image: Buffer, mime: string) => Promise<ReadInvoice>;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['readable', 'supplierName', 'invoiceNumber', 'invoiceDate', 'totalCents', 'vatCents', 'lines'],
  properties: {
    readable: { type: 'boolean', description: 'false if this is not a supplier invoice or slip, or too blurry to read' },
    supplierName: { type: ['string', 'null'] },
    invoiceNumber: { type: ['string', 'null'] },
    invoiceDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    totalCents: { type: ['integer', 'null'], description: 'total payable including VAT, in cents' },
    vatCents: { type: ['integer', 'null'] },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'supplierCode', 'qty', 'unitPriceCents'],
        properties: {
          description: { type: 'string' },
          supplierCode: { type: ['string', 'null'], description: "the supplier's item or part code, if printed" },
          qty: { type: 'number' },
          unitPriceCents: { type: ['integer', 'null'], description: 'unit price excluding VAT, in cents' },
        },
      },
    },
  },
};

const PROMPT = `This is a photo of a South African supplier's tax invoice or till slip for parts bought by a maintenance technician.
Read it exactly as printed. Amounts are in rand; give them in cents (R 1 234,50 = 123450).
One entry per printed line item. Do not invent lines or codes; use null when something isn't printed or can't be read.
Leave out delivery notes, payment lines, change and rounding. If it is not an invoice or slip, set readable to false.`;

export function claudeInvoiceReader(apiKey: string, model = process.env.INVOICE_MODEL ?? 'claude-sonnet-5-5'): InvoiceReader {
  return async (image, mime) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: image.toString('base64') } },
            { type: 'text', text: PROMPT },
          ],
        }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`invoice reading failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const body = await res.json() as { stop_reason: string; content: { type: string; text?: string }[] };
    if (body.stop_reason !== 'end_turn') throw new Error(`invoice reading stopped early (${body.stop_reason})`);
    const text = body.content.find(b => b.type === 'text')?.text ?? '';
    const out = JSON.parse(text) as ReadInvoice & { readable: boolean };
    if (!out.readable) throw new Error('not a readable invoice');
    return {
      supplierName: out.supplierName, invoiceNumber: out.invoiceNumber, invoiceDate: out.invoiceDate,
      totalCents: out.totalCents, vatCents: out.vatCents,
      lines: out.lines.filter(l => l.description?.trim() && l.qty > 0),
    };
  };
}

/** The reader the server uses, or null when none is set up (lines are then typed by hand). */
export function readerFromEnv(): InvoiceReader | null {
  const key = process.env.ANTHROPIC_API_KEY;
  return key ? claudeInvoiceReader(key) : null;
}
