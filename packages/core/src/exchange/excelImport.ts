import { dec, round2, sum, type Dec } from '../money.ts';
import { VAT_TERMS, TRANSACTION_TYPE } from '../seeds/lookups.ts';
import { isCompanyCategory } from '../categories.ts';
import { vatFromGross } from './textImport.ts';
import { DataImportError, EXCHANGE_MESSAGES, critical, fromOADate, parseImportDate, type ExchangeMessage, type ExchangeMessageKey } from './messages.ts';

/**
 * Excel import wizard (spec 04a 5). The workbook is read by the server into
 * `ExcelSheet`s; everything here is pure.
 */

export type ExcelCell = string | number | boolean | Date | null | undefined;
export interface ExcelSheet {
  name: string;
  /** 1-based Excel row and column. */
  cell: (row: number, col: number) => ExcelCell;
  rowCount: number;
}

export type ExcelEntity = 'operations' | 'partners' | 'chart' | 'products' | 'initialBalances';

export interface ExcelColumnDef { key: string; caption: string; length?: number; ica?: boolean }

const C = (key: string, what: string, length?: number, ica = false): ExcelColumnDef => ({ key, caption: `Колона за ${what}`, length, ica });

export const EXCEL_ENTITIES: Record<ExcelEntity, { title: string; setupSheet: string; columns: ExcelColumnDef[] }> = {
  operations: {
    title: 'Операции', setupSheet: 'Настройка Операции',
    columns: [
      C('Accounts', 'сметки'), C('Sums', 'суми'), C('Date', 'дата'), C('Partner', 'партньор', 254), C('PartnerBulstat', 'ЕИК на партньор', 50),
      C('PartnerVatNumber', 'ДДС номер на партньор', 50), C('PartnerIBAN', 'IBAN на партньор', 50), C('DocumentNumber', 'номер на документ', 50),
      C('DocumentType', 'тип на документ'), C('DocumentDate', 'дата на документ'), C('Term', 'основание', 254), C('Reference', 'забележка', 254),
      C('OptionalReference', 'втора забележка', 254), C('VATOperation', 'вид сделка'), C('VIES', 'VIES'), C('VIESMonth', 'месец за експорт'),
      C('OperationType', 'тип операция', undefined, true), C('OperationGoodType', 'вид на стоката/операцията', undefined, true),
      C('ICADocumentNumber', 'номер на протокол', 50, true), C('ICADate', 'дата на протокол', undefined, true), C('ICAVAT', 'ДДС по протокол', undefined, true),
      C('DeliveryDescription', 'описание на доставката', 254, true), C('ICATerm', 'основание на протокол', 254, true), C('ICAReference', 'забележка на протокол', 254, true),
      C('ICAVATOperation', 'вид сделка на протокол', undefined, true), C('ExportMonth', 'месец за експорт на протокол', undefined, true), C('ExpenseAccount', 'разходна сметка', 50, true),
    ],
  },
  partners: {
    title: 'Партньори', setupSheet: 'Настройка Партньори',
    columns: [C('CompanyName', 'име на партньор', 254), C('ContactName', 'лице за контакт', 254), C('City', 'град', 50), C('Address', 'адрес', 254), C('Phone', 'телефон', 100), C('VATNumber', 'ДДС номер', 50), C('Bulstat', 'ЕИК', 50), C('IBAN', 'IBAN', 50), C('CompanyAccounts', 'сметки на партньора')],
  },
  chart: {
    title: 'Сметкоплан', setupSheet: 'Настройка Сметкоплан',
    columns: [C('Number', 'номер на сметка', 50), C('Description', 'наименование', 254), C('EnglishDescription', 'наименование на английски', 254), C('Currency', 'валута'), C('Category', 'категория'), C('Character', 'характер')],
  },
  products: {
    title: 'СМЗ', setupSheet: 'Настройка СМЗ',
    columns: [C('ProductName', 'наименование', 254), C('ProductCode', 'код', 50), C('Measure', 'мярка', 50), C('IncrementAccount', 'сметка за заприхождаване', 50), C('DecrementAccount', 'сметка за изписване', 50)],
  },
  initialBalances: {
    title: 'Начални салда', setupSheet: 'Настройка Начални Салда',
    columns: [
      C('AccountNumber', 'сметка', 50), C('Balance', 'салдо'), C('CurrencyBalance', 'салдо във валута'), C('ExchangeRate', 'курс'), C('Quantity', 'количество'),
      C('SalePrice', 'цена'), C('Direction', 'посока'), C('CompanyName', 'партньор', 254), C('DocumentNumber', 'номер на документ', 50), C('DocumentType', 'тип на документ'),
      C('DocumentDate', 'дата на документ'), C('FinancialYear', 'счетоводна година'),
    ],
  },
};

