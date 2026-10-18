import { describe, expect, it } from 'vitest';
import {
  budgetReasonByPaymentType, documentSumToText, emptyPaymentDocument, encodeWindows1251, exportToUbb, fieldSheet, findBankByIban,
  formattedQtty, ibanChangePatch, isPaymentDocumentBulstatValid, isPaymentDocumentEgnValid, isPaymentDocumentIbanValid,
  isPaymentDocumentLnchValid, limitPaymentDocumentFields, listColumns, paymentTypeChangePatch, PAYMENT_DOCUMENT_TYPES_DEF,
  ubbRecord, validatePaymentDocument, type ExportCandidate, type PaymentDocumentFields,
} from '../src/index.ts';

const IBAN = 'BG80BNBG96611020345678';
const UBB_IBAN = 'BG89UBBS80021087654321';
const BANKS = [
  { code: 'BNBGBGSF', name: 'Българска народна банка' },
  { code: 'UBBSBGSF', name: 'Обединена българска банка' },
  { code: 'BPBIBGSF', name: 'Юробанк България' },
];

const doc = (p: Partial<PaymentDocumentFields>): PaymentDocumentFields => ({ ...emptyPaymentDocument(), ...p });
const keys = (type: number, d: Partial<PaymentDocumentFields>) => validatePaymentDocument(type, d).map((m) => m.key);

/** A complete OrderCredit that passes every check, ready for the UBB file. */
const credit = (p: Partial<PaymentDocumentFields> = {}): PaymentDocumentFields => doc({
  personName: 'Доставчик ООД', personIban: IBAN, personBic: 'BNBGBGSF', personBank: 'БНБ', currency: 'EUR', qtty: '120.50',
  reason: 'Фактура 17', reasonEx: 'от 01.02.2026', customer: 'Моята фирма', customerIban: UBB_IBAN, customerBic: 'UBBSBGSF', ...p,
});
const budgetDue = (p: Partial<PaymentDocumentFields> = {}): PaymentDocumentFields => doc({
  personName: 'НАП', personIban: IBAN, personBic: 'BNBGBGSF', personBank: 'БНБ', paymentType: 110000, currency: 'EUR', qtty: '50',
  reason: 'Данък по ЗДДФЛ', duePerson: 'Моята фирма', bulstat: '175074752', customer: 'Моята фирма', customerIban: UBB_IBAN,
  customerBic: 'UBBSBGSF', ...p,
});

describe('IBAN check of the payment documents (02c 1.4.1, acceptance 2)', () => {
  it('accepts a valid IBAN with or without spaces', () => {
    expect(isPaymentDocumentIbanValid(IBAN)).toBe(true);
    expect(isPaymentDocumentIbanValid('BG80 BNBG 9661 1020 3456 78')).toBe(true);
    expect(isPaymentDocumentIbanValid(UBB_IBAN)).toBe(true);
  });
  it('rejects lower case, other separators, wrong check digits and short strings (bug-compatible)', () => {
    expect(isPaymentDocumentIbanValid(IBAN.toLowerCase())).toBe(false);
    expect(isPaymentDocumentIbanValid('BG80-BNBG-9661-1020-3456-78')).toBe(false);
    expect(isPaymentDocumentIbanValid('BG81BNBG96611020345678')).toBe(false);
    expect(isPaymentDocumentIbanValid('BG8')).toBe(false);
  });
  it('has no country or length check', () => {
    // Same BBAN under another country code with matching check digits is still "valid".
    expect(isPaymentDocumentIbanValid('GB82WEST12345698765432')).toBe(true);
  });
});

