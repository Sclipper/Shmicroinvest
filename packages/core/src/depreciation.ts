import { BGN_PER_EUR, D, dec, round2, roundHalfEven, sum, ZERO, type Dec, type DecInput } from './money.ts';
import type { ValidationMessage } from './journal.ts';

/**
 * Fixed assets (ДМА / ДНМА) and depreciation (spec 03b).
 *
 * Pure rules: tax categories and rates (3), the start-month rule (5.3), the
 * straight-line schedule generator with truncated quotas and the remainder in
 * the last month (5.4), re-spreading over processed months (5.4 step 4), IAS
 * mode (9.1 path A / 9.2), conservation windows (10), year percentages and the
 * derived method (5.1, Z79/Z88), validations (3.3, 7), write-off entries (11),
 * revaluation rules (9.2), improvement rules (9.1) and the EUR conversion (13).
 *
 * Months are ISO dates of the first day of the month ("2025-04-01").
 */

/* ------------------------------------------------------------------ */
/* Enumerations                                                        */
/* ------------------------------------------------------------------ */

export const DEPRECIATION_CATEGORY = {
  Buildings: 1, Machines: 2, Transport: 3, Computers: 4, Vehicles: 5, Intangibles: 6, Other: 7, LandAndForests: 8,
} as const;

export const DEPRECIATION_METHOD = { Linear: 1, Custom: 2, Progressive: 3, Degressive: 4 } as const;

export const TERMINATION = { NotTerminated: 1, NoOperation: 2, Wasted: 3, Sold: 4, Expired: 5 } as const;

/** Preset values of the annual-rate combo (enum DepreciationPercentagePerYear). 0 = "Земи, гори" (not applied). */
export const RATE_PRESETS = [4, 10, 15, 25, 30, 50] as const;
export const RATE_NOT_APPLIED = 0;

/** Maximum annual tax rate per ЗКПО category (3.1). */
export const CATEGORY_MAX_RATE: Record<number, string> = {
  1: '4', 2: '30', 3: '10', 4: '50', 5: '25', 6: '33.333333333333333333333333333', 7: '15', 8: '0',
};
export const DEFAULT_MAX_RATE = '50';

export function maxRateForCategory(categoryId: number | null | undefined): Dec {
  return dec(categoryId != null && CATEGORY_MAX_RATE[categoryId] !== undefined ? CATEGORY_MAX_RATE[categoryId]! : DEFAULT_MAX_RATE);
}

/* ------------------------------------------------------------------ */
/* Messages (keys from Dictionary.resx; texts per spec 03b)            */
/* ------------------------------------------------------------------ */

