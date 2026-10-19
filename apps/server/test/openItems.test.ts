import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';
import { dec } from '@shmi/core';
import { insertPaymentLinks, openItemPartnerTotals, openItems, type OpenItem } from '../src/services/openItems.ts';

let t: TestCompany;
beforeAll(async () => {
  t = await createTestCompany();
}, 60_000);
afterAll(() => t.close());

const db = async () => t.driver.company(t.companyDb);

describe('open items (spec 05 6.3, 01b 6.4 part B)', () => {
  it('nets supplier and client documents with their payment allocations', async () => {
    const sup = await t.partner('Доставчик ООД', ['401']);
    const cli = await t.partner('Клиент ООД', ['411']);
    const inv = await t.post({ date: '2026-02-01', docNumber: 'D-17', partner: sup, dr: [['601', 600]], cr: [['401', 600]] });
    const pay = await t.post({ date: '2026-02-10', docType: 9, docNumber: '1', partner: sup, dr: [['401', 200]], cr: [['501', 200]] });
    const sale = await t.post({ date: '2026-02-03', docNumber: 'S-1', partner: cli, dr: [['411', 600]], cr: [['702', 600]] });
    const rec = await t.post({ date: '2026-02-12', docType: 8, docNumber: '1', partner: cli, dr: [['501', 200]], cr: [['411', 200]] });
    const d = await db();
    await insertPaymentLinks(d, [
      { paymentAccountingId: pay.id, refAccountingId: inv.id, documentId: null, accountId: t.acc('401'), companyId: sup, amount: '200' },
      { paymentAccountingId: rec.id, refAccountingId: sale.id, documentId: null, accountId: t.acc('411'), companyId: cli, amount: '200' },
    ]);
    const items = await openItems(d, { startDate: '2026-01-01', endDate: '2026-12-31' });
    const byAcc = new Map(items.map((i) => [i.accountingId, i]));
    expect(byAcc.get(inv.id)).toMatchObject({ open: '-400.00', kind: 'liability', side: 'supplier', documentNumber: 'D-17' });
    expect(byAcc.get(sale.id)).toMatchObject({ open: '400.00', kind: 'liability', side: 'client' });
    // Fully used payments vanish unless closed items are requested.
    expect(byAcc.has(pay.id)).toBe(false);
    expect(byAcc.has(rec.id)).toBe(false);
    const all = await openItems(d, { startDate: '2026-01-01', endDate: '2026-12-31', showClosed: true });
    expect(all.find((i) => i.accountingId === pay.id)).toMatchObject({ open: '0.00', kind: 'none', booked: '200.00', used: '200.00' });
    // An allocation whose payment is dated after the window does not count.
    const early = await openItems(d, { startDate: '2026-01-01', endDate: '2026-02-05' });
    expect(early.find((i) => i.accountingId === inv.id)?.open).toBe('-600.00');
  });
});

