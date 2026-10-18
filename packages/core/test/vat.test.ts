import { describe, expect, it } from 'vitest';
import {
  annualAdjustmentAmount, article73Ratio, article73Sums, calculateVatAmounts, compareWithNapFile, cutOrPadLeft, decodeCp1251, deklarCells, deklarLine,
  declarationFromSums, dec, diaryTotals, encodeCp1251, f2, findDuplicateDocuments, findMissingDocuments, napFileBytes, napLineToString,
  napPurchaseLines, napSaleLines, parseDiaryFile, parseNapLine, protocolTemplate, protocolVat, purchaseDiary, purchasePostings, saleDiary,
  salePostings, validateProtocol, validateVatEntry, vatClosingRows, vatDeclaration, viesFileLines, viesPart1, viesPart2, viesTotals, zipStore, crc32,
  type Dec, type VatAccounting, type VatDetail, type VatPartner,
} from '../src/index.ts';

// ---------------------------------------------------------------------------
// Fixture builder: compact accountings with legs.

type Kind = 'vp' | 'vs' | 'x' | 'none';
type LegSpec = [sign: 1 | -1, kind: Kind, term: number, amount: string | number, partner?: VatPartner | null];

let nextId = 1;
const SUPPLIER: VatPartner = { id: 1, name: 'Supplier Ltd', vatNumber: 'BG987654321', bulstat: '987654321' };
const CLIENT: VatPartner = { id: 2, name: 'Клиент ЕООД', vatNumber: 'BG831641791', bulstat: '831641791' };
const EU_A: VatPartner = { id: 3, name: 'Partner A GmbH', vatNumber: 'DE123456789', bulstat: null };
const EU_B: VatPartner = { id: 4, name: 'Partner B SRL', vatNumber: 'RO998877', bulstat: null };

function leg([sign, kind, term, amount, partner]: LegSpec): VatDetail {
  return {
    sign, vatTermId: term,
    amount: sign === 1 ? String(amount) : '0', refAmount: sign === -1 ? String(amount) : '0',
    accountId: kind === 'none' ? null : kind === 'vp' ? 16 : kind === 'vs' ? 17 : 99,
    accountNumber: kind === 'none' ? null : kind === 'vp' ? '453/1' : kind === 'vs' ? '453/2' : '602',
    isVatPurchase: kind === 'vp', isVatSale: kind === 'vs',
    partner: partner ?? null,
  };
}

const DOCS: Record<number, [string, string]> = {
  1: ['01', 'Ф-ра'], 2: ['02', 'ДИ'], 3: ['03', 'КИ'], 4: ['07', 'МД'], 5: ['09', 'Прот'], 10: ['00', 'МО'], 13: ['09', 'ПЗДДС'],
  25: ['11', 'Ф-ра(КО)'], 36: ['04', 'РСИЕС'], 37: ['05', 'РСПЕС'],
};

function acc(p: Partial<VatAccounting> & { legs: LegSpec[] }): VatAccounting {
  const id = p.id ?? nextId++;
  const doc = p.documentTypeId === undefined ? 1 : p.documentTypeId;
  const [code, short] = doc != null ? DOCS[doc]! : ['', ''];
  const date = p.accountingDate ?? '2026-06-10';
  return {
    id, number: p.number ?? String(1000 + id), financialYearId: p.financialYearId ?? 1,
    accountingDate: date, viesMonth: p.viesMonth ?? `${date.slice(0, 7)}-01`,
    transactionTypeId: p.transactionTypeId ?? 3, documentTypeId: doc, documentCode: p.documentCode ?? code, documentShortName: short,
    documentNumber: p.documentNumber ?? String(id).padStart(10, '0'), documentDate: p.documentDate ?? date, branchCode: p.branchCode ?? '0001',
    term: p.term ?? 'Основание', viesId: p.viesId ?? 1, icaType: p.icaType ?? 0, icaAccountingId: p.icaAccountingId ?? null,
    isInitialBalance: false, isInitialCorrespondence: false, extendedCodes: p.extendedCodes ?? [],
    details: p.legs.map(leg),
  };
}

/** A sale: Dt 411 (partner) total / Kt revenue base + Kt 453/2 VAT. */
function sale(base: number | string, vat: number | string, p: Partial<VatAccounting> & { term7?: number } = {}) {
  const t = p.term7 ?? 7;
  const total = dec(base).plus(dec(vat)).toFixed(2);
  return acc({ ...p, transactionTypeId: 3, legs: [[1, 'x', t, total, p.details ? null : CLIENT], [-1, 'x', t, base], ...(Number(vat) !== 0 ? [[-1, 'vs', t, vat] as LegSpec] : [])] });
}
function purchase(base: number | string, vat: number | string, term: number, p: Partial<VatAccounting> = {}) {
  const total = dec(base).plus(dec(vat)).toFixed(2);
  return acc({ ...p, transactionTypeId: 2, legs: [[1, 'x', term, base], ...(Number(vat) !== 0 ? [[1, 'vp', term, vat] as LegSpec] : []), [-1, 'x', term, total, SUPPLIER]] });
}

const s = (v: Dec | undefined) => (v ?? dec(0)).toFixed(2);
const col = (row: { cols: Dec[] }, c: number) => s(row.cols[c - 9]);

// ---------------------------------------------------------------------------

describe('cp1251 encoding (04a 1.4)', () => {
  it('encodes Cyrillic and specials to code page 1251, unknown as "?"', () => {
    expect([...encodeCp1251('Основание')]).toEqual([0xce, 0xf1, 0xed, 0xee, 0xe2, 0xe0, 0xed, 0xe8, 0xe5]);
    expect([...encodeCp1251('Ёё№„“€')]).toEqual([0xa8, 0xb8, 0xb9, 0x84, 0x93, 0x88]);
    expect([...encodeCp1251('A✓')]).toEqual([0x41, 0x3f]);
  });
  it('round-trips with the platform decoder', () => {
    const text = 'ДДС дневник на покупките №5 „Тест“ – АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯабвгдежзийклмнопрстуфхцчшщъьюя';
    const bytes = encodeCp1251(text);
    expect(new TextDecoder('windows-1251').decode(bytes)).toBe(text);
    expect(decodeCp1251(bytes)).toBe(text);
  });
  it('writes CRLF after every line including the last', () => {
    expect([...napFileBytes(['AB', 'Я'])]).toEqual([0x41, 0x42, 0x0d, 0x0a, 0xdf, 0x0d, 0x0a]);
  });
});

