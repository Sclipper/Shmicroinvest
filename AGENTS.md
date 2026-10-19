# Working on Shmicroinvest Shmelta Pro

A web rebuild of Microinvest Delta Pro 1.01.089. The functional spec lives at `.amp/in/spec/DeltaPro-DeepSpec.md` (local, not committed). Section numbers such as "02b 9" refer to it.

## Conventions

- **TypeScript runs natively on Node 26.** Use `.ts`/`.tsx` extensions in imports. No enums, namespaces or parameter properties (`erasableSyntaxOnly`).
- **Domain rules:** pure rules (calculations, validation, file formats) go in `packages/core/src`, exported from `index.ts`, with unit tests in `packages/core/test`.
- **Server:** `apps/server`, Hono + Drizzle.
  - Tables go in `src/db/company/schema/*.ts` and are re-exported from `schema/index.ts`.
  - After a schema change, delete `src/db/company/migrations` and run `pnpm --filter @shmi/server db:generate`. Migrations are regenerated freely until the first release.
  - Services live in `src/services`. Routes live in `src/routes` and are mounted in `src/app.ts`.
  - Use `zValidator` from `src/lib/validate.ts`, `ApiError` from `src/lib/errors.ts`, and `requirePermission('<key>')` with the permission keys in `packages/core/src/seeds/permissions.ts`.
  - Raw SQL goes through `exec(db, sql\`...\`)` / `queryRows`. In correlated subqueries, qualify columns with the table name in plain text; drizzle renders `${table.col}` unqualified.
  - Money is `numeric(19,6)` in the database and `decimal.js` in code (`dec`, `round2`). Never use JS floats for money.
  - User-facing messages are in Bulgarian and match the spec's texts (with their keys).
- **Web:** `apps/web`, React 19, TanStack Query and Tailwind 4.
  - Screens are `ScreenDef`s registered in `src/registry*.tsx` and reached from `src/shell/menu.ts`.
  - Reuse `components/ui.tsx`, `components/pickers.tsx` and `components/dialogs.tsx`, and match the dense desktop style of the existing screens.
- **Euro:** from 2026 the base currency is EUR. The BGN chart is used for years up to 2025 and the EUR chart from 2026. Convert at 1.95583.

## Tests (every feature needs them)

- **Core unit tests:** `pnpm --filter @shmi/core test`.
- **API integration tests:** `pnpm --filter @shmi/server test`. Use `test/helpers.ts` → `createTestCompany()` (in-memory PGlite, logged-in admin). It provides `call`, `acc('411')`, `partner()` and `post({ date, dr: [['411', 120]], cr: [...] })`. Use one test file per module.
- **End-to-end UI tests:** `pnpm test:e2e` (Playwright, `e2e/tests/*.spec.ts`). For one spec, run `cd e2e && npx playwright test tests/<name>.spec.ts`; `pnpm test:e2e -- <spec>` runs them all. The run builds the web app and starts a fresh server on port 4310, or `E2E_PORT`. Helpers are in `e2e/tests/fixtures.ts` (`openApp`, `menu`, `activeTab`, `api`, `accountId`).
- Run `pnpm -r typecheck` before committing.