export interface ExcelMapping {
  sheetName: string;
  startingRow: number;
  endingRow: number;
  columns: Record<string, string>;
  hasIcaColumns?: boolean;
  /** Persisted but never read (defect D7, compatibility). */
  conflictMode?: 'insert' | 'update' | 'ignore' | 'error';
}

/** Column letters A..ZZ -> 1-based index; null when invalid. */
export function columnIndex(letters: string): number | null {
  const t = letters.trim().toUpperCase();
  if (!/^[A-Z]{1,2}$/.test(t)) return null;
  return t.length === 1 ? t.charCodeAt(0) - 64 : (t.charCodeAt(0) - 64) * 26 + (t.charCodeAt(1) - 64);
}

export function columnLetters(index: number): string {
  let n = index;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** ValidateNextStep of the mapping page (5.2 item 4). */
export function validateExcelMapping(entity: ExcelEntity, m: ExcelMapping, sheetNames: string[]): ExchangeMessage[] {
  const out: ExchangeMessage[] = [];
  if (!m.sheetName.trim() || !sheetNames.includes(m.sheetName)) out.push(critical('strInvalidColumnSetting', 'Sheet с данни', m.sheetName));
  if (!Number.isInteger(m.startingRow) || m.startingRow > 65536 || m.startingRow < 0) out.push(critical('strInvalidColumnSetting', 'Начален ред', m.startingRow));
  if (!Number.isInteger(m.endingRow) || m.endingRow > 65536 || m.endingRow < 0) out.push(critical('strInvalidColumnSetting', 'Краен ред', m.endingRow));
  else if (Number.isInteger(m.startingRow) && m.startingRow <= 65536 && m.startingRow > m.endingRow) out.push(critical('strInvalidColumnSetting', 'Начален ред', m.startingRow));
  for (const c of EXCEL_ENTITIES[entity].columns) {
    if (c.ica && !m.hasIcaColumns) continue;
    const v = (m.columns[c.key] ?? '').trim();
    if (!v) {
      if (!c.ica) out.push(critical('strEmptyColumnSetting', c.caption));
      continue;
    }
    if (columnIndex(v) === null) out.push(critical('strInvalidColumnSetting', c.caption, v));
  }
  return out;
}

/** Setup sheet (rows 1..100: caption in A, value in B) -> mapping fields. */
export function readSetupSheet(entity: ExcelEntity, sheet: ExcelSheet | undefined): Partial<ExcelMapping> | null {
  if (!sheet) return null;
  const def = EXCEL_ENTITIES[entity];
  const out: Partial<ExcelMapping> & { columns: Record<string, string> } = { columns: {} };
  for (let r = 1; r <= 100; r++) {
    const cap = cellText(sheet.cell(r, 1)).toLowerCase();
    if (!cap) continue;
    const val = cellText(sheet.cell(r, 2));
    if (cap === 'sheet с данни') out.sheetName = val;
    else if (cap === 'начален ред') out.startingRow = Number(val) || 0;
    else if (cap === 'краен ред') out.endingRow = Number(val) || 0;
    else {
      const col = def.columns.find((c) => c.caption.toLowerCase() === cap || c.key.toLowerCase() === cap);
      if (col) out.columns[col.key] = val.toUpperCase();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cell reading (5.2: bg-BG with "." decimals, dd.MM.yyyy dates)

export function cellText(v: ExcelCell, length?: number): string {
  let s: string;
  if (v === null || v === undefined) s = '';
  else if (v instanceof Date) s = `${String(v.getUTCDate()).padStart(2, '0')}.${String(v.getUTCMonth() + 1).padStart(2, '0')}.${v.getUTCFullYear()}`;
  else if (typeof v === 'number') s = Number.isInteger(v) ? String(v) : String(v);
  else s = String(v);
  s = s.trim();
  return length ? s.slice(0, length) : s;
}

export function cellDecimal(v: ExcelCell): Dec | null {
  if (typeof v === 'number') return dec(v.toString());
  const s = cellText(v).replace(/\s/g, '');
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  return dec(s);
}

export function cellDate(v: ExcelCell): string | null {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  if (typeof v === 'number') return fromOADate(v);
  const s = cellText(v);
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s) && Number(s) > 1000) return fromOADate(Number(s));
  return parseImportDate(s);
}

/** "id-name" combo text -> id; null when not numeric. */
export function comboId(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const head = t.split('-')[0]!.trim();
  return /^\d+$/.test(head) ? Number(head) : null;
}

// ---------------------------------------------------------------------------
// Operations (5.3)

export interface ExcelAccountInfo { id: number; number: string; categoryId: number | null; isForeignCurrency: boolean; isMaterial: boolean; isLeaf: boolean }

export interface ExcelOperationsContext {
  activeYear: number;
  account: (number: string) => ExcelAccountInfo | null;
  vatPurchaseAccount: ExcelAccountInfo | null;
  vatSaleAccount: ExcelAccountInfo | null;
  documentTypeByShortName: (s: string) => number | null;
  viesIds: Set<number>;
  icaTypeIds: Set<number>;
  hasIcaColumns: boolean;
  /** Sequence-free ids of special document types. */
  protocolDocumentTypeId: number;
  invoiceDocumentTypeId: number;
}

export interface ExcelLine {
  account: ExcelAccountInfo;
  amount: string;
  vatTermId: number;
  currencyAmount?: string;
  exchangeRate?: string;
  fixedRate?: string;
  quantity?: string;
  price?: string;
}

export interface ExcelIcaDraft {
  icaType: number;
  accountingDate: string;
  transactionTypeId: number;
  deliveryDescription: string;
  term: string;
  reference: string;
  viesMonth: string;
  vatDiaryCode: string | null;
  documentTypeId: number;
  /** null = take the next number of channel "Протокол за ВОП". */
  documentNumber: string | null;
  documentDate: string;
  vatAmount: string;
  vatTermId: number;
  /** VAT-purchases account unless the expense account applies. */
  debitAccount: ExcelAccountInfo | null;
}

export interface ExcelOperationDraft {
  row: number;
  accountingDate: string;
  viesMonth: string;
  documentTypeId: number | null;
  documentNumber: string;
  documentDate: string | null;
  partner: { name: string; bulstat: string; vatNumber: string; iban: string } | null;
  term: string;
  reference: string;
  optionalReference: string;
  transactionTypeId: number;
  viesId: number;
  debits: ExcelLine[];
  credits: ExcelLine[];
  ica: ExcelIcaDraft | null;
}

const VAT_TERM = new Map<number, (typeof VAT_TERMS)[number]>(VAT_TERMS.map((t) => [t.id, t]));

interface SumItem { amount: Dec; a?: string; b?: string; c?: string }
function parseSumItem(s: string): SumItem | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:\(\s*(-?\d+(?:\.\d+)?)\s*\|\s*(-?\d+(?:\.\d+)?)\s*(?:\|\s*(-?\d+(?:\.\d+)?)\s*)?\))?\s*$/.exec(s);
  if (!m) return null;
  return { amount: round2(m[1]!), a: m[2], b: m[3], c: m[4] };
}

