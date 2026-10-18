import { dec, round2, sum, ZERO, type Dec } from '../money.ts';
import { VAT_TERMS } from '../seeds/lookups.ts';
import { parseXml, writeXml, XmlSyntaxError, type XmlElement, type XmlNode } from './xml.ts';
import { DataImportError, critical, msg, type ExchangeMessage } from './messages.ts';

/**
 * TransferData XML (`urn:Transfer`, spec 04a 3). Parsing validates against
 * the schema of 3.2 with the corrected enumerations (Vies 1-7, ICAType 1-9,
 * DocumentType 1-43). All data travels in attributes.
 */
export const TRANSFER_NS = 'urn:Transfer';

export interface TdAddress { location: string; city: string; phone: string; postalCode: string }
export interface TdBankAccount { bankName: string; bankCode: string; accountNumber: string; address?: TdAddress }
export interface TdAccount { number: string; description: string; category?: number; isActive?: boolean; currency: string; line?: number }
export interface TdProduct { name: string; code: string; measure: string; price: string; supplyAccountNumber: string; releaseAccountNumber?: string; line?: number }
export interface TdCompany {
  name: string; contactName?: string; bulstat?: string; vatNumber?: string;
  address?: TdAddress; bankAccounts: TdBankAccount[]; legacyBankAccount?: TdBankAccount; companyAccounts: string[]; line?: number;
}
export interface TdDocument { documentType: number; number: string; date: string }
export interface TdIca {
  icaType: number; vatAmount: string; term?: string; viesMonth?: string; icaType163a?: number; deliveryDescription?: string;
  reference?: string; operationByVat?: number; terminateAssetCreditAccount?: string; document: TdDocument;
}
export interface TdCurrencyDetail { currency: string; currencyAmount: string; exchangeRate: string; fixedRate: string }
export interface TdMaterialDetail { productName?: string; quantity: string; price: string }
export interface TdDetail {
  accountNumber: string; amount: string; direction: 'Debit' | 'Credit'; vatTerm: number;
  currency?: TdCurrencyDetail; material?: TdMaterialDetail;
}
export interface TdAccounting {
  number?: string; accountingDate?: string; viesMonth?: string; dueDate?: string; term?: string; reference?: string; optionalReference?: string;
  vies: number; vatTerm: number; document?: TdDocument; company?: TdCompany; details: TdDetail[]; ica?: TdIca; line?: number;
}
export interface TdOperation {
  operationType: number; date?: string; viesMonth?: string; vatTerm: number; term?: string; reference?: string;
  documentSumVatIncl: string; documentVat: string; document: TdDocument; company: TdCompany; ica?: TdIca; line?: number;
}
export interface TransferData {
  accounts?: TdAccount[];
  products?: TdProduct[];
  companies?: TdCompany[];
  accountings?: TdAccounting[];
  operations?: TdOperation[];
}

// ---------------------------------------------------------------------------
// Schema

type AttrType =
  | { t: 'string'; min?: number; max?: number; pattern?: RegExp; patternText?: string }
  | { t: 'decimal'; min?: number }
  | { t: 'date' }
  | { t: 'bool' }
  | { t: 'enum'; values: number[]; name: string };

interface AttrDef { type: AttrType; required?: boolean }
interface ElementDef { attrs: Record<string, AttrDef>; seq: [name: string, type: string, min: number, max: number][] }

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const str = (max?: number, min = 0): AttrType => ({ t: 'string', min, max });
const ACCOUNT_NUMBER: AttrType = { t: 'string', min: 1, max: 50, pattern: /^[1-9]([0-9]{0,3})(\/([0-9]{1,9}))*$/, patternText: 'AccountNumberSimpleType' };
const E_DOCTYPE: AttrType = { t: 'enum', values: range(1, 43), name: 'DocumentType' };
const E_VATTERM: AttrType = { t: 'enum', values: range(0, 18), name: 'VatTerm' };
const E_VIES: AttrType = { t: 'enum', values: range(1, 7), name: 'Vies' };
const E_ICATYPE: AttrType = { t: 'enum', values: range(1, 9), name: 'ICAType' };
const E_ICA163A: AttrType = { t: 'enum', values: [1, 2, 3, 7, 8, 41, 43, 46, 48, 51, 53, 54, 58], name: 'ICAType163a' };
const E_OPBYVAT: AttrType = { t: 'enum', values: range(1, 18), name: 'OperationByVAT' };
const E_CATEGORY: AttrType = { t: 'enum', values: range(1, 61), name: 'AccountCategory' };
const E_OPTYPE: AttrType = { t: 'enum', values: range(1, 17), name: 'OperationType' };
const DECIMAL: AttrType = { t: 'decimal' };
const DECIMAL_POS: AttrType = { t: 'decimal', min: 0 };
const DATE: AttrType = { t: 'date' };

