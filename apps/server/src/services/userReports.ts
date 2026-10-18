import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { MONTH_NAMES_BG, ZERO, dec, validateFormula, type Dec } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';
import { ApiError, notFound } from '../lib/errors.ts';
import { accountRuleSql } from './reports.ts';
import { loadStatementFormulas, statementCalculator, type ValueFamily } from './statements.ts';

/**
 * User-defined reports (Мениджър потребителски справки, spec 05 section 10).
 * A report has one or two value columns, or twelve month columns; each line
 * has a value formula in the statement DSL (account functions, statement
 * cells, saved user formulas and the other lines' keys) and an optional
 * filter condition that restricts the accountings read.
 */

export const USER_REPORT_FORMAT = { OneColumn: 1, TwoColumns: 2, Monthly: 3 } as const;
export const FORMULA_TYPE = { UsersFormula: 1, StatementFormula: 5, FilterFormula: 8 } as const;

export const FILTER_FIELDS = ['term', 'reference', 'documentNumber', 'documentType', 'partner', 'debitAccount', 'creditAccount', 'amount', 'number'] as const;
export const FILTER_OPS = ['equals', 'contains', 'notContains', 'startsWith', 'greater', 'less', 'isPartner'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];
export type FilterOp = (typeof FILTER_OPS)[number];
export interface FilterCondition {
  field: FilterField;
  op: FilterOp;
  value: string;
}
export interface FilterSpec {
  match: 'all' | 'any';
  conditions: FilterCondition[];
}

export interface UserReportCell {
  key?: string;
  expression: string;
  isOnlyPositive?: boolean;
  isCurrencyAmount?: boolean;
  isQuantityAmount?: boolean;
  filter?: FilterSpec | null;
}

export interface UserReportLine {
  number: number;
  name: string;
  /** One cell per value column (two for the two-column format). */
  cells: UserReportCell[];
}

export interface UserReportInput {
  name: string;
  description?: string | null;
  format: 1 | 2 | 3;
  columns: string[];
  lines: UserReportLine[];
}

const KEY_RE = /^[A-Za-zА-Яа-я_][A-Za-zА-Яа-я0-9_]*$/;
const columnCount = (format: number) => (format === USER_REPORT_FORMAT.TwoColumns ? 2 : 1);
const defaultKey = (column: number, number: number) => `${column === 0 ? 'u' : 'v'}${number}`;

/* ---------------- filter formulas -> SQL ---------------- */

function textPredicate(col: SQL, op: FilterOp, value: string): SQL {
  switch (op) {
    case 'equals': return sql`lower(coalesce(${col}, '')) = lower(${value})`;
    case 'contains': return sql`coalesce(${col}, '') ILIKE ${`%${value}%`}`;
    case 'notContains': return sql`NOT (coalesce(${col}, '') ILIKE ${`%${value}%`})`;
    case 'startsWith': return sql`coalesce(${col}, '') ILIKE ${`${value}%`}`;
    default: throw new ApiError(422, 'Невалидно условие във филтъра.');
  }
}

