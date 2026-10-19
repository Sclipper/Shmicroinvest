import { describe, expect, it } from 'vitest';
import {
  parseXml, writeXml, XmlSyntaxError, escapeXml,
  parseTransferXml, writeTransferXml, operationToLines, accountingLines, DataImportError, usableIdentifier, bulstatFromVat,
  tokenizeCondition, compileCondition, validateCondition, conditionToText,
  parseTextImport, txtOperationLines, formatTextImportLine, vatTermFromTxtCode, vatFromGross,
  parseBankStatement, parseMt940, parseStatementDate, mapperForBank, splitDelimited,
  mapStatementRows, mergeBankRows, validateBankRow, normalizeDocumentNumber, extractStatementInvoiceNumbers, firstExactSubset, autoBindDocuments,
  DEFAULT_BANK_TEMPLATES, defaultTemplateTokens, bankRecalc,
  parseTrzFeed, trzAggregate, trzGrid, trzDefaultTerm, trzDefaultAccountingDate, trzAccountingDateValid, trzAvailableMonths, TRZ_ITEMS,
  columnIndex, columnLetters, validateExcelMapping, parseExcelOperationRow, parseDirection, parseCharacter, icaDefaultTerm, cellDate, readSetupSheet,
  toEuro, convertOpenings, defaultEuroMapping, accountDifference, convertBalanceToEuro, euroBalanceKind,
  backupFileName, parseBackupFileName, sanitizeCompanyName, compareVersions,
  parseExportReport, bindNamedParameters, writeExportCsv, exportFileName, checkExportParameters, isReadOnlyQuery, forbiddenQueryReference,
  msg, parseImportDate, fromOADate,
  type TransferData, type BankTemplateDef, type BankMapContext, type ExcelAccountInfo, type ExcelOperationsContext, type ExcelSheet,
} from '../src/index.ts';

const errorKeys = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DataImportError) return e.messages.map((m) => m.key);
    throw e;
  }
  throw new Error('expected DataImportError');
};

describe('xml reader/writer', () => {
  it('parses attributes, entities, namespaces and CDATA', () => {
    const r = parseXml('<?xml version="1.0"?>\n<a:Root xmlns:a="urn:x" k="1 &amp; 2"><b>t&lt;x&gt;</b><c><![CDATA[<raw>]]></c></a:Root>');
    expect(r.local).toBe('Root');
    expect(r.ns).toBe('urn:x');
    expect(r.attrs.k).toBe('1 & 2');
    expect(r.children[0]!.text).toBe('t<x>');
    expect(r.children[1]!.text).toBe('<raw>');
  });
  it('reports line and position of syntax errors', () => {
    expect(() => parseXml('<a>\n<b></a>')).toThrow(XmlSyntaxError);
    try {
      parseXml('<a>\n<b></a>');
    } catch (e) {
      expect((e as Error).message).toMatch(/line 2/);
    }
  });
  it('writes escaped XML', () => {
    expect(escapeXml('a<"&>')).toBe('a&lt;&quot;&amp;&gt;');
    const s = writeXml({ name: 'X', attrs: { a: 'x&y', skip: undefined }, children: [{ name: 'Y', text: '1<2' }] });
    expect(parseXml(s).attrs.a).toBe('x&y');
    expect(parseXml(s).children[0]!.text).toBe('1<2');
    expect(s).not.toContain('skip');
  });
});

const SAMPLE: TransferData = {
  accounts: [{ number: '411/7', description: 'Клиенти Х', category: 10, currency: 'BGN' }],
  products: [{ name: 'Брашно', code: 'B1', measure: 'кг', price: '1.200000', supplyAccountNumber: '304' }],
  companies: [{ name: 'Алфа ООД', bulstat: '123456789', vatNumber: 'BG123456789', bankAccounts: [{ bankName: 'ДСК', bankCode: 'STSABGSF', accountNumber: 'BG80BNBG96611020345678' }], companyAccounts: ['411'], address: { location: 'ул. 1', city: 'София', phone: '', postalCode: '1000' } }],
  accountings: [{
    number: '1', accountingDate: '2026-03-15', viesMonth: '2026-03-15', term: 'Продажба', reference: 'реф', vies: 1, vatTerm: 7,
    document: { documentType: 1, number: '0000000123', date: '2026-03-15' },
    company: { name: 'Алфа ООД', bulstat: '123456789', bankAccounts: [], companyAccounts: [] },
    details: [
      { accountNumber: '411', amount: '120.00', direction: 'Debit', vatTerm: 7 },
      { accountNumber: '702', amount: '100.00', direction: 'Credit', vatTerm: 7 },
      { accountNumber: '453/2', amount: '20.00', direction: 'Credit', vatTerm: 7 },
    ],
  }],
  operations: [{
    operationType: 7, date: '2026-03-16', vatTerm: 7, term: 'Стоки', documentSumVatIncl: '120.00', documentVat: '20.00',
    document: { documentType: 1, number: '0000000124', date: '2026-03-16' }, company: { name: 'Бета ЕООД', bankAccounts: [], companyAccounts: [] },
  }],
};

