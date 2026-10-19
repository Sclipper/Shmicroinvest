import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type TestCompany } from './helpers.ts';

/**
 * Financial statements (spec 05 section 9), user reports (10), trial-balance
 * variants (3.5) and the euro changeover (12).
 *
 * 2025 is a BGN year whose amounts are multiples of u = 1 955.83 BGN (= 1 000 EUR),
 * so every converted previous-year figure is exact. 2026 is the EUR year that
 * opens with the 2025 closing balances in EUR.
 */

let t: TestCompany;
const U = 1955.83;
const u = (n: number) => (n * U).toFixed(2);
let client = 0;
let supplier = 0;

type Cell = { key: string; cp: string; ep: string | null };
type Statement = { code: string; rows: { identifier: string; description: string; headings: string[]; cells: Record<string, Cell> }[] };
type Run = { periods: { cp: { start: string; end: string }; ep: { start: string; end: string } }; unit: string; statements: Statement[]; issues: { message: string }[] };

const cellsOf = (r: Run) => {
  const m = new Map<string, Cell>();
  for (const s of r.statements) for (const row of s.rows) for (const c of Object.values(row.cells)) m.set(c.key, c);
  return m;
};

async function run(query: string) {
  const r = await t.call<Run>('GET', `/statements/report?${query}`);
  expect(r.status, r.text).toBe(200);
  return { run: r.body, cell: cellsOf(r.body) };
}

beforeAll(async () => {
  t = await createTestCompany({ year: 2025 });
  client = await t.partner('Клиент ООД', ['411']);
  supplier = await t.partner('Доставчик АД', ['401']);
  const { post } = t;
  // ---- 2025 (BGN) ----
  await post({ date: '2025-01-01', isInitialBalance: true, docType: null, dr: [['501', u(1)], ['503', u(4)]], cr: [['101', u(5)]] });
  await post({ date: '2025-02-10', partner: supplier, term: 'Покупка на стоки', dr: [['304', u(5)], ['453/1', u(1)]], cr: [['401', u(6)]] });
  await post({ date: '2025-03-05', partner: client, term: 'Продажба на стоки', dr: [['411', u(12)]], cr: [['702', u(10)], ['453/2', u(2)]] });
  await post({ date: '2025-03-05', term: 'Отписване на продадени стоки', dr: [['702', u(4)]], cr: [['304', u(4)]] });
  await post({ date: '2025-04-01', partner: supplier, term: 'Външни услуги', dr: [['602', u(1)]], cr: [['401', u(1)]] });
  await post({ date: '2025-04-30', term: 'Начислени заплати', dr: [['604/1', u(2)]], cr: [['421', u(2)]] });
  await post({ date: '2025-05-05', term: 'Изплатени заплати', dr: [['421', u(1)]], cr: [['501', u(1)]] });
  await post({ date: '2025-06-01', partner: supplier, term: 'Плащане на доставчик', dr: [['401', u(6)]], cr: [['503', u(6)]] });
  await post({ date: '2025-07-01', partner: client, term: 'Плащане от клиент', dr: [['503', u(10)]], cr: [['411', u(10)]] });
  // Year-end closing of the expense and revenue accounts.
  await post({ date: '2025-12-31', term: 'Приключване на разходи', dr: [['123', u(3)]], cr: [['602', u(1)], ['604/1', u(2)]] });
  await post({ date: '2025-12-31', term: 'Приключване на приходи', dr: [['702', u(6)]], cr: [['123', u(6)]] });

  // ---- 2026 (EUR) ----
  expect((await t.call('POST', '/years', { year: 2026, force: true })).status).toBe(201);
  expect((await t.call('PUT', '/years/active', { year: 2026, force: true })).status).toBe(200);
  await t.reloadAccounts();
  const ib = { date: '2026-01-01', isInitialBalance: true, docType: null };
  await post({ ...ib, dr: [['503', 8000]], cr: [['101', 5000], ['122', 3000]] });
  await post({ ...ib, dr: [['304', 1000]], cr: [['401', 1000]], partner: supplier });
  await post({ ...ib, dr: [['453/1', 1000]], cr: [['453/2', 1000]] });
  await post({ ...ib, dr: [['411', 2000]], cr: [['453/2', 1000], ['421', 1000]], partner: client });
  await post({ date: '2026-02-10', partner: client, term: 'Продажба на стоки', dr: [['411', 3600]], cr: [['702', 3000], ['453/2', 600]] });
  await post({ date: '2026-02-10', term: 'Отписване на продадени стоки', dr: [['702', 800]], cr: [['304', 800]] });
  await post({ date: '2026-03-15', partner: supplier, term: 'Външни услуги', dr: [['602', 400]], cr: [['401', 400]] });
  await post({ date: '2026-04-01', partner: client, term: 'Плащане от клиент', dr: [['503', 3000]], cr: [['411', 3000]] });
  await post({ date: '2026-04-05', term: 'Изплатени заплати', dr: [['421', 1000]], cr: [['503', 1000]] });
  await post({ date: '2026-12-31', term: 'Приключване на разходи', dr: [['123', 400]], cr: [['602', 400]] });
  await post({ date: '2026-12-31', term: 'Приключване на приходи', dr: [['702', 2200]], cr: [['123', 2200]] });
}, 120_000);
afterAll(() => t.close());

