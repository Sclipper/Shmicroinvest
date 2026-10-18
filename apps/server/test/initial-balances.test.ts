import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';

let t: TestCompany;
let call: TestCompany['call'];
beforeAll(async () => {
  t = await createTestCompany();
  call = t.call;
}, 60_000);
afterAll(() => t.close());

const keys = (r: { body: { messages?: { key: string }[] } }) => (r.body.messages ?? []).map((m) => m.key);
const tb = async () => {
  const r = await call('GET', '/reports/trial-balance?from=2026-01-01&to=2026-12-31&level=3');
  return (n: string) => r.body.rows.find((x: { number: string }) => x.number === n);
};

describe('opening balances (01b 7)', () => {
  it('stores a simple account balance as an opening entry on the same account', async () => {
    const r = await call('PUT', `/initial-balances/${t.acc('501')}`, { date: '2026-01-01', rows: [{ debit: '850' }] });
    expect(r.status, r.text).toBe(200);
    const row = (await tb())('501');
    expect([row.openingDebit, row.openingCredit, row.debitTurnover]).toEqual(['850.00', '0.00', '0.00']);
    const list = (await call('GET', `/initial-balances?accountId=${t.acc('501')}`)).body.rows;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ debit: '850.00', credit: '0.00', date: '2026-01-01' });
    // Saving again replaces, it does not add.
    await call('PUT', `/initial-balances/${t.acc('501')}`, { date: '2026-01-01', rows: [{ debit: '900' }] });
    expect((await tb())('501').openingDebit).toBe('900.00');
  });

  it('rejects debit and credit together and rounds half away from zero', async () => {
    const both = await call('PUT', `/initial-balances/${t.acc('101')}`, { date: '2026-01-01', rows: [{ debit: '100', credit: '50' }] });
    expect(both.status).toBe(422);
    expect(keys(both)).toEqual(['strInitialBalancesBothSetError']);
    expect(both.body.messages[0].text).toBe('Началните салда в дебит и в кредит са различни от 0. Задайте едно от тях на 0.');
    await call('PUT', `/initial-balances/${t.acc('101')}`, { date: '2026-01-01', rows: [{ credit: '10.005' }] });
    expect((await tb())('101').openingCredit).toBe('10.01');
  });

  it('warns on a synthetic account with sub-accounts and saves only when confirmed', async () => {
    const warn = await call('PUT', `/initial-balances/${t.acc('453')}`, { date: '2026-01-01', rows: [{ credit: '20' }] });
    expect(warn.status).toBe(422);
    expect(warn.body.code).toBe('warnings');
    expect(keys(warn)).toEqual(['strInitalBalanceOnSyntheticAccountWarning']);
    const ok = await call('PUT', `/initial-balances/${t.acc('453')}`, { date: '2026-01-01', rows: [{ credit: '20' }], force: true });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.warnings).toHaveLength(1);
  });

  it('partner accounts need a partner per row, no duplicates, and documents need type and number', async () => {
    const a = await t.partner('Клиент А ООД');
    const b = await t.partner('Клиент Б ООД');
    const id = t.acc('411');
    const noPartner = await call('PUT', `/initial-balances/${id}`, { date: '2026-01-01', rows: [{ debit: '10' }] });
    expect(keys(noPartner)).toContain('strNotCorrectCompanyInitialBalance');
    const dup = await call('PUT', `/initial-balances/${id}`, { date: '2026-01-01', rows: [{ companyId: a, debit: '10' }, { companyId: a, debit: '5' }] });
    expect(keys(dup)).toContain('strInitialBalancesDuplicateError');
    const noNumber = await call('PUT', `/initial-balances/${id}`, { date: '2026-01-01', rows: [{ companyId: a, documentTypeId: 1, debit: '10' }] });
    expect(keys(noNumber)).toContain('strInitialBalancesEmptyDocumentNumberError');
    const nonPartner = await call('PUT', `/initial-balances/${t.acc('501')}`, { date: '2026-01-01', rows: [{ companyId: a, debit: '10' }] });
    expect(keys(nonPartner)).toContain('strCompanyNotAllowed');

    const ok = await call('PUT', `/initial-balances/${id}`, {
      date: '2026-01-01',
      rows: [
        { companyId: a, documentTypeId: 1, documentNumber: '1001', documentDate: '2025-12-15', debit: '600' },
        { companyId: a, documentTypeId: 1, documentNumber: '1002', documentDate: '2025-12-20', debit: '150' },
        { companyId: b, debit: '40' },
      ],
    });
    expect(ok.status, ok.text).toBe(200);
    const rows = (await call('GET', `/initial-balances?accountId=${id}`)).body.rows;
    expect(rows.map((r: { company: string; documentNumber: string | null; debit: string }) => [r.company, r.documentNumber, r.debit])).toEqual([
      ['Клиент А ООД', '1001', '600.00'], ['Клиент А ООД', '1002', '150.00'], ['Клиент Б ООД', null, '40.00'],
    ]);
    expect((await tb())('411').openingDebit).toBe('790.00');
    // Partner turnover sees the opening per partner.
    const pt = await call('GET', `/reports/partner-turnover?from=2026-01-01&to=2026-12-31&account=411`);
    expect(pt.status, pt.text).toBe(200);
    expect(JSON.stringify(pt.body)).toContain('Клиент Б ООД');
  });

  it('is not month-lock checked but the date must be in the active year', async () => {
    const years = (await call('GET', '/years')).body;
    await call('PUT', `/years/${years[0].id}/locks`, { months: [1] });
    expect((await call('PUT', `/initial-balances/${t.acc('502')}`, { date: '2026-01-01', rows: [{ debit: '5' }] })).status).toBe(200);
    await call('PUT', `/years/${years[0].id}/locks`, { months: [] });
    const other = await call('PUT', `/initial-balances/${t.acc('502')}`, { date: '2025-12-31', rows: [{ debit: '5' }] });
    expect(keys(other)).toEqual(['strInitialBalancesDateMustBeInCurrentYear']);
  });

  it('currency accounts keep the currency amount and rate', async () => {
    const parent = t.acc('503');
    const usd = (await call('GET', '/currencies')).body.find((c: { isoCode: string }) => c.isoCode === 'USD');
    const sub = await call('POST', '/accounts', { parentId: parent, description: 'Сметка в USD', currencyId: usd.id });
    expect(sub.status, sub.text).toBe(201);
    const r = await call('PUT', `/initial-balances/${sub.body.id}`, { date: '2026-01-01', rows: [{ debit: '920', currencyDebit: '1000' }] });
    expect(r.status, r.text).toBe(200);
    const [row] = (await call('GET', `/initial-balances?accountId=${sub.body.id}`)).body.rows;
    expect([row.debit, row.currencyDebit, Number(row.exchangeRate)]).toEqual(['920.00', '1000.00', 0.92]);
  });

  it('deletes an account balance', async () => {
    await call('DELETE', `/initial-balances/${t.acc('501')}`);
    expect((await tb())('501')?.openingDebit ?? '0.00').toBe('0.00');
    expect((await call('GET', `/initial-balances?accountId=${t.acc('501')}`)).body.rows).toHaveLength(0);
  });
});
