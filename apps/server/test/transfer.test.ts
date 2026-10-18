import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';

let t: TestCompany;
beforeAll(async () => {
  t = await createTestCompany({ companyName: 'Източник ООД' });
  const client = await t.partner('Клиент Прехвърляне ЕООД', ['411'], { addresses: [{ city: 'Варна', address: 'бул. Приморски 1' }] });
  await t.post({ date: '2026-02-01', term: 'Внесен капитал', dr: [['501', '1000']], cr: [['101', '1000']] });
  await t.post({ date: '2026-02-10', term: 'Продажба', partner: client, dr: [['411', '120', { companyId: client }]], cr: [['702', '100'], ['453/2', '20']] });
  await t.call('POST', '/users', { name: 'Мария Иванова', password: 'parola1', roleId: 5 });
}, 60_000);
afterAll(() => t.close());

const newCompany = (name: string, transfer?: object) =>
  t.call('POST', '/companies', { companyName: name, adminName: 'Админ', adminPassword: 'secret2', year: 2026, transfer });

describe('new company with data carried over (01b 1.2)', () => {
  it('copies chart, users, partners and entries; numbering continues', async () => {
    const srcAccounts = (await t.call('GET', '/accounts')).body.length;
    const srcTb = (await t.call('GET', '/reports/trial-balance?from=2026-01-01&to=2026-12-31&level=3')).body.totals;
    const src = t.session.get();

    const r = await newCompany('Копие ООД', { chartOfAccounts: true, users: true, partners: true, accountings: true });
    expect(r.status, r.text).toBe(201);
    // The new company is now active.
    expect((await t.call('GET', '/session')).body.company.name).toBe('Копие ООД');
    expect((await t.call('GET', '/accounts')).body.length).toBe(srcAccounts);
    const partner = (await t.call('GET', '/partners?q=Прехвърляне')).body[0];
    expect([partner.name, partner.city]).toEqual(['Клиент Прехвърляне ЕООД', 'Варна']);
    const list = (await t.call('GET', '/entries')).body;
    expect(list.total).toBe(2);
    expect(list.rows.find((x: { term: string }) => x.term === 'Продажба').company).toBe('Клиент Прехвърляне ЕООД');
    const tb = (await t.call('GET', '/reports/trial-balance?from=2026-01-01&to=2026-12-31&level=3')).body.totals;
    expect(tb).toEqual(srcTb);
    expect((await t.call('GET', '/entries/next-number')).body.number).toBe('0000000003');
    const users = (await t.call('GET', '/users')).body.map((u: { name: string }) => u.name);
    expect(users).toEqual(expect.arrayContaining(['Админ', 'Мария Иванова']));
    // Copied users keep their passwords.
    const mariaId = (await t.call('GET', `/companies/${r.body.name}/users`)).body.find((u: { name: string }) => u.name === 'Мария Иванова').id;
    expect((await t.call('POST', '/login', { companyDb: r.body.name, userId: mariaId, password: 'parola1' })).status).toBe(200);
    t.session.set(src);
  });

  it('copies only partners when asked and seeds a fresh chart', async () => {
    const r = await newCompany('Само партньори ООД', { partners: true });
    expect(r.status, r.text).toBe(201);
    expect((await t.call('GET', '/partners?q=Прехвърляне')).body).toHaveLength(1);
    expect((await t.call('GET', '/entries')).body.total).toBe(0);
    expect((await t.call('GET', '/users')).body).toHaveLength(1);
    expect((await t.call('GET', '/accounts')).body.length).toBeGreaterThan(100);
  });

  it('starts empty without carry-over', async () => {
    expect((await newCompany('Празна ООД')).status).toBe(201);
    expect((await t.call('GET', '/partners')).body).toHaveLength(0);
  });
});
