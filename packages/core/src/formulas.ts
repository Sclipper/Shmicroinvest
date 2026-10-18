import { BGN_PER_EUR, D, dec, round, ZERO, type Dec, type DecInput } from './money.ts';

/**
 * Statement formula language (spec 05 sections 9.4-9.6, FormulaCalculator).
 *
 *   expr  := term { ('+' | '-') term }
 *   term  := ['+' | '-'] ( '[' expr ']'      max(expr, 0)
 *                        | '{' expr '}'      min(expr, 0)
 *                        | '(' expr ')'      grouping (verification checks)
 *                        | func '(' args ')' idb icb fdb fcb dt ct (kt) ac
 *                        | cellKey ['cp' | 'ep']
 *                        | decimal )
 *   args  := account | account ',' account   (ac takes two)
 *
 * There is no multiplication or division: '*' is the account wildcard (removed
 * before matching) and '/' the sub-account separator. Brackets nest here (the
 * original only supported one level; every seeded formula uses one level, so
 * results are identical). A parenthesised pair without a function name, as in
 * the seeded ОСК cell k6 "+(30*,101)", is read as a correspondence ac(30*,101)
 * and reported as a warning (the original raised "unknown operand").
 */

export type BalanceFunction = 'idb' | 'icb' | 'fdb' | 'fcb' | 'dt' | 'ct';
export type FormulaPeriod = 'cp' | 'ep';

export type FormulaNode =
  | { t: 'num'; value: string }
  | { t: 'ref'; name: string }
  | { t: 'fn'; fn: BalanceFunction; account: string }
  | { t: 'ac'; debit: string; credit: string; implicit?: boolean }
  | { t: 'neg'; e: FormulaNode }
  | { t: 'sum'; terms: { sign: 1 | -1; e: FormulaNode }[] }
  | { t: 'max0'; e: FormulaNode }
  | { t: 'min0'; e: FormulaNode }
  | { t: 'group'; e: FormulaNode };

export class FormulaSyntaxError extends Error {
  position: number;
  constructor(message: string, position: number) {
    super(message);
    this.position = position;
  }
}

export const FORMULA_MESSAGES = {
  strEmptyStatementFormula: 'Не е въведена формула!',
  strFinancialReportsFormulaCircularReferenceError: 'Във формулите на отчетите има кръгова препратка! Стойността на засегнатите редове е 0.',
  unknownFormula: (key: string) => `Непозната формула : ${key}`,
  unknownOperand: (op: string) => `Непознат операнд : ${op}`,
  implicitCorrespondence: (text: string) => `Операнд без функция „${text}“ е изчислен като ac${text}`,
} as const;

const FUNCTIONS: Record<string, BalanceFunction | 'ac'> = { idb: 'idb', icb: 'icb', fdb: 'fdb', fcb: 'fcb', dt: 'dt', ct: 'ct', kt: 'ct', ac: 'ac' };
const ACCOUNT_RE = /^[0-9A-Za-z]+(?:[\\/.\-][0-9A-Za-z]+)*\*?$/;

