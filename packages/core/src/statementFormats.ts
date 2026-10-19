import type { LayoutRow } from './statements.ts';

/**
 * Format families of "Отчети и баланс" ("Тип справка", spec 05 section 9
 * layout block): national, NSI, the 2015 forms and micro-enterprise, plus the
 * abbreviated statements ("Експорт на съкратени отчети") and the extra
 * "ГФО Микро" sheet of the micro workbook.
 *
 * Every abbreviated / micro line is an aggregation of the seeded national
 * cell keys (Appendix A), evaluated with the same formula engine; there are no
 * extra posting formulas. The line structure is RECONSTRUCTED from the Accounting
 * Act (чл. 29, small and micro enterprises present an abbreviated balance sheet
 * and income statement with the lettered sections and Roman-numeral groups only)
 * and НСС 1; the Delta layouts (.rpt / .xls templates) are not in the spec.
 */

export type StatementFormat = 'national' | 'nsi' | 'f2015' | 'micro';
export type StatementLanguage = 'bg' | 'en';

export const STATEMENT_FORMATS: readonly { value: StatementFormat; label: string }[] = [
  { value: 'national', label: 'Национален формат' },
  { value: 'nsi', label: 'Формат НСИ' },
  { value: 'f2015', label: 'Формат 2015 (ЗСч 2015 / НСС от 2016)' },
  { value: 'micro', label: 'Микропредприятие' },
];

export const STATEMENT_LANGUAGES: readonly { value: StatementLanguage; label: string }[] = [
  { value: 'bg', label: 'Български' },
  { value: 'en', label: 'English' },
];

/* ------------------------------------------------------------------ */
/* Abbreviated statements                                              */
/* ------------------------------------------------------------------ */

export interface AbbreviatedLine {
  /** Code of the line (printed in the "Код" column, also the data key). */
  code: string;
  label: string;
  en: string;
  /** Aggregation over the national cell keys (formula DSL: + and - of cell references). */
  expr: string;
  /** Side of the two-sided form (BalansCol1/2, OPRCol1/2). */
  column: string;
  headings?: readonly string[];
  headingsEn?: readonly string[];
  bold?: boolean;
  /**
   * Codes of the lines that add up to this one (a leading "-" subtracts);
   * checked by the unit tests against the full statement.
   */
  parts?: readonly string[];
}

export interface AbbreviatedStatementDef {
  code: 'balance' | 'opr';
  name: string;
  nameEn: string;
  title: string;
  titleEn: string;
  lines: readonly AbbreviatedLine[];
}

const A = 'BalansCol1';
const P = 'BalansCol2';
const E = 'OPRCol1';
const I = 'OPRCol2';

