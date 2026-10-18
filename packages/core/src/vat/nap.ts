import { dec, round2, sum, ZERO, type Dec, type DecInput } from '../money.ts';
import { TRANSACTION_TYPE } from '../seeds/lookups.ts';
import { KO_PURCHASE_DOC_TYPES, KO_SALE_DOC_TYPES, SALES_SPECIAL_TERMS, SELF_ASSESSED_TERMS, VAT_DOC } from './constants.ts';
import { encodeCp1251 } from './cp1251.ts';
import {
  convertRounded, indexAccountings, partnerOf, partnerVatId, protocolOf, siblingsOf,
  type VatAccounting, type VatIndex,
} from './model.ts';

/**
 * NAP VAT files (spec 04a section 1): diary lines built per accounting like
 * `PurchaseDiaryLine.FromAccounting` / `SaleDiaryLine.FromAccounting`, the
 * fixed-width records of POKUPKI.TXT / PRODAGBI.TXT, DEKLAR.TXT and the
 * cp1251 / CRLF file encoding.
 */

// ---------------------------------------------------------------------------
// Formatting (StringExtension, decimal.ToString("F2"))

/** Pad left with spaces; a longer value keeps its first n characters (CutOrPadLeft). */
export function cutOrPadLeft(s: string | null | undefined, n: number): string {
  const v = s ?? '';
  return v.length > n ? v.slice(0, n) : v.padStart(n, ' ');
}

/** Pad right with spaces; a longer value keeps its first n characters (CutOrPadRight). */
export function cutOrPadRight(s: string | null | undefined, n: number): string {
  const v = s ?? '';
  return v.length > n ? v.slice(0, n) : v.padEnd(n, ' ');
}

/** decimal.ToString("F2"): two decimals, midpoint away from zero, "." separator, no grouping. */
export function f2(v: DecInput): string {
  const s = round2(v).toFixed(2);
  return s === '-0.00' ? '0.00' : s;
}

/** dd/MM/yyyy */
export function napDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** yyyyMM of a date. */
export const napPeriod = (iso: string) => iso.slice(0, 4) + iso.slice(5, 7);

/** Lines joined with CRLF after every line (StreamWriter.WriteLine), encoded in cp1251. */
export function napFileBytes(lines: string[]): Uint8Array {
  return encodeCp1251(lines.map((l) => l + '\r\n').join(''));
}

// ---------------------------------------------------------------------------
// Diary lines

export interface NapLineHeader {
  ownVatId: string;
  /** Report end date (yyyy-mm-dd). */
  periodEnd: string;
  branchCode: string;
  documentCode: string;
  documentNumber: string;
  documentDate: string;
  partnerVat: string;
  partnerName: string;
  description: string;
  protocolCode: string;
}

export interface NapLine extends NapLineHeader {
  rowNumber: number;
  /** Amount columns (purchases 7: diary columns 9..15; sales 17: 9..25). */
  cols: Dec[];
  /** Cash-accounting counters per column (rowTotals_KasovaOtchetnost). */
  ko: Dec[];
  /** Purchases only: call-off arrival / loss / termination amounts (RSPESCol9). */
  rspesCol9: Dec;
  /** Source accounting ids. */
  accountingIds: number[];
}

export interface NapOptions {
  /** Period start, yyyy-mm-dd (00:00:00). */
  start: string;
  /** Period end, yyyy-mm-dd (23:59:59). */
  end: string;
  ownVatId: string;
}

const zeros = (n: number) => Array.from({ length: n }, () => ZERO);
const inPeriod = (date: string, o: NapOptions) => date.slice(0, 10) >= o.start && date.slice(0, 10) <= o.end;

