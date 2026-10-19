import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';

/**
 * Fixed assets and depreciation (spec 03b): every flow, the acceptance checks of
 * section 16 and the runtime recipes R1-R7. Expected numbers are the spec's.
 */

type Plan = Record<string, unknown>;
type BodyOpts = { accounting?: Plan; tax?: Plan; [k: string]: unknown };
type Month = { month: string; amount: string; isProcessed: boolean; status: string; accountingId: number | null; accountingNumber: string | null };
type PlanView = { months: Month[]; endDate: string | null; methodId: number; total: string; accrued: string; lastProcessedDate: string; improvements: { id: number; date: string; amount: string }[]; years: { year: number; amount: string; percentage: string; revaluationReserve: string }[]; depreciationAmount: string; revaluationReserve: string; finalDate: string | null };
type AssetView = { id: number; accounting: PlanView; tax: PlanView; terminationStatusId: number; terminationAccountingId: number | null; isTerminated: boolean; revaluationReserve: string; inventoryNumber: string };

function harness() {
  let t: TestCompany;
  let invSeq = 0;
  const h = {
    get t() { return t; },
    async init(year: number) {
      t = await createTestCompany({ year });
      return t;
    },
    call: (m: string, u: string, b?: unknown) => t.call(m, u, b),
    acc: (n: string) => t.acc(n),
    plan(o: Plan = {}): Plan {
      return { depreciationAmount: '12000', nonDepreciableAmount: '0', acquisitionDate: '2025-03-15', startDate: '2025-03-15', calcType: 'period', activePeriodLength: 60, annualRate: null, conservation: null, note: '', serialNumber: '', ...o };
    },
    body(o: BodyOpts = {}): Record<string, unknown> & { inventoryNumber: string; accounting: Plan; tax: Plan } {
      const { accounting, tax, ...rest } = o;
      return {
        inventoryNumber: `T${String(++invSeq).padStart(4, '0')}`, name: 'Машина', personInCharge: 'Иван Петров', categoryId: 2,
        inventoryAccountId: t.acc('203'), debitAccountId: t.acc('241/2'), creditAccountId: t.acc('603'), locationId: null, synchronized: false,
        accounting: h.plan(accounting), tax: h.plan({ calcType: 'rate', annualRate: '30', ...tax }), ...rest,
      };
    },
    async create(o: BodyOpts = {}) {
      const body = h.body(o);
      const r = await t.call('POST', '/assets', body);
      expect(r.status, r.text).toBe(201);
      return { id: r.body.id as number, body, warnings: r.body.warnings as { key: string; text: string }[] };
    },
    async view(id: number): Promise<AssetView> {
      const r = await t.call('GET', `/assets/${id}`);
      expect(r.status, r.text).toBe(200);
      return r.body;
    },
    async setDate(date: string) {
      const r = await t.call('PUT', '/session/working-date', { date });
      expect(r.status, r.text).toBe(200);
      await t.reloadAccounts();
    },
    async pending(q: { from?: string; to?: string } = {}) {
      const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
      const r = await t.call('GET', `/accounting-requests${qs ? `?${qs}` : ''}`);
      expect(r.status, r.text).toBe(200);
      return r.body as { from: string; to: string; total: string; rows: { id: number; assetId: number; month: string; amount: string; name: string; inventoryNumber: string }[] };
    },
    /** Posts the pending months of an asset between from and to. */
    async postMonths(assetId: number, from: string, to: string) {
      const p = await h.pending({ from, to });
      const ids = p.rows.filter((r) => r.assetId === assetId).map((r) => r.id);
      const r = await t.call('POST', '/accounting-requests/post', { ids });
      expect(r.status, r.text).toBe(200);
      return r.body as { posted: { scheduleId: number; accountingId: number; number: string; documentNumber: string }[]; failed: number[]; skippedOtherYear: number; warnings: { key: string }[] };
    },
    async addYear(year: number) {
      const r = await t.call('POST', '/years', { year });
      expect(r.status, r.text).toBe(201);
    },
    sum: (ms: { amount: string }[]) => (Math.round(ms.reduce((a, m) => a + Number(m.amount), 0) * 100) / 100).toFixed(2),
    yearSum: (ms: { month: string; amount: string }[], y: number) => h.sum(ms.filter((m) => m.month.startsWith(`${y}-`))),
  };
  return h;
}

const keys = (r: { body: { messages?: { key: string }[] } }) => (r.body.messages ?? []).map((m) => m.key);

/* ==================================================================== */