describe('number formatting (04a 1.4)', () => {
  it('F2 rounds away from zero with a dot', () => {
    expect(f2('127.9972')).toBe('128.00');
    expect(f2('0.0072')).toBe('0.01');
    expect(f2('-123.455')).toBe('-123.46');
    expect(f2('-0.001')).toBe('0.00');
    expect(f2('1234567.5')).toBe('1234567.50');
  });
  it('a 16-digit amount right-aligned in 15 characters keeps its first 15 characters', () => {
    expect(cutOrPadLeft('1234567890123.45', 15)).toBe('1234567890123.4');
    expect(cutOrPadLeft('12.50', 15)).toBe('          12.50');
  });
});

describe('NAP diary records (04a 1.13 worked examples)', () => {
  const opts = { start: '2025-03-01', end: '2025-03-31', ownVatId: 'BG123456789' };
  const p = acc({
    transactionTypeId: 2, accountingDate: '2025-03-12', documentNumber: '0000000123', documentDate: '2025-03-12', branchCode: '0001', term: 'Основание',
    legs: [[1, 'x', 2, '1000.00'], [1, 'vp', 2, '200.00'], [-1, 'x', 2, '1200.00', SUPPLIER]],
  });
  const sl = acc({
    transactionTypeId: 3, accountingDate: '2025-03-15', documentNumber: '0000000001', documentDate: '2025-03-15', branchCode: '0001', term: 'Продажба',
    legs: [[1, 'x', 7, '600.00', CLIENT], [-1, 'x', 7, '500.00'], [-1, 'vs', 7, '100.00']],
  });
  const all = [p, sl];

  it('purchase row: 274 characters with idx1 1000.00 and idx2 200.00', () => {
    const [line] = napPurchaseLines(all, opts);
    const text = napLineToString(line!);
    const expected =
      'BG123456789    ' + '202503' + '0001' + '              1' + '01' + '0000000123          ' + '12/03/2025' + 'BG987654321    '
      + 'Supplier Ltd' + ' '.repeat(38) + 'Основание' + ' '.repeat(21)
      + '           0.00' + '        1000.00' + '         200.00' + '           0.00' + '           0.00' + '           0.00' + '           0.00'
      + '  ';
    expect(text).toBe(expected);
    expect(text.length).toBe(274);
  });

  it('sale row: 424 characters, idx0 500, idx1 100, idx2 500, idx3 100', () => {
    const [line] = napSaleLines(all, opts);
    const text = napLineToString(line!);
    expect(text.length).toBe(424);
    const amount = (i: number) => text.slice(167 + i * 15, 182 + i * 15);
    expect([amount(0), amount(1), amount(2), amount(3), amount(4)]).toEqual(['         500.00', '         100.00', '         500.00', '         100.00', '           0.00']);
    expect(text.slice(72, 87)).toBe('BG831641791    ');
    expect(text.slice(422)).toBe('  ');
  });

  it('declaration row from the two lines: 590 characters and the documented cells', () => {
    const saleLines = napSaleLines(all, opts);
    const purchaseLines = napPurchaseLines(all, opts);
    const input = { ownVatId: 'BG123456789', companyName: 'Тест ООД', periodEnd: '2025-03-31', subscriberEgn: '8001010000', subscriberName: 'Иван Иванов', saleLines, purchaseLines, kl33: 0 };
    const c = deklarCells(input).cells;
    expect(Object.fromEntries(['01', '20', '11', '21', '30', '31', '41', '40', '50', '60'].map((k) => [k, s(c[k])]))).toEqual({
      '01': '500.00', '20': '100.00', '11': '500.00', '21': '100.00', '30': '0.00', '31': '1000.00', '41': '200.00', '40': '200.00', '50': '0.00', '60': '100.00',
    });
    const line = deklarLine(input);
    expect(line.length).toBe(590);
    expect(line.slice(0, 15)).toBe('BG123456789    ');
    expect(line.slice(65, 71)).toBe('202503');
    expect(line.slice(71, 121)).toBe('8001010000/Иван Иванов'.padEnd(50));
    expect(line.slice(121, 136)).toBe('              1');
    expect(line.slice(136, 151)).toBe('              1');
    expect(line.slice(151, 166)).toBe('         500.00'); // 01
    expect(line.slice(166, 181)).toBe('         100.00'); // 20
    expect(line.slice(391, 406)).toBe('        1000.00'); // 31
    expect(line.slice(406, 421)).toBe('         200.00'); // 41
    expect(line.slice(466, 470)).toBe('0.00'); // 33
    expect(line.slice(470, 485)).toBe('         200.00'); // 40
    expect(line.slice(485, 500)).toBe('           0.00'); // 50
    expect(line.slice(500, 515)).toBe('         100.00'); // 60
  });

  it('purchase with term 4 puts VAT in index 4 (diary column 13) and cell 42', () => {
    const t4 = purchase(1000, 200, 4, { accountingDate: '2025-03-05' });
    const [line] = napPurchaseLines([t4], opts);
    expect(s(line!.cols[4])).toBe('200.00');
    expect(s(line!.cols[3])).toBe('1000.00');
    expect(s(deklarCells({ ownVatId: '', companyName: '', periodEnd: '2025-03-31', subscriberEgn: '', subscriberName: '', saleLines: [], purchaseLines: [line!], kl33: '0.5' }).cells['42'])).toBe('200.00');
  });

  it('cash-accounting sale: in the diary amounts, not in DEKLAR cells 01-24', () => {
    const ko = sale(100, 20, { documentTypeId: 25, accountingDate: '2025-03-20' });
    const lines = napSaleLines([ko], opts);
    expect(s(lines[0]!.cols[2])).toBe('100.00');
    const c = deklarCells({ ownVatId: '', companyName: '', periodEnd: '2025-03-31', subscriberEgn: '', subscriberName: '', saleLines: lines, purchaseLines: [], kl33: 0 }).cells;
    expect(s(c['01'])).toBe('0.00');
    expect(s(c['21'])).toBe('0.00');
  });

  it('groups by document and orders by date then number as a string ("10" before "9")', () => {
    const a = sale(10, 2, { documentNumber: '9', accountingDate: '2025-03-02' });
    const b = sale(10, 2, { documentNumber: '10', accountingDate: '2025-03-02' });
    const c = sale(10, 2, { documentNumber: '5', accountingDate: '2025-03-01' });
    const lines = napSaleLines([a, b, c], opts);
    expect(lines.map((l) => [l.rowNumber, l.documentNumber])).toEqual([[1, '5'], [2, '10'], [3, '9']]);
  });

  it('parses its own records back (FromString)', () => {
    const [line] = napPurchaseLines(all, opts);
    const parsed = parseNapLine(napLineToString(line!), 7)!;
    expect(parsed).toMatchObject({ ownVatId: 'BG123456789', period: '202503', branchCode: '0001', rowNumber: 1, documentCode: '01', documentNumber: '0000000123', documentDate: '2025-03-12', partnerVat: 'BG987654321', partnerName: 'Supplier Ltd', description: 'Основание', protocolCode: '' });
    expect(parsed.cols.map((c) => c.toFixed(2))).toEqual(['0.00', '1000.00', '200.00', '0.00', '0.00', '0.00', '0.00']);
    expect(parseNapLine('garbage', 7)).toBeNull();
  });

  it('euro: period ending 2026-01-31, accounting dated 2025-12-30 is converted per detail; 2026-01-05 unchanged', () => {
    const o = { start: '2026-01-01', end: '2026-01-31', ownVatId: 'BG123456789' };
    const old = purchase('1000.00', '200.00', 2, { accountingDate: '2025-12-30', viesMonth: '2026-01-01' });
    const recent = purchase('1000.00', '200.00', 2, { accountingDate: '2026-01-05' });
    const lines = napPurchaseLines([old, recent], o);
    const byDate = Object.fromEntries(lines.map((l) => [l.documentDate, l]));
    expect(s(byDate['2025-12-30']!.cols[1])).toBe('511.29'); // 1000 / 1.95583 = 511.2918...
    expect(s(byDate['2025-12-30']!.cols[2])).toBe('102.26'); // 200 / 1.95583 = 102.2584...
    expect(s(byDate['2026-01-05']!.cols[1])).toBe('1000.00');
  });

  it('call-off codes: 51-58 fill only column 9 and RSPESCol9 (removed from DEKLAR 30); 41-48 lines are all zeros', () => {
    const o = { start: '2026-06-01', end: '2026-06-30', ownVatId: 'BG1' };
    const proto51 = acc({ number: 'X1', documentTypeId: 13, transactionTypeId: 2, extendedCodes: ['51'], legs: [] });
    const reg = acc({ number: 'X1', documentTypeId: 37, transactionTypeId: 2, icaAccountingId: proto51.id, legs: [[1, 'x', 3, '300.00'], [-1, 'x', 3, '300.00', SUPPLIER]] });
    const proto41 = acc({ number: 'X2', documentTypeId: 13, transactionTypeId: 2, extendedCodes: ['41'], legs: [] });
    const inv = acc({ number: 'X2', documentTypeId: 1, transactionTypeId: 2, icaAccountingId: proto41.id, legs: [[1, 'x', 2, '100.00'], [-1, 'x', 2, '100.00', SUPPLIER]] });
    const lines = napPurchaseLines([proto51, reg, proto41, inv], o);
    const regLine = lines.find((l) => l.documentCode === '05')!;
    expect(s(regLine.cols[0])).toBe('300.00');
    expect(s(regLine.rspesCol9)).toBe('300.00');
    expect(regLine.protocolCode).toBe('51');
    const invLine = lines.find((l) => l.documentCode === '01')!;
    expect(invLine.cols.every((c) => c.isZero())).toBe(true);
    const c = deklarCells({ ownVatId: '', companyName: '', periodEnd: '2026-06-30', subscriberEgn: '', subscriberName: '', saleLines: [], purchaseLines: lines, kl33: 0 }).cells;
    expect(s(c['30'])).toBe('0.00');
  });
});

