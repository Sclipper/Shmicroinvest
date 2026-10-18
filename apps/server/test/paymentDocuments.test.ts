import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';

/** Payment documents (spec 02c 1): registry, batch save, copy, delete, diary, suggestions, UBB export. */

let t: TestCompany;
let ubbId: number;
let bnbId: number;
beforeAll(async () => {
  t = await createTestCompany();
  const lookups = (await t.call('GET', '/lookups')).body;
  ubbId = lookups.banks.find((b: { code: string }) => b.code === 'UBBSBGSF').id;
  bnbId = lookups.banks.find((b: { code: string }) => b.code === 'BNBGBGSF').id;
}, 60_000);
afterAll(() => t.close());

const IBAN = 'BG80BNBG96611020345678';
const UBB_IBAN = 'BG89UBBS80021087654321';

const credit = (p: Record<string, unknown> = {}) => ({
  personName: 'Доставчик ООД', personIban: IBAN, personBic: 'BNBGBGSF', personBank: 'Българска народна банка', currency: 'EUR',
  qtty: '120.50', reason: 'Фактура 17', reasonEx: 'от 01.02.2026', customer: 'Тест ООД', customerIban: UBB_IBAN, customerBic: 'UBBSBGSF',
  paymentSystem: 'БИСЕРА', taxes: 2, executionDate: '2026-03-02', ...p,
});
const budgetDue = (p: Record<string, unknown> = {}) => ({
  personName: 'НАП', personIban: IBAN, personBic: 'BNBGBGSF', personBank: 'БНБ', paymentType: 110000, currency: 'EUR', qtty: '50',
  reason: 'Данък по ЗДДФЛ', duePerson: 'Тест ООД', bulstat: '175074752', egn: '7501010010', customer: 'Тест ООД', customerIban: UBB_IBAN,
  customerBic: 'UBBSBGSF', ...p,
});

async function save(type: number, documents: Record<string, unknown>[]) {
  const r = await t.call('POST', '/payment-documents/batch', { type, documents });
  expect(r.status, r.text).toBe(200);
  return r.body.documents as any[];
}
const today = async () => (await t.call('GET', '/session')).body;

