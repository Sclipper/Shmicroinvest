import { amountInWords } from './amountInWords.ts';
import { dec, parseAmount } from './money.ts';
import { isValidEgnChecksum, isValidLnch } from './validators.ts';
import type { ValidationMessage } from './journal.ts';

/**
 * Payment documents (Платежни документи, spec 02c section 1): printable bank
 * and budget payment forms. No accounting entry, no number; one table for all
 * types discriminated by the PaymentDocumentType identifier.
 */

export const PAYMENT_DOCUMENT_TYPE = {
  Unknown: 0, Order: 1, Due: 2, OrderCredit: 3, OrderDebit: 4, BudgetDue: 5, BudgetOrder: 6, Transire: 7, OrderMassPayment: 8,
} as const;
export type PaymentDocumentTypeId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Header text of the list's name column (strBeneficiaryCustomerShort etc.). */
export type NameHeaderKind = 'beneficiary' | 'orderer' | 'payer' | 'sender';
export const NAME_HEADERS: Record<NameHeaderKind, string> = {
  beneficiary: 'Получател',
  orderer: 'Наредител',
  payer: 'Платец',
  sender: 'Вносител',
};

export interface PaymentDocumentTypeDef {
  id: PaymentDocumentTypeId;
  /** EnumPaymentDocumentTypes.Description. */
  description: string;
  /** Crystal report of the original (the names cross over for the budget types). */
  report: string;
  /** Activity-log entity type name (01b 8). */
  entityType: string;
  nameHeader: NameHeaderKind;
  /** InWords is an editable field on the form (otherwise always recomputed). */
  editableInWords: boolean;
  /** Export "към ОББ" implemented (1.8). */
  exportable: boolean;
  /** Bank-branch chooser also fills PlaceAndDate (Order, Due, MassPayment). */
  branchFillsPlace: boolean;
}

export const PAYMENT_DOCUMENT_TYPES_DEF: Record<PaymentDocumentTypeId, PaymentDocumentTypeDef> = {
  1: { id: 1, description: 'Нареждане разписка', report: 'OrderDocument', entityType: 'OrderDocument', nameHeader: 'orderer', editableInWords: true, exportable: false, branchFillsPlace: true },
  2: { id: 2, description: 'Вносна бележка', report: 'DueDocument', entityType: 'DueDocument', nameHeader: 'sender', editableInWords: true, exportable: false, branchFillsPlace: true },
  3: { id: 3, description: 'Платежно нареждане за кредитен превод', report: 'OrderCreditDocument', entityType: 'OrderCreditDocument', nameHeader: 'beneficiary', editableInWords: false, exportable: true, branchFillsPlace: false },
  4: { id: 4, description: 'Платежно нареждане за директен дебит', report: 'OrderDebitDocument', entityType: 'OrderDebitDocument', nameHeader: 'payer', editableInWords: false, exportable: false, branchFillsPlace: false },
  5: { id: 5, description: 'Платежно нареждане', report: 'DueDocumentBudget', entityType: 'DueDocumentBudget', nameHeader: 'beneficiary', editableInWords: false, exportable: true, branchFillsPlace: false },
  6: { id: 6, description: 'Вносна бележка за плащане към бюджета', report: 'OrderDocumentBudget', entityType: 'OrderDocumentBudget', nameHeader: 'beneficiary', editableInWords: true, exportable: false, branchFillsPlace: false },
  7: { id: 7, description: 'Пътен лист', report: '', entityType: 'Document', nameHeader: 'beneficiary', editableInWords: false, exportable: false, branchFillsPlace: false },
  8: { id: 8, description: 'Нареждане за масово плащане', report: 'OrderMassPaymentDocument', entityType: 'Document', nameHeader: 'sender', editableInWords: false, exportable: false, branchFillsPlace: true },
};

/** Menu permission of each type (1.1); Transire has none. */
export const PAYMENT_DOCUMENT_PERMISSIONS: Partial<Record<number, string>> = {
  1: 'UI_Operations_PaymentDocuments_Order',
  2: 'UI_Operations_PaymentDocuments_Due',
  3: 'UI_Operations_PaymentDocuments_OrderCredit',
  4: 'UI_Operations_PaymentDocuments_OrderDebit',
  5: 'UI_Operations_PaymentDocuments_BlankBudgetDue',
  6: 'UI_Operations_PaymentDocuments_BudgetOrder',
  8: 'UI_Operations_PaymentDocuments_OrderMassPayment',
};

/** Combo lists (1.3). Combos are editable: other values may be typed. */
export const PAYMENT_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'] as const;
export const PAYMENT_SYSTEMS = ['БИСЕРА', 'РИНГС', 'SWIFT'] as const;
export const PAYMENT_TAXES = [1, 2, 3] as const;
export const TAXES_HELP = 'Такси: 1 - за сметка на наредителя; 2 - споделени (стандартно за преводи в страната); 3 - за сметка на получателя.';
export const BUDGET_PAYMENT_TYPES = [110000, 551111, 561111, 581111] as const;
/** DocumentType combo of the budget order (unused by validation, 1.9). */
export const BUDGET_DOCUMENT_TYPES = [1, 2, 3, 4, 5, 6, 9] as const;