export const ASSET_MESSAGES = {
  // 03b 4: Delta defines the key, its text is not in the spec.
  strDepreciationsAccountingAndTaxDepreciationDiffer: 'Счетоводният и данъчният амортизационен план се различават по основни параметри ({0}). Желаете ли да запишете актива?',
  strAssetNameIsMissing: 'Не е попълнено име на актива',
  strAssetInventoryNumberIsMissing: 'Не е попълнен инвентарен номер на актива',
  strAssetInventoryNumberExists: 'Вече има въведен актив със същия инвентарен номер',
  strAssetDebitAccountIsMissing: 'Не е попълнена сметка за амортизация на актива',
  strAssetCreditAccountIsMissing: 'Не е попълнена сметка за разходи за амортизация на актива',
  strAssetInventoryAccountIsMissing: 'Не е попълнена сметка, в която се води актива',
  strDebitAssetAccountHasSubAccounts: 'Сметката за амортизация на актива има подсметки',
  strCreditAssetAccountHasSubAccounts: 'Сметката за разходи за амортизация на актива има подсметки',
  strInventoryAssetAccountHasSubAccounts: 'Сметката, в която се води актива, има подсметки',
  strAssetDepreciationCategoryIsEmpty: 'Не е попълнена категория по ЗКПО',
  strFixedAssetCannotBeSaved: 'Актив с инвентарен номер {0} не може да бъде запазен поради следните грешки:',
  strFixedAssetWontBeSaved: 'Активът няма да бъде записан.',
  strTheMadeChangeInAssetPlanIsDifferentFromAccountings: 'Направената промяна в счетоводен амортизационен план се различава от осчетоводените отчисления:',
  strDepreciationMonthWithAccounting: 'Амортизационно отчисление от месец {0} с контиране №{1}',
  strShalliDeleteTheOperations: 'Желаете ли изтриване на изброените операции?',
  strDeleteAllConnectionBetweenPlanAndDepreciation: 'Внимание, връзката между амортизационния план и контировките ще бъде изтрита!',
  strSaveNotCompleted: 'Внимание, записът не беше осъществен!',
  strLockedMonth: 'Месец {0} е заключен',
  strRevaluationReserveIsDifferentFromZero: 'ВНИМАНИЕ! Ще направите запис на актив, за който е правена "Промяна на дълготраен актив по МСС"! Данните за преоценката или подобрението ще бъдат загубени! Желаете ли да продължите?',
  strCantEditAssetDueToAssetTermination: 'Избраният дълготраен актив не може да бъде редактиран, тъй като е отписан!',
  strFixedAssetAccountingAttachedError: 'Има извършени контирания към този дълготраен актив! Операцията не може да бъде извършена!',
  strConfirmFixedAssetVoid: 'Желаете ли да анулирате избрания дълготраен актив?',
  strTerminatedAssetConfirmation: 'Към избрания актив има извършена операция за отписване (контиране №{0}). Желаете ли да продължите?',
  strConfirmRestoreTerminatedAsset: 'Желаете ли да върнете избрания актив?',
  strSyncAndCopyDepreciationsConfirmation: 'Желаете ли синхронизиране на данъчния и счетоводния амортизационен план?',
  strCopyFromAccountingDepreciationConfirmation: 'Всички данни от счетоводния амортизационен план ще бъдат копирани в данъчния. Желаете ли да продължите?',
  strDepreciationsAreSynchronisedChangeConflictsWithLockedPeriod: 'Стойността не може да бъде променена, тъй като планът за данъчна амортизация участва в заключен период!',
  strCopyingInDAPCanceled: 'Копирането в данъчния амортизационен план е прекратено поради невалидни стойности.',
  strRemoveImprovementsOnAmountChangedConfirmation: 'При промяна на отчетната стойност всички въведени подобрения ще бъдат изтрити. Желаете ли да продължите?',
  strRemoveSelectedImprovementConfirmation: 'Желаете ли да премахнете избраното подобрение?',
  strAddImprovementAssetAmountNotSet: 'Не е въведена отчетна стойност на актива!',
  strAddImprovementInvalidAmount: 'Новата отчетна стойност трябва да бъде по-голяма от текущата!',
  strAddImprovementInvalidDate: 'За да бъде добавено подобрение, необходимо да има осчетоводено поне едно амортизационно отчисление !',
  strImprovementAmountIsLessThanAmount: 'Стойността на подобрението трябва да бъде по-голяма от текущата отчетна стойност!',
  strImprovementRevaluationDateIsLessThanAcquisitionDate: 'Датата на подобрението не може да бъде преди датата на придобиване!',
  strReevaluationAmountAccountsNotDefined: 'Не са дефинирани сметки в категориите Загуби /разходи/ от обезценка и Приходи от възстановени загуби от обезценка. Моля, дефинирайте ги в индивидуалния сметкоплан.',
  strRevaluationReserveChoice: 'Внимание! Ще бъде извършена преоценка на актив {0} с инвентарен номер {1} от {2}. Желаете ли да продължите?',
  strRevaluationDateIsLessThanAcquisitionDate: 'Датата на преоценката не може да бъде преди датата на придобиване!',
  strAccountingYearFail: 'Датата на операцията е в друга счетоводна година!',
  strNegativeRevaluationReserve: 'Внимание! Въведената преоценена стойност на актива не може да бъде отрицателна!',
  strAmountIsLessThanRevaluationReserve: 'Внимание! Въведената стойност на преоценка на ДА превишава първоначалната му отчетна стойност. Операцията не може да бъде извършена.',
  strZeroReevaluationSumError: 'Сумата на преоценката е нула! Операцията не може да бъде извършена.',
  strInvalidAccountNumber: 'Невалиден номер на сметка!',
  strInternationalAccountingStandard: 'Преоценка по МСС',
  strDepreciation: 'Амортизация',
  strAccountingRequestPrompt: 'Желаете ли да се извърши осчетоводяване на избраните заявки?',
  strAccountingRequestsFromAnotherYearFound: 'Има избрани заявки от друга счетоводна година. Те няма да бъдат обработени!',
  strDepreciationScheduleAttachedWarning: 'Избраният документ е генериран от амортизационен план. Моля, коригирайте амортизационния план. Желаете ли продължение?',
  strVoidAccountingWithFixedAsset: 'Избраният документ е автоматична операция за отписване на ДМА. Желаете ли продължение?',
  strInvalidAssetExpiredOperationSelected: 'Балансовата стойност на актива е по-голяма от 0 (дата на изхабяване {0}). Активът не може да бъде отписан с операция изхабяване',
  strInvalidAssetTerminationDateSAP_AccountingYear: 'Датата на отписване от САП ({0}) не може да е в друга счетоводна година',
  strInvalidAssetTerminationDateDAP_AccountingYear: 'Датата на отписване от ДАП ({0}) не може да е в друга счетоводна година',
  strInvalidAssetWasteOperationAccount: 'Не е избрана сметка за разход',
  strInvalidAssetSaleOperationAccount: 'Не е избрана сметка за приход',
  strInvalidCreditAccountHasSubAccounts: 'Невалидна сметка! Сметката за приход има подсметки',
  strInvalidDebitAccountHasSubAccounts: 'Невалидна сметка! Сметката за разход има подсметки',
  strInvalidRevaluationAccountHasSubAccounts: 'Невалидна сметка! Сметката за преоценка има подсметки',
  strMissingRevaluationAccount: 'Не е избрана сметка за преоценка',
  strInvalidAssetProfitAmount: 'Не е въведена сума на прихода',
  strFixedAssetOperationReference: '{0}, Инв. номер {1}',
  strFixedAssetOperationTermWasted: 'Бракуване на дълготраен актив',
  strFixedAssetOperationTermSold: 'Продажба на дълготраен актив',
  strFixedAssetOperationTermExpired: 'Изхабяване на дълготраен актив',
  strPercentageEqualsZero: 'Годишната амортизационна норма не може да бъде 0%!',
  strPercentageMoreThanFifty: 'Годишната амортизационна норма не може да бъде по-голяма от 50%!',
  strAttentionThereAreAccountingsInTheseFixedAssets: 'Внимание! Към следните активи има начислени амортизации през текущата година:',
  strAttentionLandAndForests: 'Внимание! Следните активи са от категория "Земи и гори" и няма да бъдат променени:',
  strAttentionStartInLaterYear: 'Внимание! Следните активи са въведени в експлоатация в следваща счетоводна година и няма да бъдат променени:',
  strAttentionWornOutInOtherYear: 'Внимание! Следните активи са изхабени в друга счетоводна година и няма да бъдат променени:',
  strAttentionYouWillChangePercentageInSapDeprOfSomeAssets: 'Внимание! Ще бъде променена годишната норма в счетоводния амортизационен план на избраните активи от 01.01.{0}г. Желаете ли да продължите?',
  strAttentionYouWillChangePercentageInTaxDeprOfSomeAssets: 'Внимание! Ще бъде променена годишната норма в данъчния амортизационен план на избраните активи от 01.01.{0}г. Желаете ли да продължите?',
  strConnectionBetweenSAPandAccountingsWillBeDeleted: 'Връзката между счетоводния амортизационен план и осчетоводените отчисления ще бъде изтрита!',
  strAutomaticApplicationDateChangeWillBeDone: 'Ще бъде извършена автоматична промяна на датата на приложението към 01.01.{0}г. След приключване на операцията е необходима ръчна корекция на датата.',
  strNoFixedAssetsError: 'Всички дълготрайни активи и амортизационни отчисления са отразени коректно в счетоводството.',
  strDepreciationAmountMismatchHeader: 'Несъответствие между отчетната стойност на активите и салдата на сметките:',
  strAccruedDepreciationMismatchHeader: 'Несъответствие между начислените амортизации и салдата на сметките:',
  strAccountDebitLine: 'Сметка {0}: отчетна стойност {1}, крайно дебитно салдо {2}',
  strAccountCreditLine: 'Сметка {0}: начислени амортизации {1}, крайно кредитно салдо {2}',
  strDifferenceFormat: 'Разлика: {0}',
  strLocationHasAssets: 'Местоположението съдържа дълготрайни активи и не може да бъде изтрито!',
  strLocationHasChildren: 'Местоположението съдържа подгрупи и не може да бъде изтрито!',
  strLocationRootCannotBeDeleted: 'Основното местоположение не може да бъде изтрито!',
  strLocationNameIsEmpty: 'Не е въведено име на местоположението!',
} as const;

