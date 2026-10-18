import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';

let t: TestCompany;
beforeAll(async () => {
  t = await createTestCompany();
}, 60_000);
afterAll(() => t.close());

const openOf = async (companyId: number) => (await t.call('GET', `/payments/open-items?companyId=${companyId}`)).body as {
  liabilities: { accountingId: number; open: string; openAbs: string }[];
  payments: { accountingId: number; open: string; openAbs: string }[];
  balance: string;
};
const keys = (r: { body: { messages?: { key: string }[] } }) => (r.body.messages ?? []).map((m) => m.key);

describe('payments F3 (07 3.3)', () => {
  it('pays part of an invoice with a cash receipt numbered from its channel, then refuses more than is open', async () => {
    const cli = await t.partner('Плащащ клиент ООД', ['411']);
    const inv = await t.post({ date: '2026-02-01', docNumber: 'P-1', partner: cli, dr: [['411', 120]], cr: [['702', 120]] });
    const r = await t.call('POST', '/payments', {
      companyId: cli, accountId: t.acc('411'), paymentAccountId: t.acc('501'), date: '2026-02-05', term: 'Плащане',
      amount: '50', allocations: [{ accountingId: inv.id, amount: '50' }],
    });
    expect(r.status, r.text).toBe(201);
    const entry = (await t.call('GET', `/entries/${r.body.id}`)).body;
    // Client payment into cash: Dr 501 / Cr 411, a ПКО with the next number of channel 4.
    expect(entry.documentTypeId).toBe(8);
    expect(entry.documentNumber).toMatch(/^\d+$/);
    expect(entry.debits[0]).toMatchObject({ accountId: t.acc('501'), amount: '50.00' });
    expect(entry.credits[0]).toMatchObject({ accountId: t.acc('411'), companyId: cli });
    let open = await openOf(cli);
    expect(open.liabilities.find((l) => l.accountingId === inv.id)?.open).toBe('70.00');
    // The payment is fully used, so it is not among the existing payments.
    expect(open.payments).toHaveLength(0);

    const tooMuch = await t.call('POST', '/payments', {
      companyId: cli, accountId: t.acc('411'), paymentAccountId: t.acc('501'), date: '2026-02-06', term: 'Плащане',
      amount: '100', allocations: [{ accountingId: inv.id, amount: '80' }],
    });
    expect(tooMuch.status).toBe(422);
    expect(keys(tooMuch)).toContain('strPaymentExceedsOpenAmount');
    // Nothing was posted by the refused payment.
    open = await openOf(cli);
    expect(open.balance).toBe('70.00');

    // The payment account is remembered (config PaymentAccount).
    expect((await t.call('GET', '/payments/settings')).body.paymentAccountId).toBe(t.acc('501'));
  });

  it('a supplier payment from the bank is Dr partner / Cr bank, and the partners list splits by tab', async () => {
    const sup = await t.partner('Доставчик за плащане ЕООД', ['401']);
    const inv = await t.post({ date: '2026-02-02', docNumber: 'S-9', partner: sup, dr: [['602', 300]], cr: [['401', 300]] });
    const r = await t.call('POST', '/payments', {
      companyId: sup, accountId: t.acc('401'), paymentAccountId: t.acc('503'), date: '2026-02-10', term: 'Плащане',
      documentNumber: '77', amount: '300', allocations: [{ accountingId: inv.id }],
    });
    expect(r.status, r.text).toBe(201);
    const entry = (await t.call('GET', `/entries/${r.body.id}`)).body;
    expect(entry).toMatchObject({ documentTypeId: 11, documentNumber: '77' });
    expect(entry.debits[0]).toMatchObject({ accountId: t.acc('401'), companyId: sup, amount: '300.00' });
    expect(entry.credits[0]).toMatchObject({ accountId: t.acc('503') });
    expect((await openOf(sup)).liabilities).toHaveLength(0);

    await t.post({ date: '2026-02-03', docNumber: 'S-10', partner: sup, dr: [['602', 10]], cr: [['401', 10]] });
    const suppliers = (await t.call('GET', '/payments/partners?tab=suppliers')).body as { companyId: number; balance: string }[];
    const clients = (await t.call('GET', '/payments/partners?tab=clients')).body as { companyId: number }[];
    expect(suppliers.find((p) => p.companyId === sup)?.balance).toBe('-10.00');
    expect(clients.some((p) => p.companyId === sup)).toBe(false);
  });

  it('binds an invoice with an existing payment (cursor walk) and the link can be deleted again', async () => {
    const sup = await t.partner('Обвързан доставчик ООД', ['401']);
    const inv1 = await t.post({ date: '2026-03-01', docNumber: 'B-1', partner: sup, dr: [['602', 100]], cr: [['401', 100]] });
    const inv2 = await t.post({ date: '2026-03-02', docNumber: 'B-2', partner: sup, dr: [['602', 100]], cr: [['401', 100]] });
    const pay = await t.post({ date: '2026-03-10', docType: 9, docNumber: '901', partner: sup, dr: [['401', 150]], cr: [['501', 150]] });
    let open = await openOf(sup);
    expect(open.payments.map((p) => p.accountingId)).toEqual([pay.id]);

    const r = await t.call('POST', '/payments/bind', {
      accountId: t.acc('401'), companyId: sup,
      liabilities: [{ accountingId: inv2.id }, { accountingId: inv1.id }], payments: [{ accountingId: pay.id }],
    });
    expect(r.status, r.text).toBe(201);
    // Liabilities are walked in date order: B-1 gets 100, B-2 the remaining 50.
    open = await openOf(sup);
    expect(open.liabilities.map((l) => [l.accountingId, l.open])).toEqual([[inv2.id, '-50.00']]);
    expect(open.payments).toHaveLength(0);

    const links = (await t.call('GET', `/payments/links?companyId=${sup}`)).body as { id: number; refAccountingId: number; amount: string; paymentDocumentNumber: string }[];
    expect(links.map((l) => [l.refAccountingId, l.amount, l.paymentDocumentNumber])).toEqual([[inv1.id, '100.00', '901'], [inv2.id, '50.00', '901']]);
    expect((await t.call('DELETE', `/payments/links/${links[1]!.id}`)).status).toBe(200);
    open = await openOf(sup);
    expect(open.liabilities.find((l) => l.accountingId === inv2.id)?.open).toBe('-100.00');
    expect(open.payments.find((p) => p.accountingId === pay.id)?.open).toBe('50.00');

    const del = await t.call('POST', '/payments/links/delete', { accountingIds: [pay.id] });
    expect(del.body.deleted).toBe(1);
    expect((await openOf(sup)).payments.find((p) => p.accountingId === pay.id)?.open).toBe('150.00');
  });

  it('refuses binding documents of another partner or account', async () => {
    const a = await t.partner('Партньор А ООД', ['411']);
    const b = await t.partner('Партньор Б ООД', ['411']);
    const inv = await t.post({ date: '2026-03-01', partner: a, dr: [['411', 40]], cr: [['702', 40]] });
    const pay = await t.post({ date: '2026-03-02', docType: 8, docNumber: '801', partner: b, dr: [['501', 40]], cr: [['411', 40]] });
    const r = await t.call('POST', '/payments/bind', { accountId: t.acc('411'), companyId: a, liabilities: [{ accountingId: inv.id }], payments: [{ accountingId: pay.id }] });
    expect(r.status).toBe(422);
    expect(keys(r)).toEqual(['strDifferentPartnerOrAccount']);
  });

  it('voiding an invoice removes its links but keeps the payment entry (02a 5.1)', async () => {
    const cli = await t.partner('Анулиран клиент ООД', ['411']);
    const inv = await t.post({ date: '2026-04-01', partner: cli, dr: [['411', 80]], cr: [['702', 80]] });
    const r = await t.call('POST', '/payments', {
      companyId: cli, accountId: t.acc('411'), paymentAccountId: t.acc('501'), date: '2026-04-02', term: 'Плащане',
      amount: '80', allocations: [{ accountingId: inv.id }],
    });
    expect(r.status, r.text).toBe(201);
    expect((await t.call('DELETE', `/entries/${inv.id}`)).status).toBe(200);
    expect((await t.call('GET', `/entries/${r.body.id}`)).status).toBe(200);
    expect((await t.call('GET', `/payments/links?accountingId=${r.body.id}`)).body).toHaveLength(0);
    // The payment is open again as an existing payment of the partner.
    expect((await openOf(cli)).payments.map((p) => [p.accountingId, p.open])).toEqual([[r.body.id, '-80.00']]);
  });

  it('a locked month blocks a payment and changing links of its entries', async () => {
    const cli = await t.partner('Заключен клиент ООД', ['411']);
    const inv = await t.post({ date: '2026-05-01', partner: cli, dr: [['411', 60]], cr: [['702', 60]] });
    const pay = await t.post({ date: '2026-05-03', docType: 8, docNumber: '805', partner: cli, dr: [['501', 60]], cr: [['411', 60]] });
    const years = (await t.call('GET', '/years')).body;
    await t.call('PUT', `/years/${years[0].id}/locks`, { months: [5] });
    try {
      const r = await t.call('POST', '/payments', {
        companyId: cli, accountId: t.acc('411'), paymentAccountId: t.acc('501'), date: '2026-05-10', term: 'Плащане',
        amount: '60', allocations: [{ accountingId: inv.id }],
      });
      expect(r.status).toBe(422);
      expect(keys(r)).toContain('strWrongAccountingMonth');
      const b = await t.call('POST', '/payments/bind', { accountId: t.acc('411'), companyId: cli, liabilities: [{ accountingId: inv.id }], payments: [{ accountingId: pay.id }] });
      expect(b.status).toBe(400);
      expect(keys(b)).toEqual(['strLockedMonthOperation']);
    } finally {
      await t.call('PUT', `/years/${years[0].id}/locks`, { months: [] });
    }
    expect((await t.call('POST', '/payments/bind', { accountId: t.acc('411'), companyId: cli, liabilities: [{ accountingId: inv.id }], payments: [{ accountingId: pay.id }] })).status).toBe(201);
  });

  it('documents of a currency account with different exchange rates are refused', async () => {
    const parent = t.acc('413');
    const sub = await t.call('POST', '/accounts', { parentId: parent, description: 'Клиенти в USD', accountCategoryId: 12, currencyId: 3 });
    expect(sub.status, sub.text).toBe(201);
    await t.reloadAccounts();
    const usd = sub.body.number as string;
    const cli = await t.partner('Валутен клиент Inc', [usd]);
    const i1 = await t.post({ date: '2026-06-01', partner: cli, dr: [[usd, 90, { currencyAmount: '100' }]], cr: [['702', 90]] });
    const i2 = await t.post({ date: '2026-06-02', partner: cli, dr: [[usd, 95, { currencyAmount: '100' }]], cr: [['702', 95]] });
    const r = await t.call('POST', '/payments', {
      companyId: cli, accountId: t.acc(usd), paymentAccountId: t.acc('503'), date: '2026-06-10', term: 'Плащане', documentNumber: '1',
      amount: '185', currencyAmount: '200', allocations: [{ accountingId: i1.id }, { accountingId: i2.id }],
    });
    expect(r.status).toBe(422);
    expect(keys(r)).toContain('strDifferentExchangeRatesInDocumentsError');
    expect(r.body.messages.find((m: { key: string }) => m.key === 'strDifferentExchangeRatesInDocumentsError').text)
      .toBe('Избраните документи са с различни валутни курсове. Операцията не може да бъде записана.');
    // One document alone is accepted and its currency balance follows.
    const ok = await t.call('POST', '/payments', {
      companyId: cli, accountId: t.acc(usd), paymentAccountId: t.acc('503'), date: '2026-06-10', term: 'Плащане', documentNumber: '2',
      amount: '45', currencyAmount: '50', exchangeRate: '0.9', allocations: [{ accountingId: i1.id, amount: '45' }],
    });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.links[0]).toMatchObject({ amount: '45.000000', currencyAmount: '50.000000' });
  });
});

