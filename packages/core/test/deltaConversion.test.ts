import { describe, expect, it } from 'vitest';
import {
  DELTA_VAT_TERMS, DataImportError, deltaAccountCategory, deltaAccountNumber, deltaAmount, deltaDate, deltaField, deltaImportTypeLabel, deltaInt,
  deltaRepairCp1251, deltaText, deltaTransactionType, deltaVatTerm, deltaViesId, deltaYearTables, mapDeltaChart, mapDeltaCompany, mapDeltaPartner,
  mapDeltaYear, vatTermFromTxtCode, type DeltaRow,
} from '../src/index.ts';

const features = new Set([0, 3]);
const priznaci: DeltaRow[] = [
  { PriznakID: 0, Type: 0 }, { PriznakID: 3, Type: 0 }, { PriznakID: 7, Type: 1 },
];

function errorOf(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DataImportError);
    return (e as DataImportError).messages[0]!;
  }
  throw new Error('no error');
}

describe('Delta conversion: cells', () => {
  it('reads fields case-insensitively', () => {
    expect(deltaField({ ACCT: 411 }, 'Acct')).toBe(411);
    expect(deltaField({ Acct: 411 }, 'Acct')).toBe(411);
    expect(deltaField({}, 'Acct')).toBeUndefined();
  });

  it('converts text, numbers, amounts and dates', () => {
    expect(deltaText('  Фирма  ', 3)).toBe('Фир');
    expect(deltaText(null)).toBe('');
    expect(deltaText(411)).toBe('411');
    expect(deltaInt(true)).toBe(1);
    expect(deltaInt(-1)).toBe(-1);
    expect(deltaInt('2')).toBe(2);
    expect(deltaInt(null)).toBe(0);
    expect(deltaAmount('120.5000').toFixed(2)).toBe('120.50');
    expect(deltaAmount('-12,3').toFixed(2)).toBe('-12.30');
    expect(deltaAmount(0.1 + 0.2).toDecimalPlaces(2).toFixed(2)).toBe('0.30');
    expect(deltaAmount(null).isZero()).toBe(true);
    expect(deltaDate(new Date(Date.UTC(2009, 2, 15)))).toBe('2009-03-15');
    expect(deltaDate('15.03.2009')).toBe('2009-03-15');
    expect(deltaDate(39887)).toBe('2009-03-15');
    expect(deltaDate(new Date(Date.UTC(1899, 11, 30)))).toBeNull();
    expect(deltaDate(null)).toBeNull();
  });

  it('repairs windows-1251 text that a Jet 3 reader decoded as windows-1252', () => {
    // "Фирма" in windows-1251 is D4 E8 F0 EC E0; decoded as 1252 it reads "Ôèðìà".
    expect(deltaRepairCp1251('Ôèðìà ÎÎÄ')).toBe('Фирма ООД');
    expect(deltaRepairCp1251('ABC 123')).toBe('ABC 123');
    // 0x96 (en dash in 1252) is also an en dash in 1251; 0xB9 is the numero sign.
    expect(deltaRepairCp1251('– ¹5')).toBe('– №5');
  });
});

describe('Delta conversion: company and partners', () => {
  it('maps the System row', () => {
    expect(mapDeltaCompany({ Company: 'Делта ЕООД', Bulstat: '831641791', Partner: 'Иван Петров', VatID: 'BG831641791', City: 'София', Phone: '02 123', Address: 'ул. Първа 1', Bank: 'Банка', BankAcct: 'BG80BNBG96611020345678' })).toEqual({
      name: 'Делта ЕООД', bulstat: '831641791', contactName: 'Иван Петров', vatId: 'BG831641791', city: 'София', phone: '02 123', address: 'ул. Първа 1', bankName: 'Банка', bankAccount: 'BG80BNBG96611020345678',
    });
    expect(mapDeltaCompany(null)).toBeNull();
    expect(mapDeltaCompany({ Company: 'x'.repeat(300) })!.name).toHaveLength(255);
  });

  it('maps Part rows with the field lengths and the placeholder Bulstat', () => {
    const p = mapDeltaPartner({ ID: 7, Company: 'Клиент АД', Partner: 'Мария', Bulstat: '999999999', DanNo: 'BG121212121', Town: 'Варна', Addr: 'бул. Морски 2', Tel_Fax: '052', Bank: 'ОББ', BanAcct: 'BG11UBBS80021012345678', BanCode: 'UBBSBGSF', IsVeryUsed: 3 });
    expect(p).toEqual({
      sourceId: 7, name: 'Клиент АД', contactName: 'Мария', bulstat: null, vatNumber: 'BG121212121', city: 'Варна', address: 'бул. Морски 2', phone: '052',
      bank: { name: 'ОББ', account: 'BG11UBBS80021012345678', code: 'UBBSBGSF' }, priority: 3,
    });
    const q = mapDeltaPartner({ ID: 8, Company: 'x'.repeat(250), Bulstat: '1234567890123456', DanNo: '', BanAcct: '', IsVeryUsed: 900 });
    expect(q.name).toHaveLength(200);
    expect(q.bulstat).toBe('123456789012');
    expect(q.vatNumber).toBeNull();
    expect(q.bank).toBeNull();
    expect(q.priority).toBe(255);
  });
});

