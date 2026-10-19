import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';
import { insertPaymentLinks } from '../src/services/openItems.ts';

/** Partner and cash reports (spec 05 6, 05 7 received/issued). */

let t: TestCompany;
let sup1: number, sup2: number, cli: number, late: number;
let inv1: { id: number }, pay1: { id: number };

beforeAll(async () => {
  t = await createTestCompany();
  const db = await t.driver.company(t.companyDb);
  sup1 = await t.partner('Доставчик Едно ООД', ['401'], { bulstat: '121212121', addresses: [{ address: 'ул. Първа 1', city: 'София', phone: '02 111' }], bankAccounts: [{ account: 'BG80BNBG96611020345678' }], contactName: 'Иван Иванов' });
  sup2 = await t.partner('Доставчик Две ООД', ['401']);
  cli = await t.partner('Клиент Три ЕООД', ['411']);
  late = await t.partner('Закъсняващ Клиент АД', ['411'], { dueDays: 5 });

  // 6.12: invoice 1000 on a payable account, allocation 400 of a cash payment.
  inv1 = await t.post({ date: '2026-02-01', docNumber: 'F-1000', partner: sup1, dueDate: '2026-03-01', dr: [['602', 1000]], cr: [['401', 1000]] });
  pay1 = await t.post({ date: '2026-02-10', docType: 9, docNumber: '1', partner: sup1, term: 'Плащане F-1000', dr: [['401', 400]], cr: [['501', 400]] });
  // Fully paid invoice of the second supplier.
  const inv2 = await t.post({ date: '2026-02-02', docNumber: 'F-2000', partner: sup2, dr: [['602', 1000]], cr: [['401', 1000]] });
  const pay2 = await t.post({ date: '2026-02-05', docType: 10, docNumber: 'MO-1', partner: sup2, dr: [['401', 1000]], cr: [['503', 1000]] });
  // A sale with VAT and a sale with a partner due-days term only.
  await t.post({ date: '2026-02-03', docNumber: 'S-1', partner: cli, transactionTypeId: 3, dr: [['411', 120]], cr: [['702', 100], ['453/2', 20]] });
  await t.post({ date: '2026-04-01', docNumber: 'S-2', partner: late, dr: [['411', 50]], cr: [['702', 50]] });
  await insertPaymentLinks(db, [
    { paymentAccountingId: pay1.id, refAccountingId: inv1.id, documentId: null, accountId: t.acc('401'), companyId: sup1, amount: '400' },
    { paymentAccountingId: pay2.id, refAccountingId: inv2.id, documentId: null, accountId: t.acc('401'), companyId: sup2, amount: '1000' },
  ]);
}, 60_000);
afterAll(() => t.close());

const get = async (url: string) => {
  const r = await t.call('GET', url);
  expect(r.status, r.text).toBe(200);
  return r.body;
};

