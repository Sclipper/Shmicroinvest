import { VAT_MESSAGES } from './vat/constants.ts';

/**
 * Messages of the shell's "Съобщения" panel (06 2.1 ContextMessagePanelRegion)
 * and of the chart-of-accounts entry point (03a 1.1, 1.4).
 */
export const SHELL_MESSAGES = {
  strVATAccountMissing: VAT_MESSAGES.strVATAccountMissing,
  /** Rebuild key and text: the threshold check of 03a 3.3 has no dictionary text in the spec. */
  strVATRegistrationTurnoverReached: 'Оборотът за последните 12 месеца е {0} {2} и достига прага от {1} {2} за задължителна регистрация по ЗДДС.',
  /** The spec quotes only the start ("Не е избран тип на сметкоплан! ..."); the rest is a rebuild text. */
  strChartOfAccountsNotDefined: 'Не е избран тип на сметкоплан! Моля, изберете тип на сметкоплана и сметките, които да бъдат прехвърлени в индивидуалния сметкоплан.',
  strSelectChartOfAccountsNotAllowed: 'Нямате права за избор на тип сметкоплан!',
  strSelectedAccountsExistWarning: 'Има избрани сметки, които не са прехвърлени в индивидуалния сметкоплан. Желаете ли да продължите?',
} as const;
export type ShellMessageKey = keyof typeof SHELL_MESSAGES;

export type NoticeLevel = 'info' | 'warning' | 'error';
export interface ShellNotice {
  key: string;
  level: NoticeLevel;
  text: string;
  /** Screen that deals with the notice. */
  screen?: string;
  screenLabel?: string;
}

const fill = (t: string, ...args: (string | number)[]) => t.replace(/\{(\d)\}/g, (_, i: string) => String(args[Number(i)] ?? ''));

/** Roles of the VAT accounts in the order of the message (02b 20 step 1). */
export const VAT_ACCOUNT_ROLES = [
  { role: 'purchases', category: 16, label: 'Начислен данък за покупките' },
  { role: 'sales', category: 17, label: 'Начислен данък за продажбите' },
  { role: 'refund', category: 35, label: 'ДДС за възстановяване' },
  { role: 'payable', category: 36, label: 'ДДС за внасяне' },
] as const;

/** strVATAccountMissing at start-up: the VAT account categories without an account in the active chart. */
export function vatAccountMissingNotice(presentCategories: Iterable<number>): ShellNotice | null {
  const have = new Set(presentCategories);
  const missing = VAT_ACCOUNT_ROLES.filter((r) => !have.has(r.category)).map((r) => r.label);
  if (!missing.length) return null;
  return { key: 'strVATAccountMissing', level: 'error', text: `${SHELL_MESSAGES.strVATAccountMissing} ${missing.join(', ')}`, screen: 'chart', screenLabel: 'Индивидуален сметкоплан' };
}

/**
 * VAT registration threshold (03a 3.3, 02b 12): a company that is neither
 * registered nor marked "не подлежи на регистрация" is told when the
 * 12-month turnover reaches the limit.
 */
export function vatRegistrationNotice(o: { isVat: boolean; isNotVat: boolean; total: string; limit: string; currency: 'BGN' | 'EUR'; exceeded: boolean }): ShellNotice | null {
  if (o.isVat || o.isNotVat || !o.exceeded) return null;
  const cur = o.currency === 'EUR' ? 'EUR' : 'лв.';
  return {
    key: 'strVATRegistrationTurnoverReached', level: 'warning',
    text: fill(SHELL_MESSAGES.strVATRegistrationTurnoverReached, o.total, o.limit, cur),
    screen: 'myCompany', screenLabel: 'Моята фирма',
  };
}
