#!/bin/bash
# The backup container's main process: backup.sh once a day at BACKUP_TIME (HH:MM, local
# time of TZ; default 02:30). BACKUP_ON_START=1 also runs one backup right away.
set -uo pipefail
BACKUP_TIME=${BACKUP_TIME:-02:30}
here=$(dirname "$0")

until pg_isready -q; do sleep 5; done
[ "${BACKUP_ON_START:-0}" = "1" ] && bash "$here/backup.sh"

while true; do
  now=$(date +%s)
  next=$(date -d "today $BACKUP_TIME" +%s)
  [ "$next" -le "$now" ] && next=$(date -d "tomorrow $BACKUP_TIME" +%s)
  echo "$(date -Is) next backup at $(date -d "@$next" -Is)"
  sleep $((next - now))
  bash "$here/backup.sh" || echo "$(date -Is) BACKUP FAILED" >&2
done
