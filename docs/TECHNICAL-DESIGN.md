# Real Sandbox: technical design

## Stack

| Part | Built with | Why |
|---|---|---|
| Database | PostgreSQL 16 | Enforces the hard rules itself (locked job cards, immutable logs) |
| Server / API | Node.js 22 + TypeScript (Fastify) | One language across server, web and phone app |
| Rules engine | Plain TypeScript, no dependencies (`server/src/core`) | Same rules run on the server and offline on the phone |
| Phone app | React Native (Expo), offline-first with on-phone SQLite | One app for Android and iPhone, works with no signal |
| Control base | React web app | Desktop for Admin and up |
| Tracker connection | Playwright background browser (`tracker/`) | Logs into the Tracking Africa portal; separate plug-in module |

## Office server

- Ubuntu server running Docker Compose: `postgres`, `api`, `web`, `tracker`, `backup`.
- Reached from phones through a Cloudflare Tunnel: no open ports or static IP needed.
- Timesheet tolerance: a job differing by more than 15 minutes from the timers raises a mismatch flag.
- Must have: UPS, LTE backup internet with automatic failover, nightly encrypted backups copied off-site.

## Build phases

1. Core: logins and permissions, stores and equipment, job cards (work items, visits, offline), van stock and stockroom.
2. Tracking: Tracking Africa connection, barcode scan-in, live map, monitoring flags.
3. Office: quotes and invoices with pricing, timesheet checks, fuel, supplier database, director digest.
4. Learned trip times, live driving markers, pattern reports.

## Status

- `server/db/001_init.sql`: full schema (47 tables and views); `db/test_rules.sql` checks 9 hard rules: all pass.
- `server/src/core`: permissions, job card forced path, monitoring thresholds; `test/core.test.ts`: 22 tests, all pass.
- `server/src`: API server (Fastify). Logins, monitoring-policy gate, job creation, the full job card flow (go, arrive with geofence, start, pause, work items, photos, van stock materials, done, continue later, close with signature or manager unavailable). `test/api.test.ts`: 8 end-to-end tests against a real database, all pass.
- Server features for the phone app: offline replays (Idempotency-Key), photo uploads, my day, van stock, vehicle barcode scan-in, fuel, supply runs with learned suppliers, timesheets checked against job timers, on-site estimates, flags (explain and resolve), notices. `test/api.test.ts`: 17 end-to-end tests.
- Companies: several businesses on one server. Every company table has `company_id` with PostgreSQL row-level security (forced), the app runs as a restricted database user, and each request runs in one transaction with its company set. Platform owner logins manage companies but cannot read company data. Per-company job/quote/invoice numbering and photo folders. `test/api.test.ts` includes cross-company break-in tests.
- Access control: defaults per login type, changeable by anyone with manage_access (Directors and Creator by default), per login type or per person, with history.
- Office server: `deploy/docker-compose.yml` (database, API, nightly backups, Cloudflare tunnel); install guide in `docs/OFFICE-SERVER.md`.
- Run tests: `npm test` in `server/` (needs a local PostgreSQL; see `TEST_DATABASE_ADMIN_URL`).
