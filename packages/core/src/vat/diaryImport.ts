import { round2, ZERO, type Dec } from '../money.ts';
import { fmtMessage } from './constants.ts';
import { parseNapLine, type ParsedNapLine } from './nap.ts';

/**
 * VAT-diary import ("Импорт от ДДС Дневници", VATDiaryOperationsImportProvider,
 * spec 04a section 2): POKUPKI / PRODAGBI lines back to accountings.
 */

/** NAP document code -> document type id. Code 10 (VOP protocol) is skipped before the map. */
export const IMPORT_PURCHASE_DOC_CODES: Record<string, number> = { '01': 1, '02': 2, '03': 3, '07': 4, '09': 5, '10': 13, '11': 25, '12': 26, '13': 27 };
export const IMPORT_SALE_DOC_CODES: Record<string, number> = { ...IMPORT_PURCHASE_DOC_CODES, '81': 6, '82': 7 };

export interface ImportPosting {
  vatTermId: number;
  /** Net amount (tax base). */
  sum: Dec;
  vat: Dec;
}

export interface ImportedDocument {
  kind: 'purchase' | 'sale';
  lineNumber: number;
  line: ParsedNapLine;
  documentTypeId: number;
  postings: ImportPosting[];
}

export interface ImportParseResult {
  documents: ImportedDocument[];
  error: string | null;
}

/** Purchase line -> one accounting per VAT term (04a 2, purchase rules). */
export function purchasePostings(c: Dec[]): ImportPosting[] {
  const col = (i: number) => c[i] ?? ZERO;
  const out: ImportPosting[] = [];
  if (!col(0).isZero()) out.push({ vatTermId: 3, sum: round2(col(0)), vat: ZERO });
  if (!col(1).isZero()) out.push({ vatTermId: 2, sum: round2(col(1).plus(col(5)).plus(col(6))), vat: round2(col(2)) });
  if (!col(3).isZero()) out.push({ vatTermId: 4, sum: round2(col(3).plus(col(5)).plus(col(6))), vat: round2(col(4)) });
  if (!out.length) {
    out.push({
      vatTermId: !col(5).isZero() ? 5 : 6,
      sum: round2(col(0).plus(col(1)).plus(col(3)).plus(col(5)).plus(col(6))),
      vat: round2(col(2).plus(col(4))),
    });
  }
  return out;
}

/** Sale line -> one accounting; term from the first non-zero specific column (04a 2, sale rules). */
export function salePostings(c: Dec[]): ImportPosting[] {
  const col = (i: number) => c[i] ?? ZERO;
  const sumNet = round2(col(0).plus(col(13)).plus(col(14)).plus(col(15)).plus(col(16)));
  const rules: [number, number, number | null][] = [
    [2, 7, 3], [5, 9, 6], [8, 11, 9], [10, 12, null], [12, 14, null], [13, 15, null], [14, 16, null], [15, 17, null],
    [4, 8, 1], [11, 13, null], [16, 18, null],
  ];
  for (const [idx, term, vatIdx] of rules) {
    if (!col(idx).isZero()) return [{ vatTermId: term, sum: sumNet, vat: vatIdx == null ? ZERO : round2(col(vatIdx)) }];
  }
  return [{ vatTermId: 10, sum: sumNet, vat: round2(col(1)) }];
}

export function parseDiaryFile(text: string, kind: 'purchase' | 'sale', period: { from: string; to: string } = { from: '1900-01-01', to: '2100-01-01' }): ImportParseResult {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const documents: ImportedDocument[] = [];
  const map = kind === 'purchase' ? IMPORT_PURCHASE_DOC_CODES : IMPORT_SALE_DOC_CODES;
  for (const [i, raw] of lines.entries()) {
    if (!raw.trim()) continue;
    const lineNumber = i + 1;
    const parsed = parseNapLine(raw, kind === 'purchase' ? 7 : 17);
    if (!parsed) return { documents, error: fmtMessage('strInvalidDataFormatInRow', lineNumber) };
    if (parsed.documentCode === '10') continue;
    const documentTypeId = map[parsed.documentCode];
    if (documentTypeId === undefined) return { documents, error: fmtMessage('strInvalidDocumentTypeInImport', lineNumber, 4, parsed.documentCode) };
    if (parsed.documentDate < period.from || parsed.documentDate > period.to) continue;
    documents.push({ kind, lineNumber, line: parsed, documentTypeId, postings: kind === 'purchase' ? purchasePostings(parsed.cols) : salePostings(parsed.cols) });
  }
  return { documents, error: null };
}
