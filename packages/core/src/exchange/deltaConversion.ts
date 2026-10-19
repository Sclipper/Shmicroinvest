import { ACCOUNT_CATEGORIES, type AccountCategoryDef } from '../categories.ts';
import { dec, round2, sum, ZERO, type Dec } from '../money.ts';
import { VIESES } from '../seeds/lookups.ts';
import { DataImportError, critical, fromOADate, isoDate, msg, parseImportDate } from './messages.ts';

/**
 * Legacy Microinvest Delta (.mdb) conversion (spec 04a 7). The Jet file is
 * read by the server into plain table rows (`DeltaSource`); everything here
 * maps those rows onto the new model and is independent of the file format.
 *
 * Tables and columns read (7.1): System (company), Accts + Priznaci (chart),
 * Part (partners) and the yearly turnover tables Year<YYYY> (operations and
 * opening balances). Column names are matched case-insensitively, as Jet does.
 */

/** A cell as the Jet reader returns it. */
export type DeltaValue = string | number | boolean | bigint | Date | null | undefined;
export type DeltaRow = Record<string, DeltaValue>;

export interface DeltaYearTable { table: string; year: number; rows: DeltaRow[] }

export interface DeltaSource {
  system: DeltaRow | null;
  accts: DeltaRow[];
  priznaci: DeltaRow[];
  part: DeltaRow[];
  years: DeltaYearTable[];
}

/** Import type list of the wizard. */
export const DELTA_IMPORT_TYPES = [
  { id: 'partners', key: 'strPartners' },
  { id: 'chartAndPartners', key: 'strChartAndPartners' },
  { id: 'all', key: 'strOperationsChartPartners' },
] as const;
export type DeltaImportType = (typeof DELTA_IMPORT_TYPES)[number]['id'];
export const deltaImportsChart = (t: DeltaImportType) => t !== 'partners';
export const deltaImportsOperations = (t: DeltaImportType) => t === 'all';

/** Only operations after 31.12.2007 are converted. */
export const DELTA_FIRST_YEAR = 2008;
export const DELTA_DEFAULT_FILE = 'C:\\MICRO\\MAINACCT.MDB';
/** Legacy "no Bulstat" placeholder, ignored when matching partners. */
export const DELTA_PLACEHOLDER_BULSTAT = '999999999';
/** "Служебен партньор" (strDefaultPartner), used for partner-account rows without a partner. */
export const DELTA_DEFAULT_PARTNER = { bulstat: '123456786', vatNumber: 'BG123456786' } as const;
/** Fallback document type when DocType matches no short name. */
export const DELTA_FALLBACK_DOCUMENT_TYPE = 'Протокол или друг документ';

// ---------------------------------------------------------------------------
// Cells

export function deltaField(row: DeltaRow, name: string): DeltaValue {
  if (name in row) return row[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(row)) if (k.toLowerCase() === lower) return row[k];
  return undefined;
}

/** Trimmed text, cut to `max` characters. */
export function deltaText(v: DeltaValue, max?: number): string {
  let t: string;
  if (v === null || v === undefined) t = '';
  else if (v instanceof Date) t = deltaDate(v) ?? '';
  else if (typeof v === 'boolean') t = v ? '1' : '0';
  else t = String(v);
  t = t.trim();
  return max ? t.slice(0, max) : t;
}

/** Whole number; Access booleans are -1/0 (true -> 1 here), empty -> 0. */
export function deltaInt(v: DeltaValue): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return 0;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function deltaBool(v: DeltaValue): boolean {
  if (typeof v === 'boolean') return v;
  return deltaInt(v) !== 0;
}

/** Amount (Currency, Double or text with "." or "," decimals); empty -> 0. */
export function deltaAmount(v: DeltaValue): Dec {
  if (v === null || v === undefined || v === '' || v instanceof Date || typeof v === 'boolean') return ZERO;
  const t = String(v).trim().replace(/\s/g, '').replace(',', '.');
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i.test(t)) return ZERO;
  return dec(t.replace(/^\+/, ''));
}