describe('sales and purchase diaries (fnSaleDiaryReport / fnPurchaseDiaryReport)', () => {
  it('sale term 7 base 100 VAT 20: col11=100, col12=20, col9=100, col10=20', () => {
    const a = sale(100, 20, { accountingDate: '2026-06-15', viesMonth: '2026-06-01' });
    const rows = saleDiary([a], { start: '2026-06-01', end: '2026-07-01', addCashDocs: true });
    expect(rows).toHaveLength(1);
    expect([col(rows[0]!, 11), col(rows[0]!, 12), col(rows[0]!, 9), col(rows[0]!, 10)]).toEqual(['100.00', '20.00', '100.00', '20.00']);
    expect(rows[0]!.partnerVat).toBe('BG831641791');
    // Screen period June 1..June 30 (end 23:59:59) still includes it.
    expect(saleDiary([a], { start: '2026-06-01', end: '2026-06-30 23:59:59', addCashDocs: true })).toHaveLength(1);
  });

  it('end is exclusive for sales and inclusive for purchases', () => {
    const s1 = sale(100, 20, { accountingDate: '2026-07-01', viesMonth: '2026-07-01' });
    const p1 = purchase(100, 20, 2, { accountingDate: '2026-07-01', viesMonth: '2026-07-01' });
    expect(saleDiary([s1, p1], { start: '2026-06-01', end: '2026-07-01', addCashDocs: true })).toHaveLength(0);
    expect(purchaseDiary([s1, p1], { start: '2026-06-01', end: '2026-07-01', addCashDocs: true })).toHaveLength(1);
  });

  it('cash-accounting documents: excluded from the declaration, included in the interactive diary', () => {
    const ko = sale(100, 20, { documentTypeId: 25 });
    const rows = saleDiary([ko], { start: '2026-06-01', end: '2026-06-30 23:59:59', addCashDocs: true });
    expect(col(rows[0]!, 11)).toBe('100.00');
    const decl = vatDeclaration([ko], { start: '2026-06-01', end: '2026-06-30 23:59:59' });
    expect(s(decl.cells['11'])).toBe('0.00');
    expect(s(decl.cells['21'])).toBe('0.00');
    const kop = purchase(100, 20, 2, { documentTypeId: 25 });
    expect(col(purchaseDiary([kop], { start: '2026-06-01', end: '2026-06-30', addCashDocs: true })[0]!, 10)).toBe('100.00');
    expect(s(vatDeclaration([kop], { start: '2026-06-01', end: '2026-06-30' }).cells['31'])).toBe('0.00');
  });

  it('РСПЕС purchase: all legs in P9 and removed from cell 30', () => {
    const r = acc({ documentTypeId: 37, transactionTypeId: 2, legs: [[1, 'x', 2, '300.00'], [1, 'vp', 2, '60.00'], [-1, 'x', 2, '360.00', SUPPLIER]] });
    const rows = purchaseDiary([r], { start: '2026-06-01', end: '2026-06-30', addCashDocs: true });
    expect(col(rows[0]!, 9)).toBe('360.00');
    const d = vatDeclaration([r], { start: '2026-06-01', end: '2026-06-30' });
    expect(s(d.cells['30'])).toBe('0.00');
  });

  it('credit note -100/-20 reduces the diary columns', () => {
    const a = sale(1000, 200);
    const cn = sale(-100, -20, { documentTypeId: 3 });
    const rows = saleDiary([a, cn], { start: '2026-06-01', end: '2026-06-30 23:59:59', addCashDocs: true });
    const t = diaryTotals(rows, 17);
    expect([s(t[11 - 9]), s(t[12 - 9])]).toEqual(['900.00', '180.00']);
  });

  it('euro: entry dated 2025-12 in a period ending 2026-01-31 is divided by 1.95583 and rounded', () => {
    const a = sale('1000.00', '200.00', { accountingDate: '2025-12-20', viesMonth: '2026-01-01' });
    const rows = saleDiary([a], { start: '2026-01-01', end: '2026-01-31 23:59:59', addCashDocs: true });
    expect([col(rows[0]!, 11), col(rows[0]!, 12)]).toEqual(['511.29', '102.26']);
    const leva = saleDiary([{ ...a, viesMonth: '2025-12-01' }], { start: '2025-12-01', end: '2025-12-31 23:59:59', addCashDocs: true });
    expect(col(leva[0]!, 11)).toBe('1000.00');
  });

  it('terms 15..18 stay out of the generic columns 9/10 and land in 22..25', () => {
    const rows = saleDiary([
      acc({ legs: [[1, 'x', 15, 50, CLIENT], [-1, 'x', 15, 50]] }),
      acc({ legs: [[1, 'x', 18, 70, CLIENT], [-1, 'x', 18, 70]] }),
      acc({ legs: [[1, 'x', 13, 30, CLIENT], [-1, 'x', 13, 30]] }),
    ], { start: '2026-06-01', end: '2026-06-30 23:59:59', addCashDocs: true });
    const t = diaryTotals(rows, 17);
    expect([s(t[0]), s(t[22 - 9]), s(t[25 - 9]), s(t[20 - 9])]).toEqual(['30.00', '50.00', '70.00', '30.00']);
  });
});