/** Съкратен счетоводен баланс: sections А-Г and groups I-VI of the national balance (b-cells). */
export const ABBREVIATED_BALANCE: AbbreviatedStatementDef = {
  code: 'balance',
  name: 'Съкратен баланс',
  nameEn: 'Abbreviated balance sheet',
  title: 'СЪКРАТЕН СЧЕТОВОДЕН БАЛАНС',
  titleEn: 'ABBREVIATED BALANCE SHEET',
  lines: [
    { code: 'sb1', column: A, label: 'А. Записан, но невнесен капитал', en: 'A. Subscribed capital unpaid', expr: 'b1', bold: true },
    { code: 'sb2', column: A, label: 'I. Нематериални активи', en: 'I. Intangible assets', expr: 'b6', headings: ['Б. НЕТЕКУЩИ (ДЪЛГОТРАЙНИ) АКТИВИ'], headingsEn: ['B. NON-CURRENT (FIXED) ASSETS'] },
    { code: 'sb3', column: A, label: 'II. Дълготрайни материални активи', en: 'II. Tangible fixed assets', expr: 'b13' },
    { code: 'sb4', column: A, label: 'III. Дългосрочни финансови активи', en: 'III. Long-term financial assets', expr: 'b21' },
    { code: 'sb5', column: A, label: 'IV. Отсрочени данъци', en: 'IV. Deferred taxes', expr: 'b22' },
    // The seeded section total b23 = b6+b13+b21 leaves out IV (b22); the abbreviated form keeps
    // the seeded total so that its total assets equal the full balance (b50 = b1+b23+b48+b49).
    { code: 'sb6', column: A, label: 'Общо за раздел Б:', en: 'Total for section B:', expr: 'b23', bold: true, parts: ['sb2', 'sb3', 'sb4'] },
    { code: 'sb7', column: A, label: 'I. Материални запаси', en: 'I. Inventories', expr: 'b30', headings: ['В. ТЕКУЩИ (КРАТКОТРАЙНИ) АКТИВИ'], headingsEn: ['C. CURRENT ASSETS'] },
    { code: 'sb8', column: A, label: 'II. Вземания, в т.ч.:', en: 'II. Receivables, including:', expr: 'b39' },
    { code: 'sb9', column: A, label: '- над 1 година', en: '- due after more than one year', expr: 'b32+b34+b36+b38' },
    { code: 'sb10', column: A, label: 'III. Инвестиции', en: 'III. Investments', expr: 'b43' },
    { code: 'sb11', column: A, label: 'IV. Парични средства', en: 'IV. Cash and cash equivalents', expr: 'b47' },
    { code: 'sb12', column: A, label: 'Общо за раздел В:', en: 'Total for section C:', expr: 'b48', bold: true, parts: ['sb7', 'sb8', 'sb10', 'sb11'] },
    { code: 'sb13', column: A, label: 'Г. Разходи за бъдещи периоди', en: 'D. Prepaid expenses', expr: 'b49', bold: true },
    { code: 'sb14', column: A, label: 'Сума на актива (А+Б+В+Г)', en: 'Total assets (A+B+C+D)', expr: 'b50', bold: true, parts: ['sb1', 'sb6', 'sb12', 'sb13'] },

    { code: 'sb15', column: P, label: 'I. Записан капитал', en: 'I. Subscribed capital', expr: 'b51', headings: ['А. СОБСТВЕН КАПИТАЛ'], headingsEn: ['A. EQUITY'] },
    { code: 'sb16', column: P, label: 'II. Премии от емисии', en: 'II. Share premium', expr: 'b52' },
    { code: 'sb17', column: P, label: 'III. Резерв от последващи оценки', en: 'III. Revaluation reserve', expr: 'b53' },
    { code: 'sb18', column: P, label: 'IV. Резерви', en: 'IV. Reserves', expr: 'b58' },
    { code: 'sb19', column: P, label: 'V. Натрупана печалба (загуба) от минали години', en: 'V. Retained earnings (accumulated loss) of prior years', expr: 'b61' },
    { code: 'sb20', column: P, label: 'VI. Текуща печалба (загуба)', en: 'VI. Profit (loss) for the year', expr: 'b62' },
    { code: 'sb21', column: P, label: 'Общо за раздел А:', en: 'Total for section A:', expr: 'b63', bold: true, parts: ['sb15', 'sb16', 'sb17', 'sb18', 'sb19', 'sb20'] },
    { code: 'sb22', column: P, label: 'Б. Провизии и сходни задължения', en: 'B. Provisions and similar obligations', expr: 'b68', bold: true },
    { code: 'sb23', column: P, label: 'В. Задължения, в т.ч.:', en: 'C. Liabilities, including:', expr: 'b102', bold: true },
    { code: 'sb24', column: P, label: '- до 1 година', en: '- due within one year', expr: 'b103' },
    { code: 'sb25', column: P, label: '- над 1 година', en: '- due after more than one year', expr: 'b104' },
    { code: 'sb26', column: P, label: 'Г. Финансирания и приходи за бъдещи периоди', en: 'D. Financing and deferred income', expr: 'b105', bold: true },
    { code: 'sb27', column: P, label: 'Сума на пасива (А+Б+В+Г)', en: 'Total equity and liabilities (A+B+C+D)', expr: 'b108', bold: true, parts: ['sb21', 'sb22', 'sb23', 'sb26'] },
  ],
};

