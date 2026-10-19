import { describe, expect, it } from 'vitest';
import {
  allocateWalk, bindByNumber, bindBySum, closeForImport, closingKey, extractInvoiceNumbers, normalizeInvoiceNumber,
  normalizeNumericNumber, operationLabel, pairForClosing, sameExchangeRate, validatePaymentAllocations, type ClosingItem,
} from '../src/index.ts';

const item = (p: Partial<ClosingItem> & { accountingId: number; open: string }): ClosingItem => ({
  accountingDate: '2026-01-10', accountId: 1, companyId: 7, side: 'client', documentTypeId: 1, documentNumber: '', optionalReference: '',
  kind: p.side === 'supplier' ? (Number(p.open) < 0 ? 'liability' : 'payment') : (Number(p.open) > 0 ? 'liability' : 'payment'),
  ...p,
});

describe('allocation walk (02a 10 import mode)', () => {
  it('invoice 100 against payments 60 and 40 gives two pairs 60, 40', () => {
    const r = allocateWalk([{ id: 'inv', amount: '100' }], [{ id: 'p1', amount: '60' }, { id: 'p2', amount: '40' }]);
    expect(r.map((a) => [a.liabilityId, a.paymentId, a.amount.toFixed(2)])).toEqual([['inv', 'p1', '60.00'], ['inv', 'p2', '40.00']]);
  });
  it('advances the side that reaches zero; surplus stays unallocated', () => {
    const r = allocateWalk([{ id: 1, amount: '30' }, { id: 2, amount: '50' }], [{ id: 'a', amount: '70' }, { id: 'b', amount: '20' }]);
    expect(r.map((a) => `${a.liabilityId}${a.paymentId}${a.amount.toFixed(2)}`)).toEqual(['1a30.00', '2a40.00', '2b10.00']);
  });
  it('splits the liability currency amount pro rata, the last part takes the remainder', () => {
    const r = allocateWalk([{ id: 1, amount: '195.58', currencyAmount: '100' }], [{ id: 'a', amount: '97.79' }, { id: 'b', amount: '97.79' }]);
    expect(r.map((a) => a.currencyAmount.toFixed(2))).toEqual(['50.00', '50.00']);
  });
});

describe('binding by number and by sum (04b 1.9)', () => {
  it('normalises invoice numbers', () => {
    expect(normalizeInvoiceNumber('0000000123')).toBe('0000123');
    expect(normalizeInvoiceNumber('123')).toBe('0000123');
    expect(normalizeInvoiceNumber('AB12')).toBe('000000AB12');
    expect(normalizeInvoiceNumber('12-5')).toBe('12-5');
  });
  it('extracts numbers after keywords', () => {
    expect(extractInvoiceNumbers('Плащане по фактура 123, 124')).toEqual(['0000123', '0000124']);
    expect(extractInvoiceNumbers('ф-ра № 0000000077 от 10.01')).toContain('0000077');
    expect(extractInvoiceNumbers('Наем за месец март')).toEqual([]);
  });
  it('adds matching documents until the amount is covered (invoices first)', () => {
    const docs = [
      { id: 'a', documentNumber: '0000000001', amount: '100' },
      { id: 'b', documentNumber: '2', amount: '50', isInvoice: true },
      { id: 'c', documentNumber: '3', amount: '150', isInvoice: true },
    ];
    expect(bindByNumber(['1', '2', '3'], docs, '150').map((d) => d.id)).toEqual(['b', 'c']);
    expect(bindByNumber(['1'], docs, '40').map((d) => d.id)).toEqual(['a']);
  });
  it('R-04b-2: three open invoices 100, 50, 150 and a row of 150 -> first exact subset', () => {
    const docs = [{ id: 1, documentNumber: '', amount: '100' }, { id: 2, documentNumber: '', amount: '50' }, { id: 3, documentNumber: '', amount: '150' }];
    // masks in order: {1}=100, {2}=50, {1,2}=150 -> first exact subset is invoices 1 and 2
    expect(bindBySum(docs, '150').map((d) => d.id)).toEqual([1, 2]);
    expect(bindBySum(docs, '151')).toEqual([]);
    expect(bindBySum(docs, '300').map((d) => d.id)).toEqual([1, 2, 3]);
  });
});