/** Parses a formula; throws FormulaSyntaxError with a Bulgarian message. */
export function parseFormula(text: string): FormulaNode {
  const src = text ?? '';
  if (!src.trim()) throw new FormulaSyntaxError(FORMULA_MESSAGES.strEmptyStatementFormula, 0);
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const peek = () => {
    ws();
    return src[i];
  };
  const fail = (msg: string): never => {
    throw new FormulaSyntaxError(`${msg} (позиция ${i + 1})`, i);
  };
  const expect = (ch: string) => {
    if (peek() !== ch) fail(`Очаква се „${ch}“`);
    i++;
  };

  function account(raw: string): string {
    const a = raw.trim();
    if (!ACCOUNT_RE.test(a)) fail(`Невалидна сметка „${a}“`);
    return a;
  }

  /** Raw text up to the matching ')' (arguments never contain parentheses). */
  function rawArgs(): string[] {
    expect('(');
    const startArgs = i;
    while (i < src.length && src[i] !== ')') {
      if ('([]{}'.includes(src[i]!)) fail('Неочакван символ в аргументите');
      i++;
    }
    if (src[i] !== ')') fail('Очаква се „)“');
    const inner = src.slice(startArgs, i);
    i++;
    return inner.split(',');
  }

  function expr(): FormulaNode {
    // A leading sign belongs to the first term (term() reads it as unary).
    const terms: { sign: 1 | -1; e: FormulaNode }[] = [{ sign: 1, e: term() }];
    for (let c = peek(); c === '+' || c === '-'; c = peek()) {
      i++;
      terms.push({ sign: c === '-' ? -1 : 1, e: term() });
    }
    return terms.length === 1 ? terms[0]!.e : { t: 'sum', terms };
  }

  function term(): FormulaNode {
    const c = peek();
    if (c === undefined) return fail('Непълна формула');
    if (c === '+') {
      i++;
      return term();
    }
    if (c === '-') {
      i++;
      return { t: 'neg', e: term() };
    }
    if (c === '[') {
      i++;
      const e = expr();
      expect(']');
      return { t: 'max0', e };
    }
    if (c === '{') {
      i++;
      const e = expr();
      expect('}');
      return { t: 'min0', e };
    }
    if (c === '(') {
      // "(A,B)" without a function name: an account pair (seed cell k6).
      const close = src.indexOf(')', i);
      const inner = close > i ? src.slice(i + 1, close) : '';
      if (inner.includes(',') && !/[()[\]{}]/.test(inner)) {
        const parts = rawArgs();
        if (parts.length !== 2) fail('ac изисква две сметки');
        return { t: 'ac', debit: account(parts[0]!), credit: account(parts[1]!), implicit: true };
      }
      i++;
      const e = expr();
      expect(')');
      return { t: 'group', e };
    }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*(?:\.[0-9]+)?/.exec(src.slice(i))!;
      if (!m[0] || m[0] === '.') fail('Невалидно число');
      i += m[0].length;
      if (/[A-Za-z_]/.test(src[i] ?? '')) fail('Невалиден операнд');
      return { t: 'num', value: m[0] };
    }
    if (/[A-Za-zА-Яа-я_]/.test(c)) {
      const m = /^[A-Za-zА-Яа-я_][A-Za-zА-Яа-я0-9_]*/.exec(src.slice(i))!;
      i += m[0].length;
      const name = m[0];
      const fn = FUNCTIONS[name.toLowerCase()];
      if (fn && peek() === '(') {
        const parts = rawArgs();
        if (fn === 'ac') {
          if (parts.length !== 2) fail('ac изисква две сметки');
          return { t: 'ac', debit: account(parts[0]!), credit: account(parts[1]!) };
        }
        if (parts.length !== 1) fail(`${name} изисква една сметка`);
        return { t: 'fn', fn, account: account(parts[0]!) };
      }
      return { t: 'ref', name };
    }
    return fail(`Неочакван символ „${c}“`);
  }

  const node = expr();
  if (peek() !== undefined) fail(`Неочакван символ „${src[i]}“`);
  return node;
}

/** Cell references and functions used by a formula (for validation and dependency views). */
export function formulaReferences(node: FormulaNode): { refs: string[]; implicit: boolean } {
  const refs: string[] = [];
  let implicit = false;
  const walk = (n: FormulaNode) => {
    switch (n.t) {
      case 'ref': refs.push(n.name); break;
      case 'ac': if (n.implicit) implicit = true; break;
      case 'neg': case 'max0': case 'min0': case 'group': walk(n.e); break;
      case 'sum': n.terms.forEach((x) => walk(x.e)); break;
      default: break;
    }
  };
  walk(node);
  return { refs, implicit };
}

/** Resolves a reference name to a known key and a period ("b50ep" -> b50, ep). */
export function resolveReference(name: string, has: (key: string) => boolean): { key: string; period: FormulaPeriod | null } | null {
  const k = name.toLowerCase();
  if (has(k)) return { key: k, period: null };
  const m = /^(.+)(cp|ep)$/.exec(k);
  if (m && has(m[1]!)) return { key: m[1]!, period: m[2] as FormulaPeriod };
  return null;
}

