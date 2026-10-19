import { ZERO, type Dec } from '../money.ts';
import { TRANSACTION_TYPE } from '../seeds/lookups.ts';
import { KO_PURCHASE_CODES, KO_SALE_CODES, SALES_SPECIAL_TERMS, SELF_ASSESSED_TERMS, VAT_DOC } from './constants.ts';
import {
  codeProtocolSibling, convertRounded, hasProtocolSibling, indexAccountings, partnerOf, partnerVatId, siblingsOf,
  type VatAccounting, type VatDetail, type VatIndex,
} from './model.ts';

/**
 * Sales and purchase diaries with the semantics of the SQL table functions
 * `fnSaleDiaryReport` / `fnPurchaseDiaryReport` (spec 02b 4-5, 05 7.3). These
 * feed the on-screen diaries (cash-accounting documents included) and the
 * VAT return report (`spVATDeclarationReport`, cash documents excluded).
 */

export interface DiaryOptions {
  /** Period start, `yyyy-mm-dd`. */
  start: string;
  /**
   * Period end. The screen passes the last day at 23:59:59
   * (`yyyy-mm-dd 23:59:59`); the sales test is strict (`<`), the purchase test inclusive.
   */
  end: string;
  /** `@IsAddCashAccountingDocs`: 1 for the printed diary, 0 for the declaration. */
  addCashDocs: boolean;
  /** Sort by entry order (AccountingID) first. */
  sortByEntry?: boolean;
  /**
   * "Разширени дневници" (TReportType AllExtended, 05 7 / 8): the rows also
   * carry the entry number, Забележка and Втора забележка and are not merged
   * across entries or notes.
   */
  extended?: boolean;
}

export interface DiaryRow {
  accountingId: number;
  accountingNumber: string;
  transactionTypeId: number;
  branchCode: string;
  documentTypeId: number | null;
  documentType: string;
  documentCode: string;
  documentNumber: string;
  documentDate: string;
  partnerVat: string;
  partnerName: string;
  description: string;
  vatDiaryCode: string;
  /** Забележка / Втора забележка of the entry (extended diaries). */
  reference: string;
  optionalReference: string;
  /** Amount columns: sales 9..25 (17), purchases 9..15 (7). */
  cols: Dec[];
}

const isVatLegFor = (kind: 'sale' | 'purchase', d: VatDetail) => (kind === 'sale' ? d.isVatSale : d.isVatPurchase);

function firstCode(a: VatAccounting | undefined) {
  return a?.extendedCodes[0] ?? '';
}

/** ViesMonth of the first other accounting with the same number (fnReport_GetOriginalSaleViesMonthDate). */
function originalViesMonth(a: VatAccounting, ix: VatIndex): string | undefined {
  return siblingsOf(a, ix)[0]?.viesMonth;
}

function groupKey(r: DiaryRow, extended?: boolean) {
  const base = [r.transactionTypeId, r.branchCode, r.documentNumber, r.documentDate, r.documentType, r.partnerVat, r.partnerName, r.description, r.vatDiaryCode];
  return (extended ? [...base, r.accountingNumber, r.reference, r.optionalReference] : base).join('\u0001');
}

function addRow(groups: Map<string, DiaryRow>, row: DiaryRow, extended?: boolean) {
  const k = groupKey(row, extended);
  const g = groups.get(k);
  if (!g) {
    groups.set(k, row);
    return;
  }
  g.accountingId = Math.min(g.accountingId, row.accountingId);
  g.cols = g.cols.map((c, i) => c.plus(row.cols[i]!));
}

function sortRows(rows: DiaryRow[], sortByEntry?: boolean) {
  return rows.sort((a, b) =>
    (sortByEntry ? a.accountingId - b.accountingId : 0)
    || (a.documentDate < b.documentDate ? -1 : a.documentDate > b.documentDate ? 1 : 0)
    || (a.documentType < b.documentType ? -1 : a.documentType > b.documentType ? 1 : 0)
    || (a.documentNumber < b.documentNumber ? -1 : a.documentNumber > b.documentNumber ? 1 : 0),
  );
}

function header(a: VatAccounting, code: string): Omit<DiaryRow, 'cols'> {
  const p = partnerOf(a);
  return {
    accountingId: a.id,
    accountingNumber: a.number,
    transactionTypeId: a.transactionTypeId,
    branchCode: a.branchCode,
    documentTypeId: a.documentTypeId,
    documentType: a.documentShortName,
    documentCode: a.documentCode,
    documentNumber: a.documentNumber,
    documentDate: a.documentDate,
    partnerVat: partnerVatId(p),
    partnerName: p?.name ?? '',
    description: a.term,
    vatDiaryCode: code,
    reference: a.reference ?? '',
    optionalReference: a.optionalReference ?? '',
  };
}

