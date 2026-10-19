import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';

/** Stock (СМЗ): products and material accounts, average price, write-offs, material reports (spec 03a 1/4, 05 7.9). */

let t: TestCompany;
let call: TestCompany['call'];
let acc: TestCompany['acc'];
const keys = (r: { body: { messages?: { key: string }[] } }) => (r.body.messages ?? []).map((m) => m.key);
const ids: Record<string, number> = {};
let supplier = 0;
let client = 0;

beforeAll(async () => {
  t = await createTestCompany();
  call = t.call;
  acc = t.acc;
  // The commercial template attaches no category to 302/304/702 (01a 6.3): the user assigns them.
  for (const [n, cat] of [['302', 1], ['304', 3], ['702', 24]] as const) {
    const r = await call('PUT', `/accounts/${acc(n)}`, { accountCategoryId: cat });
    expect(r.status, r.text).toBe(200);
  }
  supplier = await t.partner('Доставчик ООД', ['401']);
  client = await t.partner('Клиент ЕООД', ['411']);
}, 60_000);
afterAll(() => t.close());

const m = (quantity: number | string, price: number | string) => ({ quantity: String(quantity), price: String(price) });

describe('products (Дефиниране на СМЗ, 03a 4)', () => {
  it('validates name, measure and accounts with the Delta messages', async () => {
    const empty = await call('POST', '/products', { name: ' ', measure: '', incrementAccountIds: [], decrementAccountIds: [] });
    expect(empty.status).toBe(422);
    expect(keys(empty)).toEqual(['strProductNameError', 'strProductMeasureError', 'strNoIncrementAccountsAttached']);
    expect(empty.body.messages[0].text).toBe('Не е въведено име на стока, материал или продукция!');
    const wrong = await call('POST', '/products', { name: 'X', measure: 'бр.', incrementAccountIds: [acc('411')], decrementAccountIds: [] });
    expect(keys(wrong)).toContain('strAccountDoesNotSupportProducts');
    const wrongSide = await call('POST', '/products', { name: 'X', measure: 'бр.', incrementAccountIds: [acc('304')], decrementAccountIds: [acc('304')] });
    expect(keys(wrongSide)).toContain('strAccountDoesNotSupportProducts');
  });

  it('creates product sub-accounts for the delivery and sale accounts', async () => {
    const a = await call('POST', '/products', { name: 'Стока А', code: 'A1', measure: 'бр.', price: '30', incrementAccountIds: [acc('304')], decrementAccountIds: [acc('702')] });
    expect(a.status, a.text).toBe(201);
    expect(a.body.incrementAccounts.map((x: { number: string }) => x.number)).toEqual(['304/1']);
    expect(a.body.decrementAccounts.map((x: { number: string }) => x.number)).toEqual(['702/1']);
    ids.A = a.body.id;
    // No uniqueness on the name (03a 4.3).
    const b = await call('POST', '/products', { name: 'Стока А', measure: 'кг', incrementAccountIds: [acc('304')], decrementAccountIds: [acc('702')] });
    expect(b.status, b.text).toBe(201);
    ids.B = b.body.id;
    const c = await call('POST', '/products', { name: 'Стока В', measure: 'бр.', incrementAccountIds: [acc('304')], decrementAccountIds: [] });
    ids.C = c.body.id;
    const d = await call('POST', '/products', { name: 'Стока Г', measure: 'бр.', incrementAccountIds: [acc('304')], decrementAccountIds: [] });
    ids.D = d.body.id;
    await t.reloadAccounts();
    const accounts = (await call('GET', '/accounts')).body as { number: string; description: string; isMaterial: boolean; productId: number; categoryId: number; isLeaf: boolean; productAccountType: number }[];
    const a1 = accounts.find((x) => x.number === '304/1')!;
    expect(a1).toMatchObject({ description: 'Стока А', isMaterial: true, productId: ids.A, categoryId: 3, isLeaf: true, productAccountType: 0 });
    expect(accounts.find((x) => x.number === '702/1')).toMatchObject({ productId: ids.A, categoryId: 24, productAccountType: 1 });
    expect(accounts.find((x) => x.number === '304')!.isLeaf).toBe(false);
  });

  it('renames the product accounts and drops a removed account', async () => {
    const r = await call('PUT', `/products/${ids.B}`, { name: 'Стока Б', measure: 'кг', incrementAccountIds: [acc('304')], decrementAccountIds: [] });
    expect(r.status, r.text).toBe(200);
    expect(r.body.decrementAccounts).toEqual([]);
    await t.reloadAccounts();
    const accounts = (await call('GET', '/accounts')).body as { number: string; description: string }[];
    expect(accounts.find((x) => x.number === '304/2')!.description).toBe('Стока Б');
    expect(accounts.find((x) => x.number === '702/2')).toBeUndefined();
    const list = (await call('GET', '/products')).body as { name: string }[];
    expect(list.map((p) => p.name)).toEqual(['Стока А', 'Стока Б', 'Стока В', 'Стока Г']);
    const measures = (await call('GET', '/products/measures')).body as string[];
    expect(measures.slice(0, 2)).toEqual(['бр.', 'кг.']);
    expect(measures).toContain('кг');
    const sale = (await call('GET', '/stock/products?mode=sale')).body as { id: number; accounts: { number: string }[] }[];
    expect(sale.map((p) => p.id)).toEqual([ids.A]);
    expect(sale[0]!.accounts[0]!.number).toBe('702/1');
  });
});

