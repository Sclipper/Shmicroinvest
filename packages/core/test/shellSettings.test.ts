import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS, EMAIL_MESSAGES, SHELL_MESSAGES, VAT_TERM, activityByDocuments, activityDocumentClass, duplicateShortcutWarnings,
  invoicePaymentNumber, maskSecret, parseEmailList, parseVatTermConfig, paymentDocumentTypeFor, reportAttachmentName, shortcutsByType,
  validateReportEmail, validateSmtpSettings, vatAccountMissingNotice, vatRegistrationNotice, vatTermConfigValue, vatTermsFor,
} from '../src/index.ts';

describe('06 3.4 SaleVatTerm / PurchaseVatTerm store the enum name', () => {
  it('round-trips id and name', () => {
    expect(vatTermConfigValue(7)).toBe('Sale20');
    expect(vatTermConfigValue(3)).toBe('PurchaseNoCredit');
    expect(vatTermConfigValue(null)).toBe('');
    expect(vatTermConfigValue(19)).toBe('');
    expect(parseVatTermConfig('Sale9')).toBe(VAT_TERM.Sale9);
    expect(parseVatTermConfig('')).toBeNull();
    expect(parseVatTermConfig('NoSuchTerm')).toBeNull();
  });
  it('accepts the number of older builds and checks the transaction type', () => {
    expect(parseVatTermConfig('11', 3)).toBe(11);
    expect(parseVatTermConfig('Sale20', 2)).toBeNull();
    expect(parseVatTermConfig('PurchasePartialCredit', 2)).toBe(4);
    expect(parseVatTermConfig('AllSales')).toBeNull();
  });
  it('the configured term is the default of the type (02b 1.4)', () => {
    const terms = [2, 3, 4, 7, 11].map((id) => ({ id, transactionTypeId: id < 7 ? 2 : 3 }));
    expect(vatTermsFor(terms, 3, parseVatTermConfig('Sale9', 3)).defaultId).toBe(11);
    expect(vatTermsFor(terms, 3, parseVatTermConfig('', 3)).defaultId).toBe(7);
  });
});

describe('06 3.4 InvoiceAsPaymentDocument', () => {
  it('payment document type', () => {
    expect(paymentDocumentTypeFor('client', true)).toBe(8);
    expect(paymentDocumentTypeFor('supplier', true)).toBe(9);
    expect(paymentDocumentTypeFor('client', false)).toBe(11);
    expect(paymentDocumentTypeFor('client', true, true)).toBe(1);
    expect(paymentDocumentTypeFor('supplier', false, true)).toBe(1);
  });
  it('number of the paid invoice', () => {
    expect(invoicePaymentNumber([null, ' 0000000012 ', '13'])).toBe('0000000012');
    expect(invoicePaymentNumber([])).toBeNull();
  });
});

describe('06 2.6 shortcut printout', () => {
  it('groups by type in a fixed order, no duplicate defaults', () => {
    const g = shortcutsByType([...DEFAULT_SHORTCUTS, { id: 'm', label: 'Контиране', type: 'MainMenu', gesture: 'F2' }]);
    expect(g.map((x) => x.label)).toEqual(['Прозорец (редакция)', 'Прозорец', 'Главно меню']);
    expect(g[1]!.rows.some((r) => r.id === 'Export')).toBe(true);
    expect(g.reduce((n, x) => n + x.rows.length, 0)).toBe(DEFAULT_SHORTCUTS.length + 1);
    expect(shortcutsByType(DEFAULT_SHORTCUTS.filter((r) => r.type === 'WindowReadOnly'))).toHaveLength(1);
    expect(duplicateShortcutWarnings(DEFAULT_SHORTCUTS.map((d) => ({ ...d })))).toEqual([]);
  });
});

