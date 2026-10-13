// Pinning stores on the map in the background: every store waiting for a pin is looked up (its
// address, else its name in its town). A pin on the building itself is used as it is; one that only
// found the street, the suburb or the town is marked "check the pin" for the office.
import type { Db, Q } from './db.ts';
import { eachCompany } from './intake.ts';
import { lookupsFor, type Geocoder } from './geocoder.ts';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Looks up to `max` waiting stores per company. Returns how many got a pin. */
export async function locateStores(db: Db, geocoder: Geocoder, opts: { max?: number } = {}): Promise<number> {
  let pinned = 0;
  await eachCompany(db, async c => {
    const stores = (await c.query(
      `SELECT s.id, s.name, s.address, cl.name AS client, s.lookup_tries FROM stores s JOIN clients cl ON cl.id = s.client_id
        WHERE s.pin_status = 'looking' ORDER BY s.lookup_tries, s.name LIMIT $1`, [opts.max ?? 25])).rows;
    for (const s of stores) if (await locateOne(c, geocoder, s)) pinned++;
  });
  return pinned;
}

async function locateOne(c: Q, geocoder: Geocoder, s: { id: string; name: string; address: string | null; client: string; lookup_tries: number }): Promise<boolean> {
  for (const l of lookupsFor(s)) {
    if (geocoder.minGapMs) await pause(geocoder.minGapMs);
    let hit;
    try { hit = await geocoder(l.q); } catch (e) {
      // The map service is not reachable: try again on the next round (three rounds, then the office pins it).
      await c.query(`UPDATE stores SET lookup_tries = lookup_tries + 1, pin_note = $2,
                       pin_status = CASE WHEN lookup_tries + 1 >= 3 THEN 'not_found' ELSE pin_status END WHERE id = $1`,
        [s.id, `Map lookup failed: ${(e as Error).message}`.slice(0, 300)]);
      return false;
    }
    if (!hit) continue;
    const sure = hit.precision === 'exact' && !l.townOnly && !l.byName;
    const how = l.townOnly ? 'only the town or suburb was found' : l.byName ? 'found by the store\'s name, not its address' : hit.precision === 'street' ? 'only the street was found' : hit.precision === 'area' ? 'only the suburb or town was found' : '';
    await c.query(
      `UPDATE stores SET lat = $2, lng = $3, pin_source = 'lookup', pin_status = $4, pin_note = $5, pin_at = now(), lookup_tries = lookup_tries + 1 WHERE id = $1`,
      [s.id, hit.lat, hit.lng, sure ? 'ok' : 'check', `${geocoder.name ?? 'Map'}: ${hit.label}${how ? ` (${how}: check the pin)` : ''}`.slice(0, 500)]);
    return true;
  }
  await c.query(`UPDATE stores SET pin_status = 'not_found', lookup_tries = lookup_tries + 1, pin_at = now(),
                   pin_note = $2 WHERE id = $1`, [s.id, s.address ? 'Not found on the map: check the address, or pin it by hand' : 'No address: add the address, or pin it by hand']);
  return false;
}