describe('Delta conversion: chart', () => {
  it('composes account numbers from Acct, SubAcct and PriznakID', () => {
    expect(deltaAccountNumber(411, 0, 0)).toBe('411');
    expect(deltaAccountNumber(411, 1, 0)).toBe('411/1');
    expect(deltaAccountNumber(411, 1, 3)).toBe('411/1/3');
    expect(deltaAccountNumber(411, 0, 3)).toBe('411/3');
    expect(deltaAccountNumber('503', '2', null, '-')).toBe('503-2');
  });

  it('takes the first category whose code is a prefix of the number', () => {
    expect(deltaAccountCategory('411')).toBe(10);
    expect(deltaAccountCategory('411/1')).toBe(10);
    expect(deltaAccountCategory('453/2')).toBe(17);
    expect(deltaAccountCategory('121')).toBeNull();
    expect(deltaAccountCategory('41', [{ id: 1, code: '' }, { id: 2, code: '4' }])).toBe(2);
  });

  it('keeps account features only, orders parents first and maps names and currency', () => {
    const chart = mapDeltaChart([
      { AcctID: 4, Acct: 411, SubAcct: 1, PriznakID: 0, Name: 'Клиенти в страната', IsValutna: 0 },
      { AcctID: 1, Acct: 411, SubAcct: 0, PriznakID: 0, Name: 'Клиенти', IsValutna: 0 },
      { AcctID: 2, Acct: 304, SubAcct: 0, PriznakID: 7, Name: 'Стоки (количества)', IsValutna: 0 },
      { AcctID: 3, Acct: 504, SubAcct: 1, PriznakID: 3, Name: 'x'.repeat(60), IsValutna: -1 },
      { AcctID: 5, Acct: 504, SubAcct: 0, PriznakID: 0, Name: 'Сметки във валута', IsValutna: 0 },
      { AcctID: 6, Acct: 504, SubAcct: 1, PriznakID: 0, Name: 'Банка', IsValutna: 0 },
      { AcctID: 7, Acct: 411, SubAcct: 0, PriznakID: 0, Name: 'Дубликат', IsValutna: 0 },
    ], priznaci);
    expect(chart.map((a) => a.number)).toEqual(['411', '504', '411/1', '504/1', '504/1/3']);
    expect(chart[0]).toEqual({ sourceId: 1, number: '411', parentNumber: null, description: 'Клиенти', isForeignCurrency: false, categoryId: 10 });
    const fx = chart.find((a) => a.number === '504/1/3')!;
    expect(fx.parentNumber).toBe('504/1');
    expect(fx.description).toHaveLength(50);
    expect(fx.isForeignCurrency).toBe(true);
    expect(fx.categoryId).toBe(27);
  });
});

describe('Delta conversion: VAT terms and codes', () => {
  it('decodes the OperType array of 7.2', () => {
    expect(DELTA_VAT_TERMS).toHaveLength(28);
    for (let i = 0; i <= 10; i++) expect(deltaVatTerm(i)).toBe(1);
    expect(deltaVatTerm(11)).toBe(3);
    expect(deltaVatTerm(12)).toBe(2);
    expect(deltaVatTerm(13)).toBe(4);
    expect(deltaVatTerm(16)).toBe(7);
    expect(deltaVatTerm(27)).toBe(18);
    expect(deltaVatTerm(28)).toBeNull();
    expect(deltaVatTerm(-1)).toBeNull();
  });

  it('matches the text-import codes for 11..27 (the TXT format is the legacy export format)', () => {
    for (let i = 11; i <= 27; i++) expect(deltaVatTerm(i)).toBe(vatTermFromTxtCode(i));
  });

  it('maps IsPokupka and VIESCol', () => {
    expect(deltaTransactionType(0)).toBe(1);
    expect(deltaTransactionType(1)).toBe(2);
    expect(deltaTransactionType(2)).toBe(3);
    expect(deltaTransactionType(3)).toBe(1);
    expect(deltaTransactionType(-1)).toBe(1);
    expect(deltaViesId(0)).toBe(1);
    expect(deltaViesId(1)).toBe(2);
    expect(deltaViesId(6)).toBe(7);
    expect(deltaViesId(20)).toBe(1);
  });

  it('lists the Year tables after 2007', () => {
    expect(deltaYearTables(['Year2009', 'Accts', 'Year2007', 'YEAR2008', 'Yearly', 'Year20x1'])).toEqual([
      { table: 'YEAR2008', year: 2008 }, { table: 'Year2009', year: 2009 },
    ]);
  });

  it('labels the import types', () => {
    expect(deltaImportTypeLabel('partners')).toBe('Партньори');
    expect(deltaImportTypeLabel('all')).toBe('Операции, сметкоплан и партньори');
  });
});