describe('EGN, ЛНЧ, Булстат (02c 1.4.2, acceptance 3)', () => {
  it('Bulstat accepts only 9 digits', () => {
    expect(isPaymentDocumentBulstatValid('175074752')).toBe(true);
    expect(isPaymentDocumentBulstatValid('175074753')).toBe(false);
    expect(isPaymentDocumentBulstatValid('1750747520001')).toBe(false);
    expect(keys(5, budgetDue({ bulstat: '1750747520001' }))).toEqual(['strNonValidBulstat']);
    expect(keys(5, budgetDue({ bulstat: '175074752' }))).toEqual([]);
  });
  it('Bulstat second-weight branch (first remainder 10)', () => {
    expect(isPaymentDocumentBulstatValid('111111113')).toBe(true);
    // 4 * 8 = 32 mod 11 = 10 -> second weights: 4 * 10 = 40 mod 11 = 7.
    expect(isPaymentDocumentBulstatValid('000000047')).toBe(true);
    expect(isPaymentDocumentBulstatValid('000000040')).toBe(false);
  });
  it('EGN without birth-date check, ЛНЧ mod 10', () => {
    expect(isPaymentDocumentEgnValid('7501010010')).toBe(true);
    // Month 99 is not a date, but the payment-document check ignores it.
    expect(isPaymentDocumentEgnValid('7599010006')).toBe(true);
    expect(isPaymentDocumentEgnValid('7501010011')).toBe(false);
    expect(isPaymentDocumentLnchValid('1001000004')).toBe(true);
    expect(isPaymentDocumentLnchValid('1001000005')).toBe(false);
  });
});

describe('validation matrix (02c 1.4)', () => {
  it('OrderCredit: Qtty "0" gives strQttyIsZero as NonCritical (acceptance 1)', () => {
    const m = validatePaymentDocument(3, credit({ qtty: '0' }));
    expect(m).toEqual([{ key: 'strQttyIsZero', text: 'Сумата на документа трябва да е по-голяма от нула!', severity: 'warning' }]);
  });
  it('every message is NonCritical', () => {
    for (const t of [1, 2, 3, 4, 5, 6, 8]) {
      const m = validatePaymentDocument(t, {});
      expect(m.length).toBeGreaterThan(0);
      expect(m.every((x) => x.severity === 'warning')).toBe(true);
    }
  });
  it('empty documents list the checks in the original order', () => {
    expect(keys(1, {})).toEqual(['strOrderPersonIBANIsEmpty', 'strOrderPersonNameMissing', 'strOrderPersonBankIsEmpty', 'strQttyIsEmpty']);
    expect(keys(2, {})).toEqual(['strQttyIsEmpty', 'strSenderIsEmpty', 'strBeneficiaryPersonIBANIsEmpty', 'strBeneficiaryPersonNameMissing', 'strBeneficiaryPersonBankIsEmpty']);
    expect(keys(3, {})).toEqual([
      'strOrderPersonIBANIsEmpty', 'strOrderPersonNameMissing', 'strTrasferMoneyReasonIsEmpty', 'strBeneficiaryPersonIBANIsEmpty',
      'strBeneficiaryPersonNameMissing', 'strBeneficiaryPersonBankIsEmpty', 'strQttyIsEmpty',
    ]);
    expect(keys(4, {})).toEqual([
      'strOrderDebitPersonNameMissing', 'strOrderDebitPersonIBANIsEmpty', 'strOrderDebitPersonBankIsEmpty', 'strBeneficiaryPersonNameMissing',
      'strBeneficiaryPersonIBANIsEmpty', 'strTrasferMoneyReasonIsEmpty', 'strQttyIsEmpty',
    ]);
    expect(keys(5, {})).toEqual([
      'strPaymentTypeIsEmpty', 'strBeneficiaryPersonNameMissing', 'strBeneficiaryPersonIBANIsEmpty', 'strBeneficiaryPersonBankIsEmpty',
      'strBudgetReasonIsEmpty', 'strDuePersonIsEmpty', 'strOrderPersonNameMissing', 'strOrderPersonIBANIsEmpty', 'strQttyIsEmpty',
    ]);
    // BudgetOrder has no Reason and no orderer IBAN check.
    expect(keys(6, {})).toEqual([
      'strPaymentTypeIsEmpty', 'strBeneficiaryPersonNameMissing', 'strBeneficiaryPersonIBANIsEmpty', 'strDuePersonIsEmpty',
      'strOrderPersonNameMissing', 'strQttyIsEmpty',
    ]);
    expect(keys(8, {})).toEqual(['strBeneficiaryPersonIBANIsEmpty', 'strSenderIsEmpty', 'strQttyIsEmpty']);
    expect(keys(7, {})).toEqual([]);
  });
  it('invalid IBANs use the IsInvalid key of the role', () => {
    expect(keys(1, { personIban: 'BG00X', personName: 'a', personBank: 'b', qtty: '1' })).toEqual(['strOrderPersonIBANIsInvalid']);
    expect(keys(4, { personName: 'a', personIban: 'bad', personBank: 'b', customer: 'c', customerIban: IBAN, reason: 'r', qtty: '1' }))
      .toEqual(['strOrderDebitPersonIBANIsInvalid']);
    expect(keys(3, credit({ personIban: IBAN.toLowerCase() }))).toEqual(['strBeneficiaryPersonIBANIsInvalid']);
  });
  it('Order: EGN, ID number length; negative and unparseable amounts', () => {
    const base = { personIban: IBAN, personName: 'a', personBank: 'b', qtty: '1' };
    expect(keys(1, base)).toEqual([]);
    expect(keys(1, { ...base, egn: '1234567891', idNumber: '1234567890' })).toEqual(['strInvalidEGN', 'strIDNumberTooLong']);
    expect(keys(1, { ...base, qtty: '-5' })).toEqual(['strQttyIsZero']);
    expect(keys(1, { ...base, qtty: 'abc' })).toEqual(['strQttyIsZero']);
    expect(keys(1, { ...base, qtty: '12,50' })).toEqual([]);
  });
  it('Taxes outside 1..3 and the due-person rule', () => {
    expect(keys(3, credit({ taxes: 2 }))).toEqual([]);
    expect(keys(3, credit({ taxes: 4 }))).toEqual(['strTaxInvalidValue']);
    expect(keys(3, credit({ taxes: 0 }))).toEqual(['strTaxInvalidValue']);
    // DuePerson empty is fine when the orderer is given.
    expect(keys(5, budgetDue({ duePerson: null }))).toEqual([]);
    expect(keys(5, budgetDue({ duePerson: null, customer: null }))).toEqual(['strDuePersonIsEmpty', 'strOrderPersonNameMissing']);
    // Any non-null payment type is accepted.
    expect(keys(5, budgetDue({ paymentType: 42 }))).toEqual([]);
    expect(keys(6, budgetDue({ egn: '7501010011', lnch: '1001000005' }))).toEqual(['strInvalidEGN', 'strInvalidLNCH']);
  });
  it('the currency check never fires because the getter defaults to EUR', () => {
    expect(keys(3, credit({ currency: '' }))).toEqual([]);
  });
});