describe('open items computed in SQL (big companies)', () => {
  let sup: number, cli: number, both: number;
  beforeAll(async () => {
    sup = await t.partner('Голям доставчик ООД', ['401'], { dueDays: 30 });
    cli = await t.partner('Голям клиент ООД', ['411'], { dueDays: 10 });
    both = await t.partner('Двустранен ООД', ['401', '411']);
    const d = await db();
    const inv = await t.post({ date: '2026-03-01', docNumber: 'G-1', partner: sup, dr: [['601', 1000]], cr: [['401', 1000]] });
    await t.post({ date: '2026-03-05', docNumber: 'G-2', docDate: '2026-02-27', partner: sup, dueDate: '2026-04-15', dr: [['601', 50.5]], cr: [['401', 50.5]] });
    const pay = await t.post({ date: '2026-03-20', docType: 9, docNumber: '7', partner: sup, dr: [['401', 300]], cr: [['501', 300]] });
    const sale = await t.post({ date: '2026-03-02', docNumber: 'G-3', partner: cli, dr: [['411', 500]], cr: [['702', 500]] });
    // An overpaid sale: the receipt keeps 100 open as a payment.
    const rec = await t.post({ date: '2026-03-25', docType: 8, docNumber: '8', partner: cli, dr: [['501', 600]], cr: [['411', 600]] });
    await t.post({ date: '2026-03-03', docNumber: 'G-4', partner: both, dr: [['411', 70]], cr: [['702', 70]] });
    await t.post({ date: '2026-03-04', docNumber: 'G-5', partner: both, dr: [['601', 20]], cr: [['401', 20]] });
    await insertPaymentLinks(d, [
      { paymentAccountingId: pay.id, refAccountingId: inv.id, documentId: null, accountId: t.acc('401'), companyId: sup, amount: '300' },
      { paymentAccountingId: rec.id, refAccountingId: sale.id, documentId: null, accountId: t.acc('411'), companyId: cli, amount: '500' },
    ]);
  });

  const window = { startDate: '2026-01-01', endDate: '2026-12-31' };

  it('amounts, kinds, document and due dates of the items', async () => {
    const items = await openItems(await db(), { ...window, companyIds: [sup, cli] });
    const byDoc = new Map(items.map((i) => [i.documentNumber, i]));
    expect(byDoc.get('G-1')).toMatchObject({ booked: '-1000.00', covered: '300.00', used: '0.00', open: '-700.00', openAbs: '700.00', kind: 'liability', documentDate: '2026-03-01', dueDate: '2026-03-31', exchangeRate: '0' });
    // The entry's own due date wins over document date + the partner's due days.
    expect(byDoc.get('G-2')).toMatchObject({ open: '-50.50', documentDate: '2026-02-27', dueDate: '2026-04-15', companyDueDays: 30 });
    // The fully used payment is not open.
    expect(byDoc.has('7')).toBe(false);
  });

  it('the kind and closed rules in the query keep exactly the items the item list keeps', async () => {
    const d = await db();
    const all = await openItems(d, { ...window, showClosed: true });
    const open = await openItems(d, window);
    const isOpen = (i: OpenItem) => !(dec(i.open).isZero() && dec(i.openCurrency).isZero());
    expect(all.find((i) => i.documentNumber === '7')).toMatchObject({ open: '0.00', kind: 'none' });
    expect(open).toEqual(all.filter(isOpen));
    for (const kind of ['liability', 'payment'] as const) {
      expect(await openItems(d, { ...window, kind })).toEqual(open.filter((i) => i.kind === kind));
    }
    expect(open.find((i) => i.documentNumber === '8')).toMatchObject({ open: '-100.00', kind: 'payment', side: 'client' });
    // A partner's items (a small query) are the same rows as in the whole list.
    expect(await openItems(d, { ...window, companyIds: [both] })).toEqual(open.filter((i) => i.companyId === both));
  });

  it('per-partner totals (F3) equal the sums of the items', async () => {
    const d = await db();
    const items = await openItems(d, window);
    const expected = new Map<number, { balance: string; liabilities: number; payments: number }>();
    for (const i of items) {
      const e = expected.get(i.companyId) ?? { balance: '0.00', liabilities: 0, payments: 0 };
      expected.set(i.companyId, { balance: dec(e.balance).plus(i.open).toFixed(2), liabilities: e.liabilities + (i.kind === 'liability' ? 1 : 0), payments: e.payments + (i.kind === 'payment' ? 1 : 0) });
    }
    const totals = await openItemPartnerTotals(d, window);
    expect(totals.map((x) => x.companyId)).toEqual([...expected.keys()]);
    for (const x of totals) expect(x).toMatchObject(expected.get(x.companyId)!);
    expect(totals.find((x) => x.companyId === sup)).toMatchObject({ balance: '-750.50', liabilities: 2, payments: 0 });
    expect(totals.find((x) => x.companyId === cli)).toMatchObject({ balance: '-100.00', liabilities: 0, payments: 1 });
    // Tabs: the client side only / the supplier side only.
    const clients = await openItemPartnerTotals(d, { ...window, side: 'client' });
    expect(clients.find((x) => x.companyId === both)).toMatchObject({ balance: '70.00', liabilities: 1 });
    const suppliers = (await t.call('GET', '/payments/partners?tab=suppliers')).body as { companyId: number; balance: string }[];
    expect(suppliers.find((x) => x.companyId === both)?.balance).toBe('-20.00');
    expect(suppliers.some((x) => x.companyId === cli)).toBe(false);
    // In currency only: none of these items is on a currency account.
    expect((await t.call('GET', '/payments/partners?tab=all&inCurrency=1')).body).toEqual([]);
  });
});
