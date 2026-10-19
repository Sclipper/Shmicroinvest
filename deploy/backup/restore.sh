#!/bin/bash
# Restore a backup run made by backup.sh (docs/DEPLOY.md, "Restore").
#
#   restore.sh <backup-dir> [database ...]
#
# Without database names every database of the run is restored (disaster recovery);
# with names only those (e.g. one company). Each database is dropped and recreated,
# owned by APP_DB_USER (default shmelta). STOP THE APP FIRST:
#   docker compose stop app
#   docker compose run --rm --entrypoint bash backup /scripts/restore.sh /backups/2026-10-19_023000
#   docker compose start app
set -euo pipefail
dir=${1:?usage: restore.sh <backup-dir> [database ...]}
shift
owner=${APP_DB_USER:-shmelta}
[ -f "$dir/databases.txt" ] || { echo "not a backup run: $dir" >&2; exit 1; }
if [ $# -gt 0 ]; then dbs=("$@"); else mapfile -t dbs < "$dir/databases.txt"; fi

# The app's role must exist (a fresh server): create it from the backup's globals.
if ! psql -d postgres -Atc "SELECT 1 FROM pg_roles WHERE rolname = '$owner'" | grep -q 1; then
  echo "role $owner missing: loading roles from globals.sql (set its password afterwards: ALTER ROLE $owner PASSWORD '...')"
  psql -d postgres -v ON_ERROR_STOP=0 -f "$dir/globals.sql" >/dev/null
fi

for db in "${dbs[@]}"; do
  [[ "$db" =~ ^[a-z][a-z0-9_]{2,62}$ ]] || { echo "invalid database name: $db" >&2; exit 1; }
  [ -f "$dir/$db.dump" ] || { echo "missing $dir/$db.dump" >&2; exit 1; }
  echo "restoring $db"
  psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" -c "CREATE DATABASE \"$db\" OWNER \"$owner\" ENCODING 'UTF8'"
  pg_restore -d "$db" --no-owner --role="$owner" --exit-on-error "$dir/$db.dump"
done
echo "restored ${#dbs[@]} database(s) from $dir"