describe('material postings, weighted average and write-offs (03a 4.5)', () => {
  it('posts an opening balance, a delivery and a sale with quantities', async () => {
    const ib = await call('POST', '/entries', {
      accountingDate: '2026-01-01', documentTypeId: null, term: '', isInitialBalance: true,
      debits: [{ accountId: acc('304/1'), amount: '20', ...m(2, 10) }], credits: [{ accountId: acc('101'), amount: '20' }],
    });
    expect(ib.status, ib.text).toBe(201);
    await t.post({ date: '2026-02-01', docNumber: '1001', term: 'Доставка на стоки', partner: supplier,
      dr: [['304/1', 100, m(10, 10)], ['304/2', 50, m(5, 10)]], cr: [['401', 150, { companyId: supplier }]] });
    await t.post({ date: '2026-02-03', docNumber: '1002', term: 'Доставка', partner: supplier,
      dr: [['304/4', 1, m(1, 1)]], cr: [['401', 1, { companyId: supplier }]] });
    await t.post({ date: '2026-02-10', docNumber: '2001', term: 'Продажба на стоки', partner: client,
      dr: [['411', 120, { companyId: client }]], cr: [['702/1', 120, m(4, 30)]] });
    // Issues straight from stock: product Б 6 units for 60.00, product Г back to zero.
    await t.post({ date: '2026-02-15', docType: 10, docNumber: '', term: 'Изписване', dr: [['601', 61]], cr: [['304/2', 60, m(6, 10)], ['304/4', 1, m(1, 1)]] });
  });

  it('weighted average price matches the spec worked examples', async () => {
    const a = (await call('GET', `/stock/average-price?productId=${ids.A}&date=2026-02-28`)).body;
    expect(a).toMatchObject({ productId: ids.A, accountId: acc('304/1'), price: '10', quantity: '12' });
    // In 5 for 50, out 6 for 60: amount -10, qty -1 -> quotient 10 negated = -10.
    const b = (await call('GET', `/stock/average-price?productId=${ids.B}&date=2026-02-28`)).body;
    expect(b.price).toBe('-10');
    const early = (await call('GET', `/stock/average-price?productId=${ids.A}&date=2026-01-15`)).body;
    expect(early.price).toBe('10');
  });

  it('lists the sold quantity for write-off and writes it off once', async () => {
    const q = (await call('GET', '/stock/write-offs?from=2026-02-01&to=2026-02-28&account=702&date=2026-02-28')).body as Record<string, string | number>[];
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ productId: ids.A, decrementAccount: '702/1', stockAccount: '304/1', quantity: '4', averagePrice: '10', deliveryAmount: '40.00', saleAmount: '120.00' });
    const r = await call('POST', '/stock/write-offs', { from: '2026-02-01', to: '2026-02-28', account: '702', date: '2026-02-28' });
    expect(r.status, r.text).toBe(201);
    expect(r.body.created).toHaveLength(1);
    const entry = (await call('GET', `/entries/${r.body.created[0].id}`)).body;
    expect(entry.term).toBe('Изписване на стоки по отчетна стойност');
    expect(entry.documentTypeId).toBe(10);
    expect(entry.debits[0]).toMatchObject({ accountId: acc('702/1'), amount: '40.00' });
    expect(Number(entry.debits[0].quantity)).toBe(4);
    expect(entry.credits[0]).toMatchObject({ accountId: acc('304/1'), amount: '40.00' });
    // Nothing left to write off; the average stays 10 ((20+100-40)/(2+10-4)).
    expect((await call('GET', '/stock/write-offs?from=2026-02-01&to=2026-02-28&date=2026-02-28')).body).toEqual([]);
    const again = await call('POST', '/stock/write-offs', { from: '2026-02-01', to: '2026-02-28', date: '2026-02-28' });
    expect(again.status).toBe(400);
    expect((await call('GET', `/stock/average-price?productId=${ids.A}&date=2026-03-01`)).body).toMatchObject({ price: '10', quantity: '8', amount: '80.00' });
  });

  it('refuses a write-off in a locked month or outside the year', async () => {
    const years = (await call('GET', '/years')).body as { id: number }[];
    await call('PUT', `/years/${years[0]!.id}/locks`, { months: [3] });
    await t.post({ date: '2026-02-20', docNumber: '2002', term: 'Продажба', partner: client, dr: [['411', 30, { companyId: client }]], cr: [['702/1', 30, m(1, 30)]] });
    const locked = await call('POST', '/stock/write-offs', { from: '2026-02-01', to: '2026-02-28', date: '2026-03-10' });
    expect(locked.status).toBe(400);
    expect(locked.body.error).toBe('Операцията, която се опитвате да извършите, обхваща заключен месец/период!');
    await call('PUT', `/years/${years[0]!.id}/locks`, { months: [] });
    const other = await call('POST', '/stock/write-offs', { from: '2026-02-01', to: '2026-02-28', date: '2025-12-31' });
    expect(other.body.error).toBe('Датата на контирането е различна от текущата счетоводна година!');
    const ok = await call('POST', '/stock/write-offs', { from: '2026-02-01', to: '2026-02-28', date: '2026-02-28' });
    expect(ok.status, ok.text).toBe(201);
  });
});

