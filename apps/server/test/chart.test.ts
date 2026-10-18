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
const add = (parent: string, body: Record<string, unknown>) => call('POST', '/accounts', { parentId: t.acc(parent), description: 'Тестова', ...body });
const root = async () => (await call('GET', '/accounts')).body.find((a: { number: string }) => a.number === '0').id;

describe('chart of accounts rules (03a 1.5-1.9)', () => {
  it('checks the number shape per level and normalises separators', async () => {
    const r = await call('POST', '/accounts', { parentId: await root(), number: '55', description: 'X' });
    expect(keys(r)).toEqual(['strInvalidAccountNumber']);
    expect(keys(await add('40', { number: '411' }))).toContain('strInvalidAccountNumber');
    expect(keys(await add('401', { number: '401x' }))).toContain('strInvalidAccountNumber');
    const dotted = await add('401', { number: '401.7' });
    expect(dotted.status, dotted.text).toBe(201);
    expect(dotted.body.number).toBe('401/7');
  });

  it('suggests the first free sub-account number', async () => {
    await add('401', { number: '401/1' });
    await add('401', { number: '401/3' });
    const r = await add('401', {});
    expect(r.body.number).toBe('401/2');
  });

  it('rejects duplicates and an empty description', async () => {
    expect(keys(await add('401', { number: '401/1' }))).toEqual(['strAccountAlreadyExists']);
    const hidden = await add('401', { number: '401/9', isHidden: true });
    expect(hidden.status).toBe(201);
    expect(keys(await add('401', { number: '401/9' }))).toEqual(['strAccountAlreadyExistsAndIsHidden']);
    expect(keys(await add('401', { number: '401/8', description: ' ' }))).toEqual(['strInvalidAccountDescription']);
  });

  it('keeps sub-account categories with the parent and unique categories unique', async () => {
    const supplierCategory = (await call('GET', '/accounts')).body.find((a: { number: string }) => a.number === '401').categoryId;
    expect(supplierCategory).toBeTruthy();
    expect(keys(await add('401', { number: '401/20', accountCategoryId: 10 }))).toContain('strAccountCategoryDifferentFromParent');
    expect(keys(await add('40', { number: '400', accountCategoryId: supplierCategory }))).toEqual(['strAccountCategoryAlreadyTakenError']);
    expect((await add('40', { number: '400', accountCategoryId: 54 })).status).toBe(201); // "Други кредитори" may repeat
  });

  it('does not allow sub-accounts of a foreign-currency account', async () => {
    const usd = (await call('GET', '/currencies')).body.find((c: { isoCode: string }) => c.isoCode === 'USD');
    const cur = await add('503', { currencyId: usd.id });
    expect(cur.status, cur.text).toBe(201);
    const sub = await call('POST', '/accounts', { parentId: cur.body.id, description: 'Под' });
    expect(keys(sub)).toEqual(['strCanNotAddSubAccount']);
  });

  it('lists the reasons a used account cannot be deleted and what the confirmation must mention', async () => {
    await t.reloadAccounts();
    const p = await t.partner('Доставчик ООД', ['401/2']);
    await t.post({ date: '2026-03-01', partner: p, dr: [['601', '10']], cr: [['401/2', '10', { companyId: p }]] });
    const info = (await call('GET', `/accounts/${t.acc('401/2')}/delete-info`)).body;
    expect(info).toMatchObject({ hasPartners: true, hasBankAccount: false, blockers: ['Сметката участва в операции.'] });
    const r = await call('DELETE', `/accounts/${t.acc('401/2')}`);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('Сметката не може да бъде изтрита!');
    expect((await call('GET', `/accounts/${t.acc('401')}/delete-info`)).body.blockers).toContain('Сметката има подсметки.');
  });

  it('"move" copies a subtree with new numbers', async () => {
    const beforeRows = (await call('GET', '/accounts')).body as { id: number }[];
    const before = beforeRows.length;
    const r = await call('POST', `/accounts/${t.acc('402')}/copy`, { targetId: t.acc('40') });
    expect(r.status, r.text).toBe(201);
    await t.reloadAccounts();
    const after = (await call('GET', '/accounts')).body;
    expect(after.length).toBe(before + r.body.copied);
    const copy = after.find((a: { id: number; parentId: number }) => a.parentId === t.acc('40') && !beforeRows.some((b) => b.id === a.id));
    expect(copy.description).toBe(after.find((a: { number: string }) => a.number === '402').description);
    // Copying into the account's own branch is refused.
    expect(keys(await call('POST', `/accounts/${t.acc('40')}/copy`, { targetId: t.acc('402') }))).toEqual(['strCanNotAddSubAccount']);
  });
});
