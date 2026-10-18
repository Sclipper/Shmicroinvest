import { inArray, sql } from 'drizzle-orm';
import {
  CLOSING_MESSAGES, autoConcludeRow, concludeMode, concludeTurnover, dec, isListedConcludeRow, isModeAccount, isMonthLocked,
  matchesConcludeFilter, planClosing, round2, validateClosing, type ClosingMessage, type ConcludeMode, type ConcludeTarget,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { queryRows, type DbOrTx } from '../db/provider.ts';
import type { ActiveYear } from '../context.ts';
import { ApiError, badRequest } from '../lib/errors.ts';
import { MEMORIAL_ORDER, postSystemEntry } from './autoEntries.ts';
import { compareAccountNumbers } from './reports.ts';

/**
 * Closing of income/expense accounts (spec 02c section 3), manual and
 * automatic. Corrected variant: validation failures are reported and abort the
 * whole batch (D5), the overshoot cap never posts negative lines (D6) and
 * percent distribution requires Σ% = 100 (D7).
 */

type SaveCtx = { year: ActiveYear; userId: number; branchId?: number };

export interface AccountTurnover {
  accountId: number;
  number: string;
  description: string;
  categoryId: number | null;
  isActive: boolean | null;
  concludeAccountId: number | null;
  openingDebit: string;
  openingCredit: string;
  debitTurnover: string;
  creditTurnover: string;
}

/**
 * fAccountTurnovers for the leaf accounts of the active year's chart: rows of
 * the financial year of the period, dated <= to; an accounting is "initial"
 * when it is an opening balance or dated before `from`.
 */
export async function accountTurnovers(db: DbOrTx, year: ActiveYear, from: string, to: string, accountIds?: number[]): Promise<AccountTurnover[]> {
  const opening = sql`(a.is_initial_balance OR a.accounting_date < ${from})`;
  const idFilter = accountIds?.length ? sql`AND ac.id IN (${sql.join(accountIds.map((i) => sql`${i}`), sql`, `)})` : sql``;
  const rows = await queryRows<Record<string, unknown>>(db, sql`
    SELECT ac.id, ac.number, ac.description, ac.account_category_id, ac.is_active, ac.conclude_account_id,
      coalesce(t.od, 0) AS od, coalesce(t.oc, 0) AS oc, coalesce(t.dt, 0) AS dt, coalesce(t.ct, 0) AS ct
    FROM accounts ac
      LEFT JOIN (
        SELECT d.account_id,
          SUM(CASE WHEN ${opening} THEN d.amount ELSE 0 END) AS od,
          SUM(CASE WHEN ${opening} THEN d.ref_amount ELSE 0 END) AS oc,
          SUM(CASE WHEN NOT ${opening} THEN d.amount ELSE 0 END) AS dt,
          SUM(CASE WHEN NOT ${opening} THEN d.ref_amount ELSE 0 END) AS ct
        FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id
        WHERE a.financial_year_id = ${year.id} AND a.accounting_date <= ${to}
          AND NOT (a.is_initial_balance AND a.is_initial_correspondence)
        GROUP BY d.account_id
      ) t ON t.account_id = ac.id
    WHERE ac.is_euro = ${year.year >= 2026} AND ac.number <> '0' AND ac.right_index = ac.left_index + 1 ${idFilter}`);
  return rows.map((r) => ({
    accountId: r.id as number,
    number: r.number as string,
    description: r.description as string,
    categoryId: (r.account_category_id as number | null) ?? null,
    isActive: (r.is_active as boolean | null) ?? null,
    concludeAccountId: (r.conclude_account_id as number | null) ?? null,
    openingDebit: dec(r.od as string).toFixed(2),
    openingCredit: dec(r.oc as string).toFixed(2),
    debitTurnover: dec(r.dt as string).toFixed(2),
    creditTurnover: dec(r.ct as string).toFixed(2),
  })).sort((a, b) => compareAccountNumbers(a.number, b.number));
}

const closingError = (messages: ClosingMessage[]) => new ApiError(422, messages[0]!.text, messages.map((m) => ({ key: m.key, text: m.text, severity: m.severity })));
const critical = (key: keyof typeof CLOSING_MESSAGES) => closingError([{ key, text: CLOSING_MESSAGES[key], severity: 'critical' }]);

function checkDate(year: ActiveYear, date: string) {
  const [y, m] = date.split('-').map(Number);
  if (y !== year.year) throw critical('strWrongAccountingDate');
  if (isMonthLocked(year.lockedMonths, m!)) throw critical('strWrongAccountingMonth');
}

export interface ConcludeRow extends AccountTurnover {
  turnover: string;
  hasInitialBalance: boolean;
}

/** Source rows of a mode (hidden below 0.01), with the number filter. */
export async function concludeCandidates(db: DbOrTx, year: ActiveYear, mode: ConcludeMode, from: string, to: string, filter = ''): Promise<ConcludeRow[]> {
  const rows = await accountTurnovers(db, year, from, to);
  return rows
    .filter((r) => isModeAccount(mode, r.number, r.categoryId) && matchesConcludeFilter(r.number, filter))
    .map((r) => ({
      ...r,
      turnover: round2(concludeTurnover(mode, r.debitTurnover, r.creditTurnover)).toFixed(2),
      hasInitialBalance: !dec(r.openingDebit).minus(r.openingCredit).abs().lessThan('0.01'),
    }))
    .filter((r) => isListedConcludeRow(r.turnover));
}

export interface ManualClosingRequest {
  mode: ConcludeMode;
  from: string;
  to: string;
  sources: { accountId: number; amount: string }[];
  targets: ConcludeTarget[];
  percentDistribution: boolean;
  term?: string;
  /** Post despite warnings. */
  confirm?: boolean;
}

/** Planned entries and messages of a manual closing (no writes). */
export async function planManualClosing(db: DbOrTx, year: ActiveYear, r: ManualClosingRequest) {
  checkDate(year, r.to);
  const candidates = new Map((await concludeCandidates(db, year, r.mode, r.from, r.to)).map((c) => [c.accountId, c]));
  const sources = r.sources.map((x) => {
    const c = candidates.get(x.accountId);
    // A source outside the mode's listed accounts has no turnover to close.
    return { accountId: x.accountId, amount: x.amount, turnover: c?.turnover ?? '0', number: c?.number, hasInitialBalance: c?.hasInitialBalance };
  });
  const messages = validateClosing(r.mode, sources, r.targets, r.percentDistribution);
  const entries = messages.some((m) => m.severity === 'critical') ? [] : planClosing(r.mode, sources, r.targets, r.percentDistribution)
    .map((e) => ({ debits: e.debits.filter((l) => !l.amount.isZero()), credits: e.credits.filter((l) => !l.amount.isZero()) }))
    .filter((e) => e.debits.length && e.credits.length);
  return { messages, entries };
}

export async function postManualClosing(db: DbOrTx, ctx: SaveCtx, r: ManualClosingRequest) {
  const { messages, entries } = await planManualClosing(db, ctx.year, r);
  const criticals = messages.filter((m) => m.severity === 'critical');
  if (criticals.length) throw closingError(criticals);
  const warnings = messages.filter((m) => m.severity === 'warning');
  if (warnings.length && !r.confirm) return { posted: false as const, warnings, entries: [] };
  if (!entries.length) throw critical('strInvalidConcludeAccountsNumber');
  const term = r.term?.trim() || concludeMode(r.mode).term;
  const posted: { id: number; number: string }[] = [];
  for (const e of entries) {
    const res = await postSystemEntry(db, {
      accountingDate: r.to, documentDate: r.to, documentTypeId: MEMORIAL_ORDER, term, source: 'closing',
      debits: e.debits.map((l) => ({ accountId: l.accountId, amount: l.amount.toFixed(2) })),
      credits: e.credits.map((l) => ({ accountId: l.accountId, amount: l.amount.toFixed(2) })),
    }, ctx);
    posted.push({ id: res.id, number: res.number });
  }
  return { posted: true as const, warnings, entries: posted };
}

// ---- Automatic closing (AutoConcludeAccountsViewModel) ----

export interface AutoConcludeRow {
  accountId: number;
  number: string;
  description: string;
  isActive: boolean;
  concludeAccountId: number;
  concludeNumber: string;
  concludeDescription: string;
  debitTurnover: string;
  creditTurnover: string;
  amount: string;
  debitAccountId: number;
  creditAccountId: number;
}

export async function autoConcludeCandidates(db: DbOrTx, year: ActiveYear, from: string, to: string, filter = ''): Promise<AutoConcludeRow[]> {
  const rows = (await accountTurnovers(db, year, from, to)).filter((r) => r.isActive != null && r.concludeAccountId && matchesConcludeFilter(r.number, filter));
  const targetIds = [...new Set(rows.map((r) => r.concludeAccountId!))];
  const targets = targetIds.length
    ? await db.select({ id: s.accounts.id, number: s.accounts.number, description: s.accounts.description }).from(s.accounts).where(inArray(s.accounts.id, targetIds))
    : [];
  const byId = new Map(targets.map((t) => [t.id, t]));
  const out: AutoConcludeRow[] = [];
  for (const r of rows) {
    const plan = autoConcludeRow(r.isActive, r.debitTurnover, r.creditTurnover);
    const target = byId.get(r.concludeAccountId!);
    if (!plan || !target || round2(plan.amount).isZero()) continue;
    const id = (x: 'account' | 'conclude') => (x === 'account' ? r.accountId : target.id);
    out.push({
      accountId: r.accountId, number: r.number, description: r.description, isActive: r.isActive!,
      concludeAccountId: target.id, concludeNumber: target.number, concludeDescription: target.description,
      debitTurnover: r.debitTurnover, creditTurnover: r.creditTurnover, amount: round2(plan.amount).toFixed(2),
      debitAccountId: id(plan.debit), creditAccountId: id(plan.credit),
    });
  }
  return out;
}

/** One Мемориален ордер per row, all in the caller's transaction. */
export async function postAutoClosing(db: DbOrTx, ctx: SaveCtx, from: string, to: string, filter = '', accountIds?: number[]) {
  checkDate(ctx.year, to);
  let rows = await autoConcludeCandidates(db, ctx.year, from, to, filter);
  if (accountIds) rows = rows.filter((r) => accountIds.includes(r.accountId));
  if (!rows.length) throw badRequest(CLOSING_MESSAGES.strNothingToConclude);
  const posted: { id: number; number: string; accountId: number }[] = [];
  for (const r of rows) {
    const res = await postSystemEntry(db, {
      accountingDate: to, documentDate: to, documentTypeId: MEMORIAL_ORDER, term: CLOSING_MESSAGES.strAutoConcludeChartOfAccounts, source: 'auto-closing',
      debits: [{ accountId: r.debitAccountId, amount: r.amount }],
      credits: [{ accountId: r.creditAccountId, amount: r.amount }],
    }, ctx);
    posted.push({ id: res.id, number: res.number, accountId: r.accountId });
  }
  return { message: CLOSING_MESSAGES.strSuccessfulAutoConclude, entries: posted };
}

