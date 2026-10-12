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

Fill in `DB_PASSWORD` and `JWT_SECRET` with long random values. `openssl rand -base64 36` makes one each time you run it.

## 4. Start it

```bash
docker compose --env-file .env up -d --build
docker compose logs -f api      # Ctrl+C to stop watching
```

The server sets up the database by itself on first start.

## 5. First login and the policy

```bash
docker compose exec api node --experimental-strip-types scripts/create-user.ts \
  --name "Fred Schallies" --email you@yourcompany.co.za --level creator
```

It asks for a password (at least 10 characters). Then publish the monitoring policy, after the attorney has reviewed it:

```bash
docker compose cp policy.md api:/tmp/policy.md
docker compose exec api node --experimental-strip-types scripts/publish-policy.ts --version 1.0 --file /tmp/policy.md
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

```bash
cd ~/real-sandbox && git pull && cd deploy && docker compose --env-file .env up -d --build
```