describe('VAT declaration cells (spVATDeclarationReport)', () => {
  const S = (o: Record<number, number | string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [Number(k), dec(v)]));
  it('cell 01 = S11+S13+S14+S17+S19+S20+S21; cell 12 = S13+S14', () => {
    const c = declarationFromSums(S({ 11: 1000, 13: 500 }), {});
    expect([s(c['01']), s(c['12'])]).toEqual(['1500.00', '500.00']);
  });
  it('P11=200, P13=100, KL33=0.8, sales tax 300: 40 = 280, 50 = 20, 60 = 0', () => {
    const c = declarationFromSums(S({ 12: 300 }), S({ 11: 200, 13: 100 }), { kl33: '0.8' });
    expect([s(c['40']), s(c['50']), s(c['60'])]).toEqual(['280.00', '20.00', '0.00']);
  });
  it('sales tax 100 and the same purchases: 50 = 0, 60 = 180', () => {
    const c = declarationFromSums(S({ 12: 100 }), S({ 11: 200, 13: 100 }), { kl33: '0.8' });
    expect([s(c['50']), s(c['60'])]).toEqual(['0.00', '180.00']);
  });
  it('rounding case: P13 x KL33 = 27.9972 keeps 40 unrounded, 50 uses the rounded credit', () => {
    const P = S({ 11: 100, 13: '33.33' });
    const c1 = declarationFromSums(S({ 12: 128 }), P, { kl33: '0.84' });
    expect(c1['40'].toString()).toBe('127.9972');
    expect([s(c1['50']), c1['60'].toString()]).toEqual(['0.00', '0']);
    const c2 = declarationFromSums(S({ 12: '127.99' }), P, { kl33: '0.84' });
    expect(c2['60'].toString()).toBe('0.0072');
    expect(s(c2['50'])).toBe('0.00');
  });
  it('cell 71 auto-fill clamps at zero in the report; DEKLAR may be negative', () => {
    const c = declarationFromSums(S({ 12: 100 }), S({ 11: 20 }), { kl70: 100, autoFillCell71: true });
    expect(s(c['71'])).toBe('0.00');
    const c2 = declarationFromSums(S({ 12: 100 }), S({ 11: 20 }), { kl70: 30, autoFillCell71: true });
    expect(s(c2['71'])).toBe('50.00');
  });
  it('18 = S23 + S25, 30 = P9 + P15, 20 = S12+S15+S16+S18', () => {
    const c = declarationFromSums(S({ 23: 10, 25: 5, 12: 1, 15: 2, 16: 3, 18: 4 }), S({ 9: 7, 15: 8 }));
    expect([s(c['18']), s(c['30']), s(c['20'])]).toEqual(['15.00', '15.00', '10.00']);
  });
});