/** Date cell -> yyyy-mm-dd; the Jet zero date (30.12.1899) and empty cells are missing. */
export function deltaDate(v: DeltaValue): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return isoDate(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  }
  if (typeof v === 'number') return fromOADate(v);
  if (typeof v === 'string') return parseImportDate(v);
  return null;
}

/**
 * Jet 3 (Access 97) files carry text in the Windows code page; the reader
 * decodes it as windows-1252, which turns Cyrillic (windows-1251) into Latin
 * letters. This maps such a string back to its bytes and decodes them as 1251.
 */
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
const CP1252_BYTE = new Map<string, number>([...CP1252_HIGH].map((c, i) => [c, 0x80 + i]));
let cp1251: TextDecoder | null = null;
export function deltaRepairCp1251(s: string): string {
  if (!/[\u0080-\uffff]/.test(s)) return s;
  const bytes = new Uint8Array(s.length);
  let i = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    bytes[i++] = CP1252_BYTE.get(ch) ?? (code >= 0xa0 && code <= 0xff ? code : code < 0x80 ? code : 0x3f);
  }
  cp1251 ??= new TextDecoder('windows-1251');
  return cp1251.decode(bytes.subarray(0, i));
}

// ---------------------------------------------------------------------------
// Company (System)

export interface DeltaCompany {
  name: string; bulstat: string; contactName: string; vatId: string;
  city: string; phone: string; address: string; bankName: string; bankAccount: string;
}

/** System.Company / Bulstat / Partner (contact person) / VatID / City / Phone / Address / Bank / BankAcct, each cut to 255. */
export function mapDeltaCompany(row: DeltaRow | null): DeltaCompany | null {
  if (!row) return null;
  const t = (n: string) => deltaText(deltaField(row, n), 255);
  return {
    name: t('Company'), bulstat: t('Bulstat'), contactName: t('Partner'), vatId: t('VatID'),
    city: t('City'), phone: t('Phone'), address: t('Address'), bankName: t('Bank'), bankAccount: t('BankAcct'),
  };
}

// ---------------------------------------------------------------------------
// Chart (Accts, Priznaci)

/** PriznakID values of Priznaci with Type = 0 (the account features; the others are quantity features). */
export function deltaAccountFeatures(priznaci: DeltaRow[]): Set<number> {
  return new Set(priznaci.filter((p) => deltaInt(deltaField(p, 'Type')) === 0).map((p) => deltaInt(deltaField(p, 'PriznakID'))));
}

const nonZero = (t: string) => t !== '' && !(/^[-+]?\d+(\.\d+)?$/.test(t) && Number(t) === 0);

/** Account.Number = Acct [+ sep + SubAcct when non-zero] [+ sep + PriznakID when non-zero]. */
export function deltaAccountNumber(acct: DeltaValue, subAcct: DeltaValue, priznakId: DeltaValue, sep = '/'): string {
  const parts = [deltaText(acct)];
  const sub = deltaText(subAcct);
  const pr = deltaText(priznakId);
  if (nonZero(sub)) parts.push(sub);
  if (nonZero(pr)) parts.push(pr);
  return parts.join(sep);
}

/** First category whose non-empty code is a prefix of the account number. */
export function deltaAccountCategory(number: string, categories: readonly Pick<AccountCategoryDef, 'id' | 'code'>[] = ACCOUNT_CATEGORIES): number | null {
  return categories.find((c) => c.code && number.startsWith(c.code))?.id ?? null;
}

export interface DeltaAccount {
  sourceId: number;
  number: string;
  /** Account of the previous level; null for a synthetic account (child of the chart root). */
  parentNumber: string | null;
  description: string;
  isForeignCurrency: boolean;
  categoryId: number | null;
}

const cmpCell = (a: DeltaValue, b: DeltaValue) => {
  const x = deltaText(a);
  const y = deltaText(b);
  const nx = Number(x);
  const ny = Number(y);
  if (x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny)) return nx - ny;
  return x.localeCompare(y);
};

/**
 * Chart query of 7 (Accts joined with the Type = 0 features, ordered by Acct,
 * SubAcct, PriznakID). Duplicate numbers keep the first row. Parents come
 * before their children.
 */
