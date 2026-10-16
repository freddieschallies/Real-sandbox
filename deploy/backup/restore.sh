#!/bin/bash
# Getting a backup back. Run inside the backup container:
#   docker compose exec backup restore.sh list                 the dumps on this server and in the cloud
#   docker compose exec backup restore.sh fetch db-2026-10-17.dump   bring a dump down from the cloud into /backups/db
#   docker compose exec backup restore.sh files                bring every file down from the cloud into /backups/restored-files
# Putting a dump back into the database (it replaces what is there): see docs/OFFICE-SERVER.md, "Restore".
set -euo pipefail
B=${BACKUP_DIR_IN:-/backups}
if [ -n "${BACKUP_PASSPHRASE:-}" ] && [ -n "${CLOUD_BUCKET:-}" ]; then
  export RCLONE_CONFIG_SAFE_TYPE=crypt RCLONE_CONFIG_SAFE_REMOTE="cloud:${CLOUD_BUCKET}/${CLOUD_FOLDER:-realsandbox}"
  export RCLONE_CONFIG_SAFE_PASSWORD="$(rclone obscure "$BACKUP_PASSPHRASE")" RCLONE_CONFIG_SAFE_PASSWORD2="$(rclone obscure "${BACKUP_PASSPHRASE}-salt")"
fi
case "${1:-list}" in
  list) echo "On this server:"; ls -lh "$B/db" 2>/dev/null; echo; echo "In the cloud:"; rclone lsl safe:db 2>/dev/null || echo "(cannot read the cloud: not set up, or a different BACKUP_PASSPHRASE)";;
  fetch) rclone copy "safe:db/$2" "$B/db" && echo "Now in $B/db/$2";;
  files) rclone copy safe:files "$B/restored-files" && echo "Files are in $B/restored-files";;
  *) echo "restore.sh list | fetch <dump> | files"; exit 1;;
esac
