import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestCompany, type TestCompany } from './helpers.ts';
import { writeJet } from './jetWriter.ts';
import { buildDeltaPilot, sourceTotals, stotinki, type Pilot, type SourceYear } from './deltaPilot.ts';

/**
 * Delta conversion pilot (04a 7): a synthetic legacy company (test/deltaPilot.ts)
 * is converted through the API, then the source totals, computed from the
 * legacy tables without the conversion code, are compared with the app's
 * reports: trial balance per account, VAT diaries per month, partner balances.
 *
 * DELTA_PILOT=full runs the large pilot (hundreds of partners, thousands of
 * entries); the default is the small regression version.
 */
const FULL = process.env.DELTA_PILOT === 'full';
const SIZE = FULL ? { partners: 400, entriesPerYear: 3000 } : { partners: 60, entriesPerYear: 260 };

let t: TestCompany;
let pilot: Pilot;
let source: SourceYear[];
let result: any;
let mdbSize = 0;
let seconds = 0;

beforeAll(async () => {
  t = await createTestCompany({ year: 2026, companyName: 'Пилот Делта ООД' });
  pilot = buildDeltaPilot(SIZE);
  source = sourceTotals(pilot.tables);
  const mdb = writeJet(pilot.tables);
  mdbSize = mdb.length;
  const start = Date.now();
  const r = await t.call('POST', '/exchange/delta/import', { fileName: 'MAINACCT.MDB', contentBase64: Buffer.from(mdb).toString('base64'), type: 'all' });
  seconds = (Date.now() - start) / 1000;
  expect(r.status, r.text).toBe(200);
  result = r.body;
}, FULL ? 1_800_000 : 120_000);
afterAll(() => t.close());

const fmt = (st: number) => (st / 100).toFixed(2);