describe('documents closing (02a 10)', () => {
  it('amount mode: invoice 100 and cash receipt 100 of one partner form one pair of 100', () => {
    const inv = item({ accountingId: 1, open: '100.00', documentNumber: '5' });
    const pko = item({ accountingId: 2, open: '-100.00', documentTypeId: 8, documentNumber: '1', accountingDate: '2026-02-01' });
    const other = item({ accountingId: 3, open: '-90.00', documentTypeId: 8, documentNumber: '2' });
    const pairs = pairForClosing([inv, pko, other], 'amount');
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ liability: { accountingId: 1 }, payment: { accountingId: 2 } });
    expect(pairs[0]!.amount.toFixed(2)).toBe('100.00');
  });
  it('document mode: same type and number in opposite directions, "007" = "7"', () => {
    const inv = item({ accountingId: 1, open: '-120.00', side: 'supplier', documentNumber: '007' });
    const pay = item({ accountingId: 2, open: '100.00', side: 'supplier', documentNumber: '7' });
    const otherNo = item({ accountingId: 3, open: '20.00', side: 'supplier', documentNumber: '8' });
    expect(normalizeNumericNumber('007')).toBe('7');
    const pairs = pairForClosing([inv, pay, otherNo], 'document');
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.amount.toFixed(2)).toBe('100.00');
  });
  it('pairs the i-th liability with the i-th payment by date, separate accounts and partners do not mix', () => {
    const l1 = item({ accountingId: 1, open: '100', accountingDate: '2026-01-01' });
    const l2 = item({ accountingId: 2, open: '100', accountingDate: '2026-01-05' });
    const p1 = item({ accountingId: 3, open: '-100', accountingDate: '2026-03-01' });
    const pOther = item({ accountingId: 4, open: '-100', companyId: 8 });
    const pairs = pairForClosing([l2, p1, l1, pOther], 'amount');
    expect(pairs.map((p) => [p.liability.accountingId, p.payment.accountingId])).toEqual([[1, 3]]);
  });
  it('second-remark mode skips blank references', () => {
    const a = item({ accountingId: 1, open: '50', optionalReference: 'Договор 12' });
    const b = item({ accountingId: 2, open: '-30', optionalReference: 'Договор 12' });
    const c = item({ accountingId: 3, open: '-30', optionalReference: ' ' });
    expect(closingKey('optionalReference', c)).toBeNull();
    const pairs = pairForClosing([a, b, c], 'optionalReference');
    expect(pairs.map((p) => p.amount.toFixed(2))).toEqual(['30.00']);
  });
  it('import mode: invoice 100 and payments 60 + 40 -> two pairs (60, 40)', () => {
    const inv = item({ accountingId: 1, open: '100' });
    const p60 = item({ accountingId: 2, open: '-60', accountingDate: '2026-02-01' });
    const p40 = item({ accountingId: 3, open: '-40', accountingDate: '2026-02-02' });
    const pairs = closeForImport([p60, p40], [inv]);
    expect(pairs.map((p) => [p.liability.accountingId, p.payment.accountingId, p.amount.toFixed(2)])).toEqual([[1, 2, '60.00'], [1, 3, '40.00']]);
  });
  it('import mode with a way of searching (XML SelectedWayOfSearching): only items of the same group pair', () => {
    const inv1 = item({ accountingId: 1, open: '100', documentNumber: '0000000005' });
    const inv2 = item({ accountingId: 2, open: '70', documentNumber: '6' });
    const pay = item({ accountingId: 3, open: '-70', documentNumber: '6', accountingDate: '2026-02-01' });
    const pr = (m?: 'document' | 'amount' | 'optionalReference') => closeForImport([pay], [inv1, inv2], m).map((p) => [p.liability.accountingId, p.amount.toFixed(2)]);
    expect(pr()).toEqual([[1, '70.00']]);
    expect(pr('document')).toEqual([[2, '70.00']]);
    expect(pr('amount')).toEqual([[2, '70.00']]);
    expect(pr('optionalReference')).toEqual([]);
  });
  it('labels the operation type', () => {
    expect(operationLabel('client', 'liability')).toBe('Вземане');
    expect(operationLabel('supplier', 'liability')).toBe('Задължение');
    expect(operationLabel('supplier', 'payment')).toBe('Плащане');
  });
});

describe('payment validation', () => {
  it('refuses allocations above the open amount or the payment', () => {
    const keys = validatePaymentAllocations('100', [{ label: 'Ф-ра 1', amount: '80', open: '70' }, { label: 'Ф-ра 2', amount: '30', open: '30' }]).map((m) => m.key);
    expect(keys).toEqual(['strPaymentExceedsOpenAmount', 'strAllocationExceedsPayment']);
    expect(validatePaymentAllocations('100', [{ label: 'x', amount: '100', open: '-100' }])).toEqual([]);
  });
  it('refuses a negative allocation that would make the total fit the payment', () => {
    const r = validatePaymentAllocations('50', [{ label: 'Ф-ра A', amount: '-100', open: '200' }, { label: 'Ф-ра B', amount: '150', open: '200' }]);
    expect(r.map((m) => m.key)).toEqual(['strPaymentAllocationNotPositive']);
    expect(r[0]!.text).toBe('Сумата за разплащане на документ Ф-ра A трябва да бъде положителна!');
  });
  it('documents of a currency account must share one rate', () => {
    expect(sameExchangeRate(['1.95583', '1.955830', '0'])).toBe(true);
    expect(sameExchangeRate(['1.1', '1.2'])).toBe(false);
    const r = validatePaymentAllocations('10', [{ label: 'a', amount: '5', open: '5', exchangeRate: '1.1' }, { label: 'b', amount: '5', open: '5', exchangeRate: '1.2' }], true);
    expect(r.map((m) => m.text)).toEqual(['Избраните документи са с различни валутни курсове. Операцията не може да бъде записана.']);
  });
});