describe('01b 8 Действия по потребители: по документи', () => {
  it('classifies document types', () => {
    expect([1, 2, 3, 42].map(activityDocumentClass)).toEqual(['invoice', 'invoice', 'invoice', 'invoice']);
    expect([11, 8, 9, 10, 5, null].map(activityDocumentClass)).toEqual(['bankStatement', 'cashOrder', 'cashOrder', 'memorial', 'other', 'other']);
  });
  it('counts per user, distinct documents, initial balances excluded', () => {
    const rows = [
      { userId: 2, userName: 'Мария', documentId: 1, documentTypeId: 1 },
      { userId: 2, userName: 'Мария', documentId: 1, documentTypeId: 1 },
      { userId: 2, userName: 'Мария', documentId: 2, documentTypeId: 11 },
      { userId: 1, userName: 'Админ', documentId: 3, documentTypeId: 8 },
      { userId: 1, userName: 'Админ', documentId: 4, documentTypeId: 10 },
      { userId: 1, userName: 'Админ', documentId: 5, documentTypeId: 5 },
      { userId: 1, userName: 'Админ', documentId: 6, documentTypeId: 10, isInitialBalance: true },
      { userId: 1, userName: 'Админ', documentId: 7, documentTypeId: 10, isInitialCorrespondence: true },
    ];
    expect(activityByDocuments(rows)).toEqual([
      { userId: 1, userName: 'Админ', invoices: 0, bankStatements: 0, cashOrders: 1, memorials: 1, others: 1, total: 3 },
      { userId: 2, userName: 'Мария', invoices: 2, bankStatements: 1, cashOrders: 0, memorials: 0, others: 0, total: 2 },
    ]);
  });
});

describe('04b 3 report e-mail', () => {
  it('parses address lists', () => {
    expect(parseEmailList(' a@b.bg; c@d.com ,, ')).toEqual(['a@b.bg', 'c@d.com']);
    expect(parseEmailList(null)).toEqual([]);
  });
  it('strInvalidEmailTo / strInvalidEmailCC', () => {
    expect(validateReportEmail({ to: 'a@b.bg', cc: '', subject: 'Оборотна ведомост' })).toEqual([]);
    expect(validateReportEmail({ to: '', subject: 'x' }).map((m) => m.key)).toEqual(['strInvalidEmailTo']);
    expect(validateReportEmail({ to: 'a@b.bg; лошо', subject: 'x' }).map((m) => m.key)).toEqual(['strInvalidEmailTo']);
    expect(validateReportEmail({ to: 'a@b.bg', cc: 'x@', subject: ' ' }).map((m) => m.key)).toEqual(['strInvalidEmailCC', 'strEmailSubjectMissing']);
    expect(EMAIL_MESSAGES.strEmailSendSuccessfully).toBe('Изпращането е успешно!');
  });
  it('SMTP settings and the masked password', () => {
    expect(validateSmtpSettings({ host: 'smtp.abv.bg', port: 465, email: 'office@firma.bg' })).toEqual([]);
    expect(validateSmtpSettings({ host: '', port: '0', email: 'x' }).map((m) => m.key)).toEqual(['strSmtpHostMissing', 'strSmtpPortInvalid', 'strSmtpEmailInvalid']);
    expect(maskSecret('')).toBe('');
    expect(maskSecret('tajna-parola')).toBe('••••••la');
    expect(maskSecret('abc')).not.toContain('abc');
  });
  it('attachment name: short name and end date', () => {
    expect(reportAttachmentName('Оборотна ведомост', '2026-03-31')).toBe('Оборотна ведомост 2026.03.31.xlsx');
    expect(reportAttachmentName('a/b', null)).toBe('a_b.xlsx');
  });
});

describe('06 2.1 Съобщения: start-up notices', () => {
  it('strVATAccountMissing lists the missing VAT accounts', () => {
    expect(vatAccountMissingNotice([16, 17, 35, 36])).toBeNull();
    const n = vatAccountMissingNotice([16, 17])!;
    expect(n.key).toBe('strVATAccountMissing');
    expect(n.text).toBe('Липсват следните ДДС сметки: ДДС за възстановяване, ДДС за внасяне');
  });
  it('VAT registration threshold', () => {
    const base = { isVat: false, isNotVat: false, total: '52000.00', limit: '51130', currency: 'EUR' as const, exceeded: true };
    expect(vatRegistrationNotice(base)!.text).toBe('Оборотът за последните 12 месеца е 52000.00 EUR и достига прага от 51130 EUR за задължителна регистрация по ЗДДС.');
    expect(vatRegistrationNotice({ ...base, isVat: true })).toBeNull();
    expect(vatRegistrationNotice({ ...base, isNotVat: true })).toBeNull();
    expect(vatRegistrationNotice({ ...base, exceeded: false })).toBeNull();
    expect(SHELL_MESSAGES.strChartOfAccountsNotDefined.startsWith('Не е избран тип на сметкоплан!')).toBe(true);
  });
});