/** Съкратен отчет за приходите и разходите: the numbered items of the national ОПР without their sub-lines (r-cells). */
export const ABBREVIATED_OPR: AbbreviatedStatementDef = {
  code: 'opr',
  name: 'Съкратен отчет за приходите и разходите',
  nameEn: 'Abbreviated income statement',
  title: 'СЪКРАТЕН ОТЧЕТ ЗА ПРИХОДИТЕ И РАЗХОДИТЕ',
  titleEn: 'ABBREVIATED INCOME STATEMENT',
  lines: [
    { code: 'sr1', column: E, label: '1. Намаление на запасите от продукция и незавършено производство', en: '1. Decrease in inventories of finished goods and work in progress', expr: 'r1', headings: ['А. РАЗХОДИ'], headingsEn: ['A. EXPENSES'] },
    { code: 'sr2', column: E, label: '2. Разходи за суровини, материали и външни услуги', en: '2. Raw materials, consumables and external services', expr: 'r2' },
    { code: 'sr3', column: E, label: '3. Разходи за персонала', en: '3. Staff costs', expr: 'r5' },
    { code: 'sr4', column: E, label: '4. Разходи за амортизация и обезценка', en: '4. Depreciation, amortisation and impairment', expr: 'r9' },
    { code: 'sr5', column: E, label: '5. Други разходи', en: '5. Other expenses', expr: 'r14' },
    { code: 'sr6', column: E, label: 'Общо разходи за оперативна дейност', en: 'Total operating expenses', expr: 'r17', bold: true, parts: ['sr1', 'sr2', 'sr3', 'sr4', 'sr5'] },
    { code: 'sr7', column: E, label: '6. Финансови разходи', en: '6. Financial expenses', expr: 'r23' },
    { code: 'sr8', column: E, label: 'Общо разходи', en: 'Total expenses', expr: 'r26', bold: true, parts: ['sr6', 'sr7'] },
    { code: 'sr9', column: E, label: '7. Счетоводна печалба (общо приходи - общо разходи)', en: '7. Accounting profit (total income - total expenses)', expr: 'r27', bold: true },
    { code: 'sr10', column: E, label: '8. Разходи за данъци от печалбата и други данъци, алтернативни на корпоративния данък', en: '8. Income tax and other taxes in lieu of corporate tax', expr: 'r28+r29' },
    { code: 'sr11', column: E, label: '9. Печалба (7-8)', en: '9. Profit (7-8)', expr: 'r30', bold: true },
    { code: 'sr12', column: E, label: 'Всичко (общо разходи + 8 + 9)', en: 'Grand total (total expenses + 8 + 9)', expr: 'r31', bold: true, parts: ['sr8', 'sr10', 'sr11'] },

    { code: 'sr13', column: I, label: '1. Нетни приходи от продажби', en: '1. Net revenue from sales', expr: 'r32', headings: ['Б. ПРИХОДИ'], headingsEn: ['B. INCOME'] },
    { code: 'sr14', column: I, label: '2. Увеличение на запасите от продукция и незавършено производство', en: '2. Increase in inventories of finished goods and work in progress', expr: 'r36' },
    { code: 'sr15', column: I, label: '3. Разходи за придобиване на активи по стопански начин', en: '3. Own work capitalised', expr: 'r37' },
    { code: 'sr16', column: I, label: '4. Други приходи', en: '4. Other income', expr: 'r38' },
    { code: 'sr17', column: I, label: 'Общо приходи от оперативна дейност', en: 'Total operating income', expr: 'r40', bold: true, parts: ['sr13', 'sr14', 'sr15', 'sr16'] },
    { code: 'sr18', column: I, label: '5. Финансови приходи', en: '5. Financial income', expr: 'r49' },
    { code: 'sr19', column: I, label: 'Общо приходи', en: 'Total income', expr: 'r52', bold: true, parts: ['sr17', 'sr18'] },
    { code: 'sr20', column: I, label: '6. Счетоводна загуба (общо приходи - общо разходи)', en: '6. Accounting loss (total income - total expenses)', expr: 'r53', bold: true },
    { code: 'sr21', column: I, label: '7. Загуба (6 + ред 8 от разходите)', en: '7. Loss (6 + expense item 8)', expr: 'r54', bold: true },
    { code: 'sr22', column: I, label: 'Всичко (общо приходи + 7)', en: 'Grand total (total income + 7)', expr: 'r55', bold: true, parts: ['sr19', 'sr21'] },
  ],
};

export const ABBREVIATED_STATEMENTS: readonly AbbreviatedStatementDef[] = [ABBREVIATED_BALANCE, ABBREVIATED_OPR];

/* ------------------------------------------------------------------ */
/* ГФО Микро (extra sheet of the _micro workbook)                      */
/* ------------------------------------------------------------------ */

export interface GfoSectionDef {
  title: string;
  titleEn: string;
  lines: readonly Omit<AbbreviatedLine, 'column'>[];
}

/**
 * "ГФО Микро": the annual financial statement form of micro-enterprises (NSI
 * ГФО for enterprises preparing abbreviated statements). RECONSTRUCTED: the
 * sections follow the NSI micro form as known (abbreviated balance, income
 * statement by nature of expense, additional data); the line codes m01..m39 are
 * this application's own and are NOT the official NSI row codes. Every line is
 * an aggregation of seeded national cells.
 */
