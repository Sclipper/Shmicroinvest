import { dec, ZERO, type Dec, type DecInput } from '../money.ts';
import { TRANSACTION_TYPE } from '../seeds/lookups.ts';
import { ICA_TYPE, INVOICE_DOC_TYPES, VAT_DOC } from './constants.ts';

/**
 * "Проверка за дублирани и липсващи документи" (AccountingsValidationService,
 * spec 04a 1.12, 05 7.7) and the check against a file from NAP.
 */

export interface DocCheckItem {
  accountingId: number;
  accountingNumber: string;
  documentTypeId: number;
  documentTypeName: string;
  documentNumber: string;
  documentDate: string;
  transactionTypeId: number;
  partnerId: number | null;
  partnerName: string;
  amount: DecInput;
  icaType: number;
}

export interface MissingDocument {
  channel: string;
  documentNumber: string;
}

export interface DuplicateGroup {
  channel: string;
  documentNumber: string;
  rows: DocCheckItem[];
}

export const MAX_MISSING_DOCUMENTS = 1000;
export const DOC_CHANNEL = {
  SaleInvoices: 'Фактури за продажба',
  PurchaseInvoices: 'Фактури за покупка',
  SaleProtocols: 'Протоколи за продажба',
  PurchaseProtocols: 'Протоколи за покупка',
  VatProtocols: 'Протоколи по ЗДДС',
  BreadFlourProtocols: 'Протоколи по ЗДДС - хляб и брашно',
} as const;

const numeric = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null);
const normalizeNumber = (s: string) => {
  const n = numeric(s);
  return n == null ? s.trim() : String(n);
};

function channelOf(i: DocCheckItem): string | null {
  if (i.documentTypeId === VAT_DOC.VatProtocol) {
    return i.icaType === ICA_TYPE.BreadFlourAcquisition || i.icaType === ICA_TYPE.BreadFlourDomestic ? DOC_CHANNEL.BreadFlourProtocols : DOC_CHANNEL.VatProtocols;
  }
  if (INVOICE_DOC_TYPES.has(i.documentTypeId)) {
    if (i.transactionTypeId === TRANSACTION_TYPE.Sale) return DOC_CHANNEL.SaleInvoices;
    if (i.transactionTypeId === TRANSACTION_TYPE.Purchase) return DOC_CHANNEL.PurchaseInvoices;
    return null;
  }
  if (i.documentTypeId === VAT_DOC.Protocol) {
    if (i.transactionTypeId === TRANSACTION_TYPE.Sale) return DOC_CHANNEL.SaleProtocols;
    if (i.transactionTypeId === TRANSACTION_TYPE.Purchase) return DOC_CHANNEL.PurchaseProtocols;
  }
  return null;
}

/** Gaps between consecutive numeric numbers (1 < diff < 1000) of sale invoices, sale protocols and VAT protocols. */
export function findMissingDocuments(items: DocCheckItem[]): MissingDocument[] {
  const channels = [DOC_CHANNEL.SaleInvoices, DOC_CHANNEL.SaleProtocols, DOC_CHANNEL.VatProtocols];
  const out: MissingDocument[] = [];
  for (const ch of channels) {
    const nums = [...new Set(items.filter((i) => channelOf(i) === ch).map((i) => numeric(i.documentNumber)).filter((n): n is number => n != null))].sort((a, b) => a - b);
    for (let k = 1; k < nums.length; k++) {
      const diff = nums[k]! - nums[k - 1]!;
      if (diff > 1 && diff < MAX_MISSING_DOCUMENTS) {
        for (let n = nums[k - 1]! + 1; n < nums[k]!; n++) {
          if (out.length >= MAX_MISSING_DOCUMENTS) return out;
          out.push({ channel: ch, documentNumber: String(n).padStart(10, '0') });
        }
      }
    }
  }
  return out;
}

/**
 * Duplicates: purchase invoices by (type, number, partner); sale invoices by
 * (type, number); protocols likewise; VAT protocols by number (bread/flour
 * separately). A non-VAT-registered company also checks NotSet protocols on
 * the purchase side.
 */
export function findDuplicateDocuments(items: DocCheckItem[], opts: { companyIsVat?: boolean } = {}): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  for (const i of items) {
    let ch = channelOf(i);
    if (!ch && opts.companyIsVat === false && i.documentTypeId === VAT_DOC.Protocol && i.transactionTypeId === TRANSACTION_TYPE.NotSet) ch = DOC_CHANNEL.PurchaseProtocols;
    if (!ch || !i.documentNumber.trim()) continue;
    const num = normalizeNumber(i.documentNumber);
    const withPartner = ch === DOC_CHANNEL.PurchaseInvoices || ch === DOC_CHANNEL.PurchaseProtocols;
    const byType = ch !== DOC_CHANNEL.VatProtocols && ch !== DOC_CHANNEL.BreadFlourProtocols;
    const key = [ch, byType ? i.documentTypeId : '', num, withPartner ? (i.partnerId ?? '') : ''].join('\u0001');
    const g = groups.get(key) ?? { channel: ch, documentNumber: i.documentNumber, rows: [] };
    g.rows.push(i);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.rows.length > 1);
}

// ---------------------------------------------------------------------------
// Check against a NAP file

export interface NapCheckRow {
  partnerId: string;
  partnerName: string;
  documentCode: string;
  documentNumber: string;
  documentDate: string;
  base: DecInput;
  vat: DecInput;
  source?: string;
}

export interface NapCheckResult {
  /** In the NAP file, not booked. */
  missing: NapCheckRow[];
  /** Booked, absent from the NAP file. */
  absent: NapCheckRow[];
  /** Same document, different amounts. */
  different: { file: NapCheckRow; booked: NapCheckRow }[];
}

const idKey = (s: string) => s.trim().toUpperCase().replace(/^BG/, '');
const rowKey = (r: NapCheckRow) => [idKey(r.partnerId), normalizeNumber(r.documentNumber), r.documentDate.slice(0, 10)].join('\u0001');

export function compareWithNapFile(fileRows: NapCheckRow[], booked: NapCheckRow[]): NapCheckResult {
  const sumBy = (rows: NapCheckRow[]) => {
    const m = new Map<string, { row: NapCheckRow; base: Dec; vat: Dec }>();
    for (const r of rows) {
      const k = rowKey(r);
      const cur = m.get(k) ?? { row: r, base: ZERO, vat: ZERO };
      cur.base = cur.base.plus(dec(r.base));
      cur.vat = cur.vat.plus(dec(r.vat));
      m.set(k, cur);
    }
    return m;
  };
  const f = sumBy(fileRows);
  const b = sumBy(booked);
  const out: NapCheckResult = { missing: [], absent: [], different: [] };
  for (const [k, v] of f) {
    const x = b.get(k);
    if (!x) out.missing.push({ ...v.row, base: v.base.toFixed(2), vat: v.vat.toFixed(2) });
    else if (!x.base.equals(v.base) || !x.vat.equals(v.vat)) out.different.push({ file: { ...v.row, base: v.base.toFixed(2), vat: v.vat.toFixed(2) }, booked: { ...x.row, base: x.base.toFixed(2), vat: x.vat.toFixed(2) } });
  }
  for (const [k, v] of b) if (!f.has(k)) out.absent.push({ ...v.row, base: v.base.toFixed(2), vat: v.vat.toFixed(2) });
  return out;
}