describe('IBAN -> bank (02c 1.5)', () => {
  it('matches the BIC prefix with IBAN characters 5-8 after normalising', () => {
    expect(findBankByIban('bg80 bnbg-9661.1020345678', BANKS)?.code).toBe('BNBGBGSF');
    expect(findBankByIban(UBB_IBAN, BANKS)?.name).toBe('Обединена българска банка');
    expect(findBankByIban('BG80XXXX96611020345678', BANKS)).toBeNull();
    expect(findBankByIban('BG80BNB', BANKS)).toBeNull();
  });
  it('Paysera special cases', () => {
    expect(findBankByIban('EVP8610001234567', BANKS)?.code).toBe('EVIULT2V');
    expect(findBankByIban('LT12350001234567890', BANKS)?.code).toBe('EVIULT2V');
    expect(findBankByIban('BG12BPBI79421200006000', BANKS)?.code).toBe('EVIULT2V');
    expect(findBankByIban('BG12BPBI79421200106002', BANKS)?.code).toBe('BPBIBGSF');
    expect(findBankByIban('BG12BPBI79401200006000', BANKS)?.code).toBe('BPBIBGSF');
  });
  it('fills BIC and bank name from the IBAN', () => {
    expect(ibanChangePatch('personIban', IBAN, BANKS)).toEqual({ personBic: 'BNBGBGSF', personBank: 'Българска народна банка' });
    expect(ibanChangePatch('customerIban', UBB_IBAN, BANKS)).toEqual({ customerBic: 'UBBSBGSF' });
    expect(ibanChangePatch('personIban', 'BG', BANKS)).toEqual({});
  });
});

