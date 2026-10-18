import { dec, round2, type Dec } from '../money.ts';
import { VAT_TERMS } from '../seeds/lookups.ts';
import { CATEGORY } from '../categories.ts';
import { DataImportError, critical, msg, parseBgDate, parseDecimalText, type ExchangeMessage, type ExchangeMessageKey } from './messages.ts';

/**
 * Pipe-delimited operations file ("Импорт на операции", spec 04a 4) - the
 * legacy Microinvest Delta export format. One operation per line, 16+ fields.
 */

/** Account reference: by category (wizard mapping) or by explicit number. */
export type AccountRef = { category: number } | { number: string };

export interface TxtPartner {
  name: string; contactName: string; city: string; address: string; vatNumber: string; bulstat: string;
}

export interface TxtOperation {
  row: number;
  /** Kind 1..13, or 0 for a free-form "debit-credit" kind. */
  kind: number;
  debit: AccountRef;
  credit: AccountRef;
  /** VAT account and its side (purchase VAT on the debit side, sales VAT on the credit side). */
  vat: { side: 'debit' | 'credit'; category: number } | null;
  date: string;
  documentNumber: string;
  documentTypeShortName: string;
  amount: string;
  vatTermId: number;
  vatAmount: string;
  partner: TxtPartner;
  term: string;
  reference: string;
}

/** Operation kinds (4.x table): debit / credit category, VAT account, default term key. */
export const TXT_OPERATION_KINDS: Record<number, { debit: number; credit: number; vat: { side: 'debit' | 'credit'; category: number } | null; term: ExchangeMessageKey }> = {
  1: { debit: CATEGORY.Goods, credit: CATEGORY.Suppliers, vat: { side: 'debit', category: CATEGORY.VatPurchases }, term: 'strProductsDelivery' },
  2: { debit: CATEGORY.Customers, credit: 24, vat: { side: 'credit', category: CATEGORY.VatSales }, term: 'strProductsSale' },
  5: { debit: CATEGORY.Customers, credit: 25, vat: { side: 'credit', category: CATEGORY.VatSales }, term: 'strServicesInvoice' },
  6: { debit: CATEGORY.Customers, credit: 24, vat: { side: 'credit', category: CATEGORY.VatSales }, term: 'strSpecialSalesAndReturns' },
  7: { debit: CATEGORY.Goods, credit: CATEGORY.Suppliers, vat: null, term: 'strDeliveryWithoutDocument' },
  8: { debit: 24, credit: CATEGORY.Goods, vat: null, term: 'strProductsWriteOff' },
  9: { debit: CATEGORY.Suppliers, credit: CATEGORY.CashBase, vat: null, term: 'strPaymentInLevaToSupplier' },
  10: { debit: CATEGORY.CashBase, credit: CATEGORY.Customers, vat: null, term: 'strPaymentFromClientInLeva' },
  11: { debit: CATEGORY.CashBase, credit: 24, vat: { side: 'credit', category: CATEGORY.VatSales }, term: 'strInvoiceWithout411' },
  12: { debit: CATEGORY.Customers, credit: 24, vat: { side: 'credit', category: CATEGORY.VatOss }, term: 'strItemSaleOSS' },
  13: { debit: CATEGORY.Customers, credit: 25, vat: { side: 'credit', category: CATEGORY.VatOss }, term: 'strServiceSaleOSS' },
};

/** Field 6 VAT-term codes -> VATTermType ids (8 -> 1, 11 -> 3, 12 -> 2, 13..27 -> 4..18). */
export function vatTermFromTxtCode(code: number): number | null {
  if (code === 8) return 1;
  if (code === 11) return 3;
  if (code === 12) return 2;
  if (code >= 13 && code <= 27) return code - 9;
  return null;
}

