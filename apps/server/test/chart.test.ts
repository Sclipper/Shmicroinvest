import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chartTemplateAccounts } from '@shmi/core';
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

  it('an account used by a bank-import rule cannot be deleted', async () => {
    const r = await add('629', {});
    expect(r.status, r.text).toBe(201);
    const db = await t.driver.company(t.companyDb);
    await db.execute(`INSERT INTO bank_templates (bank_id, name) VALUES ((SELECT min(id) FROM banks), 'Такси')`);
    await db.execute(`INSERT INTO bank_template_details (template_id, ref_account_id) VALUES ((SELECT max(id) FROM bank_templates), ${r.body.id})`);
    expect((await call('GET', `/accounts/${r.body.id}/delete-info`)).body.blockers).toEqual(['Сметката участва в шаблони за банков импорт.']);
    expect((await call('DELETE', `/accounts/${r.body.id}`)).status).toBe(422);
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

  it('stores the conclude account for active and passive accounts only (01a 4.1, 07 3.5)', async () => {
    const expense = await add('602', { number: '602/50', isActive: true, concludeAccountId: t.acc('123') });
    expect(expense.status, expense.text).toBe(201);
    expect(expense.body.concludeAccountId).toBe(t.acc('123'));
    const listed = (await call('GET', '/accounts')).body.find((a: { id: number }) => a.id === expense.body.id);
    expect(listed.concludeAccountId).toBe(t.acc('123'));
    // Switching to active-passive clears it; an active-passive account cannot get one.
    const ap = await call('PUT', `/accounts/${expense.body.id}`, { isActive: null });
    expect(ap.status, ap.text).toBe(200);
    expect(ap.body.concludeAccountId).toBeNull();
    const stillAp = await call('PUT', `/accounts/${expense.body.id}`, { concludeAccountId: t.acc('123') });
    expect(stillAp.body.concludeAccountId).toBeNull();
    const passive = await call('PUT', `/accounts/${expense.body.id}`, { isActive: false, concludeAccountId: t.acc('123') });
    expect(passive.body.concludeAccountId).toBe(t.acc('123'));
    // Itself is not a conclude account; an unknown account is refused.
    expect((await call('PUT', `/accounts/${expense.body.id}`, { concludeAccountId: expense.body.id })).body.concludeAccountId).toBeNull();
    expect((await call('PUT', `/accounts/${expense.body.id}`, { concludeAccountId: 999999 })).status).toBe(400);
  });

  it('edits the "usable for bank statements" flag (01a 4.1 IsForBanks)', async () => {
    const r = await add('503', { number: '503/40', isForBanks: true });
    expect(r.status, r.text).toBe(201);
    expect(r.body.isForBanks).toBe(true);
    const off = await call('PUT', `/accounts/${r.body.id}`, { isForBanks: false });
    expect(off.body.isForBanks).toBe(false);
    const listed = (await call('GET', '/accounts')).body.find((a: { id: number }) => a.id === r.body.id);
    expect(listed.isForBanks).toBe(false);
    // Other edits keep the flag.
    await call('PUT', `/accounts/${r.body.id}`, { isForBanks: true });
    expect((await call('PUT', `/accounts/${r.body.id}`, { description: 'Банка 2' })).body.isForBanks).toBe(true);
  });
  it('a new non-material account cannot sit next to material analytics (strAnalyticAccountsExistOnTheSameLevelError, 03a 1.6)', async () => {
    // The commercial template attaches no category to 302 (01a 6.3): Материали (1) makes it a product account.
    expect((await call('PUT', `/accounts/${t.acc('302')}`, { accountCategoryId: 1 })).status).toBe(200);
    const mat = await add('302', { description: 'Брашно', accountType: 'material', measure: 'кг.' });
    expect(mat.status, mat.text).toBe(201);
    const plain = await add('302', { description: 'Обикновена' });
    expect([plain.status, keys(plain)]).toEqual([422, ['strAnalyticAccountsExistOnTheSameLevelError']]);
    expect(plain.body.messages[0].text).toBe('Сметката не може да бъде създадена. На същото ниво съществуват една или повече аналитични подсметки.');
    expect(keys(await add('302', { description: 'Валутна', accountType: 'currency', currencyId: 1 }))).toContain('strAnalyticAccountsExistOnTheSameLevelError');
    // Another material analytic is fine; so is a plain sub-account where no material one exists.
    expect((await add('302', { description: 'Захар', accountType: 'material', measure: 'кг.' })).status).toBe(201);
    expect((await add('602', { description: 'Обикновена' })).status).toBe(201);
  });
});

