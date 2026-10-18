import { describe, expect, it } from 'vitest';
import {
  amountFromCurrency, buildLegs, currencyLine, currencyShares, DEFAULT_SHORTCUTS, distributeExpenses, defaultDistributionSide,
  documentNumberWarnings, duplicateShortcutWarnings, effectiveShortcuts, fastRowAccountMessages, fastRowDuplicates,
  fastRowTransactionType, formatMessage, group60ClosingDrafts, isAllowedEditableGesture, JOURNAL_EXTRA_MESSAGES as M, materialLine,
  preSaveConfirmations, reorderNumbers, sequenceEditorValues, sequencePreview, sequenceStorage, splitByWeights, validateAttachment,
  validateMassEdit, validateSequence, type MassEditAccount, type MassEditEntry,
} from '../src/index.ts';

const s = (xs: { toFixed: (n: number) => string }[]) => xs.map((x) => x.toFixed(2));

describe('02a 2 row calculations', () => {
  it('foreign account: amount = round2(currency x rate), currency = round2(amount / rate)', () => {
    expect(amountFromCurrency('100', '1.95583').toFixed(2)).toBe('195.58');
    const l = currencyLine('195.58', '1.95583');
    expect(l.currencyAmount.toFixed(2)).toBe('100.00');
  });

  it('material account: price rounded to PriceFormat (away from zero) before amount', () => {
    const l = materialLine('3', '1.005', { quantityDecimals: 3, priceDecimals: 2 });
    expect(l.price.toFixed(2)).toBe('1.01');
    expect(l.amount.toFixed(2)).toBe('3.03');
    expect(materialLine('-3', '1.005', { quantityDecimals: 3, priceDecimals: 2 }).amount.toFixed(2)).toBe('-3.03');
  });

  it('compound currency entry: shares round2(amount/rate), last takes the remainder', () => {
    expect(s(currencyShares('100.00', ['97.79', '97.79'], '1.95583'))).toEqual(['50.00', '50.00']);
    // 33.33 / 1.95583 = 17.041... -> 17.04 twice, remainder 100 - 34.08 = 65.92 on the last share
    expect(s(currencyShares('100.00', ['33.33', '33.33', '128.92'], '1.95583'))).toEqual(['17.04', '17.04', '65.92']);
    const legs = buildLegs(
      [{ accountId: 1, amount: '195.58', currency: { currencyId: 2, currencyAmount: '100', exchangeRate: '1.95583', fixedRate: '1.95583' } }],
      [{ accountId: 2, amount: '97.79' }, { accountId: 3, amount: '97.79' }],
    );
    const debitLegs = legs.filter((l) => l.sign === 1);
    expect(debitLegs.map((l) => l.currency?.currencyAmount)).toEqual(['50.00', '50.00']);
  });

  it('splits by weights with the last taking the remainder', () => {
    expect(s(splitByWeights('10', [1, 1, 1]))).toEqual(['3.33', '3.33', '3.34']);
    expect(s(splitByWeights('0.05', [1, 1]))).toEqual(['0.03', '0.02']);
  });
});

describe('02a 4.7 expenses distribution', () => {
  const lines = [
    { accountId: 10, amount: '300', quantity: '1', isMaterial: true },
    { accountId: 11, amount: '100', quantity: '3', isMaterial: true },
    { accountId: 12, amount: '80', isMaterial: false },
  ];
  it('by value over the goods lines only', () => {
    expect(distributeExpenses('40', lines, 'amount').map((x) => [x.accountId, x.amount.toFixed(2)])).toEqual([[10, '30.00'], [11, '10.00']]);
  });
  it('by quantity', () => {
    expect(distributeExpenses('40', lines, 'quantity').map((x) => x.amount.toFixed(2))).toEqual(['10.00', '30.00']);
  });
  it('remainder on the last line and errors without a base', () => {
    expect(distributeExpenses('10', [{ accountId: 1, amount: '1' }, { accountId: 2, amount: '1' }, { accountId: 3, amount: '1' }], 'amount').map((x) => x.amount.toFixed(2))).toEqual(['3.33', '3.33', '3.34']);
    expect(() => distributeExpenses('10', [{ accountId: 1, amount: '5' }], 'quantity')).toThrow();
  });
  it('default side holds the material lines', () => {
    expect(defaultDistributionSide([{ accountId: 1, amount: 1 }], [{ accountId: 2, amount: 1, isMaterial: true }])).toBe('credit');
    expect(defaultDistributionSide([{ accountId: 1, amount: 1 }], [{ accountId: 2, amount: 1 }])).toBe('debit');
  });
  it('reference text', () => {
    expect(formatMessage(M.strExpensesDistributionReferenceText, '0000000007')).toBe('Разпределение по контиране 0000000007');
  });
});