describe('entry editor: automatic payment and binding (02a 4.3, 8.2)', () => {
  it('validates the auto payment options before saving', async () => {
    const noNumber = await t.call('POST', '/payments/validate-auto', {
      paymentAccountId: t.acc('503'), documentTypeId: 11, documentNumber: '', lines: [{ accountId: t.acc('411') }, { accountId: t.acc('702') }],
    });
    expect(noNumber.body.messages.map((m: { key: string }) => m.key)).toEqual(['strMissingDocumentNumberInPayment']);
    // Cash account: a ПКО takes the next number, so no number is needed.
    const cash = await t.call('POST', '/payments/validate-auto', { paymentAccountId: t.acc('501'), documentTypeId: null, lines: [{ accountId: t.acc('411') }] });
    expect(cash.body.messages).toEqual([]);
    const none = await t.call('POST', '/payments/validate-auto', { paymentAccountId: null, documentNumber: '1', lines: [{ accountId: t.acc('602') }] });
    expect(none.body.messages.map((m: { key: string }) => m.key)).toEqual(['strPaymentAccountMissing', 'strNoPartnerLineForPayment']);
  });

  it('auto payment creates the payment entry and its link; the invoice disappears from the open items', async () => {
    const cli = await t.partner('Автоматичен клиент ООД', ['411']);
    const inv = await t.post({ date: '2026-07-01', docNumber: 'A-1', term: 'Продажба на услуга', partner: cli, dr: [['411', 240]], cr: [['702', 240]] });
    const r = await t.call('POST', '/payments/auto', { entryId: inv.id, paymentAccountId: t.acc('501'), documentTypeId: null });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toHaveLength(1);
    const pay = (await t.call('GET', `/entries/${r.body[0].id}`)).body;
    expect(pay).toMatchObject({ accountingDate: '2026-07-01', documentTypeId: 8, term: 'Продажба на услуга' });
    expect(pay.debits[0]).toMatchObject({ accountId: t.acc('501'), amount: '240.00' });
    const links = (await t.call('GET', `/payments/links?accountingId=${inv.id}`)).body;
    expect(links).toMatchObject([{ refAccountingId: inv.id, paymentAccountingId: r.body[0].id, amount: '240.00' }]);
    const open = await openOf(cli);
    expect(open.liabilities).toHaveLength(0);
    expect(open.payments).toHaveLength(0);
  });

  it('binds a saved payment entry with chosen invoices, capped by the payment', async () => {
    const sup = await t.partner('Обвързване от контиране ООД', ['401']);
    const inv = await t.post({ date: '2026-07-01', partner: sup, dr: [['602', 70]], cr: [['401', 70]] });
    const inv2 = await t.post({ date: '2026-07-02', partner: sup, dr: [['602', 70]], cr: [['401', 70]] });
    const pay = await t.post({ date: '2026-07-05', docType: 9, docNumber: '905', partner: sup, dr: [['401', 100]], cr: [['501', 100]] });
    const cands = (await t.call('GET', `/payments/candidates?accountId=${t.acc('401')}&companyId=${sup}&exclude=${pay.id}`)).body as { accountingId: number }[];
    expect(cands.map((c) => c.accountingId)).toEqual([inv.id, inv2.id]);
    const over = await t.call('POST', '/payments/bind-entry', { entryId: pay.id, documents: [{ accountingId: inv.id }, { accountingId: inv2.id }] });
    expect(over.status).toBe(422);
    expect(keys(over)).toEqual(['strAllocationExceedsPayment']);
    const r = await t.call('POST', '/payments/bind-entry', { entryId: pay.id, documents: [{ accountingId: inv.id }, { accountingId: inv2.id, amount: '30' }] });
    expect(r.status, r.text).toBe(201);
    const open = await openOf(sup);
    expect(open.liabilities.map((l) => [l.accountingId, l.open])).toEqual([[inv2.id, '-40.00']]);
    expect(open.payments).toHaveLength(0);
  });
});

