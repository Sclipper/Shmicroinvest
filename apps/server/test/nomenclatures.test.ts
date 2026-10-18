import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';

let t: TestCompany;
const keys = (r: { body: { messages?: { key: string }[]; warnings?: { key: string }[] } }) => (r.body.messages ?? r.body.warnings ?? []).map((m) => m.key);

beforeAll(async () => {
  t = await createTestCompany();
}, 60_000);
afterAll(() => t.close());

describe('partners (03a 2.12 acceptance)', () => {
  it('accepts the 15-nines placeholder without EIK warning and ignores it for duplicates', async () => {
    const a = await t.call('POST', '/partners', { name: 'Плейсхолдер 1', bulstat: '999999999999999', accountIds: [t.acc('411')] });
    expect(a.status).toBe(201);
    expect(keys(a)).not.toContain('strInvalidEIKOrVAtNumber');
    const b = await t.call('POST', '/partners', { name: 'Плейсхолдер 2', bulstat: '999999999999999', accountIds: [t.acc('411')] });
    expect(b.status).toBe(201);
  });

  it('blocks a second partner with the same name', async () => {
    await t.partner('Яна ООД');
    const r = await t.call('POST', '/partners', { name: 'яна оод', accountIds: [t.acc('411')] });
    expect(r.status).toBe(422);
    expect(keys(r)).toContain('strCompanyNameExists');
  });

  it('requires a VAT number when VAT-registered', async () => {
    const r = await t.call('POST', '/partners', { name: 'ДДС Без Номер', bulstat: '831903180', isVat: true, accountIds: [t.acc('411')] });
    expect(r.status).toBe(422);
    expect(keys(r)).toContain('strCompanyVatNumberIsEmpty');
  });

  it('warns on an invalid or 13-digit EIK but saves', async () => {
    const bad = await t.call('POST', '/partners', { name: 'Грешен ЕИК', bulstat: '831903183', accountIds: [t.acc('411')] });
    expect(bad.status).toBe(201);
    expect(keys(bad)).toContain('strInvalidEIKOrVAtNumber');
    const long = await t.call('POST', '/partners', { name: 'Клон ЕИК', bulstat: '8319031801234', accountIds: [t.acc('411')] });
    expect(long.status).toBe(201);
    expect(keys(long)).toContain('strInvalidEIKOrVAtNumber');
  });

  it('validates due days 0..999', async () => {
    for (const [d, ok] of [[1000, false], [-1, false], [999, true], [0, true]] as const) {
      const r = await t.call('POST', '/partners', { name: `Падеж ${d}`, dueDays: d, accountIds: [t.acc('411')] });
      expect(r.status, String(d)).toBe(ok ? 201 : 422);
      if (!ok) expect(keys(r)).toContain('strDueDaysInvalid');
    }
  });

  it('lists frequent partners first, then by name', async () => {
    await t.call('POST', '/partners', { name: 'Ана Сорт', accountIds: [t.acc('411')] });
    await t.call('POST', '/partners', { name: 'Яна Сорт', priority: true, accountIds: [t.acc('411')] });
    const list = (await t.call('GET', '/partners?q=Сорт')).body.map((p: { name: string }) => p.name);
    expect(list).toEqual(['Яна Сорт', 'Ана Сорт']);
  });

  it('postal code must be numeric and city at most 50 characters', async () => {
    const ok = await t.call('POST', '/partners', { name: 'Адрес ОК', accountIds: [t.acc('411')], addresses: [{ countryId: 1, city: 'София', postalCode: '1000' }] });
    expect(ok.status).toBe(201);
    const bad = await t.call('POST', '/partners', { name: 'Адрес Лош', accountIds: [t.acc('411')], addresses: [{ countryId: 1, city: 'x'.repeat(51), postalCode: 'SW1A' }] });
    expect(bad.status).toBe(422);
    expect(keys(bad)).toEqual(expect.arrayContaining(['strInvalidAddressPostalCode', 'strCityNameTooLong']));
  });

  it('accepts accounts whose ancestor has a partner category, rejects others', async () => {
    const parent = t.acc('411');
    const sub = await t.call('POST', '/accounts', { parentId: parent, description: 'Клиенти – вътрешен пазар' });
    expect(sub.status, sub.text).toBe(201);
    await t.call('PUT', `/accounts/${sub.body.id}`, { accountCategoryId: null });
    const ok = await t.call('POST', '/partners', { name: 'Подсметка', accountIds: [sub.body.id] });
    expect(ok.status, ok.text).toBe(201);
    const bad = await t.call('POST', '/partners', { name: 'Каса', accountIds: [t.acc('501')] });
    expect(keys(bad)).toContain('strAccountDoesNotSupportCompanies');
  });

  it('refuses to delete a partner with postings', async () => {
    const id = await t.partner('С операции', ['401']);
    await t.post({ date: '2026-02-01', partner: id, dr: [['602', 10]], cr: [['401', 10]] });
    const r = await t.call('DELETE', `/partners/${id}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Партньорът не може да бъде изтрит, тъй като участва в операции!');
  });
});

describe('partner groups', () => {
  it('names new groups "Нова група N" and protects groups with children or members', async () => {
    const g1 = await t.call('POST', '/partner-groups', { parentId: 1 });
    const g2 = await t.call('POST', '/partner-groups', { parentId: 1 });
    expect([g1.body.name, g2.body.name]).toEqual(['Нова група 1', 'Нова група 2']);
    await t.call('POST', '/partner-groups', { parentId: g1.body.id, name: 'Под' });
    const blocked = await t.call('DELETE', `/partner-groups/${g1.body.id}`);
    expect(blocked.body.error).toBe('Избраната група не може да бъде изтрита, тъй като съдържа подгрупи!');
    await t.call('POST', '/partners', { name: 'Член', groupId: g2.body.id, accountIds: [t.acc('411')] });
    const notEmpty = await t.call('DELETE', `/partner-groups/${g2.body.id}`);
    expect(notEmpty.body.error).toBe('Избраната група не може да бъде изтрита, тъй като не е празна!');
    expect((await t.call('DELETE', '/partner-groups/1')).status).toBe(400);
  });
});

describe('branches', () => {
  it('requires name and code, and blocks deleting a branch with operations', async () => {
    const empty = await t.call('POST', '/branches', { code: '', name: '' });
    expect(keys(empty)).toEqual(['strBranchNameIsEmpty', 'strBranchCodeIsEmpty']);
    const b = await t.call('POST', '/branches', { code: '02', name: 'Пловдив', address: { city: 'Пловдив', countryId: 1 } });
    expect(b.status).toBe(201);
    const list = (await t.call('GET', '/branches')).body as { id: number; name: string; address: { city: string } | null }[];
    expect(list.find((x) => x.id === b.body.id)?.address?.city).toBe('Пловдив');
    await t.call('PUT', '/session/branch', { branchId: b.body.id });
    await t.post({ date: '2026-02-02', dr: [['501', 5]], cr: [['101', 5]] });
    await t.call('PUT', '/session/branch', { branchId: 1 });
    const del = await t.call('DELETE', `/branches/${b.body.id}`);
    expect(del.body.error).toBe('Избраният клон не може да бъде изтрит, тъй като участва в операции!');
    const free = await t.call('POST', '/branches', { code: '03', name: 'Варна' });
    expect((await t.call('DELETE', `/branches/${free.body.id}`)).status).toBe(200);
  });
});
