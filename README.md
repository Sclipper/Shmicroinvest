# Shmicroinvest Shmelta Pro (Шмикроинвест Шмелта Про)

A web rebuild of Microinvest Delta Pro (v1.1.89), the Bulgarian double-entry accounting program. The UI is in Bulgarian and keeps Delta's desktop workflow: the main menu, the toolbar, keyboard shortcuts (F2, Ctrl+F2, Ctrl+P, Ctrl+H, Ctrl+Y, Alt+O…), and windows kept as tabs.

## Layout

| Path | What |
|---|---|
| `packages/core` | Pure domain logic: money rounding, the journal leg model and entry validation, the nested-set chart, month locks, validators (EIK, EGN, ЛНЧ, IBAN), amount in words, seed data |
| `apps/server` | Hono API on Drizzle ORM. Each company is a separate Postgres database, plus a catalog database that also holds sessions. Embedded PGlite is used by default; set `DATABASE_URL` to use a real Postgres server. |
| `apps/web` | React 19, Vite, TanStack Query and Tailwind 4 |

## Run

```bash
pnpm install
pnpm --filter @shmi/server dev   # API on :3000; data in apps/server/.data
pnpm --filter @shmi/web dev      # UI on :5173; proxies /api
```

The first visit asks you to create the first company and its administrator. After that, only a logged-in user with the "Нова фирма" permission can create more companies.

To run in production, build the UI with `pnpm --filter @shmi/web build`, then run `pnpm --filter @shmi/server start`. The server serves `apps/web/dist`.

### Off-site backups

Delta's cloud archive is replaced by S3-compatible object storage (AWS S3, Hetzner Object Storage, Backblaze B2, MinIO, Garage, SeaweedFS). When a bucket is configured, every company is backed up daily as a ZIP of its backup file, "Архивиране на фирма" offers to upload the new archive, and administrators see the remote archives in "Възстановяване на фирма" and can restore one.

| Variable | Meaning |
|---|---|
| `SHMI_BACKUP_S3_BUCKET` | Bucket; without it off-site backups are off |
| `SHMI_BACKUP_S3_ENDPOINT` | e.g. `https://fsn1.your-objectstorage.com`, `https://s3.eu-central-003.backblazeb2.com`, `http://127.0.0.1:9000`; default AWS for the region |
| `SHMI_BACKUP_S3_REGION` | Default `us-east-1` |
| `SHMI_BACKUP_S3_ACCESS_KEY`, `SHMI_BACKUP_S3_SECRET_KEY` (or `SHMI_BACKUP_S3_SECRET_KEY_FILE`) | Credentials |
| `SHMI_BACKUP_S3_PATH_STYLE` | `true`/`false`; default path-style except on `*.amazonaws.com` |
| `SHMI_BACKUP_PREFIX` | Key prefix, default `shmelta/`; archives go to `<prefix><database>/<file>.zip` |
| `SHMI_BACKUP_SCHEDULE` | `daily 02:00` (default, company time zone), several times `02:00,14:00`, or `off` |
| `SHMI_BACKUP_KEEP` | Archives kept per company after each upload, default 14 (Delta keeps 2) |
| `SHMI_BACKUP_ZIP_PASSWORD` | Password of the uploaded ZIPs (a user's own ZIP password is used for the uploads that user starts) |

## What it covers

The main menu follows Delta Pro (06 1.3); every item opens a working screen.

- **Ledger:** entries (1:n / n:1, currency lines, quantities, VAT terms, ICA, binding of documents and automatic payment), fast entry, templates and template schedules, mass edit, reordering of documents, entry requests, initial balances and correspondences.
- **Chart of accounts:** commercial, ЮЛНЦ and budget templates, the BGN/EUR charts and conversion to euro (accounts, openings per document, fixed assets, templates, reschedules).
- **Modules:** payments and open items, inventory (FIFO/average, write-off), fixed assets (accounting and tax plans, depreciation, revaluation, Excel import), deferrals, cash book and orders, payment documents for every bank form.
- **VAT:** purchase/sales journals, declaration and VIES files for NRA, the art. 73 coefficient, art. 117 protocols, VAT closing, the registration turnover check.
- **Year end:** closing of income/expense accounts, automatic closing, revaluation, closing of documents, conclusion and opening of the next year.
- **Reports:** turnover, chronological and analytical registers, general ledger, partner reports, inventory and asset books, financial statements, user activities and a user-defined report manager. Every report prints, exports to PDF, Word and Excel, and can be e-mailed as a PDF or Excel attachment.
- **Exchange:** import from text, Excel, XML, VAT journals, ТРЗ Pro and Microinvest Delta; bank statements (MT940, camt.053, Excel, per-bank XML and the HTML exports of seven banks) with rules and document binding; XML export and exports to external systems; backup and restore, with daily off-site copies in S3-compatible storage.
- **Administration:** users, roles with Delta's permission tree (denied menu items are hidden), escalating login lockout, the application log, settings and SMTP, and Delta's nine skins ("Визуален стил", per user).
- **Attachments:** files on entries, and scanned pages taken with the camera ("Сканиране на документ").

## Accounting rules worth knowing

- From 2026 the base currency is the euro. A company keeps two charts of accounts: the BGN chart for years up to 2025 and the EUR chart from 2026. Amounts in BGN are converted at the fixed rate 1.95583 when they are reported in EUR.
- A journal entry can be 1:n or n:1. Each debit/credit pair is stored as two mirrored legs.
- An entry can only be posted into the active year and only into an unlocked month.

## Tests

```bash
pnpm -r test        # core unit tests + API integration tests (in-memory PGlite)
pnpm -r typecheck
pnpm test:e2e       # Playwright: builds the UI and starts a fresh server on :4310 (E2E_PORT)
```

The e2e suite includes a smoke test that opens every menu screen and runs every report with its default filter.

The Microinvest Delta conversion has a pilot (`apps/server/test/deltaPilot.test.ts`): a synthetic legacy company over 2024-2025 (VAT sales and purchases, currencies, materials, fixed assets, payments, year-end closing) is converted, and the totals computed from the legacy tables are compared with the trial balance, the VAT diaries, the partner balances and the 2026 euro openings. The default run is a small regression version; `DELTA_PILOT=full pnpm --filter @shmi/server exec vitest run test/deltaPilot.test.ts` runs the large one (400 partners, about 20 000 turnover rows, about 2 minutes).

## Known limitations

- Some Bulgarian texts have no wording in the spec; those were written for this project.
- Online services (ECB rates and VIES) are called directly. When a service is down the screens say so; they don't fall back to a guessed value.
- The Fibank movements XML and the payment intermediaries' IBAN lists aren't included. The default per-bank import rules were rebuilt from the spec.
- Bank-statement import binds payments only to open documents of the active year. Unpaid invoices of the previous year are offered once its balances are carried into the new year as openings per document.
- The commercial and ЮЛНЦ chart templates were renumbered to match Delta's statement formulas (203 сгради, 206 машини, 241/n = depreciation of 20n). Each company stores the template version of its chart (`ChartTemplateVersion`; older companies are recognised by their accounts): F4 and "Избор на сметкоплан" offer the accounts of that version, and an older company's 2026 EUR chart is a copy of its BGN chart, so balances are converted to accounts of the same meaning. The statement formulas follow the new numbering, so an older company's balance-sheet rows for groups 20, 21 and 24 need their formulas adjusted in "Отчети и баланс".