const SCHEMA: Record<string, ElementDef> = {
  TransferData: { attrs: {}, seq: [['Accounts', 'Accounts', 0, 1], ['Products', 'Products', 0, 1], ['Companies', 'Companies', 0, 1], ['Accountings', 'Accountings', 0, 1], ['Operations', 'Operations', 0, 1]] },
  Accounts: { attrs: {}, seq: [['Account', 'Account', 0, Infinity]] },
  Products: { attrs: {}, seq: [['Product', 'Product', 0, Infinity]] },
  Companies: { attrs: {}, seq: [['Company', 'Company', 0, Infinity]] },
  Accountings: { attrs: {}, seq: [['Accounting', 'Accounting', 0, Infinity]] },
  Operations: { attrs: {}, seq: [['Operation', 'Operation', 0, Infinity]] },
  Account: {
    attrs: { Number: { type: ACCOUNT_NUMBER, required: true }, Description: { type: str(255, 1), required: true }, Category: { type: E_CATEGORY }, IsActive: { type: { t: 'bool' } }, Currency: { type: str() } },
    seq: [],
  },
  Product: {
    attrs: {
      Name: { type: str(255, 1), required: true }, Code: { type: str(50) }, Measure: { type: str(50, 1), required: true }, Price: { type: DECIMAL_POS },
      SupplyAccountNumber: { type: ACCOUNT_NUMBER, required: true }, ReleaseAccountNumber: { type: ACCOUNT_NUMBER },
    },
    seq: [],
  },
  Address: { attrs: { Location: { type: str(255) }, City: { type: str(50) }, Phone: { type: str(100) }, PostalCode: { type: str(10) } }, seq: [] },
  BankAccount: { attrs: { BankName: { type: str(255) }, BankCode: { type: str(50) }, AccountNumber: { type: str(50, 1), required: true } }, seq: [['Address', 'Address', 0, 1]] },
  BankAccounts: { attrs: {}, seq: [['BankAccount', 'BankAccount', 0, Infinity]] },
  CompanyAccount: { attrs: { AccountNumber: { type: ACCOUNT_NUMBER, required: true } }, seq: [] },
  CompanyAccounts: { attrs: {}, seq: [['CompanyAccount', 'CompanyAccount', 0, Infinity]] },
  Company: {
    attrs: { Name: { type: str(255, 1), required: true }, ContactName: { type: str(255) }, Bulstat: { type: str(50) }, VatNumber: { type: str(50) } },
    seq: [['Address', 'Address', 0, 1], ['BankAccounts', 'BankAccounts', 0, 1], ['BankAccount', 'BankAccount', 0, 1], ['CompanyAccounts', 'CompanyAccounts', 0, 1]],
  },
  Document: { attrs: { DocumentType: { type: E_DOCTYPE, required: true }, Number: { type: str(50, 1), required: true }, Date: { type: DATE, required: true } }, seq: [] },
  ICADocument: { attrs: { DocumentType: { type: E_DOCTYPE, required: true }, Number: { type: str(50, 0), required: true }, Date: { type: DATE, required: true } }, seq: [] },
  ICA: {
    attrs: {
      ICAType: { type: E_ICATYPE, required: true }, VATAmount: { type: DECIMAL, required: true }, Term: { type: str(255) }, ViesMonth: { type: DATE },
      ICAType163a: { type: E_ICA163A }, DeliveryDescription: { type: str(255) }, Reference: { type: str(255) }, OperationByVAT: { type: E_OPBYVAT },
      TerminateAssetCreditAccount: { type: ACCOUNT_NUMBER },
    },
    seq: [['Document', 'ICADocument', 1, 1]],
  },
  AccountingCurrencyDetail: {
    attrs: { Currency: { type: str(), required: true }, CurrencyAmount: { type: DECIMAL, required: true }, ExchangeRate: { type: DECIMAL_POS, required: true }, FixedRate: { type: DECIMAL } },
    seq: [],
  },
  AccountingMaterialDetail: { attrs: { ProductName: { type: str() }, Quantity: { type: DECIMAL, required: true }, Price: { type: DECIMAL_POS, required: true } }, seq: [] },
  AccountingDetail: {
    attrs: {
      AccountNumber: { type: ACCOUNT_NUMBER, required: true }, Amount: { type: DECIMAL, required: true },
      Direction: { type: { t: 'string', pattern: /^(Debit|Credit)$/, patternText: 'Direction' }, required: true }, VatTerm: { type: E_VATTERM },
    },
    seq: [['AccountingCurrencyDetail', 'AccountingCurrencyDetail', 0, 1], ['AccountingMaterialDetail', 'AccountingMaterialDetail', 0, 1]],
  },
  AccountingDetails: { attrs: {}, seq: [['AccountingDetail', 'AccountingDetail', 0, Infinity]] },
  Accounting: {
    attrs: {
      Number: { type: str(30) }, AccountingDate: { type: DATE }, ViesMonth: { type: DATE }, DueDate: { type: DATE }, Term: { type: str(255) },
      Reference: { type: str(255) }, OptionalReference: { type: str(255) }, Vies: { type: E_VIES }, VatTerm: { type: E_VATTERM },
    },
    seq: [['Document', 'Document', 0, 1], ['Company', 'Company', 0, 1], ['AccountingDetails', 'AccountingDetails', 1, 1], ['ICA', 'ICA', 0, 1]],
  },
  Operation: {
    attrs: {
      OperationType: { type: E_OPTYPE, required: true }, Date: { type: DATE }, ViesMonth: { type: DATE }, VatTerm: { type: E_VATTERM }, Term: { type: str(255) },
      Reference: { type: str(255) }, DocumentSumVATIncl: { type: DECIMAL, required: true }, DocumentVAT: { type: DECIMAL },
    },
    seq: [['Document', 'Document', 1, 1], ['Company', 'Company', 1, 1], ['ICA', 'ICA', 0, 1]],
  },
};

