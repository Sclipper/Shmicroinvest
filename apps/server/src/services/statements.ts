import { asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  BGN_PER_EUR, EURO_CHANGEOVER_DATE, FormulaCalculator, STATEMENTS, STATEMENT_CHECKS, STATEMENT_COLUMNS, buildStatementSeed, dec, formatCheckMessage,
  round2, statementByCode, statementLayout, statementOfKey, statementPeriods, statementUnit, toThousands, validateFormula,
  type DateWindow, type Dec, type FormulaDataSet, type FormulaIssue, type FormulaPeriod, type LayoutRow, type StatementCode,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { exec, type DbOrTx } from '../db/provider.ts';
import { ApiError } from '../lib/errors.ts';
import { fixIdentity } from './companySetup.ts';
import { getConfig } from './config.ts';

/**
 * Financial statements ("Отчети и баланс", spec 05 section 9): seeding of the
 * statement definitions, the figures the formula engine reads, statement runs
 * and the cross-statement verification.
 */

/* ------------------------------------------------------------------ */
/* Seeding and editing                                                 */
/* ------------------------------------------------------------------ */

/** Seeds StatementReportRows/Columns/Formulas (Appendix A) including the id-0 sentinels. */
export async function seedStatements(db: DbOrTx) {
  const seed = buildStatementSeed();
  await db.insert(s.statementReportRows).values([
    { id: 0, identifier: '', description: 'Невъведен ред', order: 0 },
    ...seed.rows.map((r, i) => ({ id: i + 1, identifier: r.identifier, description: r.description, order: r.order })),
  ]);
  await db.insert(s.statementReportColumns).values([
    { id: 0, identifier: '', description: 'Невъведена колона', order: 0 },
    ...seed.columns.map((c, i) => ({ id: i + 1, identifier: c.identifier, description: c.description, order: c.order })),
  ]);
  const rowId = new Map(seed.rows.map((r, i) => [r.identifier, i + 1]));
  const colId = new Map(seed.columns.map((c, i) => [c.identifier, i + 1]));
  const values = seed.formulas.map((f, i) => ({
    id: i + 1, key: f.key, statementReportRowId: rowId.get(f.rowIdentifier)!, statementReportColumnId: colId.get(f.columnIdentifier)!,
    formula: f.formula, defaultFormula: f.formula, valueLastPeriod: '0', position: f.position,
  }));
  for (let i = 0; i < values.length; i += 300) await db.insert(s.statementFormulas).values(values.slice(i, i + 300));
  for (const t of ['statement_report_rows', 'statement_report_columns', 'statement_formulas']) await fixIdentity(db, t);
}

/** Company databases created before this module get the seed on first use. */
export async function ensureStatementsSeeded(db: DbOrTx) {
  const [{ n }] = (await exec(db, sql`SELECT count(*)::int AS n FROM statement_formulas`)).rows as [{ n: number }];
  if (n === 0) await seedStatements(db);
}

export interface StatementFormulaRow {
  id: number;
  key: string;
  statement: StatementCode;
  rowIdentifier: string;
  rowDescription: string;
  rowOrder: number;
  columnIdentifier: string;
  columnDescription: string;
  formula: string;
  defaultFormula: string;
  valueLastPeriod: string;
  position: number;
}

export async function loadStatementFormulas(db: DbOrTx): Promise<StatementFormulaRow[]> {
  await ensureStatementsSeeded(db);
  const rows = await db
    .select({
      id: s.statementFormulas.id, key: s.statementFormulas.key, formula: s.statementFormulas.formula, defaultFormula: s.statementFormulas.defaultFormula,
      valueLastPeriod: s.statementFormulas.valueLastPeriod, position: s.statementFormulas.position,
      rowIdentifier: s.statementReportRows.identifier, rowDescription: s.statementReportRows.description, rowOrder: s.statementReportRows.order,
      columnIdentifier: s.statementReportColumns.identifier, columnDescription: s.statementReportColumns.description,
    })
    .from(s.statementFormulas)
    .innerJoin(s.statementReportRows, eq(s.statementReportRows.id, s.statementFormulas.statementReportRowId))
    .innerJoin(s.statementReportColumns, eq(s.statementReportColumns.id, s.statementFormulas.statementReportColumnId))
    .orderBy(asc(s.statementFormulas.position));
  return rows.map((r) => ({ ...r, statement: statementOfKey(r.key)?.code ?? 'cr', valueLastPeriod: dec(r.valueLastPeriod).toFixed(2) }));
}

export interface FormulaEdit {
  id: number;
  formula?: string;
  valueLastPeriod?: string;
}

/** Saves edited cells after validating every formula (syntax and references). */
export async function saveStatementFormulas(db: DbOrTx, edits: FormulaEdit[]) {
  const all = await loadStatementFormulas(db);
  const byId = new Map(all.map((f) => [f.id, f]));
  const keys = new Set(all.map((f) => f.key.toLowerCase()));
  const messages = [];
  for (const e of edits) {
    const f = byId.get(e.id);
    if (!f) throw new ApiError(404, 'Формулата не е намерена.');
    if (e.formula !== undefined) {
      const err = validateFormula(e.formula, (k) => keys.has(k));
      if (err) messages.push({ key: f.key, text: `${f.key} (${f.rowDescription}): ${err}`, severity: 'critical' as const });
    }
  }
  if (messages.length) throw new ApiError(422, 'Има грешки във формулите.', messages);
  for (const e of edits) {
    const patch: Partial<typeof s.statementFormulas.$inferInsert> = {};
    if (e.formula !== undefined) patch.formula = e.formula.trim();
    if (e.valueLastPeriod !== undefined) patch.valueLastPeriod = dec(e.valueLastPeriod).toFixed(6);
    if (Object.keys(patch).length) await db.update(s.statementFormulas).set(patch).where(eq(s.statementFormulas.id, e.id));
  }
  return { saved: edits.length };
}

/** "Възстановяване" / "Възстановяване на всички": Formula := DefaultFormula. */
export async function restoreStatementFormulas(db: DbOrTx, o: { ids?: number[]; statement?: StatementCode }) {
  await ensureStatementsSeeded(db);
  if (o.ids?.length) {
    await db.update(s.statementFormulas).set({ formula: sql`${s.statementFormulas.defaultFormula}` }).where(inArray(s.statementFormulas.id, o.ids));
    return;
  }
  const def = o.statement ? statementByCode(o.statement) : undefined;
  if (o.statement && !def) throw new ApiError(400, 'Непознат отчет.');
  const all = await loadStatementFormulas(db);
  const ids = all.filter((f) => !def || f.statement === def.code).map((f) => f.id);
  if (ids.length) await db.update(s.statementFormulas).set({ formula: sql`${s.statementFormulas.defaultFormula}` }).where(inArray(s.statementFormulas.id, ids));
}

/* ------------------------------------------------------------------ */
/* Figures read by the formula engine (GetAccountTurnovers, 9.5)       */
/* ------------------------------------------------------------------ */

export type ValueFamily = 'amount' | 'currency' | 'quantity';

export interface DataOptions {
  family?: ValueFamily;
  /** Extra restriction of the accountings (user-report filter formulas). */
  filter?: SQL;
  monthMode?: boolean;
}

async function fyOf(db: DbOrTx, year: number) {
  const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.year, year));
  return fy;
}