/** Protocol code after the override rules of 04a 1.7.1. */
export function napProtocolCode(a: VatAccounting, ix: VatIndex): string {
  let code = protocolOf(a, ix)?.extendedCodes[0] ?? '';
  if (a.transactionTypeId === TRANSACTION_TYPE.NotSet && a.documentTypeId === VAT_DOC.CustomsDeclaration) code = '';
  if (a.transactionTypeId === TRANSACTION_TYPE.Purchase && a.documentTypeId === VAT_DOC.VatProtocol && a.extendedCodes[0] === '03') code = '03';
  if (a.extendedCodes.length && (a.extendedCodes[0] === '08' || a.extendedCodes[0] === '07')) code = a.extendedCodes[0];
  return code;
}

function lineHeader(a: VatAccounting, ix: VatIndex, o: NapOptions, descriptionFromProtocol: boolean): NapLineHeader {
  const p = partnerOf(a);
  const description = descriptionFromProtocol ? (protocolOf(a, ix)?.term ?? '') : a.term;
  return {
    ownVatId: o.ownVatId,
    periodEnd: o.end,
    branchCode: a.branchCode,
    documentCode: a.documentCode,
    documentNumber: a.documentNumber,
    documentDate: a.documentDate,
    partnerVat: partnerVatId(p),
    partnerName: p?.name ?? '',
    description: description ?? '',
    protocolCode: napProtocolCode(a, ix),
  };
}

/** GetPurchaseAccountingsByDate. */
export function selectPurchaseAccountings(list: VatAccounting[], o: NapOptions, ix: VatIndex): VatAccounting[] {
  return list.filter((a) => {
    if (a.isInitialBalance || a.isInitialCorrespondence) return false;
    if (!inPeriod(a.viesMonth, o)) return false;
    const customs = a.transactionTypeId === TRANSACTION_TYPE.NotSet && a.documentTypeId === VAT_DOC.CustomsDeclaration;
    const ok = (a.transactionTypeId === TRANSACTION_TYPE.Purchase && a.documentTypeId !== VAT_DOC.CallOffSendRegister) || customs;
    if (!ok || a.details.length === 0) return false;
    if (customs && !protocolOf(a, ix)) return false;
    return true;
  });
}

/** GetSaleDiaryAccountingsByDate. */
export function selectSaleAccountings(list: VatAccounting[], o: NapOptions, ix: VatIndex): VatAccounting[] {
  const picked = new Map<number, VatAccounting>();
  for (const a of list) {
    if (a.isInitialBalance || a.isInitialCorrespondence) continue;
    const isProtocol = a.documentTypeId === VAT_DOC.VatProtocol;
    if (!inPeriod(a.viesMonth, o) && !(isProtocol && inPeriod(a.accountingDate, o))) continue;
    const customs = a.transactionTypeId === TRANSACTION_TYPE.NotSet && a.documentTypeId === VAT_DOC.CustomsDeclaration;
    const ok = a.transactionTypeId === TRANSACTION_TYPE.Sale
      || (customs && !!protocolOf(a, ix))
      || (a.transactionTypeId === TRANSACTION_TYPE.Purchase && a.details.some((d) => SELF_ASSESSED_TERMS.has(d.vatTermId))
        && a.documentTypeId !== VAT_DOC.CallOffSendRegister && a.documentTypeId !== VAT_DOC.CallOffReceiveRegister);
    if (ok) picked.set(a.id, a);
    // ПротоколЗаВОП: the sibling accountings are also considered when the protocol is in the period.
    if (isProtocol) for (const s of siblingsOf(a, ix)) {
      if (s.transactionTypeId === TRANSACTION_TYPE.Sale && !picked.has(s.id) && !s.isInitialBalance) picked.set(s.id, s);
    }
  }
  return [...picked.values()].sort((x, y) => x.id - y.id);
}