describe('payment documents: save and registry (02c 1.6)', () => {
  it('saves a new OrderCredit with Qtty "0" despite the NonCritical warning (acceptance 1)', async () => {
    const v = await t.call('POST', '/payment-documents/validate', { type: 3, document: credit({ qtty: '0' }) });
    expect(v.body.messages).toEqual([{ key: 'strQttyIsZero', text: 'Сумата на документа трябва да е по-голяма от нула!', severity: 'warning' }]);
    const r = await t.call('POST', '/payment-documents/batch', { type: 3, documents: [credit({ qtty: '0' })] });
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Данните са записани успешно.');
    expect(r.body.documents[0]).toMatchObject({ documentType: 3, qtty: '0.00', isDeleted: false });
  });

  it('dates new documents with the working date and recomputes InWords (acceptance 7)', async () => {
    const [d] = await save(3, [credit({ qtty: '123.45', inWords: 'ръчно' })]);
    // The working date is today unless the session moved it.
    expect(d.date.slice(0, 10)).toBe((await today()).workingDate);
    expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    // OrderCredit has no InWords field: the typed value is ignored.
    expect(d.inWords).toBe('сто двадесет и три евро и 45 цента');
    const got = await t.call('GET', `/payment-documents/${d.id}`);
    expect(got.body).toMatchObject({ id: d.id, qtty: '123.45', personName: 'Доставчик ООД', executionDate: '2026-03-02', taxes: 2 });
  });

  it('uses the application (working) date, not the calendar date', async () => {
    const real = (await today()).workingDate;
    expect((await t.call('PUT', '/session/working-date', { date: '2026-05-15' })).status).toBe(200);
    try {
      const [d] = await save(8, [{ personIban: IBAN, customer: 'Тест ООД', qtty: '1', rowsCount: '1234567', controlCode: 'ABC' }]);
      expect(d.date.slice(0, 10)).toBe('2026-05-15');
      expect(d.rowsCount).toBe('123456');
      const may = await t.call('GET', '/payment-documents?type=8&from=2026-05-01&to=2026-05-31');
      expect(may.body.map((x: { id: number }) => x.id)).toEqual([d.id]);
    } finally {
      await t.call('PUT', '/session/working-date', { date: real });
    }
  });

  it('keeps a typed InWords on the forms that show it; empty currency words in EUR', async () => {
    const [due, due2] = await save(2, [
      { personName: 'Банка', personIban: IBAN, customer: 'Иван', qtty: '10', currency: 'EUR', inWords: 'десет евро точно' },
      { personName: 'Банка', personIban: IBAN, customer: 'Иван', qtty: '2', currency: '' },
    ]);
    expect(due.inWords).toBe('десет евро точно');
    expect(due2.inWords).toBe('два евро');
  });

  it('limits strings to 50 characters, BudgetOrder reasons to 70, trims the place (LimitStringField)', async () => {
    const long = 'Основание '.repeat(9); // 90 characters
    const [c] = await save(3, [credit({ reason: long, customer: long, issuePlace: '  София  ', currency: 'EURO' })]);
    expect(c.reason).toBe(long.slice(0, 50));
    expect(c.customer).toBe(long.slice(0, 50));
    expect(c.issuePlace).toBe('София');
    expect(c.currency).toBe('EUR');
    const [b] = await save(6, [budgetDue({ reason: long, reasonEx: long, lnch: '1001000004123' })]);
    expect(b.reason).toBe(long.slice(0, 70));
    expect(b.reasonEx).toBe(long.slice(0, 70));
    expect(b.lnch).toBe('100100000412');
  });

  it('updates in batch, lists by type and period, filters by text, bank and deleted', async () => {
    const [a, b] = await save(4, [
      { personName: 'Платец Едно', personIban: IBAN, customer: 'Тест ООД', customerIban: UBB_IBAN, customerBic: 'UBBSBGSF', reason: 'Абонамент', qtty: '5' },
      { personName: 'Платец Две', personIban: IBAN, customer: 'Тест ООД', reason: 'Наем', qtty: '7', personBic: 'BNBGBGSF' },
    ]);
    const upd = await save(4, [{ ...a, qtty: '6.5' }]);
    expect(upd[0]).toMatchObject({ id: a.id, qtty: '6.50', date: a.date, inWords: 'шест евро и 50 цента' });

    const day = a.date.slice(0, 10);
    const list = (q: string) => t.call('GET', `/payment-documents?type=4&from=${day}&to=${day}${q}`).then((r) => r.body as any[]);
    expect((await list('')).map((d) => d.id)).toEqual([a.id, b.id]);
    expect((await list('&text=наем')).map((d) => d.id)).toEqual([b.id]);
    expect((await list(`&bankId=${ubbId}`)).map((d) => d.id)).toEqual([a.id]);
    expect((await list(`&bankId=${bnbId}`)).map((d) => d.id)).toEqual([b.id]);
    // Another type and another period see nothing.
    const other = await t.call('GET', `/payment-documents?type=1&from=${day}&to=${day}`);
    expect(other.body).toEqual([]);
    const past = await t.call('GET', '/payment-documents?type=4&from=2020-01-01&to=2020-01-31');
    expect(past.body).toEqual([]);
    expect((await t.call('GET', '/payment-documents?type=4')).body.length).toBe(2);

    const del = await t.call('POST', '/payment-documents/delete', { type: 4, ids: [b.id] });
    expect(del.body).toEqual({ deleted: 1 });
    expect((await list('')).map((d) => d.id)).toEqual([a.id]);
    const withDeleted = await list('&deleted=1');
    expect(withDeleted.find((d) => d.id === b.id)).toMatchObject({ isDeleted: true });
    // A deleted document is not saved again by ApplyChanges.
    const again = await save(4, [{ ...b, qtty: '99' }]);
    expect(again).toEqual([]);
    expect((await t.call('GET', `/payment-documents/${b.id}`)).body.qtty).toBe('7.00');
  });

  it('copies the selected document as an unsaved draft dated now', async () => {
    const [d] = await save(1, [{ personName: 'Иван Петров', personIban: IBAN, personBank: 'БНБ', qtty: '300', currency: 'EUR', autorizedPerson: 'Мария', idNumber: '123456789' }]);
    const r = await t.call('POST', `/payment-documents/${d.id}/copy`);
    expect(r.body).toMatchObject({ id: null, documentType: 1, personName: 'Иван Петров', autorizedPerson: 'Мария', isDeleted: false, qtty: '300.00' });
    const [copy] = await save(1, [r.body]);
    expect(copy.id).not.toBe(d.id);
    expect(copy.inWords).toBe('триста евро');
  });

  it('refuses a document of another type in the batch', async () => {
    const [d] = await save(2, [{ personName: 'X', qtty: '1' }]);
    const r = await t.call('POST', '/payment-documents/batch', { type: 3, documents: [{ ...d }] });
    expect(r.status).toBe(404);
  });
});