/** All persisted fields of a payment document (view-model names mapped to the table columns). */
export interface PaymentDocumentFields {
  bankName: string | null;
  bankBranch: string | null;
  bankAddress: string | null;
  issuePlace: string | null;
  issueDate: string | null;
  personName: string | null;
  personIban: string | null;
  personBank: string | null;
  personBic: string | null;
  currency: string | null;
  /** Amount as typed (string on the view model). */
  qtty: string | null;
  inWords: string | null;
  autorizedPerson: string | null;
  idNumber: string | null;
  egn: string | null;
  lnch: string | null;
  receivedBy: string | null;
  /** OrderingCustomer (Credit, Due, Budget*, MassPayment) / BeneficiaryCustomer (Debit). */
  customer: string | null;
  customerIban: string | null;
  customerBic: string | null;
  duePerson: string | null;
  reason: string | null;
  reasonEx: string | null;
  executionDate: string | null;
  taxes: number | null;
  paymentSystem: string | null;
  paymentType: number | null;
  paymentType2: number | null;
  documentDate: string | null;
  documentTypeCode: number | null;
  documentNumber: string | null;
  startDate: string | null;
  endDate: string | null;
  bulstat: string | null;
  ebkParagraph: string | null;
  kid: string | null;
  budgetCode: string | null;
  sebra: string | null;
  rowsCount: string | null;
  controlCode: string | null;
}

export type PaymentDocumentField = keyof PaymentDocumentFields;

export const STRING_FIELDS: PaymentDocumentField[] = [
  'bankName', 'bankBranch', 'bankAddress', 'issuePlace', 'personName', 'personIban', 'personBank', 'personBic', 'currency',
  'autorizedPerson', 'idNumber', 'egn', 'lnch', 'receivedBy', 'customer', 'customerIban', 'customerBic', 'duePerson',
  'reason', 'reasonEx', 'paymentSystem', 'documentNumber', 'bulstat', 'ebkParagraph', 'kid', 'budgetCode', 'sebra', 'rowsCount', 'controlCode',
];

export function emptyPaymentDocument(): PaymentDocumentFields {
  return {
    bankName: null, bankBranch: null, bankAddress: null, issuePlace: null, issueDate: null, personName: null, personIban: null,
    personBank: null, personBic: null, currency: null, qtty: null, inWords: null, autorizedPerson: null, idNumber: null, egn: null,
    lnch: null, receivedBy: null, customer: null, customerIban: null, customerBic: null, duePerson: null, reason: null, reasonEx: null,
    executionDate: null, taxes: null, paymentSystem: null, paymentType: null, paymentType2: null, documentDate: null,
    documentTypeCode: null, documentNumber: null, startDate: null, endDate: null, bulstat: null, ebkParagraph: null, kid: null,
    budgetCode: null, sebra: null, rowsCount: null, controlCode: null,
  };
}

/* ------------------------------------------------------------------ */
/* Field sheets (1.3)                                                  */
/* ------------------------------------------------------------------ */

export type FieldKind = 'text' | 'iban' | 'currency' | 'money' | 'words' | 'date' | 'taxes' | 'paymentSystem' | 'paymentType' | 'bank' | 'derived';

export interface FieldDef {
  key: PaymentDocumentField;
  label: string;
  kind: FieldKind;
  /** XAML MaxLength; save truncates to this, else to 50 (LimitStringField). */
  maxLength?: number;
  /** Suggestion list for editable combos. */
  list?: 'personNames' | 'personIbans' | 'orderers' | 'orderersIbans';
  /** Group caption on the form. */
  group: string;
}

const H = 'Банка';
/** The header block common to every form (bank, branch, address, place and date). */
const HEADER: FieldDef[] = [
  { key: 'bankName', label: 'До банка', kind: 'text', group: H },
  { key: 'bankBranch', label: 'Клон', kind: 'text', group: H },
  { key: 'bankAddress', label: 'Адрес', kind: 'text', group: H },
  { key: 'issuePlace', label: 'Място', kind: 'text', group: H },
  { key: 'issueDate', label: 'Дата на подаване', kind: 'date', group: H },
];

const AMOUNT = 'Сума';
const amount = (words: boolean): FieldDef[] => [
  { key: 'currency', label: 'Вид валута', kind: 'currency', group: AMOUNT },
  { key: 'qtty', label: 'Сума', kind: 'money', group: AMOUNT },
  ...(words ? [{ key: 'inWords', label: 'Словом', kind: 'words', group: AMOUNT } as FieldDef] : []),
];

