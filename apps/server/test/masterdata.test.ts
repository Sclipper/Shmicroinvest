import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';

let t: TestCompany;
let call: TestCompany['call'];
beforeAll(async () => {
  t = await createTestCompany();
  call = t.call;
}, 60_000);
afterAll(() => t.close());

const keys = (r: { body: { messages?: { key: string }[]; warnings?: { key: string }[] } }) => (r.body.messages ?? r.body.warnings ?? []).map((m) => m.key);

describe('own company (03a 3)', () => {
  const base = { name: 'Тест ООД', bulstat: '831903180', contactName: 'Иван Иванов', isVat: false, addresses: [], bankAccounts: [] };
  it('blocks an empty name and a missing VAT number, warns about the rest and still saves', async () => {
    const bad = await call('PUT', '/my-company', { ...base, name: '', isVat: true });
    expect(bad.status).toBe(422);
    expect(keys(bad)).toEqual(expect.arrayContaining(['strMyCompanyNameIsEmpty', 'strMyCompanyVatNumberIsEmpty', 'strMyCompanyVATSubscriberNameIsEmpty', 'strMyCompanyVATSubscriberEGNIsInvalid', 'strMyCompanyVATSubscriberPositionIsEmpty']));
    const warn = await call('PUT', '/my-company', { ...base, bulstat: '831903183', contactName: '', email: 'not-an-email' });
    expect(warn.status, warn.text).toBe(200);
    expect(keys(warn)).toEqual(['strInvalidBulstat', 'strMyCompanyContactNameIsEmpty', 'strInvalidEmail']);
  });

  it('accepts a valid subscriber EGN and flags an invalid one (acceptance 3.4)', async () => {
    const vat = { ...base, isVat: true, vatId: 'BG831903180', vatDeclarationSubscriberName: 'Иван Иванов', vatDeclarationSubscriberPosition: 'Управител' };
    expect(keys(await call('PUT', '/my-company', { ...vat, vatDeclarationSubscriberEgn: '8001011236' }))).toEqual([]);
    expect(keys(await call('PUT', '/my-company', { ...vat, vatDeclarationSubscriberEgn: '8001011230' }))).toEqual(['strMyCompanyVATSubscriberEGNIsInvalid']);
  });

  it('links a ledger account to one bank account only (7.2)', async () => {
    const acc = t.acc('503');
    const r = await call('PUT', '/my-company', { ...base, bankAccounts: [
      { account: 'BG80BNBG96611020345678', bankStatementAccountId: acc },
      { account: 'BG18RZBB91550123456789', bankStatementAccountId: acc },
    ] });
    expect(keys(r)).toContain('strErrorAccountWithMultipleBankAccounts');
  });
});

describe('currencies (03a 5.3)', () => {
  it('validates name, code length and uniqueness', async () => {
    expect(keys(await call('POST', '/currencies', { isoCode: 'EU', name: 'X' }))).toEqual(['strCurrencyCodeLengthError']);
    expect(keys(await call('POST', '/currencies', { isoCode: 'USD', name: '' }))).toEqual(['strCurrencyNameError', 'strCurrencyCodeUniquenessError']);
    // Only the exact string is compared: lower-case "usd" is a different code.
    const lower = await call('POST', '/currencies', { isoCode: 'usd', name: 'Долар (малки)', exchangeRate: '1.6' });
    expect(lower.status, lower.text).toBe(201);
    expect(lower.body.fixedRate).toBe('1.600000');
  });

  it('refuses to delete a currency used by an account or a posting line and the base currencies', async () => {
    const list = (await call('GET', '/currencies')).body as { id: number; isoCode: string }[];
    const gbp = list.find((c) => c.isoCode === 'GBP')!;
    await call('POST', '/accounts', { parentId: t.acc('503'), description: 'Сметка в GBP', currencyId: gbp.id });
    const r = await call('DELETE', `/currencies/${gbp.id}`);
    expect([r.status, r.body.error]).toEqual([400, 'Валутата не може да бъде изтрита, защото се използва за аналитичност на една или повече сметки.']);
    expect((await call('DELETE', `/currencies/${list.find((c) => c.isoCode === 'EUR')!.id}`)).status).toBe(400);
    expect((await call('DELETE', `/currencies/${list.find((c) => c.isoCode === 'CHF')!.id}`)).status).toBe(200);
  });
});

describe('countries (03a 6)', () => {
  it('requires name and a 1-3 character code, warns on a missing foreign name, allows duplicates', async () => {
    expect(keys(await call('POST', '/countries', { code: 'ABCD', name: 'X', nameInOtherLang: 'X' }))).toEqual(['strCodeIncorectFormat']);
    expect(keys(await call('POST', '/countries', { code: '', name: '', nameInOtherLang: '' }))).toEqual(['strCountriesNameIsNotAdded', 'strCountriesCodeIsNotAdded', 'strCountriesNameInOtherLangIsNotAdded']);
    const ok = await call('POST', '/countries', { code: 'BG', name: 'България 2', nameInOtherLang: '' });
    expect(ok.status).toBe(201);
    expect(keys(ok)).toEqual(['strCountriesNameInOtherLangIsNotAdded']);
  });

  it('a country used in an address cannot be deleted', async () => {
    const bg = (await call('GET', '/countries')).body.find((c: { code: string; name: string }) => c.code === 'BG' && c.name === 'България');
    await call('POST', '/partners', { name: 'Адресиран ООД', accountIds: [t.acc('411')], addresses: [{ city: 'София', countryId: bg.id }] });
    const r = await call('DELETE', `/countries/${bg.id}`);
    expect([r.status, r.body.error]).toEqual([400, 'Държавата не може да бъде изтрита, тъй като е избрана към партньор/и.']);
  });
});

describe('terms and references (03a 8.1)', () => {
  it('renaming onto an existing description merges, deletion unlinks, sale/purchase use blocks deletion', async () => {
    await t.post({ date: '2026-02-01', term: 'Основание А', dr: [['501', '10']], cr: [['101', '10']] });
    await t.post({ date: '2026-02-02', term: 'Основание Б', dr: [['501', '10']], cr: [['101', '10']] });
    const terms = (await call('GET', '/dictionary/terms?all=1')).body as { id: number; description: string }[];
    const a = terms.find((x) => x.description === 'Основание А')!;
    const b = terms.find((x) => x.description === 'Основание Б')!;
    const merged = await call('PUT', `/dictionary/terms/${b.id}`, { description: 'Основание А' });
    expect(merged.body).toMatchObject({ id: a.id, merged: true });
    const entries = (await call('GET', '/entries?text=Основание')).body.rows.map((r: { term: string }) => r.term);
    expect(entries).toEqual(['Основание А', 'Основание А']);
    // Adding an existing description returns the existing row.
    expect((await call('POST', '/dictionary/terms', { description: 'Основание А' })).body.id).toBe(a.id);

    expect((await call('DELETE', `/dictionary/terms/${a.id}`)).status).toBe(200);
    expect((await call('GET', '/entries?text=Основание')).body.total).toBe(0);

    await t.post({ date: '2026-02-03', term: 'Продажба на стоки', transactionTypeId: 3, dr: [['501', '10']], cr: [['702', '10']] });
    const sale = ((await call('GET', '/dictionary/terms?all=1')).body as { id: number; description: string }[]).find((x) => x.description === 'Продажба на стоки')!;
    const blocked = await call('DELETE', `/dictionary/terms/${sale.id}`);
    expect([blocked.status, blocked.body.error]).toEqual([400, 'Избраните основания не могат да бъдат изтрити, защото участват в операции от тип Покупка/Продажба.']);
  });
});