export type AssetMessageKey = keyof typeof ASSET_MESSAGES;

/** Plan-level validation suffixes (7). Keys: strAccountingDepreciation{suffix} / strTaxDepreciation{suffix}. */
export const PLAN_MESSAGES = {
  AmountIsMissing: 'Не е въведена отчетна стойност на актива',
  InvalidStartDate: 'Датата на въвеждане в експлоатация не може да бъде преди датата на придобиване',
  InvalidEndDate: 'Датата на изхабяване трябва да бъде след датата на въвеждане в експлоатация',
  PeriodLengthIsMissing: 'Не е въведен полезен срок на годност за актива',
  InvalidPeriodLength: 'Полезният срок на годност за актива не може да е по-малък от 12 месеца',
  InvalidConservationPeriod: 'Невалиден период на консервация',
  NoDateForSumByDate: 'Не е въведена дата към която са начислените амортизации',
  ZeroSumByDate: 'Не е въведена сума на начислените амортизации към дата',
  InvalidSumByDate: 'Сумата на начислените амортизации не може да бъде по-голяма от отчетната стойност',
  SumByLastProcessedDateReachedTotal: 'Сумата на начислените амортизации е достигнала пълната отчетна стойност преди датата на изхабяване',
  AmountByDateDoesNotMatchSchedule: 'Сумата на начислените амортизации не съответства на сумата от амортизационния план към датата',
  ScheduleIsMissing: 'Не е съставен амортизационен план',
  ScheduleSumDoesNotMatchAssetAmount: 'Общата сума от амортизационния план не съответства на въведената отчетна стойност на актива (разлика: {0})',
  MonthFromLockedPeriodWithDifferingAmount: 'Месец {0} от заключен период е осчетоводен с различна сума',
  AccountingToDelete: 'Осчетоводеното отчисление за месец {0} (контиране №{1}) ще бъде променено или изтрито',
} as const;
export type PlanMessageSuffix = keyof typeof PLAN_MESSAGES;

export const YEAR_PERCENTAGE_EXCEEDS =
  'Данъчни амортизации: амортизационният план съдържа поне една година с норма надвишаваща максимално допустимата за избраната категория по ЗКПО ({0}%)';

export const PLAN_PREFIX = { accounting: 'Счетоводни амортизации: ', tax: 'Данъчни амортизации: ' } as const;

export function fmtMsg(text: string, ...args: (string | number)[]): string {
  return text.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
}

/** Status-bar text while a plan is generated (03b 5.2). */
export const strCreatingDepreciationSchedule = 'Съставяне на амортизационен план...';

/**
 * Month cell states of the plan grid (`strDepreciationMonthStatus*`, 03b 6.1):
 * Normal (unposted), Accounted, accounted with a different amount, read-only
 * (closed year / locked period) and Disabled (no depreciation charge, e.g. a
 * month outside the plan or inside a conservation window).
 */
export type DepreciationMonthStatus = 'normal' | 'posted' | 'postedDifferent' | 'readOnly' | 'disabled';
export const DEPRECIATION_MONTH_STATUS = {
  normal: 'Нормално',
  posted: 'Осчетоводено',
  postedDifferent: 'Осчетоводено',
  readOnly: 'Само за четене',
  disabled: 'Няма амортизационно отчисление за този месец',
} as const satisfies Record<DepreciationMonthStatus, string>;
export const DEPRECIATION_MONTH_DETAIL = {
  posted: 'с контиране №{0} от дата {1}',
  postedDifferent: 'има контиране №{0}, с различна сума ({1:F2})',
  readOnly: 'от приключена година или заключен период',
} as const;

/** Tooltip of a month cell: the state and its detail ({1:F2} = two decimals, bg-BG comma). */
export function depreciationMonthTooltip(m: { status: DepreciationMonthStatus; accountingNumber?: string | null; accountingDate?: string | null; postedAmount?: DecInput | null }): string {
  const f2 = (v: DecInput | null | undefined) => dec(v ?? 0).toFixed(2).replace('.', ',');
  switch (m.status) {
    case 'posted':
      return `${DEPRECIATION_MONTH_STATUS.posted} ${fmtMsg(DEPRECIATION_MONTH_DETAIL.posted, m.accountingNumber ?? '', m.accountingDate ? dateBg(m.accountingDate) : '')}`;
    case 'postedDifferent':
      return `${DEPRECIATION_MONTH_STATUS.postedDifferent}, ${fmtMsg(DEPRECIATION_MONTH_DETAIL.postedDifferent.replace('{1:F2}', '{1}'), m.accountingNumber ?? '', f2(m.postedAmount))}`;
    case 'readOnly':
      return `${DEPRECIATION_MONTH_STATUS.readOnly}, ${DEPRECIATION_MONTH_DETAIL.readOnly}`;
    default:
      return DEPRECIATION_MONTH_STATUS[m.status];
  }
}

export function assetMessage(key: AssetMessageKey, severity: 'critical' | 'warning' = 'critical', ...args: (string | number)[]): ValidationMessage {
  return { key, text: fmtMsg(ASSET_MESSAGES[key], ...args), severity };
}

export function planMessage(isAccounting: boolean, suffix: PlanMessageSuffix, severity: 'critical' | 'warning' = 'critical', ...args: (string | number)[]): ValidationMessage {
  const key = (isAccounting ? 'strAccountingDepreciation' : 'strTaxDepreciation') + suffix;
  return { key, text: (isAccounting ? PLAN_PREFIX.accounting : PLAN_PREFIX.tax) + fmtMsg(PLAN_MESSAGES[suffix], ...args), severity };
}