describe('register, locations, asset form (03b 1, 2, 6)', () => {
  const h = harness();
  beforeAll(() => h.init(2025), 60_000);
  afterAll(() => h.t.close());

  it('has a location tree whose root is named after the company', async () => {
    const r = await h.call('GET', '/asset-locations');
    expect(r.body[0]).toMatchObject({ id: 1, name: 'Тест ООД', level: 1 });
    const child = await h.call('POST', '/asset-locations', { name: 'Цех 1', parentId: 1 });
    expect(child.status).toBe(201);
    const sub = await h.call('POST', '/asset-locations', { name: 'Склад', parentId: child.body.id });
    expect(sub.body.level).toBe(3);
    expect((await h.call('DELETE', '/asset-locations/1')).status).toBe(400);
    expect((await h.call('DELETE', `/asset-locations/${child.body.id}`)).body.error).toBe('Местоположението съдържа подгрупи и не може да бъде изтрито!');
    expect((await h.call('PUT', `/asset-locations/${sub.body.id}`, { name: 'Склад 2' })).status).toBe(200);
    expect((await h.call('POST', '/asset-locations', { name: ' ', parentId: 1 })).status).toBe(422);
  });

  it('asks before saving plans that differ in cost or dates (03b 4); an unchanged difference is not asked again', async () => {
    const body = h.body({ tax: { depreciationAmount: '11000', startDate: '2025-04-01' } });
    const asked = await h.call('POST', '/assets', body);
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ code: 'plansDiffer', error: 'Счетоводният и данъчният амортизационен план се различават по основни параметри (стойност, начало на амортизация). Желаете ли да запишете актива?' });
    const r = await h.call('POST', '/assets', { ...body, plansDifferAccepted: true });
    expect(r.status, r.text).toBe(201);
    expect((await h.call('PUT', `/assets/${r.body.id}`, { ...body, name: 'Преименувана' })).status).toBe(200);
    const changed = await h.call('PUT', `/assets/${r.body.id}`, { ...body, tax: { ...body.tax, depreciationAmount: '12000', regenerate: true } });
    expect(changed.body.code, changed.text).toBe('plansDiffer');
    // Rate and non-depreciable part differ legitimately and are not asked.
    expect((await h.call('POST', '/assets', h.body({ accounting: { nonDepreciableAmount: '500' } }))).status).toBe(201);
  });

  it('new asset defaults: next inventory number of channel 8 (10 digits), dates = application date', async () => {
    await h.setDate('2025-05-20');
    const r = await h.call('GET', '/assets/new');
    expect(r.body).toMatchObject({ inventoryNumber: '0000000001', acquisitionDate: '2025-05-20', startDate: '2025-05-20', isEuro: false });
  });

  it('save validations (6.2) block the save with their keys', async () => {
    const bad = h.body({ name: '', inventoryNumber: '', inventoryAccountId: null, debitAccountId: null, creditAccountId: null, categoryId: null });
    const r = await h.call('POST', '/assets', bad);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('Актив с инвентарен номер  не може да бъде запазен поради следните грешки:');
    expect(keys(r)).toEqual(expect.arrayContaining([
      'strAssetNameIsMissing', 'strAssetInventoryNumberIsMissing', 'strAssetDebitAccountIsMissing', 'strAssetCreditAccountIsMissing',
      'strAssetInventoryAccountIsMissing', 'strAssetDepreciationCategoryIsEmpty',
    ]));
    const parent = await h.call('POST', '/assets', h.body({ debitAccountId: h.acc('241') }));
    expect(keys(parent)).toContain('strDebitAssetAccountHasSubAccounts');
  });

  it('acceptance 6: a life of 11 months blocks the save', async () => {
    const r = await h.call('POST', '/assets', h.body({ accounting: { activePeriodLength: 11 } }));
    expect(r.status).toBe(422);
    expect(r.body.messages).toContainEqual(expect.objectContaining({
      key: 'strAccountingDepreciationInvalidPeriodLength', text: 'Счетоводни амортизации: Полезният срок на годност за актива не може да е по-малък от 12 месеца',
    }));
  });

  it('inventory number is unique (case-sensitive) within the ledger', async () => {
    const a = await h.create({ inventoryNumber: 'INV-1' });
    const dup = await h.call('POST', '/assets', h.body({ inventoryNumber: 'INV-1' }));
    expect(keys(dup)).toContain('strAssetInventoryNumberExists');
    expect((await h.call('POST', '/assets', h.body({ inventoryNumber: 'inv-1' }))).status).toBe(201);
    await h.call('DELETE', `/assets/${a.id}`);
  });

  it('acceptance 1: 12 000 / 60 from 15.03.2025: first row 01.04.2025 = 200.00, 2025 = 1 800.00, last 01.03.2030', async () => {
    const { id } = await h.create();
    const v = await h.view(id);
    const m = v.accounting.months;
    expect(m).toHaveLength(60);
    expect([m[0]!.month, m[0]!.amount]).toEqual(['2025-04-01', '200.00']);
    expect(h.yearSum(m, 2025)).toBe('1800.00');
    expect(m[59]!.month).toBe('2030-03-01');
    expect(v.accounting.endDate).toBe('2030-03-01');
    expect(v.accounting.total).toBe('12000.00');
    expect(v.accounting.methodId).toBe(1);
  });

  it('acceptance 2: the tax plan starts in March unsynchronised and in April synchronised', async () => {
    const a = await h.view((await h.create({ tax: { calcType: 'period', activePeriodLength: 60 } })).id);
    expect(a.tax.months[0]!.month).toBe('2025-03-01');
    expect(a.tax.months.every((x) => x.isProcessed)).toBe(true);
    const b = await h.view((await h.create({ synchronized: true })).id);
    expect(b.tax.months[0]!.month).toBe('2025-04-01');
    expect(b.tax.months).toHaveLength(60);
  });

  it('4.1 D: САП 60 months vs ДАП at the 30 % maximum (40 months from March)', async () => {
    const v = await h.view((await h.create({ accounting: { startDate: '2025-03-20', acquisitionDate: '2025-03-20' }, tax: { startDate: '2025-03-20', acquisitionDate: '2025-03-20' } })).id);
    expect([2025, 2026, 2027, 2028].map((y) => h.yearSum(v.tax.months, y))).toEqual(['3000.00', '3600.00', '3600.00', '1800.00']);
    expect([2025, 2026].map((y) => h.yearSum(v.accounting.months, y))).toEqual(['1800.00', '2400.00']);
  });

  it('acceptance 3: 1 000 / 36 from 10.01.2025: 27.77 and Jan 2028 = 28.05, method "Потребителски"', async () => {
    const v = await h.view((await h.create({ accounting: { depreciationAmount: '1000', startDate: '2025-01-10', acquisitionDate: '2025-01-10', activePeriodLength: 36 }, tax: { depreciationAmount: '1000', startDate: '2025-01-10', acquisitionDate: '2025-01-10' } })).id);
    const m = v.accounting.months;
    expect(m[0]!.month).toBe('2025-02-01');
    expect(m.slice(0, 35).every((x) => x.amount === '27.77')).toBe(true);
    expect([m[35]!.month, m[35]!.amount]).toEqual(['2028-01-01', '28.05']);
    expect(v.accounting.total).toBe('1000.00');
    expect(v.accounting.methodId).toBe(2);
  });

  it('acceptance 4: 100.10 over 48 months from January: 24.96 x 3 and 25.22', async () => {
    const v = await h.view((await h.create({ accounting: { depreciationAmount: '100.10', startDate: '2024-12-05', acquisitionDate: '2024-12-05', activePeriodLength: 48 }, tax: { depreciationAmount: '100.10', startDate: '2024-12-05', acquisitionDate: '2024-12-05' } })).id);
    expect([2025, 2026, 2027, 2028].map((y) => h.yearSum(v.accounting.months, y))).toEqual(['24.96', '24.96', '24.96', '25.22']);
    expect(v.accounting.months[47]!.amount).toBe('2.34');
  });

  it('acceptance 5: a tax rate of 31 % on category II warns with limit 30.00 and saves', async () => {
    const r = await h.create({ tax: { calcType: 'rate', annualRate: '31' } });
    expect(r.warnings).toContainEqual(expect.objectContaining({ key: 'strYearPercentageExceedsMaximumAllowed' }));
    expect(r.warnings[0]!.text).toContain('(30.00%)');
  });

  it('land and forests: no schedule, no depreciation accounts needed', async () => {
    const { id } = await h.create({ categoryId: 8, debitAccountId: null, creditAccountId: null, inventoryAccountId: h.acc('201'), accounting: { calcType: 'rate', annualRate: '0' }, tax: { calcType: 'rate', annualRate: '0' } });
    const v = await h.view(id);
    expect(v.accounting.months).toEqual([]);
    expect(v.accounting.endDate).toBeNull();
  });

  it('preview recomputes the plan without saving', async () => {
    const r = await h.call('POST', '/assets/preview', h.body({ accounting: { depreciationAmount: '6000' } }));
    expect(r.status, r.text).toBe(200);
    expect(r.body.accounting.months[0].amount).toBe('100.00');
    expect(r.body.messages).toEqual([]);
  });

  it('lists the register with filters', async () => {
    const all = (await h.call('GET', '/assets')).body as { id: number; inventoryNumber: string; cost: string; name: string; location: string }[];
    expect(all.length).toBeGreaterThan(5);
    expect(all[0]!.location).toBe('Тест ООД');
    expect((await h.call('GET', '/assets?inventoryNumber=t000')).body.length).toBeGreaterThan(0);
    expect((await h.call('GET', '/assets?account=201')).body).toHaveLength(1);
    expect((await h.call('GET', '/assets?categoryId=8')).body).toHaveLength(1);
    expect((await h.call('GET', '/assets?mol=Петров')).body.length).toBe(all.length);
  });

  it('R6: register period filters are inclusive on both bounds', async () => {
    const q = (period: string, from: string, to: string) => h.call('GET', `/assets?period=${period}&from=${from}&to=${to}`).then((r) => r.body.length as number);
    expect(await q('expiredSap', '2030-03-01', '2030-03-01')).toBeGreaterThan(0);
    expect(await q('expiredSap', '2030-03-02', '2030-03-31')).toBe(0);
    expect(await q('active', '2025-01-01', '2025-03-15')).toBeGreaterThan(0);
  });
});

/* ==================================================================== */