describe('payment documents: lists, lookup, diary, print', () => {
  it('suggests names and IBANs of the same type and the orderers of "Моята фирма"', async () => {
    const my = (await t.call('GET', '/my-company')).body;
    const put = await t.call('PUT', '/my-company', {
      name: my.name, bulstat: my.bulstat, contactName: 'Георги Иванов', accountant: 'Анна Счетоводител',
      bankAccounts: [{ bankId: ubbId, account: UBB_IBAN }],
    });
    expect(put.status, put.text).toBe(200);
    const r = await t.call('GET', '/payment-documents/suggestions?type=3');
    expect(r.body.personNames).toContain('Доставчик ООД');
    expect(r.body.personIbans).toEqual([IBAN]);
    expect(r.body.orderers).toEqual(['Георги Иванов', 'Тест ООД', 'Анна Счетоводител']);
    expect(r.body.orderersIbans).toEqual([UBB_IBAN]);
    const due = await t.call('GET', '/payment-documents/suggestions?type=2');
    expect(due.body.personNames).not.toContain('Доставчик ООД');
  });

  it('finds the bank of an IBAN (02c 1.5)', async () => {
    const r = await t.call('GET', `/payment-documents/bank-by-iban/${encodeURIComponent('bg89 ubbs 8002 1087 6543 21')}`);
    expect(r.body).toMatchObject({ id: ubbId, code: 'UBBSBGSF' });
    expect((await t.call('GET', '/payment-documents/bank-by-iban/EVP1234567')).body).toMatchObject({ code: 'EVIULT2V' });
    expect((await t.call('GET', '/payment-documents/bank-by-iban/BG80XXXX1')).body).toBeNull();
  });

  it('offers the header blocks already used as bank branches', async () => {
    await save(2, [{ bankName: 'ОББ', bankBranch: 'Клон Витоша', bankAddress: 'бул. Витоша 1', issuePlace: 'София', personName: 'X', qtty: '1' }]);
    const r = await t.call('GET', '/payment-documents/branches');
    expect(r.body[0]).toEqual({ bankName: 'ОББ', bankBranch: 'Клон Витоша', bankAddress: 'бул. Витоша 1', issuePlace: 'София' });
  });

  it('"Дневник на платежните документи" lists non-deleted documents by date', async () => {
    const [a, b, c] = await save(3, [credit({ personName: 'Първи' }), credit({ personName: 'Втори', qtty: '2' }), credit({ personName: 'Трети' })]);
    await t.call('POST', '/payment-documents/delete', { type: 3, ids: [c.id] });
    const r = await t.call('GET', `/payment-documents/diary?ids=${a.id},${b.id},${c.id}`);
    expect(r.body).toEqual([
      expect.objectContaining({ id: a.id, typeDescription: 'Платежно нареждане за кредитен превод', receiver: 'Първи', customerIban: UBB_IBAN, personIban: IBAN, personBic: 'BNBGBGSF', qtty: '120.50', reason: 'Фактура 17' }),
      expect.objectContaining({ id: b.id, receiver: 'Втори', qtty: '2.00' }),
    ]);
  });

  it('refuses to print deleted documents and logs the print', async () => {
    const [a, b] = await save(3, [credit(), credit()]);
    await t.call('POST', '/payment-documents/delete', { type: 3, ids: [b.id] });
    const bad = await t.call('POST', '/payment-documents/print', { ids: [a.id, b.id] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('Не могат да се принтират/експортират изтрити документи.');
    const ok = await t.call('POST', '/payment-documents/print', { ids: [a.id] });
    expect(ok.body).toEqual({ ok: true, printed: 1 });
  });
});

describe('payment documents: export to UBB (02c 1.8)', () => {
  it('writes MPLSSAL311.TXT in Windows-1251, 35-character names, ||| CRLF (acceptance 6)', async () => {
    const name = 'Много дълго име на получател ЕООД АБВГДЕЖЗ';
    const [a, b] = await save(3, [credit({ personName: name }), credit({ personName: 'Втори', qtty: '2' })]);
    const r = await t.call('POST', '/payment-documents/export', { type: 3, ids: [a.id, b.id], bankId: ubbId });
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="MPLSSAL311.TXT"');
    expect(r.headers.get('content-type')).toContain('windows-1251');
    const raw = await t.app.request('/api/payment-documents/export', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: t.session.get() },
      body: JSON.stringify({ type: 3, ids: [a.id, b.id], bankId: ubbId }),
    });
    const bytes = new Uint8Array(await raw.arrayBuffer());
    const text = new TextDecoder('windows-1251').decode(bytes);
    expect(text).toBe(
      `IBAN311|${name.slice(0, 35)}|${IBAN}|BNBGBGSF|EUR|120.50|Фактура 17|от 01.02.2026|||\r\n`
      + `IBAN311|Втори|${IBAN}|BNBGBGSF|EUR|2.00|Фактура 17|от 01.02.2026|||\r\n`,
    );
    // "М" is 0xCC in Windows-1251.
    expect(bytes[8]).toBe(0xcc);
  });

  it('writes MPLSSAL313.TXT for BudgetDue', async () => {
    const [d] = await save(5, [budgetDue()]);
    const r = await t.call('POST', '/payment-documents/export', { type: 5, ids: [d.id], bankId: ubbId });
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get('x-export-file-name')).toBe('MPLSSAL313.TXT');
  });

  it('refuses when one BudgetDue orderer BIC differs from UBB (acceptance 5)', async () => {
    const docs = await save(5, [budgetDue(), budgetDue({ customerBic: 'BNBGBGSF' }), budgetDue()]);
    const r = await t.call('POST', '/payment-documents/export', { type: 5, ids: docs.map((d) => d.id), bankId: ubbId });
    expect(r.status).toBe(422);
    expect(r.body.messages).toEqual([{
      key: 'strBICIsIncorrect', text: 'BIC кода на банката на наредителя не отговаря на избраната банка за експорт!', severity: 'critical', documentId: docs[1].id,
    }]);
  });

  it('BudgetOrder "към ОББ" is not implemented (acceptance 8); bank and documents are required', async () => {
    const [d] = await save(6, [budgetDue()]);
    const r = await t.call('POST', '/payment-documents/export', { type: 6, ids: [d.id], bankId: ubbId });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('Към избраната банка няма активиран експорт. За повече информация се свържете с екипа на Microinvest!');
    const [c] = await save(3, [credit()]);
    expect((await t.call('POST', '/payment-documents/export', { type: 3, ids: [c.id], bankId: null })).body.messages[0].key).toBe('strBankNotSelected');
    expect((await t.call('POST', '/payment-documents/export', { type: 3, ids: [c.id], bankId: bnbId })).body.messages[0].key).toBe('strPaymentDocumentExportNotImplemented');
    expect((await t.call('POST', '/payment-documents/export', { type: 3, ids: [], bankId: ubbId })).body.messages[0].key).toBe('strNoDocumentToExport');
    await t.call('POST', '/payment-documents/delete', { type: 3, ids: [c.id] });
    expect((await t.call('POST', '/payment-documents/export', { type: 3, ids: [c.id], bankId: ubbId })).body.messages[0].key).toBe('strCannotExportDeletedDocument');
  });

  it('raises validation warnings to Critical on export', async () => {
    const [d] = await save(3, [credit({ personIban: IBAN.toLowerCase() })]);
    const r = await t.call('POST', '/payment-documents/export', { type: 3, ids: [d.id], bankId: ubbId });
    expect(r.body.messages).toEqual([expect.objectContaining({ key: 'strBeneficiaryPersonIBANIsInvalid', severity: 'critical' })]);
  });
});