describe('Delta conversion: operations', () => {
  const base = { Date: new Date(Date.UTC(2009, 4, 20)), DocDate: new Date(Date.UTC(2009, 4, 19)), FakNo: '0000000123', DocType: 'Ф-ра', Osnovanie: 'Продажба', Note: 'бележка', PriznakID: 0 };
  const known = new Set(['411', '702', '453/2', '501']);
  const opts = { isValidAccount: (n: string) => known.has(n) };

  it('groups rows by KonID in Kon order and maps the header (acceptance: OperType 16, IsPokupka 2)', () => {
    const r = mapDeltaYear({
      table: 'Year2009', year: 2009, rows: [
        { ...base, KonID: 5, Kon: 3, Acct: 453, SubAcct: 2, IsKredit: 1, Qtty: -20, OperType: 16, IsPokupka: 2, VIESCol: 0, PartnerID: 0 },
        { ...base, KonID: 5, Kon: 1, Acct: 411, SubAcct: 0, IsKredit: 2, Qtty: 120, OperType: 16, IsPokupka: 2, VIESCol: 0, PartnerID: 9 },
        { ...base, KonID: 5, Kon: 2, Acct: 702, SubAcct: 0, IsKredit: 1, Qtty: -100, OperType: 16, IsPokupka: 2, VIESCol: 0, PartnerID: 0 },
        { ...base, KonID: 0, Kon: 1, Acct: 501, IsKredit: 2, Qtty: 999 },
      ],
    }, features, opts);
    expect(r.accountings).toHaveLength(1);
    const a = r.accountings[0]!;
    expect(a).toMatchObject({
      table: 'Year2009', konId: 5, date: '2009-05-20', documentDate: '2009-05-19', documentNumber: '0000000123', documentType: 'Ф-ра',
      term: 'Продажба', reference: 'бележка', transactionTypeId: 3, viesId: 1, viesMonth: '2009-12-01', partnerId: 9,
    });
    expect(a.debits).toEqual([{ accountNumber: '411', amount: '120.00', vatTermId: 7, partnerId: 9 }]);
    expect(a.credits).toEqual([
      { accountNumber: '702', amount: '100.00', vatTermId: 7, partnerId: 9 },
      { accountNumber: '453/2', amount: '20.00', vatTermId: 7, partnerId: 9 },
    ]);
  });

  it('acceptance: debit rows Qtty 120 and credit rows Qtty -120 form one balanced accounting', () => {
    const r = mapDeltaYear({ table: 'Year2009', year: 2009, rows: [
      { KonID: 1, Kon: 1, Acct: 501, IsKredit: 2, Qtty: 120, OperType: 0, PriznakID: 0 },
      { KonID: 1, Kon: 2, Acct: 411, IsKredit: 1, Qtty: -120, OperType: 0, PriznakID: 0 },
    ] }, features, opts);
    expect(r.accountings).toHaveLength(1);
    expect(r.accountings[0]!.debits[0]!.amount).toBe('120.00');
    expect(r.accountings[0]!.credits[0]!.amount).toBe('120.00');
  });

  it('defaults missing dates to 1 January and the VIES month to December, takes the VIES month from VIESDate', () => {
    const r = mapDeltaYear({ table: 'Year2010', year: 2010, rows: [
      { KonID: 1, Kon: 1, Acct: 501, IsKredit: 2, Qtty: 10, PriznakID: 0, VIESCol: 1, VIESDate: new Date(Date.UTC(2010, 6, 31)) },
      { KonID: 1, Kon: 2, Acct: 411, IsKredit: 1, Qtty: -10, PriznakID: 0 },
    ] }, features, opts);
    expect(r.accountings[0]).toMatchObject({ date: '2010-01-01', documentDate: '2010-01-01', viesId: 2, viesMonth: '2010-07-01', partnerId: null, documentNumber: '' });
  });

  it('drops rows of quantity features and zero lines; an accounting without lines is skipped', () => {
    const r = mapDeltaYear({ table: 'Year2009', year: 2009, rows: [
      { KonID: 1, Kon: 1, Acct: 304, IsKredit: 2, Qtty: 5, PriznakID: 7 },
      { KonID: 2, Kon: 1, Acct: 501, IsKredit: 2, Qtty: 0, PriznakID: 0 },
      { KonID: 2, Kon: 2, Acct: 411, IsKredit: 1, Qtty: 0, PriznakID: 0 },
      { KonID: 2, Kon: 3, Acct: 411, IsKredit: 0, Qtty: 50, PriznakID: 0 },
    ] }, features, opts);
    expect(r.accountings).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it('resolves accounts by AcctID when the table carries it', () => {
    const r = mapDeltaYear({ table: 'Year2009', year: 2009, rows: [
      { KonID: 1, Kon: 1, AcctID: 10, IsKredit: 2, Qtty: 10, PriznakID: 0 },
      { KonID: 1, Kon: 2, AcctID: 11, IsKredit: 1, Qtty: -10, PriznakID: 0 },
    ] }, features, { ...opts, accountsById: new Map([[10, '501'], [11, '411']]) });
    expect(r.accountings[0]!.debits[0]!.accountNumber).toBe('501');
    expect(r.accountings[0]!.credits[0]!.accountNumber).toBe('411');
  });

  it('reports an invalid account with table and KonID (DeltaConversionInvalidAccountError)', () => {
    const m = errorOf(() => mapDeltaYear({ table: 'Year2009', year: 2009, rows: [
      { KonID: 42, Kon: 1, Acct: 999, SubAcct: 1, IsKredit: 2, Qtty: 10, PriznakID: 0 },
    ] }, features, opts));
    expect(m.key).toBe('DeltaConversionInvalidAccountError');
    expect(m.text).toBe('Сметка 999/1 в таблица Year2009 с AccountingID = 42 е невалидна!');
    const n = errorOf(() => mapDeltaYear({ table: 'Year2009', year: 2009, rows: [
      { KonID: 3, Kon: 1, AcctID: 77, IsKredit: 2, Qtty: 10, PriznakID: 0 },
    ] }, features, { ...opts, accountsById: new Map() }));
    expect(n.text).toBe('Сметка 77 в таблица Year2009 с AccountingID = 3 е невалидна!');
  });

  it('refuses unbalanced accountings and an OperType outside the array', () => {
    const m = errorOf(() => mapDeltaYear({ table: 'Year2009', year: 2009, rows: [
      { KonID: 8, Kon: 1, Acct: 501, IsKredit: 2, Qtty: 10, PriznakID: 0 },
      { KonID: 8, Kon: 2, Acct: 411, IsKredit: 1, Qtty: -9.5, PriznakID: 0 },
    ] }, features, opts));
    expect(m.key).toBe('strDeltaConversionUnbalanced');
    expect(m.text).toContain('Дебит: 10.00, Кредит: 9.50');
    const n = errorOf(() => mapDeltaYear({ table: 'Year2009', year: 2009, rows: [
      { KonID: 9, Kon: 1, Acct: 501, IsKredit: 2, Qtty: 10, OperType: 28, PriznakID: 0 },
    ] }, features, opts));
    expect(n.key).toBe('strDeltaConversionInvalidOperType');
  });

  it('nets StartDebit / StartKredit into opening balances per account and partner', () => {
    const r = mapDeltaYear({ table: 'Year2009', year: 2009, rows: [
      { KonID: 0, Acct: 501, StartDebit: 300, StartKredit: 0, PriznakID: 0 },
      { KonID: 0, Acct: 501, StartDebit: 0, StartKredit: -50, PriznakID: 0 },
      { KonID: 0, Acct: 411, StartDebit: 0, StartKredit: 0, PriznakID: 0 },
      { KonID: 0, Acct: 411, StartDebit: 20, StartKredit: 70, PartnerID: 4, PriznakID: 0 },
      { KonID: 0, Acct: 411, StartDebit: 80, StartKredit: 0, PartnerID: 5, FakNo: '17', DocType: 'Ф-ра', DocDate: new Date(Date.UTC(2008, 10, 3)), PriznakID: 0 },
      { KonID: 0, Acct: 702, StartDebit: 5, StartKredit: 5, PriznakID: 0 },
    ] }, features, opts);
    expect(r.openings).toEqual([
      { table: 'Year2009', accountNumber: '501', partnerId: null, documentType: '', documentNumber: '', documentDate: null, debit: '250.00', credit: '0.00' },
      { table: 'Year2009', accountNumber: '411', partnerId: 4, documentType: '', documentNumber: '', documentDate: null, debit: '0.00', credit: '50.00' },
      { table: 'Year2009', accountNumber: '411', partnerId: 5, documentType: 'Ф-ра', documentNumber: '17', documentDate: '2008-11-03', debit: '80.00', credit: '0.00' },
    ]);
    expect(r.accountings).toHaveLength(0);
  });
});
