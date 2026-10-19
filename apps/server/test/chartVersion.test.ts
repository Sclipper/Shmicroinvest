import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CHART_TEMPLATE_VERSION, CHART_TEMPLATE_VERSION_KEY, chartTemplateAccounts, dec } from '@shmi/core';
import { createTestCompany, type TestCompany } from './helpers.ts';
import { rebuildAccountsTree } from '../src/services/chart.ts';

/**
 * Chart template versions (ChartTemplateVersion): a company created before the
 * commercial template was renumbered keeps its numbering through F4, "Избор
 * на сметкоплан" and the 2026 EUR chart.
 */
let t: TestCompany;
let call: TestCompany['call'];
const yearId: Record<number, number> = {};
const RATE = '1.95583';

/** Replaces the company's BGN chart with the version 1 commercial template and forgets the stored version: a company of the old numbering. */
async function makeOldCompany(c: TestCompany) {
  const db = await c.driver.company(c.companyDb);
  await db.execute(sql`DELETE FROM configuration WHERE key = ${CHART_TEMPLATE_VERSION_KEY}`);
  await db.execute(sql`DELETE FROM company_accounts`);
  await db.execute(sql`UPDATE accounts SET mapped_account_id = NULL, conclude_account_id = NULL`);
  await db.execute(sql`DELETE FROM accounts WHERE number <> '0'`);
  for (const a of chartTemplateAccounts('commercial', 1)) {
    await db.execute(sql`
      INSERT INTO accounts (parent_id, number, description, account_category_id, currency_id, is_active, is_euro)
      SELECT p.id, ${a.number}, ${a.description}, ${a.categoryId}, p.currency_id, ${a.isActive}, false
      FROM accounts p WHERE NOT p.is_euro AND p.number = ${a.parentNumber}`);
  }
  await rebuildAccountsTree(db);
  await c.reloadAccounts();
}

beforeAll(async () => {
  t = await createTestCompany({ year: 2025, companyName: 'Стара номерация ООД' });
  call = t.call;
  await makeOldCompany(t);
  for (const y of (await call('GET', '/years')).body as { id: number; year: number }[]) yearId[y.year] = y.id;
}, 60_000);
afterAll(() => t.close());

const accounts = async () => (await call('GET', '/accounts')).body as { id: number; number: string; description: string }[];

describe('chart template version (old companies)', () => {
  it('a new company stores the current version; the old chart is detected as version 1', async () => {
    const fresh = await createTestCompany({ year: 2025, companyName: 'Нова ООД' });
    try {
      expect((await fresh.call('GET', '/session')).body.chartTemplateVersion).toBe(CHART_TEMPLATE_VERSION);
      const db = await fresh.driver.company(fresh.companyDb);
      const rows = ((await db.execute(sql`SELECT value FROM configuration WHERE key = ${CHART_TEMPLATE_VERSION_KEY}`)) as unknown as { rows: { value: string }[] }).rows;
      expect(rows.map((r) => r.value)).toEqual([String(CHART_TEMPLATE_VERSION)]);
    } finally {
      await fresh.close();
    }
    expect((await call('GET', '/session')).body.chartTemplateVersion).toBe(1);
    expect((await accounts()).find((a) => a.number === '202')?.description).toBe('Сгради и конструкции');
  });

  it('F4 and "Избор на сметкоплан" offer the accounts of the old numbering', async () => {
    // 209 is "Подобрения върху земи" in version 1 and "Други ДМА" in version 2.
    expect((await call('DELETE', `/accounts/${t.acc('209')}`)).status).toBe(200);
    const f4 = (await call('GET', '/accounts/templates?q=209')).body as { number: string; description: string }[];
    expect(f4.find((a) => a.number === '209')?.description).toBe('Подобрения върху земи');
    // Version 2 only accounts (241/8 "Амортизация на офис обзавеждане") are not offered.
    expect(((await call('GET', '/accounts/templates?q=241')).body as { number: string }[]).map((a) => a.number)).not.toContain('241/8');
    const r = await call('POST', '/accounts/template', { type: 'commercial', numbers: ['209'] });
    expect([r.status, r.body.added]).toEqual([200, 1]);
    expect((await accounts()).find((a) => a.number === '209')?.description).toBe('Подобрения върху земи');
    expect((await accounts()).some((a) => a.number === '241/8')).toBe(false);
    await t.reloadAccounts();
  });

  it('reaching 2026 seeds the EUR chart from the BGN chart: balances land on accounts of the same meaning', async () => {
    // 202 Сгради, 203 Машини, 241/1 Амортизация на сгради (version 1).
    await t.post({ date: '2025-03-01', dr: [['202', '10000.00']], cr: [['101', '10000.00']] });
    await t.post({ date: '2025-04-01', dr: [['203', '5000.00']], cr: [['101', '5000.00']] });
    await t.post({ date: '2025-12-31', dr: [['101', '1955.83']], cr: [['241/1', '1955.83']] });
    const done = await call('POST', `/years/${yearId[2025]}/conclude`, {});
    expect(done.status, done.text).toBe(200);
    expect((await call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
    const eur = await accounts();
    const desc = (n: string) => eur.find((a) => a.number === n)?.description;
    // The EUR chart is the BGN chart's copy, not the version 2 template (where 202 = "Подобрения върху земи").
    expect([desc('202'), desc('203'), desc('241/1'), desc('209')]).toEqual(['Сгради и конструкции', 'Машини, производствено оборудване и апаратура', 'Амортизация на сгради', 'Подобрения върху земи']);
    expect(desc('241/8')).toBeUndefined();
    const tb = (await call('GET', '/reports/trial-balance?from=2026-01-01&to=2026-12-31&level=3')).body as { rows: { number: string; description: string; openingDebit: string; openingCredit: string }[] };
    const row = (n: string) => tb.rows.find((r) => r.number === n);
    expect(row('202')).toMatchObject({ description: 'Сгради и конструкции' });
    expect(dec(row('202')!.openingDebit).toFixed(2)).toBe(dec('10000').div(RATE).toFixed(2));
    expect(dec(row('203')!.openingDebit).toFixed(2)).toBe(dec('5000').div(RATE).toFixed(2));
    expect(dec(row('241/1')!.openingCredit).toFixed(2)).toBe('1000.00');
    // F4 in the EUR chart keeps the old numbering too.
    expect((await call('GET', '/session')).body.chartTemplateVersion).toBe(1);
  });

  it('a chart of an unknown (newer) template version refuses the templates with a clear message', async () => {
    const db = await t.driver.company(t.companyDb);
    await db.execute(sql`INSERT INTO configuration (key, value, user_id) VALUES (${CHART_TEMPLATE_VERSION_KEY}, '99', NULL)`);
    const r = await call('GET', '/accounts/templates');
    expect([r.status, r.body.code]).toEqual([409, 'strChartTemplateVersionUnknown']);
    expect(r.body.error).toContain('шаблон версия 99');
    expect((await call('POST', '/accounts/template', { type: 'commercial', numbers: ['209'] })).status).toBe(409);
    await db.execute(sql`DELETE FROM configuration WHERE key = ${CHART_TEMPLATE_VERSION_KEY}`);
  });
});