/**
 * One worksheet row -> one balanced accounting draft. Throws DataImportError
 * (the whole import is then aborted, nothing saved).
 */
export function parseExcelOperationRow(get: (key: string) => ExcelCell, letter: (key: string) => string, row: number, ctx: ExcelOperationsContext): ExcelOperationDraft {
  const fail = (key: ExchangeMessageKey, ...args: (string | number)[]): never => {
    throw new DataImportError(critical(key, ...args));
  };
  const cellErr = (key: string, value: string): never => fail('strInvalidDataFormatInExcelCell', row, letter(key), value);
  const text = (key: string, len?: number) => cellText(get(key), len);

  // Accounts "D-C", ';'-lists; '%' marks the VAT side.
  const accText = text('Accounts');
  const dash = accText.indexOf('-');
  if (dash <= 0 || dash === accText.length - 1) cellErr('Accounts', accText);
  const side = (part: string, isDebit: boolean) => {
    const items = part.split(';').map((x) => x.trim()).filter(Boolean);
    let vat = false;
    const accounts = items.map((n) => {
      let num = n;
      if (num.endsWith('%')) {
        num = num.slice(0, -1).trim();
        if (items.length === 1) vat = true;
      }
      const a = ctx.account(num);
      if (!a) fail('strAccountNotFound', num);
      return a!;
    });
    if (!accounts.length) cellErr('Accounts', accText);
    const vatAccount = vat ? (isDebit ? ctx.vatPurchaseAccount : ctx.vatSaleAccount) : null;
    if (vat && !vatAccount) fail('strAccountNotDefinedInCategory', isDebit ? 'ДДС покупки' : 'ДДС продажби', row);
    return { accounts, vat: vatAccount };
  };
  const D = side(accText.slice(0, dash), true);
  const Cr = side(accText.slice(dash + 1), false);
  const n = D.accounts.length;
  const m = Cr.accounts.length;
  // Defect D4 corrected: n-m with both sides > 1 is rejected instead of a Cartesian product.
  if (n > 1 && m > 1) cellErr('Accounts', accText);
  const pairs = Math.max(n, m);

  // Sums: "a;b;c" or "debit::credit".
  const sumText = text('Sums');
  const pairItems = (s: string) => s.split(';').map((x) => x.trim()).filter((x) => x !== '').map((x) => parseSumItem(x)!);
  const parseList = (s: string) => s.split(';').map((x) => x.trim()).filter((x) => x !== '').map((x) => parseSumItem(x) ?? cellErr('Sums', sumText));
  let debitItems: SumItem[];
  let creditItems: SumItem[];
  if (sumText.includes('::')) {
    const [ds, cs] = sumText.split('::');
    debitItems = parseList(ds ?? '');
    creditItems = parseList(cs ?? '');
    if (debitItems.length !== n || creditItems.length !== m) fail('strInvalidAccountingSumsInExcel', row, letter('Sums'));
    if (!sum(debitItems.map((i) => i.amount)).eq(sum(creditItems.map((i) => i.amount)))) fail('strInvalidDebitCreditAmounts');
  } else {
    const items = parseList(sumText);
    if (items.length !== pairs) fail('strInvalidAccountingSumsInExcel', row, letter('Sums'));
    const total: SumItem = { amount: sum(items.map((i) => i.amount)) };
    debitItems = n === pairs ? items : [{ ...total, ...pickAnalytics(items) }];
    creditItems = m === pairs ? items : [{ ...total, ...pickAnalytics(items) }];
  }

  // Date / VIES month.
  const dateRaw = get('Date');
  const date = cellDate(dateRaw);
  if (!date) cellErr('Date', cellText(dateRaw));
  if (Number(date!.slice(0, 4)) !== ctx.activeYear) fail('strOperationDateInDifferentFY', cellText(dateRaw), row);
  const vmText = text('VIESMonth');
  const viesMonth = vmText ? cellDate(get('VIESMonth')) ?? cellErr('VIESMonth', vmText) : date!;

  // VAT terms (one per pair) and transaction type.
  const vatText = text('VATOperation');
  const vatItems = vatText ? vatText.split(';').map((x) => x.trim()).filter(Boolean) : [];
  const vatIds = vatItems.map((it) => {
    const id = comboId(it);
    if (id === null) cellErr('VATOperation', it);
    if (!VAT_TERM.has(id!)) fail('strInvalidVatTermInExcel', row, letter('VATOperation'), it);
    return id!;
  });
  const termFor = (i: number) => vatIds[i] ?? vatIds[vatIds.length - 1] ?? 1;
  const transactionTypeId = VAT_TERM.get(termFor(0))?.transactionTypeId ?? TRANSACTION_TYPE.NotSet;

  // VIES.
  const viesText = text('VIES');
  let viesId = 1;
  if (viesText) {
    const id = comboId(viesText);
    if (id === null) cellErr('VIES', viesText);
    if (!ctx.viesIds.has(id!)) fail('strInvalidVIESInExcel', row, letter('VIES'), viesText);
    viesId = id!;
  }

  // Lines with analytics and VAT split.
  const special = (a: ExcelAccountInfo) => a.isMaterial || a.isForeignCurrency;
  const badAnalytics = (acc: ExcelAccountInfo): never => fail('strInvalidMaterialCurrencyAccountInExcelCell', row, letter('Sums'), acc.number);
  const shared = !sumText.includes('::');
  if (shared) {
    // Analytics of a shared item belong to whichever account of the pair is material/currency.
    pairItems(sumText).forEach((it, i) => {
      const d = D.accounts[Math.min(i, n - 1)]!;
      const c = Cr.accounts[Math.min(i, m - 1)]!;
      if (it.a !== undefined && !special(d) && !special(c)) badAnalytics(d);
    });
  }
  const sharedItems = shared ? pairItems(sumText) : [];
  const buildLines = (accounts: ExcelAccountInfo[], items: SumItem[], vatAccount: ExcelAccountInfo | null, many: boolean): ExcelLine[] => {
    const out: ExcelLine[] = [];
    accounts.forEach((acc, i) => {
      const it = items[i]!;
      const t = termFor(many ? i : 0);
      const line: ExcelLine = { account: acc, amount: it.amount.toFixed(2), vatTermId: t };
      const hasAnalytics = it.a !== undefined;
      if (acc.isMaterial && acc.isForeignCurrency) badAnalytics(acc);
      if (acc.isMaterial) {
        if (!hasAnalytics || it.c !== undefined) badAnalytics(acc);
        line.quantity = it.a;
        line.price = it.b;
      } else if (acc.isForeignCurrency) {
        if (!hasAnalytics) badAnalytics(acc);
        line.currencyAmount = it.a;
        line.exchangeRate = it.b;
        line.fixedRate = it.c ?? it.b;
      } else if (hasAnalytics && !shared) badAnalytics(acc);
      if (vatAccount) {
        // VAT part per pair: with one account on this side and a shared list, sum the pair VATs.
        const vat = !many && shared && sharedItems.length > 1
          ? round2(sum(sharedItems.map((p, k) => vatFromGross(p.amount, VAT_TERM.get(termFor(k))?.vatValue ?? 0))))
          : vatFromGross(it.amount, VAT_TERM.get(t)?.vatValue ?? 0);
        if (!vat.isZero()) {
          line.amount = it.amount.minus(vat).toFixed(2);
          out.push(line);
          out.push({ account: vatAccount, amount: vat.toFixed(2), vatTermId: t });
          return;
        }
      }
      out.push(line);
    });
    return out;
  };
  const debits = buildLines(D.accounts, debitItems, D.vat, n > 1);
  const credits = buildLines(Cr.accounts, creditItems, Cr.vat, m > 1);
  const totalD = round2(sum(debits.map((l) => l.amount)));
  const totalC = round2(sum(credits.map((l) => l.amount)));
  if (!totalD.eq(totalC)) fail('strInvalidDebitCreditAmounts');

  // Partner and document.
  const partnerName = text('Partner', 254);
  const needsPartner = [...D.accounts, ...Cr.accounts].some((a) => isCompanyCategory(a.categoryId));
  if (needsPartner && !partnerName) fail('strInvalidPartnerField', row, letter('Partner'));
  const docTypeText = text('DocumentType');
  const docNumber = text('DocumentNumber', 50);
  const docDateText = text('DocumentDate');
  let documentTypeId: number | null = null;
  if (docTypeText) {
    documentTypeId = ctx.documentTypeByShortName(docTypeText);
    if (documentTypeId === null) cellErr('DocumentType', docTypeText);
  } else if (docNumber || docDateText) fail('strDocumentTypeMissingError', row);
  const documentDate = docDateText ? cellDate(get('DocumentDate')) ?? cellErr('DocumentDate', docDateText) : date!;

  // ICA group (opt-in).
  let ica: ExcelIcaDraft | null = null;
  let icaType: number | null = null;
  if (ctx.hasIcaColumns) {
    const opText = text('OperationType');
    const id = comboId(opText);
    if (id !== null && ctx.icaTypeIds.has(id)) icaType = id;
  }

  // Term rule (resolved): empty term is an error in ICA type 3 or when the transaction type is set.
  const term = text('Term', 254);
  if (!term && (icaType === 3 || transactionTypeId !== TRANSACTION_TYPE.NotSet)) fail('strInvalidTermInRowField', row, letter('Term'));

  // VAT split check: a pair whose VAT term carries a rate needs a '%' side (5.3 "VAT split").
  if (!D.vat && !Cr.vat) {
    for (let i = 0; i < pairs; i++) {
      const it = shared ? sharedItems[i] : (n === pairs ? debitItems[i] : creditItems[i]);
      const vat = it ? vatFromGross(it.amount, VAT_TERM.get(termFor(i))?.vatValue ?? 0) : dec(0);
      if (!vat.isZero()) fail('strVATNotAllowedInOperationErrorWithRowNumber', row, vat.toFixed(2));
    }
  }

  if (icaType !== null) ica = buildIca(icaType, get, letter, row, date!, documentTypeId, docNumber, termFor(0), vatIds, ctx);

  return {
    row, accountingDate: date!, viesMonth: viesMonth!, documentTypeId, documentNumber: docNumber, documentDate: documentTypeId ? documentDate! : null,
    partner: partnerName || text('PartnerBulstat') || text('PartnerVatNumber') ? { name: partnerName, bulstat: text('PartnerBulstat', 50), vatNumber: text('PartnerVatNumber', 50), iban: text('PartnerIBAN', 50) } : null,
    term, reference: text('Reference', 254), optionalReference: text('OptionalReference', 254), transactionTypeId, viesId,
    debits, credits, ica,
  };
}