describe('material reports (05 7.9)', () => {
  it('Доставки: receipts on stock accounts with partner and entry-number range', async () => {
    const all = (await call('GET', '/reports/stock/purchases?from=2026-01-01&to=2026-12-31')).body as Record<string, string>[];
    expect(all.map((r) => [r.account_number, Number(r.quantity), Number(r.amount)])).toEqual([['304/1', 10, 100], ['304/2', 5, 50], ['304/4', 1, 1]]);
    expect(all[0]!.company_name).toBe('Доставчик ООД');
    expect(all[0]!.document_type).toBe('Фактура');
    const exact = (await call('GET', `/reports/stock/purchases?product=${encodeURIComponent('стока а')}&nameExact=1`)).body as unknown[];
    expect(exact).toHaveLength(1);
    const sub = (await call('GET', `/reports/stock/purchases?product=${encodeURIComponent('Стока')}`)).body as unknown[];
    expect(sub).toHaveLength(3);
    const firstNo = Number(all[0]!.accounting_number);
    const ranged = (await call('GET', `/reports/stock/purchases?fromNumber=${firstNo + 1}&toNumber=${firstNo + 1}`)).body as Record<string, string>[];
    expect(ranged.map((r) => r.account_number)).toEqual(['304/4']);
  });

  it('Продажби: issues on sales accounts', async () => {
    const r = (await call('GET', '/reports/stock/sales?from=2026-01-01&to=2026-12-31&company=Клиент')).body as Record<string, string>[];
    expect(r.map((x) => [x.account_number, Number(x.quantity), Number(x.amount)])).toEqual([['702/1', 4, 120], ['702/1', 1, 30]]);
    expect(r[0]!.company_name).toBe('Клиент ЕООД');
  });

  it('Движение на стоки: receipts positive, issues negative', async () => {
    const r = (await call('GET', '/reports/stock/goods-movement?from=2026-02-01&to=2026-02-28&code=A1')).body as Record<string, string>[];
    expect(r.map((x) => [x.account_number, Number(x.quantity), Number(x.amount)])).toEqual([['304/1', 10, 100], ['702/1', -4, -120], ['702/1', -1, -30]]);
    const byDoc = (await call('GET', '/reports/stock/goods-movement?from=2026-02-01&to=2026-02-28&documentNumber=2001')).body as unknown[];
    expect(byDoc).toHaveLength(1);
  });

  it('Средно претеглена стойност и изписване', async () => {
    const r = (await call('GET', '/reports/stock/average-price?from=2026-02-01&to=2026-12-31&account=304')).body as Record<string, string>[];
    const a = r.find((x) => x.accountNumber === '304/1')!;
    expect(a).toMatchObject({ initialBalance: '20.00', materialInitialBalance: '2', debitTurnover: '100.00', materialDebitTurnover: '10', averagePrice: '10' });
    expect(a).toMatchObject({ creditTurnover: '50.00', materialCreditTurnover: '5', writeOutValue: '50.00', finalBalance: '70.00', materialFinalBalance: '7' });
    const b = r.find((x) => x.accountNumber === '304/2')!;
    expect(b).toMatchObject({ averagePrice: '10', finalBalance: '-10.00', materialFinalBalance: '-1' });
  });

  it('Стойност за изписване при продажба', async () => {
    const r = (await call('GET', '/reports/stock/write-out?from=2026-01-01&to=2026-12-31')).body as Record<string, string>[];
    const a = r.find((x) => x.accountNumber === '304/1')!;
    // Opening 2 for 20 (initial balance), booked 10 for 100, charged 5 -> avg 10, write-off 50.
    expect(a).toMatchObject({ initialBalance: '20.00', initialBalanceQtty: '2', bookedSum: '100.00', bookedQtty: '10', averagePrice: '10', chargedQtty: '5', writeOff: '50.00' });
  });

  it('Инвентаризационен опис with and without zero balances', async () => {
    const all = (await call('GET', '/reports/stock/inventory-list?date=2026-12-31&account=304')).body as Record<string, string | number>[];
    expect(all.map((x) => [x.accountNumber, x.materialFinalBalance, x.finalBalance])).toEqual([['304/1', '7', '70.00'], ['304/2', '-1', '-10.00'], ['304/4', '0', '0.00']]);
    expect(all[0]!.averagePrice).toBe('10');
    const nz = (await call('GET', '/reports/stock/inventory-list?date=2026-12-31&account=304&withoutZero=1')).body as Record<string, string | number>[];
    expect(nz.map((x) => [x.no, x.accountNumber])).toEqual([[1, '304/1'], [2, '304/2']]);
    const jan = (await call('GET', '/reports/stock/inventory-list?date=2026-01-31')).body as Record<string, string>[];
    expect(jan.map((x) => [x.accountNumber, x.materialFinalBalance])).toEqual([['304/1', '2']]);
  });
});

