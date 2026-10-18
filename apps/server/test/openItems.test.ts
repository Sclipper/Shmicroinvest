import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';
import { insertPaymentLinks, openItems } from '../src/services/openItems.ts';

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
