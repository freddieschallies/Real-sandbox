// Makes the list that puts a company's real staff, customers and details into the test drive, for a
// demo to that company. Reads the Servcraft import folder (company.json, customers.json, staff.json)
// and roles.json there (who stands in for each person in the demo). The list goes in at build time
// and is never kept in git:
//
//   EXPO_PUBLIC_TESTER=1 EXPO_PUBLIC_REAL_DEMO="$(node scripts/real-demo-seed.mjs --folder ../../servcraft-import)" npx expo export --platform web
//
// roles.json: { "ceo": "…", "admin": "…", "hr": "…", "manager": "…", "stockController": "…",
//               "mechanic": "…", "technician": "…", "technician2": "…", "assistant": "…",
//               "stores": { "<demo store id>": { "name": "…", "client": "…", "address": "<area>" } } }
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const folder = arg('--folder');
if (!folder) { console.error('usage: node scripts/real-demo-seed.mjs --folder <servcraft import folder>'); process.exit(1); }
const read = (f) => JSON.parse(readFileSync(join(folder, f), 'utf8'));
const company = read('company.json');
const customers = read('customers.json');
const staff = read('staff.json');
const roles = read('roles.json');

// The demo's made-up people (by demo id), and which role in roles.json stands in for each.
const DEMO = [
  ['office', 'Lilanie Schallies', 'ceo'], ['admin-1', 'Zanele Khoza', 'admin'], ['hr-1', 'Precious Ngcobo', 'hr'],
  ['mgr-1', 'Pieter van Wyk', 'manager'], ['stock', 'Lindiwe Zulu', 'stockController'], ['mech', 'Bongani Khumalo', 'mechanic'],
  ['me', 'Thabo Mkhize', 'technician'], ['tech-2', 'Sipho Ndlovu', 'technician2'], ['tech-4', 'Nomvula Dlamini', 'assistant'],
];
// The made-up technician who keeps the example warnings and flags.
const EXAMPLE = ['tech-3', 'Ayanda Mthembu', 'Example Tech'];
// The demo's made-up stores (by id). roles.json "stores" says which real store stands in for each:
// { "<id>": { "name": "<store>", "client": "<customer in customers.json>", "address": "<area>" } }.
const DEMO_STORES = { meerensee: 'FreshMart Meerensee', empangeni: 'FreshMart Empangeni', harbour: 'Harbour Deli, Alton', esikhawini: 'Boxer Esikhawini', arboretum: 'Spar Arboretum' };

const clean = (s) => (typeof s === 'string' && s.trim() && !/^[.\s]+$/.test(s) ? s.trim().replace(/\s+\.$/, '') : null);
const phone = (p) => {
  const d = String(p ?? '').replace(/\D/g, '');
  if (!d) return null;
  const local = d.startsWith('27') && d.length === 11 ? `0${d.slice(2)}` : d;
  return local.length === 10 ? `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}` : local;
};
const byName = new Map(staff.map((s) => [s.full_name.trim().toLowerCase(), s]));
const person = (name) => {
  const s = byName.get(String(name ?? '').trim().toLowerCase());
  if (!s) throw new Error(`roles.json: "${name}" is not in staff.json`);
  return { name: s.full_name.trim(), email: clean(s.email), phone: phone(s.phone) };
};
const first = (n) => n.split(' ')[0];

const people = {};
const swaps = [];
const used = new Set();
for (const [id, fake, role] of DEMO) {
  const p = person(roles[role]);
  people[id] = p;
  used.add(p.name.toLowerCase());
  swaps.push([fake, p.name], [first(fake), first(p.name)]);
}
people[EXAMPLE[0]] = { name: EXAMPLE[2], email: null, phone: null };
swaps.push([EXAMPLE[1], EXAMPLE[2]], [first(EXAMPLE[1]), EXAMPLE[2]]);
// The stores' own managers in the demo: no made-up names.
swaps.push(['Sipho Dube', 'Store manager'], ['Thandi Mthembu', 'Deli manager']);

const others = staff.filter((s) => !used.has(s.full_name.trim().toLowerCase()))
  .sort((a, b) => a.full_name.localeCompare(b.full_name))
  .map((s, i) => ({ id: `zsp-${String(i + 1).padStart(2, '0')}`, name: s.full_name.trim(), email: clean(s.email), phone: phone(s.phone) }));

const custNames = new Set(customers.map((c) => c.name.trim()));
const stores = {};
for (const [id, real] of Object.entries(roles.stores ?? {})) {
  const fake = DEMO_STORES[id];
  if (!fake || !real?.name) { console.error(`roles.json stores: no demo store "${id}"`); continue; }
  if (real.client && !custNames.has(real.client)) console.error(`note: "${real.client}" is not in customers.json`);
  stores[id] = { name: real.name, client: real.client ?? real.name, ...(real.address ? { address: real.address } : {}) };
  swaps.push([fake, real.name]);
}
if (stores.harbour) swaps.push(['Harbour Deli', stores.harbour.name]);

const name = 'ZSP';
swaps.push(['ZSP (demo)', name]);
const seed = {
  company: { name, legal_name: company.legal_name?.replace(/\bproviders\b/, 'Providers') ?? name, reg_no: clean(company.reg_no), vat_no: clean(company.vat_no),
    address: clean(company.address)?.replace(/\b(line|bay)\b/g, (w) => w[0].toUpperCase() + w.slice(1)) ?? null, phone: phone(company.phone), email: clean(company.email) },
  people, others, stores,
  clients: customers.map((c) => ({ name: c.name.trim(), code: clean(c.code), contact: clean(c.contact), email: clean(c.email), phone: phone(c.phone) }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  swaps: swaps.filter(([a, b]) => a && b && a !== b),
};
process.stdout.write(JSON.stringify(seed));