describe('product delete rules (03a 4.4)', () => {
  it('blocks a product used in postings and a removal of its used account', async () => {
    const del = await call('DELETE', `/products/${ids.A}`);
    expect(del.status).toBe(400);
    expect(del.body.error).toBe('Стоката не може да бъде изтрита, защото се използва в извършени операции.');
    const drop = await call('PUT', `/products/${ids.A}`, { name: 'Стока А', measure: 'бр.', incrementAccountIds: [], decrementAccountIds: [acc('702')] });
    expect(keys(drop)).toEqual(['strNoIncrementAccountsAttached']);
    const drop2 = await call('PUT', `/products/${ids.A}`, { name: 'Стока А', measure: 'бр.', incrementAccountIds: [acc('304')], decrementAccountIds: [] });
    expect(drop2.status).toBe(400);
    expect(drop2.body.error).toContain('Сметката не може да бъде изтрита, защото участва в операции.');
  });

  it('soft-deletes an unused product and removes its accounts', async () => {
    const del = await call('DELETE', `/products/${ids.C}`);
    expect(del.status, del.text).toBe(200);
    await t.reloadAccounts();
    expect(() => acc('304/3')).toThrow();
    expect(((await call('GET', '/products')).body as { id: number }[]).map((p) => p.id)).not.toContain(ids.C);
  });
});