function conditionSql(c: FilterCondition): SQL {
  switch (c.field) {
    case 'term': return textPredicate(sql`(SELECT t.description FROM terms t WHERE t.id = a.term_id)`, c.op, c.value);
    case 'reference': return textPredicate(sql`(SELECT r.description FROM reference_texts r WHERE r.id = a.reference_id)`, c.op, c.value);
    case 'number': return textPredicate(sql`a.number`, c.op, c.value);
    case 'documentNumber': return textPredicate(sql`(SELECT doc.number FROM documents doc WHERE doc.id = a.document_id)`, c.op, c.value);
    case 'documentType': return sql`(${textPredicate(sql`(SELECT dty.name FROM documents doc JOIN document_types dty ON dty.id = doc.document_type_id WHERE doc.id = a.document_id)`, c.op, c.value)} OR ${textPredicate(sql`(SELECT dty.short_name FROM documents doc JOIN document_types dty ON dty.id = doc.document_type_id WHERE doc.id = a.document_id)`, c.op, c.value)})`;
    case 'partner':
      if (c.op === 'isPartner') return sql`EXISTS (SELECT 1 FROM accounting_details x WHERE x.accounting_id = a.id AND x.company_id IS NOT NULL)`;
      if (c.op === 'notContains') return sql`NOT EXISTS (SELECT 1 FROM accounting_details x JOIN companies co ON co.id = x.company_id WHERE x.accounting_id = a.id AND co.name ILIKE ${`%${c.value}%`})`;
      return sql`EXISTS (SELECT 1 FROM accounting_details x JOIN companies co ON co.id = x.company_id WHERE x.accounting_id = a.id AND ${textPredicate(sql`co.name`, c.op, c.value)})`;
    case 'debitAccount':
    case 'creditAccount': {
      const sign = c.field === 'debitAccount' ? 1 : -1;
      const pred = c.op === 'equals' ? accountRuleSql(sql`xa.number`, c.value) : textPredicate(sql`xa.number`, c.op === 'notContains' ? 'contains' : c.op, c.value);
      const exists = sql`EXISTS (SELECT 1 FROM accounting_details x JOIN accounts xa ON xa.id = x.account_id WHERE x.accounting_id = a.id AND x.sign = ${sign} AND ${pred})`;
      return c.op === 'notContains' ? sql`NOT ${exists}` : exists;
    }
    case 'amount': {
      const total = sql`(SELECT coalesce(sum(x.amount), 0) FROM accounting_details x WHERE x.accounting_id = a.id AND x.sign = 1)`;
      const v = dec(c.value.replace(',', '.')).toString();
      if (c.op === 'greater') return sql`${total} > ${v}`;
      if (c.op === 'less') return sql`${total} < ${v}`;
      if (c.op === 'equals') return sql`${total} = ${v}`;
      throw new ApiError(422, 'Невалидно условие във филтъра.');
    }
  }
}

export function filterSql(f: FilterSpec | null | undefined): SQL | undefined {
  if (!f || f.conditions.length === 0) return undefined;
  const parts = f.conditions.map(conditionSql);
  return sql`(${sql.join(parts, f.match === 'any' ? sql` OR ` : sql` AND `)})`;
}

/* ---------------- saved user formulas ---------------- */

export async function listUserFormulas(db: DbOrTx) {
  return db.select({ id: s.formulas.id, name: s.formulas.name, key: s.formulas.key, expression: s.formulas.expression, isOnlyPositive: s.formulas.isOnlyPositive })
    .from(s.formulas).where(and(eq(s.formulas.isVisible, true), eq(s.formulas.formulaType, FORMULA_TYPE.UsersFormula))).orderBy(asc(s.formulas.name));
}

async function knownKeys(db: DbOrTx, extra: Iterable<string> = [], exceptFormulaId?: number) {
  const statement = await loadStatementFormulas(db);
  const user = await listUserFormulas(db);
  const keys = new Set(statement.map((f) => f.key.toLowerCase()));
  for (const u of user) if (u.id !== exceptFormulaId) keys.add(u.key.toLowerCase());
  for (const k of extra) keys.add(k.toLowerCase());
  return { keys, statementKeys: new Set(statement.map((f) => f.key.toLowerCase())) };
}

export async function saveUserFormula(db: DbOrTx, input: { name: string; key: string; expression: string; isOnlyPositive?: boolean }, id?: number) {
  const name = input.name.trim();
  const key = input.key.trim();
  if (!name) throw new ApiError(422, 'Не е въведено име на формулата.');
  if (!KEY_RE.test(key)) throw new ApiError(422, 'Невалиден ключ на формулата.');
  const { keys, statementKeys } = await knownKeys(db, [], id);
  if (keys.has(key.toLowerCase()) || statementKeys.has(key.toLowerCase())) throw new ApiError(422, `Ключът „${key}“ вече се използва.`);
  keys.add(key.toLowerCase());
  const err = validateFormula(input.expression, (k) => keys.has(k));
  if (err) throw new ApiError(422, err);
  const values = { name, key, expression: input.expression.trim(), isOnlyPositive: Boolean(input.isOnlyPositive), isVisible: true, formulaType: FORMULA_TYPE.UsersFormula };
  if (id) {
    const [row] = await db.update(s.formulas).set(values).where(and(eq(s.formulas.id, id), eq(s.formulas.isVisible, true))).returning({ id: s.formulas.id });
    if (!row) throw notFound('Формулата');
    return row;
  }
  const [row] = await db.insert(s.formulas).values(values).returning({ id: s.formulas.id });
  return row!;
}