/** Accepted document short names (field 4). `Д-ги` is an alias of `Прот`, `ББ` of the bank statement `БИ`. */
export const TXT_DOCUMENT_SHORT_NAMES = [
  'Ф-ра', 'ДИ', 'КИ', 'МД', 'Прот', 'Д-ги', 'ОП', 'ОПС', 'ПКО', 'РКО', 'МО', 'ББ', 'ПН', 'ИнвО', 'АО', 'ВнБ', 'БПлН', 'БОВал', 'СклР', 'ИОтпМ',
  'РЧ', 'Акр', 'Ф-ра(КО)', 'ДИ(КО)', 'КИ(КО)', 'Прот(КО)', 'Прот(КОдк)', 'ПротИДрл', 'ПротИДнрл', 'АкцДок', 'Квит',
];
export const TXT_DOCUMENT_ALIASES: Record<string, string> = { 'Д-ги': 'Прот', ББ: 'БИ' };

const VAT_RATE = new Map<number, number>(VAT_TERMS.map((t) => [t.id, t.vatValue]));

/** VAT part of an amount that includes VAT: amount x rate / (100 + rate), 2 dp away from zero. */
export function vatFromGross(amount: Dec | string, rate: number): Dec {
  if (!rate) return dec(0);
  return round2(dec(amount).times(rate).div(100 + rate));
}

export interface TxtParseOptions {
  activeYear: number;
  /** Optional period filter (default 1900-01-01..2100-01-01). */
  from?: string;
  to?: string;
  /** Wizard's predefined term (applied to every line when set). */
  predefinedTerm?: string;
}

/**
 * Parses and validates the whole file. Shape errors (fewer than 16 fields,
 * field 2 not a date) abort at once; the remaining row errors are collected
 * and raised together, so nothing is imported from a file with errors.
 */
export function parseTextImport(text: string, o: TxtParseOptions): TxtOperation[] {
  const lines = text.split(/\r?\n/);
  const rows: { row: number; f: string[] }[] = [];
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const f = raw.split('|');
    if (f.length < 16) throw new DataImportError(critical('strInvalidDataFormatInRow', i + 1));
    if (!parseBgDate(f[1]!)) throw new DataImportError(critical('strInvalidDataFormatInRowField', i + 1, 2, f[1]!));
    rows.push({ row: i + 1, f });
  });
  const from = o.from ?? '1900-01-01';
  const to = o.to ?? '2100-01-01';
  const errors: ExchangeMessage[] = [];
  const out: TxtOperation[] = [];
  for (const { row, f } of rows) {
    const err = (key: ExchangeMessageKey, ...args: (string | number)[]) => errors.push(critical(key, ...args));
    const date = parseBgDate(f[1]!)!;
    if (date < from || date > to) continue;
    const kindText = f[0]!.trim();
    let kind = 0;
    let debit: AccountRef;
    let credit: AccountRef;
    let vat: TxtOperation['vat'] = null;
    let defaultTerm = msg('strTerm');
    if (kindText.length <= 3) {
      if (!/^\d+$/.test(kindText)) {
        err('strInvalidDataFormatInRowField', row, 1, kindText);
        continue;
      }
      kind = Number(kindText);
      const k = TXT_OPERATION_KINDS[kind];
      if (!k) {
        err('strUnrecognizedOperationType', kind);
        continue;
      }
      debit = { category: k.debit };
      credit = { category: k.credit };
      vat = k.vat;
      defaultTerm = msg(k.term);
    } else {
      const parts = kindText.split('-');
      if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) {
        err('strInvalidDataFormatInRowField', row, 1, kindText);
        continue;
      }
      let [d, c] = parts.map((p) => p.trim()) as [string, string];
      if (d.includes('%')) {
        d = d.replace(/%/g, '');
        vat = { side: 'debit', category: CATEGORY.VatPurchases };
      }
      if (c.includes('%')) {
        c = c.replace(/%/g, '');
        vat = { side: 'credit', category: CATEGORY.VatSales };
      }
      debit = { number: d };
      credit = { number: c };
    }
    if (Number(date.slice(0, 4)) !== o.activeYear) err('strOperationDateInDifferentFY', f[1]!.trim(), row);
    const docShort = f[3]!.trim();
    if (!TXT_DOCUMENT_SHORT_NAMES.includes(docShort)) err('strInvalidDocumentTypeInImport', row, 4, docShort);
    const amountText = parseDecimalText(f[4]!);
    if (amountText === null) {
      err('strInvalidDataFormatInRowField', row, 5, f[4]!);
      continue;
    }
    const amount = round2(amountText);
    const codeText = f[5]!.trim();
    const vatTermId = /^\d+$/.test(codeText) ? vatTermFromTxtCode(Number(codeText)) : null;
    if (vatTermId === null) {
      err('strInvalidVatTermTypeInImport', row, 6, codeText);
      continue;
    }
    const vatText = f[15]!.trim();
    let vatAmount: Dec;
    if (vatText === '-1') vatAmount = vatFromGross(amount, VAT_RATE.get(vatTermId) ?? 0);
    else {
      const v = parseDecimalText(vatText || '0');
      if (v === null) {
        err('strInvalidDataFormatInRowField', row, 16, vatText);
        continue;
      }
      vatAmount = round2(v);
    }
    if (!vatAmount.isZero() && !vat) {
      err('strVATNotAllowedInOperationErrorWithRowNumber', row, vatAmount.toFixed(2));
      continue;
    }
    const term = o.predefinedTerm?.trim() || f[13]!.trim() || defaultTerm;
    out.push({
      row, kind, debit: debit!, credit: credit!, vat, date,
      documentNumber: f[2]!.trim().slice(0, 50), documentTypeShortName: docShort, amount: amount.toFixed(2), vatTermId, vatAmount: vatAmount.toFixed(2),
      partner: {
        name: f[6]!.trim().slice(0, 255), contactName: f[7]!.trim().slice(0, 255), city: f[8]!.trim().slice(0, 50), address: f[9]!.trim().slice(0, 255),
        vatNumber: f[10]!.trim().slice(0, 50), bulstat: f[11]!.trim().slice(0, 50),
      },
      term: term.slice(0, 255), reference: f[14]!.trim().slice(0, 255),
    });
  }
  if (errors.length) throw new DataImportError(errors);
  return out;
}