export function mapDeltaChart(accts: DeltaRow[], priznaci: DeltaRow[], sep = '/', categories?: readonly Pick<AccountCategoryDef, 'id' | 'code'>[]): DeltaAccount[] {
  const features = deltaAccountFeatures(priznaci);
  const rows = accts.filter((a) => features.has(deltaInt(deltaField(a, 'PriznakID'))) && deltaText(deltaField(a, 'Acct')) !== '');
  rows.sort((a, b) => cmpCell(deltaField(a, 'Acct'), deltaField(b, 'Acct')) || cmpCell(deltaField(a, 'SubAcct'), deltaField(b, 'SubAcct')) || cmpCell(deltaField(a, 'PriznakID'), deltaField(b, 'PriznakID')));
  const out: DeltaAccount[] = [];
  const seen = new Set<string>();
  for (const a of rows) {
    const number = deltaAccountNumber(deltaField(a, 'Acct'), deltaField(a, 'SubAcct'), deltaField(a, 'PriznakID'), sep);
    if (seen.has(number)) continue;
    seen.add(number);
    const cut = number.lastIndexOf(sep);
    out.push({
      sourceId: deltaInt(deltaField(a, 'AcctID')),
      number,
      parentNumber: cut > 0 ? number.slice(0, cut) : null,
      description: deltaText(deltaField(a, 'Name'), 50),
      isForeignCurrency: deltaBool(deltaField(a, 'IsValutna')),
      categoryId: deltaAccountCategory(number, categories),
    });
  }
  return out.sort((x, y) => x.number.split(sep).length - y.number.split(sep).length);
}

// ---------------------------------------------------------------------------
// Partners (Part)

export interface DeltaPartner {
  sourceId: number;
  name: string;
  contactName: string;
  /** Null when empty or the legacy placeholder 999999999. */
  bulstat: string | null;
  vatNumber: string | null;
  city: string;
  address: string;
  phone: string;
  bank: { name: string; account: string; code: string } | null;
  /** Company.Priority from IsVeryUsed (usage frequency, byte). */
  priority: number;
}

export function mapDeltaPartner(row: DeltaRow): DeltaPartner {
  const t = (n: string, max: number) => deltaText(deltaField(row, n), max);
  const bulstat = t('Bulstat', 12);
  const vat = t('DanNo', 20);
  const bankAccount = t('BanAcct', 30);
  return {
    sourceId: deltaInt(deltaField(row, 'ID')),
    name: t('Company', 200),
    contactName: t('Partner', 100),
    bulstat: bulstat && bulstat !== DELTA_PLACEHOLDER_BULSTAT ? bulstat : null,
    vatNumber: vat || null,
    city: t('Town', 50),
    address: t('Addr', 255),
    phone: t('Tel_Fax', 100),
    bank: bankAccount ? { name: t('Bank', 100), account: bankAccount, code: t('BanCode', 50) } : null,
    priority: Math.min(255, Math.max(0, deltaInt(deltaField(row, 'IsVeryUsed')))),
  };
}

// ---------------------------------------------------------------------------
// Operations (Year<YYYY>)

/** Year tables converted: name "Year" + year, year >= 2008, in year order. */
export function deltaYearTables(names: string[]): { table: string; year: number }[] {
  return names
    .filter((n) => /^year\d{4}$/i.test(n.trim()))
    .map((n) => ({ table: n, year: Number(n.trim().slice(4)) }))
    .filter((t) => t.year >= DELTA_FIRST_YEAR)
    .sort((a, b) => a.year - b.year);
}

/**
 * Decoded VAT-term array (7.2): index = legacy OperType, value = VATTermType.
 * 0-10 -> 1 (Вътрешен оборот), 11 -> 3, 12 -> 2, 13..27 -> 4..18.
 */
export const DELTA_VAT_TERMS: readonly number[] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

/** VAT term of a legacy OperType; null outside the array (Delta raises an index error). */
export function deltaVatTerm(operType: number): number | null {
  return Number.isInteger(operType) && operType >= 0 && operType < DELTA_VAT_TERMS.length ? DELTA_VAT_TERMS[operType]! : null;
}