describe('chart editor: material accounts, templates, copy (03a 1)', () => {
  it('creates a material account with its product and validates the editor rules', async () => {
    const parent = acc('302');
    const noMeasure = await call('POST', '/accounts', { parentId: parent, description: 'Брашно', accountType: 'material' });
    expect(keys(noMeasure)).toEqual(['strProductMeasureError']);
    const ok = await call('POST', '/accounts', { parentId: parent, description: 'Брашно', accountType: 'material', measure: 'кг.', productCode: 'BR' });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.number).toBe('302/1');
    expect(ok.body.productId).toBeTruthy();
    await t.reloadAccounts();
    const row = ((await call('GET', '/accounts')).body as { number: string; isMaterial: boolean; measure: string; productCode: string; productAccountType: number }[]).find((a) => a.number === '302/1')!;
    expect(row).toMatchObject({ isMaterial: true, measure: 'кг.', productCode: 'BR', productAccountType: 0 });
    expect(((await call('GET', '/products')).body as { name: string }[]).map((p) => p.name)).toContain('Брашно');

    const notProduct = await call('POST', '/accounts', { parentId: acc('411'), description: 'X', accountType: 'material', measure: 'бр.' });
    expect(keys(notProduct)).toEqual(['strNoMaterialAccount']);
    const cur = await call('POST', '/accounts', { parentId: acc('503'), description: 'X', accountType: 'currency', currencyId: 2 });
    expect(keys(cur)).toEqual(['strAccountCurrencyNotSelected']);
    const badNumber = await call('POST', '/accounts', { parentId: acc('503'), number: '504/1', description: 'X' });
    expect(keys(badNumber)).toEqual(['strInvalidAccountNumber']);
    const exists = await call('POST', '/accounts', { parentId: acc('453'), number: '453/1', description: 'X' });
    expect(keys(exists)).toEqual(['strAccountAlreadyExists']);
    const noDesc = await call('POST', '/accounts', { parentId: acc('503'), description: '' });
    expect(keys(noDesc)).toEqual(['strInvalidAccountDescription']);
    const cat = await call('POST', '/accounts', { parentId: acc('411'), description: 'X', accountCategoryId: 4 });
    expect(keys(cat)).toEqual(['strAccountCategoryDifferentFromParent']);
    const usd = await call('POST', '/accounts', { parentId: acc('503'), description: 'USD сметка', accountType: 'currency', currencyId: 3 });
    expect(usd.status, usd.text).toBe(201);
    expect(usd.body.currencyId).toBe(3);

    // Back to standard: the product loses its only account and is soft-deleted.
    const std = await call('PUT', `/accounts/${ok.body.id}`, { accountType: 'standard' });
    expect(std.status, std.text).toBe(200);
    expect(std.body.productId).toBeNull();
    expect(((await call('GET', '/products')).body as { name: string }[]).map((p) => p.name)).not.toContain('Брашно');
  });

  it('offers template accounts missing from the chart (F4)', async () => {
    expect(((await call('GET', '/accounts/templates?q=319')).body as unknown[])).toEqual([]);
    expect((await call('DELETE', `/accounts/${acc('319')}`)).status).toBe(200);
    const r = (await call('GET', '/accounts/templates?q=319')).body as { number: string; description: string; isActive: boolean }[];
    expect(r).toEqual([expect.objectContaining({ number: '319', description: 'Други краткотрайни биологични активи', isActive: true, parentNumber: '31' })]);
  });

  it('copies sub-account trees under a target with new numbers', async () => {
    const a = await call('POST', '/accounts', { parentId: acc('609'), description: 'Разходи А' });
    await call('POST', '/accounts', { parentId: a.body.id, description: 'Подразход' });
    await t.reloadAccounts();
    const r = await call('POST', '/accounts/copy', { ids: [a.body.id], targetId: acc('608') });
    expect(r.status, r.text).toBe(200);
    expect(r.body.copied).toBe(2);
    await t.reloadAccounts();
    const accounts = (await call('GET', '/accounts')).body as { number: string; description: string; parentId: number; categoryId: number }[];
    expect(accounts.find((x) => x.number === '608/1')).toMatchObject({ description: 'Разходи А', categoryId: 45 });
    expect(accounts.find((x) => x.number === '608/1/1')).toMatchObject({ description: 'Подразход' });
    const toMaterial = await call('POST', '/accounts/copy', { ids: [a.body.id], targetId: acc('304/1') });
    expect(toMaterial.body.error).toBe('Не е позволено създаването на подсметка на избраната сметка!');
    const intoSelf = await call('POST', '/accounts/copy', { ids: [a.body.id], targetId: acc('609/1/1') });
    expect(intoSelf.status).toBe(422);
  });
});
