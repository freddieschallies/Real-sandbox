# Installing Real Sandbox on the office server

## What you need

| Item | Notes |
|---|---|
| A small PC or mini server | 4 CPU cores, 8 GB RAM, 256 GB SSD is plenty for 25 vehicles. A business mini PC works. |
| UPS | Keeps it running through load-shedding switch-overs; size it for 2+ hours if possible. |
| Backup internet | An LTE router with automatic failover, so phones can sync when the fibre drops. |
| Off-site backup | A cloud folder or a USB drive that goes home with someone, for the nightly backups. |

## 1. Install the operating system

1. Install **Ubuntu Server 24.04 LTS** on the PC. Choose "Install OpenSSH server" during setup.
2. Give it a fixed address on the office network (in the router's DHCP settings).
3. Turn on automatic security updates: `sudo dpkg-reconfigure --priority=low unattended-upgrades`.

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out and back in afterwards
```

## 3. Get the code and settings

```bash
git clone https://github.com/freddieschallies/Real-sandbox.git ~/real-sandbox
cd ~/real-sandbox/deploy
cp .env.example .env
nano .env
```

Fill in `DB_PASSWORD`, `APP_DB_PASSWORD` and `JWT_SECRET` with long random values. `openssl rand -hex 24` makes one each time you run it; use a different one for each.

## 4. Start it

```bash
docker compose --env-file .env up -d --build
docker compose logs -f api      # Ctrl+C to stop watching
```

The server sets up the database by itself on first start.

## 5. Platform owner, first company, and its policy

The server can hold several companies; each one's data is kept apart by the database itself.

```bash
# Your platform owner login (creates and suspends companies; cannot see company data)
docker compose exec api node --experimental-strip-types scripts/create-platform-admin.ts \
  --name "Fred Schallies" --email you@yourcompany.co.za

# A company and its first Creator login (repeat for each client company)
docker compose exec api node --experimental-strip-types scripts/create-company.ts \
  --company "ZSP" --name "Fred Schallies" --email fred@zsp.co.za
```

Each asks for a password. One email address can belong to only one login. Then publish that company's monitoring policy, after the attorney has reviewed it:

```bash
docker compose cp policy.md api:/tmp/policy.md
docker compose exec api node --experimental-strip-types scripts/publish-policy.ts --company "ZSP" --version 1.0 --file /tmp/policy.md
```

## 6. Let the phones reach it (Cloudflare Tunnel)

1. Create a free Cloudflare account and add a domain you own (for example `zsp.co.za`).
2. In Cloudflare **Zero Trust → Networks → Tunnels**, create a tunnel, and copy its token into `TUNNEL_TOKEN` in `.env`.
3. In the tunnel's public hostname settings, point e.g. `app.zsp.co.za` to `http://api:8080`.
4. Start it: `docker compose --env-file .env --profile tunnel up -d`.

No ports are opened on the office router; the server makes the connection outwards.

## 7. Backups

- Every night at 01:30 the `backup` service writes the database and all photos to `deploy/backups/`, keeping 30 days.
- Copy that folder off-site every day (a cloud folder sync, or rsync to another machine). A backup that stays in the office is lost with the office.
- Test a restore once a month: `pg_restore` the latest dump into a spare database and check it opens.

## Updating

Every company runs on this one server, so one update reaches all of them at once. Follow this
checklist every time.

### Before

1. **Pick a quiet time:** an evening or a weekend, when the technicians are not on site. The app is
   down for under a minute while it restarts. Customers who rely on it: tell them a day before.
2. **Know what is changing.** Read the update notes (the GitHub commit messages, or the "What's new"
   note). Updates are only applied after the automatic tests have passed and the change has been tried
   in the test drive.
3. **Note the version you are on now**, so you can go back to it:

   ```bash
   cd ~/real-sandbox && git log --oneline -1
   ```

   Write down the code at the start of the line (e.g. `5ce888f`).
4. **Make a backup now** (on top of the nightly one):

   ```bash
   cd ~/real-sandbox/deploy
   docker compose exec backup bash -c 'stamp=$(date +%Y-%m-%d-%H%M); pg_dump -h db -U realsandbox -Fc realsandbox > /backups/db-before-update-$stamp.dump && tar -czf /backups/photos-before-update-$stamp.tar.gz -C /data uploads'
   ls -lh backups | tail -3
   ```

   The two new files must be there and not 0 bytes. If they are not, stop: do not update.

### Update

```bash
cd ~/real-sandbox && git pull && cd deploy && docker compose --env-file .env up -d --build
```

Any changes to the database are applied by themselves when the server starts, once. They only ever
add to the database (new tables, new columns): nothing that is in it is changed or deleted.

### Check

1. Watch it start: `docker compose logs api --tail 50`. You should see `applying 0xx_…` for each
   database change, then the server listening, and no red errors.
2. On a computer: sign in, open a job, an invoice and a timesheet.
3. Ask one technician to open the app on his phone and check his day.

### If something is wrong: go back

Go back to the version you wrote down:

```bash
cd ~/real-sandbox && git checkout 5ce888f && cd deploy && docker compose --env-file .env up -d --build
```

(Use your own code instead of `5ce888f`.) Because database changes only add, the older version runs
on the newer database; nothing is lost. Report what went wrong. When the fix is ready, come back to the
latest version with `cd ~/real-sandbox && git checkout main && git pull`, then the update command again.

**Last resort only: restore the backup.** This puts the database back to the moment of the backup:
anything entered after it (jobs, timesheets, invoices) is lost. Use it only if the data itself is damaged.

```bash
cd ~/real-sandbox/deploy
docker compose stop api
docker compose exec -T db pg_restore -U realsandbox -d realsandbox --clean --if-exists < backups/db-before-update-YYYY-MM-DD-HHMM.dump
docker compose start api
```

### The phone app

- **Screens and rules** (nearly every update): once over-the-air updates are switched on, phones load
  the new version by themselves the next time the app opens. *Not set up yet: it is done with the
  phone app build (see the server setup list).* Until then, a new phone build is installed on the phones.
- **Changes to the phone itself** (a new permission, camera or GPS feature, a new Android or iPhone
  version): a new build goes to the Play Store / App Store and people update the app there. This is rare.
- Phones that are offline or not yet updated keep working: every update is made to work with the
  previous version of the phone app for a while. Once over-the-air updates are on, the app also tells
  anyone on a version that is too old to update before carrying on.

### Rules every update follows (for whoever builds it)

- Database changes only add (new tables and columns); nothing is renamed or deleted in one go.
- The previous version of the phone app keeps working with the new server.
- The automatic tests pass, and the change is tried in the test drive, before it reaches this server.
- Customers' real data never goes into the code or the test drive used by others.

### Later, with several paying companies

- A **test copy of the server** (a second, cheap machine or a cloud server) with a copy of the data:
  every update goes there first for a day, then here.
- A short **"What's new"** note to customers with each update.
- Updates on a fixed, announced evening (e.g. Tuesday 20:00), except urgent fixes.

## Breakdowns: Gmail inboxes and the WhatsApp group

Breakdown emails and messages in the WhatsApp breakdowns group come into the office's **Breakdowns** tab.

**Gmail (per inbox)**
1. In that Gmail account: Google account → Security → turn on 2-Step Verification → App passwords → create one called "Real Sandbox".
2. In the app as the CEO: Settings → Breakdowns → Connect a Gmail inbox → the address and the 16-letter app password.
3. The server reads new emails every minute. It never deletes, moves or marks emails as read. To stop it, delete the app password in Google (or Disconnect in Settings).
4. Optional: `ANTHROPIC_API_KEY` in `.env` lets AI read the store, fault and call log number; without it simple rules do (the office checks either way).

**WhatsApp (the company's own number)**
1. A cheap Android phone with its own SIM, used only for this. Install WhatsApp on it and add that number to the breakdowns group.
2. In `.env`: `WA_BRIDGE_KEY` (make one with `openssl rand -hex 24`) and `WA_COMPANY_ID` (Settings → Breakdowns shows the company id).
3. Start it: `docker compose --env-file .env --profile whatsapp up -d --build`
4. Settings → Breakdowns shows a QR code: on the ZSP phone, WhatsApp → ⋮ → Linked devices → Link a device → scan it.
5. Choose the breakdowns group in Settings, and what the app posts there.

This is not WhatsApp's official business system (that one cannot join an existing group), so WhatsApp could block the number. If that happens, the group itself keeps working, email keeps coming in, and you link a new number the same way.

## Customers and store pins

Office → Stores → **Bring in customers**: upload the customer list (CSV or Excel .xlsx, one row per site). The app guesses the columns; check them, preview, bring them in. Every site's address is then found on the map in the background (a few a minute):

- **Pinned**: found at the address.
- **Check the pin**: only the street, suburb or town was found (or the pin came from a technician's first Arrived). Open it in Google Maps, then "The pin is right" or paste the right point.
- **No pin yet**: not found. Fix the address (it is looked up again) or paste the point from Google Maps.

A pin in the file (latitude and longitude columns) is used as it is. A pin set by hand is never replaced by an import or a lookup.

The lookups use OpenStreetMap (free) unless `GOOGLE_MAPS_KEY` is set in `.env` (Google Cloud → Geocoding API), which finds South African shop addresses better.