describe('02a 4.3/4.4 pre-save checks', () => {
  it('credit note with a positive sign asks strCreditNoteAmountConfirmation (acceptance 6)', () => {
    const keys = preSaveConfirmations({ documentTypeId: 3, totalDebit: '100', documentDate: '2026-03-01', viesMonth: '2026-03-01', duplicateExists: false }).map((m) => m.key);
    expect(keys).toEqual(['strCreditNoteAmountConfirmation']);
    expect(preSaveConfirmations({ documentTypeId: 3, totalDebit: '-100', documentDate: '2026-03-01', viesMonth: '2026-03-01', duplicateExists: false })).toEqual([]);
  });
  it('duplicate document, VIES month before the document and after the tax-credit term', () => {
    expect(preSaveConfirmations({ documentTypeId: 1, totalDebit: 1, documentDate: '2026-03-10', viesMonth: '2026-02-01', duplicateExists: true }).map((m) => m.key))
      .toEqual(['strDuplicatedDocumentWarning', 'strAskIfViesMonthIsBeforeDocumentDate']);
    expect(preSaveConfirmations({ documentTypeId: 1, totalDebit: 1, documentDate: '2025-03-10', viesMonth: '2026-03-01', duplicateExists: false }).map((m) => m.key)).toEqual([]);
    expect(preSaveConfirmations({ documentTypeId: 1, totalDebit: 1, documentDate: '2025-03-10', viesMonth: '2026-04-01', duplicateExists: false }).map((m) => m.key)).toEqual(['strViesMonthAfterTaxCredit']);
    expect(preSaveConfirmations({ documentTypeId: 1, totalDebit: 1, documentDate: null, viesMonth: null, duplicateExists: true, isInitialBalance: true })).toEqual([]);
  });
  it('invoice number longer than the sequence length is a warning', () => {
    expect(documentNumberWarnings(1, '12345678901', 10)[0]?.key).toBe('strInvalidDocNumberLenght');
    expect(documentNumberWarnings(1, '1234567890', 10)).toEqual([]);
    expect(documentNumberWarnings(10, '12345678901', 10)).toEqual([]);
  });
});

describe('02a 4.6 attachments (acceptance 7)', () => {
  it('rejects 11 MB and .exe', () => {
    expect(validateAttachment('scan.pdf', 11 * 1024 * 1024)[0]!.text).toBe('Файлът е по-голям от позволената дължина (10 MB).');
    expect(validateAttachment('virus.EXE', 10)[0]!.text).toBe('Непозволен тип на файл (.exe).');
    expect(validateAttachment('a.bat', 1)[0]!.key).toBe('strUnsupportedFileTypeMessage');
    expect(validateAttachment('lib.dll', 1)).toHaveLength(1);
    expect(validateAttachment('invoice.pdf', 10 * 1024 * 1024)).toEqual([]);
  });
});

describe('02a 4.7 group-60 assisted closing', () => {
  const src = {
    accountingDate: '2026-03-31', documentDate: '2026-03-30', term: '', reference: 'бел.',
    debits: [
      { accountId: 601, accountNumber: '601', amount: '100' },
      { accountId: 602, accountNumber: '602/1', amount: '50' },
      { accountId: 453, accountNumber: '453/1', amount: '30' },
    ],
  };
  it('one memorial order crediting every 60x debit line, debit left empty', () => {
    const d = group60ClosingDrafts(src, { enabled: true, separate: false });
    expect(d).toHaveLength(1);
    expect(d[0]!.documentTypeId).toBe(10);
    expect(d[0]!.term).toBe('Приключване на група 60');
    expect(d[0]!.debits).toEqual([]);
    expect(d[0]!.credits.map((c) => [c.accountId, c.amount])).toEqual([[601, '100.00'], [602, '50.00']]);
    expect(d[0]!.documentDate).toBe('2026-03-30');
  });
  it('separate drafts per line; nothing when off', () => {
    expect(group60ClosingDrafts({ ...src, term: 'Разходи' }, { enabled: true, separate: true }).map((x) => [x.term, x.credits.length])).toEqual([['Разходи', 1], ['Разходи', 1]]);
    expect(group60ClosingDrafts(src, { enabled: false, separate: true })).toEqual([]);
  });
});

describe('02a 3 renumbering', () => {
  it('acceptance: 1,2,2,5 -> 1,2,2,3 and LastNumber 3', () => {
    const r = reorderNumbers([
      { id: 1, number: '0000000001', date: '2026-01-05' }, { id: 2, number: '0000000002', date: '2026-01-06' },
      { id: 3, number: '0000000002', date: '2026-01-06' }, { id: 4, number: '0000000005', date: '2026-01-02' },
    ], 'number');
    expect([1, 2, 3, 4].map((i) => r.numbers.get(i))).toEqual([1, 2, 2, 3]);
    expect(r.count).toBe(3);
  });
  it('by date orders the groups by date', () => {
    const r = reorderNumbers([{ id: 1, number: '1', date: '2026-02-01' }, { id: 2, number: '2', date: '2026-01-01' }], 'date');
    expect([r.numbers.get(1), r.numbers.get(2)]).toEqual([2, 1]);
  });
});

