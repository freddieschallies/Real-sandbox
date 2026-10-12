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
- Must have: UPS, LTE backup internet with automatic failover, nightly encrypted backups copied off-site.

## Build phases

1. Core: logins and permissions, stores and equipment, job cards (work items, visits, offline), van stock and stockroom.
2. Tracking: Tracking Africa connection, barcode scan-in, live map, monitoring flags.
3. Office: quotes and invoices with pricing, timesheet checks, fuel, supplier database, director digest.
4. Learned trip times, live driving markers, pattern reports.

## Status

- `server/db/001_init.sql`: full schema (47 tables and views); `db/test_rules.sql` checks 9 hard rules: all pass.
- `server/src/core`: permissions, job card forced path, monitoring thresholds; `test/core.test.ts`: 22 tests, all pass.