describe('amount, words, budget helpers (02c 1.3, 1.9, 1.10)', () => {
  it('Currency EUR, Qtty "123.45" gives the words (acceptance 7)', () => {
    expect(documentSumToText('123.45', 'EUR')).toBe('сто двадесет и три евро и 45 цента');
    // Empty currency falls back to EUR.
    expect(documentSumToText('2', '')).toBe('два евро');
    expect(documentSumToText('', 'EUR')).toBe('');
  });
  const vectors: [string, string, string][] = [
    ['0.50', 'EUR', 'нула евро и 50 цента'],
    ['1.00', 'EUR', 'един евро'],
    ['1.00', 'BGN', 'един лв.'],
    ['2.00', 'EUR', 'два евро'],
    ['123.45', 'EUR', 'сто двадесет и три евро и 45 цента'],
    ['300', 'BGN', 'триста лв.'],
    ['1000.01', 'BGN', 'хиляда лв. и 1 ст.'],
    ['1001', 'EUR', 'хиляда и един евро'],
    ['1100', 'USD', 'хиляда и сто долара'],
    ['1105', 'GBP', 'хиляда сто и пет лири'],
    ['1121', 'CHF', 'хиляда сто двадесет и един франка'],
    ['2000', 'EUR', 'две хиляди евро'],
    ['2345.67', 'EUR', 'две хиляди триста четиридесет и пет евро и 67 цента'],
    ['12345', 'EUR', 'дванадесет хиляди триста четиридесет и пет евро'],
    ['21000', 'EUR', 'двадесет и една хиляди евро'],
    ['101101', 'EUR', 'сто и една хиляди сто и един евро'],
    ['1000000', 'EUR', 'един милион евро'],
    ['1000001', 'EUR', 'един милион и един евро'],
    ['3500000', 'EUR', 'три милиона и петстотин хиляди евро'],
    ['1000000000', 'EUR', 'един милиард евро'],
    ['999999999999', 'EUR', 'деветстотин деветдесет и девет милиарда деветстотин деветдесет и девет милиона деветстотин деветдесет и девет хиляди деветстотин деветдесет и девет евро'],
    ['1000000000000', 'EUR', ''],
    ['1.01', 'USD', 'един долар и 1 цент'],
  ];
  for (const [n, c, expected] of vectors) it(`in words ${n} ${c}`, () => expect(documentSumToText(n, c)).toBe(expected));

  it('FormattedQtty pads with "<" to 13 characters', () => {
    expect(formattedQtty('123.4')).toBe('<<<<<<<123.40');
    expect(formattedQtty('1234567890.5')).toBe('1234567890.50');
    expect(formattedQtty('')).toBe('<<<<<<<<<0.00');
  });
  it('budget reason by payment type', () => {
    expect(budgetReasonByPaymentType(581111)).toBe('Осигурителни вноски за ДЗПО');
    expect(budgetReasonByPaymentType(561111)).toBe('Осигурителни вноски за НЗОК');
    expect(budgetReasonByPaymentType(551111)).toBe('Осигуровки за ДОО, УчПФ и ФГВРС');
    expect(budgetReasonByPaymentType(110000)).toBe('Данък по ЗДДФЛ');
    expect(budgetReasonByPaymentType(123)).toBe('');
    expect(paymentTypeChangePatch(5, 110000)).toEqual({ reason: 'Данък по ЗДДФЛ' });
  });
  it('BudgetOrder with PaymentType 110000 and no NAP data leaves the payee empty (acceptance 4)', () => {
    const d = doc({ paymentType: 110000, ...paymentTypeChangePatch(6, 110000) });
    expect(d.personIban).toBeNull();
    expect(d.personName).toBeNull();
    // With configured NAP data the payee is filled.
    expect(paymentTypeChangePatch(6, 110000, { name: 'НАП', ibanByPaymentType: { 110000: IBAN } })).toEqual({ personName: 'НАП', personIban: IBAN });
  });
  it('save limits strings to 50, or the MaxLength of the view', () => {
    const long = 'я'.repeat(80);
    const c = limitPaymentDocumentFields(3, doc({ reason: long, customer: long, issuePlace: '  София  ' }));
    expect(c.reason).toHaveLength(50);
    expect(c.customer).toHaveLength(50);
    expect(c.issuePlace).toBe('София');
    const b = limitPaymentDocumentFields(6, doc({ reason: long, reasonEx: long, egn: '123456789012' }));
    expect(b.reason).toHaveLength(70);
    expect(b.reasonEx).toHaveLength(70);
    expect(b.egn).toBe('1234567890');
    expect(limitPaymentDocumentFields(1, doc({ idNumber: '1234567890' })).idNumber).toBe('123456789');
  });
  it('catalogue and list columns', () => {
    expect(PAYMENT_DOCUMENT_TYPES_DEF[5].report).toBe('DueDocumentBudget');
    expect(PAYMENT_DOCUMENT_TYPES_DEF[6].report).toBe('OrderDocumentBudget');
    expect(fieldSheet(8).map((f) => f.key)).toContain('controlCode');
    expect(fieldSheet(3).some((f) => f.key === 'inWords')).toBe(false);
    expect(listColumns(1, { personName: 'Иван', autorizedPerson: 'Петър', reason: 'x' })).toEqual({ name: 'Иван', iban: '', reason: 'Петър' });
    expect(listColumns(2, { personName: 'Банка', customer: 'Вносител', reason: 'r' }).name).toBe('Вносител');
  });
});