function where(el: { line: number; col: number }) {
  return ` on line ${el.line} position ${el.col}`;
}

function checkAttr(name: string, value: string, type: AttrType): string | null {
  const bad = (dt: string) => `The '${name}' attribute is invalid - The value '${value}' is invalid according to its datatype '${dt}'`;
  switch (type.t) {
    case 'string': {
      if (type.min !== undefined && value.length < type.min) return `${bad('String')} - The actual length is less than the MinLength value.`;
      if (type.max !== undefined && value.length > type.max) return `${bad('String')} - The actual length is greater than the MaxLength value.`;
      if (type.pattern && !type.pattern.test(value)) return `${bad(type.patternText ?? 'String')} - The Pattern constraint failed.`;
      return null;
    }
    case 'decimal': {
      if (!/^\s*[-+]?(\d+(\.\d*)?|\.\d+)\s*$/.test(value)) return bad('http://www.w3.org/2001/XMLSchema:decimal');
      if (type.min !== undefined && Number(value) < type.min) return `${bad('Decimal')} - The MinInclusive constraint failed.`;
      return null;
    }
    case 'date':
      return /^\s*\d{4}-\d{2}-\d{2}(T[\d:.]+)?(Z|[+-]\d{2}:\d{2})?\s*$/.test(value) && !Number.isNaN(Date.parse(value.trim().slice(0, 10))) ? null : bad('http://www.w3.org/2001/XMLSchema:date');
    case 'bool':
      return /^\s*(true|false|1|0)\s*$/.test(value) ? null : bad('http://www.w3.org/2001/XMLSchema:boolean');
    case 'enum': {
      const n = Number(value.trim());
      if (!/^\s*-?\d+\s*$/.test(value) || !type.values.includes(n)) return `${bad(type.name)} - The Enumeration constraint failed.`;
      return null;
    }
  }
}

function validateElement(el: XmlElement, typeName: string, errors: string[]) {
  const def = SCHEMA[typeName]!;
  if (el.ns !== TRANSFER_NS) {
    errors.push(`The element '${el.local}' in namespace '${el.ns}' is not declared${where(el)}`);
    return;
  }
  for (const [a, v] of Object.entries(el.attrs)) {
    if (a.includes(':')) continue; // xsi:* etc.
    const ad = def.attrs[a];
    if (!ad) errors.push(`The '${a}' attribute is not declared${where(el)}`);
    else {
      const e = checkAttr(a, v, ad.type);
      if (e) errors.push(e + where(el));
    }
  }
  for (const [a, ad] of Object.entries(def.attrs)) {
    if (ad.required && el.attrs[a] === undefined) errors.push(`The required attribute '${a}' is missing${where(el)}`);
  }
  if (el.text.trim()) errors.push(`The element '${el.local}' cannot contain text. Element type is element-only${where(el)}`);
  let p = 0;
  const counts = new Array(def.seq.length).fill(0) as number[];
  for (const c of el.children) {
    let k = p;
    while (k < def.seq.length && (def.seq[k]![0] !== c.local || counts[k]! >= def.seq[k]![3])) k++;
    if (k >= def.seq.length || c.ns !== TRANSFER_NS) {
      const expected = def.seq.slice(p).map((s) => `'${s[0]}'`).join(', ');
      errors.push(`The element '${el.local}' in namespace '${TRANSFER_NS}' has invalid child element '${c.local}' in namespace '${c.ns}'.${expected ? ` List of possible elements expected: ${expected} in namespace '${TRANSFER_NS}'.` : ''}${where(c)}`);
      continue;
    }
    for (let s = p; s < k; s++) {
      if (counts[s]! < def.seq[s]![2]) errors.push(`The element '${el.local}' in namespace '${TRANSFER_NS}' has invalid child element '${c.local}'. List of possible elements expected: '${def.seq[s]![0]}'${where(c)}`);
    }
    p = k;
    counts[k]!++;
    validateElement(c, def.seq[k]![1], errors);
  }
  for (let s = p; s < def.seq.length; s++) {
    if (counts[s]! < def.seq[s]![2]) errors.push(`The element '${el.local}' in namespace '${TRANSFER_NS}' has incomplete content. List of possible elements expected: '${def.seq[s]![0]}'${where(el)}`);
  }
}