/** fnSaleDiaryReport. Columns index i = diary column 9 + i. */
export function saleDiary(list: VatAccounting[], o: DiaryOptions, ix: VatIndex = indexAccountings(list)): DiaryRow[] {
  const groups = new Map<string, DiaryRow>();
  for (const a of list) {
    if (a.isInitialBalance || a.isInitialCorrespondence) continue;
    const periodDate = a.documentTypeId === VAT_DOC.VatProtocol ? (originalViesMonth(a, ix) ?? a.viesMonth) : a.viesMonth;
    if (!(periodDate >= o.start && periodDate < o.end)) continue;
    const ownCode = firstCode(a);
    const sibling = codeProtocolSibling(a, ix);
    const code = sibling ? firstCode(sibling) : ownCode === '01' || ownCode === '02' ? '' : ownCode;

    // Second UNION branch: customs declarations with a protocol sibling, zero amounts.
    if (a.documentTypeId === VAT_DOC.CustomsDeclaration && a.transactionTypeId === TRANSACTION_TYPE.NotSet) {
      if (hasProtocolSibling(a, ix)) addRow(groups, { ...header(a, code), cols: Array.from({ length: 17 }, () => ZERO) }, o.extended);
      continue;
    }
    const legs = a.details.filter((d) => d.sign === -1
      && (a.transactionTypeId === TRANSACTION_TYPE.Sale || (a.transactionTypeId === TRANSACTION_TYPE.Purchase && SELF_ASSESSED_TERMS.has(d.vatTermId))));
    if (!legs.length) continue;
    const cols = Array.from({ length: 17 }, () => ZERO);
    const cashOk = o.addCashDocs || !KO_SALE_CODES.has(a.documentCode);
    const callOff = a.documentTypeId === VAT_DOC.CallOffSendRegister || a.documentTypeId === VAT_DOC.CallOffReceiveRegister;
    for (const d of legs) {
      const v = convertRounded(d.refAmount, o.end, a.accountingDate);
      const vat = isVatLegFor('sale', d);
      const t = d.vatTermId;
      const add = (col: number) => {
        cols[col - 9] = cols[col - 9]!.plus(v);
      };
      if (!vat && !SALES_SPECIAL_TERMS.has(t)) add(9);
      if (vat && !SALES_SPECIAL_TERMS.has(t)) add(10);
      if (t === 7 && !vat && cashOk && !callOff) add(11);
      if (t === 7 && vat && cashOk) add(12);
      if (t === 8 && !vat && !callOff) add(13);
      if (t === 9 && !vat && !callOff) add(14);
      if (vat && (t === 8 || t === 9)) add(15);
      if (vat && t === 10) add(16);
      if (t === 11 && !vat && cashOk && !callOff) add(17);
      if (t === 11 && vat && cashOk) add(18);
      if (t === 12 && !vat) add(19);
      if (t === 13 && !vat) add(20);
      if (t === 14 && !vat && cashOk) add(21);
      if (t === 15 && !vat) add(22);
      if (t === 16 && !vat) add(23);
      if (t === 17 && !vat) add(24);
      if (t === 18 && !vat) add(25);
    }
    addRow(groups, { ...header(a, code), cols }, o.extended);
  }
  return sortRows([...groups.values()], o.sortByEntry);
}

const isCode78 = (c: string) => c === '07' || c === '08' || c === '7' || c === '8';

/** fnPurchaseDiaryReport. Columns index i = diary column 9 + i. */
export function purchaseDiary(list: VatAccounting[], o: DiaryOptions, ix: VatIndex = indexAccountings(list)): DiaryRow[] {
  const groups = new Map<string, DiaryRow>();
  for (const a of list) {
    if (a.isInitialBalance || a.isInitialCorrespondence) continue;
    if (!(a.viesMonth >= o.start && a.viesMonth <= o.end)) continue;
    const sibling = codeProtocolSibling(a, ix);
    const ownCode = firstCode(a);
    const code = sibling ? firstCode(sibling) : ['03', '07', '08'].includes(ownCode) ? ownCode : '';
    const cashOk = o.addCashDocs || !KO_PURCHASE_CODES.has(a.documentCode);
    const isCustoms = a.documentTypeId === VAT_DOC.CustomsDeclaration && a.transactionTypeId === TRANSACTION_TYPE.NotSet;
    if (isCustoms) {
      // Second UNION branch: customs declarations with a protocol contribute column 9 only.
      if (!hasProtocolSibling(a, ix)) continue;
      const cols = Array.from({ length: 7 }, () => ZERO);
      for (const d of a.details) if (d.sign === 1 && d.vatTermId === 3) cols[0] = cols[0]!.plus(convertRounded(d.amount, o.end, a.accountingDate));
      addRow(groups, { ...header(a, code), cols }, o.extended);
      continue;
    }
    if (a.transactionTypeId !== TRANSACTION_TYPE.Purchase) continue;
    const legs = a.details.filter((d) => d.sign === 1);
    if (!legs.length) continue;
    const cols = Array.from({ length: 7 }, () => ZERO);
    const noCode = code === '';
    const rspes = a.documentTypeId === VAT_DOC.CallOffReceiveRegister;
    for (const d of legs) {
      const v = convertRounded(d.amount, o.end, a.accountingDate);
      const vat = isVatLegFor('purchase', d);
      const t = d.vatTermId;
      const add = (col: number) => {
        cols[col - 9] = cols[col - 9]!.plus(v);
      };
      if ((t === 3 && (noCode || isCode78(code)) && cashOk) || rspes) add(9);
      if (t === 2 && !vat && (noCode || isCode78(code)) && cashOk) add(10);
      if (t === 2 && vat && noCode && cashOk) add(11);
      if (t === 4 && !vat && noCode && cashOk) add(12);
      if (t === 4 && vat && noCode) add(13);
      if (t === 5 && noCode) add(14);
      if (t === 6 && noCode && cashOk) add(15);
    }
    addRow(groups, { ...header(a, code), cols }, o.extended);
  }
  return sortRows([...groups.values()], o.sortByEntry);
}

/** Column sums of a diary (index i = column 9 + i). */
export function diaryTotals(rows: DiaryRow[], width: number): Dec[] {
  const t = Array.from({ length: width }, () => ZERO);
  for (const r of rows) r.cols.forEach((c, i) => (t[i] = t[i]!.plus(c)));
  return t;
}
