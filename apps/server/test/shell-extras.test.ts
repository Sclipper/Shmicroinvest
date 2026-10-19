import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nodemailer from 'nodemailer';
import { sql } from 'drizzle-orm';
import { queryRows } from '../src/db/provider.ts';
import { createTestCompany, type TestCompany } from './helpers.ts';
import { MAIL_OUTBOX, decryptSecret, setMailTransportFactory } from '../src/services/email.ts';

/**
 * Settings gaps (06 3.4: InvoiceAsPaymentDocument, SaleVatTerm/PurchaseVatTerm),
 * the "Съобщения" notices (06 2.1, 02b 12 strVATAccountMissing), Действия по
 * потребители (01b 8) and e-mail of reports (04b 3, 06 3.2).
 */

let t: TestCompany;
const keys = (r: { body: { messages?: { key: string }[] } }) => (r.body.messages ?? []).map((m) => m.key);

beforeAll(async () => {
  t = await createTestCompany({ companyName: 'Настройки ООД' });
}, 60_000);
afterAll(async () => {
  setMailTransportFactory(null);
  await t.close();
});

describe('06 3.4 settings', { timeout: 30_000 }, () => {
  it('lists the new options with their defaults', async () => {
    const list = (await t.call('GET', '/settings')).body as { key: string; value: string; default: string; label: string }[];
    expect(list.find((x) => x.key === 'InvoiceAsPaymentDocument')).toMatchObject({ value: 'False', label: 'Разплащане на задължения/вземания с документ тип Фактура' });
    expect(list.find((x) => x.key === 'SaleVatTerm')).toMatchObject({ value: '', default: '' });
    expect(list.find((x) => x.key === 'PurchaseVatTerm')).toMatchObject({ value: '' });
    expect((await t.call('GET', '/session')).body.settings).toMatchObject({ InvoiceAsPaymentDocument: 'False', SaleVatTerm: '', PurchaseVatTerm: '' });
  });

  it('VAT terms are stored as the enum name, numbers are normalised, wrong types refused', async () => {
    expect((await t.call('PUT', '/settings', { SaleVatTerm: 'Sale9', PurchaseVatTerm: '3' })).status).toBe(200);
    const s = (await t.call('GET', '/session')).body.settings;
    expect([s.SaleVatTerm, s.PurchaseVatTerm]).toEqual(['Sale9', 'PurchaseNoCredit']);
    expect((await t.call('PUT', '/settings', { SaleVatTerm: 'PurchaseNoCredit' })).status).toBe(400);
    expect((await t.call('PUT', '/settings', { PurchaseVatTerm: 'Nope' })).status).toBe(400);
    expect((await t.call('PUT', '/settings', { SaleVatTerm: '', PurchaseVatTerm: '' })).status).toBe(200);
    expect((await t.call('GET', '/session')).body.settings.SaleVatTerm).toBe('');
  });

  it('InvoiceAsPaymentDocument: a payment gets document type Фактура with the paid invoice number', async () => {
    const cli = await t.partner('Платец по фактура ООД', ['411']);
    const inv = await t.post({ date: '2026-02-01', docNumber: '0000000042', partner: cli, dr: [['411', 120]], cr: [['702', 120]] });
    const pay = (amount: string, accountingId: number, extra: object = {}) => t.call('POST', '/payments', {
      companyId: cli, accountId: t.acc('411'), paymentAccountId: t.acc('501'), date: '2026-02-05', term: 'Плащане', amount, allocations: [{ accountingId, amount }], ...extra,
    });
    // Off: a ПКО.
    let r = await pay('20', inv.id);
    expect(r.status, r.text).toBe(201);
    expect((await t.call('GET', `/entries/${r.body.id}`)).body.documentTypeId).toBe(8);

    expect((await t.call('PUT', '/settings', { InvoiceAsPaymentDocument: 'True' })).status).toBe(200);
    const invNext = (await t.call('GET', '/payments/settings')).body;
    r = await pay('30', inv.id);
    expect(r.status, r.text).toBe(201);
    const e = (await t.call('GET', `/entries/${r.body.id}`)).body;
    expect(e).toMatchObject({ documentTypeId: 1, documentNumber: '0000000042' });
    // An explicit document type still wins; the invoice sequence is untouched.
    r = await pay('10', inv.id, { documentTypeId: 11, documentNumber: 'BS-1' });
    expect((await t.call('GET', `/entries/${r.body.id}`)).body).toMatchObject({ documentTypeId: 11, documentNumber: 'BS-1' });
    expect((await t.call('GET', '/payments/settings')).body).toEqual(invNext);
    await t.call('PUT', '/settings', { InvoiceAsPaymentDocument: 'False' });
  });
});

