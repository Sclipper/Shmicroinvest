# Deploying Shmicroinvest Shmelta Pro

This guide covers three ways to run the app on a public address:

- (a) Docker Compose on an EU VPS, with HTTPS and daily backups (recommended);
- (b) Amp Apps;
- (c) any Node.js host.

It ends with the first run, backups, upgrades and the full list of settings.

## What gets deployed

`pnpm release:bundle` (Node 26 and pnpm on the build machine) writes `release/`, about 50 MiB:

| Path | What |
|---|---|
| `server.js` | The API server and all of its JavaScript dependencies, bundled by esbuild into plain JavaScript for **Node 22 or newer** |
| `server.js.map`, `server.js.LEGAL.txt` | The source map (`node --enable-source-maps` prints TypeScript stack traces) and the licences of the bundled packages |
| `web/` | The built UI, fonts included. The server serves it. |
| `migrations/company`, `migrations/catalog` | Schema migrations. They run at start. |
| `node_modules/@electric-sql/pglite` | The embedded database (wasm and data files), the only runtime package |
| `package.json`, `.env.example`, `VERSION` | `npm start` = `node --enable-source-maps server.js`, and the settings reference |

The bundle needs no `npm install`. Copy the folder and run `node server.js`. The server:

- listens on `HOST:PORT` (default `0.0.0.0:3000`);
- serves the UI at `/` and the API at `/api`;
- answers `GET /api/health` with `{"ok":true,"version":"1.0.0"}`, or 503 when the database is down.

To check a running server: `node scripts/release-smoke.ts https://your.host [setup-token]`. It checks the health endpoint and the UI, creates the first company, posts an entry, runs a report, builds an Excel file, and makes and restores a backup.

**Storage.** Every company is its own Postgres database, and a *catalog* database lists them and keeps the sessions.

- With `DATABASE_URL`, the URL names the catalog database, and company databases (`delta_<yyMMddHHmmss><hex>`) are created next to it on the same server. The role needs `CREATEDB`.
- Without `DATABASE_URL`, the embedded PGlite engine keeps everything in `DATA_DIR`: `catalog/`, `companies/<name>/`, `secret.key` and `shmelta.log`.

Use PGlite only when one server process has a persistent disk.

## (a) Docker Compose on an EU VPS (Hetzner or similar)

`deploy/` contains:

| File | What |
|---|---|
| `Dockerfile` | Multi-stage build: Node 26 builds the bundle, and the runtime is `node:24-bookworm-slim`. The app runs as the non-root user `node`, and the image has a `HEALTHCHECK` on `/api/health`. |
| `docker-compose.yml` | `db` (postgres:17, volume `pgdata`, not published), `app`, `caddy` (ports 80/443, automatic certificates), `backup` (daily `pg_dump` of every database) |
| `Caddyfile` | `{$DOMAIN}` → `app:3000`, compression, 110 MB upload limit, long timeouts for imports |
| `initdb/01-app-role.sh` | Runs on the first start of the database: creates the app's role `shmelta` (`LOGIN CREATEDB`, not a superuser) and its catalog database `shmelta` |
| `backup/backup.sh`, `backup/backup-loop.sh`, `backup/restore.sh` | Backup, daily schedule and restore |
| `.env.example` | The compose settings (copy to `deploy/.env`) |

### Install

1. Create a VPS in an EU location (for example Hetzner CX22 in Falkenstein, Nuremberg or Helsinki, with Debian 12 or Ubuntu 24.04). Install Docker Engine with the compose plugin. Open ports 22, 80 and 443 only.
2. Point an `A` (and `AAAA`) DNS record for your host name, for example `shmelta.example.bg`, at the server.
3. Clone the repository on the server and configure it:
   ```bash
   git clone <repo> shmelta && cd shmelta/deploy
   cp .env.example .env
   # DOMAIN, POSTGRES_PASSWORD, APP_DB_PASSWORD, SHMI_SECRET (openssl rand -base64 32), SHMI_SETUP_TOKEN
   chmod 600 .env
   docker compose up -d --build
   docker compose ps          # app: healthy
   docker compose logs app    # data location, first-run note
   ```
