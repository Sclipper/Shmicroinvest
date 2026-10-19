import { dec, round, round2, sum, ZERO, type Dec, type DecInput } from './money.ts';
import { DOCUMENT_TYPE, TRANSACTION_TYPE } from './seeds/lookups.ts';
import type { ValidationMessage } from './journal.ts';
import { ICA_TYPE } from './vat/constants.ts';

/**
 * Journal extras (spec 02a sections 2-8): row calculations beyond the basic
 * ones in journal.ts, pre-save confirmations, void/reversal/copy texts, mass
 * edit validation, renumbering, fast entry checks, group-60 assisted closing,
 * attachments, the numbering-series editor and the shortcut table.
 */

export const JOURNAL_EXTRA_MESSAGES = {
  // 4.3 / 4.4 editor
  strInvalidDocNumberLenght: 'Невалидна дължина на Номер на документа',
  strDuplicatedDocumentWarning: 'Съществува въведен документ с този номер! Желаете ли продължение?',
  strCreditNoteAmountConfirmation: 'Документ Кредитно известие (КИ) се осчетоводява с отрицателен знак! Сигурни ли сте, че искате да запазите операцията?',
  strAskIfViesMonthIsBeforeDocumentDate: 'Месец за експорт е в период преди дата на документа! Желаете ли да продължите?',
  strViesMonthAfterTaxCredit: 'Месецът за експорт е след законно установения срок за ползване на данъчен кредит. Желаете ли да продължите?',
  strPaymentAccountingDetailsDelitionWarning: 'Внимание! Връзката с документа за разплащане ще бъде изгубена. Желаете ли продължение?',
  strStateChangedWarning: 'Желаете ли изход без запис на данните?',
  strDifferentAccountingNumberWarning: "Контирането е записано с номер '{0}'.",
  strSaveAccounting: 'Запис на данните...',
  strUpdateSuccess: 'Данните са записани успешно.',
  strLoadPriceConfirmationPrompt: 'Желаете ли да бъдат изчислени и заредени средно-претеглените цени за всички въведени стоки/материали/продукти?',
  strExpensesDistributionReferenceText: 'Разпределение по контиране {0}',
  strGroup60ClosingTerm: 'Приключване на група 60',
  // 4.6 attachments
  strMaxFileSizeExceededMessage: 'Файлът е по-голям от позволената дължина ({0} {1}).',
  strUnsupportedFileTypeMessage: 'Непозволен тип на файл ({0}).',
  strIOErrorReadingFile: 'Входно-изходна грешка при четене на файла...',
  strAddAttachmentFromFile: 'Добавяне на файл',
  strAddAttachmentFromScan: 'Сканиране на документ',
  strScanDocument: 'Сканиране на документ',
  // 5 void / reversal / copy
  strConfirmVoid: 'Желаете ли да изтриете избрания документ?',
  strConfirmMultiVoid: 'Внимание!!! Информацията за извършени плащания или начислени амортизации във всички {0} избрани документа ще бъде изгубена! Желаете ли да изтриете тези документи?',
  strLiabilityAccountingAttachedWarning: 'Към избраната операция има свързано задължение/вземане (Контиране No {0}), връзката между документите ще бъде изтрита. Желатете ли продължение?',
  strPaymentAccountingAttachedWarning: 'Към избрания документ има извършено разплащане (Контиране No {0}). Моля, коригирайте операцията за разплащане. Желаете ли връзката между документите да бъде изтрита?',
  strDepreciationScheduleAttachedWarning: 'Избраният документ е генериран от амортизационен план. Моля, коригирайте амортизационния план. Желаете ли продължение?',
  strVoidAccountingWithFixedAsset: 'Избраният документ е автоматична операция за отписване на ДМА. Желаете ли продължение?',
  strVoidAccounting: 'Изтриване на избрания документ...',
  strReversalMessage: 'Ще бъде създаден сторно запис на контиране {0}. Желаете ли да прегледате/редактирате операцията преди запис?',
  strNewAccountingFromSelected: 'Ново контиране от избраното',
  strCreatingNewAccountingFromSelected: 'Създаване на контиране, базирано на селектираното...',
  strCreatingExpensesDistribution: 'Създаване на разпределение на допълнителни разходи...',
  // 6 mass edit
  strEditAccountings: 'Редакция на контировки',
  strDifferentVATEditWarning: 'В избраното за редакция контиране има повече от един режим по ДДС. Желаете ли продължение?',
  strICATypeDefaultBreadFlourEditWarning: 'Към избраното за редакция контиране има операция ВОП - хляб и брашно. Желаете ли продължение?',
  strHeaderEditAccountingData: 'Данни за редакция на контировки',
  strWrongStartDate: '"От дата" е различна от текущата счетоводна година.',
  strWrongEndDate: '"До дата" е различна от текущата счетоводна година.',
  strInvalidAccountingsNumber: 'Няма избрани контирания за редактиране.',
  strInvalidAccountingEditData: 'Няма въведена информация за редактиране.',
  strWrongAccountingMonth: 'Датата на контирането обхваща заключен месец/период!',
  strWrongAccountingDate: 'Датата на контирането е различна от текущата счетоводна година!',
  strInvalidEditNoCompanyAccountWidthCompany: 'Не може да редактирате партньор на контировки без партньор.',
  strInvalidEditCompanyOnLiabilityAttached: 'Партньорът не може да бъде редактиран, защото към някои от избраните контирания има свързани задължения/вземания.',
  strInvalidEditDocumentNumber: 'Датата на документа не може да бъде редактирана, защото някои от избраните контирания нямат документ.',
  strNoEditAccountingNo: 'Не сте въвели дебитна/кредитна сметка, която да бъде редактирана.',
  strNotValidEditDataAccount: 'Въведената дебитна/кредитна сметка не участва в дебита/кредита на някоя от избраните контировки.',
  strNotSameCurrency: 'Валутните сметки трябва да са с еднаква валута.',
  strInvalidEditForeignCurrencyAccount: 'Не може да замените валутна сметка с невалутна.',
  strInvalidEditNoForeignCurrencyAccount: 'Не може да замените невалутна сметка с валутна.',
  strInvalidEditMaterialAccount: 'Не може да замените материална сметка с нематериална.',
  strInvalidEditNoMaterialAccount: 'Не може да замените нематериална сметка с материална.',
  strInvalidEditCompanyAccount: 'Не може да замените сметка с партньор със сметка без партньор.',
  strInvalidEditNoCompanyAccount: 'Не може да замените сметка без партньор със сметка с партньор.',
  strInvalidEditAccountOnLiabilityAttached: 'Сметката не може да бъде редактирана, защото към някои от избраните контирания има свързани задължения/вземания.',
  strInvalidAccount: 'Въведена е невалидна сметка!',
  // 3 renumbering
  strReorderAccountingsComplete: 'Преподреждането завърши успешно!',
  strLockedMonthOperation: 'Операцията, която се опитвате да извършите, обхваща заключен месец/период!',
  // 8.1 fast entry
  strInappropriateFastAccountingAccountMessage: 'В "Бързо контиране" не са позволени материални или валутни сметки.',
  strCompanyAccountsOnBothSidesWarning: 'Въведени са сметки с партньори и в дебита и в кредита.',
  strDuplicatedPurchaseDocumentExistsWithParams: 'Съществува осчетоводен тип документ {1} с № {0}, тип сделка {2} и клиент {3}!',
  strDuplicatedSaleDocumentExistsWithParams: 'Съществува въведен документ с номер {0} от тип {1} за тип сделка {2}!',
  strDuplicatedPurchaseDocumentExistInRows: 'Документ с номер {0} от тип {1} е дублиран за един и същ партньор във въведените редове!',
  strDuplicatedSaleDocumentExistInRows: 'Документ с номер {0} от тип {1} е дублиран във въведените в редовете данни!',
  strNoPayment: 'Без разплащане',
  // 06 3.7 / 3.8 settings (texts not in the dictionaries are supplied here)
  strIncorrectSequenceData: 'Некоректни данни за номерацията.',
  strSequenceInUse: 'Номерацията се използва и не може да бъде изтрита.',
  strAccountingNumberationCannotBeDeactivated: 'Номерацията на контировките не може да бъде деактивирана.',
  strSequencePreviewError: 'Грешка!',
  strErrorCannotDeleteDocumentType: 'Типът документ не може да бъде премахнат, защото има осчетоводени документи от този тип.',
  strErrorCannotDeleteDocumentTypeUsedByProgram: 'Типът документ се използва от програмата и не може да бъде премахнат.',
  // 06 2.6 shortcuts
  strWarningDuplicatedKeyShortcut: 'Клавишната комбинация {0} вече се използва за „{1}“.',
  strRestoreDefaultShortcutsQuestion: 'Желаете ли да възстановите всички клавишни комбинации по подразбиране?',
} as const;
export type JournalExtraKey = keyof typeof JOURNAL_EXTRA_MESSAGES;