describe(`Delta conversion pilot (${FULL ? 'full' : 'regression'})`, () => {
  it('converts every accounting and firm of the source', () => {
    const rows = pilot.tables.filter((x) => /^Year20(24|25)$/.test(x.name)).reduce((a, x) => a + x.rows.length, 0);
    console.log(`pilot: ${pilot.partners.length} partners, ${rows} turnover rows, ${source.map((y) => `${y.year}: ${y.accountings} accountings`).join(', ')}; MDB ${(mdbSize / 1024).toFixed(0)} KB, conversion ${seconds.toFixed(1)} s`);
    expect(result.years.map((y: { year: number; accountings: number }) => [y.year, y.accountings])).toEqual(source.map((y) => [y.year, y.accountings]));
    const part = pilot.tables.find((x) => x.name === 'Part')!.rows;
    // Every Part row, plus "Служебен партньор" for the rows without a (known) partner.
    expect(result.partners + result.partnersMatched).toBe(part.length + 1);
    expect(result.partnersMatched).toBe(part.length - pilot.partners.length);
  });

  for (const year of [2024, 2025]) {
    it(`trial balance ${year}: every account's opening, turnovers and closing match the source`, async () => {
      const y = source.find((s) => s.year === year)!;
      const tb = (await t.call('GET', `/reports/trial-balance?from=${year}-01-01&to=${year}-12-31&level=10&zero=1`)).body as { rows: { number: string; hasChildren: boolean; openingDebit: string; openingCredit: string; debitTurnover: string; creditTurnover: string; closingDebit: string; closingCredit: string }[] };
      const leaves = tb.rows.filter((r) => !r.hasChildren);
      const problems: string[] = [];
      for (const r of leaves) {
        const s = y.accounts.get(r.number) ?? { od: 0, oc: 0, dt: 0, ct: 0 };
        const openApp = stotinki(r.openingDebit) - stotinki(r.openingCredit);
        const openSrc = s.od - s.oc;
        if (openApp !== openSrc) problems.push(`${r.number} opening ${fmt(openApp)} vs source ${fmt(openSrc)}`);
        if (stotinki(r.debitTurnover) !== s.dt) problems.push(`${r.number} debit turnover ${r.debitTurnover} vs source ${fmt(s.dt)}`);
        if (stotinki(r.creditTurnover) !== s.ct) problems.push(`${r.number} credit turnover ${r.creditTurnover} vs source ${fmt(s.ct)}`);
        const closeApp = stotinki(r.closingDebit) - stotinki(r.closingCredit);
        if (closeApp !== openSrc + s.dt - s.ct) problems.push(`${r.number} closing ${fmt(closeApp)} vs source ${fmt(openSrc + s.dt - s.ct)}`);
      }
      for (const n of y.accounts.keys()) if (!leaves.some((r) => r.number === n)) problems.push(`${n} missing in the trial balance`);
      expect(problems).toEqual([]);
    });

    it(`VAT diaries ${year}: every month's column totals match the source`, async () => {
      // A purchase may be declared in a later month (of the next year too): the diaries go by declaration month.
      const byMonth = (k: 'sales' | 'purchases', month: string) => source.map((s) => s[k].get(month)).filter((x): x is number[] => !!x).reduce((a, b) => a.map((v, i) => v + b[i]!));
      const problems: string[] = [];
      for (let m = 1; m <= 12; m++) {
        const month = `${year}-${String(m).padStart(2, '0')}`;
        const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
        const r = await t.call('POST', '/vat/diaries', { from: `${month}-01`, to: `${month}-${last}` });
        expect(r.status, r.text).toBe(200);
        const sales = (r.body.salesTotals as string[]).map(stotinki);
        const purchases = (r.body.purchasesTotals as string[]).map(stotinki);
        const ws = byMonth('sales', month) ?? Array(17).fill(0);
        const wp = byMonth('purchases', month) ?? Array(7).fill(0);
        ws.forEach((v, i) => v !== sales[i] && problems.push(`${month} sales col ${9 + i}: ${fmt(sales[i]!)} vs source ${fmt(v)}`));
        wp.forEach((v, i) => v !== purchases[i] && problems.push(`${month} purchases col ${9 + i}: ${fmt(purchases[i]!)} vs source ${fmt(v)}`));
      }
      expect(problems).toEqual([]);
    });

    it(`partner balances ${year}: every firm's closing on 411 and 401 matches the source`, async () => {
      const y = source.find((s) => s.year === year)!;
      const partners = (await t.call('GET', '/partners?all=1')).body as { id: number; name: string; bulstat: string | null; vatNumber: string | null }[];
      const key = (p: { name: string; bulstat: string | null; vatNumber: string | null }) =>
        p.bulstat && !/^9+$/.test(p.bulstat) ? `b:${p.bulstat}` : p.vatNumber ? `v:${p.vatNumber}` : `n:${p.name}`;
      const byId = new Map(partners.map((p) => [p.id, key(p)]));
      const app = new Map<string, number>();
      for (const group of ['411', '401']) {
        const rows = (await t.call('GET', `/reports/partner-turnover?account=${group}&from=${year}-01-01&to=${year}-12-31`)).body as { companyId: number; closingDebit: string; closingCredit: string }[];
        for (const r of rows) app.set(`${byId.get(r.companyId)}|${group}`, stotinki(r.closingDebit) - stotinki(r.closingCredit));
      }
      const problems: string[] = [];
      for (const [k, v] of y.partnerClosing) if ((app.get(k) ?? 0) !== v) problems.push(`${k}: ${fmt(app.get(k) ?? 0)} vs source ${fmt(v)}`);
      for (const [k, v] of app) if (!y.partnerClosing.has(k) && v !== 0) problems.push(`${k}: ${fmt(v)} not in the source`);
      expect(problems).toEqual([]);
    });
  }

  it('the 2025 -> 2026 changeover carries every balance to the EUR account of the same number and meaning', async () => {
    const y = source.find((s) => s.year === 2025)!;
    const bgn = (await t.call('GET', '/accounts?year=2025')).body as { id: number; number: string; description: string; isEuro: boolean }[];
    const db = await t.driver.company(t.companyDb);
    const q = async <T,>(text: ReturnType<typeof sql>) => ((await db.execute(text)) as unknown as { rows: T[] }).rows;
    const charts = await q<{ number: string; description: string; is_euro: boolean; id: number }>(sql`SELECT id, number, description, is_euro FROM accounts WHERE number <> '0'`);
    const bgnByNo = new Map(charts.filter((a) => !a.is_euro).map((a) => [a.number, a]));
    const years = (await t.call('GET', '/years')).body as { id: number; year: number }[];
    const r = await t.call('POST', `/years/${years.find((x) => x.year === 2025)!.id}/conclude`, { differencesAccountId: bgnByNo.get('123')!.id });
    expect(r.status, r.text).toBe(200);
    expect(bgn.length).toBeGreaterThan(0);
    const tb = (await t.call('GET', '/reports/trial-balance?from=2026-01-01&to=2026-12-31&level=10&zero=1')).body as { rows: { number: string; description: string; hasChildren: boolean; openingDebit: string; openingCredit: string }[] };
    // An account with partner or document detail opens per row, each row rounded on its own (half a stotinka at most).
    const rowsPerAccount = new Map((await q<{ number: string; n: number }>(sql`SELECT a.number, count(*)::int AS n FROM account_initial_balances b JOIN accounts a ON a.id = b.account_id WHERE a.is_euro GROUP BY a.number`)).map((r) => [r.number, r.n]));
    const problems: string[] = [];
    let diff = 0;
    for (const [n, a] of y.accounts) {
      const closing = a.od - a.oc + a.dt - a.ct;
      const row = tb.rows.find((x) => x.number === n && !x.hasChildren);
      if (row && row.description !== bgnByNo.get(n)?.description) problems.push(`${n}: EUR "${row.description}" vs BGN "${bgnByNo.get(n)?.description}"`);
      const app = row ? stotinki(row.openingDebit) - stotinki(row.openingCredit) : 0;
      const want = Math.round(closing / 1.95583);
      if (n === '123') diff = app - want;
      else if (Math.abs(app - want) > Math.max(1, (rowsPerAccount.get(n) ?? 0) / 2)) problems.push(`${n}: opening ${fmt(app)} EUR vs ${fmt(want)} (${fmt(closing)} BGN)`);
    }
    expect(problems).toEqual([]);
    // The rounding difference of the conversion goes to the chosen account (123), a few stotinki per account at most.
    expect(Math.abs(diff)).toBeLessThan(y.accounts.size);
  });

  it('quantity and currency-amount rows are not converted (04a 7: no quantities of material and currency accounts)', async () => {
    const y = source.find((s) => s.year === 2024)!;
    expect([...y.quantities.keys()].sort()).toEqual(['302/1/7', '304/1/7', '304/2/7', '504/1/8']);
    const db = await t.driver.company(t.companyDb);
    const { rows } = (await db.execute(sql`SELECT number FROM accounts WHERE NOT is_euro AND number IN ('302/1/7', '304/1/7', '304/2/7', '504/1/8', '504/2/8')`)) as unknown as { rows: unknown[] };
    expect(rows).toEqual([]);
  });
});