describe('statement definitions (9.3, Appendix A)', () => {
  it('seeds 898 formulas with the factory defaults', async () => {
    const r = await t.call('GET', '/statements/formulas');
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(898);
    const byKey = new Map(r.body.map((f: { key: string }) => [f.key, f]));
    expect(byKey.get('r33')).toMatchObject({ formula: 'ct(701)-ac(123,701)', defaultFormula: 'ct(701)-ac(123,701)', statement: 'opr', columnIdentifier: 'OPRCol2', valueLastPeriod: '0.00' });
    expect(byKey.get('b1')).toMatchObject({ rowDescription: 'А. Записан, но невнесен капитал', columnDescription: 'Актив' });
    const counts = r.body.reduce((m: Record<string, number>, f: { statement: string }) => ({ ...m, [f.statement]: (m[f.statement] ?? 0) + 1 }), {});
    expect(counts).toEqual({ opr: 65, opp: 56, balance: 151, osk: 198, sda: 425, cr: 3 });
  });
});

describe('balance sheet and income statement, BGN year 2025', () => {
  it('balances, matches the 12x result and agrees with the cash flow', async () => {
    await t.call('PUT', '/years/active', { year: 2025 });
    const { run: r, cell } = await run('from=2025-01-01&to=2025-12-31');
    expect(r.unit).toBe('лв.');
    expect(r.periods).toEqual({ cp: { start: '2025-01-01', end: '2025-12-31' }, ep: { start: '2024-01-01', end: '2024-12-31' }, convertPrevious: false });
    expect(cell.get('b50')!.cp).toBe(u(12));
    expect(cell.get('b108')!.cp).toBe(u(12));
    expect(cell.get('b44')!.cp).toBe(u(8)); // cash: 501 = 0, 503 = 8u
    expect(cell.get('b28')!.cp).toBe(u(1)); // goods
    expect(cell.get('b31')!.cp).toBe(u(2)); // receivables from clients
    expect(cell.get('b37')!.cp).toBe(u(1)); // VAT on purchases (debit side of 45*)
    expect(cell.get('b51')!.cp).toBe(u(5));
    expect(cell.get('b78')!.cp).toBe(u(1));
    expect(cell.get('b90')!.cp).toBe(u(3)); // 421 + 453/2
    // ОПР: revenue 10u, cost of goods sold 4u, services 1u, salaries 2u.
    expect(cell.get('r34')!.cp).toBe(u(10));
    expect(cell.get('r15')!.cp).toBe(u(4));
    expect(cell.get('r4')!.cp).toBe(u(1));
    expect(cell.get('r6')!.cp).toBe(u(2));
    expect(cell.get('r17')!.cp).toBe(u(7));
    expect(cell.get('r30')!.cp).toBe(u(3));
    expect(cell.get('r54')!.cp).toBe('0.00');
    // Profit = result on 123 (b62 = fcb(123) - fdb(123)).
    expect(cell.get('b62')!.cp).toBe(cell.get('r30')!.cp);
    // ОПП: opening cash 5u, receipts 10u, payments 7u, closing 8u = balance-sheet cash.
    expect(cell.get('p55')!.cp).toBe(u(5));
    expect(cell.get('p1')!.cp).toBe(u(10));
    expect(cell.get('p28')!.cp).toBe(u(6));
    expect(cell.get('p30')!.cp).toBe(u(1));
    expect(cell.get('p56')!.cp).toBe(cell.get('b47')!.cp);
    // No 2024 data: previous column is zero.
    expect(cell.get('b50')!.ep).toBe('0.00');
  });

  it('the cross-statement verification passes', async () => {
    const r = await t.call('GET', '/statements/verify?from=2025-01-01&to=2025-12-31');
    expect(r.status).toBe(200);
    const failed = r.body.checks.filter((c: { ok: boolean }) => !c.ok);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(r.body.message).toBe('Данните са попълнени коректно.');
  });

  it('prints in thousands of leva', async () => {
    const { run: r, cell } = await run('from=2025-01-01&to=2025-12-31&thousands=1&statements=balance');
    expect(r.unit).toBe('хил. лв.');
    expect(r.statements.map((s) => s.code)).toEqual(['balance']);
    expect(cell.get('b50')!.cp).toBe('23'); // 23 469.96
    expect(cell.get('b44')!.cp).toBe('16'); // 15 646.64
  });

  it('a mid-year start keeps the opening of the earlier months', async () => {
    const { cell } = await run('from=2025-04-01&to=2025-12-31&statements=opr,opp');
    expect(cell.get('r34')!.cp).toBe('0.00'); // the sale was in March
    expect(cell.get('r6')!.cp).toBe(u(2));
    // Opening cash at 1 April: 501 1u + 503 4u - (none paid yet) = 5u.
    expect(cell.get('p55')!.cp).toBe(u(5));
  });
});