describe('protocols (02b 19 worked examples, base 1000, VAT 200)', () => {
  const period = { start: '2026-06-01', end: '2026-06-30 23:59:59', addCashDocs: true };
  /** Main invoice + protocol accounting with the generated rows. */
  function vop(purchaseTerm: number, saleTerm: number, opts: { expense?: boolean } = {}) {
    const main = acc({ number: '777', transactionTypeId: 2, documentTypeId: 1, legs: [[1, 'x', 1, 1000], [-1, 'x', 1, 1000, SUPPLIER]] });
    const proto = acc({
      number: '777', transactionTypeId: 2, documentTypeId: 13, documentNumber: '0000000001', icaType: 1,
      legs: [[1, opts.expense ? 'x' : 'vp', purchaseTerm, 200, SUPPLIER], [-1, 'vs', saleTerm, 200, SUPPLIER], [1, 'none', purchaseTerm, 1000, SUPPLIER], [-1, 'none', saleTerm, 1000, SUPPLIER]],
    });
    main.icaAccountingId = proto.id;
    return [main, proto];
  }
  it('A: ВОП full credit: P10=1000, P11=200, S13=1000, S15=200, S9=1000, S10=200; cells 12/22/31/41', () => {
    const list = vop(2, 8);
    const p = purchaseDiary(list, period);
    // The main invoice (term 1) is listed with zero amounts, the protocol carries the self-assessed VAT.
    const inv = p.find((r) => r.documentCode === '01')!;
    const prot = p.find((r) => r.documentCode === '09')!;
    expect(p).toHaveLength(2);
    expect(inv.cols.every((c) => c.isZero())).toBe(true);
    expect([col(prot, 10), col(prot, 11)]).toEqual(['1000.00', '200.00']);
    const sd = saleDiary(list, period);
    expect([col(sd[0]!, 13), col(sd[0]!, 15), col(sd[0]!, 9), col(sd[0]!, 10)]).toEqual(['1000.00', '200.00', '1000.00', '200.00']);
    const d = vatDeclaration(list, period).cells;
    expect([s(d['12']), s(d['22']), s(d['31']), s(d['41']), s(d['50']), s(d['60'])]).toEqual(['1000.00', '200.00', '1000.00', '200.00', '0.00', '0.00']);
  });
  it('B: partial credit (term 4) with KL33 0.80: cells 32/42 and 40 = 160', () => {
    const d = vatDeclaration(vop(4, 8), period, { kl33: '0.80' }).cells;
    expect([s(d['32']), s(d['42']), s(d['33']), s(d['40']), s(d['22'])]).toEqual(['1000.00', '200.00', '0.80', '160.00', '200.00']);
  });
  it('C: no credit (term 3) with expense account 609: P9 = 1200, S13 = 1000, S15 = 200, cell 30 = 1200', () => {
    const list = vop(3, 8, { expense: true });
    expect(col(purchaseDiary(list, period).find((r) => r.documentCode === '09')!, 9)).toBe('1200.00');
    const sd = saleDiary(list, period)[0]!;
    expect([col(sd, 13), col(sd, 15)]).toEqual(['1000.00', '200.00']);
    expect(s(vatDeclaration(list, period).cells['30'])).toBe('1200.00');
  });
  it('D: service from the EU (sale term 9): S14 = 1000, S15 = 200; cells 12 and 22', () => {
    const list = vop(2, 9);
    const sd = saleDiary(list, period)[0]!;
    expect([col(sd, 14), col(sd, 15)]).toEqual(['1000.00', '200.00']);
    const d = vatDeclaration(list, period).cells;
    expect([s(d['12']), s(d['22'])]).toEqual(['1000.00', '200.00']);
  });
  it('protocol in the sales diary takes the ViesMonth of the original accounting', () => {
    const [main, proto] = vop(2, 8);
    main!.viesMonth = '2026-05-01';
    proto!.viesMonth = '2026-06-01';
    expect(saleDiary([main!, proto!], period)).toHaveLength(0);
    expect(saleDiary([main!, proto!], { ...period, start: '2026-05-01' })).toHaveLength(1);
  });
  it('NAP lines carry the protocol and its terms the same way', () => {
    const list = vop(2, 8);
    const o = { start: '2026-06-01', end: '2026-06-30', ownVatId: 'BG1' };
    const p = napPurchaseLines(list, o).find((l) => l.documentCode === '09')!;
    expect([s(p.cols[1]), s(p.cols[2])]).toEqual(['1000.00', '200.00']);
    const sl = napSaleLines(list, o)[0]!;
    expect([s(sl.cols[4]), s(sl.cols[6])]).toEqual(['1000.00', '200.00']);
  });
  it('templates: term pairs per type', () => {
    expect([protocolTemplate(1, 4).purchaseTermId, protocolTemplate(1, 4).saleTermId]).toEqual([4, 8]);
    expect([protocolTemplate(2, 2).saleTermId, protocolTemplate(7, 3).saleTermId]).toEqual([9, 9]);
    expect(protocolTemplate(5, null)).toMatchObject({ purchaseTermId: 2, saleTermId: 7, vatPair: true, basePair: true, defaultCode: '03' });
    expect(protocolTemplate(6, null)).toMatchObject({ purchaseTermId: 12, saleTermId: 9, vatPair: false });
    expect(protocolTemplate(3, null)).toMatchObject({ transactionTypeId: 3, basePair: false, purchaseTermId: 2, saleTermId: 8 });
    expect(protocolTemplate(4, null)).toMatchObject({ vatPair: false, codes: ['01', '02'] });
    expect(protocolVat('1000')).toEqual(dec('200'));
    expect(protocolVat('0.025').toFixed(2)).toBe('0.01');
  });
  it('validations: missing term, document number, expense account, 163a 20% warning, VIES code mismatch', () => {
    const keys = (r: ReturnType<typeof validateProtocol>) => [...r.messages, ...r.confirm].map((m) => `${m.key}:${m.severity}`);
    expect(keys(validateProtocol({ icaType: 1, purchaseTermId: null, documentNumber: '', base: 1000, vat: 200 }))).toEqual(['strMissingTerm:critical', 'strMissingDocumentNumber:critical']);
    expect(keys(validateProtocol({ icaType: 1, purchaseTermId: 3, documentNumber: '1', base: 1000, vat: 200, expenseAccount: null }))).toEqual(['strMissingCreditAccount:critical']);
    expect(keys(validateProtocol({ icaType: 1, purchaseTermId: 3, documentNumber: '1', base: 1000, vat: 200, expenseAccount: { id: 1, isLeaf: false } }))).toEqual(['strICACreditAccountHasSubAccounts:critical']);
    expect(keys(validateProtocol({ icaType: 4, purchaseTermId: null, documentNumber: '1', base: 1000, vat: 190 }))).toEqual(['strInvalidICAVatAmount:warning']);
    expect(keys(validateProtocol({ icaType: 9, purchaseTermId: 2, documentNumber: '', base: 0, vat: 0 }))).toEqual([]);
    expect(keys(validateProtocol({ icaType: 6, purchaseTermId: null, documentNumber: '1', base: 0, vat: 0, vatDiaryCode: '41', mainViesId: 6 }))).toEqual(['strIncorrectViesOperation:warning']);
    expect(keys(validateProtocol({ icaType: 6, purchaseTermId: null, documentNumber: '1', base: 0, vat: 0, vatDiaryCode: '46', mainViesId: 6 }))).toEqual([]);
  });
});