describe('Задължения/вземания по партньори (05 6.2-6.4)', () => {
  it('document level: invoice 1000 with allocation 400 is open 600; a fully allocated pair is hidden unless closed are shown', async () => {
    const r = await get(`/reports/partner-debts?level=document&to=2026-12-31&companyId=${sup1},${sup2}`);
    expect(r.startDate).toBe('2026-01-01');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ accountingId: inv1.id, documentNumber: 'F-1000', amount: '-600.00', sumAmount: '-1000.00', companyBankAccount: 'BG80BNBG96611020345678', dueDate: '2026-03-01' });
    const closed = await get(`/reports/partner-debts?level=document&to=2026-12-31&companyId=${sup2}&closed=1`);
    expect(closed.rows.map((x: any) => [x.documentNumber, x.amount]).sort()).toEqual([['F-2000', '0.00'], ['MO-1', '0.00']]);
  });

  it('partner level nets the window and hides zero partners unless closed are shown', async () => {
    const r = await get('/reports/partner-debts?level=partner&to=2026-12-31');
    const by = new Map(r.rows.map((x: any) => [x.companyId, x.amount]));
    expect(by.get(sup1)).toBe('-600.00');
    expect(by.get(cli)).toBe('120.00');
    expect(by.has(sup2)).toBe(false);
    const closed = await get('/reports/partner-debts?level=partner&to=2026-12-31&closed=1');
    expect(closed.rows.find((x: any) => x.companyId === sup2)?.amount).toBe('0.00');
    // A window ending before the payment shows the whole invoice.
    const early = await get(`/reports/partner-debts?level=partner&to=2026-02-05&companyId=${sup1}`);
    expect(early.rows[0].amount).toBe('-1000.00');
  });

  it("accounting level lists the covering accountings with the document's own sign", async () => {
    const r = await get(`/reports/partner-debts?level=accounting&to=2026-12-31&companyId=${sup1}`);
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row).toMatchObject({ originalAmount: '1000.00', remainingAmount: '600.00', companyAmount: '-600.00' });
    expect(row.lines).toEqual([expect.objectContaining({ accountingId: pay1.id, debitAccountNumber: '401', creditAccountNumber: '501', coveredAmount: '400.00', documentNumber: '1' })]);
  });

  it('show expired keeps documents due before the end date; the column filter narrows rows', async () => {
    const before = await get(`/reports/partner-debts?level=document&to=2026-03-01&expired=1&companyId=${sup1}`);
    expect(before.rows).toHaveLength(0);
    const after = await get(`/reports/partner-debts?level=document&to=2026-03-02&expired=1&companyId=${sup1}`);
    expect(after.rows).toHaveLength(1);
    const f = await get('/reports/partner-debts?level=document&to=2026-12-31&filterColumn=documentNumber&filterText=s-1');
    expect(f.rows.map((x: any) => x.documentNumber)).toEqual(['S-1']);
  });
});

describe('Получени и издадени документи (05 7)', () => {
  it('classifies purchases and sales and splits the VAT', async () => {
    const rows = await get('/reports/received-issued?from=2026-02-01&to=2026-02-28');
    const s1 = rows.find((x: any) => x.docNumber === 'S-1');
    expect(s1).toMatchObject({ deal: 'Продажба', amount: '120.00', vatAmount: '20.00', taxBase: '100.00', company: 'Клиент Три ЕООД' });
    const f1 = rows.find((x: any) => x.docNumber === 'F-1000');
    expect(f1).toMatchObject({ deal: 'Покупка', amount: '1000.00', vatAmount: '0.00', company: 'Доставчик Едно ООД' });
    // Payments are neither purchases nor sales.
    expect(rows.some((x: any) => x.docNumber === 'MO-1')).toBe(false);
    const onlyCli = await get(`/reports/received-issued?from=2026-02-01&to=2026-02-28&companyId=${cli}`);
    expect(onlyCli.map((x: any) => x.docNumber)).toEqual(['S-1']);
  });
});

describe('Движение по партньор (05 6.6)', () => {
  it('requires a partner and a partner account', async () => {
    const a = await t.call('GET', '/reports/partner-movement?account=401');
    expect(a.status).toBe(400);
    expect(a.body.error).toBe('Не е въведено име на фирма в поле Партньор!');
    const b = await t.call('GET', `/reports/partner-movement?account=602&companyId=${sup1}`);
    expect(b.status).toBe(400);
    expect(b.body.error).toBe('Не е избрана сметка, която поддържа работа с партньори!');
  });

  it('opening, document rows, turnover and closing; direction filter', async () => {
    const r = await get(`/reports/partner-movement?account=401&companyId=${sup1}&from=2026-02-05&to=2026-12-31`);
    expect(r.opening).toMatchObject({ debit: '0.00', credit: '1000.00' });
    expect(r.rows.map((x: any) => [x.documentNumber, x.debitAmount, x.creditAmount])).toEqual([['1', '400.00', '0.00']]);
    expect(r.turnover).toMatchObject({ debit: '400.00', credit: '0.00' });
    expect(r.closing).toMatchObject({ debit: '0.00', credit: '600.00' });
    const year = await get(`/reports/partner-movement?account=401&companyId=${sup1}&from=2026-01-01&to=2026-12-31`);
    expect(year.rows.map((x: any) => x.documentNumber)).toEqual(['F-1000', '1']);
    const increases = await get(`/reports/partner-movement?account=401&companyId=${sup1}&from=2026-01-01&to=2026-12-31&direction=1`);
    expect(increases.rows.map((x: any) => x.documentNumber)).toEqual(['F-1000']);
    const settlements = await get(`/reports/partner-movement?account=4&companyId=${sup1}&from=2026-01-01&to=2026-12-31&direction=2`);
    expect(settlements.rows.map((x: any) => x.documentNumber)).toEqual(['1']);
  });
});