describe('EUR year 2026 with the previous year in EUR', () => {
  it('balances and converts the 2025 column at 1.95583', async () => {
    await t.call('PUT', '/years/active', { year: 2026, force: true });
    const { run: r, cell } = await run('from=2026-01-01&to=2026-12-31');
    expect(r.unit).toBe('евро');
    expect(r.periods.ep).toEqual({ start: '2025-01-01', end: '2025-12-31' });
    expect(cell.get('b50')!.cp).toBe('13800.00');
    expect(cell.get('b108')!.cp).toBe('13800.00');
    expect(cell.get('b59')!.cp).toBe('3000.00');
    expect(cell.get('b62')!.cp).toBe('1800.00');
    expect(cell.get('r30')!.cp).toBe('1800.00');
    expect(cell.get('b62')!.cp).toBe(cell.get('r30')!.cp);
    expect(cell.get('p56')!.cp).toBe('10000.00');
    // "Предходна година": 2025 BGN figures / 1.95583.
    expect(cell.get('b50')!.ep).toBe('12000.00');
    expect(cell.get('b108')!.ep).toBe('12000.00');
    expect(cell.get('r30')!.ep).toBe('3000.00');
    expect(cell.get('r34')!.ep).toBe('10000.00');
    expect(cell.get('b44')!.ep).toBe('8000.00');
  });

  it('verification passes for both years', async () => {
    const r = await t.call('GET', '/statements/verify?from=2026-01-01&to=2026-12-31');
    const failed = r.body.checks.filter((c: { ok: boolean }) => !c.ok);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    const balanceOnly = await t.call('GET', '/statements/verify?from=2026-01-01&to=2026-12-31&balanceOnly=1');
    expect(balanceOnly.body.checks.map((c: { id: string }) => c.id)).toEqual(['balance', 'balance_2']);
  });

  it('the same interval of the previous year', async () => {
    const { run: r, cell } = await run('from=2026-01-01&to=2026-03-31&sameInterval=1&statements=opr');
    expect(r.periods.ep).toEqual({ start: '2025-01-01', end: '2025-03-31' });
    expect(cell.get('r34')!.ep).toBe('10000.00'); // March 2025 sale
    expect(cell.get('r6')!.ep).toBe('0.00'); // salaries were in April
    expect(cell.get('r34')!.cp).toBe('3000.00');
  });

  it('a failing check reports the difference in euro', async () => {
    const formulas = (await t.call('GET', '/statements/formulas')).body as { id: number; key: string }[];
    const b49 = formulas.find((f) => f.key === 'b49')!;
    expect((await t.call('PUT', '/statements/formulas', { edits: [{ id: b49.id, formula: 'fdb(651)+fdb(652)+125.5' }] })).status).toBe(200);
    const r = await t.call('GET', '/statements/verify?from=2026-01-01&to=2026-12-31&balanceOnly=1');
    const bad = r.body.checks.find((c: { id: string }) => c.id === 'balance');
    expect(bad).toMatchObject({ ok: false, difference: '125.50' });
    expect(bad.message).toBe('Сумата на актива не е равна на сумата на пасива (текуща година). Разлика: 125.50 евро');
    await t.call('POST', '/statements/formulas/restore', { ids: [b49.id] });
    const back = (await t.call('GET', '/statements/formulas')).body.find((f: { key: string }) => f.key === 'b49');
    expect(back.formula).toBe('fdb(651)+fdb(652)');
  });
});

