import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { exec } from '../src/db/provider.ts';
import { createTestCompany, type TestCompany } from './helpers.ts';

/** Accounting reports (spec 05 sections 3-5): trial balance, general ledger, account card, chronological register. */

let t: TestCompany;
let client = 0;
let usd = '';
const get = async (url: string) => {
  const r = await t.call('GET', url);
  expect(r.status, r.text).toBe(200);
  return r.body;
};

/** Logs in as a new user of a new group with the given permission overrides, runs fn, then returns to the admin. */
async function asLimitedUser(c: TestCompany, name: string, perms: Record<number, boolean>, fn: () => Promise<void>) {
  const role = await c.call('POST', '/roles', { name });
  expect(role.status, role.text).toBeLessThan(300);
  expect((await c.call('PUT', `/roles/${role.body.id}/permissions`, perms)).status).toBe(200);
  const u = await c.call('POST', '/users', { name: `${name} потребител`, password: 'secret1', roleId: role.body.id });
  expect(u.status, u.text).toBe(201);
  const adminId = (await c.call('GET', '/session')).body.user.id;
  expect((await c.call('POST', '/login', { companyDb: c.companyDb, userId: u.body.id, password: 'secret1' })).status).toBe(200);
  try {
    await fn();
  } finally {
    expect((await c.call('POST', '/login', { companyDb: c.companyDb, userId: adminId, password: 'secret1' })).status).toBe(200);
  }
}

beforeAll(async () => {
  t = await createTestCompany({ companyName: 'Справки ООД' });
  client = await t.partner('Клиент Справки ООД', ['411']);
  for (const [description, englishDescription] of [['Каса централна', 'Main cash'], ['Каса офис', 'Office cash']]) {
    const sub = await t.call('POST', '/accounts', { parentId: t.acc('501'), description, englishDescription });
    expect(sub.status, sub.text).toBe(201);
  }
  const cur = await t.call('POST', '/accounts', { parentId: t.acc('504'), description: 'Банка USD', accountCategoryId: 27, currencyId: 3 });
  expect(cur.status, cur.text).toBe(201);
  await t.reloadAccounts();
  usd = (await t.call('GET', '/accounts')).body.find((a: { number: string }) => a.number.startsWith('504/')).number;
  await t.post({ date: '2026-02-01', docNumber: 'K-1', term: 'Внесен капитал', dr: [['501/1', 1000]], cr: [['101', 1000]] });
  await t.post({ date: '2026-02-03', docNumber: 'K-2', term: 'Към каса офис', dr: [['501/2', 200]], cr: [['501/1', 200]] });
  await t.post({
    date: '2026-02-10', docNumber: 'F-100', term: 'Продажба', partner: client, transactionTypeId: 3,
    dr: [['411', 120, { companyId: client }]], cr: [['702', 100, { vatTermId: 7 }], ['453/2', 20, { vatTermId: 7 }]],
  });
  await t.post({ date: '2026-02-15', docNumber: 'B-1', term: 'Валутно постъпление', dr: [[usd, 920, { currencyAmount: '1000' }]], cr: [['411', 920, { companyId: client }]] });
  await t.post({ date: '2026-03-01', docNumber: 'K-3', term: 'Изплатени аванси', dr: [['422', 50]], cr: [['501/2', 50]] });
}, 90_000);
afterAll(() => t.close());

describe('permissions', () => {
  it('trial balance "По партньори" runs with the turnover right, the partner screen with its own', async () => {
    const url = '/reports/partner-turnover?account=411&from=2026-01-01&to=2026-12-31';
    // 33 = UI_Reporting_TurnoverReport, 37 = UI_Reporting_Companies_PartnersDebtReport, 134 = UI_Reporting_Companies.
    await asLimitedUser(t, 'Само оборотна', { 33: true, 37: false, 134: false }, async () => {
      const r = await t.call('GET', url);
      expect(r.status, r.text).toBe(200);
      expect(r.body.map((x: { companyName: string }) => x.companyName)).toEqual(['Клиент Справки ООД']);
    });
    await asLimitedUser(t, 'Само партньори', { 33: false, 134: true, 37: true }, async () => {
      expect((await t.call('GET', url)).status).toBe(200);
      expect((await t.call('GET', '/reports/trial-balance')).status).toBe(403);
    });
    await asLimitedUser(t, 'Без справки', { 33: false, 37: false, 134: false }, async () => {
      expect((await t.call('GET', url)).status).toBe(403);
    });
  });

  it('the chronological register needs UI_Reporting_ChronologicalReport', async () => {
    await asLimitedUser(t, 'Без хронологичен', { 34: false }, async () => {
      expect((await t.call('GET', '/journal-lines')).status).toBe(403);
    });
  });
});

