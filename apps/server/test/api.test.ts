import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';
import { findSequence, reserveNumber } from '../src/services/sequences.ts';

let t: TestCompany;
let call: TestCompany['call'];
let acc: TestCompany['acc'];

beforeAll(async () => {
  t = await createTestCompany();
  call = t.call;
  acc = t.acc;
}, 60_000);
afterAll(() => t.close());

describe('api', () => {
  it('rejects anonymous company creation once a company exists', async () => {
    const saved = t.session.get();
    t.session.set('');
    const r = await call('POST', '/companies', { companyName: 'X', adminName: 'A', adminPassword: 'secret1', year: 2026 });
    expect(r.status).toBe(403);
    expect((await call('GET', '/session')).status).toBe(401);
    t.session.set(saved);
  });

  it('logs in with the admin password only', async () => {
    const [company] = (await call('GET', '/companies')).body;
    const saved = t.session.get();
    expect((await call('POST', '/login', { companyDb: company.name, userId: 1, password: 'wrong' })).status).toBe(401);
    expect((await call('POST', '/login', { companyDb: company.name, userId: 1, password: 'secret1' })).status).toBe(200);
    expect(t.session.get()).not.toBe(saved);
  });

  it('exposes the session with a EUR base currency and seeded chart', async () => {
    const r = await call('GET', '/session');
    expect(r.body.year.year).toBe(2026);
    expect(r.body.baseCurrency).toBe('EUR');
    expect(r.body.chartIsEmpty).toBe(false);
    expect(r.body.permissions.UI_Edit_Companies).toBe(true);
  });

  it('validates and saves partners', async () => {
    const bad = await call('POST', '/partners', { name: '', isVat: true, accountIds: [] });
    expect(bad.status).toBe(422);
    const keys = bad.body.messages.map((m: { key: string }) => m.key);
    expect(keys).toContain('strCompanyNameIsEmpty');
    expect(keys).toContain('strCompanyVatNumberIsEmpty');
    const ok = await call('POST', '/partners', { name: 'Клиент ЕООД', bulstat: '831641791', isVat: true, vatNumber: 'BG831641791', accountIds: [acc('411')] });
    expect(ok.status).toBe(201);
    const dup = await call('POST', '/partners', { name: 'Друг', bulstat: '831641791', accountIds: [acc('411')] });
    expect(dup.status).toBe(422);
    expect(dup.body.messages.map((m: { key: string }) => m.key)).toContain('strCompanyBulstatExists');
    // List shows the partner's own address (owner ids differ from address ids).
    const withAddr = await call('POST', '/partners', { name: 'Доставчик АД', accountIds: [acc('401')], addresses: [{ city: 'Пловдив', address: 'ул. Главна 5' }] });
    expect(withAddr.status).toBe(201);
    const listed = (await call('GET', '/partners?q=Доставчик')).body[0];
    expect([listed.city, listed.address]).toEqual(['Пловдив', 'ул. Главна 5']);
    const notPartner = await call('POST', '/partners', { name: 'Трети', accountIds: [acc('501')] });
    expect(notPartner.body.messages.map((m: { key: string }) => m.key)).toContain('strAccountDoesNotSupportCompanies');
  });

  it('posts entries, numbers them and reports a trial balance', async () => {
    const partner = (await call('GET', '/partners?q=Клиент')).body[0];
    const capital = await call('POST', '/entries', {
      accountingDate: '2026-02-01', documentTypeId: 1, documentNumber: '1', term: 'Внесен капитал',
      debits: [{ accountId: acc('501'), amount: '1000' }], credits: [{ accountId: acc('101'), amount: '1000' }],
    });
    expect(capital.status, JSON.stringify(capital.body)).toBe(201);
    expect(capital.body.number).toBe('0000000001');
    const sale = await call('POST', '/entries', {
      accountingDate: '2026-02-10', documentTypeId: 1, documentNumber: '2', term: 'Продажба на стоки', companyId: partner.id,
      debits: [{ accountId: acc('411'), amount: '120', companyId: partner.id }],
      credits: [{ accountId: acc('702'), amount: '100' }, { accountId: acc('453/2'), amount: '20' }],
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body.number).toBe('0000000002');
    const unbalanced = await call('POST', '/entries', {
      accountingDate: '2026-02-10', documentTypeId: 1, documentNumber: '3', term: 'x',
      debits: [{ accountId: acc('501'), amount: '10' }], credits: [{ accountId: acc('101'), amount: '9' }],
    });
    expect(unbalanced.status).toBe(422);

    const tb = await call('GET', '/reports/trial-balance?from=2026-01-01&to=2026-12-31&level=3');
    const row = (n: string) => tb.body.rows.find((r: { number: string }) => r.number === n);
    expect(row('501').closingDebit).toBe('1000.00');
    expect(row('702').creditTurnover).toBe('100.00');
    expect(row('411').debitTurnover).toBe('120.00');
    expect(tb.body.totals.debitTurnover).toBe(tb.body.totals.creditTurnover);
    expect(tb.body.totals.debitTurnover).toBe('1120.00');

    const list = await call('GET', '/entries');
    expect(list.body.total).toBe(2);
    expect(list.body.rows[0].company).toBe('Клиент ЕООД');

    // Partner with postings cannot be deleted.
    expect((await call('DELETE', `/partners/${partner.id}`)).status).toBe(400);
  });

  it('blocks posting into a locked month', async () => {
    const years = (await call('GET', '/years')).body;
    await call('PUT', `/years/${years[0].id}/locks`, { months: [3] });
    const r = await call('POST', '/entries', {
      accountingDate: '2026-03-05', documentTypeId: 1, documentNumber: '9', term: 'x',
      debits: [{ accountId: acc('501'), amount: '1' }], credits: [{ accountId: acc('101'), amount: '1' }],
    });
    expect(r.status).toBe(422);
    await call('PUT', `/years/${years[0].id}/locks`, { months: [] });
  });

  it('manages users and role permissions', async () => {
    const u = await call('POST', '/users', { name: 'Иван', password: 'parola1', roleId: 5 });
    expect(u.status).toBe(201);
    const perms = (await call('GET', '/roles/5/permissions')).body as { id: number; key: string; effective: boolean }[];
    expect(perms.find((p) => p.key === 'UI_File_NewCompany')!.effective).toBe(false);
    expect(perms.find((p) => p.key === 'UI_Operations_Accounting')!.effective).toBe(true);
    expect((await call('DELETE', '/users/1')).status).toBe(400);
    // A group whose only member was deleted can itself be deleted.
    const role = await call('POST', '/roles', { name: 'Временна' });
    const temp = await call('POST', '/users', { name: 'Временен', password: 'parola1', roleId: role.body.id });
    expect((await call('DELETE', `/roles/${role.body.id}`)).status).toBe(400);
    await call('DELETE', `/users/${temp.body.id}`);
    expect((await call('PUT', `/roles/${role.body.id}`, { name: 'Временна 2' })).status).toBe(200);
    const perm = perms.find((p) => p.key === 'UI_File_NewCompany')!;
    expect((await call('PUT', `/roles/${role.body.id}/permissions`, { [perm.id]: true })).status).toBe(200);
    expect((await call('DELETE', `/roles/${role.body.id}`)).status).toBe(200);
    // Role and permission changes are in the activity log (01b 8).
    const log = (await call('GET', '/activity?limit=20')).body as { activity: string; entityType: string; entityId: number; description: string }[];
    const roleRows = log.filter((r) => r.entityId === role.body.id && r.entityType.startsWith('userRole')).map((r) => [r.activity, r.entityType, r.description]);
    expect(roleRows).toEqual([
      ['delete', 'userRole', 'Потребителска група Временна 2'],
      ['edit', 'userRolePermissions', 'Права на група Временна 2 (1)'],
      ['edit', 'userRole', 'Потребителска група Временна 2'],
      ['add', 'userRole', 'Потребителска група Временна'],
    ]);
  });

  it('reserves entry numbers atomically (01b 9 spGetNextNumber)', async () => {
    const db = await t.driver.company(t.companyDb);
    const year = (await call('GET', '/session')).body.year as { id: number };
    const start = (await findSequence(db, 1, year.id))!.lastNumber;
    // Another session reserves a number while this one is between "read" and "write":
    // the increment works on the stored value, so both get different numbers.
    let other: string | null = null;
    const mine = await reserveNumber(db, 1, year.id, async (n) => {
      if (!other) other = (await reserveNumber(db, 1, year.id, async () => false)).number;
      return n === other;
    });
    expect(other).toBe(String(start + 2).padStart(10, '0'));
    expect(mine.number).toBe(String(start + 1).padStart(10, '0'));

    // Parallel saves through the API: every entry gets its own number.
    const posts = await Promise.all(Array.from({ length: 8 }, (_, i) => call('POST', '/entries', {
      accountingDate: '2026-04-01', documentTypeId: 1, documentNumber: `P-${i}`, term: 'Паралелно',
      debits: [{ accountId: acc('501'), amount: '1' }], credits: [{ accountId: acc('101'), amount: '1' }],
    })));
    for (const p of posts) expect(p.status, p.text).toBe(201);
    const numbers = posts.map((p) => p.body.number as string);
    expect(new Set(numbers).size).toBe(8);
    expect(numbers.map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: 8 }, (_, i) => start + 3 + i));
  });

  it('rejects saving an entry that changed since it was loaded (01b 9 optimistic concurrency)', async () => {
    const body = (amount: string, term: string) => ({
      accountingDate: '2026-04-02', documentTypeId: 1, documentNumber: 'V-1', term,
      debits: [{ accountId: acc('501'), amount }], credits: [{ accountId: acc('101'), amount }],
    });
    const created = await call('POST', '/entries', body('10', 'Версия'));
    expect(created.status, created.text).toBe(201);
    const id = created.body.id as number;
    const first = (await call('GET', `/entries/${id}`)).body;
    expect(first.version).toMatch(/^\d+$/);
    expect(first.version).toBe(created.body.version);
    // User A and user B both opened version 1; A saves first.
    const a = await call('PUT', `/entries/${id}`, { ...body('20', 'Промяна А'), version: first.version });
    expect(a.status, a.text).toBe(200);
    expect(a.body.version).not.toBe(first.version);
    const b = await call('PUT', `/entries/${id}`, { ...body('30', 'Промяна Б'), version: first.version });
    expect(b.status).toBe(409);
    expect(b.body.code).toBe('conflict');
    expect(b.body.error).toBe('Контирането е променено от друг потребител след зареждането му. Заредете го отново, за да видите промените.');
    const now = (await call('GET', `/entries/${id}`)).body;
    expect([now.term, now.debits[0].amount, now.version]).toEqual(['Промяна А', '20.00', a.body.version]);
    // Reloaded, B saves; callers without a version are not checked.
    expect((await call('PUT', `/entries/${id}`, { ...body('30', 'Промяна Б'), version: now.version })).status).toBe(200);
    expect((await call('PUT', `/entries/${id}`, body('40', 'Без версия'))).status).toBe(200);
  });

  it('does not delete a user who appears in entries (strUserHasOperations, 01b 3.4)', async () => {
    const u = await call('POST', '/users', { name: 'Счетоводител', password: 'parola1', roleId: 2 });
    expect(u.status, u.text).toBe(201);
    const [company] = (await call('GET', '/companies')).body;
    expect((await call('POST', '/login', { companyDb: company.name, userId: u.body.id, password: 'parola1' })).status).toBe(200);
    expect((await call('POST', '/entries', {
      accountingDate: '2026-04-03', documentTypeId: 1, documentNumber: 'U-1', term: 'От друг потребител',
      debits: [{ accountId: acc('501'), amount: '1' }], credits: [{ accountId: acc('101'), amount: '1' }],
    })).status).toBe(201);
    expect((await call('POST', '/login', { companyDb: company.name, userId: 1, password: 'secret1' })).status).toBe(200);
    const r = await call('DELETE', `/users/${u.body.id}`);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('Потребителят не може да бъде изтрит, тъй като участва в операции!');
    expect(r.body.messages.map((m: { key: string }) => m.key)).toEqual(['strUserHasOperations']);
    expect((await call('GET', '/users')).body.some((x: { id: number }) => x.id === u.body.id)).toBe(true);
    // Without entries the user is deleted.
    const idle = await call('POST', '/users', { name: 'Без операции', password: 'parola1', roleId: 5 });
    expect((await call('DELETE', `/users/${idle.body.id}`)).status).toBe(200);
  });
});