describe('06 2.1 Съобщения', { timeout: 30_000 }, () => {
  it('strVATAccountMissing for a VAT-registered company without 453/8 and 453/9', async () => {
    let msgs = (await t.call('GET', '/session/messages')).body as { key: string; text: string }[];
    expect(msgs.some((m) => m.key === 'strVATAccountMissing')).toBe(false);
    const my = (await t.call('GET', '/my-company')).body;
    expect((await t.call('PUT', '/my-company', { ...my, isVat: true, vatId: 'BG831641791' })).status).toBe(200);
    const accounts = (await t.call('GET', '/accounts')).body as { id: number; number: string; categoryId: number | null }[];
    const refund = accounts.find((a) => a.number === '453/8')!;
    msgs = (await t.call('GET', '/session/messages')).body;
    expect(msgs.some((m) => m.key === 'strVATAccountMissing')).toBe(false);
    // Taking the category away makes the account missing.
    expect((await t.call('PUT', `/accounts/${refund.id}`, { accountCategoryId: null })).status).toBe(200);
    msgs = (await t.call('GET', '/session/messages')).body;
    expect(msgs.find((m) => m.key === 'strVATAccountMissing')!.text).toBe('Липсват следните ДДС сметки: ДДС за възстановяване');
    expect((await t.call('PUT', `/accounts/${refund.id}`, { accountCategoryId: 35 })).status).toBe(200);
  });

  it('VAT registration threshold for a non-registered company', async () => {
    const my = (await t.call('GET', '/my-company')).body;
    await t.call('PUT', '/my-company', { ...my, isVat: false, isNotVat: false });
    const cli = await t.partner('Голям клиент ООД', ['411']);
    await t.post({ date: '2026-03-01', partner: cli, dr: [['411', 60000]], cr: [['702', 60000]] });
    await t.call('PUT', '/session/working-date', { date: '2026-03-15' });
    const msgs = (await t.call('GET', '/session/messages')).body as { key: string; text: string; screen: string }[];
    const n = msgs.find((m) => m.key === 'strVATRegistrationTurnoverReached')!;
    expect(n.text).toContain('51130 EUR');
    expect(n.screen).toBe('myCompany');
    await t.call('PUT', '/my-company', { ...my, isVat: false, isNotVat: true });
    expect(((await t.call('GET', '/session/messages')).body as { key: string }[]).some((m) => m.key === 'strVATRegistrationTurnoverReached')).toBe(false);
  });
});