/** PurchaseDiaryLine.FromAccounting (04a 1.7.2). */
export function purchaseLineFromAccounting(a: VatAccounting, ix: VatIndex, o: NapOptions): NapLine {
  const h = lineHeader(a, ix, o, a.documentTypeId === VAT_DOC.CallOffReceiveRegister);
  const cols = zeros(7);
  const ko = zeros(7);
  let rspesCol9 = ZERO;
  const isKo = a.documentTypeId != null && KO_PURCHASE_DOC_TYPES.has(a.documentTypeId);
  const code = h.protocolCode;
  const debits = a.details.filter((d) => d.sign === 1);
  if (['', '03', '07', '08'].includes(code)) {
    for (const d of debits) {
      const v = convertRounded(d.amount, o.end, a.accountingDate);
      let idx = -1;
      if (d.vatTermId === 3) idx = 0;
      else if (d.vatTermId === 2) idx = d.isVatPurchase ? 2 : 1;
      else if (d.vatTermId === 4) idx = d.isVatPurchase ? 4 : 3;
      else if (d.vatTermId === 5) idx = 5;
      else if (d.vatTermId === 6) idx = 6;
      if (idx < 0) continue;
      cols[idx] = cols[idx]!.plus(v);
      if (isKo && idx !== 5) ko[idx] = ko[idx]!.plus(v);
    }
  } else if (['51', '53', '54', '58'].includes(code)) {
    for (const d of debits) {
      const v = convertRounded(d.amount, o.end, a.accountingDate);
      cols[0] = cols[0]!.plus(v);
      rspesCol9 = rspesCol9.plus(v);
    }
  }
  return { ...h, rowNumber: 0, cols, ko, rspesCol9, accountingIds: [a.id] };
}

/** SaleDiaryLine.FromAccounting (04a 1.7.3). */
export function saleLineFromAccounting(a: VatAccounting, ix: VatIndex, o: NapOptions): NapLine {
  const h = lineHeader(a, ix, o, a.documentTypeId === VAT_DOC.CallOffSendRegister);
  const cols = zeros(17);
  const ko = zeros(17);
  const isKo = a.documentTypeId != null && KO_SALE_DOC_TYPES.has(a.documentTypeId);
  const customsWithIca = a.transactionTypeId === TRANSACTION_TYPE.NotSet && a.documentTypeId === VAT_DOC.CustomsDeclaration && !!protocolOf(a, ix);
  const rsies = a.documentTypeId === VAT_DOC.CallOffSendRegister;
  for (const d of a.details) {
    if (d.sign !== -1) continue;
    const v = convertRounded(d.refAmount, o.end, a.accountingDate);
    const vat = d.isVatSale;
    const t = d.vatTermId;
    const add = (i: number, countKo = false) => {
      cols[i] = cols[i]!.plus(v);
      if (countKo && isKo) ko[i] = ko[i]!.plus(v);
    };
    if (!vat && !SALES_SPECIAL_TERMS.has(t) && !customsWithIca) add(0);
    if (vat && !SALES_SPECIAL_TERMS.has(t)) add(1);
    if (rsies) continue;
    if (!vat) {
      if (t === 7) add(2, true);
      else if (t === 8) add(4);
      else if (t === 9) add(5);
      else if (t === 11) add(8, true);
      else if (t === 12) add(10);
      else if (t === 13) add(11);
      else if (t === 14) add(12);
      else if (t === 15) add(13);
      else if (t === 16) add(14);
      else if (t === 17) add(15);
      else if (t === 18) add(16);
    } else {
      if (t === 7) add(3, true);
      else if (t === 8 || t === 9) add(6);
      else if (t === 10) add(7);
      else if (t === 11) add(9, true);
    }
  }
  return { ...h, rowNumber: 0, cols, ko, rspesCol9: ZERO, accountingIds: [a.id] };
}

