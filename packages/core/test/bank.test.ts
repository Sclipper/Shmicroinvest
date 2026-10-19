import { describe, expect, it } from 'vitest';
import {
  BANKS_WITH_DEFAULT_TEMPLATES, bankFeeChecks, bankPostingLines, bankRowDifference, bankRowKey, bankTotals, defaultBankTemplates, defaultTemplateTokens,
  hasDefaultBankTemplates, mapStatementRow, mapStatementRows, mergeBankRows, parseBankStatement, parseStatementTable, readStatementHeader, tokenizeCondition,
  validateCondition, type BankMapContext, type BankPostingContext, type BankStatementRow, type BankTemplateDef,
} from '../src/index.ts';

const row = (o: Partial<BankStatementRow>): BankStatementRow => ({
  index: 0, date: '2026-03-02', isInflow: true, amount: '100.00', partnerIban: '', partnerName: '', reason: '', reference: '', props: {}, ...o,
});

describe('exchange rate per date and currency differences (04b 1.8, 1.10)', () => {
  const ctx: BankMapContext = {
    bankAccountId: 504, templates: [], accountByNumber: () => null, isCompanyAccount: () => false, findCompany: () => null,
    isForeignCurrency: true, currencyRate: (d) => ({ '2026-03-02': '0.92', '2026-03-03': '0.93' })[d] ?? null,
  };
  it('each row takes the rate of its own date; the file base amount is kept', () => {
    const [a, b, c] = mapStatementRows([
      row({ date: '2026-03-02', amount: '100.00' }),
      row({ index: 1, date: '2026-03-03', amount: '100.00', baseAmount: '94.00' }),
      row({ index: 2, date: '2026-03-04', amount: '50.00', baseAmount: '46.50' }),
    ], ctx);
    expect([a!.currencyAmount, a!.exchangeRate, a!.postAmount]).toEqual(['100.00', '0.92', '92.00']);
    expect([b!.exchangeRate, b!.postAmount]).toEqual(['0.93', '94.00']);
    // No stored rate for the date: derived from the file amounts.
    expect([c!.exchangeRate, c!.postAmount]).toEqual(['0.93', '46.50']);
    expect(bankRowDifference(b!)).toBe('1.00');
    expect(bankRowDifference(a!)).toBe('0.00');
  });

  const pctx: BankPostingContext = { bankAccountId: 504, isForeignCurrency: (id) => id === 504 || id === 4011, fxIncomeAccountId: 724, fxExpenseAccountId: 624, feeAccountId: 629 };
  it('bank line at currency x rate, the difference to 624 / 724', () => {
    // Inflow, counter base 94.00 > bank 93.00: loss.
    let r = bankPostingLines({ debitAccountId: 504, creditAccountId: 503, postAmount: '94.00', currencyAmount: '100', exchangeRate: '0.93' }, pctx);
    expect(r.debits).toEqual([{ accountId: 504, amount: '93.00', currencyAmount: '100.00', exchangeRate: '0.93' }, { accountId: 624, amount: '1.00' }]);
    expect(r.credits).toEqual([{ accountId: 503, amount: '94.00' }]);
    expect(r.difference).toBe('1.00');
    // Outflow, counter 95.00 > bank 93.00: gain.
    r = bankPostingLines({ debitAccountId: 503, creditAccountId: 504, postAmount: '95.00', currencyAmount: '100', exchangeRate: '0.93' }, pctx);
    expect(r.credits).toEqual([{ accountId: 504, amount: '93.00', currencyAmount: '100.00', exchangeRate: '0.93' }, { accountId: 724, amount: '2.00' }]);
    expect(r.messages).toEqual([]);
    // Currency on both sides: no difference.
    r = bankPostingLines({ debitAccountId: 4011, creditAccountId: 504, postAmount: '95.00', currencyAmount: '100', exchangeRate: '0.93' }, pctx);
    expect(r.difference).toBe('0.00');
    expect(r.debits[0]).toMatchObject({ accountId: 4011, amount: '95.00', currencyAmount: '100.00' });
    // Missing FX accounts.
    r = bankPostingLines({ debitAccountId: 504, creditAccountId: 503, postAmount: '94.00', currencyAmount: '100', exchangeRate: '0.93' }, { ...pctx, fxExpenseAccountId: null });
    expect(r.messages.map((m) => m.key)).toEqual(['strCurrencyAccountsNotFound']);
    // BGN/EUR account: one line each side.
    r = bankPostingLines({ debitAccountId: 503, creditAccountId: 401, postAmount: '10' }, { ...pctx, bankAccountId: 503 });
    expect([r.debits, r.credits]).toEqual([[{ accountId: 503, amount: '10.00' }], [{ accountId: 401, amount: '10.00' }]]);
  });

  it('bank fees: lines and the strBankTax* checks', () => {
    let r = bankPostingLines({ debitAccountId: 401, creditAccountId: 503, postAmount: '100', feeAmount: '2.50' }, { ...pctx, bankAccountId: 503 });
    expect([r.debits, r.credits]).toEqual([[{ accountId: 401, amount: '100.00' }], [{ accountId: 503, amount: '100.00' }]]);
    expect(r.fee).toEqual({ debits: [{ accountId: 629, amount: '2.50' }], credits: [{ accountId: 503, amount: '2.50' }] });
    r = bankPostingLines({ debitAccountId: 401, creditAccountId: 503, postAmount: '100', feeAmount: '2.50' }, { ...pctx, bankAccountId: 503, feeAccountId: null });
    expect(r.messages.map((m) => m.key)).toEqual(['strBankTaxAccountsMissing']);
    r = bankPostingLines({ debitAccountId: 401, creditAccountId: 504, postAmount: '93', currencyAmount: '100', exchangeRate: '0', feeCurrencyAmount: '3' }, pctx);
    expect(r.messages.map((m) => m.key)).toEqual(['strBankTaxZeroSum', 'strBankTaxZeroExchangeRate']);
    r = bankPostingLines({ debitAccountId: 401, creditAccountId: 504, postAmount: '93', currencyAmount: '100', exchangeRate: '0.93', feeCurrencyAmount: '3' }, pctx);
    expect(r.fee).toEqual({ debits: [{ accountId: 629, amount: '2.79' }], credits: [{ accountId: 504, amount: '2.79', currencyAmount: '3.00', exchangeRate: '0.93' }] });
    expect(r.fee && bankPostingLines({ debitAccountId: 401, creditAccountId: 504, postAmount: '93', currencyAmount: '100', exchangeRate: '0.93' }, pctx).fee).toBeNull();
    // A fee row itself (Dt 629 / Ct currency bank) with no currency amount.
    r = bankPostingLines({ debitAccountId: 629, creditAccountId: 504, postAmount: '5', currencyAmount: '0', exchangeRate: '0.93' }, pctx);
    expect(r.messages.map((m) => m.key)).toEqual(['strBankTaxZeroCurrencySum']);
    expect(bankFeeChecks({ amount: '0', currencyAmount: null, rate: null }, false).map((m) => m.key)).toEqual(['strBankTaxZeroSum']);
  });

  it('footer totals', () => {
    expect(bankTotals([
      { isInflow: true, postAmount: '94.00', currencyAmount: '100.00', exchangeRate: '0.93' },
      { isInflow: false, postAmount: '10.00', currencyAmount: '10.00', exchangeRate: '1' },
      { isInflow: true, postAmount: '6.00' },
    ])).toEqual({ count: 3, inflow: '100.00', outflow: '10.00', currencyInflow: '100.00', currencyOutflow: '10.00', difference: '1.00' });
  });
});