function pickAnalytics(items: SumItem[]): Partial<SumItem> {
  // Single side of a 1-n pair: analytics are summed from the items that carry them (currency amount / quantity).
  const withA = items.filter((i) => i.a !== undefined);
  if (!withA.length) return {};
  return { a: sum(withA.map((i) => i.a!)).toString(), b: withA[0]!.b, c: withA[0]!.c };
}

/** Default protocol term by ICA type (5.3 ICA item 8). */
export function icaDefaultTerm(icaType: number, goodType: number): ExchangeMessageKey | null {
  switch (icaType) {
    case 1: return 'strICATerm';
    case 4: return 'strICATerm163a';
    case 5: return 'strICATerm167a01';
    case 6: return null;
    case 7: return 'strICATypeThirdPart';
    case 8: return goodType === 7 ? 'strDefaultBreadTerm' : 'strDefaultFlourTerm';
    default: return 'strICATypeServiceTerm';
  }
}

const ICA_PURCHASE_FULL_CREDIT = 2; // "Получени доставки, ВОП с право на пълен ДК"

function buildIca(icaType: number, get: (key: string) => ExcelCell, letter: (key: string) => string, row: number, date: string, mainDocType: number | null, mainDocNumber: string, mainVatTerm: number, rowVatTerms: number[], ctx: ExcelOperationsContext): ExcelIcaDraft {
  const text = (k: string, len?: number) => cellText(get(k), len);
  const fail = (key: ExchangeMessageKey, ...args: (string | number)[]): never => {
    throw new DataImportError(critical(key, ...args));
  };
  const cellErr = (k: string, v: string): never => fail('strInvalidDataFormatInExcelCell', row, letter(k), v);
  const transactionTypeId = icaType === 3 ? TRANSACTION_TYPE.Sale : TRANSACTION_TYPE.Purchase;
  const emText = text('ExportMonth');
  const viesMonth = emText ? cellDate(get('ExportMonth')) ?? cellErr('ExportMonth', emText) : date;
  const goodText = text('OperationGoodType');
  let goodType = 0;
  if ([4, 5, 8, 9].includes(icaType)) {
    const g = comboId(goodText);
    if (g === null) fail('strInvalidOperationGoodTypeInExcelCell', row, letter('OperationGoodType'));
    goodType = g!;
  }
  const vatDiaryCode = [4, 6, 8, 9].includes(icaType) || (icaType === 5 && goodType === 3) ? String(goodType).padStart(2, '0') : null;
  // Document of the protocol.
  let documentTypeId = mainDocType ?? ctx.protocolDocumentTypeId;
  let protocolType = false;
  if (icaType !== 9 && !(icaType === 4 && transactionTypeId !== TRANSACTION_TYPE.Purchase)) {
    documentTypeId = ctx.protocolDocumentTypeId;
    protocolType = true;
  }
  if (icaType === 4 && mainVatTerm === 7) documentTypeId = ctx.invoiceDocumentTypeId;
  const icaNumber = text('ICADocumentNumber', 50);
  const documentNumber = protocolType ? icaNumber || null : mainDocNumber;
  const icaDateText = text('ICADate');
  const documentDate = icaDateText ? cellDate(get('ICADate')) ?? cellErr('ICADate', icaDateText) : date;
  // VAT amount.
  let vatAmount = dec(0);
  if ([1, 2, 5, 7].includes(icaType) || (icaType === 4 && rowVatTerms.includes(ICA_PURCHASE_FULL_CREDIT))) {
    const v = cellDecimal(get('ICAVAT'));
    if (v === null && text('ICAVAT')) cellErr('ICAVAT', text('ICAVAT'));
    vatAmount = round2(v ?? 0);
  }
  // Protocol VAT term.
  let vatTermId = ICA_PURCHASE_FULL_CREDIT;
  const icaVatText = text('ICAVATOperation');
  const icaVatId = comboId(icaVatText);
  if (icaType !== 1 && icaVatId !== null && VAT_TERM.has(icaVatId)) vatTermId = icaVatId;
  // Account10: VAT purchases, or the expense account for "no right to credit" (id 3).
  let debitAccount = ctx.vatPurchaseAccount;
  if ([1, 2, 4, 5, 7, 8].includes(icaType) && icaVatId === 3) {
    const expText = text('ExpenseAccount');
    const exp = expText ? ctx.account(expText) : null;
    if (!exp || !exp.isLeaf) fail('strInvalidExpenceAccountInExcelCell', row, letter('ExpenseAccount'));
    debitAccount = exp;
  }
  const termKey = icaDefaultTerm(icaType, goodType);
  return {
    icaType, accountingDate: date, transactionTypeId, deliveryDescription: text('DeliveryDescription', 254),
    term: text('ICATerm', 254) || (termKey ? (EXCEL_TERM_TEXT[termKey] ?? '') : ''),
    reference: icaType === 3 ? '' : text('ICAReference', 254), viesMonth: viesMonth!, vatDiaryCode, documentTypeId, documentNumber, documentDate: documentDate!,
    vatAmount: vatAmount.toFixed(2), vatTermId, debitAccount,
  };
}

const EXCEL_TERM_TEXT: Partial<Record<ExchangeMessageKey, string>> = EXCHANGE_MESSAGES;

// ---------------------------------------------------------------------------
// Initial balances direction tokens (5.4)

export function parseDirection(s: string): 1 | -1 | null {
  const t = s.trim().toLowerCase();
  if (['dt', 'debit', 'дт', 'дебит'].includes(t)) return 1;
  if (['ct', 'credit', 'kt', 'kredit', 'кт', 'кредит'].includes(t)) return -1;
  return null;
}

/** Character column "0/1/2-name" -> IsActive (1 active, 2 passive, 0/empty not set). */
export function parseCharacter(s: string): { ok: boolean; isActive: boolean | null } {
  const t = s.trim();
  if (!t) return { ok: true, isActive: null };
  const id = comboId(t);
  if (id === 0) return { ok: true, isActive: null };
  if (id === 1) return { ok: true, isActive: true };
  if (id === 2) return { ok: true, isActive: false };
  return { ok: false, isActive: null };
}