describe('Разплащания и обвързани документи', () => {
  it('one row per allocation with the booked amount of the linked document', async () => {
    const rows = await get(`/reports/payments?from=2026-01-01&to=2026-12-31&companyId=${sup1}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partnerName: 'Доставчик Едно ООД', refAccountingDocumentNumber: 'F-1000', refAccountingAmount: '1000.00',
      paymentAccountingDocumentNumber: '1', paymentAmount: '400.00', paymentAccountingTerm: 'Плащане F-1000',
    });
    expect(await get('/reports/payments?from=2026-01-01&to=2026-12-31&fromAmount=500')).toHaveLength(1);
    expect(await get('/reports/payments?from=2026-01-01&to=2026-12-31&term=F-1000')).toHaveLength(1);
  });
});

describe('Потвърдително писмо (05 6.5)', () => {
  it('signed open items per partner above the minimum sum', async () => {
    const all = await get('/reports/confirmation-letter?to=2026-12-31&minSum=100');
    const names = all.letters.map((l: any) => l.company.name);
    expect(names).toEqual(expect.arrayContaining(['Доставчик Едно ООД', 'Клиент Три ЕООД']));
    expect(names).not.toContain('Закъсняващ Клиент АД'); // 50 < 100
    const s1 = all.letters.find((l: any) => l.company.name === 'Доставчик Едно ООД');
    expect(s1).toMatchObject({ total: '-600.00' });
    expect(s1.company).toMatchObject({ address: 'ул. Първа 1', city: 'София', mol: 'Иван Иванов' });
    expect(all.myCompany.name).toBe('Тест ООД');
    const big = await get('/reports/confirmation-letter?to=2026-12-31&minSum=700');
    expect(big.letters).toHaveLength(0);
    const byName = await get('/reports/confirmation-letter?to=2026-12-31&companyName=Клиент Три');
    expect(byName.letters.map((l: any) => [l.company.name, l.total])).toEqual([['Клиент Три ЕООД', '120.00']]);
  });
});

describe('Просрочени задължения (05 6.7, corrected D2)', () => {
  it('compares the due date with the end date and prints the day count', async () => {
    const onDue = await get(`/reports/overdues?to=2026-03-01&companyId=${sup1}`);
    expect(onDue.letters).toHaveLength(0);
    const later = await get(`/reports/overdues?to=2026-03-11&companyId=${sup1}`);
    expect(later.letters[0].items[0]).toMatchObject({ documentNumber: 'F-1000', amount: '600.00', dueDate: '2026-03-01', overdueDays: 10, overdueDaysText: '10 дни' });
    // Document date + partner due days (5) without an own due date.
    const one = await get(`/reports/overdues?to=2026-04-07&companyId=${late}`);
    expect(one.letters[0].items[0]).toMatchObject({ dueDate: '2026-04-06', overdueDaysText: '1 ден' });
    expect((await get(`/reports/overdues?to=2026-04-06&companyId=${late}`)).letters).toHaveLength(0);
  });
});

describe('cash reports', () => {
  let c: TestCompany;
  let client: number;
  beforeAll(async () => {
    c = await createTestCompany({ companyName: 'Каса ООД' });
    client = await c.partner('Касов Клиент ООД', ['411']);
    const supplier = await c.partner('Касов Доставчик ООД', ['401']);
    await c.post({ date: '2026-01-05', docType: 8, docNumber: '1', dr: [['501', 1000]], cr: [['101', 1000]] });
    await c.post({ date: '2026-02-10', docType: 9, docNumber: '1', partner: supplier, term: 'Плащане', dr: [['401', 400]], cr: [['501', 400]] });
    await c.post({ date: '2026-02-12', docType: 8, docNumber: '5', partner: client, term: 'Получено плащане', dr: [['501', 120]], cr: [['411', 120]] });
    await c.post({ date: '2026-02-20', docType: 8, docNumber: '7', partner: client, dr: [['501', 30]], cr: [['411', 30]] });
    await c.post({ date: '2026-02-21', docType: 9, docNumber: '2', dr: [['422', 50]], cr: [['501', 50]] });
    // Foreign-currency cash sub-account.
    const r = await c.call('POST', '/accounts', { number: '502/1', parentId: c.acc('502'), description: 'Каса в USD', accountCategoryId: 26, currencyId: 3 });
    expect(r.status, r.text).toBe(201);
    await c.reloadAccounts();
    await c.post({ date: '2026-02-15', docType: 8, docNumber: '6', dr: [['502/1', 90, { currencyAmount: '100' }]], cr: [['503', 90]] });
  }, 60_000);
  afterAll(() => c.close());
  const cget = async (url: string) => {
    const r = await c.call('GET', url);
    expect(r.status, r.text).toBe(200);
    return r.body;
  };

  it('cash book: opening, income/expense with counter accounts, running balance, closing; partner filter', async () => {
    const r = await cget('/reports/cash-book?account=501&from=2026-02-01&to=2026-02-28');
    expect(r.balances).toMatchObject({ openingDebit: '1000.00', debitTurnover: '150.00', creditTurnover: '450.00', closingDebit: '700.00' });
    expect(r.rows.map((x: any) => [x.documentDate, x.documentNumber, x.incomeAmount, x.incomeAccount, x.expenseAmount, x.expenseAccount, x.balance])).toEqual([
      ['2026-02-10', '1', '0.00', '', '400.00', '401', '600.00'],
      ['2026-02-12', '5', '120.00', '411', '0.00', '', '720.00'],
      ['2026-02-20', '7', '30.00', '411', '0.00', '', '750.00'],
      ['2026-02-21', '2', '0.00', '', '50.00', '422', '700.00'],
    ]);
    expect(r.rows[0].companyName).toBe('Касов Доставчик ООД');
    expect(r.totals).toMatchObject({ income: '150.00', expense: '450.00' });
    const onlyClient = await cget('/reports/cash-book?account=501&from=2026-02-01&to=2026-02-28&companyName=Касов Клиент');
    expect(onlyClient.rows.map((x: any) => x.documentNumber)).toEqual(['5', '7']);
    expect(onlyClient.balances).toMatchObject({ openingDebit: '0.00', debitTurnover: '150.00' });
  });

  it('cash book currency columns of a foreign cash account, with sub-accounts', async () => {
    const flat = await cget('/reports/cash-book?account=502&from=2026-02-01&to=2026-02-28');
    expect(flat.rows).toHaveLength(0);
    const r = await cget('/reports/cash-book?account=502&sub=1&from=2026-02-01&to=2026-02-28');
    expect(r.rows[0]).toMatchObject({ incomeAmount: '90.00', incomeCurrencyAmount: '100.00', incomeAccount: '503', currencyBalance: '100.00' });
    expect(Number(r.rows[0].incomeExchangeRate)).toBeCloseTo(0.9);
    expect(r.balances).toMatchObject({ closingDebitCurrency: '100.00' });
  });

  it('cash orders: type, number bounds, two per row, amount in words and posting lines', async () => {
    const pko = await cget('/reports/cash-order?documentTypeId=8&account=501&from=2026-02-01&to=2026-02-28');
    expect(pko.orders.map((o: any) => o.documentNumber)).toEqual(['5', '7']);
    expect(pko.rows).toHaveLength(1);
    expect(pko.rows[0].first.documentNumber).toBe('5');
    expect(pko.rows[0].second.documentNumber).toBe('7');
    expect(pko.orders[0]).toMatchObject({ amount: '120.00', amountText: 'Сто и двадесет евро', companyName: 'Касов Клиент ООД', term: 'Получено плащане' });
    expect(pko.orders[0].lines).toEqual([expect.objectContaining({ debitAccount: '501', creditAccount: '411', amount: '120.00' })]);
    expect(pko.myCompanyName).toBe('Каса ООД');
    const bounded = await cget('/reports/cash-order?documentTypeId=8&account=501&from=2026-01-01&to=2026-02-28&fromNumber=2&toNumber=6');
    expect(bounded.orders.map((o: any) => o.documentNumber)).toEqual(['5']);
    const rko = await cget('/reports/cash-order?documentTypeId=9&account=501&from=2026-02-01&to=2026-02-28');
    expect(rko.title).toBe('Разходен касов ордер');
    expect(rko.orders.map((o: any) => [o.documentNumber, o.amount])).toEqual([['1', '400.00'], ['2', '50.00']]);
    expect(rko.rows[0].second).toMatchObject({ documentNumber: '2', amountText: 'Петдесет евро' });
  });

  it('cash and receivables: formulas cr1..cr3 and the detailed sections', async () => {
    const r = await cget('/reports/cash-and-receivables?from=2026-01-01&to=2026-12-31&level=1');
    // cr1 = 501 (700) + 502 (90); cr2 = 493 (0); cr3 = 422 (50).
    expect(r).toMatchObject({ availableCash: '790.00', ownersReceivables: '0.00', workersReceivables: '50.00', totalAmount: '840.00' });
    const cash = r.sections.find((x: any) => x.key === 'availableCash');
    expect(cash.rows.map((x: any) => [x.accountNumber, x.finalDebitBalance])).toEqual(expect.arrayContaining([['501', '700.00'], ['502/1', '90.00']]));
    expect(r.sections.find((x: any) => x.key === 'workersReceivables').rows).toEqual([expect.objectContaining({ accountNumber: '422', debitBalance: '50.00' })]);
  });
});

describe('euro changeover (6.12, 6.9)', () => {
  let m: TestCompany;
  let sup: number;
  beforeAll(async () => {
    m = await createTestCompany({ year: 2025, companyName: 'Преход ООД' });
    expect((await m.call('POST', '/years', { year: 2026 })).status).toBe(201);
    const bgn401 = m.acc('401');
    await m.post({ date: '2025-12-10', docNumber: 'BGN-1', dr: [['602', '1955.83']], cr: [['401', '1955.83']], partner: (sup = await m.partner('Преходен Доставчик ООД', ['401'])) });
    await m.post({ date: '2025-12-15', docType: 8, docNumber: '3', dr: [['501', '195.58']], cr: [['101', '195.58']] });
    expect((await m.call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
    await m.reloadAccounts();
    const eur401 = m.acc('401');
    expect(eur401).not.toBe(bgn401);
    const p = await m.call('GET', `/partners/${sup}`);
    const r = await m.call('PUT', `/partners/${sup}`, { ...p.body, accountIds: [bgn401, eur401] });
    expect(r.status, r.text).toBe(200);
    await m.post({ date: '2026-01-10', docNumber: 'EUR-1', partner: sup, dr: [['602', 100]], cr: [['401', 100]] });
  }, 90_000);
  afterAll(() => m.close());
  const mget = async (url: string) => {
    const r = await m.call('GET', url);
    expect(r.status, r.text).toBe(200);
    return r.body;
  };

  it('document-level open items use the EUR chart only for a pure 2026 period, unconverted otherwise', async () => {
    const pure = await mget('/reports/partner-debts?level=document&from=2026-01-01&to=2026-01-31');
    expect(pure.rows.map((x: any) => [x.documentNumber, x.amount])).toEqual([['EUR-1', '-100.00']]);
    const mixed = await mget('/reports/partner-debts?level=document&from=2025-12-01&to=2026-01-31');
    expect(mixed.rows.map((x: any) => [x.documentNumber, x.amount])).toEqual([['BGN-1', '-1955.83']]);
  });

  it('cash order of a mixed period is converted and spelled in euro; a pure 2025 order in leva', async () => {
    const mixed = await mget('/reports/cash-order?documentTypeId=8&account=501&from=2025-12-01&to=2026-01-31');
    expect(mixed.orders[0]).toMatchObject({ documentNumber: '3', amount: '100.00', amountText: 'Сто евро' });
    const old = await mget('/reports/cash-order?documentTypeId=8&account=501&from=2025-12-01&to=2025-12-31');
    expect(old.orders[0]).toMatchObject({ amount: '195.58', amountText: 'Сто деветдесет и пет лв. и 58 ст.' });
  });
});

describe('Справка партньори (spCompaniesReport, 05 7.7)', () => {
  it('lists partners by name with the first address, accounts and IBANs; group subtree, account and column filters', async () => {
    const top = await t.call('POST', '/partner-groups', { name: 'Доставчици', parentId: 1 });
    expect(top.status, top.text).toBe(201);
    const sub = await t.call('POST', '/partner-groups', { name: 'Местни', parentId: top.body.id });
    expect(sub.status, sub.text).toBe(201);
    const local = await t.partner('Местен Доставчик ЕООД', ['401', '411'], {
      groupId: sub.body.id, bulstat: '204060801', vatNumber: 'BG204060801', email: 'office@mestni.bg',
      addresses: [{ address: 'ул. Втора 2', city: 'Пловдив', postalCode: '4000', phone: '032 222' }, { address: 'ул. Трета 3', city: 'Варна' }],
      bankAccounts: [{ account: 'BG11UNCR70001512345678' }, { account: 'BG22STSA93000012345678' }],
    });

    const all = await get('/reports/companies');
    const names = all.map((r: { companyName: string }) => r.companyName);
    expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b, 'bg')));
    expect(all.find((r: { companyId: number }) => r.companyId === sup1)).toMatchObject({ contactName: 'Иван Иванов', city: 'София', address: 'ул. Първа 1', phone: '02 111', ibans: 'BG80BNBG96611020345678', accountNumbers: '401' });
    const row = all.find((r: { companyId: number }) => r.companyId === local);
    expect(row).toMatchObject({ city: 'Пловдив', postalCode: '4000', accountNumbers: '401; 411', ibans: 'BG11UNCR70001512345678; BG22STSA93000012345678', email: 'office@mestni.bg' });
    expect(row.lastModifiedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The group filter takes the whole subtree.
    expect((await get(`/reports/companies?groupId=${top.body.id}`)).map((r: { companyId: number }) => r.companyId)).toEqual([local]);
    expect((await get(`/reports/companies?groupId=${sub.body.id}`)).map((r: { companyId: number }) => r.companyId)).toEqual([local]);
    // Account: substring of the joined list.
    const with411 = (await get('/reports/companies?account=411')).map((r: { companyId: number }) => r.companyId);
    expect(with411).toEqual(expect.arrayContaining([cli, late, local]));
    expect(with411).not.toContain(sup1);
    expect((await get('/reports/companies?filterColumn=City&filterText=пловдив')).map((r: { companyId: number }) => r.companyId)).toEqual([local]);
    expect((await get('/reports/companies?filterColumn=BulstatAndVATNumber&filterText=BG2040')).map((r: { companyId: number }) => r.companyId)).toEqual([local]);
    expect((await get('/reports/companies?filterText=121212121')).map((r: { companyId: number }) => r.companyId)).toEqual([sup1]);
    expect((await t.call('GET', '/reports/companies?filterColumn=Nope&filterText=x')).status).toBe(400);
  });
});
