# Changelog

All notable changes to Shmicroinvest Shmelta Pro. Versions follow [Semantic Versioning](https://semver.org/). From 1.0.0 on, released database migrations are never changed: a schema change ships as a new migration, which runs on start.

## Unreleased

- **Free registration.** Anybody can create a company with its own administrator from the login screen (**Нова фирма**). No setup token is generated in production any more; set `SHMI_SETUP_TOKEN` to require a key for every registration.

## 1.0.0 – 2026-10-19

First production release: a web rebuild of Microinvest Delta Pro 1.01.089 for Bulgarian double-entry accounting, with Delta's menus, toolbar, keyboard shortcuts and windows as tabs, in Bulgarian.

### Accounting

- **Ledger.** Entries can be 1:n or n:1, with:
  - currency lines and quantities;
  - VAT terms and ICA;
  - binding of documents and automatic payment.

  Also:
  - fast entry;
  - templates and template schedules;
  - mass edit and reordering of documents;
  - entry requests and reversals;
  - initial balances and correspondences;
  - attachments, including pages scanned with the camera.
- **Chart of accounts.** Commercial, ЮЛНЦ and budget templates. The BGN chart is used up to 2025 and the EUR chart from 2026 (the base currency is the euro from 2026, at 1.95583). Conversion to euro covers accounts, openings per document, fixed assets, templates and reschedules.
- **Modules.**
  - payments and open items;
  - inventory (FIFO and average cost, write-off);
  - fixed assets: accounting and tax plans, depreciation, revaluation, Excel import;
  - deferrals;
  - cash book and cash orders;
  - payment documents for every bank form.
- **VAT.**
  - purchase and sales journals;
  - the declaration and the VIES files for the NRA;
  - the art. 73 coefficient and art. 117 protocols;
  - VAT closing and the registration turnover check.
- **Year end.**
  - closing of income and expense accounts, and automatic closing;
  - revaluation;
  - closing of documents;
  - conclusion of the year and opening of the next.
- **Reports.**
  - turnover, chronological and analytical registers, and the general ledger;
  - partner reports;
  - inventory and asset books;
  - financial statements (including the micro-enterprise and NSI formats);
  - user activities and a user-defined report manager.

  Every report prints, exports to PDF, Word and Excel, and can be e-mailed.
- **Exchange.**
  - imports from text, Excel, XML, VAT journals, ТРЗ Pro and Microinvest Delta;
  - bank statements (MT940, camt.053, Excel, per-bank XML and the HTML exports of seven banks), with rules and document binding;
  - XML export and exports to external systems;
  - backup and restore of a company.
- **Administration.**
  - users, and roles with Delta's permission tree (denied menu items are hidden);
  - escalating login lockout;
  - the application log, settings, SMTP and the GDPR check;
  - Delta's nine skins.

### Running in production

- **Release bundle.** `pnpm release:bundle` builds a self-contained `release/` of about 50 MiB: the server bundled by esbuild for Node 22+, the built UI, the migrations and the embedded PGlite. It starts with `node server.js`, and `/api/health` reports the version.
- **Docker.** A Docker image (multi-stage, non-root, `HEALTHCHECK`) and `deploy/docker-compose.yml`, which runs:
  - PostgreSQL 17;
  - Caddy with automatic HTTPS;
  - a daily backup of every database, with retention and a tested restore script.
- **Storage.** PostgreSQL mode (one database per company plus a catalog database) is tested with the full API and end-to-end suites, just like the embedded PGlite mode.
- **First-run setup token.** Creating the first company needs `SHMI_SETUP_TOKEN`, or a token generated and logged at start in production.
- **Session cookies.** They are `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS (also behind a trusted proxy with `TRUST_PROXY=1`). Sessions have an idle timeout and a maximum lifetime.
- **Security headers.** A Content-Security-Policy, `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and HSTS over HTTPS.
- **Limits.** Request bodies are limited per route, with larger limits for imports and backups. Failed logins are limited per IP, in addition to the per-user lockout.
- **Errors.** Error responses carry no stack traces.
- **Persistent secret.** In production the server refuses to start without a persistent secret. At start it logs where the data lives.
- **CI.** CI covers typecheck, unit tests, API tests on PGlite and on PostgreSQL 17, the web build, end-to-end tests and a smoke test of the bundle on Node 22. `pnpm ci:all` runs the same locally.
- **Migrations.** The baseline migrations of 1.0.0 are frozen and guarded by `migrations.lock.json`.
