import { STATEMENT_SEED } from './seeds/statements.ts';

/**
 * Financial statements ("Отчети и баланс", spec 05 section 9): the statement
 * catalogue, the seed broken into rows/columns/cells (StatementReportRows,
 * StatementReportColumns, StatementFormulas) and the printed layout.
 */

export type StatementCode = 'balance' | 'opr' | 'opp' | 'osk' | 'sda' | 'cr';

export interface StatementDef {
  code: StatementCode;
  /** Section name in Appendix A. */
  seedName: string;
  name: string;
  title: string;
  /** Cell-key prefix. */
  prefix: string;
  rowPrefix: string;
}

export const STATEMENTS: readonly StatementDef[] = [
  { code: 'balance', seedName: 'Баланс', name: 'Баланс', title: 'Б А Л А Н С', prefix: 'b', rowPrefix: 'BalansRow' },
  { code: 'opr', seedName: 'ОПР', name: 'Отчет за приходите и разходите', title: 'ОТЧЕТ ЗА ПРИХОДИТЕ И РАЗХОДИТЕ', prefix: 'r', rowPrefix: 'OPRRow' },
  { code: 'opp', seedName: 'ОПП', name: 'Отчет за паричните потоци', title: 'ОТЧЕТ ЗА ПАРИЧНИТЕ ПОТОЦИ ПО ПРЕКИЯ МЕТОД', prefix: 'p', rowPrefix: 'OPPRow' },
  { code: 'osk', seedName: 'ОСК', name: 'Отчет за собствения капитал', title: 'ОТЧЕТ ЗА СОБСТВЕНИЯ КАПИТАЛ', prefix: 'k', rowPrefix: 'OSKRow' },
  { code: 'sda', seedName: 'СДА', name: 'Справка за нетекущите (дълготрайни) активи', title: 'СПРАВКА ЗА НЕТЕКУЩИТЕ (ДЪЛГОТРАЙНИ) АКТИВИ', prefix: 's', rowPrefix: 'SDARow' },
  { code: 'cr', seedName: 'CashAndReceivables', name: 'Касова наличност и вземания', title: 'КАСОВА НАЛИЧНОСТ И ВЗЕМАНИЯ', prefix: 'cr', rowPrefix: 'CRRow' },
];

export const statementByCode = (code: string) => STATEMENTS.find((s) => s.code === code);

/** Statement of a cell key: longest matching prefix ("cr1" -> cr, "b20a" -> balance). */
export function statementOfKey(key: string): StatementDef | undefined {
  const k = key.toLowerCase();
  return [...STATEMENTS].sort((a, b) => b.prefix.length - a.prefix.length).find((s) => k.startsWith(s.prefix) && /^\d/.test(k.slice(s.prefix.length)));
}