describe('formats: abbreviated, micro, 2015, English (Тип справка)', () => {
  type Gfo = { title: string; lines: { key: string; description: string; source: string; cp: string; ep: string }[] }[];
  const Y = 'from=2026-01-01&to=2026-12-31';

  it('micro: the abbreviated balance and ОПР add up to the full statements, plus ГФО Микро', async () => {
    await t.call('PUT', '/years/active', { year: 2026, force: true });
    const { run: r, cell } = await run(`${Y}&format=micro`);
    expect((r as Run & { format: string }).format).toBe('micro');
    expect(r.statements.map((s) => [s.code, (s as Statement & { abbreviated?: boolean }).abbreviated])).toEqual([['balance', true], ['opr', true]]);
    expect(cell.get('sb14')).toMatchObject({ cp: '13800.00', ep: '12000.00', source: 'b50' }); // = b50 of the full balance
    expect(cell.get('sb27')).toMatchObject({ cp: '13800.00', ep: '12000.00' });
    expect(cell.get('sb11')!.cp).toBe('10000.00'); // cash = b47
    expect(cell.get('sb19')!.cp).toBe('3000.00'); // retained earnings b61
    expect(cell.get('sb20')!.cp).toBe('1800.00');
    expect(cell.get('sr11')).toMatchObject({ cp: '1800.00', ep: '3000.00' });
    expect(cell.get('sr13')!.cp).toBe('3000.00');
    expect(cell.get('sr12')!.cp).toBe(cell.get('sr22')!.cp);
    expect(cell.has('b50')).toBe(false);
    const balance = r.statements[0]!;
    expect(balance.rows.find((x) => x.cells.BalansCol2?.key === 'sb15')!.headings).toEqual(['А. СОБСТВЕН КАПИТАЛ']);
    const gfo = (r as Run & { gfo: Gfo }).gfo;
    expect(gfo.map((s) => s.title)).toEqual(['I. СЧЕТОВОДЕН БАЛАНС (съкратен)', 'II. ОТЧЕТ ЗА ПРИХОДИТЕ И РАЗХОДИТЕ (съкратен)', 'III. ДОПЪЛНИТЕЛНИ ДАННИ']);
    const line = new Map(gfo.flatMap((s) => s.lines).map((l) => [l.key, l]));
    expect(line.get('m08')).toMatchObject({ cp: '13800.00', ep: '12000.00' });
    expect(line.get('m19')!.cp).toBe('13800.00');
    expect(line.get('m32')).toMatchObject({ cp: '1800.00', ep: '3000.00', source: 'r30-r54' });
    expect(line.get('m30')!.cp).toBe('1800.00');
    // Other statements are not part of the micro format.
    const { run: opp } = await run(`${Y}&format=micro&statements=opp`);
    expect(opp.statements).toEqual([]);
  });

  it('Експорт на съкратени отчети: abbreviated statements in thousands for any format', async () => {
    const r = await t.call<Run & { gfo: Gfo }>('GET', `/statements/abbreviated?${Y}&thousands=1&format=national`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.unit).toBe('хил. евро');
    expect(r.body.statements.map((s) => s.code)).toEqual(['balance', 'opr']);
    const cell = cellsOf(r.body);
    expect(cell.get('sb14')).toMatchObject({ cp: '14', ep: '12' });
    expect(cell.get('sr11')!.cp).toBe('2');
    expect(r.body.gfo).toHaveLength(3);
  });

  it('the 2015 forms: same cells, without the extraordinary rows and with renumbered results', async () => {
    const { run: r, cell } = await run(`${Y}&format=f2015&statements=balance,opr`);
    const opr = r.statements.find((s) => s.code === 'opr')!;
    const label = (key: string) => opr.rows.find((x) => Object.values(x.cells).some((c) => c.key === key))?.description;
    expect(label('r24')).toBeUndefined();
    expect(label('r51')).toBeUndefined();
    expect(label('r27')).toBe('8. Счетоводна печалба (общо приходи - общо разходи)');
    expect(label('r30')).toBe('11. Печалба (8-9-10)');
    expect(cell.get('r30')!.cp).toBe('1800.00');
    expect(cell.get('b50')!.cp).toBe('13800.00');
    const national = await run(`${Y}&statements=opr`);
    expect(national.run.statements[0]!.rows.length - opr.rows.length).toBe(6);
  });

  it('English captions (NSI language choice)', async () => {
    const { run: r, cell } = await run(`${Y}&format=nsi&lang=en&statements=balance,sda`);
    expect(r.unit).toBe('EUR');
    const balance = r.statements.find((s) => s.code === 'balance')! as Statement & { title: string };
    expect(balance.title).toBe('B A L A N C E   S H E E T');
    expect(balance.rows.find((x) => x.cells.BalansCol1?.key === 'b50')!.description).toBe('Total assets (A+B+C+D)');
    expect(balance.rows.find((x) => x.cells.BalansCol1?.key === 'b2')!.headings).toEqual(['B. NON-CURRENT (FIXED) ASSETS', 'I. Intangible assets']);
    expect(cell.get('b50')!.cp).toBe('13800.00');
    const sda = r.statements.find((s) => s.code === 'sda')! as Statement & { columns: { identifier: string; description: string }[] };
    expect(sda.columns.some((c) => c.identifier === 'SDANSICol2a')).toBe(true);
    const micro = await t.call<Run & { gfo: Gfo }>('GET', `/statements/report?${Y}&format=micro&lang=en`);
    expect(micro.body.gfo[0]!.title).toBe('I. BALANCE SHEET (abbreviated)');
    expect(cellsOf(micro.body).get('sb14')!.cp).toBe('13800.00');
    expect((await t.call('GET', `/statements/report?${Y}&format=xyz`)).body.error).toBe('Непознат тип справка.');
    expect((await t.call('GET', `/statements/report?${Y}&lang=de`)).status).toBe(400);
  });

  it('runs the previous-year counterparts of the checks', async () => {
    const r = await t.call('GET', `/statements/verify?${Y}`);
    const ids = r.body.checks.map((c: { id: string }) => c.id);
    for (const id of ['cash_2', 'equity_2', 'equity_result_2', 'capital_2', 'premium_2', 'revaluation_2', 'reserves_2', 'profit_2']) expect(ids).toContain(id);
    const failed = r.body.checks.filter((c: { ok: boolean }) => !c.ok);
    expect(failed, JSON.stringify(failed)).toEqual([]);
  });
});