/* ------------------------------------------------------------------ */
/* Month arithmetic                                                    */
/* ------------------------------------------------------------------ */

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Month index (year * 12 + month - 1) of an ISO date. */
export const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
/** First day of the month with the given index. */
export const monthOf = (index: number) => `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}-01`;
/** First day of the month of an ISO date. */
export const firstOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`;
/** Last day of the month of an ISO date. */
export function endOfMonth(iso: string) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return `${iso.slice(0, 7)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}
export const addMonths = (iso: string, n: number) => monthOf(monthIndex(iso) + n);
/** DateTimeExtension.DifferenceInMonths: (a.Year - b.Year) * 12 + a.Month - b.Month, day ignored. */
export const monthsBetween = (a: string, b: string) => monthIndex(a) - monthIndex(b);
/** "MM.yyyy" label. */
export const monthLabelBg = (iso: string) => `${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
export const dateBg = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export const NO_END_DATE = '9999-12-31';

/* ------------------------------------------------------------------ */
/* Rate <-> useful life (3.2)                                          */
/* ------------------------------------------------------------------ */

/** months = Truncate(years) * 12 + Round((years - Truncate(years)) * 12) with years = 100 / percent (banker's rounding). */
export function monthsFromRate(percent: DecInput): number {
  const p = dec(percent);
  if (p.lte(0)) return 0;
  const years = new D(100).div(p);
  const whole = years.trunc();
  return whole.toNumber() * 12 + roundHalfEven(years.minus(whole).times(12), 0).toNumber();
}

/** percent = 100 / (months / 12), full precision. */
export function rateFromMonths(months: number): Dec {
  return months > 0 ? new D(100).div(new D(months).div(12)) : ZERO;
}

/** Truncate to cents (Math.Truncate(x * 100) / 100). */
export const trunc2 = (v: DecInput) => dec(v).toDecimalPlaces(2, D.ROUND_DOWN);

/* ------------------------------------------------------------------ */
/* Start-month rule (5.3)                                              */
/* ------------------------------------------------------------------ */

/** IsStartMonthIncluded = NOT IsAccounting AND NOT AreDepreciationsSynchronized. */
export const isStartMonthIncluded = (isAccounting: boolean, synchronized: boolean) => !isAccounting && !synchronized;

/** First scheduled month: the commissioning month when included, else the month after. */
export const firstScheduledMonth = (startDate: string, included: boolean) => addMonths(firstOfMonth(startDate), included ? 0 : 1);

/* ------------------------------------------------------------------ */
/* Schedule generation (5.4)                                           */
/* ------------------------------------------------------------------ */

export interface MonthAmount {
  month: string;
  amount: Dec;
}

export interface ScheduleRow extends MonthAmount {
  isProcessed: boolean;
}

export interface PlanParams {
  isAccounting: boolean;
  /** 5.3: true only for an unsynchronised tax plan. */
  startMonthIncluded: boolean;
  depreciableAmount: DecInput;
  /** Sum of the year reserves (accounting plan only; normally <= 0). */
  revaluationReserve?: DecInput;
  /** Commissioning date (Дата на въвеждане). */
  startDate: string;
  /** Useful life in months. */
  activePeriodLength: number;
  /** LP (4.1); defaults to the start date (nothing processed). */
  lastProcessedDate?: string | null;
  /** Accrued amount up to LP. */
  amountByLastProcessedDate?: DecInput;
  /** Amounts of the already processed months (<= LP); when absent they are rebuilt from the accrued amount (plan2). */
  processedMonths?: MonthAmount[] | null;
  /** 8: months before this date are read-only and are kept as they are. */
  firstEditableMonthDate?: string | null;
  /** Existing months before firstEditableMonthDate. */
  lockedMonths?: MonthAmount[] | null;
  /** Conservation window (start = first suspended month, end = first month depreciation resumes). */
  conservation?: { start: string; end: string } | null;
  /** IAS mode (improvement from the IAS dialog, revaluation): keep the life and the end date, re-spread the remainder. */
  iasMode?: boolean;
}

export interface GeneratedSchedule {
  rows: ScheduleRow[];
  /** First day of the last scheduled month, or 9999-12-31 without a schedule. */
  endDate: string;
  /** EstimatedMonthAmount (Truncate(B / N, 2)). */
  estimate: Dec;
  /** Base of the schedule: DA (+ reserve for the accounting plan). */
  base: Dec;
  /** Whether the conservation window was applied. */
  conservationApplied: boolean;
}

/** Base of the schedule (4.1): accounting = DA + reserve, tax = DA. */
export function scheduleBase(p: Pick<PlanParams, 'isAccounting' | 'depreciableAmount' | 'revaluationReserve'>): Dec {
  return p.isAccounting ? dec(p.depreciableAmount).plus(dec(p.revaluationReserve)) : dec(p.depreciableAmount);
}

/** Spreads `total` over `count` months: Truncate(total / count, 2) each, remainder in the last one. */
export function spread(total: DecInput, count: number): Dec[] {
  if (count <= 0) return [];
  const t = dec(total);
  const est = trunc2(t.div(count));
  const out = Array.from({ length: count }, () => est);
  out[count - 1] = t.minus(est.times(count - 1));
  return out;
}

/**
 * RecalculateSchedule + Z134 (5.4). Net effect: every month = est, the last
 * month = B - (N - 1) * est; conservation months get no row and push the end;
 * with processed months outside IAS mode the quota is kept and the plan length
 * changes (appended or trimmed months, defect D3 compatible); in IAS mode the
 * length is kept and the quota of the remaining months changes.
 */
export function generateSchedule(p: PlanParams): GeneratedSchedule {
  const base = scheduleBase(p);
  const start = firstOfMonth(p.startDate);
  const included = p.startMonthIncluded;
  const first = monthIndex(start) + (included ? 0 : 1);
  const lp = p.lastProcessedDate ?? p.startDate;
  const lpIdx = monthIndex(lp);
  const lpAfterStart = monthsBetween(lp, p.startDate) >= 1;
  const nDone = Math.max(0, monthsBetween(lp, p.startDate) + (included ? 1 : 0));
  const accrued = dec(p.amountByLastProcessedDate);
  const life = p.activePeriodLength;
  const empty: GeneratedSchedule = { rows: [], endDate: NO_END_DATE, estimate: ZERO, base, conservationApplied: false };
  if (!life || life <= 0) return empty;

  // Processed months (first .. LP): existing amounts or plan2 from the accrued amount.
  const processedCount = lpAfterStart || included ? Math.max(0, lpIdx - first + 1) : 0;
  const processed: MonthAmount[] = [];
  if (processedCount > 0) {
    if (p.processedMonths?.length) {
      for (const m of p.processedMonths) if (monthIndex(m.month) <= lpIdx && monthIndex(m.month) >= first) processed.push({ month: firstOfMonth(m.month), amount: dec(m.amount) });
      processed.sort((a, b) => monthIndex(a.month) - monthIndex(b.month));
    } else if (!accrued.isZero()) {
      spread(accrued, processedCount).forEach((amount, i) => processed.push({ month: monthOf(first + i), amount }));
    }
  }

  let B = base;
  let N = life;
  let genFirst = first;
  let prefix: MonthAmount[] = [];
  if (p.iasMode) {
    B = B.minus(accrued);
    N = life - nDone;
    genFirst = Math.max(first, lpIdx + 1);
    prefix = processed;
  } else if (p.firstEditableMonthDate) {
    const lockN = monthsBetween(p.firstEditableMonthDate, monthOf(first));
    if (lockN > 0) {
      const lockIdx = monthIndex(p.firstEditableMonthDate);
      prefix = (p.lockedMonths ?? []).filter((m) => monthIndex(m.month) < lockIdx).map((m) => ({ month: firstOfMonth(m.month), amount: dec(m.amount) }));
      B = B.minus(sum(prefix.map((m) => m.amount)));
      genFirst = first + lockN;
      N -= lockN;
    }
  }

  const est = N > 0 ? trunc2(B.div(N)) : ZERO;
  const cons = p.conservation;
  const consOn = Boolean(cons?.start && cons?.end && lpAfterStart
    && monthIndex(cons.start) > first && monthIndex(cons.start) < first + life);
  const cs = consOn ? monthIndex(cons!.start) : -1;
  const ce = consOn ? monthIndex(cons!.end) : -1;

  const generated: MonthAmount[] = [];
  if (N > 0 && est.gt(0) && B.gt(0)) {
    let m = genFirst;
    let left = N;
    while (left > 0) {
      if (consOn && m >= cs && m < ce) {
        m++;
        continue;
      }
      generated.push({ month: monthOf(m), amount: left === 1 ? B.minus(est.times(N - 1)) : est });
      left--;
      m++;
    }
  }
  if (!generated.length && !prefix.length) return empty;

  let rows: MonthAmount[] = [...prefix, ...generated];

  // Step 4: re-spread when months are already processed (outside IAS mode).
  if (!p.iasMode && lpAfterStart && nDone > 0 && generated.length) {
    const onLine = accrued.times(life).eq(base.times(nDone));
    if (!onLine) {
      const stepSum = sum(rows.filter((r) => monthIndex(r.month) <= lpIdx).map((r) => r.amount));
      let diff = stepSum.minus(accrued);
      const procByMonth = new Map(processed.map((m) => [m.month, m.amount]));
      rows = rows.map((r) => (monthIndex(r.month) <= lpIdx ? { month: r.month, amount: procByMonth.get(r.month) ?? r.amount } : r));
      const last = rows[rows.length - 1]!;
      if (monthIndex(last.month) > lpIdx) {
        diff = diff.plus(last.amount.minus(est));
        rows[rows.length - 1] = { month: last.month, amount: est };
      }
      if (diff.gt(0)) {
        let m = monthIndex(rows[rows.length - 1]!.month) + 1;
        while (diff.gt(0)) {
          if (consOn && m >= cs && m < ce) {
            m++;
            continue;
          }
          const a = D.min(est, diff);
          rows.push({ month: monthOf(m), amount: a });
          diff = diff.minus(a);
          m++;
        }
      } else if (diff.lt(0)) {
        for (let i = rows.length - 1; i >= 0 && diff.lt(0); i--) {
          const r = rows[i]!;
          if (monthIndex(r.month) <= lpIdx) break;
          if (r.amount.plus(diff).gt(0)) {
            rows[i] = { month: r.month, amount: r.amount.plus(diff) };
            diff = ZERO;
          } else {
            diff = diff.plus(r.amount);
            rows.splice(i, 1);
          }
        }
      }
    }
  }

  const out: ScheduleRow[] = rows.map((r) => ({ month: r.month, amount: r.amount, isProcessed: p.isAccounting ? monthIndex(r.month) <= lpIdx && lpAfterStart : true }));
  return { rows: out, endDate: out.length ? out[out.length - 1]!.month : NO_END_DATE, estimate: est, base, conservationApplied: consOn };
}

/* ------------------------------------------------------------------ */
/* Year plans, method (Z79, Z88)                                       */
/* ------------------------------------------------------------------ */

export interface YearPlan {
  year: number;
  /** Annual rate actually achieved (yearSum / activeMonths * 12 / base * 100). */
  percentage: Dec;
  amount: Dec;
  activeMonths: number;
}

export function yearPlans(rows: MonthAmount[], base: DecInput, selectedRate?: DecInput | null): YearPlan[] {
  if (!rows.length) return [];
  const b = dec(base);
  const years = new Map<number, { amount: Dec; n: number }>();
  for (const r of rows) {
    const y = Number(r.month.slice(0, 4));
    const cur = years.get(y) ?? { amount: ZERO, n: 0 };
    years.set(y, { amount: cur.amount.plus(r.amount), n: cur.n + 1 });
  }
  const ys = [...years.keys()];
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const out: YearPlan[] = [];
  for (let y = minY; y <= maxY; y++) {
    const v = years.get(y);
    const pct = v && v.n > 0 && !b.isZero() ? v.amount.div(v.n).times(12).div(b).times(100) : null;
    out.push({ year: y, percentage: pct ?? ZERO, amount: v?.amount ?? ZERO, activeMonths: v?.n ?? 0 });
  }
  // A year without an active month copies the next year's percentage (or the selected rate).
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.activeMonths === 0) out[i]!.percentage = out[i + 1]?.percentage ?? dec(selectedRate);
  }
  return out;
}

/** Z88: Custom when any year's Round(Percentage, 2) differs from the first year's, else Linear (defect D4 compatible). */
export function deriveMethod(plans: YearPlan[]): number {
  if (!plans.length) return DEPRECIATION_METHOD.Linear;
  const first = roundHalfEven(plans[0]!.percentage, 2);
  return plans.some((p) => !roundHalfEven(p.percentage, 2).eq(first)) ? DEPRECIATION_METHOD.Custom : DEPRECIATION_METHOD.Linear;
}

/** Year-amount edit (DepreciationYearViewModel.Z16): Truncate(year / n) per month, the last month takes the rest. */
export function redistributeYear(yearAmount: DecInput, activeMonths: number): Dec[] {
  return spread(yearAmount, activeMonths);
}

/** Z87: preset when the rate is an integer preset, else Custom (-1); 0 = not applied. */
export function rateSelection(rate: DecInput | null | undefined): number {
  const r = dec(rate);
  if (r.isZero()) return RATE_NOT_APPLIED;
  const preset = RATE_PRESETS.find((x) => r.eq(x));
  return preset ?? -1;
}

/* ------------------------------------------------------------------ */
/* Last processed date (4.1, Z127)                                     */
/* ------------------------------------------------------------------ */

export interface StoredRow {
  month: string;
  amount: DecInput;
  isProcessed: boolean;
  /** Accounting date of the linked posting, if any. */
  accountingDate?: string | null;
}

/** САП: posting date of the last processed row; its MonthDate when unposted; none -> StartDate. */
export function accountingLastProcessedDate(rows: StoredRow[], startDate: string): string {
  const processed = rows.filter((r) => r.isProcessed).sort((a, b) => monthIndex(a.month) - monthIndex(b.month));
  const last = processed[processed.length - 1];
  if (!last) return startDate;
  return last.accountingDate ?? firstOfMonth(last.month);
}

/** ДАП: end of the month of the last row with MonthDate <= application date; none -> StartDate. */
export function taxLastProcessedDate(rows: StoredRow[], startDate: string, applicationDate: string): string {
  const appIdx = monthIndex(applicationDate);
  const before = rows.filter((r) => monthIndex(r.month) <= appIdx && r.month <= applicationDate).sort((a, b) => monthIndex(a.month) - monthIndex(b.month));
  const last = before[before.length - 1];
  return last ? endOfMonth(last.month) : startDate;
}

/** AmountByLastProcessedDate = sum of rows with MonthDate <= LP. */
export function amountByDate(rows: { month: string; amount: DecInput }[], date: string): Dec {
  return sum(rows.filter((r) => r.month <= date).map((r) => r.amount));
}

/** FirstEditableMonthDate (8): 1 January after the last locked financial year, else the commissioning date. */
export function firstEditableMonthDate(lastLockedYear: number | null | undefined, startDate: string): string {
  return lastLockedYear ? `${lastLockedYear + 1}-01-01` : startDate;
}

/* ------------------------------------------------------------------ */
/* Plan validation (3.1, 3.3, 5.4, 7, 10)                              */
/* ------------------------------------------------------------------ */

export interface PlanForValidation {
  isAccounting: boolean;
  /** Rate 0 = not applied (land, non-depreciable): no schedule, no life checks. */
  notApplied: boolean;
  depreciationAmount: DecInput;
  nonDepreciableAmount: DecInput;
  revaluationReserve?: DecInput;
  acquisitionDate: string;
  startDate: string;
  endDate: string;
  activePeriodLength: number | null;
  conservation?: { start: string | null; end: string | null } | null;
  lastProcessedDate: string;
  /** Manually typed accrued-to-date (Начислени амортизации + Към дата). */
  manualAccrued?: { date: string | null; amount: DecInput | null } | null;
  accrued: DecInput;
  rows: MonthAmount[];
  categoryId?: number | null;
  startMonthIncluded: boolean;
}

export function canApplyConservation(p: Pick<PlanForValidation, 'conservation' | 'lastProcessedDate' | 'startDate' | 'endDate'>): boolean {
  const c = p.conservation;
  if (!c?.start || !c.end) return false;
  if (!p.endDate || p.endDate === NO_END_DATE) return false;
  if (monthsBetween(p.lastProcessedDate, p.startDate) < 1) return false;
  if (monthIndex(c.start) < monthIndex(p.startDate)) return false;
  return monthIndex(c.end) <= monthIndex(p.endDate);
}

export function validatePlan(p: PlanForValidation): ValidationMessage[] {
  const out: ValidationMessage[] = [];
  const crit = (s: PlanMessageSuffix, ...a: (string | number)[]) => out.push(planMessage(p.isAccounting, s, 'critical', ...a));
  const da = dec(p.depreciationAmount).minus(dec(p.nonDepreciableAmount));
  const amount = p.isAccounting ? da.plus(dec(p.revaluationReserve)) : da;
  if (amount.isZero()) crit('AmountIsMissing');
  if (p.startDate < p.acquisitionDate) crit('InvalidStartDate');
  if (p.notApplied) return out;
  if (p.endDate <= p.startDate) crit('InvalidEndDate');
  if (!p.activePeriodLength) crit('PeriodLengthIsMissing');
  else if (p.activePeriodLength < 12) crit('InvalidPeriodLength');
  if (p.conservation && !canApplyConservation(p)) crit('InvalidConservationPeriod');
  if (p.manualAccrued) {
    const hasDate = Boolean(p.manualAccrued.date);
    const amt = dec(p.manualAccrued.amount);
    if (!amt.isZero() && !hasDate) crit('NoDateForSumByDate');
    if (hasDate && amt.isZero()) crit('ZeroSumByDate');
    if (amt.gt(amount)) crit('InvalidSumByDate');
    else if (hasDate && !amt.isZero() && amt.eq(amount) && p.manualAccrued.date! < p.endDate) crit('SumByLastProcessedDateReachedTotal');
    if (hasDate && !amt.isZero() && p.rows.length) {
      const bySchedule = amountByDate(p.rows, p.manualAccrued.date!);
      if (!bySchedule.eq(amt)) crit('AmountByDateDoesNotMatchSchedule');
    }
  }
  if (!p.rows.length) crit('ScheduleIsMissing');
  else {
    const diff = amount.minus(sum(p.rows.map((r) => r.amount))).toDecimalPlaces(2, D.ROUND_HALF_UP);
    if (!diff.isZero()) crit('ScheduleSumDoesNotMatchAssetAmount', diff.toFixed(2));
  }
  if (!p.isAccounting && p.rows.length) {
    const max = maxRateForCategory(p.categoryId);
    const plans = yearPlans(p.rows, amount);
    if (plans.some((y) => roundHalfEven(y.percentage, 2).gt(max))) {
      out.push({ key: 'strYearPercentageExceedsMaximumAllowed', text: fmtMsg(YEAR_PERCENTAGE_EXCEEDS, max.toFixed(2)), severity: 'warning' });
    }
  }
  return out;
}

/** Bulk change of common data (14.3): percent 0 or > 50 rejected. */
export function validateCommonPercent(percent: DecInput): ValidationMessage | null {
  const p = dec(percent);
  if (p.isZero()) return assetMessage('strPercentageEqualsZero');
  if (p.gt(50)) return assetMessage('strPercentageMoreThanFifty');
  return null;
}

/**
 * Bulk rate change (EditCommonPercent): months before 1 January of `fromYear`
 * are kept; from then on the monthly quota is Truncate(base * rate / 1200) until
 * the remaining base is used up (the last month takes the rest).
 */
export function changeRateFrom(rows: MonthAmount[], base: DecInput, rate: DecInput, fromYear: number, startMonth: string): MonthAmount[] {
  const from = `${fromYear}-01-01`;
  const kept = rows.filter((r) => r.month < from);
  let remaining = dec(base).minus(sum(kept.map((r) => r.amount)));
  const est = trunc2(dec(base).times(dec(rate)).div(1200));
  const out = [...kept];
  if (est.lte(0)) return out;
  let m = Math.max(monthIndex(from), monthIndex(startMonth));
  while (remaining.gt(0)) {
    const a = D.min(est, remaining);
    out.push({ month: monthOf(m), amount: a });
    remaining = remaining.minus(a);
    m++;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Improvement (9.1, Z75)                                              */
/* ------------------------------------------------------------------ */

export interface ImprovementCheck {
  isAccounting: boolean;
  newAmount: DecInput;
  depreciationAmount: DecInput;
  nonDepreciableAmount: DecInput;
  revaluationReserve?: DecInput;
  lastProcessedDate: string;
  startDate: string;
  notApplied: boolean;
}

export function checkImprovement(c: ImprovementCheck): AssetMessageKey | null {
  const da = dec(c.depreciationAmount).minus(dec(c.nonDepreciableAmount));
  const awrr = da.plus(c.isAccounting ? dec(c.revaluationReserve) : ZERO);
  if (awrr.isZero()) return 'strAddImprovementAssetAmountNotSet';
  const limit = c.isAccounting ? awrr.plus(dec(c.nonDepreciableAmount)) : dec(c.depreciationAmount);
  if (dec(c.newAmount).lte(limit)) return 'strAddImprovementInvalidAmount';
  if (!c.notApplied && monthsBetween(c.lastProcessedDate, c.startDate) < 1) return 'strAddImprovementInvalidDate';
  return null;
}

/** Improvement date: last day of LP's month (or the revaluation date for land in IAS mode). */
export const improvementDate = (lastProcessedDate: string) => endOfMonth(lastProcessedDate);

/** Cost read by the reports: MAX(NewDepreciationAmount) of rows dated <= date, else DepreciationAmount. */
export function costAt(depreciationAmount: DecInput, improvements: { date: string; amount: DecInput }[], date: string): Dec {
  const upTo = improvements.filter((i) => i.date <= date);
  if (!upTo.length) return dec(depreciationAmount);
  return upTo.reduce((m, i) => D.max(m, dec(i.amount)), dec(upTo[0]!.amount));
}

/* ------------------------------------------------------------------ */
/* Revaluation / impairment (9.2, Z39) — bug-compatible with D1        */
/* ------------------------------------------------------------------ */

export interface RevaluationInput {
  newAmount: DecInput;
  depreciableAmount: DecInput;
  accrued: DecInput;
  /** LRR: current cumulative reserve of the accounting plan. */
  currentReserve: DecInput;
}

export interface AssetRevaluationResult {
  error: AssetMessageKey | null;
  /** NRR = NewAmount - (DA - accrued). */
  nrr: Dec;
  totalReserve: Dec;
  /** Posted amount (always |NRR|). */
  postingAmount: Dec;
  /** NRR < 0: Dt impairment loss (631) / Kt user account; else Dt user account / Kt reversal income (731). */
  isDecrease: boolean;
}

/** Prefill of "Нова стойност": RemainderByLastProcessedDate = max(0, DA - accrued) (without the reserve). */
export const revaluationPrefill = (depreciableAmount: DecInput, accrued: DecInput) => D.max(ZERO, dec(depreciableAmount).minus(dec(accrued)));

export function computeRevaluation(r: RevaluationInput): AssetRevaluationResult {
  const lrr = dec(r.currentReserve);
  const nrr = dec(r.newAmount).minus(dec(r.depreciableAmount).minus(dec(r.accrued)));
  const res: AssetRevaluationResult = { error: null, nrr, totalReserve: nrr.plus(lrr), postingAmount: nrr.abs(), isDecrease: nrr.lt(0) };
  if (dec(r.newAmount).lt(0)) return { ...res, error: 'strNegativeRevaluationReserve' };
  if (nrr.gt(lrr.abs())) return { ...res, error: 'strAmountIsLessThanRevaluationReserve' };
  const carrying = dec(r.depreciableAmount).plus(lrr).minus(dec(r.accrued));
  if (nrr.abs().gte(carrying)) return { ...res, error: 'strAmountIsLessThanRevaluationReserve' };
  const amount = nrr.gte(lrr.abs()) ? lrr.abs() : nrr.abs();
  return { ...res, postingAmount: amount };
}

/* ------------------------------------------------------------------ */
/* Write-off (11)                                                      */
/* ------------------------------------------------------------------ */

export interface TerminationLine {
  role: 'depreciation' | 'operation' | 'revaluation' | 'inventory';
  side: 'debit' | 'credit';
  amount: Dec;
}

/**
 * Write-off entry (11.2). Wasted/Sold: Dt depreciation acc; Dt operation cost - acc - reserve;
 * Dt revaluation reserve; Kt inventory cost. Expired: Dt depreciation cost - reserve - residual;
 * Dt operation residual; Dt revaluation reserve; Kt inventory cost.
 * The signed reserve (defect D7 corrected): a positive reserve is credited to the revaluation account.
 * Zero lines are dropped.
 */
export function terminationLines(o: {
  type: number;
  depreciableAmount: DecInput;
  nonDepreciableAmount: DecInput;
  accrued: DecInput;
  reserve: DecInput;
}): TerminationLine[] {
  const residual = dec(o.nonDepreciableAmount);
  const cost = dec(o.depreciableAmount).plus(residual);
  const signed = dec(o.reserve);
  const reserve = signed.abs();
  const acc = dec(o.accrued);
  const lines: TerminationLine[] = [];
  if (o.type === TERMINATION.Wasted || o.type === TERMINATION.Sold) {
    lines.push({ role: 'depreciation', side: 'debit', amount: acc });
    // Unconditional subtraction of |reserve| as in Delta; with a positive reserve the credit line balances it.
    lines.push({ role: 'operation', side: 'debit', amount: cost.minus(acc).minus(signed.lt(0) ? reserve : signed.neg()) });
  } else if (o.type === TERMINATION.Expired) {
    lines.push({ role: 'depreciation', side: 'debit', amount: cost.minus(signed.lt(0) ? reserve : signed.neg()).minus(residual) });
    if (residual.gt(0)) lines.push({ role: 'operation', side: 'debit', amount: residual });
  } else return [];
  if (signed.lt(0)) lines.push({ role: 'revaluation', side: 'debit', amount: reserve });
  else if (signed.gt(0)) lines.push({ role: 'revaluation', side: 'credit', amount: reserve });
  lines.push({ role: 'inventory', side: 'credit', amount: cost });
  return lines.filter((l) => !l.amount.isZero());
}

export interface TerminateDefaults {
  sapDate: string;
  dapDate: string;
  operation: number;
}

/** TerminateAssetViewModel constructor (11.1). */
export function terminateDefaults(sapLp: string, dapLp: string, sapEndDate: string, applicationDate: string): TerminateDefaults {
  const dapDate = monthIndex(dapLp) >= monthIndex(sapLp) ? firstOfMonth(sapLp) : dapLp;
  const operation = monthIndex(applicationDate) < monthIndex(sapEndDate) ? TERMINATION.NoOperation : TERMINATION.Expired;
  return { sapDate: sapLp, dapDate, operation };
}

/* ------------------------------------------------------------------ */
/* Pending requests (12.1)                                             */
/* ------------------------------------------------------------------ */

/** From = 1 January of the active year; To = 31 December, or the end of the application month when it is in the active year. */
export function pendingDefaultPeriod(activeYear: number, applicationDate: string) {
  const to = Number(applicationDate.slice(0, 4)) === activeYear ? endOfMonth(applicationDate) : `${activeYear}-12-31`;
  return { from: `${activeYear}-01-01`, to };
}

export const postingReference = (name: string, inventoryNumber: string) => `${name}; ${inventoryNumber}`.slice(0, 255);

/* ------------------------------------------------------------------ */
/* EUR changeover (13)                                                 */
/* ------------------------------------------------------------------ */

/** Round(value / 1.95583, 2, AwayFromZero). */
export const toEur = (v: DecInput) => round2(dec(v).div(BGN_PER_EUR));

/**
 * Converts a schedule to EUR (FixedAssetsEuroConversionService): every month is
 * converted; the last processed month takes converted accrued minus the earlier
 * converted processed months; every unprocessed December takes the difference to
 * the converted year amount; the last row takes the difference to the converted base.
 */
export function convertScheduleToEur(rows: ScheduleRow[], base: DecInput): ScheduleRow[] {
  const out = rows.map((r) => ({ ...r, amount: toEur(r.amount) }));
  const processedIdx = out.map((r, i) => (r.isProcessed ? i : -1)).filter((i) => i >= 0);
  const lastProc = processedIdx[processedIdx.length - 1];
  if (lastProc !== undefined) {
    const accrued = toEur(sum(processedIdx.map((i) => rows[i]!.amount)));
    const earlier = sum(processedIdx.slice(0, -1).map((i) => out[i]!.amount));
    out[lastProc]!.amount = accrued.minus(earlier);
  }
  const lastProcMonth = lastProc !== undefined ? out[lastProc]!.month : '';
  const years = [...new Set(rows.map((r) => Number(r.month.slice(0, 4))))];
  for (const y of years) {
    const decIdx = out.findIndex((r) => r.month === `${y}-12-01`);
    if (decIdx < 0 || decIdx === out.length - 1 || out[decIdx]!.month <= lastProcMonth) continue;
    const yearBgn = sum(rows.filter((r) => r.month.startsWith(`${y}-`)).map((r) => r.amount));
    const others = sum(out.filter((r, i) => i !== decIdx && r.month.startsWith(`${y}-`)).map((r) => r.amount));
    out[decIdx]!.amount = toEur(yearBgn).minus(others);
  }
  if (out.length && out.length - 1 !== lastProc) {
    const others = sum(out.slice(0, -1).map((r) => r.amount));
    out[out.length - 1]!.amount = toEur(base).minus(others);
  }
  return out;
}

/** GetValidPercentage: the rate of the last year with a non-zero percentage. */
export function validPercentage(plans: { percentage: DecInput }[]): Dec {
  for (let i = plans.length - 1; i >= 0; i--) if (!dec(plans[i]!.percentage).isZero()) return dec(plans[i]!.percentage);
  return ZERO;
}

/** Main parameters of a plan compared before save (03b 4): cost and dates. */
export interface PlanMainParameters {
  depreciationAmount: DecInput;
  acquisitionDate: string;
  startDate: string;
}

/**
 * Labels of the main parameters where the accounting (САП) and tax (ДАП)
 * plans differ. The rate, period and non-depreciable part legitimately
 * differ (statutory tax rates; the tax plan depreciates the whole cost).
 */
export function planMainDifferences(sap: PlanMainParameters, dap: PlanMainParameters): string[] {
  const out: string[] = [];
  if (!dec(sap.depreciationAmount).eq(dec(dap.depreciationAmount))) out.push('стойност');
  if (sap.acquisitionDate !== dap.acquisitionDate) out.push('дата на придобиване');
  if (sap.startDate !== dap.startDate) out.push('начало на амортизация');
  return out;
}
