import { dec, round2, ZERO, type Dec, type DecInput } from '../money.ts';
import type { ValidationMessage } from '../journal.ts';
import { TRANSACTION_TYPE } from '../seeds/lookups.ts';
import { ICA_TYPE, VAT_MESSAGES, VIES_TYPE } from './constants.ts';

/**
 * Protocols under art. 117 ZDDS (ICA, spec 02b 7 and 19): the second
 * accounting with the same number that self-assesses the VAT.
 */

export interface ProtocolTemplate {
  transactionTypeId: number;
  purchaseTermId: number;
  saleTermId: number;
  /** Dt 453/1 (or expense account) / Kt 453/2 for the VAT. */
  vatPair: boolean;
  /** Account-less base rows (Dt purchase term / Kt sale term). */
  basePair: boolean;
  /** Default VatDiaryCode written as AccountingExtendedDetail. */
  defaultCode: string | null;
  /** Codes the user may choose. */
  codes: string[];
  /** The user chooses the purchase-side term (2, 3 or 4). */
  userTerm: boolean;
  defaultTerm: string;
}

/** Term pairs and generated rows per protocol type (02b 7.1 / 19). */
export function protocolTemplate(icaType: number, userPurchaseTerm: number | null): ProtocolTemplate {
  const user = userPurchaseTerm ?? 2;
  const base = { transactionTypeId: TRANSACTION_TYPE.Purchase, vatPair: true, basePair: true, defaultCode: null as string | null, codes: [] as string[], userTerm: false };
  switch (icaType) {
    case ICA_TYPE.IntraCommunityAcquisition:
      return { ...base, purchaseTermId: user, saleTermId: 8, userTerm: true, defaultTerm: 'Самоначисляване на ДДС при ВОП' };
    case ICA_TYPE.ServiceFromEu:
    case ICA_TYPE.ThirdCountryService:
      return { ...base, purchaseTermId: user, saleTermId: 9, userTerm: true, defaultTerm: 'Самоначисляване на ДДС при получена услуга' };
    case ICA_TYPE.Other:
      return { ...base, transactionTypeId: TRANSACTION_TYPE.Sale, purchaseTermId: 2, saleTermId: 8, basePair: false, defaultTerm: 'Туристическа услуга/Стоки втора употреба' };
    case ICA_TYPE.Art163a:
      return { ...base, purchaseTermId: 2, saleTermId: 8, vatPair: false, basePair: false, defaultCode: '01', codes: ['01', '02'], defaultTerm: 'Обратно начисляване по чл. 163а от ЗДДС' };
    case ICA_TYPE.Art167a:
      return { ...base, purchaseTermId: 2, saleTermId: 7, defaultCode: '03', codes: ['03'], defaultTerm: 'Отложено начисляване на данъка при внос' };
    case ICA_TYPE.CallOffStock:
      return { ...base, purchaseTermId: 12, saleTermId: 9, vatPair: false, basePair: false, defaultCode: '41', codes: ['41', '43', '46', '48', '51', '53', '54', '58'], defaultTerm: 'Режим складиране на стоки до поискване по чл. 15а' };
    case ICA_TYPE.BreadFlourAcquisition:
      return { ...base, purchaseTermId: 3, saleTermId: 8, vatPair: false, basePair: false, defaultCode: '07', codes: ['07', '08'], defaultTerm: 'ВОП - хляб и брашно' };
    case ICA_TYPE.BreadFlourDomestic:
      return { ...base, purchaseTermId: user, saleTermId: 9, vatPair: false, basePair: false, defaultCode: '07', codes: ['07', '08'], userTerm: true, defaultTerm: 'Доставка/Внос на хляб и брашно в страната' };
    default:
      throw new Error(`Unknown protocol type ${icaType}`);
  }
}

/** Calculate button: VAT = round(0.2 x base, 2, away from zero); the 20% is hard-coded. */
export function protocolVat(base: DecInput): Dec {
  return round2(dec(base).times('0.2'));
}

/** Default base B = sum of the main entry's debit amounts on non-VAT accounts (0 for type "Other"). */
export function protocolBase(icaType: number, mainDebits: { amount: DecInput; isVat: boolean }[]): Dec {
  if (icaType === ICA_TYPE.Other) return ZERO;
  return mainDebits.filter((d) => !d.isVat).reduce((a, d) => a.plus(dec(d.amount)), ZERO);
}

export interface ProtocolDraft {
  icaType: number;
  purchaseTermId: number | null;
  documentNumber: string;
  base: DecInput;
  vat: DecInput;
  /** Expense account for the "no credit" term (term 3). */
  expenseAccount?: { id: number; isLeaf: boolean } | null;
  vatDiaryCode?: string | null;
  /** VIES type of the main accounting (for the call-off code check). */
  mainViesId?: number | null;
}

/** Protocol dialog validations (02b 7.2 / 7.4). `confirm` messages need a Yes/No answer. */
export function validateProtocol(p: ProtocolDraft): { messages: ValidationMessage[]; confirm: ValidationMessage[] } {
  const messages: ValidationMessage[] = [];
  const confirm: ValidationMessage[] = [];
  const crit = (key: keyof typeof VAT_MESSAGES) => messages.push({ key, text: VAT_MESSAGES[key], severity: 'critical' });
  const t = protocolTemplate(p.icaType, p.purchaseTermId);
  if (t.userTerm && !p.purchaseTermId) crit('strMissingTerm');
  if (!p.documentNumber.trim() && p.icaType !== ICA_TYPE.BreadFlourDomestic) crit('strMissingDocumentNumber');
  if (t.vatPair && t.purchaseTermId === 3) {
    if (!p.expenseAccount) crit('strMissingCreditAccount');
    else if (!p.expenseAccount.isLeaf) crit('strICACreditAccountHasSubAccounts');
  }
  if (p.icaType === ICA_TYPE.Art163a && !protocolVat(p.base).equals(round2(p.vat))) {
    messages.push({ key: 'strInvalidICAVatAmount', text: VAT_MESSAGES.strInvalidICAVatAmount, severity: 'warning' });
  }
  const code = p.vatDiaryCode ?? '';
  const expected: Record<string, number> = { '41': VIES_TYPE.CallOffSending, '43': VIES_TYPE.CallOffReplacement, '46': VIES_TYPE.CallOffReturn };
  if (expected[code] !== undefined && p.mainViesId !== expected[code]) {
    confirm.push({ key: 'strIncorrectViesOperation', text: VAT_MESSAGES.strIncorrectViesOperation, severity: 'warning' });
  }
  return { messages, confirm };
}
