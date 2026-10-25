#!/bin/bash
# Prepares an online server (a VPS with Ubuntu or Debian) for Real Sandbox, safely, in one go. Run as root
# from the deploy folder of the code:   sudo bash setup-online.sh --domain app.example.co.za
#   --backup-dir /mnt/data/realsandbox-backups   where the daily backups go (best the second disk)
#   --lock-ssh                                   after you have checked that signing in with your SSH key works:
#                                                passwords can no longer be used to sign in to the server
# Safe to run again: it only adds what is missing and never overwrites the settings in .env.
set -euo pipefail
DOMAIN=""; BACKUP=""; LOCK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2;;
    --backup-dir) BACKUP="$2"; shift 2;; --lock-ssh) LOCK=1; shift;;
    *) echo "unknown option $1"; exit 1;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "Run it as root (sudo)."; exit 1; }
cd "$(dirname "$0")"
say() { echo; echo "== $*"; }

say "Updates and the basics"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q && apt-get upgrade -yq
apt-get install -yq ca-certificates curl git ufw fail2ban unattended-upgrades openssl
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

say "Swap (so a small server does not run out of memory while building)"
mem_mb=$(free -m | awk '/^Mem:/ {print $2}')
if [ "$mem_mb" -lt 4000 ] && ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "2 GB swap added"
else echo "not needed"; fi

say "Firewall: only SSH and the web (80, 443) are open"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null; ufw status | sed -n '1,12p'
systemctl enable --now fail2ban >/dev/null 2>&1 || true

say "Docker"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; else docker --version; fi
systemctl enable --now docker >/dev/null

say "Settings (.env)"
if [ ! -f .env ]; then
  cp .env.example .env
  r() { openssl rand -hex 24; }
  sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=$(r)/; s/^APP_DB_PASSWORD=.*/APP_DB_PASSWORD=$(r)/; s/^JWT_SECRET=.*/JWT_SECRET=$(r)$(r)/; s/^WA_BRIDGE_KEY=.*/WA_BRIDGE_KEY=$(r)/" .env
  chmod 600 .env
  echo ".env made with new random passwords (they stay on this server; nobody needs to know them)"
else echo ".env is already there: kept as it is"; fi
setkey() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
[ -n "$DOMAIN" ] && { setkey DOMAIN "$DOMAIN"; setkey PUBLIC_URL "https://$DOMAIN"; echo "web address: https://$DOMAIN"; }
if [ -n "$BACKUP" ]; then mkdir -p "$BACKUP"; setkey BACKUP_DIR "$BACKUP"; echo "backups go to $BACKUP"; fi

if [ "$LOCK" = 1 ]; then
  say "SSH: keys only"
  if [ -s /root/.ssh/authorized_keys ] || ls /home/*/.ssh/authorized_keys >/dev/null 2>&1; then
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/10-realsandbox.conf
    systemctl reload ssh 2>/dev/null || systemctl reload sshd
    echo "Done: signing in to the server now needs your SSH key."
  else echo "No SSH key found on the server: NOT locked (you would be locked out)."; fi
fi

say "Ready"
echo "Start it:   docker compose --env-file .env --profile online up -d --build"
echo "Watch it:   docker compose logs -f api web"