export const FIELD_SHEETS: Record<Exclude<PaymentDocumentTypeId, 7>, FieldDef[]> = {
  1: [
    ...HEADER,
    { key: 'personName', label: 'Наредител (име)', kind: 'text', list: 'orderers', group: 'Наредител' },
    { key: 'personIban', label: 'IBAN', kind: 'iban', list: 'personIbans', group: 'Наредител' },
    { key: 'personBank', label: 'Банка', kind: 'bank', group: 'Наредител' },
    ...amount(true),
    { key: 'autorizedPerson', label: 'Упълномощено лице', kind: 'text', group: 'Вносител' },
    { key: 'idNumber', label: 'Лична карта №', kind: 'text', maxLength: 9, group: 'Вносител' },
    { key: 'egn', label: 'ЕГН', kind: 'text', maxLength: 10, group: 'Вносител' },
    { key: 'receivedBy', label: 'Получил', kind: 'text', group: 'Вносител' },
  ],
  2: [
    ...HEADER,
    { key: 'personName', label: 'В полза на (получател)', kind: 'text', list: 'personNames', group: 'Получател' },
    { key: 'personIban', label: 'IBAN на получателя', kind: 'iban', list: 'personIbans', group: 'Получател' },
    { key: 'personBic', label: 'BIC на банката на получателя', kind: 'derived', group: 'Получател' },
    { key: 'personBank', label: 'При банка', kind: 'derived', group: 'Получател' },
    ...amount(true),
    { key: 'customer', label: 'Вносител', kind: 'text', list: 'orderers', group: 'Вносител' },
    { key: 'reason', label: 'Основание за внасяне', kind: 'text', group: 'Вносител' },
  ],
  3: [
    ...HEADER,
    { key: 'personName', label: 'Платете на (име на получателя)', kind: 'text', list: 'personNames', group: 'Получател' },
    { key: 'personIban', label: 'IBAN на получателя', kind: 'iban', list: 'personIbans', group: 'Получател' },
    { key: 'personBic', label: 'BIC на банката на получателя', kind: 'derived', group: 'Получател' },
    { key: 'personBank', label: 'При банка', kind: 'derived', group: 'Получател' },
    ...amount(false),
    { key: 'reason', label: 'Основание за превода', kind: 'text', group: 'Основание' },
    { key: 'reasonEx', label: 'Още пояснения', kind: 'text', group: 'Основание' },
    { key: 'customer', label: 'Наредител (име)', kind: 'text', list: 'orderers', group: 'Наредител' },
    { key: 'customerIban', label: 'IBAN на наредителя', kind: 'iban', list: 'orderersIbans', group: 'Наредител' },
    { key: 'customerBic', label: 'BIC на банката на наредителя', kind: 'derived', group: 'Наредител' },
    { key: 'paymentSystem', label: 'Платежна система', kind: 'paymentSystem', group: 'Наредител' },
    { key: 'executionDate', label: 'Дата на изпълнение', kind: 'date', group: 'Наредител' },
    { key: 'taxes', label: 'Такси', kind: 'taxes', group: 'Наредител' },
  ],
  4: [
    ...HEADER,
    { key: 'personName', label: 'Платец', kind: 'text', list: 'personNames', group: 'Платец' },
    { key: 'personIban', label: 'IBAN на платеца', kind: 'iban', list: 'personIbans', group: 'Платец' },
    { key: 'personBic', label: 'BIC на банката на платеца', kind: 'derived', group: 'Платец' },
    { key: 'personBank', label: 'При банка', kind: 'derived', group: 'Платец' },
    ...amount(false),
    { key: 'reason', label: 'Основание за дебитиране', kind: 'text', group: 'Основание' },
    { key: 'reasonEx', label: 'Още пояснения', kind: 'text', group: 'Основание' },
    { key: 'customer', label: 'Получател (име)', kind: 'text', list: 'orderers', group: 'Получател' },
    { key: 'customerIban', label: 'IBAN на получателя', kind: 'iban', list: 'orderersIbans', group: 'Получател' },
    { key: 'customerBic', label: 'BIC на банката на получателя', kind: 'derived', group: 'Получател' },
    { key: 'executionDate', label: 'Дата на изпълнение', kind: 'date', group: 'Получател' },
    { key: 'taxes', label: 'Такси', kind: 'taxes', group: 'Получател' },
    { key: 'paymentSystem', label: 'Платежна система', kind: 'paymentSystem', group: 'Получател' },
  ],
  5: [
    ...HEADER,
    { key: 'personName', label: 'Платете на (име на получателя)', kind: 'text', list: 'personNames', group: 'Получател' },
    { key: 'personIban', label: 'IBAN на получателя', kind: 'iban', list: 'personIbans', group: 'Получател' },
    { key: 'personBic', label: 'BIC на банката на получателя', kind: 'derived', group: 'Получател' },
    { key: 'personBank', label: 'При банка', kind: 'derived', group: 'Получател' },
    { key: 'paymentType', label: 'Вид плащане', kind: 'paymentType', group: 'Получател' },
    ...amount(false),
    { key: 'reason', label: 'Основание за плащане', kind: 'text', group: 'Основание' },
    { key: 'reasonEx', label: 'Още пояснения', kind: 'text', group: 'Основание' },
    { key: 'duePerson', label: 'Задължено лице', kind: 'text', group: 'Задължено лице' },
    { key: 'bulstat', label: 'БУЛСТАТ', kind: 'text', group: 'Задължено лице' },
    { key: 'egn', label: 'ЕГН', kind: 'text', maxLength: 10, group: 'Задължено лице' },
    { key: 'lnch', label: 'ЛНЧ', kind: 'text', maxLength: 12, group: 'Задължено лице' },
    { key: 'customer', label: 'Наредител (име)', kind: 'text', list: 'orderers', group: 'Наредител' },
    { key: 'customerIban', label: 'IBAN на наредителя', kind: 'iban', list: 'orderersIbans', group: 'Наредител' },
    { key: 'customerBic', label: 'BIC на банката на наредителя', kind: 'derived', group: 'Наредител' },
    { key: 'sebra', label: 'Код SEBRA', kind: 'text', group: 'Наредител' },
    { key: 'paymentSystem', label: 'Платежна система', kind: 'paymentSystem', group: 'Наредител' },
    { key: 'executionDate', label: 'Дата на изпълнение', kind: 'date', group: 'Наредител' },
    { key: 'taxes', label: 'Такси', kind: 'taxes', group: 'Наредител' },
  ],
  6: [
    ...HEADER,
    { key: 'personName', label: 'В полза на (получател)', kind: 'text', list: 'personNames', group: 'Получател' },
    { key: 'personIban', label: 'IBAN на получателя', kind: 'iban', list: 'personIbans', group: 'Получател' },
    { key: 'personBic', label: 'BIC на банката на получателя', kind: 'derived', group: 'Получател' },
    { key: 'personBank', label: 'При банка', kind: 'derived', group: 'Получател' },
    { key: 'paymentType', label: 'Вид плащане', kind: 'paymentType', group: 'Получател' },
    ...amount(true),
    { key: 'reason', label: 'Основание за плащане', kind: 'text', maxLength: 70, group: 'Основание' },
    { key: 'reasonEx', label: 'Още пояснения', kind: 'text', maxLength: 70, group: 'Основание' },
    { key: 'duePerson', label: 'Задължено лице', kind: 'text', group: 'Задължено лице' },
    { key: 'bulstat', label: 'БУЛСТАТ', kind: 'text', group: 'Задължено лице' },
    { key: 'egn', label: 'ЕГН', kind: 'text', maxLength: 10, group: 'Задължено лице' },
    { key: 'lnch', label: 'ЛНЧ', kind: 'text', maxLength: 12, group: 'Задължено лице' },
    { key: 'customer', label: 'Вносител', kind: 'text', list: 'orderers', group: 'Вносител' },
    { key: 'receivedBy', label: 'Получил', kind: 'text', group: 'Вносител' },
    { key: 'paymentSystem', label: 'Платежна система', kind: 'paymentSystem', group: 'Вносител' },
  ],
  8: [
    ...HEADER,
    { key: 'personIban', label: 'IBAN на сметката за задължаване', kind: 'iban', list: 'orderersIbans', group: 'Наредител' },
    { key: 'personBic', label: 'BIC на банката', kind: 'bank', group: 'Наредител' },
    { key: 'customer', label: 'Наредител', kind: 'text', list: 'orderers', group: 'Наредител' },
    ...amount(false),
    { key: 'reason', label: 'Основание', kind: 'text', group: 'Основание' },
    { key: 'rowsCount', label: 'Брой редове', kind: 'text', maxLength: 6, group: 'Основание' },
    { key: 'controlCode', label: 'Контролна сума / код', kind: 'text', maxLength: 6, group: 'Основание' },
  ],
};