/** Syntax check plus unknown-reference check; returns the Bulgarian error or null. */
export function validateFormula(text: string, has: (key: string) => boolean): string | null {
  try {
    const node = parseFormula(text);
    for (const r of formulaReferences(node).refs) if (!resolveReference(r, has)) return FORMULA_MESSAGES.unknownFormula(r);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/* ------------------------------------------------------------------ */
/* Account matching and data                                           */
/* ------------------------------------------------------------------ */

/** Account rule (05 2.5 / 9.5): equal, sub-account "N<sep>...", or prefix when N is shorter than 3 chars. */
export function formulaAccountMatches(number: string, arg: string, separator = '/'): boolean {
  const n = arg.replace(/\*/g, '').replace(/\\/g, separator);
  if (!n) return false;
  if (number === n) return true;
  if (number.startsWith(n + separator)) return true;
  return n.length < 3 && number.startsWith(n);
}

/** Per posting account: summed opening debit/credit (od/oc) and period turnovers (dt/ct). */
export interface AccountFigures {
  number: string;
  od: DecInput;
  oc: DecInput;
  dt: DecInput;
  ct: DecInput;
}

/** Debit correspondence: postings debiting `debit` against `credit`. */
export interface CorrespondenceFigure {
  debit: string;
  credit: string;
  amount: DecInput;
}

export interface FormulaDataSet {
  accounts: AccountFigures[];
  correspondences: CorrespondenceFigure[];
  /**
   * Month mode (monthly user reports): the figures are of one calendar month,
   * balances are netted over all matching accounts and floored once.
   */
  monthMode?: boolean;
}

const pos = (v: Dec) => (v.greaterThan(0) ? v : ZERO);

/** Value of a balance function over a data set (9.5 floor rules). */
export function balanceFunction(fn: BalanceFunction, account: string, data: FormulaDataSet, separator = '/'): Dec {
  const rows = data.accounts.filter((a) => formulaAccountMatches(a.number, account, separator));
  const v = (a: AccountFigures) => ({ od: dec(a.od), oc: dec(a.oc), dt: dec(a.dt), ct: dec(a.ct) });
  if (fn === 'dt') return rows.reduce((s, a) => s.plus(dec(a.dt)), ZERO);
  if (fn === 'ct') return rows.reduce((s, a) => s.plus(dec(a.ct)), ZERO);
  const signed = (a: ReturnType<typeof v>) => {
    switch (fn) {
      case 'idb': return a.od.minus(a.oc);
      case 'icb': return a.oc.minus(a.od);
      case 'fdb': return a.od.minus(a.oc).plus(a.dt).minus(a.ct);
      default: return a.oc.minus(a.od).plus(a.ct).minus(a.dt);
    }
  };
  if (data.monthMode) return pos(rows.reduce((s, a) => s.plus(signed(v(a))), ZERO));
  return pos(rows.reduce((s, a) => s.plus(pos(signed(v(a)))), ZERO));
}

export function correspondence(debit: string, credit: string, data: FormulaDataSet, separator = '/'): Dec {
  return data.correspondences
    .filter((c) => formulaAccountMatches(c.debit, debit, separator) && formulaAccountMatches(c.credit, credit, separator))
    .reduce((s, c) => s.plus(dec(c.amount)), ZERO);
}

/* ------------------------------------------------------------------ */
/* Evaluator                                                           */
/* ------------------------------------------------------------------ */

export interface FormulaContext {
  /** Cell formulas by key (any case). */
  formulas: Record<string, string> | Map<string, string>;
  /** Figures of the current ('cp') and previous ('ep') period. */
  data: (period: FormulaPeriod) => FormulaDataSet;
  /** Stored previous-period values (StatementFormulas.ValueLastPeriod). */
  lastPeriodValues?: Record<string, DecInput> | Map<string, DecInput>;
  /** "Попълване на ръчно въведени данни за предходен период": ep cells use the stored value. */
  usePreviousPeriodValues?: boolean;
  /** Divide previous-period results by 1.95583 (both report years are 2026, 9.6). */
  convertPrevious?: boolean;
  /** Accounts separator (ConfigurationKey.AccountsSeparator) replacing "\" in formulas. */
  separator?: string;
  /** Loop guard per top-level evaluation (default 1 000). */
  maxEvaluations?: number;
}

export interface FormulaIssue {
  key?: string;
  message: string;
}

/** FormulaCalculator: evaluates cells with caching, the cp/ep periods and the loop guard. */
export class FormulaCalculator {
  private readonly formulas = new Map<string, string>();
  private readonly lastValues = new Map<string, Dec>();
  private readonly parsed = new Map<string, FormulaNode | Error>();
  private readonly cache = new Map<string, Dec>();
  private readonly ctx: FormulaContext;
  private counter = 0;
  private readonly stack: string[] = [];
  readonly issues: FormulaIssue[] = [];
  circular = false;

  constructor(ctx: FormulaContext) {
    this.ctx = ctx;
    const entries = ctx.formulas instanceof Map ? [...ctx.formulas] : Object.entries(ctx.formulas);
    for (const [k, f] of entries) this.formulas.set(k.toLowerCase(), f);
    const lv = ctx.lastPeriodValues instanceof Map ? [...ctx.lastPeriodValues] : Object.entries(ctx.lastPeriodValues ?? {});
    for (const [k, v] of lv) this.lastValues.set(k.toLowerCase(), dec(v));
  }

  has = (key: string) => this.formulas.has(key.toLowerCase());

  private issue(message: string, key?: string) {
    if (!this.issues.some((x) => x.message === message && x.key === key)) this.issues.push({ key, message });
  }

  private node(text: string, key?: string): FormulaNode | null {
    let n = this.parsed.get(text);
    if (!n) {
      try {
        n = parseFormula(text.replace(/\\/g, this.ctx.separator ?? '/'));
      } catch (e) {
        n = e instanceof Error ? e : new Error(String(e));
      }
      this.parsed.set(text, n);
    }
    if (n instanceof Error) {
      this.issue(n.message, key);
      return null;
    }
    return n;
  }

  /** Value of a cell for a period (top-level call: resets the loop guard, applies the ep conversion). */
  cell(key: string, period: FormulaPeriod = 'cp'): Dec {
    this.counter = 0;
    const raw = this.cellRaw(key.toLowerCase(), period);
    return period === 'ep' ? this.convert(raw) : raw;
  }

  /** Value of a free expression (verification checks, user-report rows). */
  expression(text: string, period: FormulaPeriod = 'cp', key?: string): Dec {
    this.counter = 0;
    const n = this.node(text, key);
    if (!n) return ZERO;
    const raw = this.eval(n, period, key);
    return period === 'ep' ? this.convert(raw) : raw;
  }

  /** Previous-period BGN figures shown in EUR; manually entered values are already in the base currency. */
  private convert(v: Dec) {
    return this.ctx.convertPrevious && !this.ctx.usePreviousPeriodValues ? v.div(BGN_PER_EUR) : v;
  }

  private cellRaw(key: string, period: FormulaPeriod): Dec {
    const cacheKey = `${period}:${key}`;
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;
    if (period === 'ep' && this.ctx.usePreviousPeriodValues) return this.lastValues.get(key) ?? ZERO;
    const text = this.formulas.get(key);
    if (text === undefined) {
      this.issue(FORMULA_MESSAGES.unknownFormula(key));
      return ZERO;
    }
    if (this.stack.includes(cacheKey)) {
      this.flagCircular(key);
      return ZERO;
    }
    if (!text.trim()) {
      this.issue(FORMULA_MESSAGES.strEmptyStatementFormula, key);
      return ZERO;
    }
    const n = this.node(text, key);
    if (!n) return ZERO;
    this.stack.push(cacheKey);
    try {
      const v = this.eval(n, period, key);
      this.cache.set(cacheKey, v);
      return v;
    } finally {
      this.stack.pop();
    }
  }

  private flagCircular(key: string) {
    if (!this.circular) this.issue(FORMULA_MESSAGES.strFinancialReportsFormulaCircularReferenceError, key);
    this.circular = true;
  }

  private eval(n: FormulaNode, period: FormulaPeriod, key?: string): Dec {
    if (++this.counter > (this.ctx.maxEvaluations ?? 1000)) {
      this.flagCircular(key ?? '');
      return ZERO;
    }
    const sep = this.ctx.separator ?? '/';
    switch (n.t) {
      case 'num': return new D(n.value);
      case 'neg': return this.eval(n.e, period, key).negated();
      case 'group': return this.eval(n.e, period, key);
      case 'max0': return pos(this.eval(n.e, period, key));
      case 'min0': {
        const v = this.eval(n.e, period, key);
        return v.lessThan(0) ? v : ZERO;
      }
      case 'sum': return n.terms.reduce((s, t) => (t.sign === 1 ? s.plus(this.eval(t.e, period, key)) : s.minus(this.eval(t.e, period, key))), ZERO);
      case 'fn': return balanceFunction(n.fn, n.account, this.ctx.data(period), sep);
      case 'ac': {
        if (n.implicit) this.issue(FORMULA_MESSAGES.implicitCorrespondence(`(${n.debit},${n.credit})`), key);
        return correspondence(n.debit, n.credit, this.ctx.data(period), sep);
      }
      case 'ref': {
        const r = resolveReference(n.name, this.has);
        if (!r) {
          this.issue(FORMULA_MESSAGES.unknownFormula(n.name), key);
          return ZERO;
        }
        const target = r.period ?? period;
        const v = this.cellRaw(r.key, target);
        // Entering the previous period from the current one converts once.
        return target === 'ep' && period === 'cp' ? this.convert(v) : v;
      }
    }
  }
}

/** "В хиляди": value / 1000 rounded to 0 decimals, half away from zero (9.6). */
export function toThousands(v: DecInput): Dec {
  return round(dec(v).div(1000), 0);
}

/* ------------------------------------------------------------------ */
/* Periods (FormulaCalculator.Init, 9.2)                               */
/* ------------------------------------------------------------------ */

export interface DateWindow {
  start: string;
  end: string;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function shiftYears(iso: string, years: number) {
  const y = Number(iso.slice(0, 4)) + years;
  let md = iso.slice(5, 10);
  if (md === '02-29' && !isLeap(y)) md = '02-28';
  return `${y}-${md}`;
}

/**
 * Current and previous windows of a statement run.
 * - current start = max(start, financial-year start of the start year);
 * - same interval previous year: start and end one year back (start clamped to
 *   the previous financial-year start; 28 Feb of a leap year moves to 29 Feb);
 * - otherwise the whole previous financial year (or 1 January) to 31 December.
 */
export function statementPeriods(o: { start: string; end: string; sameIntervalPreviousYear?: boolean; fyStart: (year: number) => string | null | undefined }): { cp: DateWindow; ep: DateWindow; convertPrevious: boolean } {
  const y = Number(o.start.slice(0, 4));
  const fy = o.fyStart(y);
  const cpStart = fy && fy > o.start ? fy : o.start;
  const cp = { start: cpStart, end: o.end };
  let ep: DateWindow;
  if (o.sameIntervalPreviousYear) {
    let s = shiftYears(cpStart, -1);
    const prevFy = o.fyStart(y - 1);
    if (prevFy && prevFy > s) s = prevFy;
    let e = shiftYears(o.end, -1);
    const ey = Number(e.slice(0, 4));
    if (e.slice(5) === '02-28' && isLeap(ey)) e = `${ey}-02-29`;
    ep = { start: s, end: e };
  } else {
    ep = { start: o.fyStart(y - 1) ?? `${y - 1}-01-01`, end: `${y - 1}-12-31` };
  }
  const convertPrevious = y === 2026 && Number(o.end.slice(0, 4)) === 2026;
  return { cp, ep, convertPrevious };
}

/** Unit label of a statement run (9.8, 12): euro from end year 2026. */
export function statementUnit(endYear: number, thousands: boolean) {
  if (endYear > 2025) return thousands ? 'хил. евро' : 'евро';
  return thousands ? 'хил. лв.' : 'лв.';
}