/** Schema validation of a parsed document; returns ".NET-style" messages with line/position. */
export function validateTransferXml(root: XmlElement): string[] {
  const errors: string[] = [];
  if (root.local !== 'TransferData' || root.ns !== TRANSFER_NS) {
    errors.push(`The '${root.local}' element is not declared${where(root)}`);
    return errors;
  }
  validateElement(root, 'TransferData', errors);
  return errors;
}

// ---------------------------------------------------------------------------
// Reading

const a = (el: XmlElement | undefined, n: string) => el?.attrs[n];
const opt = (el: XmlElement, n: string) => {
  const v = el.attrs[n];
  return v === undefined ? undefined : v;
};
const kid = (el: XmlElement | undefined, n: string) => el?.children.find((c) => c.local === n);
const kids = (el: XmlElement | undefined, n: string) => el?.children.filter((c) => c.local === n) ?? [];
const num = (v: string | undefined, d: number) => (v === undefined || v.trim() === '' ? d : Number(v.trim()));
const date = (v: string | undefined) => (v ? v.trim().slice(0, 10) : undefined);
const decs = (v: string | undefined, d = '0') => (v === undefined || v.trim() === '' ? d : v.trim().replace(/^\+/, ''));

function readAddress(el: XmlElement | undefined): TdAddress | undefined {
  if (!el) return undefined;
  return { location: a(el, 'Location') ?? '', city: a(el, 'City') ?? '', phone: a(el, 'Phone') ?? '', postalCode: a(el, 'PostalCode') ?? '' };
}
function readBankAccount(el: XmlElement): TdBankAccount {
  return { bankName: a(el, 'BankName') ?? '', bankCode: a(el, 'BankCode') ?? '', accountNumber: a(el, 'AccountNumber') ?? '', address: readAddress(kid(el, 'Address')) };
}
function readCompany(el: XmlElement): TdCompany {
  const legacy = kid(el, 'BankAccount');
  return {
    name: a(el, 'Name') ?? '', contactName: opt(el, 'ContactName'), bulstat: opt(el, 'Bulstat'), vatNumber: opt(el, 'VatNumber'),
    address: readAddress(kid(el, 'Address')),
    bankAccounts: kids(kid(el, 'BankAccounts'), 'BankAccount').map(readBankAccount),
    legacyBankAccount: legacy ? readBankAccount(legacy) : undefined,
    companyAccounts: kids(kid(el, 'CompanyAccounts'), 'CompanyAccount').map((c) => a(c, 'AccountNumber') ?? ''),
    line: el.line,
  };
}
function readDocument(el: XmlElement | undefined): TdDocument | undefined {
  if (!el) return undefined;
  return { documentType: num(a(el, 'DocumentType'), 0), number: a(el, 'Number') ?? '', date: date(a(el, 'Date'))! };
}
function readIca(el: XmlElement | undefined): TdIca | undefined {
  if (!el) return undefined;
  return {
    icaType: num(a(el, 'ICAType'), 0), vatAmount: decs(a(el, 'VATAmount')), term: opt(el, 'Term'), viesMonth: date(opt(el, 'ViesMonth')),
    icaType163a: opt(el, 'ICAType163a') !== undefined ? num(a(el, 'ICAType163a'), 0) : undefined, deliveryDescription: opt(el, 'DeliveryDescription'),
    reference: opt(el, 'Reference'), operationByVat: opt(el, 'OperationByVAT') !== undefined ? num(a(el, 'OperationByVAT'), 1) : undefined,
    terminateAssetCreditAccount: opt(el, 'TerminateAssetCreditAccount'), document: readDocument(kid(el, 'Document'))!,
  };
}
function readDetail(el: XmlElement): TdDetail {
  const c = kid(el, 'AccountingCurrencyDetail');
  const m = kid(el, 'AccountingMaterialDetail');
  return {
    accountNumber: a(el, 'AccountNumber') ?? '', amount: decs(a(el, 'Amount')), direction: a(el, 'Direction') === 'Credit' ? 'Credit' : 'Debit',
    vatTerm: num(a(el, 'VatTerm'), 1),
    currency: c ? { currency: a(c, 'Currency') ?? '', currencyAmount: decs(a(c, 'CurrencyAmount')), exchangeRate: decs(a(c, 'ExchangeRate')), fixedRate: decs(a(c, 'FixedRate')) } : undefined,
    material: m ? { productName: opt(m, 'ProductName'), quantity: decs(a(m, 'Quantity')), price: decs(a(m, 'Price')) } : undefined,
  };
}

