#!/bin/bash
# First start of the postgres container only (docker-entrypoint-initdb.d): the role the app
# connects with and its catalog database. The role may create databases (one per company)
# but is not a superuser.
set -euo pipefail
: "${APP_DB_USER:=shmelta}" "${APP_DB_NAME:=shmelta}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v user="$APP_DB_USER" -v pass="$APP_DB_PASSWORD" -v db="$APP_DB_NAME" <<'SQL'
CREATE ROLE :"user" LOGIN CREATEDB PASSWORD :'pass';
CREATE DATABASE :"db" OWNER :"user" ENCODING 'UTF8';
SQL