4. Open `https://shmelta.example.bg` and follow [First run](#first-run).

Caddy gets and renews the certificate by itself. The app runs with `TRUST_PROXY=1`, so the session cookie is `Secure` and HSTS is sent. Only Caddy is reachable from outside: the database and the app port are internal to the compose network.

### Backups

The `backup` container runs `backup.sh` every day at `BACKUP_TIME` (default 02:30 Sofia time). Each run writes a folder `deploy/backups/<YYYY-MM-DD_HHMMSS>/` with:

- one `pg_dump -Fc` file per database: the catalog `shmelta.dump` and every company's `delta_….dump`;
- `globals.sql` with the roles;
- `databases.txt` with the list of databases.

Folders older than `BACKUP_KEEP_DAYS` (default 14) are deleted. The files are readable only by root (`umask 077`).

```bash
docker compose exec backup bash /scripts/backup.sh     # a backup now
ls deploy/backups/
```

Copy the backups off the server as well, for example with a nightly `rsync`/`restic` from `deploy/backups` to a storage box. Keep `SHMI_SECRET` with them: without it the stored SMTP passwords cannot be read, although the accounting data can.

The program's own backups ("Архивиране", 01b 2) are kept in the catalog database, so the dumps include them.

For copies off the server, set `SHMI_BACKUP_S3_*` (see Settings): the program then uploads a ZIP of every company to S3-compatible storage each day and lists the remote archives in "Възстановяване на фирма", where an administrator can restore one.

### Restore

```bash
cd deploy
docker compose stop app
# everything (disaster recovery: a new server, or after `docker compose down -v`) ...
docker compose run --rm --entrypoint bash backup /scripts/restore.sh /backups/2026-10-19_023000
# ... or one company only (its database name is in databases.txt / the program's "Активна фирма")
docker compose run --rm --entrypoint bash backup /scripts/restore.sh /backups/2026-10-19_023000 delta_261019193629ac98
docker compose start app
```

`restore.sh` drops and recreates each database owned by `shmelta` and loads the dump with `pg_restore`. On a new server, first run `docker compose up -d db backup`, which creates the role from `.env`, then restore and start the app.

This procedure was tested: back up, `docker compose down -v`, `up -d db backup`, `restore.sh`, then `up -d`. The companies, users, passwords and entries all came back.

### Upgrade

```bash
cd shmelta && git pull
cd deploy
docker compose exec backup bash /scripts/backup.sh      # always back up first
docker compose up -d --build app
docker compose logs -f app
```

The migrations run on start: the catalog's before the port opens, and each company's the first time the company is opened. Migrations only go forward. To roll back, restore the backup taken before the upgrade and run the previous image (`SHMELTA_VERSION`).

## (b) Amp Apps

Build the bundle locally or in CI, then deploy the folder:

```bash
pnpm release:bundle
amp apps deploy <workspace/app> release/ --command node --arg server.js --port 3000 --health-path /api/health
```

Set the app's environment (see `amp apps --help` for how your CLI version takes environment variables and secrets):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | the port given to `--port` |
| `DATABASE_URL` | an external Postgres database, see below (**required**) |
| `SHMI_SECRET` | a long random string (**required**; the file system is not persistent) |
| `SHMI_SETUP_TOKEN` | the first-run token |
| `TRUST_PROXY` | `1` (HTTPS is terminated in front of the app) |

Before you choose Amp Apps, know three things:

- **Amp Apps are public.** Anybody with the URL reaches the login page, so set `SHMI_SETUP_TOKEN` before the first deploy.
- **They pause when idle.** The first request after a pause waits for the start. Startup is quick because the catalog migration is a no-op after the first run, but the first request is slower.
- **Persistence across redeploys is not documented.** Do not keep production data in the app's file system: the PGlite `DATA_DIR`, the `secret.key` file and the log file can disappear with a redeploy.
  - Point `DATABASE_URL` at a managed Postgres in an EU region, for example Neon (`aws-eu-central-1`, Frankfurt) or Supabase (Frankfurt), and set `SHMI_SECRET`.
  - In production the server refuses to start without either `SHMI_SECRET` or `SHMI_SECRET_FILE`/`DATA_DIR`.

The managed Postgres must allow:

- the role in `DATABASE_URL` to run `CREATE DATABASE`, because every company is a new database;
- connections to those new databases with the same host and credentials.

On Neon, use a role created in the console (those may create databases) and the direct, non-pooled host. Add `?sslmode=require` to the URL. Each open company keeps up to `PG_POOL_MAX` connections (default 5), so watch the plan's connection limit.

Back up with the provider's point-in-time restore, plus a periodic `pg_dump` of every database. `deploy/backup/backup.sh` works against any server with `PGHOST`/`PGUSER`/`PGPASSWORD` set.

## (c) Any Node.js host (VM, systemd, a PaaS)

Requirements:

- Node.js **22 or newer**;
- a persistent directory, or PostgreSQL 14 or newer (tested on 17);
- a reverse proxy for HTTPS.

```bash
pnpm release:bundle                       # on the build machine (Node 26, pnpm)
rsync -a release/ server:/opt/shmelta/    # the folder is self-contained
```

`/etc/systemd/system/shmelta.service`:

```ini
[Unit]
Description=Shmicroinvest Shmelta Pro
After=network-online.target postgresql.service

[Service]
User=shmelta
WorkingDirectory=/opt/shmelta
EnvironmentFile=/etc/shmelta.env          # NODE_ENV=production, DATABASE_URL or DATA_DIR, SHMI_SECRET, TRUST_PROXY=1 …
ExecStart=/usr/bin/node --enable-source-maps server.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/shmelta

[Install]
WantedBy=multi-user.target
```

nginx in front (Caddy works with the `deploy/Caddyfile`):

```nginx
server {
  listen 443 ssl http2;
  server_name shmelta.example.bg;
  # ssl_certificate …;
  client_max_body_size 110m;              # uploads: MAX_UPLOAD_MB (100) plus some room
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 600s;
  }
}
```

With PGlite (`DATA_DIR=/var/lib/shmelta`), run **one** process only, because PGlite has no shared access. To back up, stop the service and copy `DATA_DIR`, or use the program's own "Архивиране" and download the files. With Postgres, use `deploy/backup/backup.sh` from cron:

```cron
30 2 * * * PGHOST=localhost PGUSER=postgres PGPASSWORD=… BACKUP_DIR=/var/backups/shmelta /opt/shmelta-deploy/backup.sh
```

## First run

1. Choose the setup token.
   - Either set `SHMI_SETUP_TOKEN` to a random value (`openssl rand -base64 24`).
   - Or leave it unset. With `NODE_ENV=production`, the server then generates one and prints it at start: `Първо стартиране: ключ за инсталация (SHMI_SETUP_TOKEN) …` (`docker compose logs app`).

   Outside production no token is needed unless one is set.
2. Open the site. While the server has no company, the login screen shows "Създаване на първата фирма" with the field **Ключ за инсталация**. Enter the token, the company name, EIK, the financial year and the administrator's password.
   - Wrong tokens count towards the per-IP limit.
   - After the first company exists, the token is no longer used. Further companies are created only by a logged-in user with the "Нова фирма" right.
3. Log in as the administrator. Then:
   - set a strong password (the GDPR check, "Други → GDPR проверка", lists what is missing);
   - create the users and their roles;
   - configure SMTP ("Настройки → E-mail").
4. Check that `https://…/api/health` reports the expected version.

## Security notes

- **Cookies.** The session cookie is `HttpOnly` and `SameSite=Lax`. It is `Secure` over HTTPS, and behind a proxy only with `TRUST_PROXY=1`.
- **Session expiry.** A session ends after `SESSION_IDLE_MINUTES` without use (default 12 h) and at the latest `SESSION_MAX_AGE_DAYS` after the login (default 14).
- **Headers.** Every response carries:
  - a Content-Security-Policy that allows scripts only from the server and `frame-ancestors 'none'`;
  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: same-origin`;
  - a `Permissions-Policy` that allows the camera only for the document scanner;
  - HSTS over HTTPS.
- **Body limits.** Requests are limited to 4 MB, and file uploads (imports, bank statements, backups, attachments) to 100 MB. Larger requests get 413.
- **Login limits.** After `LOGIN_IP_MAX_FAILURES` (20) failed logins or setup tokens from one IP within 15 minutes, that address gets 429. This is in addition to the per-user lockout (every third failure, a pause that doubles up to 15 minutes).
- **Errors.** Error responses never include stack traces. The details go to the server log and the application log.
- **The login screen is public.** As in Delta, it lists the company names and their users before login. To keep a deployment private, restrict access in the proxy with an IP allow-list or basic auth in front of the site, for example in Caddy with `@office remote_ip …`.
- **Don't put plain HTTP on the internet.** With `TRUST_PROXY=0` the `X-Forwarded-*` headers are ignored, so that a client cannot fake its IP or HTTPS.

## Settings

Every setting is an environment variable, and all are optional unless marked otherwise. They are also listed in `.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | – | `production` requires a setup token for the first company and a persistent secret, and keeps logs short. Always set it on a server. |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Listen address |
| `TRUST_PROXY` | `0` | `1` behind a reverse proxy that terminates HTTPS. `X-Forwarded-Proto` then makes the cookie `Secure` and turns on HSTS, and the last `X-Forwarded-For` entry is the client IP. |
| `DATABASE_URL` | – | Postgres URL of the catalog database. Company databases are created on the same server, so the role needs `CREATEDB`. Without it, PGlite is used. |
| `DATA_DIR` | `apps/server/.data` (sources), `data/` beside `server.js` (bundle) | PGlite data, the default `secret.key` and `shmelta.log`. Must be persistent. |
| `PG_POOL_MAX` | `5` | Postgres connections per company database |
| `PGPASSWORD` | – | Used when `DATABASE_URL` has no password |
| `SHMI_SECRET` | – | The key for stored SMTP passwords. **Production: this or a persistent `SHMI_SECRET_FILE`/`DATA_DIR` is required.** |
| `SHMI_SECRET_FILE` | `<DATA_DIR>/secret.key` | The key file used without `SHMI_SECRET`. It is created on first start. |
| `SHMI_SETUP_TOKEN` | – (generated in production) | The token needed to create the first company |
| `SESSION_IDLE_MINUTES` | `720` | Idle timeout of a session |
| `SESSION_MAX_AGE_DAYS` | `14` | Absolute lifetime of a session, which is also the cookie `Max-Age` |
| `LOGIN_IP_MAX_FAILURES` | `20` | Failed logins or setup tokens per IP before 429 |
| `LOGIN_IP_WINDOW_MINUTES` | `15` | The window of that limit |
| `MAX_JSON_BODY_MB` | `4` | Body limit of ordinary requests |
| `MAX_UPLOAD_MB` | `100` | Body limit of file uploads |
| `APP_LOG` | `<DATA_DIR>/shmelta.log` with PGlite, none with Postgres | The application log file ("Дневник на приложението") |
| `MAIL_TRANSPORT` | – | `json` logs e-mails instead of sending them (tests, demos) |
| `TZ_COMPANY` | `Europe/Sofia` | Time zone of the working date and of printed times |
| `VIES_URL` | EU VIES REST endpoint | VAT number check |
| `ECB_RATES_URL` | ECB 90-day XML | Exchange rates for revaluation |
| `WEB_DIST` | `web/` (bundle), `apps/web/dist` (sources) | Folder of the UI |
| `SHMI_BACKUP_S3_BUCKET` | – | Bucket of the off-site backups (S3-compatible). Without it they are off. |
| `SHMI_BACKUP_S3_ENDPOINT` | AWS for the region | Storage endpoint, e.g. `https://fsn1.your-objectstorage.com` |
| `SHMI_BACKUP_S3_REGION` | `us-east-1` | Signing region |
| `SHMI_BACKUP_S3_ACCESS_KEY`, `SHMI_BACKUP_S3_SECRET_KEY` | – | Credentials (or the secret in `SHMI_BACKUP_S3_SECRET_KEY_FILE`) |
| `SHMI_BACKUP_S3_PATH_STYLE` | path-style except `*.amazonaws.com` | `true`/`false` |
| `SHMI_BACKUP_PREFIX` | `shmelta/` | Key prefix: `<prefix><database>/<file>.zip` |
| `SHMI_BACKUP_SCHEDULE` | `daily 02:00` | Times of the run of every company (`TZ_COMPANY`), or `off` |
| `SHMI_BACKUP_KEEP` | `14` | Archives kept per company |
| `SHMI_BACKUP_ZIP_PASSWORD` | – | Password of the uploaded ZIPs |
| `SHMI_BACKUP_TIMEOUT_MS` | `60000` | Timeout of one storage request |

Test-only variables:

- `TEST_DATABASE_URL`: the API tests on a Postgres server;
- `E2E_DATABASE_URL`, `E2E_PORT`: the e2e suite on Postgres and its port;
- `SHMI_TEST_SLOTS`: the machine-wide test slots.