describe('re-applying a rule to one row (MapStatementToAccountingWithTemplate)', () => {
  const t: BankTemplateDef = { id: 5, name: 'Наем', priority: 3, formula: tokenizeCondition('Reason съдържа "наем"'), termText: 'наем', referenceText: '', companyId: null, isOwnAccounts: false, mergeRowsOnImport: false, detail: { sign: 1, accountId: 602, refAccountId: null, accountNumber: null } };
  const ctx: BankMapContext = { bankAccountId: 503, templates: [t], accountByNumber: () => null, isCompanyAccount: () => false, findCompany: () => null };
  it('maps the row with the chosen rule even when its condition does not hold', () => {
    const r = mapStatementRow(row({ isInflow: false, reason: 'нещо' }), ctx, t);
    expect(r).toMatchObject({ templateId: 5, debitAccountId: 602, creditAccountId: 503, term: 'наем', warnings: [] });
    expect(mapStatementRow(row({ isInflow: false }), ctx, null).warnings).toEqual(['strNoBankTemplateWarning']);
  });
});

describe('duplicate keys (D-04b-6)', () => {
  it('hash of date, signed amount, IBAN and reference', () => {
    const a = row({ partnerIban: 'BG11 UNCR 7000 1512 3456 78', reference: 'REF1' });
    expect(bankRowKey(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(bankRowKey(a)).toBe(bankRowKey({ ...a, partnerIban: 'BG11UNCR70001512345678', amount: '100', reason: 'other' } as BankStatementRow));
    expect(bankRowKey(a)).not.toBe(bankRowKey({ ...a, isInflow: false }));
    expect(bankRowKey(a)).not.toBe(bankRowKey({ ...a, reference: 'REF2' }));
    expect(bankRowKey(a)).not.toBe(bankRowKey({ ...a, date: '2026-03-03' }));
  });
  it('mapped rows carry their key; merged rows all their keys', () => {
    const t: BankTemplateDef = { id: 1, name: 'Такса', priority: 1, formula: tokenizeCondition('Reason съдържа "такса"'), termText: '', referenceText: '', companyId: null, isOwnAccounts: false, mergeRowsOnImport: true, detail: { sign: 1, accountId: 629, refAccountId: null, accountNumber: null } };
    const ctx: BankMapContext = { bankAccountId: 503, templates: [t], accountByNumber: () => null, isCompanyAccount: () => false, findCompany: () => null };
    const rows = mapStatementRows([row({ isInflow: false, reason: 'такса', props: { Reason: 'такса' } }), row({ index: 1, isInflow: false, amount: '2', reason: 'такса', props: { Reason: 'такса' } })], ctx);
    expect(rows[0]!.rowKeys).toEqual([bankRowKey(rows[0]!)]);
    const merged = mergeBankRows(rows, 'all', new Set([1]));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.rowKeys).toHaveLength(2);
  });
});

describe('per-bank default rules (03a 9.1)', () => {
  const COUNTS: Record<string, number> = {
    STSABGSF: 15, UBBSBGSF: 16, BPBIBGSF: 15, PRCBBGSF: 16, FINVBGSF: 15, RZBBBGSF: 16, UNCRBGSF: 15, IRIS: 15, BUINBGSF: 15, EVIULT2V: 14,
    IORTBGSF: 16, TEXIBGSF: 17, IABGBGSF: 17, SOMBBGSF: 16, INTFBGSF: 7, BGUSBGSF: 16, DEMIBGSF: 16, ESPYBGS1: 7, CECBBGSF: 18, TCZBBGSF: 18,
  };
  it('the rule count of every bank of the spec', () => {
    expect(BANKS_WITH_DEFAULT_TEMPLATES.sort()).toEqual(Object.keys(COUNTS).sort());
    for (const [code, n] of Object.entries(COUNTS)) expect(defaultBankTemplates(code), code).toHaveLength(n);
    expect(hasDefaultBankTemplates('stsabgsf')).toBe(true);
    expect(hasDefaultBankTemplates('NASBBGSF')).toBe(false);
    expect(defaultBankTemplates('NASBBGSF')).toHaveLength(15); // the "Стандартни шаблони" command falls back to the common set
  });
  it('valid conditions; fee priority 1 or 2; partner rules at 10; ПОС rules flagged', () => {
    for (const code of BANKS_WITH_DEFAULT_TEMPLATES) {
      const list = defaultBankTemplates(code);
      for (const d of list) expect(validateCondition(defaultTemplateTokens(d)), `${code} ${d.name}`).toBeNull();
      expect([1, 2]).toContain(list.find((d) => d.name === 'Банкова такса')!.priority);
      expect(list.find((d) => d.name === 'Плащане към Доставчик')).toMatchObject({ debit: '401', priority: 10 });
      expect(list.find((d) => d.name === 'Получаване от Клиент')).toMatchObject({ credit: '411', priority: 10 });
      expect(list.filter((d) => d.name.includes('ПОС')).every((d) => d.posPartner)).toBe(true);
      expect(new Set(list.map((d) => d.name)).size).toBe(list.length);
    }
  });
  it('bank-specific rules, spellings and fee codes', () => {
    const names = (c: string) => defaultBankTemplates(c).map((d) => d.name);
    expect(names('EVIULT2V')).not.toContain('Вноска на каса');
    expect(names('UBBSBGSF')).toContain('Възстановяване на такси');
    expect(names('PRCBBGSF')).toContain('Възстановяване на ДДС');
    expect(names('CECBBGSF')).toEqual(expect.arrayContaining(['Плащане по МД', 'Плащане по изпълнително дело', 'Лихва разход']));
    expect(names('TEXIBGSF')).toContain('Плащане ДДС');
    expect(names('INTFBGSF').sort()).toEqual(['Банкова такса', 'Вноска на каса', 'Плащане към Доставчик', 'Плащане на ПОС терминал', 'Получаване на ПОС терминал', 'Получаване от Клиент', 'Теглене в брой'].sort());
    expect(defaultBankTemplates('RZBBBGSF').find((d) => d.name === 'Банкова такса')!.condition).toContain('RACOMM');
    // Tallies of 03a 9.1: fee priority 1 at 10 banks, 2 at 9.
    const sets = BANKS_WITH_DEFAULT_TEMPLATES.filter((c) => c !== 'IRIS');
    const fee = sets.map((c) => defaultBankTemplates(c).find((d) => d.name === 'Банкова такса')!.priority);
    expect([fee.filter((p) => p === 1).length, fee.filter((p) => p === 2).length]).toEqual([10, 9]);
    const pos = sets.map((c) => defaultBankTemplates(c).find((d) => d.name === 'Получаване на ПОС терминал')!.priority);
    expect([pos.filter((p) => p === 9).length, pos.filter((p) => p === 10).length]).toEqual([12, 7]);
  });
});

describe('bank XML formats (04b 1.13)', () => {
  it('Fibank statement XML: <ROWSET><ROW><XML> wrapper, statement/system/header', () => {
    const xml = `<ROWSET><ROW><XML><statement>
      <system><Version>1</Version></system>
      <header><IBAN>BG18FINV91501014771636</IBAN><FromDate>01.03.2026</FromDate><Currency>EUR</Currency><OpeningBalance>1000.00</OpeningBalance><ClosingBalance>1120.00</ClosingBalance></header>
      <movements>
        <movement><ValueDate>02.03.2026</ValueDate><Reference>FT1</Reference><DebitTov>0</DebitTov><CreditTov>150.00</CreditTov><Amount>150.00</Amount><REMIII>BG11UNCR70001512345678</REMIII>
          <OperationReason><RecipientAccount>BG11UNCR70001512345678</RecipientAccount><RecipientName>Алфа ООД</RecipientName><Description>ф-ра 123</Description></OperationReason></movement>
        <movement><ValueDate>03.03.2026</ValueDate><Reference>FT2</Reference><DebitTov>30.00</DebitTov><CreditTov>0</CreditTov><Amount>30.00</Amount>
          <OperationReason><Description>Такса</Description></OperationReason></movement>
      </movements>
    </statement></XML></ROW></ROWSET>`;
    const s = parseBankStatement({ text: xml }, 'FINVBGSF')!;
    expect(s).toMatchObject({ format: 'Fibank XML', model: 'Fibank', iban: 'BG18FINV91501014771636', currency: 'EUR', from: '2026-03-01', to: '2026-03-03', openingBalance: '1000.00', closingBalance: '1120.00' });
    expect(s.rows.map((r) => [r.date, r.isInflow, r.amount, r.partnerName, r.reason, r.reference])).toEqual([
      ['2026-03-02', true, '150.00', 'Алфа ООД', 'ф-ра 123', 'FT1'],
      ['2026-03-03', false, '30.00', '', 'Такса', 'FT2'],
    ]);
    expect(s.rows[0]!.props.TRNAccount).toBe('BG11UNCR70001512345678');
    expect(parseBankStatement({ text: '<ROWSET><ROW><XML><other/></XML></ROW></ROWSET>' }, 'FINVBGSF')).toBeNull();
  });

  it('Raiffeisen data-contract XML (d3p1: elements, Items)', () => {
    const xml = `<?xml version="1.0"?><AccountStatement xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:d3p1="http://schemas.datacontract.org/2004/07/Raiffeisen">
      <d3p1:IBAN>BG13RZBB91551001234567</d3p1:IBAN><d3p1:Currency>EUR</d3p1:Currency>
      <d3p1:Items>
        <d3p1:Item><d3p1:ValueDate>2026-03-05T00:00:00</d3p1:ValueDate><d3p1:MovementType>CREDIT</d3p1:MovementType><d3p1:Amount>200.00</d3p1:Amount>
          <d3p1:OppositeSideAccount>BG11UNCR70001512345678-EUR</d3p1:OppositeSideAccount><d3p1:OppositeSideName>Бета ЕООД</d3p1:OppositeSideName><d3p1:Narrative>Плащане ф-ра 9</d3p1:Narrative>
          <d3p1:MovementDocument><d3p1:DescriptionAdditional>доп.</d3p1:DescriptionAdditional></d3p1:MovementDocument></d3p1:Item>
        <d3p1:Item><d3p1:ValueDate>2026-03-06T00:00:00</d3p1:ValueDate><d3p1:MovementType>DEBIT</d3p1:MovementType><d3p1:Amount>-4.50</d3p1:Amount><d3p1:Narrative>RACOMM такса</d3p1:Narrative></d3p1:Item>
      </d3p1:Items></AccountStatement>`;
    const s = parseBankStatement({ text: xml }, 'RZBBBGSF')!;
    expect(s).toMatchObject({ format: 'Raiffeisen XML', iban: 'BG13RZBB91551001234567', currency: 'EUR' });
    expect(s.rows.map((r) => [r.date, r.isInflow, r.amount, r.partnerIban, r.reason])).toEqual([
      ['2026-03-05', true, '200.00', 'BG11UNCR70001512345678', 'Плащане ф-ра 9 доп.'],
      ['2026-03-06', false, '4.50', '', 'RACOMM такса'],
    ]);
  });

  it('Unicredit data-contract XML (AmountInMovementCCY, Reason + ReasonI02)', () => {
    const xml = `<Statement xmlns:d3p1="http://schemas.datacontract.org/2004/07/Unicredit"><d3p1:Movements>
      <d3p1:Movement><d3p1:Date>10.03.2026</d3p1:Date><d3p1:MovementType>ДТ</d3p1:MovementType><d3p1:AmountInMovementCCY>75,00</d3p1:AmountInMovementCCY>
        <d3p1:OppositeSideAccount>BG11UNCR70001512345678</d3p1:OppositeSideAccount><d3p1:OppositeSideName>Гама АД</d3p1:OppositeSideName><d3p1:Reason>Наем</d3p1:Reason><d3p1:ReasonI02>март</d3p1:ReasonI02></d3p1:Movement>
      <d3p1:Movement><d3p1:Date>11.03.2026</d3p1:Date><d3p1:MovementType>КТ</d3p1:MovementType><d3p1:AmountInMovementCCY>12</d3p1:AmountInMovementCCY><d3p1:Reason>Лихва</d3p1:Reason></d3p1:Movement>
    </d3p1:Movements></Statement>`;
    const s = parseBankStatement({ text: xml }, 'UNCRBGSF')!;
    expect(s.format).toBe('Unicredit XML');
    expect(s.rows.map((r) => [r.date, r.isInflow, r.amount, r.reason])).toEqual([['2026-03-10', false, '75.00', 'Наем март'], ['2026-03-11', true, '12.00', 'Лихва']]);
  });

  it('Fibank movements XML (SYTY_BAL_CUST_MAIN) is not read: the spec gives no fields', () => {
    expect(parseBankStatement({ text: '<SYTY_BAL_CUST_MAIN><A/><B/><C/><ACC/></SYTY_BAL_CUST_MAIN>' }, 'FINVBGSF')).toBeNull();
  });
});

describe('Excel/CSV statement header (04b 1.3, 1.4)', () => {
  it('DSK: col A rows 3-10, col B rows 12-17', () => {
    const t: string[][] = [
      ['Банка ДСК'], ['ОТЧЕТ'], ['Банка ДСК АД'], ['София'], ['STSABGSF'], ['Клиент ООД'], ['123456789'], ['ул. 1'], [''], ['BG80STSA93000012345678 EUR'],
      [''], ['', '01.03.2026'], ['', '31.03.2026'], ['', '1 000,00'], ['', '20,00'], ['', '150,50'], ['', '1130,50'],
      ['Дата', 'Дебит', 'Кредит', 'Контрагент', 'Основание'],
      ['02.03.2026', '', '150,50', 'Алфа ООД', 'ф-ра 1'],
      ['03.03.2026', '20', '', '', 'Такса'],
    ];
    const s = parseStatementTable(t, 'STSABGSF', 'Excel');
    expect(s).toMatchObject({ iban: 'BG80STSA93000012345678', currency: 'EUR', from: '2026-03-01', to: '2026-03-31', openingBalance: '1000.00', closingBalance: '1130.50' });
    expect(s.rows).toHaveLength(2);
  });
  it('Postbank "(XXX)" currency, balances by caption, period cell', () => {
    const t: string[][] = [
      ['Извлечение по сметка BG66BPBI79241012345678'], ['Период: 01.03.2026 - 31.03.2026'], ['Сума (USD)'], ['Начално салдо', '500,00'],
      ['Дата', 'Тип', 'Сума', 'Контрагент', 'Основание'],
      ['05.03.2026', 'Приход', '10', 'X', 'y'],
      ['Ново салдо: 510,00'],
    ];
    expect(parseStatementTable(t, 'BPBIBGSF', 'Excel')).toMatchObject({ iban: 'BG66BPBI79241012345678', currency: 'USD', from: '2026-03-01', to: '2026-03-31', openingBalance: '500.00', closingBalance: '510.00' });
  });
  it('Zirat: rows 5/8, the last two date tokens; name/IBAN split on newline', () => {
    const t: string[][] = [[''], [''], [''], ['Дата на печат 15.04.2026'], ['Клиент ООД\nBG72TCZB93501012345678', 'Валута:', 'EUR'], [''], [''], ['Справка 01.03.2026 31.03.2026']];
    expect(readStatementHeader(t, [], 'Zirat')).toMatchObject({ iban: 'BG72TCZB93501012345678', currency: 'EUR', from: '2026-03-01', to: '2026-03-31' });
  });
});
