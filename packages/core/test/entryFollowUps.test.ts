import { describe, expect, it } from 'vitest';
import {
  assetFromPosting, ASSET_MESSAGES, ENTRY_FOLLOW_UP_MESSAGES as M, entryCardSides, fixedAssetOffer, formatMessage, JOURNAL_EXTRA_MESSAGES,
  lineWithFixing, linkedPostingWarning, missingPartnerAccounts,
} from '../src/index.ts';

describe('02a 2 fixing of the date', () => {
  it('a currency amount gives the amount: 100 EUR x 1.95583 = 195.58', () => {
    const r = lineWithFixing({ amount: '', currencyAmount: '100' }, '1.95583');
    expect([r.exchangeRate.toString(), r.fixedRate.toString(), r.amount!.toFixed(2), r.currencyAmount!.toFixed(2)]).toEqual(['1.95583', '1.95583', '195.58', '100.00']);
  });

  it('only an amount gives the currency amount; an empty line only takes the rate', () => {
    const r = lineWithFixing({ amount: '92.51', currencyAmount: null }, '0.92507');
    expect(r.currencyAmount!.toFixed(2)).toBe('100.00');
    const e = lineWithFixing({ amount: null, currencyAmount: null }, '1.1');
    expect([e.exchangeRate.toString(), e.amount, e.currencyAmount]).toEqual(['1.1', null, null]);
  });

  it('texts of the spec', () => {
    expect(M.strCalculateFixingExchangeConfirmationPrompt).toBe('Ще бъде преизчислен фиксингът/валутният курс за всички сметки в операцията. Сигурни ли сте,че желаете да продължите?');
    expect(M.strCurrenciesServiceUnavailableOrHoliday).toBe('Избраната дата на осчетоводяване е почивен ден или услугата за валутни справки е временно неактивна.');
  });
});

describe('02a 4.4 / 03b 14.1 fixed asset after save', () => {
  const dr = (n: string, amount = '1200') => ({ accountId: Number(n.replace(/\D/g, '')), accountNumber: n, amount });
  it('a debit on a 2xx account offers an asset unless the credit side has a partner account', () => {
    expect(fixedAssetOffer([dr('602', '10'), dr('204', '1200')], [{ ...dr('503'), isCompany: false }])?.accountNumber).toBe('204');
    expect(fixedAssetOffer([dr('204')], [{ ...dr('401'), isCompany: true }])).toBeNull();
    expect(fixedAssetOffer([dr('602')], [dr('503')])).toBeNull();
    expect(fixedAssetOffer([dr('204', '0')], [dr('503')])).toBeNull();
  });

  it('the asset form is prefilled from the posting (03b 6.1), name from the term', () => {
    expect(assetFromPosting({ accountId: 7, accountDescription: 'Компютърна техника', amount: '1200.004', date: '2026-03-15', term: ' Лаптоп Dell ' })).toEqual({
      inventoryAccountId: 7, name: 'Лаптоп Dell', acquisitionDate: '2026-03-15', startDate: '2026-03-15', depreciationAmount: '1200.00',
    });
    expect(assetFromPosting({ accountId: 7, accountDescription: 'Компютърна техника', amount: '5', date: '2026-03-15', term: '' }).name).toBe('Компютърна техника');
  });

  it('texts of the spec', () => {
    expect(M.strAddFixedAssetData).toBe('Желаете ли да въведете допълнителни данни за амортизационния план на актива?');
    expect(M.strPrintVOPProtocolConfirmation).toBe('Желаете ли печат на протокол по ЗДДС?');
  });
});

describe('03b 12.3 postings of the asset module', () => {
  it('depreciation and write-off postings are warned about with the 03b texts', () => {
    expect(linkedPostingWarning('depreciation')).toEqual({ key: 'strDepreciationScheduleAttachedWarning', text: ASSET_MESSAGES.strDepreciationScheduleAttachedWarning });
    expect(linkedPostingWarning('asset-writeoff')?.text).toBe('Избраният документ е автоматична операция за отписване на ДМА. Желаете ли продължение?');
    expect(linkedPostingWarning('manual')).toBeNull();
    expect(linkedPostingWarning(undefined)).toBeNull();
    expect(JOURNAL_EXTRA_MESSAGES.strDepreciationScheduleAttachedWarning).toBe('Избраният документ е генериран от амортизационен план. Моля, коригирайте амортизационния план. Желаете ли продължение?');
  });
});

describe('03a 2.9 partner account links', () => {
  it('lists each partner line whose account the partner lacks once', () => {
    const lines = [
      { accountId: 1, accountNumber: '401', companyId: 5, isCompany: true },
      { accountId: 1, accountNumber: '401', companyId: 5, isCompany: true },
      { accountId: 2, accountNumber: '411', companyId: 5, isCompany: true },
      { accountId: 3, accountNumber: '602', companyId: null, isCompany: false },
      { accountId: 4, accountNumber: '403', companyId: null, isCompany: true },
    ];
    expect(missingPartnerAccounts(lines, new Set(['5:2']))).toEqual([{ companyId: 5, accountId: 1, accountNumber: '401' }]);
    expect(formatMessage(M.strAddAccountToCompanyConfirmation, '401')).toBe('Избраният партньор не съдържа сметка 401! Сметката ще бъде добавена към партньора!');
  });
});

describe('05 7.11 entry card', () => {
  it('totals per side and the optional currency / material columns', () => {
    const r = entryCardSides(
      [{ accountNumber: '304/1', accountDescription: 'Стока', amount: '30.15', quantity: '3', price: '10.05', measure: 'бр.' }, { accountNumber: '453/1', accountDescription: 'ДДС', amount: '6.03' }],
      [{ accountNumber: '401', accountDescription: 'Доставчици', amount: '36.18', companyName: 'А ООД' }],
    );
    expect([r.debit.total.toFixed(2), r.credit.total.toFixed(2), r.balanced]).toEqual(['36.18', '36.18', true]);
    expect([r.debit.hasMaterial, r.debit.hasCurrency, r.credit.hasMaterial]).toEqual([true, false, false]);
    const c = entryCardSides([{ accountNumber: '502', accountDescription: 'Валутна сметка', amount: '195.58', currencyIso: 'USD', currencyAmount: '100', exchangeRate: '1.95583' }], []);
    expect([c.debit.hasCurrency, c.credit.total.toFixed(2), c.balanced]).toEqual([true, '0.00', false]);
  });
});