export function readTransferData(root: XmlElement): TransferData {
  const out: TransferData = {};
  const accounts = kid(root, 'Accounts');
  if (accounts) out.accounts = kids(accounts, 'Account').map((el) => ({
    number: a(el, 'Number')!, description: a(el, 'Description')!, category: opt(el, 'Category') !== undefined ? num(a(el, 'Category'), 0) : undefined,
    isActive: opt(el, 'IsActive') !== undefined ? /^(true|1)$/.test(a(el, 'IsActive')!.trim()) : undefined,
    currency: (a(el, 'Currency') ?? '').trim() || 'BGN', line: el.line,
  }));
  const products = kid(root, 'Products');
  if (products) out.products = kids(products, 'Product').map((el) => ({
    name: a(el, 'Name')!, code: a(el, 'Code') ?? '', measure: a(el, 'Measure')!, price: decs(a(el, 'Price'), '0.000000'),
    supplyAccountNumber: a(el, 'SupplyAccountNumber')!, releaseAccountNumber: opt(el, 'ReleaseAccountNumber'), line: el.line,
  }));
  const companies = kid(root, 'Companies');
  if (companies) out.companies = kids(companies, 'Company').map(readCompany);
  const accountings = kid(root, 'Accountings');
  if (accountings) out.accountings = kids(accountings, 'Accounting').map((el) => {
    const company = kid(el, 'Company');
    return {
      number: opt(el, 'Number'), accountingDate: date(opt(el, 'AccountingDate')), viesMonth: date(opt(el, 'ViesMonth')), dueDate: date(opt(el, 'DueDate')),
      term: opt(el, 'Term'), reference: opt(el, 'Reference'), optionalReference: opt(el, 'OptionalReference'),
      vies: num(a(el, 'Vies'), 1), vatTerm: num(a(el, 'VatTerm'), 0), document: readDocument(kid(el, 'Document')),
      company: company ? readCompany(company) : undefined, details: kids(kid(el, 'AccountingDetails'), 'AccountingDetail').map(readDetail),
      ica: readIca(kid(el, 'ICA')), line: el.line,
    };
  });
  const operations = kid(root, 'Operations');
  if (operations) out.operations = kids(operations, 'Operation').map((el) => ({
    operationType: num(a(el, 'OperationType'), 0), date: date(opt(el, 'Date')), viesMonth: date(opt(el, 'ViesMonth')), vatTerm: num(a(el, 'VatTerm'), 1),
    term: opt(el, 'Term'), reference: opt(el, 'Reference'), documentSumVatIncl: decs(a(el, 'DocumentSumVATIncl')), documentVat: decs(a(el, 'DocumentVAT'), '0.00'),
    document: readDocument(kid(el, 'Document'))!, company: readCompany(kid(el, 'Company')!), ica: readIca(kid(el, 'ICA')), line: el.line,
  }));
  return out;
}

/**
 * File validation of step 1 (3.5): well-formedness + schema; then at least
 * one Accounting or Operation. Throws DataImportError with strXMLImportError
 * (or strXMLImportCurrencyError when a message mentions "Currency").
 */
export function parseTransferXml(text: string, opts: { requireOperations?: boolean } = {}): TransferData {
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch (e) {
    if (e instanceof XmlSyntaxError) throw new DataImportError(critical('strXMLImportError'), [e.message]);
    throw e;
  }
  const errors = validateTransferXml(root);
  if (errors.length) {
    const key = errors.some((e) => e.includes('Currency')) ? 'strXMLImportCurrencyError' : 'strXMLImportError';
    throw new DataImportError(critical(key), errors);
  }
  const data = readTransferData(root);
  if (opts.requireOperations !== false && !data.accountings?.length && !data.operations?.length) {
    throw new DataImportError(critical('strImportFileHasNoDataErrorMessage'));
  }
  return data;
}

// ---------------------------------------------------------------------------
// Writing

