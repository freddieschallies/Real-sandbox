// Customer lists from any company: CSV and Excel, the columns guessed, rows into customers and sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessMapping, joinAddress, parseCsv, splitHeader, toCustomers } from '../src/core/customerSheet.ts';
import { readSheet } from '../src/sheet.ts';
import { lookupsFor } from '../src/geocoder.ts';
import { arrive, type JobCard } from '../src/core/jobCard.ts';
import { xlsx } from './xlsx.ts';

test('CSV: quotes, semicolons, a title line above the headings', () => {
  const rows = parseCsv('﻿Customer list (exported)\n"Customer";"Site";"Physical Address";"Suburb";"Town"\n"Pick n Pay";"PnP ""Boardwalk""";"Boardwalk Mall, 1 Bullion Blvd";"Central";"Richards Bay"\n');
  const { headers, body } = splitHeader(rows);
  assert.deepEqual(headers, ['Customer', 'Site', 'Physical Address', 'Suburb', 'Town']);
  assert.equal(body[0][1], 'PnP "Boardwalk"');
  const m = guessMapping(headers);
  assert.deepEqual(m, { store: 1, client: 0, address: 2, suburb: 3, city: 4 });
  const { rows: out } = toCustomers(body, m);
  assert.equal(out[0].address, 'Boardwalk Mall, 1 Bullion Blvd, Central, Richards Bay');
  assert.equal(joinAddress(['Alton', 'Richards Bay', 'richards bay']), 'Alton, Richards Bay');
});

test('Excel: the first sheet, text and numbers; a pin in the file counts only inside South Africa', () => {
  const buf = xlsx([['Code', 'Customer Name', 'Address Line 1', 'City', 'Latitude', 'Longitude', 'E-mail'],
    ['C001', 'Spar Group', '12 Demo Road', 'Empangeni', -28.7621, 31.8932, 'a@x.co.za; b@x.co.za'],
    ['C002', 'Corner Cafe', '', 'Richards Bay', 0, 0, ''],
    ['C003', '', 'nobody', '', '', '', '']]);
  const rows = readSheet(buf);
  assert.equal(rows.length, 4);
  const { headers, body } = splitHeader(rows);
  const m = guessMapping(headers);
  assert.equal(m.client, 1); assert.equal(m.accountCode, 0); assert.equal(m.lat, 4); assert.equal(m.lng, 5); assert.equal(m.email, 6);
  const { rows: out, skipped } = toCustomers(body, m);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].lat, out[0].lng, out[0].email, out[0].store], [-28.7621, 31.8932, 'a@x.co.za', 'Spar Group'], 'one site per customer when there is no site column');
  assert.equal(out[1].lat, null, '0,0 is not a pin');
  assert.deepEqual(skipped, [{ line: 4, reason: 'no customer name' }]);
  assert.throws(() => readSheet(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), /save it as \.xlsx or CSV/);
});

test('what is looked up for a store, and Arrived at a store with no pin', () => {
  assert.deepEqual(lookupsFor({ client: 'Spar', name: 'Spar Arboretum', address: 'Arboretum Centre, Richards Bay' }).map(l => l.q),
    ['Arboretum Centre, Richards Bay, South Africa', 'Spar Arboretum, Arboretum Centre, Richards Bay, South Africa', 'Richards Bay, South Africa']);
  const card = { jobType: 'breakdown', status: 'in_progress', store: { lat: null as unknown as number, lng: null as unknown as number, geofenceM: 150 }, items: [], visits: [{ state: 'on_the_way', goAt: '2026-10-13T08:00:00+02:00', pauses: [] }] } as unknown as JobCard;
  const r = arrive(card, { at: '2026-10-13T08:30:00+02:00', vehiclePosition: { lat: -28.75, lng: 32.05 }, managerName: 'Jane', safety: { areaSafe: true, isolated: true, publicClear: true } });
  assert.ok(r.ok, 'no pin: Arrived counts without a reason');
  assert.deepEqual(r.ok && r.flags, ['store_not_pinned']);
});