describe('02a 6.2 mass edit validation', () => {
  const acc = (number: string, o: Partial<MassEditAccount> = {}): [string, MassEditAccount] => [number, { number, isLeaf: true, isForeignCurrency: false, currencyId: 2, isMaterial: false, isCompany: false, ...o }];
  const accounts = new Map([acc('4011', { isCompany: true }), acc('4012', { isCompany: true }), acc('503'), acc('5041', { isForeignCurrency: true, currencyId: 3 }), acc('5042', { isForeignCurrency: true, currencyId: 4 }), acc('3041', { isMaterial: true })]);
  const entry = (id: number, o: Partial<MassEditEntry> = {}): MassEditEntry => ({
    id, number: String(100 + id), isMonthLocked: false, hasDocument: true, hasCompanyLine: true, attachedNumbers: [],
    details: [{ accountNumber: '4011', sign: 1 }, { accountNumber: '503', sign: -1 }], ...o,
  });
  const ctx = { activeYear: 2026, accounts };
  const keys = (es: MassEditEntry[], ch: Parameters<typeof validateMassEdit>[1]) => validateMassEdit(es, ch, ctx).map((m) => m.key);

  it('worked example passes', () => {
    expect(keys([entry(1), entry(2), entry(3)], { fromDebitAccount: '4011', newAccount: '4012', newTerm: 'Корекция' })).toEqual([]);
  });
  it('rules 1-9 in order', () => {
    expect(keys([], { newTerm: 'x' })).toEqual(['strInvalidAccountingsNumber']);
    expect(keys([entry(1)], {})).toEqual(['strInvalidAccountingEditData']);
    expect(keys([entry(1), entry(2, { isMonthLocked: true })], { newTerm: 'x' })).toEqual(['strWrongAccountingMonth']);
    expect(keys([entry(1)], { newAccountingDate: '2025-05-01' })).toEqual(['strWrongAccountingDate']);
    expect(keys([entry(1, { hasCompanyLine: false })], { newCompanyId: 5 })).toEqual(['strInvalidEditNoCompanyAccountWidthCompany']);
    expect(keys([entry(1, { attachedNumbers: ['999'] })], { newCompanyId: 5 })).toEqual(['strInvalidEditCompanyOnLiabilityAttached']);
    expect(keys([entry(1, { attachedNumbers: ['102'] }), entry(2)], { newCompanyId: 5 })).toEqual([]);
    expect(keys([entry(1, { hasDocument: false })], { newDocumentDate: '2026-02-02' })).toEqual(['strInvalidEditDocumentNumber']);
    expect(keys([entry(1)], { newAccount: '4012' })).toEqual(['strNoEditAccountingNo']);
    expect(keys([entry(1)], { fromCreditAccount: '4011', newAccount: '4012' })).toEqual(['strNotValidEditDataAccount']);
  });
  it('rules 10-17 by account kind', () => {
    const fx = entry(1, { details: [{ accountNumber: '5041', sign: 1 }, { accountNumber: '3041', sign: -1 }] });
    expect(keys([fx], { fromDebitAccount: '5041', newAccount: '5042' })).toEqual(['strNotSameCurrency']);
    expect(keys([fx], { fromDebitAccount: '5041', newAccount: '503' })).toEqual(['strInvalidEditForeignCurrencyAccount']);
    expect(keys([entry(1)], { fromCreditAccount: '503', newAccount: '5041' })).toEqual(['strInvalidEditNoForeignCurrencyAccount']);
    expect(keys([fx], { fromCreditAccount: '3041', newAccount: '503' })).toEqual(['strInvalidEditMaterialAccount']);
    expect(keys([entry(1)], { fromCreditAccount: '503', newAccount: '3041' })).toEqual(['strInvalidEditNoMaterialAccount']);
    expect(keys([entry(1)], { fromDebitAccount: '4011', newAccount: '503' })).toEqual(['strInvalidEditCompanyAccount']);
    expect(keys([entry(1)], { fromCreditAccount: '503', newAccount: '4012' })).toEqual(['strInvalidEditNoCompanyAccount']);
    expect(keys([entry(1, { attachedNumbers: ['55'] })], { fromDebitAccount: '4011', newAccount: '4012' })).toEqual(['strInvalidEditAccountOnLiabilityAttached']);
    expect(keys([entry(1)], { fromDebitAccount: '4011', newAccount: '9999' })).toEqual(['strInvalidAccount']);
  });
  it('credit wins when both source accounts are filled', () => {
    expect(keys([entry(1)], { fromDebitAccount: '4011', fromCreditAccount: '503', newAccount: '503' })).toEqual([]);
  });
});

