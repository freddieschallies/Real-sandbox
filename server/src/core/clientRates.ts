// Each client's own rates and mark-up, set by the CEO and Accounts with the client's Pastel code.
// Rates: labour per hour, call-out, travel per km and travel time per hour, each of which can be
// switched off for a client (not charged at all). Parts: a mark-up on what the part cost, in three
// price bands; the cheaper the part, the bigger the mark-up. A client without its own uses the
// company's rates (Accounts → Company and rates). Pure functions, the same on the server and in the app.

export const CLIENT_RATE_KEYS = ['labour_per_hour', 'call_out', 'travel_per_km', 'travel_per_hour'] as const;
export type ClientRateKey = (typeof CLIENT_RATE_KEYS)[number];
export const CLIENT_RATE_LABEL: Record<ClientRateKey, string> = {
  labour_per_hour: 'Labour per hour', call_out: 'Call-out fee', travel_per_km: 'Travel per km', travel_per_hour: 'Travel time per hour',
};

export interface RateSetting { on: boolean; cents: number }
/** A price band: parts costing up to `upToCents` each (the last band: anything more) get `pct` mark-up. */
export interface MarkupBand { upToCents: number | null; pct: number }
export interface Markup { on: boolean; bands: MarkupBand[] }
export interface ClientRates { rates: Record<ClientRateKey, RateSetting>; markup: Markup }

/** A starting point for a new client's bands (the CEO and Accounts change them). */
export const DEFAULT_BANDS: MarkupBand[] = [{ upToCents: 50_000, pct: 60 }, { upToCents: 200_000, pct: 40 }, { upToCents: null, pct: 25 }];

/** The client's rates to start from: the company's, all switched on. */
export function startingRates(company: Record<string, number>): ClientRates {
  return {
    rates: Object.fromEntries(CLIENT_RATE_KEYS.map(k => [k, { on: true, cents: company[k] ?? 0 }])) as Record<ClientRateKey, RateSetting>,
    markup: { on: true, bands: DEFAULT_BANDS.map(b => ({ ...b })) },
  };
}

/** What is wrong with a client's rates before they are saved. */
export function ratesProblems(r: ClientRates): string[] {
  const out: string[] = [];
  for (const k of CLIENT_RATE_KEYS) {
    const x = r.rates[k];
    if (!x) { out.push(`${CLIENT_RATE_LABEL[k]}: missing`); continue; }
    if (x.on && !(x.cents > 0)) out.push(`${CLIENT_RATE_LABEL[k]}: a rate, or untick it`);
  }
  const b = r.markup.bands;
  if (b.length !== 3) out.push('three mark-up bands');
  else {
    if (!(b[0].upToCents && b[0].upToCents > 0)) out.push('mark-up: where the first band ends');
    if (!(b[1].upToCents && b[0].upToCents && b[1].upToCents > b[0].upToCents)) out.push('mark-up: the second band must end above the first');
    if (b[2].upToCents !== null) out.push('mark-up: the last band is for anything more');
    b.forEach((x, i) => { if (!(x.pct >= 0 && x.pct <= 1000)) out.push(`mark-up band ${i + 1}: a percentage from 0 to 1000`); });
  }
  return out;
}

/** The band a part falls in, by what one costs. */
export function bandOf(costCents: number, bands: MarkupBand[]): number {
  const i = bands.findIndex(b => b.upToCents === null || costCents <= b.upToCents);
  return i < 0 ? bands.length - 1 : i;
}

/** The selling price of one part that cost `costCents`. */
export function markedUp(costCents: number, m: Markup): number {
  return Math.round(costCents * (1 + m.bands[bandOf(costCents, m.bands)].pct / 100));
}

/** The pricing for one invoice: null = not charged to this client. */
export interface PriceRules {
  source: 'client' | 'company';
  labour: number | null; callOut: number | null; travelKm: number | null; travelHour: number | null;
  /** The client's banded mark-up on parts, or null: stock at its selling price, bought-out items at the company mark-up. */
  markup: Markup | null;
  boughtOutPct: number;
}

export function priceRules(company: Record<string, number>, client: ClientRates | null): PriceRules {
  const boughtOutPct = company.bought_out_markup_pct ?? 0;
  if (!client) {
    return {
      source: 'company', labour: company.labour_per_hour ?? 0, callOut: company.call_out ?? 0,
      // Travel only once the company has a travel rate.
      travelKm: company.travel_per_km ? company.travel_per_km : null, travelHour: company.travel_per_hour ? company.travel_per_hour : null,
      markup: null, boughtOutPct,
    };
  }
  const r = (k: ClientRateKey) => (client.rates[k]?.on ? client.rates[k].cents : null);
  return { source: 'client', labour: r('labour_per_hour'), callOut: r('call_out'), travelKm: r('travel_per_km'), travelHour: r('travel_per_hour'), markup: client.markup.on ? client.markup : null, boughtOutPct };
}

/** Straight-line km between two points (for estimating travel before the tracker gives real trips). */
export function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Roads are longer than a straight line: about a quarter more. */
export const ROAD_FACTOR = 1.25;