/** "{0}"-style placeholders. */
export function formatMessage(text: string, ...args: (string | number)[]) {
  return text.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
}

type Message = ValidationMessage;
const msg = (key: JournalExtraKey, severity: Message['severity'] = 'critical', ...args: (string | number)[]): Message => ({
  key, severity, text: formatMessage(JOURNAL_EXTRA_MESSAGES[key], ...args),
});

// ---------------------------------------------------------------------------
// 2. Row calculations

/** Shares of a whole split by weights; each share round2, the LAST takes the remainder (02a 2, 4.7). */
export function splitByWeights(total: DecInput, weights: DecInput[]): Dec[] {
  const t = dec(total);
  const w = weights.map((x) => dec(x).abs());
  const sw = sum(w);
  let remaining = t;
  return w.map((x, i) => {
    if (i === w.length - 1) return remaining;
    const share = sw.isZero() ? ZERO : round2(t.times(x).div(sw));
    remaining = remaining.minus(share);
    return share;
  });
}

/**
 * Compound entry with currency (02a 2): each partner share of the currency
 * amount = round2(share amount / rate); the last one takes the remainder.
 */
export function currencyShares(totalCurrency: DecInput, legAmounts: DecInput[], rate: DecInput): Dec[] {
  const r = dec(rate);
  if (r.isZero()) return splitByWeights(totalCurrency, legAmounts);
  let remaining = dec(totalCurrency);
  return legAmounts.map((a, i) => {
    if (i === legAmounts.length - 1) return remaining;
    const share = round2(dec(a).div(r));
    remaining = remaining.minus(share);
    return share;
  });
}