describe('01b 8 Действия по потребители', { timeout: 30_000 }, () => {
  it('filters the log on the server by user, activity, period and text', async () => {
    await t.call('POST', '/users', { name: 'Петя Колева', password: 'parola1', roleId: 5 });
    const all = (await t.call('GET', '/activity?limit=500')).body as { activity: string; user: string; createdAt: string; description: string }[];
    expect(all.length).toBeGreaterThan(3);
    const adds = (await t.call('GET', '/activity?activity=add')).body as { activity: string }[];
    expect(adds.length).toBeGreaterThan(0);
    expect(adds.every((r) => r.activity === 'add')).toBe(true);
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });
    expect((await t.call('GET', `/activity?from=${today}&to=${today}`)).body.length).toBe(all.length);
    expect((await t.call('GET', '/activity?from=2001-01-01&to=2001-12-31')).body).toEqual([]);
    const byText = (await t.call('GET', '/activity?q=Петя')).body as { description: string }[];
    expect(byText.length).toBeGreaterThan(0);
    expect((await t.call('GET', '/activity?userId=999')).body).toEqual([]);
    expect((await t.call('GET', '/activity?activity=hack')).status).toBe(400);
    expect((await t.call('GET', '/activity?from=2026-13-01')).status).toBe(400);
  });

  it('report print and export are logged', async () => {
    expect((await t.call('POST', '/activity/log', { activity: 'export', entityType: 'turnoverReport', description: 'Оборотна ведомост (Excel)' })).status).toBe(201);
    expect((await t.call('POST', '/activity/log', { activity: 'print', entityType: 'icaReport', description: 'Протоколи' })).status).toBe(201);
    expect((await t.call('POST', '/activity/log', { activity: 'delete', entityType: 'x' })).status).toBe(400);
    const rows = (await t.call('GET', '/activity?activity=export&entityType=turnoverReport')).body as { description: string; user: string }[];
    expect(rows[0]).toMatchObject({ description: 'Оборотна ведомост (Excel)', user: 'Администратор' });
    expect(((await t.call('GET', '/activity?activity=print')).body as { entityType: string }[]).some((r) => r.entityType === 'icaReport')).toBe(true);
  });

  it('"По документи": per-user counts by document class', async () => {
    await t.post({ date: '2026-04-01', docType: 1, dr: [['501', 10]], cr: [['702', 10]] });
    await t.post({ date: '2026-04-02', docType: 11, dr: [['503', 10]], cr: [['702', 10]] });
    await t.post({ date: '2026-04-03', docType: 10, dr: [['602', 10]], cr: [['101', 10]] });
    await t.post({ date: '2026-04-04', docType: 9, dr: [['602', 5]], cr: [['501', 5]] });
    const r = (await t.call('GET', '/activity/by-documents?from=2026-04-01&to=2026-04-30')).body as Record<string, number | string>[];
    expect(r).toEqual([{ userId: 1, userName: 'Администратор', invoices: 1, bankStatements: 1, cashOrders: 1, memorials: 1, others: 0, total: 4 }]);
    expect((await t.call('GET', '/activity/by-documents?from=2026-04-01&to=2026-04-30&userId=2')).body).toEqual([]);
    const year = (await t.call('GET', '/activity/by-documents')).body as { invoices: number }[];
    expect(year[0]!.invoices).toBeGreaterThan(1);
  });
});