/** StatementReportColumns (36 real columns; captions from the seed and the Excel workbook). */
export const STATEMENT_COLUMNS: readonly { identifier: string; description: string; statement: StatementCode; nsi?: boolean }[] = [
  { identifier: 'OPRCol1', description: 'Разходи', statement: 'opr' },
  { identifier: 'OPRCol2', description: 'Приходи', statement: 'opr' },
  { identifier: 'OPPCol1', description: 'Постъпления', statement: 'opp' },
  { identifier: 'OPPCol2', description: 'Плащания', statement: 'opp' },
  { identifier: 'OPPCol3', description: 'Нетен поток', statement: 'opp' },
  { identifier: 'BalansCol1', description: 'Актив', statement: 'balance' },
  { identifier: 'BalansCol2', description: 'Пасив', statement: 'balance' },
  { identifier: 'OSKCol1', description: 'Записан капитал', statement: 'osk' },
  { identifier: 'OSKCol2', description: 'Премии от емисии', statement: 'osk' },
  { identifier: 'OSKCol3', description: 'Резерв от последващи оценки', statement: 'osk' },
  { identifier: 'OSKCol4', description: 'Законови резерви', statement: 'osk' },
  { identifier: 'OSKCol5', description: 'Резерв, свързан с изкупени собствени акции', statement: 'osk' },
  { identifier: 'OSKCol6', description: 'Резерв съгласно учредителен акт', statement: 'osk' },
  { identifier: 'OSKCol7', description: 'Други резерви', statement: 'osk' },
  { identifier: 'OSKCol8', description: 'Неразпределена печалба', statement: 'osk' },
  { identifier: 'OSKCol9', description: 'Непокрита загуба', statement: 'osk' },
  { identifier: 'OSKCol10', description: 'Текуща печалба/загуба', statement: 'osk' },
  { identifier: 'OSKCol11', description: 'Общо собствен капитал', statement: 'osk' },
  { identifier: 'SDACol1', description: 'Отчетна стойност в началото на периода', statement: 'sda' },
  { identifier: 'SDACol2', description: 'Отчетна стойност на постъпилите през периода', statement: 'sda' },
  { identifier: 'SDANSICol2a', description: 'в т.ч. постъпили (НСИ, а)', statement: 'sda', nsi: true },
  { identifier: 'SDANSICol2b', description: 'в т.ч. постъпили (НСИ, б)', statement: 'sda', nsi: true },
  { identifier: 'SDACol3', description: 'Отчетна стойност на излезлите през периода', statement: 'sda' },
  { identifier: 'SDACol4', description: 'Отчетна стойност в края на периода (1+2-3)', statement: 'sda' },
  { identifier: 'SDACol5', description: 'Последваща оценка - увеличение', statement: 'sda' },
  { identifier: 'SDACol6', description: 'Последваща оценка - намаление', statement: 'sda' },
  { identifier: 'SDACol7', description: 'Преоценена стойност (4+5-6)', statement: 'sda' },
  { identifier: 'SDACol8', description: 'Амортизация в началото на периода', statement: 'sda' },
  { identifier: 'SDACol9', description: 'Начислена амортизация през периода', statement: 'sda' },
  { identifier: 'SDACol10', description: 'Отписана амортизация през периода', statement: 'sda' },
  { identifier: 'SDACol11', description: 'Амортизация в края на периода (8+9-10)', statement: 'sda' },
  { identifier: 'SDACol12', description: 'Последваща оценка на амортизацията - увеличение', statement: 'sda' },
  { identifier: 'SDACol13', description: 'Последваща оценка на амортизацията - намаление', statement: 'sda' },
  { identifier: 'SDACol14', description: 'Преоценена амортизация в края на периода (11+12-13)', statement: 'sda' },
  { identifier: 'SDACol15', description: 'Балансова стойност в края на периода (7-14)', statement: 'sda' },
  { identifier: 'CRCol1', description: 'Стойност', statement: 'cr' },
];

export interface SeedRow {
  identifier: string;
  description: string;
  statement: StatementCode;
  order: number;
}

export interface SeedFormula {
  key: string;
  rowIdentifier: string;
  columnIdentifier: string;
  formula: string;
  /** Position in Appendix A. */
  position: number;
}

/**
 * Breaks Appendix A into rows, columns and cells. A new row starts when the
 * caption changes or a column repeats (gives exactly the 289 seeded rows).
 */
export function buildStatementSeed() {
  const rows: SeedRow[] = [];
  const formulas: SeedFormula[] = [];
  let position = 0;
  for (const def of STATEMENTS) {
    const cells = STATEMENT_SEED[def.seedName] ?? [];
    let caption: string | null = null;
    let used = new Set<string>();
    let n = 0;
    for (const [key, row, column, formula] of cells) {
      if (row !== caption || used.has(column)) {
        n++;
        rows.push({ identifier: `${def.rowPrefix}${n}`, description: row, statement: def.code, order: n });
        caption = row;
        used = new Set();
      }
      used.add(column);
      formulas.push({ key, rowIdentifier: `${def.rowPrefix}${n}`, columnIdentifier: column, formula, position: ++position });
    }
  }
  const columns = STATEMENT_COLUMNS.map((c, i) => ({ ...c, order: i + 1 }));
  return { rows, columns, formulas };
}

/* ------------------------------------------------------------------ */
/* Printed layout                                                      */
/* ------------------------------------------------------------------ */

/**
 * Section headings of the official forms, printed before the row holding the
 * given cell [I: the encrypted .rpt layouts are not readable; wording from the
 * Excel workbook and the official NRA forms].
 */