describe('chronological register (05 5)', () => {
  const lines = async (q: string) => (await get(`/journal-lines?from=2026-01-01&to=2026-12-31&${q}`)) as Record<string, any>[];
  const numbers = (r: Record<string, any>[]) => r.map((l) => `${l.debitAccount}/${l.creditAccount}:${l.amount}`);

  it('debit account with and without sub-accounts, then the excluded list (acceptance check)', async () => {
    expect(numbers(await lines('debit=501&debitSub=0'))).toEqual([]);
    expect(numbers(await lines('debit=501'))).toEqual(['501/1/101:1000.00', '501/2/501/1:200.00']);
    expect(numbers(await lines('debit=501&excludeDebit=501/2'))).toEqual(['501/1/101:1000.00']);
    expect(numbers(await lines('debit=501/1&debitSub=0'))).toEqual(['501/1/101:1000.00']);
    expect(numbers(await lines('credit=501/2'))).toEqual(['422/501/2:50.00']);
    expect(numbers(await lines('credit=501&creditSub=0'))).toEqual([]);
    expect(numbers(await lines('credit=501'))).toEqual(['501/2/501/1:200.00', '422/501/2:50.00']);
    expect(numbers(await lines('credit=501&excludeCredit=501/1;501/2'))).toEqual([]);
  });

  it('filters by entry number range, document number, transaction type and VAT operation', async () => {
    const all = await lines('');
    const n = all.map((l) => l.number);
    const range = await lines(`fromNumber=${n[1]}&toNumber=${n[2]}`);
    expect([...new Set(range.map((l) => l.number))]).toEqual([n[1], all.find((l) => l.documentNumber === 'F-100')!.number]);
    expect(numbers(await lines('documentNumber=B-1'))).toEqual([`${usd}/411:920.00`]);
    expect(numbers(await lines('transactionTypeId=3'))).toEqual(['411/702:100.00', '411/453/2:20.00']);
    const vat = await lines('vatTermId=7');
    expect(numbers(vat)).toEqual(['411/702:100.00', '411/453/2:20.00']);
    expect(vat[0]!.vatTerm).toMatch(/^7 - /);
  });

  it('"Филтър по" one column and sort by a column', async () => {
    expect(numbers(await lines('filterColumn=Term&text=каса'))).toEqual(['501/2/501/1:200.00']);
    // A number typed in the account column is not matched against amounts.
    expect(await lines('filterColumn=DebitAccount&text=1000')).toEqual([]);
    expect(numbers(await lines('filterColumn=Amount&text=1000'))).toEqual(['501/1/101:1000.00']);
    expect(numbers(await lines('filterColumn=CompanyName&text=клиент'))).toEqual(['411/702:100.00', '411/453/2:20.00', `${usd}/411:920.00`]);
    const byAmount = await lines('sort=Amount');
    expect(byAmount.map((l) => l.amount)).toEqual(['20.00', '50.00', '100.00', '200.00', '920.00', '1000.00']);
    const byDebit = await lines('sort=DebitAccount');
    expect(byDebit[0]!.debitAccount).toBe('411');
    expect((await t.call('GET', '/journal-lines?sort=Nope')).status).toBe(400);
  });

  it('currency and materials variants list the lines with currency amounts / quantities', async () => {
    const fc = await lines('type=currency');
    expect(fc).toHaveLength(1);
    expect(fc[0]).toMatchObject({ debitAccount: usd, debitCurrency: 'USD', debitCurrencyAmount: '1000.00', debitExchangeRate: '0.92000', creditCurrencyAmount: null });
    expect(await lines('type=quantity')).toEqual([]);
  });
});