describe('04b 3 e-mail of reports', { timeout: 30_000 }, () => {
  it('SMTP settings: validated, password stored encrypted and never returned', async () => {
    let r = await t.call('PUT', '/settings/smtp', { host: 'smtp.firma.bg', port: 70000, userName: 'office', password: 'Tajna-1234', email: 'лошо' });
    expect(r.status).toBe(422);
    expect(keys(r)).toEqual(['strSmtpPortInvalid', 'strSmtpEmailInvalid']);
    r = await t.call('PUT', '/settings/smtp', { host: 'smtp.firma.bg', port: 587, userName: 'office', password: 'Tajna-1234', email: 'office@firma.bg', enableSsl: true });
    expect(r.status, r.text).toBe(200);
    expect(r.text).not.toContain('Tajna-1234');
    expect(r.body).toMatchObject({ host: 'smtp.firma.bg', port: 587, userName: 'office', email: 'office@firma.bg', enableSsl: true, hasPassword: true });
    const db = await t.driver.company(t.companyDb);
    const [stored] = await queryRows<{ value: string }>(db, sql`SELECT value FROM configuration WHERE key = 'SmtpPassword'`);
    expect(stored!.value).not.toContain('Tajna');
    expect(decryptSecret(stored!.value)).toBe('Tajna-1234');
    // Saving without a password keeps it.
    r = await t.call('PUT', '/settings/smtp', { host: 'smtp.firma.bg', port: 465, userName: 'office', email: 'office@firma.bg', enableSsl: true });
    expect((await t.call('GET', '/settings/smtp')).body).toMatchObject({ port: 465, hasPassword: true });
  });

  it('test send and report send through the transport; strInvalidEmailTo / CC', async () => {
    const seen: { host: string; port: number; user: string; pass: string }[] = [];
    setMailTransportFactory((c) => {
      seen.push({ host: c.host, port: c.port, user: c.userName, pass: c.password });
      return nodemailer.createTransport({ jsonTransport: true });
    });
    MAIL_OUTBOX.length = 0;
    let r = await t.call('POST', '/settings/smtp/test', {});
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ message: 'Изпращането е успешно!', to: 'office@firma.bg' });
    expect(seen[0]).toEqual({ host: 'smtp.firma.bg', port: 465, user: 'office', pass: 'Tajna-1234' });

    const attachment = { fileName: 'Оборотна ведомост 2026.12.31.xlsx', contentBase64: Buffer.from('PK fake xlsx').toString('base64') };
    r = await t.call('POST', '/email/report', { to: 'лошо', cc: 'x@', subject: 'Оборотна ведомост', attachment });
    expect(r.status).toBe(422);
    expect(keys(r)).toEqual(['strInvalidEmailTo', 'strInvalidEmailCC']);
    r = await t.call('POST', '/email/report', { to: 'boss@firma.bg; acc@firma.bg', cc: 'audit@firma.bg', subject: 'Оборотна ведомост', body: 'Приложено', report: 'Оборотна ведомост', entityType: 'turnoverReport', attachment });
    expect(r.status, r.text).toBe(200);
    expect(r.body.message).toBe('Изпращането е успешно!');
    const m = MAIL_OUTBOX.at(-1)!;
    expect(m).toMatchObject({ from: 'office@firma.bg', to: ['boss@firma.bg', 'acc@firma.bg'], cc: ['audit@firma.bg'], subject: 'Оборотна ведомост', text: 'Приложено' });
    expect(m.attachments).toEqual([{ filename: attachment.fileName, size: 12 }]);
    const log = (await t.call('GET', '/activity?activity=export&entityType=turnoverReport')).body as { description: string }[];
    expect(log[0]!.description).toBe('Оборотна ведомост: e-mail до boss@firma.bg; acc@firma.bg');

    // A failing server gives strEmailSendingFailed.
    setMailTransportFactory(() => ({ sendMail: async () => { throw new Error('ECONNREFUSED'); } }) as never);
    r = await t.call('POST', '/email/report', { to: 'boss@firma.bg', subject: 'x', attachment });
    expect(r.status).toBe(422);
    expect(keys(r)).toEqual(['strEmailSendingFailed']);
  });

  it('without an SMTP server: strNotConnectedToSenderaOrMissingSMTP', async () => {
    await t.call('PUT', '/settings/smtp', { host: '', port: 25 });
    expect((await t.call('GET', '/settings/smtp')).body).toMatchObject({ host: '', hasPassword: false });
    const r = await t.call('POST', '/email/report', { to: 'boss@firma.bg', subject: 'x', attachment: { fileName: 'a.xlsx', contentBase64: '' } });
    expect(keys(r)).toEqual(['strNotConnectedToSenderaOrMissingSMTP']);
  });
});

describe('03a 1.1 chart type', { timeout: 30_000 }, () => {
  it('the session reports the chart type chosen at creation; none without a template', async () => {
    expect((await t.call('GET', '/session')).body.chartOfAccountsType).toBe('commercial');
    const r = await t.call('POST', '/companies', { companyName: 'Без сметкоплан ООД', adminName: 'Админ', adminPassword: 'secret2', year: 2026, chartTemplate: null });
    expect(r.status, r.text).toBe(201);
    const s = (await t.call('GET', '/session')).body;
    expect([s.chartOfAccountsType, s.chartIsEmpty]).toEqual(['', true]);
    expect((await t.call('POST', '/accounts/template', { type: 'commercial' })).status).toBe(200);
    expect((await t.call('GET', '/session')).body.chartOfAccountsType).toBe('commercial');
  });
});
