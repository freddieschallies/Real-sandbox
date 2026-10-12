export interface Point { lat: number; lng: number }

/** Distance in metres between two points (haversine). */
export function distanceM(a: Point, b: Point): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function insideGeofence(p: Point, centre: Point, radiusM: number): boolean {
  return distanceM(p, centre) <= radiusM;
}

/** Rough ~1 km grid cell used to group trip start points for learned trip times. */
export function originCell(p: Point): string {
  return `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
}