export function fieldSheet(type: number): FieldDef[] {
  return (FIELD_SHEETS as Record<number, FieldDef[]>)[type] ?? HEADER;
}

/** Fields shown in the list grid (name column and reason column per type, 1.6). */
export function listColumns(type: number, d: Partial<PaymentDocumentFields>) {
  const name = type === 2 || type === 8 ? d.customer : d.personName;
  const reason = type === 1 ? d.autorizedPerson : [d.reason, d.reasonEx].filter(Boolean).join(' ');
  return { name: name ?? '', iban: d.personIban ?? '', reason: reason ?? '' };
}

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

/** Empty Currency getter returns "EUR" (1.3). */
export const effectiveCurrency = (c: string | null | undefined) => (c && c.trim() ? c.trim() : 'EUR');

/** Qtty setter: whitespace becomes "0". */
export function normalizeQtty(q: string | null | undefined): string {
  if (q === null || q === undefined) return '';
  return q.trim() === '' && q.length > 0 ? '0' : q;
}

/** ConvertDocumentSumToText(Qtty, Currency) (1.10.1). */
export function documentSumToText(qtty: string | null | undefined, currency: string | null | undefined): string {
  const v = parseAmount(String(qtty ?? ''));
  if (!v) return '';
  return amountInWords(v, effectiveCurrency(currency));
}

/** FormattedQtty: "{0:0.00}" left-padded with '<' to 13 characters (fill mark). */
export function formattedQtty(qtty: string | null | undefined): string {
  const v = parseAmount(String(qtty ?? '')) ?? dec(0);
  return v.toFixed(2).padStart(13, '<');
}

/** GetDocumentReason(paymentType) (1.9). */
export function budgetReasonByPaymentType(paymentType: number | null | undefined): string {
  switch (paymentType) {
    case 581111: return 'Осигурителни вноски за ДЗПО';
    case 561111: return 'Осигурителни вноски за НЗОК';
    case 551111: return 'Осигуровки за ДОО, УчПФ и ФГВРС';
    case 110000: return 'Данък по ЗДДФЛ';
    default: return '';
  }
}

/** NAP branch data (NAPBranchName, NAPBranch*IBAN): never assigned in the original build. */
export interface NapBranchData {
  name: string | null;
  ibanByPaymentType: Partial<Record<number, string>>;
}
export const UNCONFIGURED_NAP: NapBranchData = { name: null, ibanByPaymentType: {} };

/**
 * Field changes when PaymentType changes (1.9): BudgetDue gets the reason of
 * the purpose; BudgetOrder gets the NAP branch name and account of the
 * purpose. With no NAP data (as shipped) nothing is filled; values the user
 * typed are kept rather than overwritten with the empty NAP values.
 */
export function paymentTypeChangePatch(type: number, paymentType: number | null, nap: NapBranchData = UNCONFIGURED_NAP): Partial<PaymentDocumentFields> {
  if (type === 5) {
    const reason = budgetReasonByPaymentType(paymentType);
    return reason ? { reason } : {};
  }
  if (type === 6) {
    const patch: Partial<PaymentDocumentFields> = {};
    const iban = paymentType == null ? undefined : nap.ibanByPaymentType[paymentType];
    if (nap.name) patch.personName = nap.name;
    if (iban) patch.personIban = iban;
    return patch;
  }
  return {};
}