const fmtDec = (v: string | Dec, places = 2) => dec(v).toFixed(places);
function addressNode(x: TdAddress | undefined): XmlNode[] {
  return x ? [{ name: 'Address', attrs: { Location: x.location, City: x.city, Phone: x.phone, PostalCode: x.postalCode } }] : [];
}
function bankAccountNode(b: TdBankAccount): XmlNode {
  return { name: 'BankAccount', attrs: { BankName: b.bankName || undefined, BankCode: b.bankCode || undefined, AccountNumber: b.accountNumber }, children: addressNode(b.address) };
}
function companyNode(c: TdCompany): XmlNode {
  const kidsOut: XmlNode[] = [...addressNode(c.address)];
  if (c.bankAccounts.length) kidsOut.push({ name: 'BankAccounts', children: c.bankAccounts.map(bankAccountNode) });
  if (c.legacyBankAccount) kidsOut.push(bankAccountNode(c.legacyBankAccount));
  if (c.companyAccounts.length) kidsOut.push({ name: 'CompanyAccounts', children: c.companyAccounts.map((n) => ({ name: 'CompanyAccount', attrs: { AccountNumber: n } })) });
  return { name: 'Company', attrs: { Name: c.name, ContactName: c.contactName || undefined, Bulstat: c.bulstat || undefined, VatNumber: c.vatNumber || undefined }, children: kidsOut };
}
function documentNode(d: TdDocument): XmlNode {
  return { name: 'Document', attrs: { DocumentType: d.documentType, Number: d.number, Date: d.date } };
}
function icaNode(i: TdIca): XmlNode {
  return {
    name: 'ICA',
    attrs: {
      ICAType: i.icaType, VATAmount: fmtDec(i.vatAmount), Term: i.term, ViesMonth: i.viesMonth, ICAType163a: i.icaType163a || undefined,
      DeliveryDescription: i.deliveryDescription, Reference: i.reference, OperationByVAT: i.operationByVat, TerminateAssetCreditAccount: i.terminateAssetCreditAccount,
    },
    children: [documentNode(i.document)],
  };
}

export function writeTransferXml(data: TransferData): string {
  const root: XmlNode = { name: 'TransferData', attrs: { xmlns: TRANSFER_NS }, children: [] };
  const top = root.children!;
  if (data.accounts) top.push({ name: 'Accounts', children: data.accounts.map((x) => ({ name: 'Account', attrs: { Number: x.number, Description: x.description, Category: x.category, IsActive: x.isActive === undefined ? undefined : String(x.isActive), Currency: x.currency } })) });
  if (data.products) top.push({ name: 'Products', children: data.products.map((p) => ({ name: 'Product', attrs: { Name: p.name, Code: p.code, Measure: p.measure, Price: fmtDec(p.price, 6), SupplyAccountNumber: p.supplyAccountNumber, ReleaseAccountNumber: p.releaseAccountNumber } })) });
  if (data.companies) top.push({ name: 'Companies', children: data.companies.map(companyNode) });
  if (data.accountings) top.push({
    name: 'Accountings',
    children: data.accountings.map((x) => ({
      name: 'Accounting',
      attrs: {
        AccountingDate: x.accountingDate, DueDate: x.dueDate, Number: x.number, Reference: x.reference ?? undefined, OptionalReference: x.optionalReference ?? undefined,
        Term: x.term ?? '', Vies: x.vies, ViesMonth: x.viesMonth,
      },
      children: [
        ...(x.document ? [documentNode(x.document)] : []),
        ...(x.company ? [companyNode(x.company)] : []),
        {
          name: 'AccountingDetails',
          children: x.details.map((d) => ({
            name: 'AccountingDetail',
            attrs: { AccountNumber: d.accountNumber, Amount: fmtDec(d.amount), Direction: d.direction, VatTerm: d.vatTerm },
            children: [
              ...(d.currency ? [{ name: 'AccountingCurrencyDetail', attrs: { Currency: d.currency.currency, CurrencyAmount: fmtDec(d.currency.currencyAmount), ExchangeRate: dec(d.currency.exchangeRate).toFixed(6), FixedRate: dec(d.currency.fixedRate).toFixed(6) } }] : []),
              ...(d.material ? [{ name: 'AccountingMaterialDetail', attrs: { ProductName: d.material.productName, Quantity: dec(d.material.quantity).toFixed(6), Price: dec(d.material.price).toFixed(6) } }] : []),
            ],
          })),
        },
        ...(x.ica ? [icaNode(x.ica)] : []),
      ],
    })),
  });
  if (data.operations) top.push({
    name: 'Operations',
    children: data.operations.map((o) => ({
      name: 'Operation',
      attrs: { OperationType: o.operationType, Date: o.date, ViesMonth: o.viesMonth, VatTerm: o.vatTerm, Term: o.term, Reference: o.reference, DocumentSumVATIncl: fmtDec(o.documentSumVatIncl), DocumentVAT: fmtDec(o.documentVat) },
      children: [documentNode(o.document), companyNode(o.company), ...(o.ica ? [icaNode(o.ica)] : [])],
    })),
  });
  return writeXml(root);
}

