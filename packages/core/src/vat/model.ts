import { BGN_PER_EUR, EURO_CHANGEOVER_DATE, dec, round2, type Dec, type DecInput } from '../money.ts';
import { ICA_CODE_TYPES, VAT_DOC } from './constants.ts';

/**
 * In-memory model of the accountings the VAT functions read: the header
 * fields of 02b section 2 plus the legs (AccountingDetails) and the
 * account-less protocol rows (AccountID NULL in Delta).
 */

export interface VatPartner {
  id: number;
  name: string;
  vatNumber: string | null;
  bulstat: string | null;
}

export interface VatDetail {
  /** +1 debit (amount in `amount`), -1 credit (amount in `refAmount`). */
  sign: 1 | -1;
  amount: DecInput;
  refAmount: DecInput;
  vatTermId: number;
  /** null for the account-less base rows of a protocol. */
  accountId: number | null;
  accountNumber: string | null;
  /** The account is the VAT purchases account (category 16) or one of its sub-accounts. */
  isVatPurchase: boolean;
  /** The account is the VAT sales account (category 17) or one of its sub-accounts. */
  isVatSale: boolean;
  accountCategoryId?: number | null;
  /** Category of the counter account (RefAccountID). */
  refAccountCategoryId?: number | null;
  partner: VatPartner | null;
}

export interface VatAccounting {
  id: number;
  number: string;
  financialYearId: number;
  accountingDate: string;
  viesMonth: string;
  transactionTypeId: number;
  documentTypeId: number | null;
  /** DocumentTypes.Code (NAP code). */
  documentCode: string;
  documentShortName: string;
  documentNumber: string;
  documentDate: string;
  branchCode: string;
  /** Основание (Term). */
  term: string;
  /** Забележка (Reference) and Втора забележка (OptionalReference): shown by the extended diaries. */
  reference?: string;
  optionalReference?: string;
  viesId: number | null;
  icaType: number;
  /** Link main -> protocol accounting. */
  icaAccountingId: number | null;
  isInitialBalance: boolean;
  isInitialCorrespondence: boolean;
  /** AccountingExtendedDetails.VatDiaryCode values, in id order. */
  extendedCodes: string[];
  details: VatDetail[];
}

export interface VatIndex {
  byId: Map<number, VatAccounting>;
  /** Accountings sharing (financial year, number), in id order. */
  byNumber: Map<string, VatAccounting[]>;
}

export function indexAccountings(list: VatAccounting[]): VatIndex {
  const byId = new Map(list.map((a) => [a.id, a]));
  const byNumber = new Map<string, VatAccounting[]>();
  for (const a of [...list].sort((x, y) => x.id - y.id)) {
    const k = `${a.financialYearId}:${a.number}`;
    byNumber.set(k, [...(byNumber.get(k) ?? []), a]);
  }
  return { byId, byNumber };
}

/** Other accountings with the same number and financial year. */
export function siblingsOf(a: VatAccounting, ix: VatIndex): VatAccounting[] {
  return (ix.byNumber.get(`${a.financialYearId}:${a.number}`) ?? []).filter((x) => x.id !== a.id);
}

/** The ICA protocol of an accounting: IcaAccountingID link, else a sibling protocol accounting. */
export function protocolOf(a: VatAccounting, ix: VatIndex): VatAccounting | undefined {
  if (a.icaAccountingId != null) return ix.byId.get(a.icaAccountingId);
  return undefined;
}

/** Sibling protocol whose type feeds the diary code (ICAType 4, 5, 6, 8, 9). */
export function codeProtocolSibling(a: VatAccounting, ix: VatIndex): VatAccounting | undefined {
  return siblingsOf(a, ix).find((s) => ICA_CODE_TYPES.has(s.icaType));
}

export function hasProtocolSibling(a: VatAccounting, ix: VatIndex): boolean {
  return a.icaAccountingId != null || siblingsOf(a, ix).some((s) => s.icaType > 0 || s.documentTypeId === VAT_DOC.VatProtocol);
}

/** First detail with a partner (the accounting's partner in the diaries). */
export function partnerOf(a: VatAccounting): VatPartner | null {
  return a.details.find((d) => d.partner)?.partner ?? null;
}

/** Partner identifier for the diaries: VAT number when non-blank, else Bulstat, else empty. */
export function partnerVatId(p: VatPartner | null): string {
  if (!p) return '';
  if (p.vatNumber && p.vatNumber.trim()) return p.vatNumber.trim();
  return p.bulstat?.trim() ?? '';
}

/** Euro changeover (02b 13): convert leva amounts when the period ends on/after 2026-01-01. */
export function shouldConvert(periodEnd: string, accountingDate: string): boolean {
  return periodEnd.slice(0, 10) >= EURO_CHANGEOVER_DATE && accountingDate < EURO_CHANGEOVER_DATE;
}

/** Per-detail conversion `ROUND(x / 1.95583, 2)` (away from zero). */
export function convertRounded(v: DecInput, periodEnd: string, accountingDate: string): Dec {
  return shouldConvert(periodEnd, accountingDate) ? round2(dec(v).div(BGN_PER_EUR)) : dec(v);
}

/** Unrounded conversion (VIES file, ICA report, turnovers). */
export function convertUnrounded(v: DecInput, periodEnd: string, accountingDate: string): Dec {
  return shouldConvert(periodEnd, accountingDate) ? dec(v).div(BGN_PER_EUR) : dec(v);
}

export const legValue = (d: VatDetail) => (d.sign > 0 ? dec(d.amount) : dec(d.refAmount));
