#!/bin/bash
# One backup:
#   1. The database (every company's records, documents as they went out, the history) dumped and checked.
#   2. The files (photos, scanned slips, job documents, PDFs) copied to the backup folder; only what is new.
#   3. Kept: 30 daily dumps and one a month for a year.
#   4. To the cloud (if set up), encrypted on this server first: the dump and the files. PDFs the app made
#      are not sent (they are made again from the database); photos are sent unless CLOUD_PHOTOS=0.
#   5. What it took per company (for the owner's dashboard) and how it went: status.json.
set -uo pipefail
B=${BACKUP_DIR_IN:-/backups}; U=${UPLOADS_DIR:-/data/uploads}
DB_HOST=${DB_HOST:-db}; DB_USER=${DB_USER:-realsandbox}; DB_NAME=${DB_NAME:-realsandbox}
stamp=$(date +%Y-%m-%d); started=$(date -Iseconds)
mkdir -p "$B/db" "$B/files"
errors=()
log() { echo "$(date -Iseconds) $*" | tee -a "$B/backup.log"; }
log "backup started"

# 1. Database
dump="$B/db/db-$stamp.dump"
db_ok=false; db_bytes=0
if pg_dump -h "$DB_HOST" -U "$DB_USER" -Fc -Z 9 "$DB_NAME" > "$dump.part" && pg_restore -l "$dump.part" > /dev/null; then
  mv "$dump.part" "$dump"; db_ok=true; db_bytes=$(stat -c %s "$dump"); log "database: $db_bytes bytes"
else
  rm -f "$dump.part"; errors+=("the database dump failed"); log "database dump FAILED"
fi

# 2. Files (copied, never deleted from the backup)
files_ok=false
if [ -d "$U" ] && rclone copy "$U" "$B/files" --local-no-check-updated --quiet; then files_ok=true; log "files copied"
elif [ -d "$U" ]; then errors+=("copying the files failed"); log "files FAILED"; else files_ok=true; fi

# 3. Keep 30 days, and the 1st of each month for a year (and old-style photo archives for 30 days)
find "$B/db" -name 'db-*.dump' ! -name 'db-*-01.dump' -mtime +30 -delete
find "$B/db" -name 'db-*-01.dump' -mtime +400 -delete
find "$B" -maxdepth 1 \( -name 'photos-*.tar.gz' -o -name 'db-*.dump' \) -mtime +30 -delete