export async function deleteUserFormula(db: DbOrTx, id: number) {
  const r = await db.delete(s.formulas).where(and(eq(s.formulas.id, id), eq(s.formulas.isVisible, true))).returning({ id: s.formulas.id });
  if (!r.length) throw notFound('Формулата');
}

/* ---------------- reports ---------------- */

export async function listUserReports(db: DbOrTx) {
  return db.select().from(s.userReports).orderBy(asc(s.userReports.name));
}

export async function loadUserReport(db: DbOrTx, id: number) {
  const [report] = await db.select().from(s.userReports).where(eq(s.userReports.id, id));
  if (!report) throw notFound('Справката');
  const columns = await db.select().from(s.userReportColumns).where(eq(s.userReportColumns.reportId, id)).orderBy(asc(s.userReportColumns.position));
  const rows = columns.length
    ? await db.select({ row: s.userReportRows, formula: s.formulas }).from(s.userReportRows)
      .leftJoin(s.formulas, eq(s.formulas.id, s.userReportRows.formulaId))
      .where(inArray(s.userReportRows.columnId, columns.map((c) => c.id)))
    : [];
  const filterIds = rows.map((r) => r.row.filterFormulaId).filter((x): x is number => x != null);
  const filters = filterIds.length ? await db.select().from(s.formulas).where(inArray(s.formulas.id, filterIds)) : [];
  const filterById = new Map(filters.map((f) => [f.id, f.filter as FilterSpec | null]));
  const count = columnCount(report.format ?? 1);
  const lines = new Map<number, UserReportLine>();
  for (const r of rows) {
    const col = columns.findIndex((c) => c.id === r.row.columnId);
    const n = r.row.number ?? 0;
    const line = lines.get(n) ?? { number: n, name: r.row.name ?? '', cells: Array.from({ length: count }, (): UserReportCell => ({ expression: '' })) };
    line.cells[col] = {
      key: r.formula?.key ?? defaultKey(col, n),
      expression: r.formula?.expression ?? '',
      isOnlyPositive: r.formula?.isOnlyPositive ?? false,
      isCurrencyAmount: r.formula?.isCurrencyAmount ?? false,
      isQuantityAmount: r.formula?.isQuantityAmount ?? false,
      filter: r.row.filterFormulaId ? (filterById.get(r.row.filterFormulaId) ?? null) : null,
    };
    if (col === 0 || !line.name) line.name = r.row.name ?? line.name;
    lines.set(n, line);
  }
  return {
    id: report.id, name: report.name, description: report.description ?? '', format: (report.format ?? 1) as 1 | 2 | 3,
    columns: columns.map((c) => c.name),
    lines: [...lines.values()].sort((a, b) => a.number - b.number),
  };
}