/**
 * Material line (02a 2): quantity and price are rounded to QuantityFormat /
 * PriceFormat decimals (away from zero), then Amount = round2(Quantity x Price).
 */
export function materialLine(quantity: DecInput, price: DecInput, f: { quantityDecimals: number; priceDecimals: number }) {
  const q = round(quantity, f.quantityDecimals);
  const p = round(price, f.priceDecimals);
  return { quantity: q, price: p, amount: round2(q.times(p)) };
}

/** Foreign line (02a 2): CurrencyAmount = round2(Amount / Rate) when the amount is typed. */
export function currencyLine(amount: DecInput, rate: DecInput) {
  const r = dec(rate);
  return { amount: round2(amount), currencyAmount: r.isZero() ? ZERO : round2(dec(amount).div(r)) };
}

// ---------------------------------------------------------------------------
// 4.7 Expenses distribution

export interface DistributableLine {
  accountId: number;
  amount: DecInput;
  quantity?: DecInput | null;
  isMaterial?: boolean;
}

/**
 * Разпределяне на допълнителни разходи: an expense amount is spread over the
 * goods lines of one side by value or by quantity (last line takes the
 * remainder). Only material lines take part when the side has any.
 */
export function distributeExpenses(amount: DecInput, lines: DistributableLine[], base: 'amount' | 'quantity') {
  const goods = lines.some((l) => l.isMaterial) ? lines.filter((l) => l.isMaterial) : lines;
  const weights = goods.map((l) => (base === 'quantity' ? dec(l.quantity ?? 0) : dec(l.amount)));
  if (sum(weights.map((w) => w.abs())).isZero()) {
    throw new Error(base === 'quantity' ? 'Няма въведени количества за разпределение.' : 'Няма стойности за разпределение.');
  }
  const shares = splitByWeights(amount, weights);
  return goods.map((l, i) => ({ accountId: l.accountId, amount: shares[i]! }));
}

/** Default side (07 ExpensesDistributionView): the side holding material lines, else debit. */
export function defaultDistributionSide(debits: DistributableLine[], credits: DistributableLine[]): 'debit' | 'credit' {
  if (debits.some((l) => l.isMaterial)) return 'debit';
  if (credits.some((l) => l.isMaterial)) return 'credit';
  return 'debit';
}

// ---------------------------------------------------------------------------
// 4.3 / 4.4 document number and pre-save confirmations

export const CREDIT_NOTE_TYPES: readonly number[] = [DOCUMENT_TYPE.CreditNote, 27, 42];
export const INVOICE_LIKE_TYPES: readonly number[] = [DOCUMENT_TYPE.Invoice, DOCUMENT_TYPE.DebitNote, 25, 26];

/**
 * strInvalidDocNumberLenght (NonCritical) for invoices and debit notes whose
 * number is longer than the document sequence's NumericLength plus an
 * allowance. The allowance constant was lost upstream [U]; 0 is used.
 */
export function documentNumberWarnings(documentTypeId: number | null, documentNumber: string, numericLength = 10, allowance = 0): Message[] {
  if (documentTypeId == null || !INVOICE_LIKE_TYPES.includes(documentTypeId)) return [];
  return documentNumber.trim().length > numericLength + allowance ? [msg('strInvalidDocNumberLenght', 'warning')] : [];
}

const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;

export interface PreSaveInput {
  documentTypeId: number | null;
  totalDebit: DecInput;
  documentDate: string | null;
  viesMonth: string | null;
  duplicateExists: boolean;
  hasPaymentLinks?: boolean;
  isInitialBalance?: boolean;
}

/**
 * Pre-save confirmation chain (02a 4.4), in order; each is a Yes/No question.
 * The VIES-month tax-credit limit is the document month + 12 (ZDDS art. 72(1):
 * the period of issue or one of the next twelve).
 */
