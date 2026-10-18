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

## Accounting rules worth knowing

- From 2026 the base currency is the euro. A company keeps two charts of accounts: the BGN chart for years up to 2025 and the EUR chart from 2026. Amounts in BGN are converted at the fixed rate 1.95583 when they are reported in EUR.
- A journal entry can be 1:n or n:1. Each debit/credit pair is stored as two mirrored legs.
- An entry can only be posted into the active year and only into an unlocked month.

## Tests

```bash
pnpm -r test        # core unit tests + API integration tests (in-memory PGlite)
pnpm -r typecheck
```