async function validateReport(db: DbOrTx, input: UserReportInput) {
  if (!input.name.trim()) throw new ApiError(422, 'Не е въведено име на справката.');
  if (![1, 2, 3].includes(input.format)) throw new ApiError(422, 'Невалиден вид на справката.');
  const count = columnCount(input.format);
  const ownKeys: string[] = [];
  const { keys, statementKeys } = await knownKeys(db);
  const messages: { key: string; text: string; severity: 'critical' }[] = [];
  for (const line of input.lines) {
    if (line.cells.length !== count) throw new ApiError(422, 'Броят на формулите на ред не съответства на вида на справката.');
    line.cells.forEach((c, col) => {
      const key = (c.key?.trim() || defaultKey(col, line.number)).toLowerCase();
      if (!KEY_RE.test(key)) messages.push({ key, text: `Ред ${line.number}: невалиден ключ „${key}“.`, severity: 'critical' });
      if (statementKeys.has(key) || ownKeys.includes(key) || keys.has(key)) messages.push({ key, text: `Ред ${line.number}: ключът „${key}“ вече се използва.`, severity: 'critical' });
      ownKeys.push(key);
    });
  }
  for (const k of ownKeys) keys.add(k);
  for (const line of input.lines) {
    line.cells.forEach((c) => {
      const err = validateFormula(c.expression, (k) => keys.has(k));
      if (err) messages.push({ key: String(line.number), text: `Ред ${line.number} „${line.name}“: ${err}`, severity: 'critical' });
      for (const cond of c.filter?.conditions ?? []) {
        if (!FILTER_FIELDS.includes(cond.field) || !FILTER_OPS.includes(cond.op)) messages.push({ key: String(line.number), text: `Ред ${line.number}: невалидно условие във филтъра.`, severity: 'critical' });
        else if (cond.field === 'amount' && !['equals', 'greater', 'less'].includes(cond.op)) messages.push({ key: String(line.number), text: `Ред ${line.number}: сумата се сравнява само с „равно“, „по-голямо“ или „по-малко“.`, severity: 'critical' });
        else if (cond.field !== 'amount' && ['greater', 'less'].includes(cond.op)) messages.push({ key: String(line.number), text: `Ред ${line.number}: „по-голямо“ и „по-малко“ се използват само за сума.`, severity: 'critical' });
        else if (cond.field === 'amount' && !/^-?\d+([.,]\d+)?$/.test(cond.value.trim())) messages.push({ key: String(line.number), text: `Ред ${line.number}: невалидна сума във филтъра.`, severity: 'critical' });
      }
    });
  }
  if (messages.length) throw new ApiError(422, 'Справката съдържа грешки.', messages);
}

async function deleteReportContent(db: DbOrTx, reportId: number) {
  const cols = await db.select({ id: s.userReportColumns.id }).from(s.userReportColumns).where(eq(s.userReportColumns.reportId, reportId));
  if (!cols.length) return;
  const rows = await db.select().from(s.userReportRows).where(inArray(s.userReportRows.columnId, cols.map((c) => c.id)));
  await db.delete(s.userReportColumns).where(eq(s.userReportColumns.reportId, reportId));
  const ids = rows.flatMap((r) => [r.formulaId, r.filterFormulaId]).filter((x): x is number => x != null);
  if (ids.length) await db.delete(s.formulas).where(and(inArray(s.formulas.id, ids), eq(s.formulas.isVisible, false)));
}

export async function saveUserReport(db: DbOrTx, input: UserReportInput, id?: number) {
  await validateReport(db, input);
  let reportId = id;
  const header = { name: input.name.trim(), description: input.description?.trim() || null, format: input.format };
  if (reportId) {
    const r = await db.update(s.userReports).set(header).where(eq(s.userReports.id, reportId)).returning({ id: s.userReports.id });
    if (!r.length) throw notFound('Справката');
    await deleteReportContent(db, reportId);
  } else {
    const [r] = await db.insert(s.userReports).values(header).returning({ id: s.userReports.id });
    reportId = r!.id;
  }
  const count = columnCount(input.format);
  const names = Array.from({ length: count }, (_, i) => input.columns[i]?.trim() || (i === 0 ? 'Стойност' : 'Колона 2'));
  const cols = await db.insert(s.userReportColumns).values(names.map((name, i) => ({ name, reportId: reportId!, position: i + 1 }))).returning({ id: s.userReportColumns.id });
  for (const line of input.lines) {
    for (const [col, c] of line.cells.entries()) {
      const key = c.key?.trim() || defaultKey(col, line.number);
      const [f] = await db.insert(s.formulas).values({
        name: line.name, key, expression: c.expression.trim(), isVisible: false, formulaType: FORMULA_TYPE.UsersFormula,
        isOnlyPositive: Boolean(c.isOnlyPositive), isCurrencyAmount: Boolean(c.isCurrencyAmount), isQuantityAmount: Boolean(c.isQuantityAmount),
      }).returning({ id: s.formulas.id });
      let filterId: number | null = null;
      if (c.filter?.conditions.length) {
        const [ff] = await db.insert(s.formulas).values({ name: `${line.name} (филтър)`, key: `${key}_filter`, isVisible: false, formulaType: FORMULA_TYPE.FilterFormula, filter: c.filter }).returning({ id: s.formulas.id });
        filterId = ff!.id;
      }
      await db.insert(s.userReportRows).values({ name: line.name, number: line.number, formulaId: f!.id, filterFormulaId: filterId, columnId: cols[col]!.id });
    }
  }
  return { id: reportId! };
}