describe('chart-of-accounts templates (01a 7, 03a 1.3-1.4)', { timeout: 120_000 }, () => {
  type Acc = { id: number; number: string; description: string; categoryId: number | null; parentId: number | null };
  const nonRoot = (list: Acc[]) => list.filter((a) => a.number !== '0');
  const chartSizes = async (c: TestCompany) => {
    const db = await c.driver.company(c.companyDb);
    return ((await db.execute(`SELECT is_euro, count(*)::int AS n FROM accounts WHERE number <> '0' GROUP BY is_euro ORDER BY is_euro`)) as unknown as { rows: unknown[] }).rows;
  };

  it('a non-profit company gets the ЮЛНЦ chart (EUR chart from 2026) and its F4 templates', async () => {
    const n = await createTestCompany({ chartTemplate: 'nonProfit', companyName: 'Сдружение Тест' });
    try {
      const s = (await n.call('GET', '/session')).body;
      expect([s.chartOfAccountsType, s.chartIsEmpty, s.settings.IsParagraphEnabled]).toEqual(['nonProfit', false, 'False']);
      const accs = (await n.call('GET', '/accounts')).body as Acc[];
      expect(nonRoot(accs)).toHaveLength(chartTemplateAccounts('nonProfit').length);
      const by = new Map(accs.map((a) => [a.number, a]));
      expect(by.get('712')!.description).toBe('Приходи от членски внос');
      expect(by.get('609/1/1')).toMatchObject({ categoryId: 45, parentId: by.get('609/1')!.id });
      expect(by.get('453/1')!.categoryId).toBe(16);
      expect(by.has('415')).toBe(false);
      expect(await chartSizes(n)).toEqual([{ is_euro: true, n: 301 }]);
      // F4 offers the missing accounts of the chosen template.
      expect((await n.call('DELETE', `/accounts/${by.get('716')!.id}`)).status).toBe(200);
      const f4 = (await n.call('GET', '/accounts/templates?q=71')).body as { number: string }[];
      expect(f4.map((a) => a.number)).toEqual(['716']);
    } finally {
      await n.close();
    }
  });

  it('a budget company gets the 4-digit budget chart in BGN and EUR and IsParagraphEnabled', async () => {
    const b = await createTestCompany({ chartTemplate: 'budget', year: 2025, companyName: 'Община Тест' });
    try {
      const s = (await b.call('GET', '/session')).body;
      expect([s.chartOfAccountsType, s.settings.IsParagraphEnabled]).toEqual(['budget', 'True']);
      const accs = (await b.call('GET', '/accounts')).body as Acc[];
      const n = chartTemplateAccounts('budget').length;
      expect(nonRoot(accs)).toHaveLength(n);
      const by = new Map(accs.map((a) => [a.number, a]));
      expect(by.get('1001')).toMatchObject({ description: 'Разполагаем капитал', parentId: by.get('100')!.id });
      expect(by.get('5011')!.categoryId).toBe(21);
      expect(by.get('4511/9')).toMatchObject({ categoryId: 36, parentId: by.get('4511')!.id });
      // A EUR year gets the budget chart too (the type is stored per database).
      const y = await b.call('POST', '/years', { year: 2026, force: true });
      expect(y.status, y.text).toBe(201);
      expect(await chartSizes(b)).toEqual([{ is_euro: false, n }, { is_euro: true, n }]);
    } finally {
      await b.close();
    }
  });

  it('adding accounts of another template keeps the chart type; a copied budget chart turns on Параграф', async () => {
    const c = await createTestCompany({ companyName: 'Смесен Тест' });
    try {
      const add = await c.call('POST', '/accounts/template', { type: 'budget', numbers: ['4511/1'] });
      expect(add.status, add.text).toBe(200);
      expect(add.body.added).toBeGreaterThan(0);
      let s = (await c.call('GET', '/session')).body;
      expect([s.chartOfAccountsType, s.settings.IsParagraphEnabled]).toEqual(['commercial', 'False']);
    } finally {
      await c.close();
    }
    const b = await createTestCompany({ chartTemplate: 'budget', companyName: 'Община Източник' });
    try {
      const r = await b.call('POST', '/companies', { companyName: 'Община Копие', adminName: 'Админ', adminPassword: 'secret2', year: 2026, transfer: { chartOfAccounts: true } });
      expect(r.status, r.text).toBe(201);
      const s = (await b.call('GET', '/session')).body;
      expect([s.company.name, s.chartOfAccountsType, s.settings.IsParagraphEnabled]).toEqual(['Община Копие', 'budget', 'True']);
    } finally {
      await b.close();
    }
  });

  it('"Избор на сметкоплан" adds selected budget accounts with their ancestors to an empty chart', async () => {
    const e = await createTestCompany({ companyName: 'Празна Тест' });
    try {
      const r = await e.call('POST', '/companies', { companyName: 'Без сметкоплан ЕООД', adminName: 'Админ', adminPassword: 'secret2', year: 2026, chartTemplate: null });
      expect(r.status, r.text).toBe(201);
      const add = await e.call('POST', '/accounts/template', { type: 'budget', numbers: ['4511/1'] });
      expect(add.status, add.text).toBe(200);
      expect(add.body.added).toBe(5);
      const numbers = nonRoot((await e.call('GET', '/accounts')).body as Acc[]).map((a) => a.number).sort();
      expect(numbers).toEqual(['4', '45', '451', '4511', '4511/1']);
      const s = (await e.call('GET', '/session')).body;
      expect([s.chartOfAccountsType, s.settings.IsParagraphEnabled]).toEqual(['budget', 'True']);
    } finally {
      await e.close();
    }
  });
});