# 4. Cloud
cloud_set=false; cloud_ok=false; cloud_bytes=0; cloud_at=""
if [ -n "${RCLONE_CONFIG_CLOUD_TYPE:-}" ] && [ -n "${CLOUD_BUCKET:-}" ]; then
  cloud_set=true
  if [ -z "${BACKUP_PASSPHRASE:-}" ] || [[ "${BACKUP_PASSPHRASE}" == CHANGE_ME* ]] || [ ${#BACKUP_PASSPHRASE} -lt 16 ]; then
    errors+=("BACKUP_PASSPHRASE is not set (a sentence of 16+ characters of your own): nothing goes to the cloud"); log "cloud: no passphrase"
  else
    export RCLONE_CONFIG_SAFE_TYPE=crypt
    export RCLONE_CONFIG_SAFE_REMOTE="cloud:${CLOUD_BUCKET}/${CLOUD_FOLDER:-realsandbox}"
    export RCLONE_CONFIG_SAFE_PASSWORD="$(rclone obscure "$BACKUP_PASSPHRASE")"
    export RCLONE_CONFIG_SAFE_PASSWORD2="$(rclone obscure "${BACKUP_PASSPHRASE}-salt")"
    photos=()
    [ "${CLOUD_PHOTOS:-1}" = 0 ] && photos=(--exclude '*.{jpg,jpeg,png,webp,JPG,JPEG,PNG,WEBP}')
    ok=true
    if $db_ok; then rclone copy "$dump" safe:db --quiet || { ok=false; errors+=("the database did not reach the cloud"); }; fi
    if [ -d "$U" ]; then rclone copy "$U" safe:files --exclude '**/export-*.pdf' "${photos[@]}" --quiet || { ok=false; errors+=("the files did not all reach the cloud"); }; fi
    rclone delete safe:db --min-age 31d --exclude 'db-*-01.dump' --quiet 2>/dev/null
    rclone delete safe:db --min-age 400d --quiet 2>/dev/null
    cloud_bytes=$(rclone size safe: --json 2>/dev/null | jq -r '.bytes // 0')
    if $ok; then cloud_ok=true; cloud_at=$(date -Iseconds); log "cloud: $cloud_bytes bytes"; else log "cloud FAILED"; fi
  fi
fi

# 5. Per company (folders of the uploads are per company): photos, documents and the PDFs the app made
companies='{}'
if [ -d "$U" ]; then
  companies=$(find "$U" -type f -printf '%s\t%P\n' | awk -F'\t' '
    { split($2, p, "/"); c = p[1]; n = split($2, q, "/"); f = tolower(q[n]);
      k = (f ~ /^export-.*\.pdf$/) ? "pdfs" : (f ~ /\.(jpg|jpeg|png|webp)$/) ? "photos" : "documents";
      s[c, k] += $1; cnt[c] += 1; seen[c] = 1 }
    END { printf "{"; first = 1
      for (c in seen) { if (!first) printf ","; first = 0
        printf "\"%s\":{\"photos\":%d,\"documents\":%d,\"pdfs\":%d,\"files\":%d}", c, s[c, "photos"], s[c, "documents"], s[c, "pdfs"], cnt[c] }
      printf "}" }')
fi
dumps=$(find "$B/db" -name 'db-*.dump' | wc -l)
local_bytes=$(du -sb "$B" 2>/dev/null | cut -f1)
free_bytes=$(df -B1 --output=avail "$B" 2>/dev/null | tail -1 | tr -d ' ')
ok=$([ ${#errors[@]} -eq 0 ] && echo true || echo false)
errs=$(printf '%s\n' "${errors[@]:-}" | jq -R . | jq -s 'map(select(length > 0))')
prev_cloud_at=$(jq -r '.cloud.lastOkAt // empty' "$B/status.json" 2>/dev/null)
jq -n --arg started "$started" --arg finished "$(date -Iseconds)" --argjson ok "$ok" \
  --argjson dbOk "$db_ok" --argjson dbBytes "${db_bytes:-0}" --arg dbFile "$(basename "$dump")" --argjson filesOk "$files_ok" \
  --argjson dumps "${dumps:-0}" --argjson localBytes "${local_bytes:-0}" --argjson freeBytes "${free_bytes:-0}" \
  --argjson cloudSet "$cloud_set" --argjson cloudOk "$cloud_ok" --argjson cloudBytes "${cloud_bytes:-0}" --arg cloudAt "${cloud_at:-$prev_cloud_at}" \
  --argjson photosToCloud "$([ "${CLOUD_PHOTOS:-1}" = 0 ] && echo false || echo true)" \
  --argjson companies "$companies" --argjson errors "$errs" \
  '{startedAt: $started, finishedAt: $finished, ok: $ok,
    database: {ok: $dbOk, bytes: $dbBytes, file: $dbFile}, files: {ok: $filesOk},
    local: {dumps: $dumps, bytes: $localBytes, freeBytes: $freeBytes},
    cloud: {configured: $cloudSet, ok: $cloudOk, bytes: $cloudBytes, lastOkAt: (if $cloudAt == "" then null else $cloudAt end), photos: $photosToCloud},
    companies: $companies, errors: $errors}' > "$B/status.json.part" && mv "$B/status.json.part" "$B/status.json"
if [ "$ok" = true ]; then date +%s > "$B/last-ok"; log "backup done"; else log "backup finished with problems: ${errors[*]}"; fi
[ "$ok" = true ]