describe('VAT closing (02b 9, 20)', () => {
  const rows = (P: number, S: number, o: { R?: number; include?: boolean; alt?: boolean } = {}) =>
    vatClosingRows({ purchases: P, sales: S, refund: o.R, includeRefund: o.include, alternative: o.alt }).map((r) => `Kt ${r.credit} / Dt ${r.debit} ${r.amount.toFixed(2)}`);
  it('payable: P=100, S=300', () => expect(rows(100, 300)).toEqual(['Kt purchases / Dt sales 100.00', 'Kt payable / Dt sales 200.00']));
  it('refundable: P=300, S=100', () => expect(rows(300, 100)).toEqual(['Kt purchases / Dt sales 100.00', 'Kt purchases / Dt refund 200.00']));
  it('only sales / only purchases', () => {
    expect(rows(0, 300)).toEqual(['Kt payable / Dt sales 300.00']);
    expect(rows(300, 0)).toEqual(['Kt purchases / Dt refund 300.00']);
  });
  it('P=100, S=300, R=50 with refund: 100 / 50 / 150; R=500: 100 / 200', () => {
    expect(rows(100, 300, { R: 50, include: true })).toEqual(['Kt purchases / Dt sales 100.00', 'Kt refund / Dt sales 50.00', 'Kt payable / Dt sales 150.00']);
    expect(rows(100, 300, { R: 500, include: true })).toEqual(['Kt purchases / Dt sales 100.00', 'Kt refund / Dt sales 200.00']);
  });
  it('carry-forward P=50, S=400, R=200: 50 / 200 / 150; P=50, S=100, R=200: 50 / 50', () => {
    expect(rows(50, 400, { R: 200, include: true })).toEqual(['Kt purchases / Dt sales 50.00', 'Kt refund / Dt sales 200.00', 'Kt payable / Dt sales 150.00']);
    expect(rows(50, 100, { R: 200, include: true })).toEqual(['Kt purchases / Dt sales 50.00', 'Kt refund / Dt sales 50.00']);
  });
  it('without the refund tick R is untouched', () => expect(rows(50, 400, { R: 200 })).toEqual(['Kt purchases / Dt sales 50.00', 'Kt payable / Dt sales 350.00']));
  it('negative turnover: no rows', () => {
    expect(rows(-1, 300)).toEqual([]);
    expect(rows(100, -5)).toEqual([]);
  });
  it('alternative variant table (bug-compatible |P-S|)', () => {
    expect(rows(100, 300, { alt: true })).toEqual(['Kt purchases / Dt refund 100.00', 'Kt payable / Dt sales 300.00', 'Kt refund / Dt payable 200.00']);
    expect(rows(300, 100, { alt: true })).toEqual(['Kt purchases / Dt refund 300.00', 'Kt payable / Dt sales 100.00', 'Kt refund / Dt payable 200.00']);
    expect(rows(200, 200, { alt: true })).toEqual(['Kt purchases / Dt refund 200.00', 'Kt payable / Dt sales 200.00']);
    expect(rows(100, 0, { alt: true })).toEqual(['Kt purchases / Dt refund 100.00']);
  });
});

describe('article 73 (02b 21)', () => {
  const cases: [number, number, number, number, string, string][] = [
    [60000, 100000, 0, 0, '0.60', '0.60'],
    [83333, 100000, 0, 0, '0.84', '0.83'],
    [83500, 100000, 0, 0, '0.84', '0.84'],
    [1, 1000, 0, 0, '0.01', '0.00'],
    [500, 1000, 100, 0, '0.60', '0.60'],
    [0, 0, 0, 0, '0.00', '0.00'],
  ];
  for (const [n, d, dn, dd, ratio, plain] of cases) {
    it(`N=${n} D=${d} dN=${dn}: ratio ${ratio}, plain ${plain}`, () => {
      const r = article73Ratio(n, d, dn, dd);
      expect([r.ratio.toFixed(2), r.plain.toFixed(2)]).toEqual([ratio, plain]);
    });
  }
  it('annual adjustment: 10 000 x 0.84 - 10 000 x 0.80 = 400; decreasing ratio gives -400', () => {
    expect(annualAdjustmentAmount(10000, '0.80', '0.84').toFixed(2)).toBe('400.00');
    expect(annualAdjustmentAmount(10000, '0.80', '0.76').toFixed(2)).toBe('-400.00');
  });
  it('N and D from sale legs, excluding legs against the VAT-sales account', () => {
    const mk = (term: number, base: number) => {
      const a = sale(base, base / 5, { term7: term });
      a.details[0]!.refAccountCategoryId = 25;
      a.details.push({ ...a.details[0]!, amount: String(base / 5), refAccountCategoryId: 17 });
      a.details[0]!.amount = String(base);
      return a;
    };
    const r = article73Sums([mk(7, 600), mk(12, 400)], '2026-01-01', '2026-12-31');
    expect([r.numerator.toFixed(2), r.denominator.toFixed(2)]).toEqual(['600.00', '1000.00']);
  });
});

describe('calculate VAT (02b 1.5, F8)', () => {
  it('debit lines 100 and 50 with term 2 and an empty 453/1 line: 30.00', () => {
    const r = calculateVatAmounts([
      { amount: 100, vatTermId: 2, isVat: false },
      { amount: 50, vatTermId: null, isVat: false },
      { amount: 0, vatTermId: 2, isVat: true },
    ], 2, (t) => (t === 2 ? 20 : 0));
    expect(r.map((x) => x?.toFixed(2) ?? null)).toEqual([null, null, '30.00']);
  });
  it('uses the rate of the VAT line term and rounds away from zero', () => {
    const r = calculateVatAmounts([{ amount: '10.05', vatTermId: 11, isVat: false }, { amount: 0, vatTermId: 11, isVat: true }], null, () => 9);
    expect(r[1]!.toFixed(2)).toBe('0.90'); // 0.9045
  });
});