describe('statement formula editor (9.9)', () => {
  it('validates formulas and keeps the default for restore', async () => {
    const formulas = (await t.call('GET', '/statements/formulas')).body as { id: number; key: string; defaultFormula: string }[];
    const r3 = formulas.find((f) => f.key === 'r3')!;
    const bad = await t.call('PUT', '/statements/formulas', { edits: [{ id: r3.id, formula: 'dt(601)+r999' }, { id: formulas.find((f) => f.key === 'r4')!.id, formula: 'dt(602' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.messages.map((m: { text: string }) => m.text)).toEqual([
      'r3 (а) суровини и материали): Непозната формула : r999',
      expect.stringMatching(/^r4 \(б\) външни услуги\): Очаква се „\)“/),
    ]);
    // An edit changes the statement immediately (there are no formula versions).
    const r4 = formulas.find((f) => f.key === 'r4')!;
    expect((await t.call('PUT', '/statements/formulas', { edits: [{ id: r4.id, formula: 'dt(602)+dt(604)' }] })).status).toBe(200);
    const { cell } = await run('from=2026-01-01&to=2026-12-31&statements=opr');
    expect(cell.get('r4')!.cp).toBe('400.00');
    expect(cell.get('r4')!.ep).toBe('3000.00'); // 2025: (1u + 2u) / 1.95583
    // Restore all of one statement.
    await t.call('POST', '/statements/formulas/restore', { statement: 'opr' });
    const after = (await t.call('GET', '/statements/formulas')).body.find((f: { key: string }) => f.key === 'r4');
    expect(after.formula).toBe('dt(602)');
  });

  it('uses the manually entered previous-period values', async () => {
    const formulas = (await t.call('GET', '/statements/formulas')).body as { id: number; key: string }[];
    const b50 = formulas.find((f) => f.key === 'b50')!;
    expect((await t.call('PUT', '/statements/formulas', { edits: [{ id: b50.id, valueLastPeriod: '4321.5' }] })).status).toBe(200);
    const { cell } = await run('from=2026-01-01&to=2026-12-31&statements=balance&usePrev=1');
    expect(cell.get('b50')!.ep).toBe('4321.50');
    expect(cell.get('b108')!.ep).toBe('0.00');
    const { cell: computed } = await run('from=2026-01-01&to=2026-12-31&statements=balance');
    expect(computed.get('b50')!.ep).toBe('12000.00');
  });

  it('needs the editor permission', async () => {
    const r = await t.call('GET', '/statements/report?from=2026-12-01&to=2026-01-01');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Началната дата е след крайната дата.');
  });
});

describe('trial balance variants and euro changeover (3.4, 3.5, 12)', () => {
  it('a mixed period is in EUR with BGN postings divided by 1.95583', async () => {
    const r = await t.call('GET', '/reports/trial-balance?from=2025-07-01&to=2026-02-28&level=2&account=702');
    expect(r.status).toBe(200);
    const row = r.body.rows.find((x: { number: string }) => x.number === '702');
    // Before 1 July 2025: sale 10u credit, COGS 4u debit -> opening credit 6u = 6 000 EUR;
    // turnover: closing 6u debit (Dec 2025, 6 000 EUR) + Feb 2026 credit 3 000 / debit 800.
    // The 2026 initial balances belong to another financial year and are not read.
    expect(row).toMatchObject({ openingCredit: '6000.00', openingDebit: '0.00', debitTurnover: '6800.00', creditTurnover: '3000.00', closingCredit: '2200.00' });
  });

  it('by months chains the closing balance into the next month', async () => {
    const r = await t.call('GET', '/reports/trial-balance-months?from=2026-01-01&to=2026-12-31&level=2&account=503');
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].months).toEqual([
      { month: '04.2026', openingDebit: '8000.00', openingCredit: '0.00', debitTurnover: '3000.00', creditTurnover: '1000.00', closingDebit: '10000.00', closingCredit: '0.00' },
    ]);
    const all = await t.call('GET', '/reports/trial-balance-months?from=2025-01-01&to=2025-12-31&level=2&account=411');
    expect(all.body[0].months.map((m: { month: string }) => m.month)).toEqual(['03.2025', '07.2025']);
    expect(all.body[0].months[1]).toMatchObject({ openingDebit: u(12), creditTurnover: u(10), closingDebit: u(2) });
  });

  it('foreign-currency and material variants', async () => {
    await t.reloadAccounts();
    const usd = await t.call('POST', '/accounts', { parentId: t.acc('502'), description: 'Каса в USD', currencyId: 3 });
    expect(usd.status, usd.text).toBe(201);
    const goods = await t.call('POST', '/accounts', { parentId: t.acc('302'), description: 'Стока А', accountType: 'material', measure: 'бр.', accountCategoryId: 1 });
    expect(goods.status, goods.text).toBe(201);
    await t.reloadAccounts();
    const usdNumber = usd.body.number as string;
    const goodsNumber = goods.body.number as string;
    await t.post({ date: '2026-05-01', term: 'Покупка на валута', dr: [[usdNumber, 920, { currencyAmount: '1000', exchangeRate: '0.92' }]], cr: [['503', 920]] });
    await t.post({ date: '2026-05-02', partner: supplier, term: 'Доставка', dr: [[goodsNumber, 250, { quantity: '25', price: '10' }]], cr: [['401', 250]] });

    const fc = await t.call('GET', '/reports/trial-balance-fc?from=2026-01-01&to=2026-12-31');
    expect(fc.status).toBe(200);
    const usdRow = fc.body.rows.find((x: { number: string }) => x.number === usdNumber);
    expect(usdRow).toMatchObject({ isoCode: 'USD', debitTurnover: '920.00', closingDebit: '920.00' });
    expect(usdRow.extra).toMatchObject({ debitTurnover: '1000.00', closingDebit: '1000.00' });
    // National-currency accounts are only listed as parents of foreign-currency accounts.
    expect(fc.body.rows.some((x: { number: string }) => x.number === '503')).toBe(false);
    expect(fc.body.rows.some((x: { number: string }) => x.number === '502')).toBe(true);

    const mt = await t.call('GET', `/reports/trial-balance-mt?from=2026-01-01&to=2026-12-31&level=5&account=302`);
    const goodsRow = mt.body.rows.find((x: { number: string }) => x.number === goodsNumber);
    expect(goodsRow.extra).toMatchObject({ debitTurnover: '25.000', closingDebit: '25.000' });
    expect(goodsRow.debitTurnover).toBe('250.00');

    // Currency figures in the formula engine (user report with "сума във валута").
    const rep = await t.call('POST', '/user-reports', {
      name: 'Валута', format: 1, columns: ['USD'],
      lines: [{ number: 1, name: 'Каса USD', cells: [{ expression: `fdb(${usdNumber})`, isCurrencyAmount: true }] }, { number: 2, name: 'Каса USD в евро', cells: [{ expression: `fdb(${usdNumber})` }] }],
    });
    const res = await t.call('GET', `/user-reports/${rep.body.id}/run?from=2026-01-01&to=2026-12-31`);
    expect(res.body.lines.map((l: { values: string[] }) => l.values[0])).toEqual(['1000.00', '920.00']);
  });

  it('free-text filter and search in all levels', async () => {
    const r = await t.call('GET', '/reports/trial-balance-filtered?from=2026-01-01&to=2026-12-31&level=2&filterColumn=AccountDescription&filter=клиенти');
    expect(r.body.rows.map((x: { number: string }) => x.number)).toEqual(['41', '411']);
    expect(r.body.rows.every((x: { description: string }) => /клиенти/i.test(x.description))).toBe(true);
    // 411 is folded into 41: the total counts it once.
    expect(r.body.totals.closingDebit).toBe('2600.00');
    const deep = await t.call('GET', '/reports/trial-balance-filtered?from=2026-01-01&to=2026-12-31&level=0&filterColumn=AccountDescription&filter=в USD&allLevels=1');
    const numbers = deep.body.rows.map((x: { number: string }) => x.number);
    expect(numbers).toEqual(expect.arrayContaining(['5', '50', '502']));
    const any = await t.call('GET', '/reports/trial-balance-filtered?from=2026-01-01&to=2026-12-31&level=2&filter=13800');
    expect(any.body.rows).toEqual([]);
  });

  it('general ledger with balances lists accounts with zero turnover', async () => {
    const without = await t.call('GET', '/reports/general-ledger?from=2026-06-01&to=2026-06-30&level=2&account=101');
    expect(without.body).toEqual([]);
    const withZero = await t.call('GET', '/reports/general-ledger?from=2026-06-01&to=2026-06-30&level=2&account=101&zero=1');
    expect(withZero.body).toHaveLength(1);
    expect(withZero.body[0]).toMatchObject({ number: '101', counters: [], balances: { openingCredit: '5000.00', closingCredit: '5000.00' } });
  });

  it('balances report (spBalancesReport) matches by number across both charts', async () => {
    const r = await t.call('GET', '/reports/balances?account=411&from=2026-01-01&to=2026-12-31');
    expect(r.body).toMatchObject({ openingDebit: '2000.00', debitTurnover: '3600.00', creditTurnover: '3000.00', closingDebit: '2600.00' });
    // A 2025 card read with a 2026 end: legacy amounts divided by 1.95583.
    const legacy = await t.call('GET', '/reports/balances?account=411&from=2025-01-01&to=2026-01-31');
    expect(legacy.body).toMatchObject({ openingDebit: '0.00', debitTurnover: '12000.00', creditTurnover: '10000.00', closingDebit: '2000.00' });
  });
});

