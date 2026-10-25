# Real Sandbox on an online server (VPS)

The same app as on an office PC, but on a rented server in a data centre (e.g. Rackzar in
Johannesburg). Phones and office computers reach it from anywhere on one web address, with HTTPS.
There is no tunnel, no office PC to keep switched on, and no load-shedding.

| Office PC (OFFICE-SERVER.md) | Online server (this page) |
|---|---|
| Needs a UPS and backup internet in the office | The data centre has power and internet |
| Cloudflare tunnel for the phones | Opens to the internet itself, with HTTPS (Caddy) |
| Office computers use the phone app or a browser | Office computers just open the web address |

## What it needs

- **Ubuntu 24.04 or Debian 12**, 2 or more CPU cores, 4 GB RAM (2 GB works with the swap the setup adds), and 40 GB or more of disk.
- **A web address** pointing at the server's IP address:
  - **Free for now:** DuckDNS (`something.duckdns.org`).
    1. Sign in at duckdns.org with Google or GitHub.
    2. Add a sub-domain.
    3. Type the server's IP address and tap "update ip".
  - **Later:** your own address (e.g. `jobs.<name>.co.za`, about R100 a year). Add an "A record" with the server's IP at the registrar, then change `DOMAIN` in `.env` and restart the `web` service.
- **The second disk** (Rackzar gives a 1 TB SATA disk) for the daily backups. Mount it once, e.g. at `/mnt/data`.

## 1. Sign in with a key, not a password

On the laptop (PowerShell):

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\realsandbox -C "fred laptop"
type $env:USERPROFILE\.ssh\realsandbox.pub | ssh root@SERVER_IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
ssh -i $env:USERPROFILE\.ssh\realsandbox root@SERVER_IP
```

The second line asks for the server's root password from the Rackzar email, **once**. Type it there yourself. After that the key signs you in.

## 2. The code

The repository is private, so the server gets a read-only deploy key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github -N "" -C "realsandbox server"
cat ~/.ssh/github.pub
```

1. Copy that line into GitHub → the repo → Settings → Deploy keys → Add deploy key. Leave **Allow write access** off.
2. Back on the server, run:

   ```bash
   printf 'Host github.com\n  IdentityFile ~/.ssh/github\n' >> ~/.ssh/config
   git clone git@github.com:freddieschallies/Real-sandbox.git /opt/realsandbox
   ```

## 3. Set up the server

```bash
cd /opt/realsandbox/deploy
sudo bash setup-online.sh --domain yourname.duckdns.org --backup-dir /mnt/data/realsandbox-backups
```

It does the following:

- Installs the updates, with automatic security updates from then on.
- Adds swap on a small server.
- Turns on the firewall: only SSH, 80 and 443 are open.
- Blocks repeated wrong sign-ins (fail2ban).
- Installs Docker.
- Makes `.env` with new random passwords. They stay on the server, and nobody needs to know them.

When you have checked that the key works (step 1), lock passwords out:

```bash
sudo bash setup-online.sh --lock-ssh
```

## 4. Start it

```bash
docker compose --env-file .env --profile online up -d --build
docker compose logs -f api web
```

The first build takes a few minutes. Then open `https://yourname.duckdns.org`: the sign-in page. The HTTPS certificate is fetched by itself the first time.

Then create your owner login and the first company exactly as in OFFICE-SERVER.md step 5, from `/opt/realsandbox/deploy`.

## 5. Backups

These are the same as on the office PC (OFFICE-SERVER.md, "Backups").

- The daily copy goes to `--backup-dir` on the second disk.
- The encrypted copy goes to the cloud once `CLOUD_BUCKET`, the keys and `BACKUP_PASSPHRASE` are set in `.env`.
- Because the server and its disks are in the same building, **the cloud copy matters**: set it up.

## Updating

```bash
cd /opt/realsandbox && git pull
cd deploy && docker compose --env-file .env --profile online up -d --build
```

Follow the checklist in OFFICE-SERVER.md, "Updating": a quiet time, a backup first, and the version you came from noted down.