/**
 * Per posting account (merged by number across both charts, no mapped-account
 * re-attribution): opening = initial-balance accountings of the financial year
 * of the start + postings dated before the start; turnover = the window.
 * Initial correspondences are excluded. With an end on/after 2026, amounts
 * dated before 2026 are divided by 1.95583 (fAccountTurnovers).
 */
export async function loadFormulaData(db: DbOrTx, w: DateWindow, o: DataOptions = {}): Promise<FormulaDataSet> {
  const fy = await fyOf(db, Number(w.start.slice(0, 4)));
  const family = o.family ?? 'amount';
  const convert = family === 'amount' && w.end >= EURO_CHANGEOVER_DATE;
  const factor = convert ? sql`CASE WHEN a.accounting_date < ${EURO_CHANGEOVER_DATE} THEN ${sql.raw(BGN_PER_EUR.toString())} ELSE 1 END` : sql`1`;
  const debit = family === 'amount' ? sql`d.amount` : family === 'currency' ? sql`CASE WHEN d.sign = 1 THEN coalesce(d.currency_amount, 0) ELSE 0 END` : sql`CASE WHEN d.sign = 1 THEN coalesce(d.quantity, 0) ELSE 0 END`;
  const credit = family === 'amount' ? sql`d.ref_amount` : family === 'currency' ? sql`CASE WHEN d.sign = -1 THEN coalesce(d.currency_amount, 0) ELSE 0 END` : sql`CASE WHEN d.sign = -1 THEN coalesce(d.quantity, 0) ELSE 0 END`;
  const opening = sql`(a.is_initial_balance OR a.accounting_date < ${w.start})`;
  const yearFilter = fy ? sql`a.financial_year_id = ${fy.id}` : sql`a.accounting_date >= ${w.start}`;
  const extra = o.filter ? sql`AND ${o.filter}` : sql``;
  const acc = await exec(db, sql`
    SELECT ac.number,
      SUM(CASE WHEN ${opening} THEN ${debit} / ${factor} ELSE 0 END) AS od,
      SUM(CASE WHEN ${opening} THEN ${credit} / ${factor} ELSE 0 END) AS oc,
      SUM(CASE WHEN NOT ${opening} THEN ${debit} / ${factor} ELSE 0 END) AS dt,
      SUM(CASE WHEN NOT ${opening} THEN ${credit} / ${factor} ELSE 0 END) AS ct
    FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id JOIN accounts ac ON ac.id = d.account_id
    WHERE ${yearFilter} AND a.accounting_date <= ${w.end}
      AND NOT (a.is_initial_balance AND a.is_initial_correspondence) ${extra}
    GROUP BY ac.number`);
  const corrAmount = family === 'amount' ? sql`d.amount / ${factor}` : family === 'currency' ? sql`coalesce(d.currency_amount, 0)` : sql`coalesce(d.quantity, 0)`;
  const corr = await exec(db, sql`
    SELECT da.number AS debit, ca.number AS credit, SUM(${corrAmount}) AS amount
    FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id
      JOIN accounts da ON da.id = d.account_id JOIN accounts ca ON ca.id = d.ref_account_id
    WHERE d.sign = 1 AND NOT a.is_initial_balance AND a.accounting_date >= ${w.start} AND a.accounting_date <= ${w.end} ${extra}
    GROUP BY da.number, ca.number`);
  return {
    accounts: (acc.rows as { number: string; od: string; oc: string; dt: string; ct: string }[]).map((r) => ({ number: r.number, od: r.od, oc: r.oc, dt: r.dt, ct: r.ct })),
    correspondences: (corr.rows as { debit: string; credit: string; amount: string }[]),
    monthMode: o.monthMode,
  };
}