describe('entry VAT checks (02b 12, 22)', () => {
  const base = { transactionTypeId: 2, documentTypeId: 1, documentDate: '2025-06-10', viesMonth: '2025-06-01', debitTotal: 100, lineTerms: [2], hasVatPurchaseAccount: true, hasVatSaleAccount: true };
  const keys = (r: ReturnType<typeof validateVatEntry>) => [...r.messages.map((m) => `${m.key}:${m.severity}`), ...r.confirm.map((m) => `${m.key}:confirm`)];
  it('ViesMonth before the document month asks', () => {
    expect(keys(validateVatEntry({ ...base, viesMonth: '2025-03-01' }))).toEqual(['strAskIfViesMonthIsBeforeDocumentDate:confirm']);
  });
  it('more than 13 months asks unless term 3', () => {
    expect(keys(validateVatEntry({ ...base, documentDate: '2025-01-15', viesMonth: '2026-04-01' }))).toEqual(['strViesMonthAfterTaxCredit:confirm']);
    expect(keys(validateVatEntry({ ...base, documentDate: '2025-01-15', viesMonth: '2026-03-01' }))).toEqual(['strViesMonthAfterTaxCredit:confirm']);
    expect(keys(validateVatEntry({ ...base, documentDate: '2025-01-15', viesMonth: '2026-04-01', lineTerms: [3] }))).toEqual([]);
  });
  it('credit note with a non-negative sum asks', () => {
    expect(keys(validateVatEntry({ ...base, documentTypeId: 3 }))).toEqual(['strCreditNoteAmountConfirmation:confirm']);
    expect(keys(validateVatEntry({ ...base, documentTypeId: 3, debitTotal: -10 }))).toEqual([]);
  });
  it('РСИЕС must be a sale, РСПЕС a purchase; missing VAT accounts block', () => {
    expect(keys(validateVatEntry({ ...base, documentTypeId: 36 }))).toEqual(['strDocumentWithSaleAttention:critical']);
    expect(keys(validateVatEntry({ ...base, transactionTypeId: 3, documentTypeId: 37 }))).toEqual(['strDocumentWithPurchaseAttention:critical']);
    expect(keys(validateVatEntry({ ...base, hasVatPurchaseAccount: false }))).toEqual(['strVatPurchasesAccountNotDefined:critical']);
    expect(keys(validateVatEntry({ ...base, transactionTypeId: 3, hasVatSaleAccount: false }))).toEqual(['strVatSalesAccountNotDefined:critical']);
  });
  it('duplicate document asks', () => {
    expect(keys(validateVatEntry({ ...base, duplicateExists: true }))).toEqual(['strDuplicatedDocumentWarning:confirm']);
  });
});

describe('VIES (02b 10, 04a 1.10)', () => {
  const p = { start: '2026-06-01', end: '2026-06-30' };
  const vod = (partner: VatPartner, amount: number, viesId: number, extra: Partial<VatAccounting> = {}) =>
    acc({ ...extra, viesId, legs: [[1, 'x', viesId === 2 ? 13 : viesId === 4 ? 15 : 18, amount, partner], [-1, 'x', 13, amount]] });
  const info = {
    periodEnd: '2026-06-30', ownVatId: 'BG123456789', companyName: 'Тест ООД', companyAddress: 'ул. Главна 1',
    subscriber: { egn: '8001010000', name: 'Иван Иванов', city: 'София', postalCode: '1000', address: 'ул. Главна 1', isProcurator: false },
  };
  it('partner A 1200 (VIES 2) and 300 (VIES 4): TTR 1500.00 / 1200.00, one VIR 1200.00, 0.00, 300.00', () => {
    const list = [vod(EU_A, 1200, 2), vod(EU_A, 300, 4)];
    const lines = viesFileLines(list, p, info);
    expect(lines[0]).toBe('VHR06/2026    1');
    expect(lines[1]).toBe('VDR' + '8001010000'.padEnd(15) + 'Иван Иванов'.padEnd(150) + 'София'.padEnd(50) + '1000' + 'ул. Главна 1'.padEnd(150) + 'R');
    expect(lines[2]).toBe('VTR' + 'BG123456789'.padEnd(15) + 'Тест ООД'.padEnd(150) + 'ул. Главна 1'.padEnd(200));
    expect(lines[3]).toBe('TTR' + '     1500.00' + '     1200.00');
    expect(lines[4]).toBe('VIR' + '    1' + 'DE123456789    ' + '     1200.00' + '        0.00' + '      300.00' + '       ');
    expect(lines).toHaveLength(5);
    const rows = viesPart1(list, p);
    expect(rows.map((r) => [r.vatNumber, r.k3.toFixed(2), r.k4.toFixed(2), r.k5.toFixed(2)])).toEqual([['DE123456789', '1200.00', '0.00', '300.00']]);
    const t = viesTotals(rows);
    expect([t['01'].toFixed(2), t['17'].toFixed(2), t['02']]).toEqual(['1500.00', '1200.00', 1]);
  });
  it('only mediator operations and part-2 data: TTR/VIR are not written (documented defect)', () => {
    const proto = acc({ number: 'S1', documentTypeId: 13, extendedCodes: ['41'], legs: [], viesMonth: '2026-06-01' });
    const reg = acc({ number: 'S1', documentTypeId: 36, viesId: 5, icaAccountingId: proto.id, legs: [[1, 'x', 12, 100, EU_B], [-1, 'x', 12, 100]] });
    const lines = viesFileLines([vod(EU_A, 500, 3), proto, reg], p, info);
    expect(lines.map((l) => l.slice(0, 3))).toEqual(['VHR', 'VDR', 'VTR', 'CHR', 'COS']);
    expect(lines[3]).toBe('CHR    1');
    expect(lines[4]).toBe('COS' + '    1' + 'RO998877'.padEnd(15) + '1' + ' '.repeat(15) + ' '.repeat(7));
  });
  it('code 46 return: part 2 K3 = "1" plus an extra row K3 = "2"; COS adds a helper record', () => {
    const proto = acc({ number: 'S2', documentTypeId: 13, extendedCodes: ['46'], legs: [], viesMonth: '2026-05-01', term: 'DE000111222' });
    const reg = acc({ number: 'S2', documentTypeId: 36, viesId: 6, icaAccountingId: proto.id, legs: [[1, 'x', 12, 100, EU_B], [-1, 'x', 12, 100]] });
    const rows = viesPart2([proto, reg], p);
    expect(rows).toEqual([
      { k2: 'RO998877', k3: '1', k4: '', viesMonth: '2026-05-01' },
      { k2: 'DE000111222', k3: '2', k4: '', viesMonth: '2026-05-01' },
    ]);
    const lines = viesFileLines([proto, reg], p, info);
    expect(lines.slice(3)).toEqual([
      'CHR    2',
      'COS' + '    1' + 'DE000111222'.padEnd(15) + '2' + ' '.repeat(15) + '05/2026',
      'COS' + '    2' + 'RO998877'.padEnd(15) + '1' + ''.padEnd(15) + '05/2026',
    ]);
  });
  it('euro: SQL rounds per detail, the file divides the accounting total unrounded', () => {
    const a = acc({ viesId: 2, accountingDate: '2025-12-20', viesMonth: '2026-01-01', legs: [[1, 'x', 13, '0.03', EU_A], [1, 'x', 13, '0.03', EU_A], [-1, 'x', 13, '0.06']] });
    const q = { start: '2026-01-01', end: '2026-01-31' };
    // per detail: round(0.03 / 1.95583) = 0.02 each -> 0.04; total 0.06 / 1.95583 = 0.0307 -> 0.03
    expect(viesPart1([a], q)[0]!.k3.toFixed(2)).toBe('0.04');
    const lines = viesFileLines([a], q, { ...info, periodEnd: '2026-01-31' });
    expect(lines[3]).toBe('TTR' + '        0.03' + '        0.03');
  });
});