// ---------------------------------------------------------------------------
// Operation -> postings (3.8)

/** The 15 account categories of wizard step 2 (category ids of 01a 6). */
export const XML_OPERATION_CATEGORIES: { id: number; name: string }[] = [
  { id: 1, name: 'Материали' }, { id: 3, name: 'Стоки' }, { id: 4, name: 'Доставчици' }, { id: 10, name: 'Клиенти' },
  { id: 16, name: 'ДДС покупки' }, { id: 17, name: 'ДДС продажби' }, { id: 56, name: 'Разчети с митници' },
  { id: 21, name: 'Каса в основна валута' }, { id: 22, name: 'Банка в основна валута' }, { id: 37, name: 'Разходи за материали' },
  { id: 38, name: 'Разходи за външни услуги' }, { id: 45, name: 'Други разходи' }, { id: 23, name: 'Продажби на продукция' },
  { id: 24, name: 'Продажби на стоки' }, { id: 25, name: 'Продажби на услуги' },
];

export const OPERATION_TYPE_NAMES: Record<number, string> = {
  1: 'Разходи за материали', 2: 'Разходи за услуги', 3: 'Други разходи', 4: 'Покупка на материали', 5: 'Покупка на стоки',
  6: 'Продажба на продукция', 7: 'Продажба на стоки', 8: 'Продажба на услуги', 9: 'Изписване материали/стоки на разход',
  10: 'Изписване на отчетна стойност', 11: 'ВОП', 12: 'ВОП услуги', 13: 'Внос - митническа декларация',
  14: 'Плащане на доставчик в брой', 15: 'Плащане от клиент в брой', 16: 'Плащане на доставчик по банка', 17: 'Плащане от клиент по банка',
};

/** [debit category, debit amount, credit category, credit amount, vat mode] */
type OpRule = { dr: number; drAmt: 'net' | 'sum'; cr: number; crAmt: 'net' | 'sum'; vat: 'purchase' | 'sale' | 'forbidden' | 'required' };
const OP_RULES: Record<number, OpRule> = {
  1: { dr: 37, drAmt: 'net', cr: 4, crAmt: 'sum', vat: 'purchase' },
  2: { dr: 38, drAmt: 'net', cr: 4, crAmt: 'sum', vat: 'purchase' },
  3: { dr: 45, drAmt: 'net', cr: 4, crAmt: 'sum', vat: 'purchase' },
  4: { dr: 1, drAmt: 'net', cr: 4, crAmt: 'sum', vat: 'purchase' },
  5: { dr: 3, drAmt: 'net', cr: 4, crAmt: 'sum', vat: 'purchase' },
  6: { dr: 10, drAmt: 'sum', cr: 23, crAmt: 'net', vat: 'sale' },
  7: { dr: 10, drAmt: 'sum', cr: 24, crAmt: 'net', vat: 'sale' },
  8: { dr: 10, drAmt: 'sum', cr: 25, crAmt: 'net', vat: 'sale' },
  9: { dr: 37, drAmt: 'sum', cr: 3, crAmt: 'sum', vat: 'forbidden' },
  10: { dr: 24, drAmt: 'sum', cr: 3, crAmt: 'sum', vat: 'forbidden' },
  13: { dr: 56, drAmt: 'net', cr: 56, crAmt: 'sum', vat: 'required' },
  14: { dr: 4, drAmt: 'sum', cr: 21, crAmt: 'sum', vat: 'forbidden' },
  15: { dr: 21, drAmt: 'sum', cr: 10, crAmt: 'sum', vat: 'forbidden' },
  16: { dr: 4, drAmt: 'sum', cr: 22, crAmt: 'sum', vat: 'forbidden' },
  17: { dr: 22, drAmt: 'sum', cr: 10, crAmt: 'sum', vat: 'forbidden' },
};

export interface CategoryLine { categoryId: number; amount: string; vatTerm: number }

/**
 * Converts an Operation to debit/credit lines by account category. VatTerm
 * is set on the first two lines only (3.8). Throws DataImportError.
 */
export function operationToLines(op: TdOperation): { debits: CategoryLine[]; credits: CategoryLine[] } {
  const rule = OP_RULES[op.operationType];
  if (!rule) throw new DataImportError(critical('strUnrecognizedOperationType', op.operationType));
  const total = round2(op.documentSumVatIncl);
  const vat = round2(op.documentVat);
  const net = total.minus(vat);
  const amt = (k: 'net' | 'sum') => (k === 'net' ? net : total).toFixed(2);
  const debits: CategoryLine[] = [{ categoryId: rule.dr, amount: amt(rule.drAmt), vatTerm: op.vatTerm }];
  const credits: CategoryLine[] = [{ categoryId: rule.cr, amount: amt(rule.crAmt), vatTerm: op.vatTerm }];
  if (rule.vat === 'forbidden' && !vat.isZero()) throw new DataImportError(critical('strVATNotAllowedInOperation', vat.toFixed(2)));
  if (rule.vat === 'required' && !vat.greaterThan(0)) throw new DataImportError(critical('strVATRequiredInOperation'));
  if (vat.greaterThan(0)) {
    if (rule.vat === 'purchase' || rule.vat === 'required') debits.push({ categoryId: 16, amount: vat.toFixed(2), vatTerm: 1 });
    else if (rule.vat === 'sale') credits.push({ categoryId: 17, amount: vat.toFixed(2), vatTerm: 1 });
  }
  return { debits, credits };
}

