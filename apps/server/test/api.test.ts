import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { PgliteDriver } from '../src/db/provider.ts';

const driver = new PgliteDriver();
const app = createApp(driver);
let cookie = '';

async function call(method: string, url: string, body?: unknown) {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const set of res.headers.getSetCookie()) cookie = set.split(';')[0]!;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let accounts: { id: number; number: string }[] = [];
const acc = (n: string) => accounts.find((a) => a.number === n)!.id;

beforeAll(async () => {
  const r = await call('POST', '/companies', { companyName: 'Тест ООД', adminName: 'Администратор', adminPassword: 'secret1', year: 2026 });
  expect(r.status).toBe(201);
  accounts = (await call('GET', '/accounts')).body;
}, 60_000);
afterAll(() => driver.close());

describe('api', () => {
  it('rejects anonymous company creation once a company exists', async () => {
    const saved = cookie;
    cookie = '';
    const r = await call('POST', '/companies', { companyName: 'X', adminName: 'A', adminPassword: 'secret1', year: 2026 });
    expect(r.status).toBe(403);
    expect((await call('GET', '/session')).status).toBe(401);
    cookie = saved;
  });

  it('logs in with the admin password only', async () => {
    const [company] = (await call('GET', '/companies')).body;
    const saved = cookie;
    expect((await call('POST', '/login', { companyDb: company.name, userId: 1, password: 'wrong' })).status).toBe(401);
    expect((await call('POST', '/login', { companyDb: company.name, userId: 1, password: 'secret1' })).status).toBe(200);
    expect(cookie).not.toBe(saved);
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
  });
});