describe('TransferData XML (04a 3)', () => {
  it('export -> import round trip keeps all data', () => {
    const xml = writeTransferXml(SAMPLE);
    expect(xml).toContain('xmlns="urn:Transfer"');
    const back = parseTransferXml(xml);
    expect(back.accounts![0]).toMatchObject({ number: '411/7', category: 10, currency: 'BGN' });
    expect(back.products![0]).toMatchObject({ name: 'Брашно', supplyAccountNumber: '304', price: '1.200000' });
    expect(back.companies![0]!.bankAccounts[0]!.accountNumber).toBe('BG80BNBG96611020345678');
    expect(back.companies![0]!.address!.city).toBe('София');
    const a = back.accountings![0]!;
    expect(a.document).toEqual({ documentType: 1, number: '0000000123', date: '2026-03-15' });
    expect(a.details.map((d) => [d.accountNumber, d.amount, d.direction])).toEqual([['411', '120.00', 'Debit'], ['702', '100.00', 'Credit'], ['453/2', '20.00', 'Credit']]);
    expect(back.operations![0]).toMatchObject({ operationType: 7, documentSumVatIncl: '120.00', documentVat: '20.00' });
    // Second round trip is byte-identical.
    expect(writeTransferXml(back)).toBe(writeTransferXml(parseTransferXml(writeTransferXml(back))));
  });
  it('rejects malformed XML and schema violations with strXMLImportError and the position', () => {
    const e1 = (() => { try { parseTransferXml('<TransferData xmlns="urn:Transfer"><Accountings>'); } catch (e) { return e as DataImportError; } })()!;
    expect(e1.messages[0]!.key).toBe('strXMLImportError');
    expect(e1.details.join(' ')).toMatch(/line \d+ position \d+/);
    const bad = writeTransferXml(SAMPLE).replace('Vies="1"', 'Vies="9"');
    expect(errorKeys(() => parseTransferXml(bad))).toEqual(['strXMLImportError']);
  });
  it('accepts the corrected enumerations (Vies 5-7, ICAType 5-6, DocumentType 42-43)', () => {
    const xml = writeTransferXml({ accountings: [{ ...SAMPLE.accountings![0]!, vies: 7, document: { documentType: 43, number: '1', date: '2026-01-01' } }] });
    expect(parseTransferXml(xml).accountings![0]!.vies).toBe(7);
  });
  it('currency problems give strXMLImportCurrencyError', () => {
    const acc = SAMPLE.accountings![0]!;
    const withCur = { ...acc, details: [{ ...acc.details[0]!, currency: { currency: 'USD', currencyAmount: '10', exchangeRate: '1.5', fixedRate: '1.5' } }, ...acc.details.slice(1)] };
    const xml = writeTransferXml({ accountings: [withCur] }).replace('CurrencyAmount="10.00"', 'CurrencyAmount="abc"');
    expect(errorKeys(() => parseTransferXml(xml))).toEqual(['strXMLImportCurrencyError']);
  });
  it('a file without accountings or operations has no data', () => {
    expect(errorKeys(() => parseTransferXml(writeTransferXml({ accounts: SAMPLE.accounts })))).toEqual(['strImportFileHasNoDataErrorMessage']);
  });
  it('operation type 7 (120 incl. 20 VAT) -> Dt Клиенти 120 / Ct Продажби на стоки 100 / Ct ДДС продажби 20', () => {
    const r = operationToLines(SAMPLE.operations![0]!);
    expect(r.debits).toEqual([{ categoryId: 10, amount: '120.00', vatTerm: 7 }]);
    expect(r.credits).toEqual([{ categoryId: 24, amount: '100.00', vatTerm: 7 }, { categoryId: 17, amount: '20.00', vatTerm: 1 }]);
  });
  it('operation VAT rules', () => {
    const op = SAMPLE.operations![0]!;
    expect(errorKeys(() => operationToLines({ ...op, operationType: 14 }))).toEqual(['strVATNotAllowedInOperation']);
    expect(errorKeys(() => operationToLines({ ...op, operationType: 13, documentVat: '0' }))).toEqual(['strVATRequiredInOperation']);
    expect(errorKeys(() => operationToLines({ ...op, operationType: 99 }))).toEqual(['strUnrecognizedOperationType']);
    const imp = operationToLines({ ...op, operationType: 1, documentSumVatIncl: '60', documentVat: '10' });
    expect(imp.debits.map((l) => [l.categoryId, l.amount])).toEqual([[37, '50.00'], [16, '10.00']]);
    expect(imp.credits.map((l) => [l.categoryId, l.amount])).toEqual([[4, '60.00']]);
  });
  it('accounting rules: sums, 2-2 shape, empty side, VAT term, currency', () => {
    const base = SAMPLE.accountings![0]!;
    const cur = new Set(['BGN', 'EUR', 'USD']);
    expect(accountingLines(base, cur).credits).toHaveLength(2);
    expect(errorKeys(() => accountingLines({ ...base, details: [base.details[0]!, { ...base.details[1]!, amount: '90' }] }, cur))).toEqual(['strXMLImportAccountingSumsError']);
    const twoTwo = [
      { accountNumber: '411', amount: '50', direction: 'Debit' as const, vatTerm: 7 }, { accountNumber: '412', amount: '50', direction: 'Debit' as const, vatTerm: 7 },
      { accountNumber: '702', amount: '50', direction: 'Credit' as const, vatTerm: 7 }, { accountNumber: '703', amount: '50', direction: 'Credit' as const, vatTerm: 7 },
    ];
    expect(errorKeys(() => accountingLines({ ...base, details: twoTwo }, cur))).toEqual(['strXMLImportAccountingDetailsError']);
    expect(errorKeys(() => accountingLines({ ...base, details: [base.details[0]!] }, cur))).toEqual(['strXMLImportEmptyAccountingError']);
    expect(errorKeys(() => accountingLines({ ...base, vatTerm: 0, details: base.details.map((d) => ({ ...d, vatTerm: 0 })) }, cur))).toEqual(['strXMLImportAccountingVatTermError']);
    expect(errorKeys(() => accountingLines({ ...base, details: [] }, cur))).toEqual(['strXMLImportDetailError']);
    const withCur = { ...base, details: [{ ...base.details[0]!, currency: { currency: 'GBP', currencyAmount: '10', exchangeRate: '2', fixedRate: '2' } }, ...base.details.slice(1)] };
    expect(errorKeys(() => accountingLines(withCur, cur))).toEqual(['strXMLImportCurrencyError']);
  });
  it('partner identifiers', () => {
    expect(usableIdentifier('999999999999999')).toBeNull();
    expect(usableIdentifier(' 123 ')).toBe('123');
    expect(bulstatFromVat('BG175074752')).toBe('175074752');
    expect(bulstatFromVat('DE123')).toBeNull();
  });
});