/* ------------------------------------------------------------------ */
/* Statement run                                                       */
/* ------------------------------------------------------------------ */

export interface StatementRunOptions {
  startDate: string;
  endDate: string;
  /** Statements to compute; empty = all. */
  statements?: StatementCode[];
  thousands?: boolean;
  usePreviousPeriodValues?: boolean;
  sameIntervalPreviousYear?: boolean;
  /** NSI (statistics) format: the NSI columns of СДА are included. */
  nsi?: boolean;
}

/** Calculator over the statement cells for a run. */
export async function statementCalculator(db: DbOrTx, o: StatementRunOptions, extraFormulas: Record<string, string> = {}, data: DataOptions = {}) {
  const formulas = await loadStatementFormulas(db);
  const years = await db.select().from(s.financialYears);
  const fyStart = (y: number) => years.find((f) => f.year === y)?.startDate ?? null;
  const periods = statementPeriods({ start: o.startDate, end: o.endDate, sameIntervalPreviousYear: o.sameIntervalPreviousYear, fyStart });
  const separator = (await getConfig(db, 'AccountsSeparator')) ?? '/';
  const cache = new Map<FormulaPeriod, FormulaDataSet>();
  const sets = { cp: await loadFormulaData(db, periods.cp, data), ep: await loadFormulaData(db, periods.ep, data) };
  for (const p of ['cp', 'ep'] as const) cache.set(p, sets[p]);
  const calc = new FormulaCalculator({
    formulas: { ...Object.fromEntries(formulas.map((f) => [f.key, f.formula])), ...extraFormulas },
    data: (p) => cache.get(p)!,
    lastPeriodValues: Object.fromEntries(formulas.map((f) => [f.key, f.valueLastPeriod])),
    usePreviousPeriodValues: o.usePreviousPeriodValues,
    convertPrevious: periods.convertPrevious,
    separator,
  });
  return { calc, formulas, periods };
}