describe('documents closing (02a 10)', () => {
  it('by amount: invoice 100 and cash receipt 100 form one pair; after saving it disappears from the open items', async () => {
    const cli = await t.partner('Закриване по сума ООД', ['411']);
    const inv = await t.post({ date: '2026-08-01', docNumber: 'C-1', partner: cli, dr: [['411', 100]], cr: [['702', 100]] });
    const pko = await t.post({ date: '2026-08-05', docType: 8, docNumber: '850', partner: cli, dr: [['501', 100]], cr: [['411', 100]] });
    await t.post({ date: '2026-08-06', docType: 8, docNumber: '851', partner: cli, dr: [['501', 90]], cr: [['411', 90]] });
    const q = `/documents-closing?mode=amount&companyId=${cli}`;
    const prop = (await t.call('GET', q)).body;
    expect(prop.modes.map((m: { id: string }) => m.id)).toEqual(['document', 'amount', 'optionalReference']);
    expect(prop.pairs).toHaveLength(1);
    expect(prop.pairs[0]).toMatchObject({
      amount: '100.00',
      liability: { accountingId: inv.id, operation: 'Вземане', documentType: 'Ф-ра', documentNumber: 'C-1', amount: '100.00' },
      payment: { accountingId: pko.id, operation: 'Плащане', documentType: 'ПКО' },
    });
    const r = await t.call('POST', '/documents-closing', { pairs: [{ liabilityAccountingId: inv.id, paymentAccountingId: pko.id }] });
    expect(r.status, r.text).toBe(201);
    expect(r.body.links).toHaveLength(1);
    const open = await openOf(cli);
    expect(open.liabilities).toHaveLength(0);
    expect(open.payments.map((p) => p.open)).toEqual(['-90.00']);
    expect((await t.call('GET', q)).body.pairs).toHaveLength(0);
    // Saving the same pair again writes nothing more.
    const again = await t.call('POST', '/documents-closing', { pairs: [{ liabilityAccountingId: inv.id, paymentAccountingId: pko.id }] });
    expect(again.status).toBe(422);
  });

  it('by document: same type and number in opposite directions ("007" = "7"), partial amount', async () => {
    const sup = await t.partner('Закриване по документ ООД', ['401']);
    const inv = await t.post({ date: '2026-08-01', docType: 5, docNumber: '007', partner: sup, dr: [['602', 120]], cr: [['401', 120]] });
    const back = await t.post({ date: '2026-08-02', docType: 5, docNumber: '7', partner: sup, dr: [['401', 100]], cr: [['602', 100]] });
    const pairs = (await t.call('GET', `/documents-closing?mode=document&companyId=${sup}`)).body.pairs;
    expect(pairs.map((p: { liability: { accountingId: number }; payment: { accountingId: number }; amount: string }) => [p.liability.accountingId, p.payment.accountingId, p.amount]))
      .toEqual([[inv.id, back.id, '100.00']]);
    expect((await t.call('POST', '/documents-closing', { pairs: [{ liabilityAccountingId: inv.id, paymentAccountingId: back.id }] })).status).toBe(201);
    expect((await openOf(sup)).liabilities.map((l) => l.open)).toEqual(['-20.00']);
  });

  it('import mode: invoice 100 against imported payments 60 and 40 gives two links', async () => {
    const cli = await t.partner('Импорт клиент ООД', ['411']);
    const inv = await t.post({ date: '2026-09-01', partner: cli, dr: [['411', 100]], cr: [['702', 100]] });
    const p60 = await t.post({ date: '2026-09-02', docType: 11, docNumber: 'BI-1', partner: cli, dr: [['503', 60]], cr: [['411', 60]] });
    const p40 = await t.post({ date: '2026-09-03', docType: 11, docNumber: 'BI-2', partner: cli, dr: [['503', 40]], cr: [['411', 40]] });
    const r = await t.call('POST', '/documents-closing/import', { accountingIds: [p60.id, p40.id] });
    expect(r.status, r.text).toBe(201);
    expect(r.body.links.map((l: { paymentAccountingId: number; amount: string }) => [l.paymentAccountingId, l.amount])).toEqual([[p60.id, '60.000000'], [p40.id, '40.000000']]);
    expect((await openOf(cli)).liabilities).toHaveLength(0);
  });
});