/** Group (04a 1.8), sort by document date then number (string order, stable), number rows 1..n. */
export function groupNapLines(lines: NapLine[]): NapLine[] {
  const groups = new Map<string, NapLine>();
  for (const l of lines) {
    const k = [l.ownVatId, l.periodEnd, l.partnerName, l.partnerVat, l.documentDate, l.documentNumber, l.documentCode, l.description, l.branchCode, l.protocolCode].join('\u0001');
    const g = groups.get(k);
    if (!g) {
      groups.set(k, { ...l, cols: [...l.cols], ko: [...l.ko], accountingIds: [...l.accountingIds] });
      continue;
    }
    g.cols = g.cols.map((c, i) => c.plus(l.cols[i]!));
    g.ko = g.ko.map((c, i) => c.plus(l.ko[i]!));
    g.rspesCol9 = g.rspesCol9.plus(l.rspesCol9);
    g.accountingIds.push(...l.accountingIds);
  }
  const out = [...groups.values()].sort((a, b) =>
    (a.documentDate < b.documentDate ? -1 : a.documentDate > b.documentDate ? 1 : 0)
    || (a.documentNumber < b.documentNumber ? -1 : a.documentNumber > b.documentNumber ? 1 : 0));
  out.forEach((l, i) => (l.rowNumber = i + 1));
  return out;
}

export function napPurchaseLines(list: VatAccounting[], o: NapOptions, ix: VatIndex = indexAccountings(list)): NapLine[] {
  return groupNapLines(selectPurchaseAccountings(list, o, ix).map((a) => purchaseLineFromAccounting(a, ix, o)));
}

export function napSaleLines(list: VatAccounting[], o: NapOptions, ix: VatIndex = indexAccountings(list)): NapLine[] {
  return groupNapLines(selectSaleAccountings(list, o, ix).map((a) => saleLineFromAccounting(a, ix, o)));
}

/** One POKUPKI (274) or PRODAGBI (424) record (PurchaseDiaryLine/SaleDiaryLine.ToString). */
export function napLineToString(l: NapLine): string {
  return cutOrPadRight(l.ownVatId, 15)
    + napPeriod(l.periodEnd)
    + cutOrPadRight(l.branchCode, 4)
    + cutOrPadLeft(String(l.rowNumber), 15)
    + l.documentCode
    + cutOrPadRight(l.documentNumber, 20)
    + napDate(l.documentDate)
    + cutOrPadRight(l.partnerVat, 15)
    + cutOrPadRight(l.partnerName, 50)
    + cutOrPadRight(l.description, 30)
    + l.cols.map((c) => cutOrPadLeft(f2(c), 15)).join('')
    + cutOrPadRight(l.protocolCode, 2);
}

export interface ParsedNapLine {
  ownVatId: string;
  period: string;
  branchCode: string;
  rowNumber: number;
  documentCode: string;
  documentNumber: string;
  /** yyyy-mm-dd */
  documentDate: string;
  partnerVat: string;
  partnerName: string;
  description: string;
  cols: Dec[];
  protocolCode: string;
}

/** FromString: parse a POKUPKI (7 amounts) or PRODAGBI (17 amounts) record; null when malformed. */
export function parseNapLine(line: string, amounts: 7 | 17): ParsedNapLine | null {
  const width = 167 + amounts * 15 + 2;
  const l = line.replace(/\r?\n$/, '');
  if (l.length < width - 2 || l.length > width) return null;
  const s = l.padEnd(width, ' ');
  const date = s.slice(62, 72);
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  const period = s.slice(15, 21);
  const rowNumber = Number(s.slice(25, 40).trim());
  if (!m || !/^\d{6}$/.test(period) || !Number.isInteger(rowNumber)) return null;
  const cols: Dec[] = [];
  for (let i = 0; i < amounts; i++) {
    const t = s.slice(167 + i * 15, 182 + i * 15).trim();
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    cols.push(dec(t));
  }
  return {
    ownVatId: s.slice(0, 15).trim(),
    period,
    branchCode: s.slice(21, 25).trim(),
    rowNumber,
    documentCode: s.slice(40, 42),
    documentNumber: s.slice(42, 62).trim(),
    documentDate: `${m[3]}-${m[2]}-${m[1]}`,
    partnerVat: s.slice(72, 87).trim(),
    partnerName: s.slice(87, 137).trim(),
    description: s.slice(137, 167).trim(),
    cols,
    protocolCode: s.slice(width - 2, width).trim(),
  };
}