export async function deleteUserReport(db: DbOrTx, id: number) {
  await deleteReportContent(db, id);
  const r = await db.delete(s.userReports).where(eq(s.userReports.id, id)).returning({ id: s.userReports.id });
  if (!r.length) throw notFound('Справката');
}

export async function copyUserReport(db: DbOrTx, id: number) {
  const r = await loadUserReport(db, id);
  // Keys must stay unique across reports only within one report, so the copy keeps them.
  return saveUserReport(db, { name: `${r.name} (копие)`, description: r.description, format: r.format, columns: r.columns, lines: r.lines });
}

/* ---------------- execution ---------------- */

export interface UserReportRunOptions {
  startDate: string;
  endDate: string;
  /** Monthly layout: the twelve months of this financial year. */
  year?: number;
}

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export async function runUserReport(db: DbOrTx, id: number, o: UserReportRunOptions) {
  const report = await loadUserReport(db, id);
  const user = await listUserFormulas(db);
  const extra: Record<string, string> = Object.fromEntries(user.map((u) => [u.key, u.expression]));
  for (const line of report.lines) line.cells.forEach((c, col) => { extra[c.key ?? defaultKey(col, line.number)] = c.expression; });
  const userPositive = new Set(user.filter((u) => u.isOnlyPositive).map((u) => u.key.toLowerCase()));

  const monthly = report.format === USER_REPORT_FORMAT.Monthly;
  const windows = monthly
    ? Array.from({ length: 12 }, (_, i) => {
      const y = o.year ?? Number(o.startDate.slice(0, 4));
      const m = String(i + 1).padStart(2, '0');
      return { startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${lastDay(y, i + 1)}`, month: true };
    })
    : [{ startDate: o.startDate, endDate: o.endDate, month: false }];

  const calcs = new Map<string, Awaited<ReturnType<typeof statementCalculator>>>();
  const calcFor = async (w: (typeof windows)[number], family: ValueFamily, filter: FilterSpec | null | undefined) => {
    const k = `${w.startDate}|${family}|${JSON.stringify(filter ?? null)}`;
    let c = calcs.get(k);
    if (!c) {
      c = await statementCalculator(db, { startDate: w.startDate, endDate: w.endDate }, extra, { family, filter: filterSql(filter), monthMode: w.month });
      calcs.set(k, c);
    }
    return c.calc;
  };

  const issues: { key?: string; message: string }[] = [];
  const lines = [];
  for (const line of report.lines) {
    const values: string[] = [];
    for (const [col, c] of line.cells.entries()) {
      const family: ValueFamily = c.isQuantityAmount ? 'quantity' : c.isCurrencyAmount ? 'currency' : 'amount';
      const key = c.key ?? defaultKey(col, line.number);
      const places = family === 'quantity' ? 3 : 2;
      const one = async (w: (typeof windows)[number]) => {
        const calc = await calcFor(w, family, c.filter);
        let v: Dec = calc.cell(key);
        if ((c.isOnlyPositive || userPositive.has(key.toLowerCase())) && v.lessThan(0)) v = ZERO;
        for (const i of calc.issues) if (!issues.some((x) => x.message === i.message)) issues.push(i);
        return v;
      };
      if (monthly) {
        let total = ZERO;
        for (const w of windows) {
          const v = await one(w);
          total = total.plus(v);
          values.push(v.toFixed(places));
        }
        values.push(total.toFixed(places));
      } else values.push((await one(windows[0]!)).toFixed(places));
    }
    lines.push({ number: line.number, name: line.name, values, quantity: line.cells.map((c) => Boolean(c.isQuantityAmount)), currency: line.cells.map((c) => Boolean(c.isCurrencyAmount)) });
  }
  return {
    report: { id: report.id, name: report.name, description: report.description, format: report.format },
    columns: monthly ? [...MONTH_NAMES_BG, 'Общо'] : report.columns,
    period: monthly ? { start: windows[0]!.startDate, end: windows[11]!.endDate } : { start: o.startDate, end: o.endDate },
    lines,
    issues,
  };
}
