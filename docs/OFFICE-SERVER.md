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

Each asks for a password. One email address can belong to only one login.

After that you don't need the scripts: in the app, tap **Real Sandbox owner sign-in** on the sign-in screen and use your owner login. The owner dashboard shows every company as numbers only (people, jobs this month, last activity, start-up progress, WhatsApp and Pastel), and lets you:

- **Add a company** with its CEO's name and email: the CEO gets a setup code and chooses their own password.
- **New CEO setup code** when a CEO is locked out or forgot their password.
- **Suspend / Reactivate** a company (nothing is deleted).
- **Open as support**, only while that company's CEO has tapped *Settings → Real Sandbox support → Let support in*, and only for the time they chose. Everything you do is in their history as "Support: <your name>", and they can end it any time.

Then publish that company's monitoring policy, after the attorney has reviewed it:

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

Every day at 01:30 (or as soon as the server is back on, if it was off) the `backup` service:

1. Dumps the database: every company's records, every document exactly as it went out, and the history. It checks that the dump can be read.
2. Copies the files (photos, scanned slips, job documents, the PDFs the app made) into the backup folder. Only new files are copied, and nothing is ever deleted from the backup.
3. Keeps 30 daily dumps, plus the dump from the 1st of each month for a year.
4. Sends a copy to the cloud. Everything is **encrypted on this server first** with `BACKUP_PASSPHRASE`, so the cloud company cannot read your clients' data. The cloud gets:
   - the database
   - the documents
   - the photos (they are compressed; `CLOUD_PHOTOS=0` leaves them out)

   PDFs the app made are not sent: they are made again from the database.
5. Writes how it went (and the space each company uses) for the owner's dashboard. The CEO sees "last backup" under Settings.

**Set it up once**

- `BACKUP_DIR` in `.env`: a folder on a **second disk** if the PC has one (e.g. `/mnt/backup-disk/realsandbox`). A backup on the same disk as the database is lost with the disk.
- The cloud: Cloudflare R2 is recommended, because the tunnel already uses Cloudflare. It has 10 GB free, then about R0.30 per GB a month.
  1. In Cloudflare, go to R2 → Create bucket (e.g. `zsp-backup`).
  2. Go to R2 → Manage API tokens → Create API token, with Object Read & Write for that bucket only.
  3. In `.env`, fill in:
     - `CLOUD_BUCKET`
     - `CLOUD_ENDPOINT` (shown on the token page)
     - `CLOUD_ACCESS_KEY_ID`
     - `CLOUD_SECRET_ACCESS_KEY`
  4. Choose `BACKUP_PASSPHRASE`: a long sentence. **Write it on paper and keep it at home or in the safe.** Without it the cloud copy cannot be read, by anyone.
  5. Start it with `docker compose --env-file .env up -d --build backup`.
- Run one now to check it:

  ```bash
  docker compose exec backup backup.sh
  ```

  It must end with "backup done". The owner's dashboard then shows the backup in green.

**Restore** (test this once a month)

- To see what there is (on this server and in the cloud):

  ```bash
  docker compose exec backup restore.sh list
  ```

- If this server's disk is gone, bring a dump down from the cloud:

  ```bash
  docker compose exec backup restore.sh fetch db-2026-10-17.dump
  ```

- To bring all the files down from the cloud (into `BACKUP_DIR/restored-files`):

  ```bash
  docker compose exec backup restore.sh files
  ```

- To put a dump back into the database (this replaces what is there; do it with the app stopped):

  ```bash
  docker compose stop api
  docker compose exec -T db pg_restore -U realsandbox -d realsandbox --clean --if-exists < backups/db/db-2026-10-17.dump
  docker compose start api
  ```

- To test without touching the real data, restore into a spare database instead:

  ```bash
  docker compose exec db createdb -U realsandbox restore_test
  docker compose exec -T db pg_restore -U realsandbox -d restore_test < backups/db/db-2026-10-17.dump
  ```

  Check that it opens, then drop it:

  ```bash
  docker compose exec db dropdb -U realsandbox restore_test
  ```

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
   docker compose exec backup bash -c 'stamp=$(date +%Y-%m-%d-%H%M); pg_dump -h db -U realsandbox -Fc realsandbox > /backups/db/db-before-update-$stamp.dump' && docker compose exec backup backup.sh
   ls -lh backups/db | tail -3
   ```

   The new dump must be there and not 0 bytes, and the backup must end with "backup done". If not, stop: do not update.

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
docker compose exec -T db pg_restore -U realsandbox -d realsandbox --clean --if-exists < backups/db/db-before-update-YYYY-MM-DD-HHMM.dump
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

**WhatsApp: each company chooses when it sets up (nothing to do on the server per company)**

The CEO opens Start-up → WhatsApp (or Settings → WhatsApp) and picks one:

- **Our own phone** (works in the existing breakdowns group): a cheap Android phone with its own SIM, used only
  for this, with WhatsApp on it and the number added to the breakdowns group. In the app: "Show the code", then on
  that phone WhatsApp → ⋮ → Linked devices → Link a device → scan. Choose the group, "Send a test", done.
  The link service (`whatsapp` in docker-compose) runs for every company on this server; it only needs
  `WA_BRIDGE_KEY` in `.env` once, at install. This is not WhatsApp's official system (that one cannot join an
  existing group), so WhatsApp could block a number: the group itself keeps working, email keeps coming in, and
  the company links a new number the same way.
- **Official WhatsApp Business number** (no phone; stores message the number directly, no groups): the CEO taps
  "Connect with WhatsApp", Meta's own window opens, they choose or add a number and confirm it with a code by SMS
  or a call. It only shows once Real Sandbox is signed up with Meta (below); until then it says "coming soon".

Either way every chat shows in the office's **WhatsApp** tab (read and reply in the app).

**Once, for the official option: Real Sandbox signs up with Meta as a "tech provider"**
1. A Meta (Facebook) business account for Real Sandbox, and **business verification** (company documents; takes days).
2. developers.facebook.com → Create app → type **Business** → add the **WhatsApp** product.
3. WhatsApp → Configuration → Webhook: URL `https://<your server address>/webhooks/whatsapp`, a verify token you
   make up (put the same in `WA_VERIFY_TOKEN`), and subscribe to **messages**.
4. Facebook Login for Business → Configurations → create one for **WhatsApp Embedded Signup**; copy its id into
   `META_CONFIG_ID`. Add your server's web address under the app's allowed domains.
5. App settings → Basic: copy the App ID and App Secret into `META_APP_ID` and `META_APP_SECRET`.
6. App Review: ask for `whatsapp_business_management` and `whatsapp_business_messaging` (advanced access), then
   switch the app to Live. Restart: `docker compose --env-file .env up -d`.
Meta charges per message the business starts (templates); replies within 24 hours of the customer's message are
free. An official number can only write freely within 24 hours of the person's last message.

## Customers and store pins

Office → Stores → **Bring in customers**: upload the customer list (CSV or Excel .xlsx, one row per site). The app guesses the columns; check them, preview, bring them in. Every site's address is then found on the map in the background (a few a minute):

- **Pinned**: found at the address.
- **Check the pin**: only the street, suburb or town was found (or the pin came from a technician's first Arrived). Open it in Google Maps, then "The pin is right" or paste the right point.
- **No pin yet**: not found. Fix the address (it is looked up again) or paste the point from Google Maps.

A pin in the file (latitude and longitude columns) is used as it is. A pin set by hand is never replaced by an import or a lookup.

The lookups use OpenStreetMap (free) unless `GOOGLE_MAPS_KEY` is set in `.env` (Google Cloud → Geocoding API), which finds South African shop addresses better.
