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

describe('new company with data carried over (01b 1.2)', { timeout: 60_000 }, () => {
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

  it('carries over accounting templates and bank-import templates with their formulas (01b 1.2, 06 3.6)', async () => {
    const src = t.session.get();
    const bankId = ((await t.call('GET', '/banks')).body as { id: number; code: string }[]).find((b) => b.code === 'STSABGSF')!.id;
    const client = (await t.call('GET', '/partners?q=Прехвърляне')).body[0].id as number;
    const tpl = await t.call('POST', '/templates', {
      name: 'Наем офис', documentTypeId: 10, term: 'Начислен наем', companyId: client,
      debits: [{ accountId: t.acc('602'), amount: '500' }], credits: [{ accountId: t.acc('401'), amount: '500' }],
      schedule: { mode: 2, interval: 1, weekDays: 0, months: 4095, days: 1 },
    });
    expect(tpl.status, tpl.text).toBe(201);
    const bt = await t.call('POST', '/bank-templates', { bankId, name: 'Банкови такси', formula: 'Reason съдържа "такса"', debitAccountId: t.acc('602'), termText: 'такса', priority: 2 });
    expect(bt.status, bt.text).toBe(201);
    const srcBank = (await t.call('GET', `/bank-templates?bankId=${bankId}`)).body.find((x: { name: string }) => x.name === 'Банкови такси');

    const r = await newCompany('Шаблони ООД', { accountingTemplates: true, bankTemplates: true });
    expect(r.status, r.text).toBe(201);
    // Templates bring the chart and its type; no entries, partners or users.
    expect((await t.call('GET', '/session')).body.chartOfAccountsType).toBe('commercial');
    expect((await t.call('GET', '/entries')).body.total).toBe(0);
    expect((await t.call('GET', '/partners')).body).toHaveLength(0);
    const list = (await t.call('GET', '/templates')).body as { id: number; name: string }[];
    const copied = list.find((x) => x.name === 'Наем офис')!;
    expect(copied).toBeTruthy();
    const full = (await t.call('GET', `/templates/${copied.id}`)).body;
    expect(full.companyId ?? null).toBeNull();
    expect(full.schedule).toMatchObject({ mode: 2, months: 4095 });
    const banks = (await t.call('GET', `/bank-templates?bankId=${bankId}`)).body as { name: string; formula: string; debitAccountNumber: string; priority: number }[];
    const b = banks.find((x) => x.name === 'Банкови такси')!;
    expect(b).toMatchObject({ debitAccountNumber: '602', priority: 2, formula: srcBank.formula });

    // Without the options nothing of the kind is copied.
    t.session.set(src);
    expect((await newCompany('Без шаблони ООД', { chartOfAccounts: true })).status).toBe(201);
    expect((await t.call('GET', '/templates')).body).toHaveLength(0);
    expect((await t.call('GET', `/bank-templates?bankId=${bankId}`)).body).toHaveLength(0);
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
