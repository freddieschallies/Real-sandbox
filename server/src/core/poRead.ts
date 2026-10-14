// Reading a purchase order posted in the WhatsApp group without the AI reader: the PO number, the
// job number, the supplier and "2 x Water inlet valve" lines from the message text.
export interface ReadPO {
  poNumber: string | null; supplierName: string | null; jobNumber: number | null; technicianName: string | null;
  lines: { description: string; code: string | null; qty: number; unitPriceCents: number | null }[];
}

export function readPOByRules(text: string): ReadPO {
  const t = text.replace(/\r/g, '');
  const po = t.match(/\b(?:P\.?\s?O\.?|purchase\s+order)\s*(?:no\.?|number|nr\.?|#)?\s*[:#-]?\s*([A-Z]{0,4}\d[\w/-]{1,20})/i)?.[1] ?? null;
  const job = t.match(/\bjob\s*(?:card)?\s*(?:no\.?|number|nr\.?|#)?\s*[:#-]?\s*(\d{4,7})\b/i)?.[1];
  const sup = t.match(/^\s*(?:supplier|from|to)\s*[:-]\s*(.+)$/im)?.[1]?.trim()
    ?? t.match(/\b(?:P\.?\s?O\.?|purchase\s+order)\s*(?:no\.?|number|#)?\s*[:#-]?\s*[A-Z]{0,4}\d[\w/-]{1,20}\s*[,-]?\s*(?:for\s+)?([A-Z][\w&'. ]{2,60}?)(?=\s+for\s+job|\s*[,\n]|$)/i)?.[1]?.trim() ?? null;
  const tech = t.match(/^\s*(?:tech(?:nician)?|for)\s*[:-]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*$/im)?.[1] ?? null;
  const lines: ReadPO['lines'] = [];
  for (const m of t.matchAll(/^\s*(\d+(?:[.,]\d+)?)\s*(?:x|×|\*)\s*(.+?)\s*(?:@\s*R?\s*([\d\s]+(?:[.,]\d{2})?))?\s*$/gim)) {
    const qty = Number(m[1].replace(',', '.'));
    const price = m[3] ? Math.round(Number(m[3].replace(/\s/g, '').replace(',', '.')) * 100) : null;
    if (qty > 0 && m[2].trim().length >= 2) lines.push({ description: m[2].trim(), code: null, qty, unitPriceCents: price });
  }
  return { poNumber: po, supplierName: sup, jobNumber: job ? Number(job) : null, technicianName: tech, lines };
}