export function preSaveConfirmations(i: PreSaveInput): Message[] {
  if (i.isInitialBalance) return [];
  const out: Message[] = [];
  if (i.duplicateExists) out.push(msg('strDuplicatedDocumentWarning', 'warning'));
  if (i.documentTypeId != null && CREDIT_NOTE_TYPES.includes(i.documentTypeId) && dec(i.totalDebit).greaterThanOrEqualTo(0)) {
    out.push(msg('strCreditNoteAmountConfirmation', 'warning'));
  }
  if (i.viesMonth && i.documentDate) {
    const v = monthIndex(i.viesMonth);
    const d = monthIndex(i.documentDate);
    if (v < d) out.push(msg('strAskIfViesMonthIsBeforeDocumentDate', 'warning'));
    else if (v > d + 12) out.push(msg('strViesMonthAfterTaxCredit', 'warning'));
  }
  if (i.hasPaymentLinks) out.push(msg('strPaymentAccountingDetailsDelitionWarning', 'warning'));
  return out;
}

// ---------------------------------------------------------------------------
// 4.6 Attachments

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_BLACKLIST = ['.exe', '.bat', '.dll'] as const;

/** Validates one attachment (02a 4.6): 10 MB limit and the extension blacklist. */
export function validateAttachment(fileName: string, size: number): Message[] {
  const out: Message[] = [];
  const ext = (fileName.match(/\.[^./\\]+$/)?.[0] ?? '').toLowerCase();
  if ((ATTACHMENT_BLACKLIST as readonly string[]).includes(ext)) out.push(msg('strUnsupportedFileTypeMessage', 'critical', ext));
  if (size > ATTACHMENT_MAX_BYTES) out.push(msg('strMaxFileSizeExceededMessage', 'critical', 10, 'MB'));
  return out;
}

/** Image formats of a scanned page (the scanner's JPEG encoder is the default). */
export const SCAN_FORMATS = { jpeg: { mime: 'image/jpeg', ext: 'jpg' }, png: { mime: 'image/png', ext: 'png' } } as const;
export type ScanFormat = keyof typeof SCAN_FORMATS;

