// Search from anyone's front page: the screens and tabs they can open (by name, and by the words people
// use for them: "prices" finds the rates, "hours" the timesheets), and what they may see: job cards,
// stores, customers, stock with its price, quotes, invoices, purchase orders, supplier invoices, people,
// vehicles. Pure helpers, the same on the server, in the app and in the test drive.

export const SEARCH_KINDS = ['job', 'store', 'client', 'stock', 'quote', 'invoice', 'po', 'supplier_invoice', 'person', 'vehicle'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export const KIND_LABEL: Record<SearchKind, string> = {
  job: 'Job cards', store: 'Stores', client: 'Customers', stock: 'Stock and prices', quote: 'Quotes', invoice: 'Invoices',
  po: 'Purchase orders', supplier_invoice: 'Supplier invoices', person: 'People', vehicle: 'Vehicles',
};
export type Tone = 'info' | 'good' | 'warn' | 'bad' | 'quiet';
export interface SearchHit { kind: SearchKind; id: string; title: string; sub: string; badge?: { text: string; tone: Tone } | null; price?: string | null }
export interface SearchResult { q: string; groups: { kind: SearchKind; label: string; hits: SearchHit[] }[] }

export const MIN_CHARS = 2;
export const PER_KIND = 6;

/** The words of a search, lower case (at most 6). */
export function wordsOf(q: string): string[] {
  return q.toLowerCase().replace(/[^\p{L}\p{N}@.\-/ ]+/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
}
/** For SQL: each word as an ILIKE pattern (% and _ taken literally). */
export const likePatterns = (q: string) => wordsOf(q).map(w => `%${w.replace(/[\\%_]/g, m => `\\${m}`)}%`);
/** Whether every word is somewhere in the text. */
export const hasAll = (text: string, q: string) => { const t = text.toLowerCase(); const w = wordsOf(q); return w.length > 0 && w.every(x => t.includes(x)); };

/** The other words people use for each screen or tab. */
export const PLACE_WORDS: Record<string, string> = {
  help: 'help how to guide guides tutorial instructions steps learn',
  setup: 'start-up startup start up setup set up new company checklist employees logins roles',
  today: 'home dashboard overview summary',
  breakdowns: 'call outs callouts emails whatsapp group intake new calls',
  jobs: 'job cards jobcards work orders open jobs',
  queries: 'questions messages ask chat',
  quotes: 'quotation estimates estimate prices',
  invoices: 'invoice billing bill money in credit notes paid',
  supplier: 'supplier invoices slips till slips money out bills',
  pos: 'purchase orders po orders stock run',
  customers: 'clients customer statements statement accounts',
  debtors: 'owing owed age analysis 30 60 90 120 days on hold overdue statement',
  profit: 'margin money made cost profit per job',
  accounts: 'pastel rates prices price list labour rate call-out mark-up markup company details codes customer codes line codes batches who did what',
  flags: 'alerts warnings problems',
  map: 'team map live tracking where gps location',
  vans: 'van stock vans bill of quantities',
  departments: 'teams department managers',
  timesheets: 'timesheet hours overtime time office time pay performance',
  people: 'staff employees logins passwords users positions',
  repairs: 'workshop repairs machines uplifted',
  stores: 'sites branches shops addresses pins import customers',
  barcodes: 'qr codes print codes labels',
  settings: 'letterhead logo theme colours password gmail whatsapp menus storage',
  // The technician's phone
  timesheet: 'hours office time meeting overtime',
  stock: 'my stock van stock parts on my name',
  fuel: 'fuel diesel petrol slip',
  kit: 'tools ppe kit',
  scan: 'vehicle scan qr bakkie',
  fault: 'vehicle fault report',
  techquotes: 'quotes quote estimate',
  // The stockroom
  issue: 'to issue requests book out',
  receive: 'returns to receive',
  room: 'stock stockroom levels prices items parts',
  order: 'to order reorder low stock minimum purchase order po supplier buy',
  count: 'stock take stocktake count counting stock count',
  suppliers: 'suppliers supplier contacts email phone',
  tools: 'tool store ladders',
  live: 'activity what happened',
  items: 'new items name items',
  // The fleet
  vehicles: 'vehicles fleet bakkies cars trucks handover handovers approve driver driving fuel trips unauthorised licence disc km odometer',
  bookings: 'booked services service due',
  faults: 'vehicle faults defects',
  techs: 'drivers technicians assign vehicle',
  codes: 'qr codes',
};

export interface Place { key: string; label: string }
/** The places that match, best first (the name starting with the search, then the name, then other words). */
export function matchPlaces<T extends Place>(places: T[], q: string): T[] {
  const w = wordsOf(q);
  if (!w.length) return [];
  const score = (p: T) => {
    const name = p.label.toLowerCase();
    if (name.startsWith(w.join(' '))) return 3;
    if (w.every(x => name.includes(x))) return 2;
    return hasAll(`${name} ${PLACE_WORDS[p.key] ?? ''}`, q) ? 1 : 0;
  };
  return places.map(p => ({ p, s: score(p) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.p);
}