describe('posting-rule conditions (04b 1.6)', () => {
  const row: Record<string, string> = { Reason: 'Плащане по ф-ра 123', OppositeSideName: 'Алфа ООД', DebitAmount: '', CreditAmount: '150.50', OppositeSideAccount: 'BG80BNBG96611020345678' };
  const run = (text: string, isPartner?: (v: string) => boolean) => compileCondition(tokenizeCondition(text))({ get: (n) => row[n], isPartner });
  it('съдържа / не съдържа / започва с / = are case-insensitive', () => {
    expect(run('Reason съдържа "ФАКТУРА"')).toBe(false);
    expect(run('Reason съдържа "ф-ра"')).toBe(true);
    expect(run('Reason не съдържа "заплата"')).toBe(true);
    expect(run('Reason започва с "плащане"')).toBe(true);
    expect(run('OppositeSideName = "алфа оод"')).toBe(true);
  });
  it('и също binds left-to-right with или; parentheses group', () => {
    expect(run('Reason съдържа "x" или Reason съдържа "ф-ра" и също OppositeSideName съдържа "бета"')).toBe(false);
    expect(run('Reason съдържа "x" или (Reason съдържа "ф-ра" и също OppositeSideName съдържа "алфа")')).toBe(true);
  });
  it('numeric comparisons and empty values', () => {
    expect(run('CreditAmount > 100')).toBe(true);
    expect(run('CreditAmount < 100')).toBe(false);
    expect(run('DebitAmount = ""')).toBe(true);
    expect(run('Reason съдържа "такса,ф-ра"')).toBe(true);
  });
  it('е клиент/доставчик asks the partner lookup', () => {
    expect(run('OppositeSideAccount е клиент/доставчик', (v) => v === 'BG80BNBG96611020345678')).toBe(true);
    expect(run('OppositeSideAccount е клиент/доставчик', () => false)).toBe(false);
  });
  it('validation and text round trip', () => {
    expect(validateCondition(tokenizeCondition('Reason съдържа'))).not.toBeNull();
    expect(validateCondition(tokenizeCondition('(Reason съдържа "a"'))).not.toBeNull();
    expect(validateCondition(tokenizeCondition('Foo = 1'), ['Reason'])).toMatch(/Foo/);
    const t = 'Reason съдържа "a" и също (CreditAmount > 5 или OppositeSideName е клиент/доставчик)';
    expect(conditionToText(tokenizeCondition(t))).toBe(t);
    for (const d of DEFAULT_BANK_TEMPLATES) expect(validateCondition(defaultTemplateTokens(d))).toBeNull();
  });
});

describe('text import (04a 4)', () => {
  const line = (kind: string, amount: string, code = '16', vat = '-1', date = '15.03.2026', doc = 'Ф-ра') =>
    formatTextImportLine([kind, date, '123', doc, amount, code, 'Алфа ООД', 'Иван', 'София', 'ул. 1', 'BG123456789', '123456789', '', '', 'бел.', vat]);
  it('parses a sale with VAT computed from the gross amount (-1)', () => {
    const [op] = parseTextImport(line('2', '120.00'), { activeYear: 2026 });
    expect(op!.vatTermId).toBe(7);
    expect(op!.vatAmount).toBe('20.00');
    expect(op!.term).toBe('Продажба на стоки');
    const l = txtOperationLines(op!);
    expect(l.debits).toEqual([{ ref: { category: 10 }, amount: '120.00', vatTermId: 7 }]);
    expect(l.credits.map((c) => [c.ref, c.amount])).toEqual([[{ category: 24 }, '100.00'], [{ category: 17 }, '20.00']]);
  });
  it('free-form "602%-401" puts purchase VAT on the debit side', () => {
    const [op] = parseTextImport(line('602%-401', '120', '12', '20.00'), { activeYear: 2026 });
    const l = txtOperationLines(op!);
    expect(l.debits.map((d) => [d.ref, d.amount])).toEqual([[{ number: '602' }, '100.00'], [{ category: 16 }, '20.00']]);
    expect(l.credits).toEqual([{ ref: { number: '401' }, amount: '120.00', vatTermId: 2 }]);
  });
  it('a row with 15 fields gives strInvalidDataFormatInRow', () => {
    const bad = line('2', '1').split('|').slice(0, 15).join('|');
    expect(errorKeys(() => parseTextImport(bad, { activeYear: 2026 }))).toEqual(['strInvalidDataFormatInRow']);
  });
  it('VAT code 10 gives strInvalidVatTermTypeInImport; other errors are collected', () => {
    const text = [line('2', '1', '10'), line('2', '1', '16', '0', '15.03.2025'), line('2', '1', '16', '0', '15.03.2026', 'XX'), line('99', '1')].join('\r\n');
    expect(errorKeys(() => parseTextImport(text, { activeYear: 2026 }))).toEqual(['strInvalidVatTermTypeInImport', 'strOperationDateInDifferentFY', 'strInvalidDocumentTypeInImport', 'strUnrecognizedOperationType']);
  });
  it('VAT on an operation without a VAT account is rejected', () => {
    expect(errorKeys(() => parseTextImport(line('9', '100', '8', '10'), { activeYear: 2026 }))).toEqual(['strVATNotAllowedInOperationErrorWithRowNumber']);
  });
  it('period filter and predefined term', () => {
    const text = [line('2', '1', '16', '0', '01.02.2026'), line('2', '1', '16', '0', '01.03.2026')].join('\n');
    const ops = parseTextImport(text, { activeYear: 2026, from: '2026-03-01', to: '2026-03-31', predefinedTerm: 'Импорт' });
    expect(ops).toHaveLength(1);
    expect(ops[0]!.term).toBe('Импорт');
  });
  it('VAT term codes and VAT part', () => {
    expect([8, 11, 12, 13, 27, 10].map(vatTermFromTxtCode)).toEqual([1, 3, 2, 4, 18, null]);
    expect(vatFromGross('120', 20).toFixed(2)).toBe('20.00');
    expect(vatFromGross('100', 9).toFixed(2)).toBe('8.26');
  });
});

