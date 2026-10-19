import { ACCOUNT_CATEGORIES, type ChartTemplateType } from '../categories.ts';
import { BUDGET_CHART } from './chartBudget.ts';
import { COMMERCIAL_CHART, parseChartTemplate, type TemplateAccount } from './chartCommercial.ts';
import { NON_PROFIT_CHART } from './chartNonProfit.ts';

/** Template text per ChartOfAccountsType (01a 7, 03a 1.3). */
export const CHART_TEMPLATE_TEXT: Record<ChartTemplateType, string> = {
  commercial: COMMERCIAL_CHART,
  nonProfit: NON_PROFIT_CHART,
  budget: BUDGET_CHART,
};

export const CHART_TEMPLATE_TYPES: readonly ChartTemplateType[] = ['commercial', 'nonProfit', 'budget'];

const parsed = new Map<ChartTemplateType, TemplateAccount[]>();

/** Parsed template accounts in file order (a parent always precedes its children). */
export function chartTemplateAccounts(type: ChartTemplateType): TemplateAccount[] {
  let list = parsed.get(type);
  if (!list) parsed.set(type, (list = parseChartTemplate(CHART_TEMPLATE_TEXT[type])));
  return list;
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