export const STATEMENT_HEADINGS: Readonly<Record<string, readonly string[]>> = {
  b2: ['Б. НЕТЕКУЩИ (ДЪЛГОТРАЙНИ) АКТИВИ', 'I. Нематериални активи'],
  b7: ['II. Дълготрайни материални активи'],
  b14: ['III. Дългосрочни финансови активи'],
  b24: ['В. ТЕКУЩИ (КРАТКОТРАЙНИ) АКТИВИ', 'I. Материални запаси'],
  b31: ['II. Вземания'],
  b40: ['III. Инвестиции'],
  b51: ['А. СОБСТВЕН КАПИТАЛ'],
  b54: ['IV. Резерви'],
  b59: ['V. Натрупана печалба (загуба) от минали години, в т.ч.:'],
  b64: ['Б. ПРОВИЗИИ И СХОДНИ ЗАДЪЛЖЕНИЯ'],
  b69: ['В. ЗАДЪЛЖЕНИЯ'],
  r1: ['А. РАЗХОДИ', 'I. Разходи за оперативна дейност'],
  r18: ['II. Финансови разходи'],
  r32: ['Б. ПРИХОДИ', 'I. Приходи от оперативна дейност'],
  r41: ['II. Финансови приходи'],
  p1: ['А. Парични потоци от основната дейност'],
  p10: ['Б. Парични потоци от инвестиционната дейност'],
  p17: ['В. Парични потоци от финансовата дейност'],
  s1: ['I. Нематериални активи'],
  s6: ['II. Дълготрайни материални активи'],
  s13: ['III. Дългосрочни финансови активи'],
};

/** Cells listed at the end of the seed that print under another row ("номинална стойност"). */
export const STATEMENT_PRINT_AFTER: Readonly<Record<string, string>> = { b20a: 'b20', b41a: 'b41', b164: 'b62' };

/** Rows printed in bold (totals and section results). */
export const STATEMENT_TOTAL_KEYS = new Set([
  'b6', 'b13', 'b21', 'b23', 'b30', 'b39', 'b43', 'b47', 'b48', 'b50', 'b58', 'b61', 'b63', 'b68', 'b102', 'b108',
  'r17', 'r23', 'r26', 'r31', 'r40', 'r49', 'r52', 'r55', 'r24', 'r27', 'r30', 'r50', 'r53', 'r54',
  'p9', 'p16', 'p24', 'p25', 'p26', 'p27',
  'k1', 'k4', 'k16', 'k18', 's5', 's12', 's20', 's22',
]);

export interface LayoutCell {
  key: string;
  formula?: string;
}

export interface LayoutRow {
  identifier: string;
  description: string;
  headings: string[];
  bold: boolean;
  cells: Record<string, LayoutCell>;
}

/** Orders the rows of one statement for printing (seed order + headings + moved rows). */
export function statementLayout(code: StatementCode, rows: { identifier: string; description: string; order: number }[], cells: { key: string; rowIdentifier: string; columnIdentifier: string; formula?: string; position: number }[]): LayoutRow[] {
  const byRow = new Map<string, LayoutRow & { pos: number }>();
  const ordered = [...rows].sort((a, b) => a.order - b.order);
  for (const r of ordered) byRow.set(r.identifier, { identifier: r.identifier, description: r.description, headings: [], bold: false, cells: {}, pos: r.order });
  for (const c of [...cells].sort((a, b) => a.position - b.position)) {
    const r = byRow.get(c.rowIdentifier);
    if (!r) continue;
    r.cells[c.columnIdentifier] = { key: c.key, formula: c.formula };
    const k = c.key.toLowerCase();
    if (STATEMENT_HEADINGS[k] && r.headings.length === 0) r.headings = [...STATEMENT_HEADINGS[k]!];
    if (STATEMENT_TOTAL_KEYS.has(k)) r.bold = true;
  }
  const list = [...byRow.values()];
  // Move the late-seeded rows under their parent row.
  for (const [key, after] of Object.entries(STATEMENT_PRINT_AFTER)) {
    const from = list.findIndex((r) => Object.values(r.cells).some((c) => c.key.toLowerCase() === key));
    if (from < 0) continue;
    const [row] = list.splice(from, 1);
    const to = list.findIndex((r) => Object.values(r.cells).some((c) => c.key.toLowerCase() === after));
    list.splice(to < 0 ? list.length : to + 1, 0, row!);
  }
  void code;
  return list.map(({ pos: _pos, ...r }) => r);
}