// ---------------------------------------------------------------------------
// DEKLAR.TXT (04a 1.9)

export interface DeklarInput {
  ownVatId: string;
  companyName: string;
  periodEnd: string;
  subscriberEgn: string;
  subscriberName: string;
  saleLines: NapLine[];
  purchaseLines: NapLine[];
  kl33: DecInput;
  kl70?: DecInput;
  kl71?: DecInput;
  kl80?: DecInput;
  kl81?: DecInput;
  kl82?: DecInput;
  autoFillCell71?: boolean;
}

export interface DeklarCells {
  S: Dec[];
  P: Dec[];
  cells: Record<string, Dec>;
}

/** Declaration figures as computed by NAPExportFiles (sales/purchases minus КО, purchases col 9 minus RSPES). */
export function deklarCells(i: DeklarInput): DeklarCells {
  const S = zeros(17);
  const P = zeros(7);
  for (const l of i.saleLines) l.cols.forEach((c, k) => (S[k] = S[k]!.plus(c).minus(l.ko[k]!)));
  for (const l of i.purchaseLines) l.cols.forEach((c, k) => (P[k] = P[k]!.plus(c).minus(l.ko[k]!)));
  P[0] = P[0]!.minus(sum(i.purchaseLines.map((l) => l.rspesCol9)));
  const coef = dec(i.kl33);
  const charged = S[3]!.plus(S[6]!).plus(S[7]!).plus(S[9]!);
  const credit = P[2]!.plus(P[4]!.times(coef)).plus(P[5]!);
  const creditRounded = P[2]!.plus(round2(P[4]!.times(coef))).plus(P[5]!);
  const due = charged.greaterThanOrEqualTo(creditRounded) ? charged.minus(creditRounded) : ZERO;
  const refund = charged.lessThan(credit) ? credit.minus(charged) : ZERO;
  const kl70 = dec(i.kl70 ?? 0);
  const cells: Record<string, Dec> = {
    '01': S[2]!.plus(S[4]!).plus(S[5]!).plus(S[8]!).plus(S[10]!).plus(S[11]!).plus(S[12]!),
    '20': charged,
    '11': S[2]!, '21': S[3]!, '12': S[4]!.plus(S[5]!), '22': S[6]!, '23': S[7]!, '13': S[8]!, '24': S[9]!,
    '14': S[10]!, '15': S[11]!, '16': S[12]!, '17': S[13]!, '18': S[14]!.plus(S[16]!), '19': S[15]!,
    '30': P[0]!.plus(P[6]!), '31': P[1]!, '41': P[2]!, '32': P[3]!, '42': P[4]!, '43': P[5]!,
    '33': coef, '40': credit, '50': due, '60': refund, '70': kl70,
    '71': i.autoFillCell71 ? due.minus(kl70) : dec(i.kl71 ?? 0),
    '80': dec(i.kl80 ?? 0), '81': dec(i.kl81 ?? 0), '82': dec(i.kl82 ?? 0),
  };
  return { S, P, cells };
}

/** The single 590-character DEKLAR record. */
export function deklarLine(i: DeklarInput): string {
  const { cells } = deklarCells(i);
  const n = (k: string) => cutOrPadLeft(f2(cells[k]!), 15);
  return cutOrPadRight(i.ownVatId, 15)
    + cutOrPadRight(i.companyName, 50)
    + napPeriod(i.periodEnd)
    + cutOrPadRight(`${i.subscriberEgn}/${i.subscriberName}`, 50)
    + cutOrPadLeft(String(i.saleLines.length), 15)
    + cutOrPadLeft(String(i.purchaseLines.length), 15)
    + ['01', '20', '11', '21', '12', '22', '23', '13', '24', '14', '15', '16', '17', '18', '19', '30', '31', '41', '32', '42', '43'].map(n).join('')
    + cutOrPadLeft(f2(cells['33']!), 4)
    + ['40', '50', '60', '70', '71', '80', '81', '82'].map(n).join('');
}