/** TransactionTypeCode = IsPokupka + 1 (1 not set, 2 purchase, 3 sale); IsPokupka above 2 counts as 0. */
export function deltaTransactionType(isPokupka: number): number {
  return (isPokupka >= 0 && isPokupka <= 2 ? isPokupka : 0) + 1;
}

/** Vies.TypeIdentifier = VIESCol + 1 (unknown values -> 1, not in the declaration). */
export function deltaViesId(viesCol: number): number {
  const id = viesCol + 1;
  return VIESES.some((v) => v.id === id) ? id : 1;
}

export interface DeltaLine { accountNumber: string; amount: string; vatTermId: number; partnerId: number | null }

export interface DeltaAccounting {
  table: string;
  konId: number;
  date: string;
  documentDate: string;
  documentNumber: string;
  /** DocType short name (matched against DocumentType.ShortName). */
  documentType: string;
  term: string;
  reference: string;
  transactionTypeId: number;
  viesId: number;
  viesMonth: string;
  partnerId: number | null;
  debits: DeltaLine[];
  credits: DeltaLine[];
}

export interface DeltaOpening {
  table: string;
  accountNumber: string;
  partnerId: number | null;
  documentType: string;
  documentNumber: string;
  documentDate: string | null;
  debit: string;
  credit: string;
}

export interface DeltaYearOptions {
  sep?: string;
  /** Accts.AcctID -> account number (rows that carry AcctID). */
  accountsById?: Map<number, string>;
  /** The account exists in the converted chart. */
  isValidAccount?: (number: string) => boolean;
}

/** Account of a turnover row: by AcctID when the table has it, else composed from Acct / SubAcct / PriznakID. */
export function deltaRowAccount(row: DeltaRow, opts: DeltaYearOptions): { number: string | null; text: string } {
  const id = deltaField(row, 'AcctID');
  if (id !== undefined && opts.accountsById) {
    const n = opts.accountsById.get(deltaInt(id)) ?? null;
    return { number: n, text: n ?? String(deltaInt(id)) };
  }
  const n = deltaAccountNumber(deltaField(row, 'Acct'), deltaField(row, 'SubAcct'), deltaField(row, 'PriznakID'), opts.sep ?? '/');
  return { number: deltaText(deltaField(row, 'Acct')) ? n : null, text: n };
}

/**
 * Turnover table -> accountings and opening balances (7.1). Rows of
 * non-account features are dropped; rows with KonID = 0 form no accounting;
 * the others are grouped by KonID in Kon order. IsKredit = 2 rows are debit
 * lines (amount Qtty), IsKredit = 1 rows credit lines (amount -Qtty); both
 * sides must balance. StartDebit / StartKredit give the opening balances
 * (debit when |StartDebit| > |StartKredit|), netted per account, partner and
 * document.
 */