describe('UBB export (02c 1.8)', () => {
  it('311 record truncates to 35 without padding and ends with ||| CRLF (acceptance 6)', () => {
    const name = 'Много дълго име на получател ЕООД АБВГДЕЖЗ';
    const line = ubbRecord(3, credit({ personName: name }));
    expect(line).toBe(`IBAN311|${name.slice(0, 35)}|${IBAN}|BNBGBGSF|EUR|120.50|Фактура 17|от 01.02.2026|||\r\n`);
    expect(line.endsWith('|||\r\n')).toBe(true);
  });
  it('313 record: currency 3, payment type, Bulstat, EGN; ЛНЧ is not exported', () => {
    const line = ubbRecord(5, budgetDue({ currency: 'EURO', egn: '7501010010', lnch: '1001000004', reasonEx: 'Q1' }));
    expect(line).toBe(`IBAN313|НАП|${IBAN}|BNBGBGSF|EUR|50.00|Данък по ЗДДФЛ|Q1||110000||175074752|7501010010||||||\r\n`);
  });
  const cand = (id: number, d: PaymentDocumentFields, isDeleted = false): ExportCandidate => ({ ...d, id, isDeleted });
  it('refuses when a BudgetDue orderer BIC differs from UBB (acceptance 5)', () => {
    const r = exportToUbb(5, 'UBBSBGSF', [cand(1, budgetDue()), cand(2, budgetDue({ customerBic: 'BNBGBGSF' })), cand(3, budgetDue())]);
    expect(r.ok).toBe(false);
    expect(r.content).toBeUndefined();
    expect(r.messages).toEqual([{ key: 'strBICIsIncorrect', text: 'BIC кода на банката на наредителя не отговаря на избраната банка за експорт!', severity: 'critical', documentId: 2 }]);
  });
  it('BudgetOrder "към ОББ" is not implemented (acceptance 8)', () => {
    expect(exportToUbb(6, 'UBBSBGSF', [cand(1, budgetDue())]).messages.map((m) => m.key)).toEqual(['strPaymentDocumentExportNotImplemented']);
    expect(exportToUbb(3, 'BNBGBGSF', [cand(1, credit())]).messages.map((m) => m.key)).toEqual(['strPaymentDocumentExportNotImplemented']);
  });
  it('needs a bank and a non-deleted document; validation becomes Critical', () => {
    expect(exportToUbb(3, null, [cand(1, credit())]).messages[0]!.key).toBe('strBankNotSelected');
    expect(exportToUbb(3, 'UBBSBGSF', []).messages[0]!.key).toBe('strNoDocumentToExport');
    expect(exportToUbb(3, 'UBBSBGSF', [cand(1, credit(), true)]).messages[0]!.key).toBe('strCannotExportDeletedDocument');
    const r = exportToUbb(3, 'UBBSBGSF', [cand(1, credit({ qtty: '0' }))]);
    expect(r.messages).toEqual([expect.objectContaining({ key: 'strQttyIsZero', severity: 'critical', documentId: 1 })]);
  });
  it('concatenates the records of the non-deleted documents into the schema file', () => {
    const r = exportToUbb(3, 'ubbsbgsf', [cand(1, credit()), cand(2, credit(), true), cand(3, credit({ personName: 'Друг' }))]);
    expect(r.ok).toBe(true);
    expect(r.fileName).toBe('MPLSSAL311.TXT');
    expect(r.content!.split('\r\n')).toHaveLength(3);
    expect(r.content).toContain('IBAN311|Друг|');
  });
  it('Windows-1251 encoding', () => {
    expect([...encodeWindows1251('Аа Яя|1')]).toEqual([0xc0, 0xe0, 0x20, 0xdf, 0xff, 0x7c, 0x31]);
    expect([...encodeWindows1251('Ёё№€\r\n✓')]).toEqual([0xa8, 0xb8, 0xb9, 0x88, 0x0d, 0x0a, 0x3f]);
  });
});
