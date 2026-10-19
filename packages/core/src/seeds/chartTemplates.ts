import { ACCOUNT_CATEGORIES, type ChartTemplateType } from '../categories.ts';
import { BUDGET_CHART } from './chartBudget.ts';
import { COMMERCIAL_CHART, parseChartTemplate, type TemplateAccount } from './chartCommercial.ts';
import { NON_PROFIT_CHART } from './chartNonProfit.ts';
import { COMMERCIAL_CHART_V1, NON_PROFIT_CHART_V1 } from './chartTemplatesV1.ts';

/** Template text per ChartOfAccountsType (01a 7, 03a 1.3). */
export const CHART_TEMPLATE_TEXT: Record<ChartTemplateType, string> = {
  commercial: COMMERCIAL_CHART,
  nonProfit: NON_PROFIT_CHART,
  budget: BUDGET_CHART,
};

export const CHART_TEMPLATE_TYPES: readonly ChartTemplateType[] = ['commercial', 'nonProfit', 'budget'];

/**
 * Version of the chart templates (config ChartTemplateVersion, stored when a
 * company's chart is first created from a template). Version 1 is the
 * national-chart numbering of the commercial and ЮЛНЦ templates (202 сгради,
 * 203 машини, 241/1-241/7); version 2 follows Delta's statement formulas
 * (203 сгради, 206 машини, 241/n = depreciation of 20n). The budget template
 * is the same in both.
 */
export const CHART_TEMPLATE_VERSION = 2;
export const CHART_TEMPLATE_VERSION_KEY = 'ChartTemplateVersion';

const V1_TEXT: Partial<Record<ChartTemplateType, string>> = { commercial: COMMERCIAL_CHART_V1, nonProfit: NON_PROFIT_CHART_V1 };

const parsed = new Map<string, TemplateAccount[]>();

/** Parsed template accounts in file order (a parent always precedes its children), of the given template version. */
export function chartTemplateAccounts(type: ChartTemplateType, version: number = CHART_TEMPLATE_VERSION): TemplateAccount[] {
  const text = version === 1 ? V1_TEXT[type] ?? CHART_TEMPLATE_TEXT[type] : CHART_TEMPLATE_TEXT[type];
  const key = `${type}:${text === CHART_TEMPLATE_TEXT[type] ? CHART_TEMPLATE_VERSION : 1}`;
  let list = parsed.get(key);
  if (!list) parsed.set(key, (list = parseChartTemplate(text)));
  return list;
}

/** A template version this program has (1 or the current one). */
export const isKnownChartTemplateVersion = (v: number) => v === 1 || v === CHART_TEMPLATE_VERSION;

/** strChartTemplateVersionUnknown: a chart made by a newer program version (e.g. a restored backup). */
export const CHART_TEMPLATE_MESSAGES = {
  strChartTemplateVersionUnknown: (v: number) =>
    `Сметкопланът на фирмата е създаден по шаблон версия ${v}, а тази версия на програмата познава шаблоните до версия ${CHART_TEMPLATE_VERSION}. Сметки от шаблон не могат да бъдат добавяни, за да не се смесят сметки с различно значение. Обновете програмата.`,
};

const normDesc = (t: string) => t.toLowerCase().replace(/[\s„“"'.,()-]+/g, ' ').trim();

/**
 * Template version of an existing chart without a stored ChartTemplateVersion
 * (companies created before the version was stored): the accounts whose
 * meaning differs between the versions are compared by number and
 * description. Null when the chart matches neither (its own numbering, an
 * import) or the type has a single version.
 */
export function detectChartTemplateVersion(type: ChartTemplateType, accounts: { number: string; description: string }[]): number | null {
  if (!V1_TEXT[type]) return null;
  const v1 = new Map(chartTemplateAccounts(type, 1).map((a) => [a.number, normDesc(a.description)]));
  const v2 = new Map(chartTemplateAccounts(type).map((a) => [a.number, normDesc(a.description)]));
  let one = 0;
  let two = 0;
  for (const a of accounts) {
    const d1 = v1.get(a.number);
    const d2 = v2.get(a.number);
    if (d1 === d2) continue;
    const d = normDesc(a.description);
    if (d === d1) one++;
    else if (d === d2) two++;
  }
  if (one === two) return null;
  return one > two ? 1 : CHART_TEMPLATE_VERSION;
}

/**
 * Configuration written when a template is chosen (03a 1.4): the budget chart
 * also turns on the "Параграф" field of the entry editor (IsParagraphEnabled).
 */
export function chartTemplateSettings(type: ChartTemplateType): Record<string, string> {
  return type === 'budget' ? { IsParagraphEnabled: 'True' } : {};
}

/**
 * Consistency of a template tree: unique numbers, every parent present and
 * listed before its children, known categories, a sub-account's category
 * equal to its parent's when both are set (03a 1.6
 * strAccountCategoryDifferentFromParent). Returns the problems found.
 */
export function checkChartTemplate(accounts: TemplateAccount[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, TemplateAccount>();
  const known = new Set(ACCOUNT_CATEGORIES.map((c) => c.id));
  for (const a of accounts) {
    if (seen.has(a.number)) problems.push(`${a.number}: duplicate number`);
    if (!a.description.trim()) problems.push(`${a.number}: empty description`);
    const parent = a.parentNumber === '0' ? null : seen.get(a.parentNumber);
    if (a.parentNumber !== '0' && !parent) problems.push(`${a.number}: parent ${a.parentNumber} missing or listed later`);
    if (a.categoryId != null && !known.has(a.categoryId)) problems.push(`${a.number}: unknown category ${a.categoryId}`);
    if (parent?.categoryId != null && a.categoryId != null && parent.categoryId !== a.categoryId) {
      problems.push(`${a.number}: category ${a.categoryId} differs from parent ${parent.number} (${parent.categoryId})`);
    }
    seen.set(a.number, a);
  }
  return problems;
}

/** Tree level of a template account as Delta counts it (root = 1, classes = 2). */
export function templateLevel(account: TemplateAccount, byNumber: Map<string, TemplateAccount>): number {
  let level = 2;
  for (let p = account.parentNumber; p !== '0'; p = byNumber.get(p)?.parentNumber ?? '0') level++;
  return level;
}