describe('account card (05 4.2)', () => {
  it('running balance in posting order is not changed by the sort or the filter', async () => {
    const plain = await get('/reports/analytical?account=501&from=2026-01-01&to=2026-12-31');
    expect(plain.lines.map((l: any) => [l.amount, l.balanceDebit])).toEqual([['1000.00', '1000.00'], ['200.00', '1000.00'], ['50.00', '950.00']]);
    const sorted = await get('/reports/analytical?account=501&sort=Amount&from=2026-01-01&to=2026-12-31');
    expect(sorted.lines.map((l: any) => [l.amount, l.balanceDebit])).toEqual([['50.00', '950.00'], ['200.00', '1000.00'], ['1000.00', '1000.00']]);
    const filtered = await get('/reports/analytical?account=501&filterColumn=CreditAccount&text=501/2&from=2026-01-01&to=2026-12-31');
    expect(filtered.lines.map((l: any) => [l.amount, l.balanceDebit])).toEqual([['50.00', '950.00']]);
    expect(filtered.closing.debit).toBe('950.00');
  });

  it('currency version carries the currency amount and rate, with currency totals', async () => {
    const r = await get(`/reports/analytical?account=${usd}&type=currency&from=2026-01-01&to=2026-12-31`);
    expect(r.reportType).toBe('currency');
    expect(r.lines[0]).toMatchObject({ debitCurrencyAmount: '1000.00', debitExchangeRate: '0.92000' });
    expect(r.currencyTotals).toEqual({ debit: '1000.00', credit: '0.00' });
  });

  it('materials version carries quantity and price', async () => {
    expect((await t.call('PUT', `/accounts/${t.acc('304')}`, { accountCategoryId: 3 })).status).toBe(200);
    const p = await t.call('POST', '/products', { name: 'Стока Справка', measure: 'бр.', incrementAccountIds: [t.acc('304')], decrementAccountIds: [] });
    expect(p.status, p.text).toBe(201);
    await t.reloadAccounts();
    const mat = p.body.incrementAccounts[0].number as string;
    await t.post({ date: '2026-04-01', docNumber: 'S-1', dr: [[mat, 300, { quantity: '10', price: '30' }]], cr: [['501/1', 300]] });
    const r = await get(`/reports/analytical?account=${mat}&type=quantity&from=2026-01-01&to=2026-12-31`);
    expect(r.lines[0]).toMatchObject({ debitQuantity: '10.000', debitPrice: '30.000' });
    expect(r.quantityTotals).toEqual({ debit: '10.000', credit: '0.000' });
    const chrono = await get('/journal-lines?type=quantity&from=2026-01-01&to=2026-12-31');
    expect(chrono.map((l: any) => l.debitAccount)).toEqual([mat]);
  });
});

describe('general ledger (05 4.1)', () => {
  it('carries the foreign-language account names', async () => {
    const r = await get('/reports/general-ledger?account=501&level=3&from=2026-01-01&to=2026-12-31');
    const g = r.find((x: { number: string }) => x.number === '501/2');
    expect(g.englishDescription).toBe('Office cash');
    expect(g.counters.find((c: { number: string }) => c.number === '501/1').englishDescription).toBe('Main cash');
  });
});

describe('chronological register in a mixed 2025/2026 period', () => {
  let m: TestCompany;
  beforeAll(async () => {
    m = await createTestCompany({ year: 2025, companyName: 'Смесен период ООД' });
    await m.post({ date: '2025-12-10', docNumber: 'BGN-1', dr: [['503', '195.58']], cr: [['101', '195.58']] });
    expect((await m.call('POST', '/years', { year: 2026 })).status).toBe(201);
    expect((await m.call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
    await m.reloadAccounts();
    await m.post({ date: '2026-01-10', docNumber: 'EUR-1', dr: [['503', 100]], cr: [['101', 100]] });
    // The BGN 503 is mapped to a EUR account with another number (Accounts.MappedAccountID).
    const db = await m.driver.company(m.companyDb);
    await exec(db, sql`UPDATE accounts SET mapped_account_id = (SELECT id FROM accounts WHERE is_euro AND number = '504')
      WHERE NOT is_euro AND number = '503'`);
  }, 90_000);
  afterAll(() => m.close());

  it('shows pre-2026 lines with the mapped EUR account, converted, and filters on the mapped number', async () => {
    const r = await m.call('GET', '/journal-lines?from=2025-12-01&to=2026-01-31');
    expect(r.status, r.text).toBe(200);
    expect(r.body.map((l: any) => [l.documentNumber, l.debitAccount, l.amount])).toEqual([['BGN-1', '504', '100.00'], ['EUR-1', '503', '100.00']]);
    const filtered = await m.call('GET', '/journal-lines?from=2025-12-01&to=2026-01-31&debit=504');
    expect(filtered.body.map((l: any) => l.documentNumber)).toEqual(['BGN-1']);
    // A pure BGN period keeps the BGN accounts and amounts.
    const old = await m.call('GET', '/journal-lines?from=2025-12-01&to=2025-12-31');
    expect(old.body.map((l: any) => [l.debitAccount, l.amount])).toEqual([['503', '195.58']]);
  });
});
