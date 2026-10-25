// Finding a store's address on the map. With GOOGLE_MAPS_KEY set, Google's geocoding (best for South
// African shop addresses; paid per lookup after Google's free allowance). Without it, OpenStreetMap's
// free lookup (Nominatim: one lookup a second, which the background job keeps to). GEOCODER=off turns
// it off: then the office pins stores by hand.
import type { PinPrecision } from './core/customerSheet.ts';

export interface GeoHit { lat: number; lng: number; precision: PinPrecision; label: string }
export type Geocoder = ((query: string) => Promise<GeoHit | null>) & { minGapMs?: number; source?: string };

const inSA = (lat: number, lng: number) => lat >= -35 && lat <= -22 && lng >= 16 && lng <= 33;

export function googleGeocoder(key: string): Geocoder {
  const g: Geocoder = async q => {
    const u = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=za&components=country:ZA&key=${encodeURIComponent(key)}`;
    const res = await fetch(u, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`map lookup failed (${res.status})`);
    const b = await res.json() as { status: string; error_message?: string; results: { formatted_address: string; types: string[]; geometry: { location: { lat: number; lng: number }; location_type: string } }[] };
    if (b.status === 'ZERO_RESULTS') return null;
    if (b.status !== 'OK') throw new Error(`map lookup: ${b.status}${b.error_message ? ` (${b.error_message})` : ''}`);
    const r = b.results[0];
    const { lat, lng } = r.geometry.location;
    if (!inSA(lat, lng)) return null;
    const exact = ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(r.geometry.location_type) || r.types.some(t => ['establishment', 'premise', 'subpremise', 'street_address', 'shopping_mall', 'point_of_interest'].includes(t));
    const street = r.types.includes('route');
    return { lat, lng, precision: exact ? 'exact' : street ? 'street' : 'area', label: r.formatted_address };
  };
  g.minGapMs = 100; g.source = 'Google Maps';
  return g;
}

export function nominatimGeocoder(contact = process.env.NOMINATIM_EMAIL ?? ''): Geocoder {
  const g: Geocoder = async q => {
    const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=za&limit=1&q=${encodeURIComponent(q)}${contact ? `&email=${encodeURIComponent(contact)}` : ''}`;
    const res = await fetch(u, { headers: { 'user-agent': 'RealSandbox-jobcards/1.0 (store map pins)', 'accept-language': 'en' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`map lookup failed (${res.status})`);
    const b = await res.json() as { lat: string; lon: string; display_name: string; addresstype?: string; category?: string; type?: string }[];
    const r = b[0];
    if (!r) return null;
    const lat = Number(r.lat), lng = Number(r.lon);
    if (!inSA(lat, lng)) return null;
    const kind = r.addresstype ?? r.type ?? '';
    const exact = ['house', 'building', 'shop', 'amenity', 'retail', 'commercial', 'office', 'industrial', 'craft', 'tourism', 'leisure'].includes(kind) || ['shop', 'amenity', 'building', 'office'].includes(r.category ?? '');
    const street = ['road', 'street', 'residential', 'primary', 'secondary', 'tertiary', 'trunk'].includes(kind);
    return { lat, lng, precision: exact ? 'exact' : street ? 'street' : 'area', label: r.display_name };
  };
  g.minGapMs = 1100; g.source = 'OpenStreetMap';
  return g;
}

export function geocoderFromEnv(): Geocoder | null {
  if ((process.env.GEOCODER ?? '').toLowerCase() === 'off') return null;
  return process.env.GOOGLE_MAPS_KEY ? googleGeocoder(process.env.GOOGLE_MAPS_KEY) : nominatimGeocoder();
}

/** What to look up for a store, best first: the full address, then the store's name in its town, then the town alone. */
export function lookupsFor(s: { client: string; name: string; address: string | null }): { q: string; byName: boolean; townOnly: boolean }[] {
  const out: { q: string; byName: boolean; townOnly: boolean }[] = [];
  const addr = s.address?.replace(/\s+/g, ' ').trim();
  if (addr) out.push({ q: `${addr}, South Africa`, byName: false, townOnly: false });
  const parts = addr ? addr.split(/\s*,\s*/).filter(Boolean) : [];
  const town = parts.length ? parts.slice(-2).join(', ') : '';
  const name = s.name.toLowerCase().includes(s.client.toLowerCase()) ? s.name : `${s.client} ${s.name}`;
  out.push({ q: `${name}${town ? `, ${town}` : ''}, South Africa`, byName: true, townOnly: false });
  if (parts.length >= 2) out.push({ q: `${parts.slice(1).join(', ')}, South Africa`, byName: false, townOnly: true });
  return out;
}