export interface RefLine { ref: AccountRef; amount: string; vatTermId: number }

/**
 * Posting of one line (net = amount - vat): Dt account / Ct account3 for the
 * net amount; purchase VAT as Dt VAT-purchases / Ct account3; sales VAT as
 * Dt account / Ct VAT-sales. In editor shape this is 2-1 or 1-2.
 */
export function txtOperationLines(op: TxtOperation): { debits: RefLine[]; credits: RefLine[] } {
  const amount = dec(op.amount);
  const vat = dec(op.vatAmount);
  const net = amount.minus(vat);
  const t = op.vatTermId;
  if (vat.isZero() || !op.vat) {
    return { debits: [{ ref: op.debit, amount: amount.toFixed(2), vatTermId: t }], credits: [{ ref: op.credit, amount: amount.toFixed(2), vatTermId: t }] };
  }
  if (op.vat.side === 'debit') {
    return {
      debits: [{ ref: op.debit, amount: net.toFixed(2), vatTermId: t }, { ref: { category: op.vat.category }, amount: vat.toFixed(2), vatTermId: t }],
      credits: [{ ref: op.credit, amount: amount.toFixed(2), vatTermId: t }],
    };
  }
  return {
    debits: [{ ref: op.debit, amount: amount.toFixed(2), vatTermId: t }],
    credits: [{ ref: op.credit, amount: net.toFixed(2), vatTermId: t }, { ref: { category: op.vat.category }, amount: vat.toFixed(2), vatTermId: t }],
  };
}

/** Builds a text-import line (used by tests and by the XML/TXT round trips). */
export function formatTextImportLine(fields: (string | number)[]): string {
  const f = fields.map(String);
  while (f.length < 16) f.push('');
  return f.join('|');
}