/**
 * LimitStringField on save: trim IssuePlace, truncate every string to the
 * field's MaxLength, default 50 (even where the column is 70 wide).
 */
export function limitPaymentDocumentFields(type: number, d: PaymentDocumentFields): PaymentDocumentFields {
  const max = new Map(fieldSheet(type).filter((f) => f.maxLength).map((f) => [f.key, f.maxLength!]));
  const out = { ...d };
  for (const k of STRING_FIELDS) {
    let v = out[k] as string | null;
    if (v === null || v === undefined) continue;
    if (k === 'issuePlace') v = v.trim();
    (out as Record<string, unknown>)[k] = v.slice(0, max.get(k) ?? 50);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Validators of the module (1.4.1, 1.4.2)                              */
/* ------------------------------------------------------------------ */

/**
 * ValidateIBAN, bug-compatible: only spaces are removed, case is not
 * normalised (lower-case letters make the IBAN invalid), no country/length
 * check, 2-digit chunks, valid iff 98 - rem equals the check digits.
 */
export function isPaymentDocumentIbanValid(iban: string): boolean {
  const s = iban.replace(/ /g, '');
  if (s.length < 4) return false;
  if (!/^\d\d$/.test(s.slice(2, 4))) return false;
  const check = Number(s.slice(2, 4));
  let t = '';
  for (const ch of s.slice(4) + s.slice(0, 2) + '00') {
    if (ch >= 'A' && ch <= 'Z') t += String(ch.charCodeAt(0) - 55);
    else if (ch >= '0' && ch <= '9') t += ch;
    else return false;
  }
  if (t.length % 2 === 1) t = '0' + t;
  let rem = 0;
  for (let i = 0; i < t.length; i += 2) rem = (rem * 100 + Number(t.slice(i, i + 2))) % 97;
  return 98 - rem === check;
}

/** FrameworkHelperMethods.IsBulstatValid: exactly 9 digits (a 13-digit EIK is rejected). */
export function isPaymentDocumentBulstatValid(input: string): boolean {
  const s = input.trim();
  if (!/^\d{9}$/.test(s)) return false;
  const d = [...s].map(Number);
  let r = 0;
  for (let i = 0; i < 8; i++) r += d[i]! * (i + 1);
  r %= 11;
  if (r === 10) {
    r = 0;
    for (let i = 0; i < 8; i++) r += d[i]! * (i + 3);
    r = (r % 11) % 10;
  }
  return d[8] === r;
}

/** IsEGNValid: mod 11 with weights 2,4,8,5,10,9,7,3,6; no birth-date check. */
export const isPaymentDocumentEgnValid = (s: string) => isValidEgnChecksum(s);
/** IsForeignerNumberValid. */
export const isPaymentDocumentLnchValid = (s: string) => isValidLnch(s);

/* ------------------------------------------------------------------ */
/* Validation matrix (1.4)                                             */
/* ------------------------------------------------------------------ */

export const PAYMENT_DOCUMENT_MESSAGES = {
  strQttyIsEmpty: 'Не е въведена сума на документа!',
  strQttyIsZero: 'Сумата на документа трябва да е по-голяма от нула!',
  strCurrencyIsEmpty: 'Не е въведена валута на документа!',
  strTaxInvalidValue: "Въведената стойност в полето 'Такси' е невалидна!",
  strPaymentTypeIsEmpty: 'Не е въведен тип на плащането!',
  strInvalidEGN: 'Невалиден ЕГН!',
  strInvalidLNCH: 'Невалиден ЛНЧ!',
  strNonValidBulstat: 'Невалиден Булстат номер',
  strDuePersonIsEmpty: 'Не е въведенo задължено лице(юридическо или физическо лице)!',
  strIDNumberTooLong: 'Номерът на документа за самоличност не може да е повече от 9 символа!',
  strOrderPersonNameMissing: 'Не е въведено име на наредител!',
  strOrderPersonBankIsEmpty: 'Не е въведена банка на наредител!',
  strOrderPersonIBANIsEmpty: 'Не е въведена банкова сметка на наредител!',
  strOrderPersonIBANIsInvalid: 'Банковата сметка на наредителя е невалидна!',
  strSenderIsEmpty: 'Не е въведено име на вносителя!',
  strBeneficiaryPersonIBANIsEmpty: 'Не е въведена банкова сметка на получател!',
  strBeneficiaryPersonIBANIsInvalid: 'Банковата сметка на получателя е невалидна!',
  strBeneficiaryPersonNameMissing: 'Не е въведено име на получател!',
  strBeneficiaryPersonBankIsEmpty: 'Не е въведена банка на получател!',
  strTrasferMoneyReasonIsEmpty: 'Не е въведено основание за паричния превод!',
  strOrderDebitPersonNameMissing: 'Не е въведено име на платец!',
  strOrderDebitPersonIBANIsEmpty: 'Не е въведена банкова сметка на платец!',
  strOrderDebitPersonIBANIsInvalid: 'Банковата сметка на платеца е невалидна!',
  strOrderDebitPersonBankIsEmpty: 'Не е въведена банка на платец!',
  strBudgetReasonIsEmpty: 'Не е въведено основание за плащането!',
  strInvalidPeriod: 'Началната дата на периода е по-голяма от крайната!',
  strDocumentTypeIsInvalid: 'Невалиден тип на документа!',
  // Export / print (1.6, 1.8)
  strBankNotSelected: 'Не е избрана банка, към която да се извърши експорт!',
  strNoDocumentToExport: 'Няма избран документ!',
  strBICIsIncorrect: 'BIC кода на банката на наредителя не отговаря на избраната банка за експорт!',
  strPaymentDocumentExportNotImplemented: 'Към избраната банка няма активиран експорт. За повече информация се свържете с екипа на Microinvest!',
  strCannotPrintDeletedDocuments: 'Не могат да се принтират/експортират изтрити документи.',
  strCannotExportDeletedDocument: 'Не може да бъде експортиран изтрит документ.',
  strExportPaymentDocument: 'Експорт на платежни документи към електронен файл!',
  strPaymentDocumentSaved: 'Данните са записани успешно.',
  strDeletePaymentDocumentConfirmation: 'Желаете ли изтриване на избрания(те) документ(и)?',
  strDiscardChangesConfirmation: 'Желаете ли отказ от направените промени?',
  strSaveChangesConfirmation: 'Желаете ли да запишете направените промени?',
  strExecutePaymentDocumentsLogConfirmation: 'Експортът е извършен успешно! Желаете ли изпълнение на справка Дневник на платежните документи?',
  strLoadPaymentDocuments: 'Зареждане на платежни документи...',
} as const;
export type PaymentDocumentMessageKey = keyof typeof PAYMENT_DOCUMENT_MESSAGES;

type Doc = Partial<PaymentDocumentFields>;
type Msgs = ValidationMessage[];

const msg = (out: Msgs, key: PaymentDocumentMessageKey) => out.push({ key, text: PAYMENT_DOCUMENT_MESSAGES[key], severity: 'warning' });
const empty = (v: unknown) => v === null || v === undefined || v === '';

function isEmptyCheck(out: Msgs, v: string | null | undefined, key: PaymentDocumentMessageKey) {
  if (empty(v)) msg(out, key);
}
function ibanCheck(out: Msgs, v: string | null | undefined, prefix: 'strOrderPersonIBAN' | 'strBeneficiaryPersonIBAN' | 'strOrderDebitPersonIBAN') {
  if (empty(v)) msg(out, `${prefix}IsEmpty`);
  else if (!isPaymentDocumentIbanValid(v!)) msg(out, `${prefix}IsInvalid`);
}
function qttyCheck(out: Msgs, q: string | null | undefined) {
  const s = q ?? '';
  if (s === '') return msg(out, 'strQttyIsEmpty');
  const v = parseAmount(normalizeQtty(s));
  if (!v || v.lessThanOrEqualTo(0)) msg(out, 'strQttyIsZero');
}
function currencyCheck(out: Msgs, c: string | null | undefined) {
  if (empty(effectiveCurrency(c))) msg(out, 'strCurrencyIsEmpty');
}
function taxesCheck(out: Msgs, t: number | null | undefined) {
  if (t !== null && t !== undefined && !(t >= 1 && t <= 3 && Number.isInteger(t))) msg(out, 'strTaxInvalidValue');
}
function paymentTypeCheck(out: Msgs, t: number | null | undefined) {
  if (t === null || t === undefined) msg(out, 'strPaymentTypeIsEmpty');
}
function egnCheck(out: Msgs, v: string | null | undefined) {
  if (!empty(v) && !isPaymentDocumentEgnValid(v!)) msg(out, 'strInvalidEGN');
}
function lnchCheck(out: Msgs, v: string | null | undefined) {
  if (!empty(v) && !isPaymentDocumentLnchValid(v!)) msg(out, 'strInvalidLNCH');
}
function bulstatCheck(out: Msgs, v: string | null | undefined) {
  if (!empty(v) && !isPaymentDocumentBulstatValid(v!)) msg(out, 'strNonValidBulstat');
}
function duePersonCheck(out: Msgs, d: Doc) {
  if (empty(d.duePerson) && empty(d.customer)) msg(out, 'strDuePersonIsEmpty');
}

/**
 * Validate() of each view model, in the original order. Every result is
 * NonCritical (severity 'warning'): saving is never blocked (1.4).
 */
export function validatePaymentDocument(type: number, d: Doc): ValidationMessage[] {
  const out: Msgs = [];
  switch (type) {
    case 1:
      ibanCheck(out, d.personIban, 'strOrderPersonIBAN');
      currencyCheck(out, d.currency);
      egnCheck(out, d.egn);
      isEmptyCheck(out, d.personName, 'strOrderPersonNameMissing');
      isEmptyCheck(out, d.personBank, 'strOrderPersonBankIsEmpty');
      qttyCheck(out, d.qtty);
      if ((d.idNumber ?? '').length > 9) msg(out, 'strIDNumberTooLong');
      break;
    case 2:
      qttyCheck(out, d.qtty);
      isEmptyCheck(out, d.customer, 'strSenderIsEmpty');
      ibanCheck(out, d.personIban, 'strBeneficiaryPersonIBAN');
      isEmptyCheck(out, d.personName, 'strBeneficiaryPersonNameMissing');
      currencyCheck(out, d.currency);
      isEmptyCheck(out, d.personBank, 'strBeneficiaryPersonBankIsEmpty');
      break;
    case 3:
      ibanCheck(out, d.customerIban, 'strOrderPersonIBAN');
      isEmptyCheck(out, d.customer, 'strOrderPersonNameMissing');
      isEmptyCheck(out, d.reason, 'strTrasferMoneyReasonIsEmpty');
      ibanCheck(out, d.personIban, 'strBeneficiaryPersonIBAN');
      isEmptyCheck(out, d.personName, 'strBeneficiaryPersonNameMissing');
      isEmptyCheck(out, d.personBank, 'strBeneficiaryPersonBankIsEmpty');
      currencyCheck(out, d.currency);
      qttyCheck(out, d.qtty);
      taxesCheck(out, d.taxes);
      break;
    case 4:
      isEmptyCheck(out, d.personName, 'strOrderDebitPersonNameMissing');
      ibanCheck(out, d.personIban, 'strOrderDebitPersonIBAN');
      isEmptyCheck(out, d.personBank, 'strOrderDebitPersonBankIsEmpty');
      isEmptyCheck(out, d.customer, 'strBeneficiaryPersonNameMissing');
      ibanCheck(out, d.customerIban, 'strBeneficiaryPersonIBAN');
      isEmptyCheck(out, d.reason, 'strTrasferMoneyReasonIsEmpty');
      currencyCheck(out, d.currency);
      qttyCheck(out, d.qtty);
      taxesCheck(out, d.taxes);
      break;
    case 5:
      paymentTypeCheck(out, d.paymentType);
      isEmptyCheck(out, d.personName, 'strBeneficiaryPersonNameMissing');
      ibanCheck(out, d.personIban, 'strBeneficiaryPersonIBAN');
      isEmptyCheck(out, d.personBank, 'strBeneficiaryPersonBankIsEmpty');
      isEmptyCheck(out, d.reason, 'strBudgetReasonIsEmpty');
      duePersonCheck(out, d);
      bulstatCheck(out, d.bulstat);
      egnCheck(out, d.egn);
      lnchCheck(out, d.lnch);
      isEmptyCheck(out, d.customer, 'strOrderPersonNameMissing');
      ibanCheck(out, d.customerIban, 'strOrderPersonIBAN');
      currencyCheck(out, d.currency);
      qttyCheck(out, d.qtty);
      break;
    case 6:
      paymentTypeCheck(out, d.paymentType);
      isEmptyCheck(out, d.personName, 'strBeneficiaryPersonNameMissing');
      ibanCheck(out, d.personIban, 'strBeneficiaryPersonIBAN');
      duePersonCheck(out, d);
      bulstatCheck(out, d.bulstat);
      egnCheck(out, d.egn);
      lnchCheck(out, d.lnch);
      isEmptyCheck(out, d.customer, 'strOrderPersonNameMissing');
      currencyCheck(out, d.currency);
      qttyCheck(out, d.qtty);
      break;
    case 8:
      ibanCheck(out, d.personIban, 'strBeneficiaryPersonIBAN');
      isEmptyCheck(out, d.customer, 'strSenderIsEmpty');
      currencyCheck(out, d.currency);
      qttyCheck(out, d.qtty);
      break;
    default:
      // Transire: Validate() returns an empty list.
      break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* IBAN -> bank (1.5)                                                  */
/* ------------------------------------------------------------------ */

export const PAYSERA = { code: 'EVIULT2V', name: 'Paysera LT, UAB' } as const;

/**
 * IBANService.FindBankByIBAN: normalise (remove ' ', '-', '.'; upper case);
 * the first bank whose BIC starts with IBAN characters 5-8; Paysera for IBANs
 * starting "EVP", characters 5-9 = "35000", or Postbank 794212 accounts in
 * the Paysera number range.
 */
export function findBankByIban<B extends { code: string | null; name: string | null }>(iban: string | null | undefined, banks: B[]): B | { code: string; name: string } | null {
  const s = (iban ?? '').replace(/[\s\-.]/g, '').toUpperCase();
  if (s.startsWith('EVP') || s.slice(4, 9) === '35000') return { ...PAYSERA };
  if (s.length < 8) return null;
  const key = s.slice(4, 8);
  const bank = banks.find((b) => b.code && b.code.toUpperCase().startsWith(key)) ?? null;
  if (bank && bank.code!.toUpperCase() === 'BPBIBGSF' && s.slice(8, 14) === '794212') {
    const n = Number(s.slice(14));
    if (Number.isFinite(n) && n >= 6000 && n <= 106001) return { ...PAYSERA };
  }
  return bank;
}

/**
 * Field changes when an IBAN is typed: PersonIBAN fills PersonBIC and
 * PersonBank, the orderer/beneficiary-customer IBAN fills its BIC. Nothing
 * changes when no bank is found.
 */
export function ibanChangePatch(field: 'personIban' | 'customerIban', iban: string | null, banks: { code: string | null; name: string | null }[]): Partial<PaymentDocumentFields> {
  const bank = findBankByIban(iban, banks);
  if (!bank) return {};
  return field === 'personIban' ? { personBic: bank.code, personBank: bank.name } : { customerBic: bank.code };
}

/* ------------------------------------------------------------------ */
/* UBB export (1.8)                                                    */
/* ------------------------------------------------------------------ */

export const UBB_BIC = 'UBBSBGSF';

export interface UbbSchema {
  type: 3 | 5;
  fileName: string;
}
export const UBB_SCHEMAS: Record<3 | 5, UbbSchema> = {
  3: { type: 3, fileName: 'MPLSSAL311.TXT' },
  5: { type: 5, fileName: 'MPLSSAL313.TXT' },
};

/** "NoAligment": truncate to the length, never pad. */
const cut = (v: string | null | undefined, len: number) => (v ?? '').slice(0, len);
/** decimal fields formatted "0.00" (the original follows the Windows culture; a point is written here). */
const sumField = (q: string | null | undefined) => (parseAmount(String(q ?? '')) ?? dec(0)).toFixed(2).slice(0, 12);

/** One record of the UBB text file (OrderCredit -> 311, BudgetDue -> 313). */
export function ubbRecord(type: number, d: Doc): string {
  const cur = effectiveCurrency(d.currency);
  if (type === 3) {
    return 'IBAN311|' + cut(d.personName, 35) + '|' + cut(d.personIban, 22) + '|' + cut(d.personBic, 8) + '|' + cut(cur, 8) + '|' + sumField(d.qtty) + '|'
      + cut(d.reason, 35) + '|' + cut(d.reasonEx, 35) + '|||' + '\r\n';
  }
  if (type === 5) {
    return 'IBAN313|' + cut(d.personName, 30) + '|' + cut(d.personIban, 22) + '|' + cut(d.personBic, 8) + '|' + cut(cur, 3) + '|' + sumField(d.qtty) + '|'
      + cut(d.reason, 35) + '|' + cut(d.reasonEx, 35) + '||' + cut(d.paymentType == null ? '' : String(d.paymentType), 6) + '||'
      + cut(d.bulstat, 13) + '|' + cut(d.egn, 10) + '||||||' + '\r\n';
  }
  throw new Error('NotImplemented');
}

export interface ExportCandidate extends Doc {
  id: number;
  isDeleted: boolean;
}

export interface ExportResult {
  ok: boolean;
  messages: (ValidationMessage & { documentId?: number })[];
  fileName?: string;
  content?: string;
}

/**
 * Export of the checked documents to the bank file: bank chosen and UBB,
 * type exportable, non-deleted documents, every validation result raised to
 * Critical plus the BIC check (ValidateExportToBank). Any message stops the
 * whole batch.
 */
export function exportToUbb(type: number, bankCode: string | null | undefined, docs: ExportCandidate[]): ExportResult {
  const fail = (key: PaymentDocumentMessageKey): ExportResult => ({ ok: false, messages: [{ key, text: PAYMENT_DOCUMENT_MESSAGES[key], severity: 'critical' }] });
  if (!bankCode) return fail('strBankNotSelected');
  if (bankCode.toUpperCase() !== UBB_BIC || (type !== 3 && type !== 5)) return fail('strPaymentDocumentExportNotImplemented');
  const live = docs.filter((d) => !d.isDeleted);
  if (!live.length) return fail(docs.length ? 'strCannotExportDeletedDocument' : 'strNoDocumentToExport');
  const messages: ExportResult['messages'] = [];
  for (const d of live) {
    for (const m of validatePaymentDocument(type, d)) messages.push({ ...m, severity: 'critical', documentId: d.id });
    if ((d.customerBic ?? '').toUpperCase() !== bankCode.toUpperCase()) {
      messages.push({ key: 'strBICIsIncorrect', text: PAYMENT_DOCUMENT_MESSAGES.strBICIsIncorrect, severity: 'critical', documentId: d.id });
    }
  }
  if (messages.length) return { ok: false, messages };
  return { ok: true, messages: [], fileName: UBB_SCHEMAS[type as 3 | 5].fileName, content: live.map((d) => ubbRecord(type, d)).join('') };
}

/* ------------------------------------------------------------------ */
/* Windows-1251                                                        */
/* ------------------------------------------------------------------ */

const CP1251_EXTRA: Record<number, number> = {
  0x0402: 0x80, 0x0403: 0x81, 0x201a: 0x82, 0x0453: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x20ac: 0x88,
  0x2030: 0x89, 0x0409: 0x8a, 0x2039: 0x8b, 0x040a: 0x8c, 0x040c: 0x8d, 0x040b: 0x8e, 0x040f: 0x8f, 0x0452: 0x90, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99, 0x0459: 0x9a, 0x203a: 0x9b,
  0x045a: 0x9c, 0x045c: 0x9d, 0x045b: 0x9e, 0x045f: 0x9f, 0x00a0: 0xa0, 0x040e: 0xa1, 0x045e: 0xa2, 0x0408: 0xa3, 0x00a4: 0xa4,
  0x0490: 0xa5, 0x00a6: 0xa6, 0x00a7: 0xa7, 0x0401: 0xa8, 0x00a9: 0xa9, 0x0404: 0xaa, 0x00ab: 0xab, 0x00ac: 0xac, 0x00ad: 0xad,
  0x00ae: 0xae, 0x0407: 0xaf, 0x00b0: 0xb0, 0x00b1: 0xb1, 0x0406: 0xb2, 0x0456: 0xb3, 0x0491: 0xb4, 0x00b5: 0xb5, 0x00b6: 0xb6,
  0x00b7: 0xb7, 0x0451: 0xb8, 0x2116: 0xb9, 0x0454: 0xba, 0x00bb: 0xbb, 0x0458: 0xbc, 0x0405: 0xbd, 0x0455: 0xbe, 0x0457: 0xbf,
};

/** Encodes text in Windows-1251 (the UBB file encoding); unmapped characters become '?'. */
export function encodeWindows1251(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out[n++] = c;
    else if (c >= 0x0410 && c <= 0x044f) out[n++] = c - 0x0410 + 0xc0;
    else out[n++] = CP1251_EXTRA[c] ?? 0x3f;
  }
  return out.slice(0, n);
}
