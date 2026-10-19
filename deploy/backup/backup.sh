#!/bin/bash
# One backup run: every database of the server (the catalog plus one database per
# company, delta_<yyMMddHHmmss><hex>) as a pg_dump custom-format file, plus the roles.
#
#   BACKUP_DIR/<YYYY-MM-DD_HHMMSS>/<database>.dump
#   BACKUP_DIR/<YYYY-MM-DD_HHMMSS>/globals.sql      roles (pg_dumpall --globals-only)
#   BACKUP_DIR/<YYYY-MM-DD_HHMMSS>/databases.txt    the list, catalog first
#
# Runs in the postgres:17 image (same major version as the server). Connection from
# PGHOST / PGUSER / PGPASSWORD. Runs older than BACKUP_KEEP_DAYS (default 14) are removed.
set -euo pipefail
umask 077 # the dumps hold all accounting data
BACKUP_DIR=${BACKUP_DIR:-/backups}
KEEP=${BACKUP_KEEP_DAYS:-14}
stamp=$(date +%Y-%m-%d_%H%M%S)
target="$BACKUP_DIR/$stamp"
tmp="$BACKUP_DIR/.partial-$stamp"
mkdir -p "$tmp"

# Catalog databases first (they list the companies), then the company databases.
mapfile -t dbs < <(psql -d postgres -Atc "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY (datname LIKE 'delta\_%'), datname")
printf '%s\n' "${dbs[@]}" > "$tmp/databases.txt"
pg_dumpall --globals-only --no-role-passwords -f "$tmp/globals.sql" 2>/dev/null || pg_dumpall --globals-only -f "$tmp/globals.sql"
for db in "${dbs[@]}"; do
  pg_dump -d "$db" -Fc -Z 6 -f "$tmp/$db.dump"
done
mv "$tmp" "$target"
echo "$(date -Is) backup $target: ${#dbs[@]} databases, $(du -sh "$target" | cut -f1)"

# Retention
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime "+$KEEP" -print -exec rm -rf {} +
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '.partial-*' -mmin +720 -exec rm -rf {} +
