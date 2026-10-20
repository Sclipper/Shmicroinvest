import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';
import { findSequence, reserveNumber } from '../src/services/sequences.ts';
import * as schema from '../src/db/company/schema/index.ts';

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

  it('keeps user names unique among active users and the last administrator under concurrency (01b 3.4)', async () => {
    const a = await call('POST', '/users', { name: 'Петър Петров', password: 'parola1', roleId: 5 });
    expect(a.status, a.text).toBe(201);
    const dup = await call('POST', '/users', { name: 'петър петров', password: 'parola1', roleId: 5 });
    expect([dup.status, dup.body.error]).toEqual([400, 'Вече съществува потребител с такова име.']);
    const b = await call('POST', '/users', { name: 'Мария', password: 'parola1', roleId: 5 });
    const rename = await call('PUT', `/users/${b.body.id}`, { name: 'ПЕТЪР ПЕТРОВ', roleId: 5 });
    expect([rename.status, rename.body.error]).toEqual([400, 'Вече съществува потребител с такова име.']);
    // The database refuses a duplicate too (partial unique index); a deleted user's name is free again.
    const db = await t.driver.company(t.companyDb);
    await expect(db.insert(schema.users).values({ name: 'ПЕТЪР петров', userRoleId: 5 })).rejects.toThrow();
    expect((await call('DELETE', `/users/${a.body.id}`)).status).toBe(200);
    expect((await call('POST', '/users', { name: 'Петър Петров', password: 'parola1', roleId: 5 })).status).toBe(201);

    // Two administrators demoted at the same time: one of them stays an administrator.
    const admin2 = await call('POST', '/users', { name: 'Втори администратор', password: 'parola1', roleId: 2 });
    const others = ((await call('GET', '/users')).body as { id: number; roleId: number }[]).filter((u) => u.roleId === 2 && u.id !== 1 && u.id !== admin2.body.id);
    for (const o of others) await call('PUT', `/users/${o.id}`, { name: `Админ ${o.id}`, roleId: 5 });
    const [r1, r2] = await Promise.all([
      call('PUT', '/users/1', { name: 'Администратор', roleId: 5 }),
      call('PUT', `/users/${admin2.body.id}`, { name: 'Втори администратор', roleId: 5 }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 400]);
    expect([r1, r2].find((r) => r.status === 400)!.body.error).toBe('Трябва да има поне един потребител администратор.');
    // Restore the administrator role of user 1 (from the remaining administrator when user 1 lost it).
    const [company] = (await call('GET', '/companies')).body;
    if (r1.status === 200) {
      expect((await call('POST', '/login', { companyDb: company.name, userId: admin2.body.id, password: 'parola1' })).status).toBe(200);
      expect(((await call('GET', '/users')).body as { roleId: number }[]).filter((u) => u.roleId === 2)).toHaveLength(1);
      expect((await call('PUT', '/users/1', { name: 'Администратор', roleId: 2 })).status).toBe(200);
      expect((await call('POST', '/login', { companyDb: company.name, userId: 1, password: 'secret1' })).status).toBe(200);
    } else {
      expect(((await call('GET', '/users')).body as { roleId: number }[]).filter((u) => u.roleId === 2)).toHaveLength(1);
    }
  });

  it('voids only entries of the active year', async () => {
    const e = await t.post({ date: '2026-05-01', dr: [['501', 3]], cr: [['101', 3]] });
    expect((await call('POST', '/years', { year: 2027, force: true })).status).toBe(201);
    expect((await call('PUT', '/years/active', { year: 2027 })).status).toBe(200);
    const other = await call('DELETE', `/entries/${e.id}`);
    expect([other.status, other.body.error]).toEqual([400, 'Датата на контирането е различна от текущата счетоводна година!']);
    expect((await call('POST', '/journal/void', { ids: [e.id] })).status).toBe(400);
    expect((await call('GET', `/entries/${e.id}`)).status).toBe(200);
    expect((await call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
    expect((await call('DELETE', `/entries/${e.id}`)).status).toBe(200);
  });

  it('asks before a weak password and warns on none instead of refusing them (01b 3.4)', async () => {
    const weak = await call('POST', '/users', { name: 'Слаба парола', password: '123', roleId: 5 });
    expect([weak.status, weak.body.code, weak.body.messages.map((m: { key: string }) => m.key)]).toEqual([409, 'confirm', ['strPasswordNotSecure']]);
    expect(weak.body.error).toBe('Въведената парола не отговаря на изискванията за "силна" парола. Желаете ли продължение?');
    const saved = await call('POST', '/users', { name: 'Слаба парола', password: '123', roleId: 5, force: true });
    expect(saved.status, saved.text).toBe(201);
    const none = await call('POST', '/users', { name: 'Без парола', roleId: 5 });
    expect([none.status, none.body.messages.map((m: { key: string; severity: string }) => [m.key, m.severity])]).toEqual([409, [['strUserPasswordMissing', 'warning']]]);
    const empty = await call('POST', '/users', { name: 'Без парола', roleId: 5, force: true });
    expect(empty.status, empty.text).toBe(201);
    expect(((await call('GET', '/users')).body as { id: number; hasPassword: boolean }[]).find((u) => u.id === empty.body.id)!.hasPassword).toBe(false);
    // Changing to a weak password asks too; a strong one goes through.
    expect((await call('PUT', `/users/${saved.body.id}`, { name: 'Слаба парола', roleId: 5, password: 'abc' })).status).toBe(409);
    expect((await call('PUT', `/users/${saved.body.id}`, { name: 'Слаба парола', roleId: 5, password: 'abcdef' })).status).toBe(200);
    // Users are added in a group, not in the base group; groups only under the base group.
    const base = await call('POST', '/users', { name: 'В основната група', password: 'parola1', roleId: 1 });
    expect([base.status, base.body.error]).toEqual([400, 'Не може да създавате подгрупи в тази група']);
    const sub = await call('POST', '/roles', { name: 'Подгрупа', parentId: 5 });
    expect([sub.status, sub.body.error]).toEqual([400, 'Не може да създавате подгрупи в тази група']);
    expect((await call('POST', '/roles', { name: 'Под основната', parentId: 1 })).status).toBe(201);
    for (const id of [saved.body.id, empty.body.id]) expect((await call('DELETE', `/users/${id}`)).status).toBe(200);
  });

  it('a company with one user cannot lose it (strUserCountValidation, 01b 3.4)', async () => {
    const saved = t.session.get();
    const r = await call('POST', '/companies', { companyName: 'Един потребител ООД', adminName: 'Самичък', adminPassword: 'secret1', year: 2026, bulstat: '175074752' });
    expect(r.status, r.text).toBe(201);
    expect((await call('GET', '/users')).body).toHaveLength(1);
    const del = await call('DELETE', '/users/1');
    expect([del.status, del.body.messages?.[0]?.key, del.body.error]).toEqual([422, 'strUserCountValidation', 'Въведен е само един потребител...']);
    t.session.set(saved);
  });

  it('a company whose database cannot be created or filled: strDatabaseCreatePermissionDenied / strCompanyWasntCreated (01b 1.2)', async () => {
    const driver = t.driver as unknown as Record<string, unknown>;
    const create = t.driver.createCompanyDatabase.bind(t.driver);
    const before = ((await call('GET', '/companies')).body as unknown[]).length;
    const body = { companyName: 'Неуспешна ООД', adminName: 'Админ', adminPassword: 'secret1', year: 2026 };
    try {
      // A Postgres role without CREATEDB: insufficient_privilege.
      driver.createCompanyDatabase = async () => { throw Object.assign(new Error('permission denied to create database'), { code: '42501' }); };
      let r = await call('POST', '/companies', body);
      expect([r.status, r.body.code, r.body.error]).toEqual([500, 'strDatabaseCreatePermissionDenied', 'Фирмата не беше създадена! SQL потребителят няма достатъчно права!']);
      // Any other fault while the new database is filled: the database is dropped again.
      let createdName = '';
      driver.createCompanyDatabase = async (name: string) => {
        createdName = name;
        const db = await create(name);
        return new Proxy(db, { get: (o, k) => (k === 'transaction' ? async () => { throw new Error('disk full'); } : Reflect.get(o, k)) });
      };
      r = await call('POST', '/companies', body);
      expect([r.status, r.body.code, r.body.error]).toEqual([500, 'strCompanyWasntCreated', 'Фирмата не беше създадена!']);
      expect(createdName).not.toBe('');
      const log = (await call('GET', '/app-log')).body as { message: string }[];
      expect(log.some((e) => e.message === 'Фирмата не беше създадена! (Неуспешна ООД)')).toBe(true);
    } finally {
      driver.createCompanyDatabase = create;
    }
    expect(((await call('GET', '/companies')).body as unknown[]).length).toBe(before);
    // Rule errors keep their own text.
    const weak = await call('POST', '/companies', { ...body, adminPassword: '1' });
    expect(weak.status).toBe(400);
  });
});