describe('monthly posting (03b 12, acceptance 7-8)', () => {
  const h = harness();
  let assetId: number;
  beforeAll(async () => {
    await h.init(2025);
    await h.addYear(2024);
    await h.setDate('2025-06-15');
  }, 60_000);
  afterAll(() => h.t.close());

  it('defaults the list to 01.01 .. end of the application month of the active year', async () => {
    const p = await h.pending();
    expect([p.from, p.to]).toEqual(['2025-01-01', '2025-06-30']);
  });

  it('acceptance 7: two memorial orders for the active year, the previous-year month is skipped with a warning', async () => {
    assetId = (await h.create({ name: 'Струг', accounting: { startDate: '2024-11-15', acquisitionDate: '2024-11-15' }, tax: { startDate: '2024-11-15', acquisitionDate: '2024-11-15' } })).id;
    const p = await h.pending({ from: '2024-12-01', to: '2025-02-28' });
    const mine = p.rows.filter((r) => r.assetId === assetId);
    expect(mine.map((r) => r.month)).toEqual(['2024-12-01', '2025-01-01', '2025-02-01']);
    const r = await h.call('POST', '/accounting-requests/post', { ids: mine.map((x) => x.id) });
    expect(r.body.posted).toHaveLength(2);
    expect(r.body.skippedOtherYear).toBe(1);
    expect(r.body.warnings[0].key).toBe('strAccountingRequestsFromAnotherYearFound');
    const [jan, feb] = r.body.posted;
    const e = (await h.call('GET', `/entries/${jan.accountingId}`)).body;
    expect(e.accountingDate).toBe('2025-01-31');
    expect(e.documentDate).toBe('2025-01-31');
    expect(e.documentTypeId).toBe(10);
    expect(e.documentNumber).toBe('0000000001');
    expect(e.term).toBe('Амортизация');
    expect(e.reference).toMatch(/^Струг; T\d{4}$/);
    expect(e.debits).toEqual([expect.objectContaining({ accountId: h.acc('603'), amount: '200.00' })]);
    expect(e.credits).toEqual([expect.objectContaining({ accountId: h.acc('241/2'), amount: '200.00' })]);
    expect((await h.call('GET', `/entries/${feb.accountingId}`)).body.accountingDate).toBe('2025-02-28');
    // Posted rows are no longer pending; the December 2024 row still is.
    const after = (await h.pending({ from: '2024-12-01', to: '2025-02-28' })).rows.filter((x) => x.assetId === assetId);
    expect(after.map((x) => x.month)).toEqual(['2024-12-01']);
    const v = await h.view(assetId);
    expect(v.accounting.months[1]).toMatchObject({ status: 'posted', isProcessed: true, accountingNumber: jan.number });
  });

  it('acceptance 8: a deleted posting makes the month pending again; a new run uses the next memorial-order number', async () => {
    const v = await h.view(assetId);
    const feb = v.accounting.months.find((m) => m.month === '2025-02-01')!;
    expect((await h.call('DELETE', `/entries/${feb.accountingId}`)).status).toBe(200);
    const again = (await h.pending({ from: '2025-02-01', to: '2025-02-28' })).rows.filter((x) => x.assetId === assetId);
    expect(again).toHaveLength(1);
    const r = await h.postMonths(assetId, '2025-02-01', '2025-02-28');
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0]!.documentNumber).toBe('0000000003');
  });

  it('a month in a locked period stays pending without a message (12.3)', async () => {
    const years = (await h.call('GET', '/years')).body as { id: number; year: number }[];
    const fy = years.find((y) => y.year === 2025)!;
    await h.call('PUT', `/years/${fy.id}/locks`, { months: [3] });
    const r = await h.postMonths(assetId, '2025-03-01', '2025-03-31');
    expect(r.posted).toHaveLength(0);
    expect(r.failed).toHaveLength(1);
    expect((await h.pending({ from: '2025-03-01', to: '2025-03-31' })).rows.filter((x) => x.assetId === assetId)).toHaveLength(1);
    await h.call('PUT', `/years/${fy.id}/locks`, { months: [] });
  });

  it('a month requested twice (double click) is posted once', async () => {
    const other = (await h.create({ name: 'Двоен клик' })).id;
    const row = (await h.pending({ from: '2025-04-01', to: '2025-04-30' })).rows.find((x) => x.assetId === other)!;
    const r = await h.call('POST', '/accounting-requests/post', { ids: [row.id, row.id] });
    expect(r.status, r.text).toBe(200);
    expect(r.body.posted).toHaveLength(1);
  });

  it('acceptance 9: changing a posted month offers delete / unlink; a locked month refuses the save', async () => {
    await h.postMonths(assetId, '2025-03-01', '2025-04-30');
    const v = await h.view(assetId);
    const body = h.body({ inventoryNumber: v.inventoryNumber, name: 'Струг', accounting: { startDate: '2024-11-15', acquisitionDate: '2024-11-15' }, tax: { startDate: '2024-11-15', acquisitionDate: '2024-11-15' } });
    const months = v.accounting.months.map((m) => ({ month: m.month, amount: m.amount }));
    const changed = (month: string, delta: number) => months.map((m) => (m.month === month ? { ...m, amount: (Number(m.amount) + delta).toFixed(2) } : m.month === '2029-11-01' ? { ...m, amount: (Number(m.amount) - delta).toFixed(2) } : m));
    // March: posted; plan amount changed -> dialog.
    const ask = await h.call('PUT', `/assets/${assetId}`, { ...body, accounting: { ...body.accounting, months: changed('2025-03-01', 10) } });
    expect(ask.status).toBe(409);
    expect(ask.body.code).toBe('postingsDiffer');
    expect(ask.body.error).toContain('Направената промяна в счетоводен амортизационен план се различава от осчетоводените отчисления:');
    expect(ask.body.error).toContain('Амортизационно отчисление от месец 03.2025 с контиране №');
    expect(ask.body.error).toContain('Желаете ли изтриване на изброените операции?');
    const march = v.accounting.months.find((m) => m.month === '2025-03-01')!;
    // "Не": only the link is dropped; the posting stays in the ledger.
    const unlink = await h.call('PUT', `/assets/${assetId}`, { ...body, accounting: { ...body.accounting, months: changed('2025-03-01', 10) }, postingsResolution: 'unlink' });
    expect(unlink.status, unlink.text).toBe(200);
    expect((await h.call('GET', `/entries/${march.accountingId}`)).status).toBe(200);
    const v2 = await h.view(assetId);
    expect(v2.accounting.months.find((m) => m.month === '2025-03-01')).toMatchObject({ amount: '210.00', isProcessed: false, accountingId: null });
    // "Да": the posting of April is deleted.
    const april = v2.accounting.months.find((m) => m.month === '2025-04-01')!;
    const months2 = v2.accounting.months.map((m) => ({ month: m.month, amount: m.month === '2025-04-01' ? '190.00' : m.month === '2029-11-01' ? (Number(m.amount) + 10).toFixed(2) : m.amount }));
    const del = await h.call('PUT', `/assets/${assetId}`, { ...body, accounting: { ...body.accounting, months: months2 }, postingsResolution: 'delete' });
    expect(del.status, del.text).toBe(200);
    expect((await h.call('GET', `/entries/${april.accountingId}`)).status).toBe(404);
    // Locked period: the save is refused with "Месец 01.2025 е заключен".
    const years = (await h.call('GET', '/years')).body as { id: number; year: number }[];
    const fy = years.find((y) => y.year === 2025)!;
    await h.call('PUT', `/years/${fy.id}/locks`, { months: [1] });
    const v3 = await h.view(assetId);
    const months3 = v3.accounting.months.map((m) => ({ month: m.month, amount: m.month === '2025-01-01' ? '150.00' : m.month === '2029-11-01' ? (Number(m.amount) + 50).toFixed(2) : m.amount }));
    const locked = await h.call('PUT', `/assets/${assetId}`, { ...body, accounting: { ...body.accounting, months: months3 }, postingsResolution: 'delete' });
    expect(locked.status).toBe(422);
    expect(locked.body.messages.map((m: { text: string }) => m.text)).toContain('Месец 01.2025 е заключен');
    await h.call('PUT', `/years/${fy.id}/locks`, { months: [] });
  });

  it('acceptance 13: an asset with a posted row cannot be deleted', async () => {
    const r = await h.call('DELETE', `/assets/${assetId}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Има извършени контирания към този дълготраен актив! Операцията не може да бъде извършена!');
    expect((await h.call('GET', `/assets/${assetId}`)).status).toBe(200);
  });

  it('the optional reference carries the САП note when the setting is on', async () => {
    await h.call('PUT', '/settings', { IsOptionalReferenceEnabled: 'True' });
    const { id } = await h.create({ name: 'Бележка', accounting: { note: 'Договор 12', startDate: '2024-12-10', acquisitionDate: '2024-12-10' }, tax: { startDate: '2024-12-10', acquisitionDate: '2024-12-10' } });
    const r = await h.postMonths(id, '2025-01-01', '2025-01-31');
    expect((await h.call('GET', `/entries/${r.posted[0]!.accountingId}`)).body.optionalReference).toBe('Договор 12');
    await h.call('PUT', '/settings', { IsOptionalReferenceEnabled: 'False' });
  });
});

/* ==================================================================== */

describe('improvement, revaluation, conservation, write-off (03b 9-11)', () => {
  const h = harness();
  let fy: Record<number, number> = {};
  beforeAll(async () => {
    await h.init(2025);
    await h.addYear(2026);
    await h.addYear(2027);
    fy = Object.fromEntries(((await h.call('GET', '/years')).body as { id: number; year: number }[]).map((y) => [y.year, y.id]));
    await h.setDate('2025-12-31');
  }, 60_000);
  afterAll(() => h.t.close());

  it('acceptance 10: improvement rules of the plan editor', async () => {
    const { id } = await h.create();
    const noPosting = await h.call('POST', `/assets/${id}/improvements`, { plan: 'accounting', amount: '15000' });
    expect(noPosting.status).toBe(422);
    expect(keys(noPosting)).toEqual(['strAddImprovementInvalidDate']);
    await h.postMonths(id, '2025-04-01', '2025-04-30');
    const low = await h.call('POST', `/assets/${id}/improvements`, { plan: 'accounting', amount: '12000' });
    expect(keys(low)).toEqual(['strAddImprovementInvalidAmount']);
  });

  it('acceptance 19 path B: the plan editor keeps 250.00 and appends Apr 2030 250.00, May 2030 200.00', async () => {
    const { id } = await h.create();
    await h.postMonths(id, '2025-04-01', '2025-12-31');
    const r = await h.call('POST', `/assets/${id}/improvements`, { plan: 'accounting', amount: '15000' });
    expect(r.status, r.text).toBe(200);
    const v = await h.view(id);
    const m = v.accounting.months;
    expect(m).toHaveLength(62);
    expect(m.slice(0, 9).every((x) => x.amount === '200.00' && x.status === 'posted')).toBe(true);
    expect(m.slice(9, 60).every((x) => x.amount === '250.00')).toBe(true);
    expect([m[60]!.month, m[60]!.amount, m[61]!.month, m[61]!.amount]).toEqual(['2030-04-01', '250.00', '2030-05-01', '200.00']);
    expect(v.accounting.endDate).toBe('2030-05-01');
    expect(v.accounting.total).toBe('15000.00');
    expect(v.accounting.improvements.map((i) => [i.date, i.amount])).toEqual([['2025-03-15', '12000.00'], ['2025-12-31', '15000.00']]);
    // Changing the cost by hand while improvements exist asks first.
    const body = h.body({ inventoryNumber: v.inventoryNumber, accounting: { depreciationAmount: '16000' } });
    const ask = await h.call('PUT', `/assets/${id}`, body);
    expect(ask.status).toBe(409);
    expect(ask.body.code).toBe('improvements');
    // Removing the improvement restores the cost.
    expect((await h.call('DELETE', `/assets/${id}/improvements/${v.accounting.improvements[1]!.id}`)).status).toBe(200);
    const v2 = await h.view(id);
    expect(v2.accounting.depreciationAmount).toBe('12000.00');
    expect(v2.accounting.improvements).toEqual([]);
  });

  it('acceptance 19 path A (IAS dialog): 258.82 until Feb 2030, 259.00 in Mar 2030, end unchanged; R7: the synchronised ДАП is untouched', async () => {
    const { id } = await h.create({ synchronized: true });
    await h.postMonths(id, '2025-04-01', '2025-12-31');
    const info = (await h.call('GET', `/assets/${id}/ias`)).body;
    expect(info).toMatchObject({ improvementAmount: '12000.00', newAmount: '10200.00', operationDate: '2025-12-31', accountsDefined: true, isLand: false });
    const low = await h.call('POST', `/assets/${id}/ias`, { mode: 'improvement', amount: '12000' });
    expect(keys(low)).toEqual(['strImprovementAmountIsLessThanAmount']);
    const r = await h.call('POST', `/assets/${id}/ias`, { mode: 'improvement', amount: '15000' });
    expect(r.status, r.text).toBe(200);
    const v = await h.view(id);
    const m = v.accounting.months;
    expect(m).toHaveLength(60);
    expect(m.slice(9, 59).every((x) => x.amount === '258.82')).toBe(true);
    expect([m[59]!.month, m[59]!.amount]).toEqual(['2030-03-01', '259.00']);
    expect(v.accounting.endDate).toBe('2030-03-01');
    expect(v.accounting.improvements.map((i) => [i.date, i.amount])).toEqual([['2025-03-15', '12000.00'], ['2025-12-31', '15000.00']]);
    expect(v.tax.depreciationAmount).toBe('12000.00');
    expect(v.tax.total).toBe('12000.00');
    // Saving the form afterwards copies the synchronised САП (15 000) into the ДАП; the САП keeps its IAS schedule.
    const body = h.body({ inventoryNumber: v.inventoryNumber, synchronized: true, accounting: { depreciationAmount: '15000' } });
    const saved = await h.call('PUT', `/assets/${id}`, body);
    expect(saved.status, saved.text).toBe(200);
    const v2 = await h.view(id);
    expect([v2.tax.depreciationAmount, v2.tax.total]).toEqual(['15000.00', '15000.00']);
    expect(v2.accounting.months[59]!.amount).toBe('259.00');
  });

  it('acceptance 20 / E: conservation 01.07.2026-01.07.2027 leaves 12 months empty and ends on 01.03.2031; E′ without posting is Critical', async () => {
    await h.setDate('2026-06-30');
    await h.t.reloadAccounts();
    const nothing = await h.call('POST', '/assets', h.body({ accounting: { conservation: { start: '2026-07-01', end: '2027-07-01' } } }));
    expect(nothing.status).toBe(422);
    expect(keys(nothing)).toContain('strAccountingDepreciationInvalidConservationPeriod');
    // Plan A with Apr 2025 - Jun 2026 accrued (3 000.00 entered as accrued-to-date).
    const created = await h.create({ accounting: { manualAccrued: { date: '2026-06-30', amount: '3000' } } });
    const v0 = await h.view(created.id);
    expect(v0.accounting.months.filter((x) => x.isProcessed)).toHaveLength(15);
    expect(v0.accounting.accrued).toBe('3000.00');
    const body = { ...created.body, accounting: { ...created.body.accounting, manualAccrued: null, conservation: { start: '2026-07-01', end: '2027-07-01' } } };
    const r = await h.call('PUT', `/assets/${created.id}`, body);
    expect(r.status, r.text).toBe(200);
    const v = await h.view(created.id);
    const m = v.accounting.months;
    expect(m).toHaveLength(60);
    expect(m.some((x) => x.month >= '2026-07-01' && x.month < '2027-07-01')).toBe(false);
    expect([2025, 2026, 2027, 2028, 2031].map((y) => h.yearSum(m, y))).toEqual(['1800.00', '1200.00', '1200.00', '2400.00', '600.00']);
    expect(v.accounting.endDate).toBe('2031-03-01');
    // Reactivation: unticking regenerates the plan without the window.
    const back = await h.call('PUT', `/assets/${created.id}`, { ...body, accounting: { ...body.accounting, conservation: null } });
    expect(back.status).toBe(200);
    expect((await h.view(created.id)).accounting.endDate).toBe('2030-03-01');
  });

  it('acceptance 14 / 9.3a: impairment 6 000 -> 5 000 posts Dt 631 1 000 / Kt U, slot -1 000, 30 months of 166.66 + 166.86', async () => {
    await h.setDate('2026-06-30');
    const base = { depreciationAmount: '10000', startDate: '2024-10-15', acquisitionDate: '2024-10-15', activePeriodLength: 50 };
    const created = await h.create({ name: 'Преса', inventoryAccountId: h.acc('203'), accounting: { ...base, manualAccrued: { date: '2026-06-30', amount: '4000' } }, tax: base });
    const id = created.id;
    // A prior memorial order of 2026 (monthly posting) to check "last memorial number + 1".
    const other = await h.create({ accounting: { startDate: '2025-12-10', acquisitionDate: '2025-12-10' }, tax: { startDate: '2025-12-10', acquisitionDate: '2025-12-10' } });
    const prior = await h.postMonths(other.id, '2026-01-01', '2026-01-31');
    expect(prior.posted[0]!.documentNumber).toBe('0000000001');
    const info = (await h.call('GET', `/assets/${id}/ias`)).body;
    expect(info).toMatchObject({ newAmount: '6000.00', operationDate: '2026-06-30' });
    const tooHigh = await h.call('POST', `/assets/${id}/ias`, { mode: 'revaluation', amount: '7000', withPosting: true, accountId: h.acc('291') });
    expect(keys(tooHigh)).toEqual(['strAmountIsLessThanRevaluationReserve']);
    expect(tooHigh.body.error).toBe('Внимание! Въведената стойност на преоценка на ДА превишава първоначалната му отчетна стойност. Операцията не може да бъде извършена.');
    expect(keys(await h.call('POST', `/assets/${id}/ias`, { mode: 'revaluation', amount: '0', withPosting: true, accountId: h.acc('291') }))).toEqual(['strAmountIsLessThanRevaluationReserve']);
    expect(keys(await h.call('POST', `/assets/${id}/ias`, { mode: 'revaluation', amount: '-1', withPosting: true, accountId: h.acc('291') }))).toEqual(['strNegativeRevaluationReserve']);
    // Acceptance 17: nothing was written by the refusals.
    expect((await h.view(id)).revaluationReserve).toBe('0.00');
    const r = await h.call('POST', `/assets/${id}/ias`, { mode: 'revaluation', amount: '5000', withPosting: true, accountId: h.acc('291') });
    expect(r.status, r.text).toBe(200);
    expect(r.body.nrr).toBe('-1000.00');
    const e = (await h.call('GET', `/entries/${r.body.accountingId}`)).body;
    expect(e.accountingDate).toBe('2026-06-30');
    expect(e.term).toBe('Преоценка по МСС');
    expect(e.documentNumber).toBe('0000000002');
    expect(e.debits).toEqual([expect.objectContaining({ accountId: h.acc('631'), amount: '1000.00' })]);
    expect(e.credits).toEqual([expect.objectContaining({ accountId: h.acc('291'), amount: '1000.00' })]);
    const v = await h.view(id);
    expect(v.revaluationReserve).toBe('-1000.00');
    expect(v.accounting.years.find((y) => y.year === 2026)!.revaluationReserve).toBe('-1000.00');
    const after = v.accounting.months.filter((x) => x.month >= '2026-07-01');
    expect(after).toHaveLength(30);
    expect(after.slice(0, 29).every((x) => x.amount === '166.66')).toBe(true);
    expect(after[29]!.amount).toBe('166.86');
    expect(v.accounting.endDate).toBe('2028-12-01');
    expect(v.tax.total).toBe('10000.00');
    (globalThis as Record<string, unknown>).impairedId = id;
  });

  it('acceptance 18 / 9.3b: reversal of 600 in 2027: Dt U 600 / Kt 731 600, slot +600, total -400, 23 months of 192.75 + 192.88', async () => {
    const id = (globalThis as Record<string, unknown>).impairedId as number;
    await h.postMonths(id, '2026-07-01', '2026-12-31');
    await h.setDate('2027-01-31');
    await h.postMonths(id, '2027-01-01', '2027-01-31');
    const info = (await h.call('GET', `/assets/${id}/ias`)).body;
    expect(info.newAmount).toBe('4833.38');
    expect(info.operationDate).toBe('2027-01-31');
    const r = await h.call('POST', `/assets/${id}/ias`, { mode: 'revaluation', amount: '5433.38', withPosting: true, accountId: h.acc('291') });
    expect(r.status, r.text).toBe(200);
    expect([r.body.nrr, r.body.totalReserve]).toEqual(['600.00', '-400.00']);
    const e = (await h.call('GET', `/entries/${r.body.accountingId}`)).body;
    expect(e.debits).toEqual([expect.objectContaining({ accountId: h.acc('291'), amount: '600.00' })]);
    expect(e.credits).toEqual([expect.objectContaining({ accountId: h.acc('731'), amount: '600.00' })]);
    const v = await h.view(id);
    expect(v.accounting.years.find((y) => y.year === 2027)!.revaluationReserve).toBe('600.00');
    expect(v.revaluationReserve).toBe('-400.00');
    const after = v.accounting.months.filter((x) => x.month >= '2027-02-01');
    expect(after).toHaveLength(23);
    expect(after[0]!.amount).toBe('192.75');
    expect(after[22]!.amount).toBe('192.88');
    expect(v.accounting.endDate).toBe('2028-12-01');
  });

  it('R2 (defect D1 compatible): a second operation in the same year posts |NRR| and overwrites the slot', async () => {
    await h.setDate('2026-06-30');
    const base = { depreciationAmount: '10000', startDate: '2024-10-15', acquisitionDate: '2024-10-15', activePeriodLength: 50 };
    const { id } = await h.create({ accounting: { ...base, manualAccrued: { date: '2026-06-30', amount: '4000' } }, tax: base });
    const a = await h.call('POST', `/assets/${id}/ias`, { mode: 'revaluation', amount: '5000', withPosting: true, accountId: h.acc('291') });
    const b = await h.call('POST', `/assets/${id}/ias`, { mode: 'revaluation', amount: '4500', withPosting: true, accountId: h.acc('291') });
    expect(b.status, b.text).toBe(200);
    const amountOf = async (aid: number) => (await h.call('GET', `/entries/${aid}`)).body.debits[0].amount;
    expect([await amountOf(a.body.accountingId), await amountOf(b.body.accountingId)]).toEqual(['1000.00', '1500.00']);
    const v = await h.view(id);
    expect(v.accounting.years.find((y) => y.year === 2026)!.revaluationReserve).toBe('-1500.00');
    expect(v.revaluationReserve).toBe('-1500.00');
    const hist = (await h.call('GET', `/assets/${id}/ias`)).body.reserves;
    expect(hist).toEqual([{ date: '2026-06-30', amount: '4500.00' }]);
  });

  it('R3 (defect D6 corrected): a revaluation in a locked month is refused and nothing changes; R4: zero is refused', async () => {
    const base = { depreciationAmount: '10000', startDate: '2024-10-15', acquisitionDate: '2024-10-15', activePeriodLength: 50 };
    const { id } = await h.create({ accounting: { ...base, manualAccrued: { date: '2026-06-30', amount: '4000' } }, tax: base });
    const zero = await h.call('POST', `/assets/${id}/ias`, { mode: 'revaluation', amount: '6000', withPosting: true, accountId: h.acc('291') });
    expect(keys(zero)).toEqual(['strZeroReevaluationSumError']);
    await h.call('PUT', `/years/${fy[2026]}/locks`, { months: [6] });
    const r = await h.call('POST', `/assets/${id}/ias`, { mode: 'revaluation', amount: '5000', withPosting: true, accountId: h.acc('291') });
    expect(r.status).toBe(422);
    await h.call('PUT', `/years/${fy[2026]}/locks`, { months: [] });
    const v = await h.view(id);
    expect(v.revaluationReserve).toBe('0.00');
    expect((await h.call('GET', `/assets/${id}/ias`)).body.reserves).toEqual([]);
    // "Без операция": the reserve changes without a posting.
    const noPost = await h.call('POST', `/assets/${id}/ias`, { mode: 'revaluation', amount: '5500', withPosting: false });
    expect(noPost.body.accountingId).toBeNull();
    expect((await h.view(id)).revaluationReserve).toBe('-500.00');
  });

  it('acceptance 12: Expired with a SAP date before the EndDate month is refused', async () => {
    await h.setDate('2026-06-15');
    const { id } = await h.create();
    const r = await h.call('POST', `/assets/${id}/terminate`, { type: 5, sapDate: '2026-06-15', dapDate: '2026-06-15', operationAccountId: h.acc('609') });
    expect(r.status).toBe(422);
    expect(r.body.messages).toContainEqual(expect.objectContaining({
      key: 'strInvalidAssetExpiredOperationSelected',
      text: 'Балансовата стойност на актива е по-голяма от 0 (дата на изхабяване 01.03.2030). Активът не може да бъде отписан с операция изхабяване',
    }));
    const otherYear = await h.call('POST', `/assets/${id}/terminate`, { type: 2, sapDate: '2025-06-15', dapDate: '2026-06-15' });
    expect(keys(otherYear)).toEqual(['strInvalidAssetTerminationDateSAP_AccountingYear']);
    const noAccount = await h.call('POST', `/assets/${id}/terminate`, { type: 3, sapDate: '2026-06-15', dapDate: '2026-06-15' });
    expect(keys(noAccount)).toEqual(['strInvalidAssetWasteOperationAccount']);
    const sold = await h.call('POST', `/assets/${id}/terminate`, { type: 4, sapDate: '2026-06-15', dapDate: '2026-06-15', operationAccountId: h.acc('609') });
    expect(keys(sold)).toEqual(['strInvalidAssetProfitAmount']);
  });

  it('acceptance 11: wasted write-off of 12 000 with 7 200 accrued; locked asset; restore keeps the entry', async () => {
    await h.setDate('2026-06-15');
    const { id, body } = await h.create({ accounting: { manualAccrued: { date: '2028-03-31', amount: '7200' } } });
    const r = await h.call('POST', `/assets/${id}/terminate`, { type: 3, sapDate: '2026-06-15', dapDate: '2026-06-15', operationAccountId: h.acc('609') });
    expect(r.status, r.text).toBe(200);
    const e = (await h.call('GET', `/entries/${r.body.accountingId}`)).body;
    expect(e.term).toBe('Бракуване на дълготраен актив');
    expect(e.reference).toBe(`Машина, Инв. номер ${body.inventoryNumber}`);
    expect(e.debits).toEqual([expect.objectContaining({ accountId: h.acc('241/2'), amount: '7200.00' }), expect.objectContaining({ accountId: h.acc('609'), amount: '4800.00' })]);
    expect(e.credits).toEqual([expect.objectContaining({ accountId: h.acc('203'), amount: '12000.00' })]);
    const v = await h.view(id);
    expect(v.isTerminated).toBe(true);
    expect(v.accounting.finalDate).toBe('2026-06-15');
    const edit = await h.call('PUT', `/assets/${id}`, body);
    expect(edit.status).toBe(400);
    expect(edit.body.error).toBe('Избраният дълготраен актив не може да бъде редактиран, тъй като е отписан!');
    expect((await h.call('POST', `/assets/${id}/restore`)).status).toBe(200);
    const v2 = await h.view(id);
    expect([v2.isTerminated, v2.accounting.finalDate, v2.tax.finalDate, v2.terminationAccountingId]).toEqual([false, null, null, null]);
    expect((await h.call('GET', `/entries/${r.body.accountingId}`)).status).toBe(200);
  });

  it('acceptance 21 / 22: defaults and a mid-month wasted write-off (Plan A shifted by one year)', async () => {
    await h.setDate('2026-12-31');
    const { id } = await h.create({ accounting: { startDate: '2026-03-15', acquisitionDate: '2026-03-15' }, tax: { startDate: '2026-03-15', acquisitionDate: '2026-03-15' } });
    await h.postMonths(id, '2026-04-01', '2026-12-31');
    await h.setDate('2027-06-15');
    await h.postMonths(id, '2027-01-01', '2027-05-31');
    const d = (await h.call('GET', `/assets/${id}/terminate`)).body;
    expect(d).toMatchObject({ sapDate: '2027-05-31', dapDate: '2027-05-01', operation: 2, accrued: '2800.00' });
    const r = await h.call('POST', `/assets/${id}/terminate`, { type: 3, sapDate: '2027-06-15', dapDate: d.dapDate, operationAccountId: h.acc('609') });
    expect(r.status, r.text).toBe(200);
    const e = (await h.call('GET', `/entries/${r.body.accountingId}`)).body;
    expect(e.accountingDate).toBe('2027-06-15');
    expect(e.debits.map((l: { amount: string }) => l.amount)).toEqual(['2800.00', '9200.00']);
    expect(e.credits[0].amount).toBe('12000.00');
    const june = () => h.pending({ from: '2027-06-01', to: '2027-06-30' }).then((p) => p.rows.filter((x) => x.assetId === id));
    expect(await june()).toHaveLength(0);
    const v = await h.view(id);
    expect(v.accounting.months.find((m) => m.month === '2027-06-01')).toMatchObject({ amount: '200.00', isProcessed: false });
    expect(v.tax.finalDate).toBe('2027-05-01');
    await h.call('POST', `/assets/${id}/restore`);
    expect(await june()).toHaveLength(1);
  });

  it('expired write-off with residual and a revalued wasted write-off (11.3)', async () => {
    await h.setDate('2027-06-15');
    const exp = await h.create({ accounting: { depreciationAmount: '12000', nonDepreciableAmount: '1000', manualAccrued: { date: '2027-03-31', amount: '11000' }, startDate: '2022-03-15', acquisitionDate: '2022-03-15' }, tax: { startDate: '2022-03-15', acquisitionDate: '2022-03-15' } });
    const v = await h.view(exp.id);
    expect(v.accounting.endDate).toBe('2027-03-01');
    const r = await h.call('POST', `/assets/${exp.id}/terminate`, { type: 5, sapDate: '2027-06-15', dapDate: '2027-06-15', operationAccountId: h.acc('609') });
    expect(r.status, r.text).toBe(200);
    const e = (await h.call('GET', `/entries/${r.body.accountingId}`)).body;
    expect(e.term).toBe('Изхабяване на дълготраен актив');
    expect(e.debits.map((l: { amount: string }) => l.amount)).toEqual(['11000.00', '1000.00']);
    // "Без операция": no posting at all.
    const plain = await h.create();
    const none = await h.call('POST', `/assets/${plain.id}/terminate`, { type: 2, sapDate: '2027-06-15', dapDate: '2027-06-15' });
    expect(none.body.accountingId).toBeNull();
    expect((await h.view(plain.id)).terminationStatusId).toBe(2);
  });

  it('a revalued asset needs a revaluation account; the entry debits it with the reserve', async () => {
    await h.setDate('2027-01-31');
    const { id } = await h.create({ accounting: { manualAccrued: { date: '2027-01-31', amount: '4400' } } });
    const ias = await h.call('POST', `/assets/${id}/ias`, { mode: 'revaluation', amount: '6600', withPosting: false });
    expect(ias.status, ias.text).toBe(200);
    expect(keys(await h.call('POST', `/assets/${id}/terminate`, { type: 3, sapDate: '2027-02-15', dapDate: '2027-02-15', operationAccountId: h.acc('609') }))).toEqual(['strMissingRevaluationAccount']);
    const r = await h.call('POST', `/assets/${id}/terminate`, { type: 3, sapDate: '2027-02-15', dapDate: '2027-02-15', operationAccountId: h.acc('609'), revaluationAccountId: h.acc('291') });
    expect(r.status, r.text).toBe(200);
    const e = (await h.call('GET', `/entries/${r.body.accountingId}`)).body;
    // cost 12 000, accrued 4 400, reserve -1 000: Dt 241 4 400, Dt 609 6 600, Dt 291 1 000, Kt 203 12 000.
    expect(e.debits.map((l: { accountId: number; amount: string }) => [l.accountId, l.amount])).toEqual([[h.acc('241/2'), '4400.00'], [h.acc('609'), '6600.00'], [h.acc('291'), '1000.00']]);
  });
});

/* ==================================================================== */

describe('R1: remainder month, method label and the tail stub (5.4, D3, D4)', () => {
  const h = harness();
  beforeAll(async () => {
    await h.init(2025);
    await h.setDate('2025-06-30');
  }, 60_000);
  afterAll(() => h.t.close());

  it('35 x 27.77 + 28.05 "Потребителски"; after posting Feb-Jun and ticking/unticking conservation a 37th row of 0.28', async () => {
    const p = { depreciationAmount: '1000', startDate: '2025-01-10', acquisitionDate: '2025-01-10', activePeriodLength: 36 };
    const { id, body } = await h.create({ inventoryAccountId: h.acc('204'), debitAccountId: h.acc('241/4'), accounting: p, tax: p });
    const v = await h.view(id);
    expect(v.accounting.months).toHaveLength(36);
    expect(v.accounting.methodId).toBe(2);
    await h.postMonths(id, '2025-02-01', '2025-06-30');
    // Ticking and unticking "Консервиране" regenerates the plan (the client marks it).
    const r = await h.call('PUT', `/assets/${id}`, { ...body, accounting: { ...body.accounting, regenerate: true } });
    expect(r.status, r.text).toBe(200);
    const v2 = await h.view(id);
    const m = v2.accounting.months;
    expect(m).toHaveLength(37);
    expect([m[35]!.month, m[35]!.amount, m[36]!.month, m[36]!.amount]).toEqual(['2028-01-01', '27.77', '2028-02-01', '0.28']);
    expect(v2.accounting.endDate).toBe('2028-02-01');
    expect(v2.accounting.total).toBe('1000.00');
    expect(m.slice(0, 5).every((x) => x.status === 'posted')).toBe(true);
  });

  it('saving without touching the schedule keeps it as it is', async () => {
    const list = (await h.call('GET', '/assets')).body as { id: number }[];
    const v = await h.view(list[0]!.id);
    const body = h.body({
      inventoryNumber: v.inventoryNumber, inventoryAccountId: h.acc('204'), debitAccountId: h.acc('241/4'),
      accounting: { depreciationAmount: '1000', startDate: '2025-01-10', acquisitionDate: '2025-01-10', activePeriodLength: 36 },
      tax: { depreciationAmount: '1000', startDate: '2025-01-10', acquisitionDate: '2025-01-10', activePeriodLength: 36 },
      name: 'Преименувана',
    });
    expect((await h.call('PUT', `/assets/${v.id}`, body)).status).toBe(200);
    expect((await h.view(v.id)).accounting.months).toHaveLength(37);
  });
});

/* ==================================================================== */

describe('EUR changeover (03b 13, acceptance 15)', () => {
  const h = harness();
  let bgnId: number;
  beforeAll(async () => {
    await h.init(2025);
    await h.setDate('2025-12-31');
  }, 60_000);
  afterAll(() => h.t.close());

  it('a BGN asset with 9 posted months gets an EUR copy: 6 135.50, processed rows without postings, accrued 920.33', async () => {
    bgnId = (await h.create({ inventoryNumber: '0000000001' })).id;
    await h.postMonths(bgnId, '2025-04-01', '2025-12-31');
    await h.addYear(2026);
    await h.setDate('2026-01-15');
    expect((await h.call('GET', '/assets')).body).toEqual([]);
    const r = await h.call('POST', '/assets/euro-conversion');
    expect(r.status, r.text).toBe(200);
    expect(r.body.created).toHaveLength(1);
    const list = (await h.call('GET', '/assets')).body as { id: number; inventoryNumber: string; cost: string; accrued: string; inventoryAccount: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ inventoryNumber: '0000000001', cost: '6135.50', accrued: '920.33', inventoryAccount: '203' });
    const v = await h.view(list[0]!.id);
    const m = v.accounting.months;
    expect(m[0]!.amount).toBe('102.26');
    expect(m[8]!.amount).toBe('102.25');
    expect(m.filter((x) => x.isProcessed)).toHaveLength(9);
    expect(m.every((x) => x.accountingId === null)).toBe(true);
    expect(m.find((x) => x.month === '2026-12-01')!.amount).toBe('102.24');
    expect(v.accounting.total).toBe('6135.50');
    // The EUR copy may reuse the BGN inventory number; running again creates nothing.
    expect((await h.call('POST', '/assets/euro-conversion')).body.created).toHaveLength(0);
    // The EUR copy posts into the EUR chart from January 2026.
    const p = await h.postMonths(list[0]!.id, '2026-01-01', '2026-01-31');
    expect(p.posted).toHaveLength(1);
    const e = (await h.call('GET', `/entries/${p.posted[0]!.accountingId}`)).body;
    expect(e.debits[0]).toMatchObject({ accountId: h.acc('603'), amount: '102.26' });
  });
});

/* ==================================================================== */

describe('reconciliation, reports, protocols, bulk change (03b 14-15, 05 7.10)', () => {
  const h = harness();
  let a: number;
  let b: number;
  beforeAll(async () => {
    await h.init(2025);
    await h.setDate('2025-12-31');
    const loc = await h.call('POST', '/asset-locations', { name: 'Цех', parentId: 1 });
    a = (await h.create({ name: 'Машина А', personInCharge: 'Иван Петров', locationId: loc.body.id, accounting: { serialNumber: 'SN-1', note: 'Цех 1' } })).id;
    b = (await h.create({
      name: 'Компютър Б', personInCharge: 'Мария Иванова', categoryId: 4, inventoryAccountId: h.acc('207'), debitAccountId: h.acc('241/6'),
      accounting: { depreciationAmount: '2400', startDate: '2025-06-10', acquisitionDate: '2025-06-10', activePeriodLength: 24 },
      tax: { depreciationAmount: '2400', startDate: '2025-06-10', acquisitionDate: '2025-06-10', annualRate: '50' },
    })).id;
    await h.postMonths(a, '2025-04-01', '2025-12-31');
    await h.postMonths(b, '2025-07-01', '2025-12-31');
  }, 60_000);
  afterAll(() => h.t.close());

  it('acceptance 16: mismatching accounts are listed; the all-OK info after booking the costs', async () => {
    const r = (await h.call('GET', '/assets/check?from=2025-01-01&to=2025-12-31')).body;
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([
      { kind: 'cost', account: '203', assets: '12000.00', balance: '0.00', difference: '12000.00' },
      { kind: 'cost', account: '207', assets: '2400.00', balance: '0.00', difference: '2400.00' },
    ]);
    expect(r.lines[0]).toBe('Несъответствие между отчетната стойност на активите и салдата на сметките:');
    await h.t.post({ date: '2025-03-15', dr: [['203', 12000]], cr: [['101', 12000]] });
    await h.t.post({ date: '2025-06-10', dr: [['207', 2400]], cr: [['101', 2400]] });
    const ok = (await h.call('GET', '/assets/check?from=2025-01-01&to=2025-12-31')).body;
    expect(ok).toMatchObject({ ok: true, lines: ['Всички дълготрайни активи и амортизационни отчисления са отразени коректно в счетоводството.'] });
  });

  it('Месечни амортизационни квоти: one row per year with January..December', async () => {
    const r = (await h.call('GET', '/reports/assets/quotas?year=2025&type=sap')).body;
    const ma = r.assets.find((x: { id: number }) => x.id === a);
    expect(ma.years).toHaveLength(1);
    expect(ma.years[0].months).toEqual(['0.00', '0.00', '0.00', '200.00', '200.00', '200.00', '200.00', '200.00', '200.00', '200.00', '200.00', '200.00']);
    expect(ma.years[0]).toMatchObject({ total: '1800.00', before: '0.00', bookValue: '10200.00' });
    expect(r.total).toBe('2400.00');
    const all = (await h.call('GET', '/reports/assets/quotas?type=dap')).body;
    expect(all.assets.find((x: { id: number }) => x.id === a).years.map((y: { year: number; total: string }) => [y.year, y.total])).toEqual([[2025, '3000.00'], [2026, '3600.00'], [2027, '3600.00'], [2028, '1800.00']]);
  });

  it('Инвентарна книга: accrued processed rows, ActiveYears, filters', async () => {
    const r = (await h.call('GET', '/reports/assets/inventory-book?toDate=2025-12-31')).body;
    const row = r.rows.find((x: { id: number }) => x.id === a);
    expect(row).toMatchObject({ cost: '12000.00', accrued: '1800.00', bookValue: '10200.00', activeYears: 5, endDate: '2030-03-01', serialNumber: 'SN-1', location: 'Тест ООД / Цех' });
    expect((await h.call('GET', '/reports/assets/inventory-book?toDate=2025-12-31&account=207')).body.rows).toHaveLength(1);
    expect((await h.call('GET', '/reports/assets/inventory-book?toDate=2025-12-31&mol=Мария')).body.rows).toHaveLength(1);
    expect((await h.call('GET', '/reports/assets/inventory-book?toDate=2025-12-31&serialNumber=sn-')).body.rows).toHaveLength(1);
  });

  it('Амортизационен план: САП counts processed rows, ДАП every row', async () => {
    const sap = (await h.call('GET', '/reports/assets/plan?month=2025-12-01&type=sap')).body;
    expect(sap.rows.find((x: { id: number }) => x.id === a)).toMatchObject({ accrued: '1800.00', currentYear: '1800.00', percentage: '20.00', remainder: '10200.00', yearQuota: '1800.00', monthQuota: '200.00' });
    const dap = (await h.call('GET', '/reports/assets/plan?month=2025-12-01&type=dap')).body;
    expect(dap.rows.find((x: { id: number }) => x.id === a)).toMatchObject({ accrued: '3000.00', percentage: '30.00' });
    const june = (await h.call('GET', '/reports/assets/plan?month=2025-05-01&type=sap')).body;
    expect(june.rows.some((x: { id: number }) => x.id === b)).toBe(false);
    const sorted = (await h.call('GET', '/reports/assets/plan?month=2025-12-01&type=sap&sort=name')).body.rows.map((x: { name: string }) => x.name);
    expect(sorted).toEqual(['Компютър Б', 'Машина А']);
  });

  it('Активи по категории (ДАП): per asset and per category', async () => {
    const r = (await h.call('GET', '/reports/assets/by-categories?year=2025')).body;
    expect(r.categories.map((c: { categoryId: number; totalValue: string; totalDepreciations: string; currentYear: string }) => [c.categoryId, c.totalValue, c.totalDepreciations, c.currentYear]))
      .toEqual([[2, '12000.00', '3000.00', '3000.00'], [4, '2400.00', '700.00', '700.00']]);
    expect(r.totals.totalValue).toBe('14400.00');
  });

  it('Инвентаризационен опис на ДМА: grouped by МОЛ; allowed for a non-admin (R5)', async () => {
    const r = (await h.call('GET', '/reports/assets/inventory-mol?date=2025-12-31')).body;
    expect(r.groups.map((g: { personInCharge: string; rows: unknown[] }) => [g.personInCharge, g.rows.length])).toEqual([['Иван Петров', 1], ['Мария Иванова', 1]]);
    expect(r.groups[0].rows[0]).toMatchObject({ accrued: '1800.00', cost: '12000.00' });
    expect(r.mols).toEqual(['Иван Петров', 'Мария Иванова']);
    const u = await h.call('POST', '/users', { name: 'Оператор', password: 'parola1', roleId: 5 });
    const admin = h.t.session.get();
    const companies = (await h.call('GET', '/companies')).body;
    h.t.session.set('');
    expect((await h.call('POST', '/login', { companyDb: companies[0].name, userId: u.body.id, password: 'parola1' })).status).toBe(200);
    expect((await h.call('GET', '/reports/assets/inventory-mol?date=2025-12-31')).status).toBe(200);
    expect((await h.call('GET', '/reports/assets/inventory-book?toDate=2025-12-31')).status).toBe(200);
    h.t.session.set(admin);
  });

  it('protocols: чл. 58 ЗКПО and scrapping', async () => {
    const p58 = (await h.call('GET', `/assets/protocol58?ids=${a}`)).body;
    expect(p58.companyName).toBe('Тест ООД');
    expect(p58.rows[0]).toMatchObject({ dateOfCommissioning: '2025-03-15', depreciableAmount: '12000.00', currency: 'BGN', percentage: '30.00', accountNumber: '203', category: 'II - Машини, оборудване', location: 'Тест ООД / Цех' });
    const sc = (await h.call('GET', `/assets/scrapping-protocol?ids=${a},${b}`)).body;
    expect(sc.rows).toHaveLength(2);
    expect(sc.rows[0]).toMatchObject({ depreciationAmount: '12000.00', dateOfCommissioning: '2025-03-15', terminationDate: null });
    const card = (await h.call('GET', `/assets/${a}/card?date=2025-12-31`)).body;
    expect(card.accounting).toMatchObject({ accrued: '1800.00', toDate: '2025-12-31' });
  });

  it('bulk change of common data (14.3): MOL and САП rate from 1 January with a protocol', async () => {
    const bad = await h.call('POST', '/assets/common-data', { ids: [a], sapRate: '60' });
    expect(keys(bad)).toEqual(['strPercentageMoreThanFifty']);
    expect(keys(await h.call('POST', '/assets/common-data', { ids: [a], sapRate: '0' }))).toEqual(['strPercentageEqualsZero']);
    const dry = (await h.call('POST', '/assets/common-data', { ids: [a, b], mol: 'Нов МОЛ', sapRate: '25' })).body;
    expect(dry.applied).toBe(false);
    expect(dry.warnings[0].text).toBe('Внимание! Към следните активи има начислени амортизации през текущата година:');
    expect(dry.confirmations[0]).toBe('Внимание! Ще бъде променена годишната норма в счетоводния амортизационен план на избраните активи от 01.01.2025г. Желаете ли да продължите?');
    const done = (await h.call('POST', '/assets/common-data', { ids: [a], mol: 'Нов МОЛ', sapRate: '25', confirm: true })).body;
    expect(done.applied).toBe(true);
    expect(done.protocol.map((p: { kind: string; from: string; to: string }) => [p.kind, p.from, p.to])).toEqual([['mol', 'Иван Петров', 'Нов МОЛ'], ['sap', '20', '25']]);
    const v = await h.view(a);
    expect(v.accounting.months.find((m) => m.month === '2025-04-01')).toMatchObject({ amount: '250.00', isProcessed: false, accountingId: null });
    expect(v.accounting.total).toBe('12000.00');
    const list = (await h.call('GET', `/assets?mol=Нов МОЛ`)).body;
    expect(list).toHaveLength(1);
  });
});