/* ------------------------------------------------------------------ */
/* Cross-statement verification (VerifyFinancialReportsService, 9.8)   */
/* ------------------------------------------------------------------ */

export interface StatementCheck {
  id: string;
  /** Left sides compared with 0; the check passes if any one of them holds. */
  formulas: string[];
  /** {0} = difference, {1} = unit. */
  message: string;
  severity: 'critical' | 'warning';
  /** true = part of the "balance sheet only" sub-type. */
  balanceOnly?: boolean;
}

const SDA_PAIRS: [string, number][] = [['b2', 309], ['b3', 310], ['b4', 311], ['b5', 312], ['b6', 313], ['b7', 314], ['b8', 315], ['b9', 316], ['b10', 317], ['b11', 318], ['b12', 319], ['b13', 320]];

export const STATEMENT_CHECKS: readonly StatementCheck[] = [
  { id: 'balance', formulas: ['B50CP-B108CP'], message: 'Сумата на актива не е равна на сумата на пасива (текуща година). Разлика: {0} {1}', severity: 'critical', balanceOnly: true },
  { id: 'balance_2', formulas: ['B50EP-B108EP'], message: 'Сумата на актива не е равна на сумата на пасива (предходна година). Разлика: {0} {1}', severity: 'critical', balanceOnly: true },
  { id: 'result', formulas: ['B62CP-r30CP+r54CP'], message: 'Текущата печалба (загуба) в баланса не съответства на резултата в отчета за приходите и разходите. Разлика: {0} {1}', severity: 'critical' },
  { id: 'result_2', formulas: ['B62EP-r30EP+r54EP'], message: 'Текущата печалба (загуба) в баланса не съответства на резултата в отчета за приходите и разходите (предходна година). Разлика: {0} {1}', severity: 'critical' },
  { id: 'cash', formulas: ['B47CP-P56CP'], message: 'Паричните средства в баланса не съответстват на паричните средства в края на периода в отчета за паричните потоци. Разлика: {0} {1}', severity: 'warning' },
  { id: 'equity', formulas: ['B63CP-K196CP'], message: 'Собственият капитал в баланса не съответства на отчета за собствения капитал. Разлика: {0} {1}', severity: 'critical' },
  { id: 'equity_result', formulas: ['B62CP-K188CP'], message: 'Текущата печалба (загуба) в баланса не съответства на отчета за собствения капитал. Разлика: {0} {1}', severity: 'critical' },
  { id: 'capital', formulas: ['B51CP-K16CP'], message: 'Записаният капитал в баланса не съответства на отчета за собствения капитал. Разлика: {0} {1}', severity: 'critical' },
  { id: 'premium', formulas: ['B52CP-K34CP'], message: 'Премиите от емисии в баланса не съответстват на отчета за собствения капитал. Разлика: {0} {1}', severity: 'critical' },
  { id: 'revaluation', formulas: ['B53CP-K52CP'], message: 'Резервът от последващи оценки в баланса не съответства на отчета за собствения капитал. Разлика: {0} {1}', severity: 'critical' },
  { id: 'reserves', formulas: ['B58CP-(K70CP+K88CP+K106CP+K124CP)'], message: 'Резервите в баланса не съответстват на отчета за собствения капитал. Разлика: {0} {1}', severity: 'critical' },
  { id: 'profit', formulas: ['r30CP-r54CP-K170CP'], message: 'Финансовият резултат в отчета за приходите и разходите не съответства на отчета за собствения капитал. Разлика: {0} {1}', severity: 'critical' },
  ...SDA_PAIRS.map(([b, s]): StatementCheck => ({
    id: `sda_${b}`, formulas: [`${b.toUpperCase()}CP-S${s}`],
    message: `Стойността на ред ${b} в баланса не съответства на справката за нетекущите активи. Разлика: {0} {1}`, severity: 'critical',
  })),
];

/** string.Format(message, difference, unit). */
export function formatCheckMessage(message: string, difference: string, unit: string) {
  return message.replace('{0}', difference).replace('{1}', unit);
}