export interface StatementCellValue {
  key: string;
  cp: string;
  ep: string | null;
}

export interface StatementResult {
  code: StatementCode;
  name: string;
  title: string;
  columns: { identifier: string; description: string }[];
  rows: (Omit<LayoutRow, 'cells'> & { cells: Record<string, StatementCellValue> })[];
}

const WITH_PREVIOUS: StatementCode[] = ['balance', 'opr', 'opp'];

export async function runStatements(db: DbOrTx, o: StatementRunOptions) {
  const { calc, formulas, periods } = await statementCalculator(db, o);
  const codes = o.statements?.length ? o.statements : STATEMENTS.map((x) => x.code);
  const fmt = (v: Dec) => (o.thousands ? toThousands(v).toFixed(0) : v.toFixed(2));
  const out: StatementResult[] = [];
  for (const code of codes) {
    const def = statementByCode(code);
    if (!def) throw new ApiError(400, 'Непознат отчет.');
    const columns = STATEMENT_COLUMNS.filter((c) => c.statement === code && (o.nsi || !c.nsi));
    const colSet = new Set(columns.map((c) => c.identifier));
    const mine = formulas.filter((f) => f.statement === code && colSet.has(f.columnIdentifier));
    const rowsById = new Map<string, { identifier: string; description: string; order: number }>();
    for (const f of formulas.filter((x) => x.statement === code)) rowsById.set(f.rowIdentifier, { identifier: f.rowIdentifier, description: f.rowDescription, order: f.rowOrder });
    const layout = statementLayout(code, [...rowsById.values()], mine);
    const withPrev = WITH_PREVIOUS.includes(code);
    out.push({
      code, name: def.name, title: def.title,
      columns: columns.map((c) => ({ identifier: c.identifier, description: c.description })),
      rows: layout.filter((r) => Object.keys(r.cells).length > 0).map((r) => ({
        ...r,
        cells: Object.fromEntries(Object.entries(r.cells).map(([col, c]) => [col, { key: c.key, cp: fmt(calc.cell(c.key, 'cp')), ep: withPrev ? fmt(calc.cell(c.key, 'ep')) : null }])),
      })),
    });
  }
  const endYear = Number(o.endDate.slice(0, 4));
  return {
    periods,
    unit: statementUnit(endYear, Boolean(o.thousands)),
    thousands: Boolean(o.thousands),
    statements: out,
    issues: calc.issues as FormulaIssue[],
  };
}

/** Cross-statement verification (9.8). */
export async function verifyStatements(db: DbOrTx, o: StatementRunOptions & { balanceOnly?: boolean }) {
  const { calc } = await statementCalculator(db, o);
  const unit = statementUnit(Number(o.endDate.slice(0, 4)), Boolean(o.thousands));
  const checks = STATEMENT_CHECKS.filter((c) => !o.balanceOnly || c.balanceOnly).map((c) => {
    let last: Dec = dec(0);
    let ok = false;
    for (const f of c.formulas) {
      last = round2(calc.expression(f, 'cp'));
      if (last.isZero()) {
        ok = true;
        break;
      }
    }
    const diff = last.abs();
    const shown = o.thousands ? toThousands(diff).toFixed(0) : diff.toFixed(2);
    return { id: c.id, formulas: c.formulas, ok, severity: c.severity, difference: shown, message: ok ? null : formatCheckMessage(c.message, shown, unit) };
  });
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    message: failed.length === 0 ? 'Данните са попълнени коректно.' : `Открити несъответствия: ${failed.length}.`,
    checks,
    issues: calc.issues,
  };
}