export function mapDeltaYear(t: DeltaYearTable, features: Set<number>, opts: DeltaYearOptions = {}): { accountings: DeltaAccounting[]; openings: DeltaOpening[]; skipped: number } {
  const rows = t.rows.filter((r) => features.has(deltaInt(deltaField(r, 'PriznakID'))));
  const jan1 = `${t.year}-01-01`;
  const account = (r: DeltaRow, konId: number) => {
    const a = deltaRowAccount(r, opts);
    if (!a.number || (opts.isValidAccount && !opts.isValidAccount(a.number))) {
      throw new DataImportError(critical('DeltaConversionInvalidAccountError', a.text, t.table, konId));
    }
    return a.number;
  };

  // Opening balances.
  const openings = new Map<string, DeltaOpening & { net: Dec }>();
  for (const r of rows) {
    const d = deltaAmount(deltaField(r, 'StartDebit')).abs();
    const k = deltaAmount(deltaField(r, 'StartKredit')).abs();
    const net = round2(d.minus(k));
    if (net.isZero()) continue;
    const konId = deltaInt(deltaField(r, 'KonID'));
    const accountNumber = account(r, konId);
    const partnerId = deltaInt(deltaField(r, 'PartnerID')) || null;
    const documentNumber = deltaText(deltaField(r, 'FakNo'), 50);
    const documentType = documentNumber ? deltaText(deltaField(r, 'DocType')) : '';
    const documentDate = documentNumber ? deltaDate(deltaField(r, 'DocDate')) : null;
    const key = `${accountNumber}|${partnerId ?? ''}|${documentType}|${documentNumber}|${documentDate ?? ''}`;
    const o = openings.get(key) ?? { table: t.table, accountNumber, partnerId, documentType, documentNumber, documentDate, debit: '0.00', credit: '0.00', net: ZERO };
    o.net = o.net.plus(net);
    openings.set(key, o);
  }

  // Accountings.
  const groups = new Map<number, DeltaRow[]>();
  for (const r of rows) {
    const konId = deltaInt(deltaField(r, 'KonID'));
    if (konId === 0) continue;
    const g = groups.get(konId);
    if (g) g.push(r);
    else groups.set(konId, [r]);
  }
  const accountings: DeltaAccounting[] = [];
  let skipped = 0;
  for (const konId of [...groups.keys()].sort((a, b) => a - b)) {
    const g = groups.get(konId)!.sort((a, b) => cmpCell(deltaField(a, 'Kon'), deltaField(b, 'Kon')));
    const head = g[0]!;
    const partnerId = g.map((r) => deltaInt(deltaField(r, 'PartnerID'))).find((p) => p !== 0) ?? null;
    const debits: DeltaLine[] = [];
    const credits: DeltaLine[] = [];
    for (const r of g) {
      const side = deltaInt(deltaField(r, 'IsKredit'));
      if (side !== 1 && side !== 2) continue;
      const qtty = round2(deltaAmount(deltaField(r, 'Qtty')));
      const amount = side === 2 ? qtty : qtty.negated();
      if (amount.isZero()) continue;
      const operType = deltaInt(deltaField(r, 'OperType'));
      const vatTermId = deltaVatTerm(operType);
      if (vatTermId === null) throw new DataImportError(critical('strDeltaConversionInvalidOperType', operType, t.table, konId));
      const line: DeltaLine = { accountNumber: account(r, konId), amount: amount.toFixed(2), vatTermId, partnerId: deltaInt(deltaField(r, 'PartnerID')) || partnerId };
      (side === 2 ? debits : credits).push(line);
    }
    if (!debits.length && !credits.length) {
      skipped++;
      continue;
    }
    const totalD = round2(sum(debits.map((l) => l.amount)));
    const totalC = round2(sum(credits.map((l) => l.amount)));
    if (!totalD.equals(totalC)) throw new DataImportError(critical('strDeltaConversionUnbalanced', t.table, konId, totalD.toFixed(2), totalC.toFixed(2)));
    const vies = deltaDate(deltaField(head, 'VIESDate'));
    accountings.push({
      table: t.table,
      konId,
      date: deltaDate(deltaField(head, 'Date')) ?? jan1,
      documentDate: deltaDate(deltaField(head, 'DocDate')) ?? jan1,
      documentNumber: deltaText(deltaField(head, 'FakNo'), 50),
      documentType: deltaText(deltaField(head, 'DocType')),
      term: deltaText(deltaField(head, 'Osnovanie'), 255),
      reference: deltaText(deltaField(head, 'Note'), 255),
      transactionTypeId: deltaTransactionType(deltaInt(deltaField(head, 'IsPokupka'))),
      viesId: deltaViesId(deltaInt(deltaField(head, 'VIESCol'))),
      viesMonth: vies ? `${vies.slice(0, 7)}-01` : `${t.year}-12-01`,
      partnerId,
      debits,
      credits,
    });
  }
  const opening = [...openings.values()].filter((o) => !o.net.isZero()).map(({ net, ...o }) => ({
    ...o, debit: net.isPositive() ? net.toFixed(2) : '0.00', credit: net.isNegative() ? net.negated().toFixed(2) : '0.00',
  }));
  return { accountings, openings: opening, skipped };
}

/** Wizard label of an import type. */
export const deltaImportTypeLabel = (t: DeltaImportType) => msg(DELTA_IMPORT_TYPES.find((x) => x.id === t)!.key);