export const GFO_MICRO: readonly GfoSectionDef[] = [
  {
    title: 'I. СЧЕТОВОДЕН БАЛАНС (съкратен)',
    titleEn: 'I. BALANCE SHEET (abbreviated)',
    lines: [
      { code: 'm01', label: 'А. Записан, но невнесен капитал', en: 'A. Subscribed capital unpaid', expr: 'b1', headings: ['АКТИВ'], headingsEn: ['ASSETS'] },
      { code: 'm02', label: 'Б. Нетекущи (дълготрайни) активи', en: 'B. Non-current (fixed) assets', expr: 'b23' },
      { code: 'm03', label: 'В. Текущи (краткотрайни) активи, в т.ч.:', en: 'C. Current assets, including:', expr: 'b48', parts: ['m04', 'm05', 'm06'] },
      { code: 'm04', label: '- материални запаси', en: '- inventories', expr: 'b30' },
      { code: 'm05', label: '- вземания', en: '- receivables', expr: 'b39' },
      { code: 'm06', label: '- инвестиции и парични средства', en: '- investments, cash and cash equivalents', expr: 'b43+b47' },
      { code: 'm07', label: 'Г. Разходи за бъдещи периоди', en: 'D. Prepaid expenses', expr: 'b49' },
      { code: 'm08', label: 'Сума на актива', en: 'Total assets', expr: 'b50', bold: true, parts: ['m01', 'm02', 'm03', 'm07'] },
      { code: 'm09', label: 'А. Собствен капитал, в т.ч.:', en: 'A. Equity, including:', expr: 'b63', parts: ['m10', 'm11', 'm12', 'm13'], headings: ['ПАСИВ'], headingsEn: ['EQUITY AND LIABILITIES'] },
      { code: 'm10', label: '- записан капитал', en: '- subscribed capital', expr: 'b51' },
      { code: 'm11', label: '- премии от емисии, резерв от последващи оценки и резерви', en: '- share premium, revaluation reserve and reserves', expr: 'b52+b53+b58' },
      { code: 'm12', label: '- натрупана печалба (загуба) от минали години', en: '- retained earnings (accumulated loss) of prior years', expr: 'b61' },
      { code: 'm13', label: '- текуща печалба (загуба)', en: '- profit (loss) for the year', expr: 'b62' },
      { code: 'm14', label: 'Б. Провизии и сходни задължения', en: 'B. Provisions and similar obligations', expr: 'b68' },
      { code: 'm15', label: 'В. Задължения, в т.ч.:', en: 'C. Liabilities, including:', expr: 'b102' },
      { code: 'm16', label: '- до 1 година', en: '- due within one year', expr: 'b103' },
      { code: 'm17', label: '- над 1 година', en: '- due after more than one year', expr: 'b104' },
      { code: 'm18', label: 'Г. Финансирания и приходи за бъдещи периоди', en: 'D. Financing and deferred income', expr: 'b105' },
      { code: 'm19', label: 'Сума на пасива', en: 'Total equity and liabilities', expr: 'b108', bold: true, parts: ['m09', 'm14', 'm15', 'm18'] },
    ],
  },
  {
    title: 'II. ОТЧЕТ ЗА ПРИХОДИТЕ И РАЗХОДИТЕ (съкратен)',
    titleEn: 'II. INCOME STATEMENT (abbreviated)',
    lines: [
      { code: 'm20', label: '1. Нетни приходи от продажби', en: '1. Net revenue from sales', expr: 'r32' },
      { code: 'm21', label: '2. Изменение на запасите от продукция и незавършено производство', en: '2. Change in inventories of finished goods and work in progress', expr: 'r36-r1' },
      { code: 'm22', label: '3. Разходи за придобиване на активи по стопански начин', en: '3. Own work capitalised', expr: 'r37' },
      { code: 'm23', label: '4. Други приходи', en: '4. Other income', expr: 'r38' },
      { code: 'm24', label: '5. Разходи за суровини, материали и външни услуги', en: '5. Raw materials, consumables and external services', expr: 'r2' },
      { code: 'm25', label: '6. Разходи за персонала', en: '6. Staff costs', expr: 'r5' },
      { code: 'm26', label: '7. Разходи за амортизация и обезценка', en: '7. Depreciation, amortisation and impairment', expr: 'r9' },
      { code: 'm27', label: '8. Други разходи', en: '8. Other expenses', expr: 'r14' },
      { code: 'm28', label: '9. Финансови приходи', en: '9. Financial income', expr: 'r49' },
      { code: 'm29', label: '10. Финансови разходи', en: '10. Financial expenses', expr: 'r23' },
      {
        code: 'm30', label: '11. Печалба (загуба) преди облагане с данъци (1+2+3+4-5-6-7-8+9-10)', en: '11. Profit (loss) before tax (1+2+3+4-5-6-7-8+9-10)', expr: 'r27-r53', bold: true,
        parts: ['m20', 'm21', 'm22', 'm23', '-m24', '-m25', '-m26', '-m27', 'm28', '-m29'],
      },
      { code: 'm31', label: '12. Разходи за данъци', en: '12. Taxes', expr: 'r28+r29' },
      { code: 'm32', label: '13. Печалба (загуба) за периода (11-12)', en: '13. Profit (loss) for the period (11-12)', expr: 'r30-r54', bold: true, parts: ['m30', '-m31'] },
    ],
  },
  {
    title: 'III. ДОПЪЛНИТЕЛНИ ДАННИ',
    titleEn: 'III. ADDITIONAL DATA',
    lines: [
      { code: 'm33', label: 'Нетни приходи от продажби на продукция', en: 'Net revenue from sales of finished goods', expr: 'r33' },
      { code: 'm34', label: 'Нетни приходи от продажби на стоки', en: 'Net revenue from sales of merchandise', expr: 'r34' },
      { code: 'm35', label: 'Нетни приходи от продажби на услуги', en: 'Net revenue from sales of services', expr: 'r35' },
      { code: 'm36', label: 'Разходи за възнаграждения', en: 'Wages and salaries', expr: 'r6' },
      { code: 'm37', label: 'Разходи за осигуровки', en: 'Social security costs', expr: 'r7' },
      { code: 'm38', label: 'Балансова стойност на продадените активи', en: 'Carrying amount of assets sold', expr: 'r15' },
      { code: 'm39', label: 'Парични средства в края на периода', en: 'Cash at the end of the period', expr: 'b47' },
    ],
  },
];

