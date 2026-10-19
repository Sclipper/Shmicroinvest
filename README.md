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

## What it covers

The main menu follows Delta Pro (06 1.3); every item opens a working screen.

- **Ledger:** entries (1:n / n:1, currency lines, quantities, VAT terms, ICA, binding of documents and automatic payment), fast entry, templates and template schedules, mass edit, reordering of documents, entry requests, initial balances and correspondences.
- **Chart of accounts:** commercial, ЮЛНЦ and budget templates, the BGN/EUR charts and conversion to euro (accounts, openings per document, fixed assets, templates, reschedules).
- **Modules:** payments and open items, inventory (FIFO/average, write-off), fixed assets (accounting and tax plans, depreciation, revaluation, Excel import), deferrals, cash book and orders, payment documents for every bank form.
- **VAT:** purchase/sales journals, declaration and VIES files for NRA, the art. 73 coefficient, art. 117 protocols, VAT closing, the registration turnover check.
- **Year end:** closing of income/expense accounts, automatic closing, revaluation, closing of documents, conclusion and opening of the next year.
- **Reports:** turnover, chronological and analytical registers, general ledger, partner reports, inventory and asset books, financial statements, user activities and a user-defined report manager. Every report prints (PDF through the browser print dialog), exports to Excel and can be e-mailed.
- **Exchange:** import from text, Excel, XML, VAT journals, ТРЗ Pro and Microinvest Delta; bank statements (MT940, Excel and per-bank XML) with rules and document binding; XML export and exports to external systems; backup and restore.
- **Administration:** users, roles with Delta's permission tree (denied menu items are hidden), escalating login lockout, the application log, settings and SMTP.

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

## Known limitations

- Some Bulgarian texts have no wording in the spec; those were written for this project.
- Online services (ECB rates and VIES) are called directly. When a service is down the screens say so; they don't fall back to a guessed value.
- The Fibank movements XML and the payment intermediaries' IBAN lists aren't included. The default per-bank import rules were rebuilt from the spec.