describe('bank statements (04b 1)', () => {
  const MT940 = [
    ':20:STMT1', ':25:BG80BNBG96611020345678', ':28C:1/1', ':60F:C260301BGN1000,00',
    ':61:2603020302C150,50NTRFREF1//B1', ':86:Плащане по ф-ра 123/ 2026 от Алфа ООД BG11UNCR70001512345678',
    ':61:2603030303D20,00NCHGREF2', ':86:Такса за превод',
    ':62F:C260303BGN1130,50', '-',
  ].join('\r\n');
  it('MT940: rows, direction, balances', () => {
    const s = parseMt940(MT940)!;
    expect(s.iban).toBe('BG80BNBG96611020345678');
    expect(s.currency).toBe('BGN');
    expect(s.openingBalance).toBe('1000.00');
    expect(s.closingBalance).toBe('1130.50');
    expect(s.rows.map((r) => [r.date, r.isInflow, r.amount])).toEqual([['2026-03-02', true, '150.50'], ['2026-03-03', false, '20.00']]);
    expect(s.rows[0]!.partnerIban).toBe('BG11UNCR70001512345678');
  });
  it('camt.053', () => {
    const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
      <Acct><Id><IBAN>BG80BNBG96611020345678</IBAN></Id><Ccy>EUR</Ccy></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">10.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
      <Ntry><Amt Ccy="EUR">25.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-04-01</Dt></BookgDt><ValDt><Dt>2026-04-01</Dt></ValDt>
        <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Бета ЕООД</Nm></Cdtr><CdtrAcct><Id><IBAN>BG11UNCR70001512345678</IBAN></Id></CdtrAcct></RltdPties>
        <RmtInf><Ustrd>Плащане ф-ра 77</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
    </Stmt></BkToCstmrStmt></Document>`;
    const s = parseBankStatement({ text: xml }, 'PAYSLT2X')!;
    expect(s.format).toBe('camt.053');
    expect(s.currency).toBe('EUR');
    expect(s.rows[0]).toMatchObject({ date: '2026-04-01', isInflow: false, amount: '25.00', partnerName: 'Бета ЕООД', partnerIban: 'BG11UNCR70001512345678' });
    expect(s.rows[0]!.reason).toContain('ф-ра 77');
  });
  it('CSV by header captions (DSK model)', () => {
    const csv = 'Дата;Дебит;Кредит;Контрагент;IBAN на контрагента;Основание\n02.03.2026;;150,50;Алфа ООД;BG11UNCR70001512345678;ф-ра 123\n03.03.2026;20.00;;;;Такса\n';
    const s = parseBankStatement({ text: csv }, 'STSABGSF')!;
    expect(s.rows.map((r) => [r.date, r.isInflow, r.amount, r.partnerName])).toEqual([['2026-03-02', true, '150.50', 'Алфа ООД'], ['2026-03-03', false, '20.00', '']]);
    expect(mapperForBank('STSABGSF').id).toBe('DSK');
  });
  it('delimiters and dates', () => {
    expect(splitDelimited('a|b|c\n1|2|3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(splitDelimited('"a;b";c\n1;2')).toEqual([['a;b', 'c'], ['1', '2']]);
    expect(parseStatementDate('2026-03-02T10:00:00')).toBe('2026-03-02');
    expect(parseStatementDate('02/03/2026')).toBe('2026-03-02');
  });

  const templates: BankTemplateDef[] = [
    { id: 1, name: 'Такса', priority: 2, formula: tokenizeCondition('Reason съдържа "такса"'), termText: 'Банкова такса', referenceText: '', companyId: null, isOwnAccounts: false, mergeRowsOnImport: true, detail: { sign: 1, accountId: 629, refAccountId: null, accountNumber: null } },
    { id: 2, name: 'Получаване от клиент', priority: 10, formula: tokenizeCondition('OppositeSideAccount е клиент/доставчик'), termText: 'Плащане от клиент', referenceText: '', companyId: null, isOwnAccounts: false, mergeRowsOnImport: false, detail: { sign: -1, accountId: null, refAccountId: 411, accountNumber: null } },
    { id: 3, name: 'Wrong sign', priority: 1, formula: tokenizeCondition('Reason съдържа "ф-ра"'), termText: '', referenceText: '', companyId: null, isOwnAccounts: false, mergeRowsOnImport: false, detail: { sign: 1, accountId: 999, refAccountId: null, accountNumber: null } },
  ];
  const ctx: BankMapContext = {
    bankAccountId: 503, templates, accountByNumber: () => null, isCompanyAccount: (id) => id === 411,
    findCompany: (iban) => (iban === 'BG11UNCR70001512345678' ? { id: 7, name: 'Алфа ООД' } : null),
    isPartnerValue: (v) => v === 'BG11UNCR70001512345678',
  };
  it('mapping applies templates by priority and sign; otherwise the no-template path', () => {
    const rows = parseMt940(MT940)!.rows;
    const extra = { ...rows[1]!, index: 2, reason: 'нещо', props: { ...rows[1]!.props, Reason: 'нещо' } };
    const mapped = mapStatementRows([...rows, extra], ctx);
    // Row 1 is an inflow: template 3 (sign +1) matches the formula but not the direction.
    expect(mapped[0]).toMatchObject({ templateId: 2, debitAccountId: 503, creditAccountId: 411, companyId: 7, term: 'Плащане от клиент', postAmount: '150.50' });
    expect(mapped[1]).toMatchObject({ templateId: 1, debitAccountId: 629, creditAccountId: 503, term: 'Банкова такса' });
    expect(mapped[2]).toMatchObject({ templateId: null, debitAccountId: null, creditAccountId: 503, warnings: ['strNoBankTemplateWarning'] });
    const merged = mergeBankRows([mapped[1]!, { ...mapped[1]!, index: 9, amount: '5.00', postAmount: '5.00' }], 'all', new Set([1]));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.postAmount).toBe('25.00');
  });
  it('row validation', () => {
    const info = (id: number) => ({ isLeaf: id !== 50, isCompany: id === 411 });
    const keys = (r: Parameters<typeof validateBankRow>[0]) => validateBankRow(r, { activeYear: 2026, accountInfo: info }).map((m) => m.key);
    expect(keys({ date: '2026-03-02', debitAccountId: 503, creditAccountId: 411, postAmount: '1', companyId: 7, companyName: '' })).toEqual([]);
    expect(keys({ date: '2025-03-02', debitAccountId: null, creditAccountId: 411, postAmount: '0', companyId: null, companyName: 'Х' })).toEqual(['strMissingValidDebitAccount', 'strWrongAccountingDate', 'strMissingValidDebitAndCreditAmount', 'strCompanyNotFound']);
    expect(keys({ date: '2026-03-02', debitAccountId: 50, creditAccountId: 503, postAmount: '1', companyId: null, companyName: '' })).toEqual(['strHelpSelectBankAccount']);
  });
  it('invoice numbers: "ф-ра 123/ 2026" -> 0000123', () => {
    const nums = extractStatementInvoiceNumbers('Плащане по ф-ра 123/ 2026', ['ф-ра', 'фактура']);
    expect(nums.has('0000123')).toBe(true);
    expect(normalizeDocumentNumber('0000000123')).toBe('0000123');
    expect(normalizeDocumentNumber('А-15')).toBe('000000А-15');
  });
  it('sum bind: {100, 50} before {150}', () => {
    expect(firstExactSubset(['100', '50', '150'], '150')).toEqual([0, 1]);
    expect(firstExactSubset(['100', '60'], '150')).toEqual([]);
    const docs = [{ accountingId: 1, documentNumber: '0000000999', amount: '100', isInvoice: true }, { accountingId: 2, documentNumber: '0000000123', amount: '150', isInvoice: true }];
    expect(autoBindDocuments('ф-ра 123', '150', docs, ['ф-ра'], false)).toEqual([1]);
    expect(autoBindDocuments('без номер', '100', docs, ['ф-ра'], true)).toEqual([0]);
  });
  it('currency recalculation', () => {
    expect(bankRecalc.base('100', '1.95583')).toBe('195.58');
    expect(bankRecalc.currency('195.58', '1.95583')).toBe('100.00');
    expect(bankRecalc.rate('195.58', '100')).toBe('1.9558');
  });
});

describe('ТРЗ Pro feed (04a 6)', () => {
  const feed = [
    'Month;Code;Name;ZaplTrudoviIDUK;VuznagrajdenieOtraboteniDni;DtZaplTrudoviIDUK;KtZaplTrudoviIDUK',
    '03.2026;001;Администрация;1000;900;604/1;421',
    '03.2026;001001;Счетоводство;500;450;604/1;421',
    '02.2026;002;Склад;300;300;604/1;421',
  ].join('\n');
  it('parses, lists months and aggregates by level', () => {
    const rows = parseTrzFeed(feed);
    expect(rows).toHaveLength(3);
    expect(trzAvailableMonths(rows, 2026)).toEqual(['2026-02', '2026-03']);
    const top = trzAggregate(rows, '2026-03', 0);
    expect(top).toHaveLength(1);
    expect(top[0]!.amounts[10100]).toBe('1500.00');
    expect(trzAggregate(rows, '2026-03', 1)).toHaveLength(2);
  });
  it('grid by details replaces 10100 by its detail rows', () => {
    const top = trzAggregate(parseTrzFeed(feed), '2026-03', 0);
    const plain = trzGrid(top, false);
    const detailed = trzGrid(top, true);
    expect(plain.find((r) => r.itemId === 10100)).toMatchObject({ amount: '1500.00', debit: '604/1', credit: '421' });
    expect(detailed.find((r) => r.itemId === 10100)).toBeUndefined();
    expect(detailed.find((r) => r.itemId === 10101)).toMatchObject({ amount: '1350.00', debit: '604/1' });
    expect(TRZ_ITEMS).toHaveLength(33);
  });
  it('default term, date and date check', () => {
    expect(trzDefaultTerm('2026-03')).toBe('Заплати за м. 03.2026');
    expect(trzDefaultAccountingDate('2026-02')).toBe('2026-02-28');
    expect(trzAccountingDateValid('2026-02-27', '2026-03', 2026)).toBe(false);
    expect(trzAccountingDateValid('2026-03-31', '2026-03', 2026)).toBe(true);
  });
});

describe('Excel import (04a 5)', () => {
  const accounts: Record<string, ExcelAccountInfo> = {
    '602': { id: 602, number: '602', categoryId: 38, isForeignCurrency: false, isMaterial: false, isLeaf: true },
    '601': { id: 601, number: '601', categoryId: 37, isForeignCurrency: false, isMaterial: false, isLeaf: true },
    '401': { id: 401, number: '401', categoryId: 4, isForeignCurrency: false, isMaterial: false, isLeaf: true },
    '403': { id: 403, number: '403', categoryId: null, isForeignCurrency: false, isMaterial: false, isLeaf: true },
    '304': { id: 304, number: '304', categoryId: 3, isForeignCurrency: false, isMaterial: true, isLeaf: true },
    '4531': { id: 4531, number: '453/1', categoryId: 16, isForeignCurrency: false, isMaterial: false, isLeaf: true },
  };
  const ctx: ExcelOperationsContext = {
    activeYear: 2025, account: (n) => accounts[n] ?? null, vatPurchaseAccount: accounts['4531']!, vatSaleAccount: null,
    documentTypeByShortName: (s) => (s === 'Ф-ра' ? 1 : null), viesIds: new Set([1, 2, 3]), icaTypeIds: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    hasIcaColumns: true, protocolDocumentTypeId: 9, invoiceDocumentTypeId: 1,
  };
  const letters: Record<string, string> = { Accounts: 'A', Sums: 'B', Date: 'C', Partner: 'D', VATOperation: 'E', Term: 'F', DocumentType: 'G', DocumentNumber: 'H', OperationType: 'I', ICATerm: 'J', OperationGoodType: 'K' };
  const row = (cells: Record<string, string | number>) => (k: string) => cells[k];
  const letter = (k: string) => letters[k] ?? 'Z';
  it('602%-401 120.00 with VAT term 7 -> Dt 602 100 / Dt ДДС покупки 20 / Ct 401 120', () => {
    const d = parseExcelOperationRow(row({ Accounts: '602%-401', Sums: '120.00', Date: '15.03.2025', Partner: 'Алфа', VATOperation: '7-x', Term: 'Покупка' }), letter, 3, ctx);
    expect(d.debits.map((l) => [l.account.number, l.amount])).toEqual([['602', '100.00'], ['453/1', '20.00']]);
    expect(d.credits.map((l) => [l.account.number, l.amount])).toEqual([['401', '120.00']]);
    expect(d.accountingDate).toBe('2025-03-15');
  });
  it('"100;50::150" with 601;602-401 is accepted, "::140" is not', () => {
    const ok = parseExcelOperationRow(row({ Accounts: '601;602-401', Sums: '100;50::150', Date: '15.03.2025', Partner: 'Алфа' }), letter, 3, ctx);
    expect(ok.debits.map((l) => l.amount)).toEqual(['100.00', '50.00']);
    expect(errorKeys(() => parseExcelOperationRow(row({ Accounts: '601;602-401', Sums: '100;50::140', Date: '15.03.2025', Partner: 'Алфа' }), letter, 3, ctx))).toEqual(['strInvalidDebitCreditAmounts']);
  });
  it('row errors', () => {
    const base = { Accounts: '601-401', Sums: '10', Date: '15.03.2025', Partner: 'Алфа' };
    const k = (over: Record<string, string>) => errorKeys(() => parseExcelOperationRow(row({ ...base, ...over }), letter, 3, ctx));
    expect(k({ Sums: '10;20' })).toEqual(['strInvalidAccountingSumsInExcel']);
    expect(k({ Sums: 'abc' })).toEqual(['strInvalidDataFormatInExcelCell']);
    expect(k({ Date: '15.03.2024' })).toEqual(['strOperationDateInDifferentFY']);
    expect(k({ Accounts: '601' })).toEqual(['strInvalidDataFormatInExcelCell']);
    expect(k({ Accounts: '999-401' })).toEqual(['strAccountNotFound']);
    expect(k({ Partner: '' })).toEqual(['strInvalidPartnerField']);
    expect(k({ DocumentNumber: '12' })).toEqual(['strDocumentTypeMissingError']);
    expect(k({ VATOperation: '2-покупка', Term: '' })).toEqual(['strInvalidTermInRowField']);
    expect(k({ VATOperation: '99-x' })).toEqual(['strInvalidVatTermInExcel']);
    expect(k({ Accounts: '304-401', Sums: '10' })).toEqual(['strInvalidMaterialCurrencyAccountInExcelCell']);
    expect(k({ Accounts: '601;602-401;403', Sums: '1;1' })).toEqual(['strInvalidDataFormatInExcelCell']);
    expect(k({ OperationType: '3-x', Term: '' })).toEqual(['strInvalidTermInRowField']);
  });
  it('a VAT rate on a pair without a "%" side is strVATNotAllowedInOperationErrorWithRowNumber (5.3 VAT split)', () => {
    const base = { Accounts: '602-401', Sums: '120', Date: '15.03.2025', Partner: 'Алфа', Term: 'x' };
    let msgs: string[] = [];
    try {
      parseExcelOperationRow(row({ ...base, VATOperation: '2-покупка' }), letter, 3, ctx);
    } catch (e) {
      msgs = (e as DataImportError).messages.map((m) => `${m.key}: ${m.text}`);
    }
    expect(msgs).toEqual(['strVATNotAllowedInOperationErrorWithRowNumber: Грешка при импортирането на ред 3 от файла. В избрания тип операция не се използват ДДС сметки, а има начислен ДДС 20.00 лв.']);
    // Per pair: the second pair's term (20 %) fails even when the first is VAT-free.
    expect(errorKeys(() => parseExcelOperationRow(row({ ...base, Accounts: '601;602-401', Sums: '20;100', VATOperation: '1-x;2-покупка' }), letter, 3, ctx))).toEqual(['strVATNotAllowedInOperationErrorWithRowNumber']);
    // A "%" side or a rate-free term is fine.
    expect(parseExcelOperationRow(row({ ...base, Accounts: '602%-401', VATOperation: '2-покупка' }), letter, 3, ctx).debits.map((l) => l.amount)).toEqual(['100.00', '20.00']);
    expect(parseExcelOperationRow(row({ ...base, VATOperation: '3-x' }), letter, 3, ctx).debits.map((l) => l.amount)).toEqual(['120.00']);
  });
  it('no-VAT term with empty term imports; material analytics', () => {
    const d = parseExcelOperationRow(row({ Accounts: '304-401', Sums: '10(5|2)', Date: '15.03.2025', Partner: 'Алфа', VATOperation: '1-x' }), letter, 3, ctx);
    expect(d.debits[0]).toMatchObject({ quantity: '5', price: '2', amount: '10.00' });
    expect(d.term).toBe('');
  });
  it('ICA protocol default terms', () => {
    const d = parseExcelOperationRow(row({ Accounts: '601-401', Sums: '10', Date: '15.03.2025', Partner: 'Алфа', OperationType: '1-ВОП', Term: 'x' }), letter, 3, ctx);
    expect(d.ica!.term).toBe('Самоначисляване на ДДС при ВОП');
    expect(d.ica!.documentTypeId).toBe(9);
    const bread = parseExcelOperationRow(row({ Accounts: '601-401', Sums: '10', Date: '15.03.2025', Partner: 'Алфа', OperationType: '8-x', OperationGoodType: '7-хляб', Term: 'x' }), letter, 3, ctx);
    expect(bread.ica!.term).toBe(msg('strDefaultBreadTerm'));
    expect(bread.ica!.vatDiaryCode).toBe('07');
    expect(icaDefaultTerm(6, 0)).toBeNull();
  });
  it('mapping validation', () => {
    const cols = { Accounts: 'A', Sums: 'B', Date: 'C', Partner: 'D', PartnerBulstat: 'E', PartnerVatNumber: 'F', PartnerIBAN: 'G', DocumentNumber: 'H', DocumentType: 'I', DocumentDate: 'J', Term: 'K', Reference: 'L', OptionalReference: 'M', VATOperation: 'N', VIES: 'O', VIESMonth: 'P' };
    expect(validateExcelMapping('operations', { sheetName: 'S1', startingRow: 2, endingRow: 10, columns: cols }, ['S1'])).toEqual([]);
    const bad = validateExcelMapping('operations', { sheetName: 'S1', startingRow: 70000, endingRow: 10, columns: { ...cols, Sums: '1A', Date: '' } }, ['S1']);
    expect(bad.map((m) => m.key)).toEqual(['strInvalidColumnSetting', 'strInvalidColumnSetting', 'strEmptyColumnSetting']);
    expect(columnIndex('A')).toBe(1);
    expect(columnIndex('ZZ')).toBe(702);
    expect(columnIndex('AAA')).toBeNull();
    expect(columnLetters(28)).toBe('AB');
  });
  it('setup sheet, direction, character, dates', () => {
    const cells: Record<string, string> = { '1,1': 'Sheet с данни', '1,2': 'Данни', '2,1': 'Начален ред', '2,2': '2', '3,1': 'Колона за сметки', '3,2': 'a' };
    const sheet: ExcelSheet = { name: 'Настройка Операции', rowCount: 3, cell: (r, c) => cells[`${r},${c}`] };
    expect(readSetupSheet('operations', sheet)).toMatchObject({ sheetName: 'Данни', startingRow: 2, columns: { Accounts: 'A' } });
    expect(parseDirection('КТ')).toBe(-1);
    expect(parseDirection('дебит')).toBe(1);
    expect(parseDirection('x')).toBeNull();
    expect(parseCharacter('2-Пасивна')).toEqual({ ok: true, isActive: false });
    expect(parseCharacter('3')).toEqual({ ok: false, isActive: null });
    expect(cellDate(46096)).toBe('2026-03-15');
    expect(fromOADate(45000)).toBe('2023-03-15');
    expect(parseImportDate('5.3.2026')).toBe('2026-03-05');
  });
});

describe('euro conversion (04b 4)', () => {
  it('worked examples', () => {
    expect(toEuro('100').toFixed(2)).toBe('51.13');
    expect(toEuro('0.01').toFixed(2)).toBe('0.01');
    expect(toEuro('0').toFixed(2)).toBe('0.00');
    expect(toEuro('-100').toFixed(2)).toBe('-51.13');
  });
  it('openings are converted per side and equalised on the differences account', () => {
    const map = new Map([[1, 11], [2, 12], [3, 13]]);
    const r = convertOpenings([{ accountId: 1, debit: '100', credit: '0' }, { accountId: 2, debit: '0', credit: '50' }, { accountId: 3, debit: '0', credit: '50' }], map, 99);
    expect(r.lines).toEqual([{ accountId: 11, debit: '51.13', credit: '0.00' }, { accountId: 12, debit: '0.00', credit: '25.56' }, { accountId: 13, debit: '0.00', credit: '25.56' }]);
    expect(r.difference).toEqual({ accountId: 99, debit: '0.00', credit: '0.01' });
    expect(accountDifference('51.13', '0', '100', '0').toFixed(2)).toBe('0.00');
  });
  it('default mapping by number (cash in base currency too); relations override, null leaves unmapped', () => {
    const bgn = [{ id: 1, number: '501', categoryId: 21 }, { id: 2, number: '411', categoryId: 10 }, { id: 3, number: '999', categoryId: null }];
    const eur = [{ id: 11, number: '501', categoryId: 21 }, { id: 12, number: '411', categoryId: 10 }];
    expect([...defaultEuroMapping(bgn, eur, { 3: 12 }).entries()]).toEqual([[1, 11], [2, 12], [3, 12]]);
    expect([...defaultEuroMapping(bgn, eur, { 1: null }).entries()]).toEqual([[2, 12]]);
  });
  it('opening kinds and their conversion (04b 4 per-account detail conversion)', () => {
    const cur = { bgn: 1, eur: 2 };
    expect(euroBalanceKind({ categoryId: 21, currencyId: 1 }, cur)).toBe('cash');
    expect(euroBalanceKind({ categoryId: 26, currencyId: 2 }, cur)).toBe('eur');
    expect(euroBalanceKind({ categoryId: 27, currencyId: 3 }, cur)).toBe('foreign');
    expect(euroBalanceKind({ categoryId: 3, currencyId: 1, productId: 7 }, cur)).toBe('material');
    expect(euroBalanceKind({ categoryId: 10, currencyId: 1 }, cur)).toBe('bgn');
    const f = { priceDecimals: 3, rateDecimals: 5 };
    const sides = (d: string, c: string, cd = '0', cc = '0', qd = '0', qc = '0') => ({ debit: d, credit: c, curDebit: cd, curCredit: cc, qtyDebit: qd, qtyCredit: qc });
    const show = (x: ReturnType<typeof convertBalanceToEuro>) => [x.debit.toFixed(2), x.credit.toFixed(2), x.curDebit.toFixed(2), x.curCredit.toFixed(2), x.rate?.toString() ?? null, x.fixedRate?.toString() ?? null, x.price?.toString() ?? null];
    // Cash: EUR amount, the leva as a BGN currency detail with FixedRate 1.
    expect(show(convertBalanceToEuro('cash', sides('1000', '0'), f))).toEqual(['511.29', '0.00', '1000.00', '0.00', '0.51129', '1', null]);
    // Foreign: the rate is recalculated, the amount follows the currency amount (not 180000 / 1.95583 = 92032.54).
    expect(show(convertBalanceToEuro('foreign', sides('180000', '0', '100000'), f))).toEqual(['92033.00', '0.00', '100000.00', '0.00', '0.92033', null, null]);
    // ... and without a currency amount the plain conversion is the fallback.
    expect(show(convertBalanceToEuro('foreign', sides('0', '19.56'), f))).toEqual(['0.00', '10.00', '0.00', '0.00', null, null, null]);
    // Material: price rounded to PriceFormat, amount = price x quantity (1000 x 0.511 = 511.00, not 1000 / 1.95583 = 511.29).
    expect(show(convertBalanceToEuro('material', sides('1000', '0', '0', '0', '1000'), f))).toEqual(['511.00', '0.00', '0.00', '0.00', null, null, '0.511']);
    expect(show(convertBalanceToEuro('material', sides('10', '0'), f))).toEqual(['5.11', '0.00', '0.00', '0.00', null, null, null]);
    // BGN converted per side; EUR accounts copy their currency amounts.
    expect(show(convertBalanceToEuro('bgn', sides('100', '0.01'), f))).toEqual(['51.13', '0.01', '0.00', '0.00', null, null, null]);
    expect(show(convertBalanceToEuro('eur', sides('195.58', '0', '100'), f))).toEqual(['100.00', '0.00', '0.00', '0.00', null, null, null]);
    // ... and an EUR account without currency amounts (Delta conversion) keeps its leva at the fixed rate.
    expect(show(convertBalanceToEuro('eur', sides('1955.83', '0'), f))).toEqual(['1000.00', '0.00', '0.00', '0.00', null, null, null]);
  });
});

describe('backup names (01b 2)', () => {
  it('builds and parses "<product> - <company> - dd.MM.yyyy_HH.mm"', () => {
    const name = backupFileName('„Алфа/Бета“ ООД', new Date(2026, 9, 18, 14, 5));
    expect(name).toBe('Shmelta Pro - Алфа-Бета ООД - 18.10.2026_14.05.shbak');
    expect(parseBackupFileName(name)).toEqual({ product: 'Shmelta Pro', company: 'Алфа-Бета ООД', date: '2026-10-18', time: '14:05' });
    expect(parseBackupFileName('random.zip')).toBeNull();
    expect(sanitizeCompanyName('A"B\\C*')).toBe('AB-C');
    expect(compareVersions('1.01.089', '1.01.100')).toBe(-1);
    expect(compareVersions('1.01.089', '1.01.089')).toBe(0);
  });
});

describe('report exports (04a 8.3)', () => {
  const def = `<ExportReport xmlns="http://schemas.microinvest.net/ExportReports" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
    <Name>Партньори</Name><Description>Списък</Description>
    <Parameters><ExportReportParameter><Name>@from</Name><Title>От дата</Title><Type>DateTime</Type></ExportReportParameter></Parameters>
    <Documents>
      <ExportDocument i:type="CSVExportDocument"><Name>p</Name><FileNameFormat>partners_{0:yyyyMM}</FileNameFormat><Query>select name from t where d &gt;= @from and x = '@from'</Query><Separator>|</Separator></ExportDocument>
      <ExportDocument i:type="ExcelExportDocument"><Name>x</Name><Query>select 1 as a</Query></ExportDocument>
    </Documents></ExportReport>`;
  it('parses definitions, binds parameters outside literals, names files', () => {
    const r = parseExportReport(def);
    expect(r.documents.map((d) => d.kind)).toEqual(['csv', 'excel']);
    const b = bindNamedParameters(r.documents[0]!.query, { '@from': '2026-01-01' });
    expect(b.sql).toBe("select name from t where d >= $1 and x = '@from'");
    expect(b.params).toEqual(['2026-01-01']);
    expect(exportFileName(r.documents[0]!, r, { '@from': '2026-03-05' })).toBe('partners_202603.csv');
    expect(errorKeys(() => checkExportParameters(r, {}))).toEqual(['strExportReportParameterNotFilled']);
    expect(isReadOnlyQuery('select 1')).toBe(true);
    expect(isReadOnlyQuery('delete from x')).toBe(false);
    expect(isReadOnlyQuery('select 1; drop table x')).toBe(false);
  });
  it('protected names in an export query', () => {
    expect(forbiddenQueryReference('select name, password_hash from users')).toBe('users');
    expect(forbiddenQueryReference('select u.name from public."USERS" u')).toBe('users');
    expect(forbiddenQueryReference('select value from configuration where key = @k')).toBe('configuration');
    expect(forbiddenQueryReference("select pg_read_file('/etc/passwd')")).toBe('pg_read_file');
    expect(forbiddenQueryReference('select $q$x$q$')).toBe('$$');
    expect(forbiddenQueryReference("select 'users', number from accounts -- users\n /* configuration */")).toBeNull();
    expect(forbiddenQueryReference('select number, description from accounts where is_euro')).toBeNull();
  });
  it('CSV has a trailing separator on every line', () => {
    expect(writeExportCsv([{ a: 1, b: 'x' }, { a: 2, b: null }], ';')).toBe('1;x;\r\n2;;\r\n');
  });
});