// ---------------------------------------------------------------------------
// Accounting rules (3.7 steps 2-6)

const VAT_TERM_TYPE = new Map<number, number>(VAT_TERMS.map((t) => [t.id, t.transactionTypeId]));

export interface PairLine {
  accountNumber: string;
  amount: string;
  vatTerm: number;
  currency?: TdCurrencyDetail;
  material?: TdMaterialDetail;
}

/**
 * Validates an Accounting's details and returns debit/credit lines in
 * editor shape (1-1, 1-n, n-1). `knownCurrencies` = ISO codes in the DB.
 */
export function accountingLines(acc: TdAccounting, knownCurrencies: Set<string>): { debits: PairLine[]; credits: PairLine[]; transactionTypeId: number } {
  const errs: ExchangeMessage[] = [];
  if (!acc.details.length) errs.push(critical('strXMLImportDetailError'));
  for (const d of acc.details) {
    if (!d.currency) continue;
    if (!d.currency.currency.trim()) errs.push(critical('strXMLImportMissingCurrencyError'));
    else if (!knownCurrencies.has(d.currency.currency.trim().toUpperCase())) errs.push({ key: 'strXMLImportCurrencyError', text: `${msg('strXMLImportCurrencyError')}: ${d.currency.currency}`, severity: 'critical' });
  }
  if (errs.length) throw new DataImportError(errs);

  const debitsIn = acc.details.filter((d) => d.direction === 'Debit');
  const creditsIn = acc.details.filter((d) => d.direction === 'Credit');
  const accLevel = acc.vatTerm && VAT_TERM_TYPE.has(acc.vatTerm) ? acc.vatTerm : null;
  const firstTerm = accLevel ?? (debitsIn[0] && VAT_TERM_TYPE.has(debitsIn[0].vatTerm) ? debitsIn[0].vatTerm : null);
  if (firstTerm == null) throw new DataImportError(critical('strXMLImportAccountingVatTermError'));
  if (!debitsIn.length || !creditsIn.length) throw new DataImportError(critical('strXMLImportEmptyAccountingError'));
  const dSum = round2(sum(debitsIn.map((d) => d.amount)));
  const cSum = round2(sum(creditsIn.map((d) => d.amount)));
  if (!dSum.eq(cSum)) throw new DataImportError(critical('strXMLImportAccountingSumsError', dSum.toFixed(2), cSum.toFixed(2)));
  if (debitsIn.length > 1 && creditsIn.length > 1) throw new DataImportError(critical('strXMLImportAccountingDetailsError'));
  for (const d of acc.details) {
    if (d.currency && d.material) throw new DataImportError(critical('strXMLImportAccountingAnalyticalDetailsError', d.accountNumber));
  }
  const toLine = (d: TdDetail): PairLine => ({
    accountNumber: d.accountNumber, amount: round2(d.amount).toFixed(2), vatTerm: accLevel ?? (VAT_TERM_TYPE.has(d.vatTerm) ? d.vatTerm : 1),
    currency: d.currency ? { ...d.currency, currency: d.currency.currency.trim().toUpperCase() } : undefined, material: d.material,
  });
  const debits = debitsIn.map(toLine);
  const credits = creditsIn.map(toLine);
  // The single side's currency/material amounts are split over the pairs by
  // buildLegs (proportional shares, residue on the last pair).
  return { debits, credits, transactionTypeId: VAT_TERM_TYPE.get(firstTerm) ?? 1 };
}

/** Placeholder Bulstat / VAT number ignored by partner matching (3.6). */
export const IDENTIFIER_PLACEHOLDER = '999999999999999';
export const usableIdentifier = (v: string | null | undefined) => {
  const t = v?.trim() ?? '';
  return t !== '' && t !== IDENTIFIER_PLACEHOLDER ? t : null;
};

/** Bulstat derived from a BG VAT number when the Bulstat is empty (3.6). */
export function bulstatFromVat(vat: string | null | undefined): string | null {
  const t = vat?.trim().toUpperCase() ?? '';
  return t.startsWith('BG') && t.length > 2 ? t.slice(2) : null;
}