/** File name of a scanned attachment: "Сканиран документ 19.10.2026 14-30-05.jpg" (local time of the scan). */
export function scanAttachmentFileName(at: Date, format: ScanFormat = 'jpeg'): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Сканиран документ ${p(at.getDate())}.${p(at.getMonth() + 1)}.${at.getFullYear()} ${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}.${SCAN_FORMATS[format].ext}`;
}

// ---------------------------------------------------------------------------
// 4.7 Group-60 assisted closing

export interface ClosingSource {
  accountingDate: string;
  documentDate: string | null;
  term: string;
  reference: string;
  optionalReference?: string;
  debits: { accountId: number; accountNumber: string; amount: DecInput; companyId?: number | null }[];
}

export interface ClosingDraft {
  accountingDate: string;
  documentDate: string;
  documentTypeId: number;
  transactionTypeId: number;
  term: string;
  reference: string;
  optionalReference: string;
  debits: { accountId: number; amount: string }[];
  credits: { accountId: number; amount: string; companyId: number | null }[];
}

/**
 * After saving an entry with IsAllowAccountingAutomaticEnd on: one memorial
 * order crediting every debit line on a "60…" account (same amount); the debit
 * side stays empty for the user (J3 bug-compatible). separate = one draft per line.
 */
export function group60ClosingDrafts(e: ClosingSource, opts: { enabled: boolean; separate: boolean }): ClosingDraft[] {
  if (!opts.enabled) return [];
  const lines = e.debits.filter((l) => l.accountNumber.startsWith('60') && !dec(l.amount).isZero());
  if (!lines.length) return [];
  const base = {
    accountingDate: e.accountingDate,
    documentDate: e.documentDate || e.accountingDate,
    documentTypeId: DOCUMENT_TYPE.MemorialOrder,
    transactionTypeId: TRANSACTION_TYPE.NotSet,
    term: e.term.trim() ? e.term : JOURNAL_EXTRA_MESSAGES.strGroup60ClosingTerm,
    reference: e.reference,
    optionalReference: e.optionalReference ?? '',
    debits: [] as ClosingDraft['debits'],
  };
  const credit = (l: ClosingSource['debits'][number]) => ({ accountId: l.accountId, amount: round2(l.amount).toFixed(2), companyId: l.companyId ?? null });
  if (opts.separate) return lines.map((l) => ({ ...base, credits: [credit(l)] }));
  return [{ ...base, credits: lines.map(credit) }];
}

// ---------------------------------------------------------------------------
// 3. Renumbering (ReorderAccountingsByNumber / ByDate / ReorderDocuments)

export interface ReorderItem {
  id: number;
  number: string;
  date: string;
}

const numericOrText = (a: string, b: string) => {
  const na = /^\d+$/.test(a) ? BigInt(a) : null;
  const nb = /^\d+$/.test(b) ? BigInt(b) : null;
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Groups items by number (entries sharing a number keep sharing one), orders
 * the groups by number or by their earliest date, and numbers them 1..N.
 * Returns the new sequence value per id and the group count (new LastNumber).
 */
export function reorderNumbers(items: ReorderItem[], by: 'number' | 'date'): { numbers: Map<number, number>; count: number } {
  const groups = new Map<string, ReorderItem[]>();
  for (const it of items) groups.set(it.number, [...(groups.get(it.number) ?? []), it]);
  const list = [...groups.entries()].map(([number, rows]) => ({
    number, rows, date: rows.map((r) => r.date).sort()[0]!, minId: Math.min(...rows.map((r) => r.id)),
  }));
  list.sort((a, b) => {
    if (by === 'date' && a.date !== b.date) return a.date < b.date ? -1 : 1;
    const c = numericOrText(a.number, b.number);
    return c !== 0 ? c : a.minId - b.minId;
  });
  const numbers = new Map<number, number>();
  list.forEach((g, i) => g.rows.forEach((r) => numbers.set(r.id, i + 1)));
  return { numbers, count: list.length };
}

// ---------------------------------------------------------------------------
// 6.2 Mass edit validation

export interface MassEditAccount {
  number: string;
  isLeaf: boolean;
  isForeignCurrency: boolean;
  currencyId: number;
  isMaterial: boolean;
  isCompany: boolean;
}

export interface MassEditEntry {
  id: number;
  number: string;
  isMonthLocked: boolean;
  hasDocument: boolean;
  hasCompanyLine: boolean;
  /** Numbers of the payment/liability counterpart entries linked to this one. */
  attachedNumbers: string[];
  details: { accountNumber: string; sign: number }[];
}

export interface MassEditChanges {
  newAccountingDate?: string | null;
  newDocumentDate?: string | null;
  newViesMonth?: string | null;
  newCompanyId?: number | null;
  newTerm?: string | null;
  newReference?: string | null;
  newOptionalReference?: string | null;
  newParagraph?: string | null;
  fromDebitAccount?: string | null;
  fromCreditAccount?: string | null;
  newAccount?: string | null;
}

const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== '';

/**
 * Yes/No questions before a mass edit (02b 12): an entry with more than one
 * VAT regime, or with a bread/flour ICA protocol (ВОП - хляб и брашно).
 */
export function massEditConfirmations(entries: { vatTermIds: (number | null)[]; icaType: number }[]): Message[] {
  const out: Message[] = [];
  if (entries.some((e) => new Set(e.vatTermIds.filter((v) => v != null)).size > 1)) out.push(msg('strDifferentVATEditWarning', 'warning'));
  if (entries.some((e) => e.icaType === ICA_TYPE.BreadFlourAcquisition)) out.push(msg('strICATypeDefaultBreadFlourEditWarning', 'warning'));
  return out;
}

/** Mass edit validation in the documented order (02a 6.2); all critical. */
export function validateMassEdit(
  entries: MassEditEntry[],
  ch: MassEditChanges,
  ctx: { activeYear: number; accounts: Map<string, MassEditAccount> },
): Message[] {
  const out: Message[] = [];
  if (!entries.length) return [msg('strInvalidAccountingsNumber')];
  const replacing = filled(ch.newAccount);
  const anyField = [ch.newAccountingDate, ch.newDocumentDate, ch.newViesMonth, ch.newCompanyId, ch.newTerm, ch.newReference, ch.newOptionalReference, ch.newParagraph].some(filled);
  if (!anyField && !replacing) return [msg('strInvalidAccountingEditData')];
  if (entries.some((e) => e.isMonthLocked)) out.push(msg('strWrongAccountingMonth'));
  if (filled(ch.newAccountingDate) && Number(String(ch.newAccountingDate).slice(0, 4)) !== ctx.activeYear) out.push(msg('strWrongAccountingDate'));
  const selected = new Set(entries.map((e) => e.number));
  const linkedOutside = entries.some((e) => e.attachedNumbers.some((n) => !selected.has(n)));
  if (filled(ch.newCompanyId)) {
    if (entries.some((e) => !e.hasCompanyLine)) out.push(msg('strInvalidEditNoCompanyAccountWidthCompany'));
    if (linkedOutside) out.push(msg('strInvalidEditCompanyOnLiabilityAttached'));
  }
  if (filled(ch.newDocumentDate) && entries.some((e) => !e.hasDocument)) out.push(msg('strInvalidEditDocumentNumber'));
  if (replacing) {
    const fromCredit = filled(ch.fromCreditAccount);
    const fromNumber = (fromCredit ? ch.fromCreditAccount : ch.fromDebitAccount)?.trim() ?? '';
    if (!fromNumber) out.push(msg('strNoEditAccountingNo'));
    else {
      const sign = fromCredit ? -1 : 1;
      if (entries.some((e) => !e.details.some((d) => d.accountNumber === fromNumber && d.sign === sign))) out.push(msg('strNotValidEditDataAccount'));
      const from = ctx.accounts.get(fromNumber);
      const to = ctx.accounts.get(String(ch.newAccount).trim());
      if (!to || !to.isLeaf) out.push(msg('strInvalidAccount'));
      if (from && to) {
        if (from.isForeignCurrency && to.isForeignCurrency && from.currencyId !== to.currencyId) out.push(msg('strNotSameCurrency'));
        if (from.isForeignCurrency && !to.isForeignCurrency) out.push(msg('strInvalidEditForeignCurrencyAccount'));
        if (!from.isForeignCurrency && to.isForeignCurrency) out.push(msg('strInvalidEditNoForeignCurrencyAccount'));
        if (from.isMaterial && !to.isMaterial) out.push(msg('strInvalidEditMaterialAccount'));
        if (!from.isMaterial && to.isMaterial) out.push(msg('strInvalidEditNoMaterialAccount'));
        if (from.isCompany && !to.isCompany) out.push(msg('strInvalidEditCompanyAccount'));
        if (!from.isCompany && to.isCompany) out.push(msg('strInvalidEditNoCompanyAccount'));
      }
      if (linkedOutside) out.push(msg('strInvalidEditAccountOnLiabilityAttached'));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 8.1 Fast entry

export interface FastRowAccount {
  number: string;
  isLeaf: boolean;
  isForeignCurrency: boolean;
  isMaterial: boolean;
  isCompany: boolean;
}

export interface FastRow {
  documentTypeId: number | null;
  documentNumber: string;
  transactionTypeId: number;
  companyId: number | null;
  debit?: FastRowAccount;
  credit?: FastRowAccount;
}

/** Row-level account rules of fast entry (only non-material, non-foreign accounts; 1:1). */
export function fastRowAccountMessages(r: FastRow): Message[] {
  const out: Message[] = [];
  const bad = (a?: FastRowAccount) => !!a && (a.isMaterial || a.isForeignCurrency);
  if (bad(r.debit) || bad(r.credit)) out.push(msg('strInappropriateFastAccountingAccountMessage'));
  if (r.debit?.isCompany && r.credit?.isCompany) out.push(msg('strCompanyAccountsOnBothSidesWarning', 'warning'));
  return out;
}

/** Duplicate documents within the batch: purchases per partner, sales per number/type/transaction type. */
export function fastRowDuplicates(rows: FastRow[], docTypeName: (id: number) => string): Map<number, Message[]> {
  const out = new Map<number, Message[]>();
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.documentTypeId == null || !r.documentNumber.trim()) return;
    const purchase = r.transactionTypeId === TRANSACTION_TYPE.Purchase;
    const key = [r.documentTypeId, r.documentNumber.trim(), r.transactionTypeId, purchase ? r.companyId ?? '' : ''].join('|');
    if (seen.has(key)) {
      const m = purchase
        ? msg('strDuplicatedPurchaseDocumentExistInRows', 'critical', r.documentNumber.trim(), docTypeName(r.documentTypeId))
        : msg('strDuplicatedSaleDocumentExistInRows', 'critical', r.documentNumber.trim(), docTypeName(r.documentTypeId));
      out.set(i, [...(out.get(i) ?? []), m]);
    } else seen.set(key, i);
  });
  return out;
}

/** Transaction type of a fast row: the first line VAT term with a transaction type, else the document's default. */
export function fastRowTransactionType(debitTermType: number | null, creditTermType: number | null) {
  if (debitTermType && debitTermType !== TRANSACTION_TYPE.NotSet) return debitTermType;
  if (creditTermType && creditTermType !== TRANSACTION_TYPE.NotSet) return creditTermType;
  return TRANSACTION_TYPE.NotSet;
}

// ---------------------------------------------------------------------------
// 06 3.7 Numbering series editor

/** Number-length choices "1".."1234567890": index 0..9 = 1..10 characters. */
export const SEQUENCE_LENGTH_OPTIONS = Array.from({ length: 10 }, (_, i) => '1234567890'.slice(0, i + 1));

/**
 * Preview = Prefix + StartNumber zero-padded to (SelectedNumberLength + 1 -
 * Prefix.Length); "Грешка!" when SelectedNumberLength + 1 < Prefix.Length +
 * digits(StartNumber).
 */
export function sequencePreview(prefix: string, selectedNumberLength: number, startNumber: number): string {
  const width = selectedNumberLength + 1 - prefix.length;
  const digits = String(Math.max(0, Math.trunc(startNumber)));
  if (selectedNumberLength + 1 < prefix.length + digits.length) return JOURNAL_EXTRA_MESSAGES.strSequencePreviewError;
  return prefix + digits.padStart(width, '0');
}

/** Stored values: Format = Prefix + separator, NumericLength = len + 1 - Prefix.Length, LastNumber = start - 1. */
export function sequenceStorage(prefix: string, separator: string, selectedNumberLength: number, startNumber: number) {
  return { format: prefix + separator, numericLength: selectedNumberLength + 1 - prefix.length, lastNumber: Math.max(0, Math.trunc(startNumber) - 1) };
}

export function validateSequence(prefix: string, selectedNumberLength: number, startNumber: number): Message[] {
  const ok = Number.isInteger(startNumber) && startNumber >= 1 && selectedNumberLength >= 0 && selectedNumberLength <= 9
    && sequencePreview(prefix, selectedNumberLength, startNumber) !== JOURNAL_EXTRA_MESSAGES.strSequencePreviewError
    && !/\d$/.test(prefix);
  return ok ? [] : [msg('strIncorrectSequenceData')];
}

/** Inverse of sequenceStorage for the editor: prefix/separator split and the length index. */
export function sequenceEditorValues(seq: { format: string; numericLength: number; lastNumber: number }) {
  const format = seq.format === '[#]' ? '' : seq.format.replace('[#]', '');
  const m = format.match(/^(.*?)([^\p{L}\p{N}]*)$/u)!;
  const prefix = m[1] ?? '';
  const separator = m[2] ?? '';
  return { prefix, separator, selectedNumberLength: Math.min(9, Math.max(0, seq.numericLength - 1 + prefix.length)), startNumber: seq.lastNumber + 1 };
}

/** Document types that cannot be removed from the visible list (06 3.8). */
export const MANDATORY_DOCUMENT_TYPES: readonly number[] = [1, 2, 3, 5, 6, 8, 9, 10, 11, 13];

// ---------------------------------------------------------------------------
// 06 2.6 Shortcuts

export type ShortcutType = 'WindowEditable' | 'WindowReadOnly' | 'MainMenu';
export interface ShortcutDef {
  id: string;
  label: string;
  type: ShortcutType;
  gesture: string;
}

/** Window shortcuts (DefaultShortcutKeys selection from 06 2.6; the full table is obfuscated upstream, recipe A6). */
export const DEFAULT_SHORTCUTS: ShortcutDef[] = [
  { id: 'Select', label: 'Избор (номенклатура)', type: 'WindowReadOnly', gesture: 'F4' },
  { id: 'Save', label: 'Запис', type: 'WindowReadOnly', gesture: 'Ctrl+S' },
  { id: 'Balancing', label: 'Изравняване', type: 'WindowEditable', gesture: 'Ctrl+F9' },
  { id: 'BalancingAndSave', label: 'Изравняване и запис', type: 'WindowEditable', gesture: 'Shift+F9' },
  { id: 'BalancingSaveAndCopy', label: 'Изравняване, запис и копиране', type: 'WindowEditable', gesture: 'Alt+F9' },
  { id: 'BalancingSaveAndPayment', label: 'Изравняване, запис и разплащане', type: 'WindowEditable', gesture: 'Ctrl+F10' },
  { id: 'SaveAndExpensesDistribution', label: 'Запис и разпределяне на разходи', type: 'WindowEditable', gesture: 'Ctrl+F11' },
  { id: 'ExpensesDistribution', label: 'Разпределяне на допълнителни разходи', type: 'WindowEditable', gesture: 'F11' },
  { id: 'Payment', label: 'Разплащане', type: 'WindowEditable', gesture: 'F10' },
  { id: 'SaveTemplate', label: 'Запис като шаблон', type: 'WindowEditable', gesture: 'F5' },
  { id: 'LoadTemplates', label: 'Зареждане на шаблон', type: 'WindowEditable', gesture: 'Ctrl+T' },
  { id: 'CopyAccountingData', label: 'Копиране на данни', type: 'WindowEditable', gesture: 'Alt+C' },
  { id: 'PasteAccountingData', label: 'Поставяне на данни', type: 'WindowEditable', gesture: 'Alt+V' },
  { id: 'CalculateVAT', label: 'Изчисляване на ДДС', type: 'WindowEditable', gesture: 'F8' },
  { id: 'Transaction', label: 'Тип на сделката', type: 'WindowEditable', gesture: 'F9' },
  { id: 'SelectVAT', label: 'Операция по ДДС', type: 'WindowEditable', gesture: 'Ctrl+F8' },
  { id: 'CalculatePrice', label: 'Средно претеглени цени', type: 'WindowEditable', gesture: 'Ctrl+F5' },
  { id: 'Fixing', label: 'Фиксинг', type: 'WindowEditable', gesture: 'Ctrl+F12' },
  { id: 'RefreshCurrency', label: 'Обновяване на валутен курс', type: 'WindowEditable', gesture: 'Alt+R' },
  { id: 'ICAProtocol', label: 'Протокол по ЗДДС', type: 'WindowEditable', gesture: 'Ctrl+F6' },
  { id: 'DeliveryMaterialDetails', label: 'Доставка на СМЗ (детайли)', type: 'WindowEditable', gesture: 'Alt+D' },
  { id: 'SaleMaterialDetails', label: 'Продажба на СМЗ (детайли)', type: 'WindowEditable', gesture: 'Alt+P' },
  { id: 'AddVatPurchase', label: 'ДДС покупка', type: 'WindowEditable', gesture: 'Shift+F1' },
  { id: 'AddVatSale', label: 'ДДС продажба', type: 'WindowEditable', gesture: 'Shift+F2' },
  { id: 'FocusDefaultGrid', label: 'Към редовете', type: 'WindowEditable', gesture: 'Ctrl+ArrowDown' },
  { id: 'FocusDebit', label: 'Към дебит', type: 'WindowEditable', gesture: 'Ctrl+ArrowLeft' },
  { id: 'FocusCredit', label: 'Към кредит', type: 'WindowEditable', gesture: 'Ctrl+ArrowRight' },
  { id: 'PrevAccounting', label: 'Предишно контиране', type: 'WindowReadOnly', gesture: 'Alt+ArrowLeft' },
  { id: 'NextAccounting', label: 'Следващо контиране', type: 'WindowReadOnly', gesture: 'Alt+ArrowRight' },
  { id: 'ClearRow', label: 'Изчистване на ред', type: 'WindowEditable', gesture: 'Ctrl+Delete' },
  { id: 'AddSubaccount', label: 'Нова подсметка', type: 'WindowEditable', gesture: 'Ctrl+F3' },
  { id: 'NewAccountingFromSelected', label: 'Ново контиране от избраното', type: 'WindowReadOnly', gesture: 'Ctrl+N' },
  { id: 'Print', label: 'Печат', type: 'WindowReadOnly', gesture: 'Ctrl+P' },
  { id: 'Export', label: 'Експорт (справки)', type: 'WindowReadOnly', gesture: 'Ctrl+E' },
  { id: 'SelectAllItems', label: 'Избор на всички', type: 'WindowReadOnly', gesture: 'F11' },
  { id: 'SelectFirstCellOfRow', label: 'Първа клетка на реда', type: 'WindowReadOnly', gesture: 'Home' },
  { id: 'SelectLastCellOfRow', label: 'Последна клетка на реда', type: 'WindowReadOnly', gesture: 'End' },
  { id: 'SearchCompanyByBulstat', label: 'Търсене на партньор по ЕИК', type: 'WindowReadOnly', gesture: 'Ctrl+S' },
  { id: 'PaymentsAndConnectedDocuments', label: 'Разплащания и обвързани документи', type: 'WindowReadOnly', gesture: 'Alt+R' },
  { id: 'ExportPaymentsDocument', label: 'Експорт на платежни документи', type: 'WindowReadOnly', gesture: 'F6' },
];

/** Captions of the shortcut types, in the order of the printout (06 2.6 "Print builds a FlowDocument grouped by type"). */
export const SHORTCUT_TYPE_LABELS: Record<ShortcutType, string> = {
  WindowEditable: 'Прозорец (редакция)',
  WindowReadOnly: 'Прозорец',
  MainMenu: 'Главно меню',
};

/** Rows grouped by shortcut type for the printout; empty groups are left out, rows keep their order. */
export function shortcutsByType<R extends { type: string }>(rows: R[]): { type: ShortcutType; label: string; rows: R[] }[] {
  return (Object.keys(SHORTCUT_TYPE_LABELS) as ShortcutType[])
    .map((type) => ({ type, label: SHORTCUT_TYPE_LABELS[type], rows: rows.filter((r) => r.type === type) }))
    .filter((g) => g.rows.length > 0);
}

/** Keys an editable row may use (06 2.6): letters/digits, Home/End/arrows, F1-F12, with modifiers. */
export function isAllowedEditableGesture(gesture: string): boolean {
  const key = gesture.split('+').pop() ?? '';
  return /^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-2])$/.test(key) || ['Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete'].includes(key);
}

/**
 * Duplicate gestures among editable/read-only window rows (non-critical
 * strWarningDuplicatedKeyShortcut). Ids listed in `allowShared` may share a
 * gesture by design (e.g. F11 is both ExpensesDistribution and SelectAllItems
 * upstream, in different windows).
 */
export function duplicateShortcutWarnings(rows: { id: string; label: string; gesture: string }[], allowShared: string[][] = DEFAULT_SHARED_GESTURES): Message[] {
  const out: Message[] = [];
  const shared = (a: string, b: string) => allowShared.some((g) => g.includes(a) && g.includes(b));
  const seen = new Map<string, { id: string; label: string }>();
  for (const r of rows) {
    if (!r.gesture) continue;
    const prev = seen.get(r.gesture);
    if (prev && !shared(prev.id, r.id)) out.push(msg('strWarningDuplicatedKeyShortcut', 'warning', r.gesture, prev.label));
    else if (!prev) seen.set(r.gesture, r);
  }
  return out;
}

/** Upstream defaults that intentionally share a gesture (different windows). */
export const DEFAULT_SHARED_GESTURES: string[][] = [
  ['ExpensesDistribution', 'SelectAllItems'],
  ['Save', 'SearchCompanyByBulstat'],
  ['CopyAccountingData', 'SelectCurrency'],
  ['RefreshCurrency', 'PaymentsAndConnectedDocuments'],
];

/** Effective gesture per shortcut id: user override (empty string = disabled) or the default. */
export function effectiveShortcuts(overrides: Record<string, string>): Map<string, string> {
  return new Map(DEFAULT_SHORTCUTS.map((d) => [d.id, overrides[d.id] ?? d.gesture]));
}
