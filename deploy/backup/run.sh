#!/bin/bash
# Runs the backup every day at BACKUP_TIME (default 01:30, office time). If the server was off at that
# time (a PC switched off overnight), it runs as soon as it is back and the last backup is over a day old.
set -u
B=${BACKUP_DIR_IN:-/backups}
AT=${BACKUP_TIME:-01:30}
mkdir -p "$B"
last_ok() { [ -f "$B/last-ok" ] && cat "$B/last-ok" || echo 0; }
sleep "${BACKUP_START_DELAY:-300}"   # let the database start first
while true; do
  now=$(date +%s); today=$(date +%Y-%m-%d)
  done_today=$([ -f "$B/done-$today" ] && echo 1 || echo 0)
  if { [ "$(date +%H:%M)" \> "$AT" ] || [ "$(date +%H:%M)" = "$AT" ]; } && [ "$done_today" = 0 ]; then
    backup.sh && touch "$B/done-$today"
  elif [ $((now - $(last_ok))) -gt 93600 ] && [ ! -f "$B/tried-$today" ]; then
    touch "$B/tried-$today"; backup.sh   # missed: catch up once today
  fi
  find "$B" -maxdepth 1 \( -name 'done-*' -o -name 'tried-*' \) -mtime +3 -delete 2>/dev/null
  sleep 60
done