describe('payment documents: permissions', () => {
  it('checks the permission of the document type', async () => {
    const role = await t.call('POST', '/roles', { name: 'Без кредитни преводи' });
    expect(role.status, role.text).toBeLessThan(300);
    const roleId = role.body.id;
    await t.call('PUT', `/roles/${roleId}/permissions`, { 102: false, 104: true, 27: true });
    const u = await t.call('POST', '/users', { name: 'Оператор', password: 'secret1', roleId });
    expect(u.status, u.text).toBe(201);
    const adminId = (await today()).user.id;
    const login = await t.call('POST', '/login', { companyDb: t.companyDb, userId: u.body.id, password: 'secret1' });
    expect(login.status, login.text).toBe(200);
    try {
      expect((await t.call('GET', '/payment-documents?type=3')).status).toBe(403);
      expect((await t.call('POST', '/payment-documents/batch', { type: 3, documents: [credit()] })).status).toBe(403);
      expect((await t.call('GET', '/payment-documents?type=2')).status).toBe(200);
    } finally {
      const back = await t.call('POST', '/login', { companyDb: t.companyDb, userId: adminId, password: 'secret1' });
      expect(back.status, back.text).toBe(200);
    }
  });

  it('rejects an unknown type', async () => {
    expect((await t.call('GET', '/payment-documents?type=7')).status).toBe(400);
    expect((await t.call('GET', '/payment-documents?type=9')).status).toBe(400);
  });
});