describe('user-defined reports (section 10)', () => {
  it('one-column report with row references, only-positive and a filter', async () => {
    const created = await t.call('POST', '/user-reports', {
      name: 'Продажби', description: 'Приходи и разходи по сметки', format: 1, columns: ['Сума'],
      lines: [
        { number: 1, name: 'Приходи от стоки', cells: [{ expression: 'ct(702)' }] },
        { number: 2, name: 'Себестойност', cells: [{ expression: 'ac(702,304)' }] },
        { number: 3, name: 'Марж', cells: [{ expression: 'u1-u2' }] },
        { number: 4, name: 'Отрицателно', cells: [{ expression: 'u2-u1', isOnlyPositive: true }] },
        { number: 5, name: 'Плащания от клиента', cells: [{ expression: 'ac(503,411)', filter: { match: 'all', conditions: [{ field: 'partner', op: 'contains', value: 'Клиент' }] } }] },
        { number: 6, name: 'Плащания с друго основание', cells: [{ expression: 'ac(503,411)', filter: { match: 'all', conditions: [{ field: 'term', op: 'equals', value: 'Друго' }] } }] },
        { number: 7, name: 'Печалба по ОПР', cells: [{ expression: 'r30' }] },
      ],
    });
    expect(created.status, created.text).toBe(201);
    const r = await t.call('GET', `/user-reports/${created.body.id}/run?from=2026-01-01&to=2026-12-31`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.columns).toEqual(['Сума']);
    expect(r.body.lines.map((l: { values: string[] }) => l.values[0])).toEqual(['3000.00', '800.00', '2200.00', '0.00', '3000.00', '0.00', '1800.00']);
    const list = await t.call('GET', '/user-reports');
    expect(list.body.map((x: { name: string }) => x.name)).toContain('Продажби');
  });

  it('monthly report: dt(602) per month and total (acceptance 10.4)', async () => {
    await t.call('PUT', '/years/active', { year: 2025 });
    const created = await t.call('POST', '/user-reports', { name: 'Услуги по месеци', format: 3, columns: [], lines: [{ number: 1, name: 'Външни услуги', cells: [{ expression: 'dt(602)' }] }] });
    expect(created.status, created.text).toBe(201);
    const r = await t.call('GET', `/user-reports/${created.body.id}/run?year=2025`);
    expect(r.body.columns).toHaveLength(13);
    expect(r.body.columns[0]).toBe('Януари');
    const values = r.body.lines[0].values as string[];
    expect(values[3]).toBe(u(1)); // April
    expect(values.filter((v, i) => i < 12 && v !== '0.00')).toHaveLength(1);
    expect(values[12]).toBe(u(1));
    await t.call('PUT', '/years/active', { year: 2026, force: true });
  });

  it('two-column report, edit, copy and delete', async () => {
    const body = {
      name: 'Две колони', format: 2, columns: ['Дебит', 'Кредит'],
      lines: [{ number: 1, name: 'Клиенти', cells: [{ expression: 'dt(411)' }, { expression: 'ct(411)' }] }],
    };
    const created = await t.call('POST', '/user-reports', body);
    const id = created.body.id;
    let r = await t.call('GET', `/user-reports/${id}/run?from=2026-01-01&to=2026-12-31`);
    expect(r.body.columns).toEqual(['Дебит', 'Кредит']);
    expect(r.body.lines[0].values).toEqual(['3600.00', '3000.00']);
    const loaded = await t.call('GET', `/user-reports/${id}`);
    expect(loaded.body.lines[0].cells.map((c: { key: string }) => c.key)).toEqual(['u1', 'v1']);
    expect((await t.call('PUT', `/user-reports/${id}`, { ...body, lines: [{ number: 1, name: 'Клиенти', cells: [{ expression: 'fdb(411)' }, { expression: 'v1+1' }] }] })).status).toBe(200);
    r = await t.call('GET', `/user-reports/${id}/run?from=2026-01-01&to=2026-12-31`);
    expect(r.body.lines[0].values).toEqual(['2600.00', '1.00']);
    const copy = await t.call('POST', `/user-reports/${id}/copy`);
    expect((await t.call('GET', `/user-reports/${copy.body.id}`)).body.name).toBe('Две колони (копие)');
    expect((await t.call('DELETE', `/user-reports/${id}`)).status).toBe(200);
    expect((await t.call('GET', `/user-reports/${id}`)).status).toBe(404);
  });

  it('rejects invalid formulas and duplicate keys', async () => {
    const r = await t.call('POST', '/user-reports', {
      name: 'Грешна', format: 1, columns: [],
      lines: [{ number: 1, name: 'А', cells: [{ expression: 'dt(411' }] }, { number: 2, name: 'Б', cells: [{ key: 'r30', expression: '1' }] }],
    });
    expect(r.status).toBe(422);
    const texts = r.body.messages.map((m: { text: string }) => m.text);
    expect(texts).toContain('Ред 2: ключът „r30“ вече се използва.');
    expect(texts.some((x: string) => x.startsWith('Ред 1 „А“: Очаква се'))).toBe(true);
  });

  it('saved user formulas can be used in report rows', async () => {
    const f = await t.call('POST', '/user-formulas', { name: 'Парични средства', key: 'cash', expression: 'fdb(50*)' });
    expect(f.status, f.text).toBe(201);
    expect((await t.call('POST', '/user-formulas', { name: 'Дубликат', key: 'b50', expression: '1' })).status).toBe(422);
    const rep = await t.call('POST', '/user-reports', { name: 'Пари', format: 1, columns: [], lines: [{ number: 1, name: 'Пари', cells: [{ expression: 'cash' }] }] });
    const r = await t.call('GET', `/user-reports/${rep.body.id}/run?from=2026-01-01&to=2026-12-31`);
    expect(r.body.lines[0].values[0]).toBe('10000.00'); // 503 9 080 + USD cash 920 (both 50*)
    expect((await t.call('GET', '/user-formulas')).body.map((x: { key: string }) => x.key)).toContain('cash');
  });
});