describe('missing and duplicated documents (04a 1.12)', () => {
  const item = (n: string, tt: number, partnerId: number | null = null, documentTypeId = 1) => ({
    accountingId: Number(n) || 0, accountingNumber: n, documentTypeId, documentTypeName: 'Фактура', documentNumber: n, documentDate: '2026-06-01',
    transactionTypeId: tt, partnerId, partnerName: '', amount: 1, icaType: 0,
  });
  it('reports gaps of sale invoices (1 < diff < 1000) as 10-digit numbers', () => {
    const r = findMissingDocuments([item('0000000001', 3), item('0000000004', 3), item('0000002000', 3), item('5', 2)]);
    expect(r).toEqual([
      { channel: 'Фактури за продажба', documentNumber: '0000000002' },
      { channel: 'Фактури за продажба', documentNumber: '0000000003' },
    ]);
  });
  it('purchase invoices duplicate by (type, number, partner); sales by (type, number)', () => {
    const r = findDuplicateDocuments([item('10', 2, 1), item('0010', 2, 2), item('10', 2, 1), item('7', 3, 1), item('7', 3, 2)]);
    expect(r.map((g) => [g.channel, g.rows.length])).toEqual([['Фактури за покупка', 2], ['Фактури за продажба', 2]]);
  });
  it('compares booked documents with a NAP file', () => {
    const f = [{ partnerId: 'BG1', partnerName: 'A', documentCode: '01', documentNumber: '0000000001', documentDate: '2026-06-01', base: 100, vat: 20 },
      { partnerId: 'BG2', partnerName: 'B', documentCode: '01', documentNumber: '2', documentDate: '2026-06-02', base: 50, vat: 10 }];
    const b = [{ partnerId: '1', partnerName: 'A', documentCode: '01', documentNumber: '1', documentDate: '2026-06-01', base: 100, vat: 19 },
      { partnerId: 'BG3', partnerName: 'C', documentCode: '01', documentNumber: '3', documentDate: '2026-06-03', base: 1, vat: 0 }];
    const r = compareWithNapFile(f, b);
    expect([r.missing.map((x) => x.documentNumber), r.absent.map((x) => x.documentNumber), r.different.length]).toEqual([['2'], ['3'], 1]);
  });
});

describe('VAT-diary import (04a 2)', () => {
  const d = (...v: number[]) => v.map((x) => dec(x));
  it('purchase postings by column', () => {
    const r = (c: number[]) => purchasePostings(d(...c)).map((p) => [p.vatTermId, p.sum.toFixed(2), p.vat.toFixed(2)]);
    expect(r([0, 1000, 200, 0, 0, 0, 0])).toEqual([[2, '1000.00', '200.00']]);
    expect(r([50, 1000, 200, 0, 0, 0, 0])).toEqual([[3, '50.00', '0.00'], [2, '1000.00', '200.00']]);
    expect(r([0, 0, 0, 300, 60, 0, 0])).toEqual([[4, '300.00', '60.00']]);
    expect(r([0, 0, 0, 0, 0, 40, 0])).toEqual([[5, '40.00', '0.00']]);
    expect(r([0, 0, 0, 0, 0, 0, 70])).toEqual([[6, '70.00', '0.00']]);
  });
  it('sale postings by column', () => {
    const cols = (set: Record<number, number>) => d(...Array.from({ length: 17 }, (_, i) => set[i] ?? 0));
    const r = (set: Record<number, number>) => salePostings(cols(set)).map((p) => [p.vatTermId, p.sum.toFixed(2), p.vat.toFixed(2)]);
    expect(r({ 0: 500, 1: 100, 2: 500, 3: 100 })).toEqual([[7, '500.00', '100.00']]);
    expect(r({ 0: 300, 11: 300 })).toEqual([[13, '300.00', '0.00']]);
    expect(r({ 13: 80 })).toEqual([[15, '80.00', '0.00']]);
    expect(r({ 1: 15 })).toEqual([[10, '0.00', '15.00']]);
  });
  it('parses a generated POKUPKI file, skips code 10, rejects bad lines and unknown codes', () => {
    const opts = { start: '2025-03-01', end: '2025-03-31', ownVatId: 'BG123456789' };
    const line = napLineToString(napPurchaseLines([purchase(1000, 200, 2, { accountingDate: '2025-03-12' })], opts)[0]!);
    const ok = parseDiaryFile(line + '\r\n' + line.slice(0, 40) + '10' + line.slice(42) + '\r\n', 'purchase');
    expect(ok.error).toBeNull();
    expect(ok.documents).toHaveLength(1);
    expect(ok.documents[0]!.postings.map((p) => [p.vatTermId, p.sum.toFixed(2), p.vat.toFixed(2)])).toEqual([[2, '1000.00', '200.00']]);
    expect(parseDiaryFile('xx\r\n', 'purchase').error).toBe('Невалиден формат на данните на ред 1 от файла за импорт.');
    expect(parseDiaryFile(line.slice(0, 40) + '81' + line.slice(42), 'purchase').error).toBe('Невалиден тип на документ на ред 1 от файла за импорт в поле 4: 81.');
  });
});

describe('zip writer', () => {
  it('stores files with CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789')).toString(16)).toBe('cbf43926');
    const z = zipStore([{ name: '06.2026/DEKLAR.TXT', data: new Uint8Array([65, 13, 10]) }]);
    expect([...z.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect([...z.slice(z.length - 22, z.length - 18)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });
});