/** Cell keys of the national statements referenced by an aggregation ("b32+b34-r1" -> b32, b34, r1). */
export function aggregationKeys(expr: string): string[] {
  return expr.split(/[+-]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* The 2015 forms (Accounting Act 2015, НСС amended for 2016)          */
/* ------------------------------------------------------------------ */

/**
 * The 2015 forms are the national forms with different captions. RECONSTRUCTED
 * from the Accounting Act of 2015 (in force 1.1.2016, Directive 2013/34/EU):
 * extraordinary items and the "profit/loss from ordinary activities" lines are
 * gone, the result lines are renumbered and "асоциирани и смесени предприятия"
 * becomes "асоциирани предприятия". The cells and their formulas are unchanged
 * (the seeded totals already leave the extraordinary cells out), so the 2015
 * variant only hides rows and relabels them.
 */
export const FORMAT_2015 = {
  /** Cells whose rows are not printed. */
  hidden: new Set(['r24', 'r25', 'r56', 'r50', 'r51', 'r63']),
  /** New captions by cell key. */
  labels: {
    b16: '3. Акции и дялове в асоциирани предприятия',
    b17: '4. Предоставени заеми, свързани с асоциирани предприятия',
    b35: '3. Вземания, свързани с асоциирани предприятия, в т.ч.:',
    b87: '7. Задължения, свързани с асоциирани предприятия, в т.ч.:',
    r17: 'Общо разходи за оперативна дейност (1+2+3+4+5)',
    r23: 'Общо финансови разходи (6+7)',
    r26: 'Общо разходи',
    r27: '8. Счетоводна печалба (общо приходи - общо разходи)',
    r28: '9. Разходи за данъци от печалбата',
    r29: '10. Други данъци, алтернативни на корпоративния данък',
    r30: '11. Печалба (8-9-10)',
    r31: 'Всичко (общо разходи + 9 + 10 + 11)',
    r40: 'Общо приходи от оперативна дейност (1+2+3+4)',
    r41: '5. Приходи от участия в дъщерни и асоциирани предприятия, в т.ч.',
    r49: 'Общо финансови приходи (5+6+7)',
    r53: '8. Счетоводна загуба (общо приходи - общо разходи)',
    r54: '9. Загуба (8 + ред 9 и 10 от разходите)',
    r55: 'Всичко (общо приходи + 9)',
  } as Readonly<Record<string, string>>,
};

/** Applies a format variant to a laid-out statement (only the 2015 forms change captions). */
export function applyStatementFormat<R extends Pick<LayoutRow, 'description'> & { cells: Record<string, { key: string }> }>(rows: R[], format: StatementFormat): R[] {
  if (format !== 'f2015') return rows;
  const keysOf = (r: R) => Object.values(r.cells).map((c) => c.key.toLowerCase());
  return rows
    .filter((r) => {
      const keys = keysOf(r);
      return keys.length === 0 || !keys.every((k) => FORMAT_2015.hidden.has(k));
    })
    .map((r) => {
      const label = keysOf(r).map((k) => FORMAT_2015.labels[k]).find(Boolean);
      return label ? { ...r, description: label } : r;
    });
}