describe('02a 8.1 fast entry', () => {
  const a = (o: object = {}) => ({ number: '1', isLeaf: true, isForeignCurrency: false, isMaterial: false, isCompany: false, ...o });
  it('material/foreign accounts and partners on both sides', () => {
    expect(fastRowAccountMessages({ documentTypeId: 1, documentNumber: '1', transactionTypeId: 1, companyId: null, debit: a({ isMaterial: true }), credit: a() }).map((m) => m.key)).toEqual(['strInappropriateFastAccountingAccountMessage']);
    expect(fastRowAccountMessages({ documentTypeId: 1, documentNumber: '1', transactionTypeId: 1, companyId: 1, debit: a({ isCompany: true }), credit: a({ isCompany: true }) }).map((m) => [m.key, m.severity])).toEqual([['strCompanyAccountsOnBothSidesWarning', 'warning']]);
  });
  it('acceptance: same purchase invoice number and partner in two rows blocks', () => {
    const row = { documentTypeId: 1, documentNumber: '77', transactionTypeId: 2, companyId: 5 };
    const d = fastRowDuplicates([row, { ...row }, { ...row, companyId: 6 }], () => 'Фактура');
    expect([...d.keys()]).toEqual([1]);
    expect(d.get(1)![0]!.text).toBe('Документ с номер 77 от тип Фактура е дублиран за един и същ партньор във въведените редове!');
    const sale = { documentTypeId: 1, documentNumber: '8', transactionTypeId: 3, companyId: 5 };
    expect(fastRowDuplicates([sale, { ...sale, companyId: 6 }], () => 'Фактура').get(1)![0]!.key).toBe('strDuplicatedSaleDocumentExistInRows');
  });
  it('transaction type from the line VAT terms', () => {
    expect(fastRowTransactionType(2, 1)).toBe(2);
    expect(fastRowTransactionType(1, 3)).toBe(3);
    expect(fastRowTransactionType(null, null)).toBe(1);
  });
});

describe('06 3.7 numbering series', () => {
  it('worked example AB / - / 9 / 5', () => {
    expect(sequencePreview('AB', 9, 5)).toBe('AB00000005');
    expect(sequenceStorage('AB', '-', 9, 5)).toEqual({ format: 'AB-', numericLength: 8, lastNumber: 4 });
    expect(validateSequence('AB', 9, 5)).toEqual([]);
  });
  it('preview error when the prefix and number do not fit (the "123" option, index 2)', () => {
    expect(sequencePreview('ABC', 2, 1)).toBe('Грешка!');
    expect(validateSequence('ABC', 2, 1)[0]!.key).toBe('strIncorrectSequenceData');
  });
  it('round-trips the editor values', () => {
    expect(sequenceEditorValues({ format: 'AB-', numericLength: 8, lastNumber: 4 })).toEqual({ prefix: 'AB', separator: '-', selectedNumberLength: 9, startNumber: 5 });
    expect(sequenceEditorValues({ format: '[#]', numericLength: 10, lastNumber: 0 })).toEqual({ prefix: '', separator: '', selectedNumberLength: 9, startNumber: 1 });
  });
});

describe('06 2.6 shortcuts', () => {
  it('defaults from the spec', () => {
    const g = effectiveShortcuts({});
    expect(g.get('BalancingAndSave')).toBe('Shift+F9');
    expect(g.get('BalancingSaveAndCopy')).toBe('Alt+F9');
    expect(g.get('SaveTemplate')).toBe('F5');
    expect(g.get('LoadTemplates')).toBe('Ctrl+T');
    expect(g.get('CalculatePrice')).toBe('Ctrl+F5');
    expect(effectiveShortcuts({ SaveTemplate: 'Ctrl+F5' }).get('SaveTemplate')).toBe('Ctrl+F5');
    expect(DEFAULT_SHORTCUTS.length).toBeGreaterThan(30);
  });
  it('duplicate gestures are a warning, editable keys restricted', () => {
    const rows = DEFAULT_SHORTCUTS.map((d) => ({ ...d }));
    expect(duplicateShortcutWarnings(rows)).toEqual([]);
    rows.find((r) => r.id === 'SaveTemplate')!.gesture = 'Ctrl+F9';
    const w = duplicateShortcutWarnings(rows);
    expect(w.map((m) => [m.key, m.severity])).toEqual([['strWarningDuplicatedKeyShortcut', 'warning']]);
    expect(w[0]!.text).toContain('Изравняване');
    expect(isAllowedEditableGesture('Ctrl+F5')).toBe(true);
    expect(isAllowedEditableGesture('Alt+D')).toBe(true);
    expect(isAllowedEditableGesture('Ctrl+Space')).toBe(false);
  });
});
