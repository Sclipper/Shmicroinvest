import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestCompany, type CallResult, type TestCompany } from './helpers.ts';
import { insertPaymentLinks, openItems } from '../src/services/openItems.ts';
import { queryRows } from '../src/db/provider.ts';

const keys = (r: CallResult) => ((r.body?.messages ?? []) as { key: string }[]).map((m) => m.key);
const entry = async (t: TestCompany, id: number) => (await t.call('GET', `/entries/${id}`)).body;
const lines = (ls: { accountId: number; amount: string }[]) => ls.map((l) => [l.accountId, l.amount]);

// One 2026 company for revaluation, closings and the year-end transfer (which runs last: it creates 2027 and closes the company).
let t: TestCompany;
beforeAll(async () => {
  t = await createTestCompany();
}, 60_000);

// ---------------------------------------------------------------------------
describe('FX revaluation (02c 2)', () => {
  let usd1 = '', usd2 = '', gbp = '';
  beforeAll(async () => {
    for (const [description, currencyId] of [['Банка USD', 3], ['Банка USD 2', 3], ['Банка GBP', 4]] as const) {
      const r = await t.call('POST', '/accounts', { parentId: t.acc('504'), description, accountCategoryId: 27, currencyId });
      expect(r.status, r.text).toBe(201);
    }
    await t.reloadAccounts();
    const subs = (await t.call('GET', '/accounts')).body.filter((a: { number: string }) => a.number.startsWith('504/')).map((a: { number: string }) => a.number).sort();
    [usd1, usd2, gbp] = subs as [string, string, string];
    await t.post({ date: '2026-03-10', dr: [[usd1, 1100, { currencyAmount: '1200' }]], cr: [['702', 1100]] });
  });

  const body = (extra: Record<string, unknown>) => ({ tab: 'currency', date: '2026-03-31', term: 'Преоценка', ...extra });

  it('balances of the foreign-currency accounts', async () => {
    const r = await t.call('GET', '/revaluation/balances?date=2026-03-31');
    expect(r.status, r.text).toBe(200);
    expect(r.body.rows).toEqual([expect.objectContaining({ accountId: t.acc(usd1), bookNet: '1100.00', curNet: '1200.00', currencyIso: 'USD' })]);
    expect(r.body.rates).toEqual([{ currencyId: 3, iso: 'USD', rate: null, source: null }]);
  });

  it('worked example 2.5: 0.9250 -> Dr account / Cr 724 10.00 (currency 0); 0.9100 previews Dr 624 / Cr account 8.00', async () => {
    const down = await t.call('POST', '/revaluation/preview', body({ accountId: t.acc(usd1), rates: [{ currencyId: 3, rate: '0.9100' }] }));
    expect(down.body).toEqual([expect.objectContaining({ newAmount: '1092.00', direction: 'negative', sum: '8.00', debitAccountId: t.acc('624'), creditAccountId: t.acc(usd1) })]);
    const r = await t.call('POST', '/revaluation', body({ accountId: t.acc(usd1), rates: [{ currencyId: 3, rate: '0.9250' }] }));
    expect(r.status, r.text).toBe(201);
    expect(r.body.entries).toHaveLength(1);
    const e = await entry(t, r.body.entries[0].id);
    expect(e).toMatchObject({ documentTypeId: 10, term: 'Преоценка', accountingDate: '2026-03-31' });
    expect(e.debits).toEqual([expect.objectContaining({ accountId: t.acc(usd1), amount: '10.00', currencyAmount: '0.00' })]);
    expect(lines(e.credits)).toEqual([[t.acc('724'), '10.00']]);
    // The currency balance is unchanged; only the book value moved.
    const after = await t.call('GET', '/revaluation/balances?date=2026-03-31');
    expect(after.body.rows[0]).toMatchObject({ bookNet: '1110.00', curNet: '1200.00' });
    // The fixing was remembered for the date.
    expect((await t.call('GET', '/revaluation/rates?date=2026-03-31')).body.find((x: { iso: string }) => x.iso === 'USD').rate).toBe('0.925');
  });

  it('acceptance 1: USD 1,000 booked 1,500.00 at 1.4999 -> Dr 624 / Cr account 0.10', async () => {
    await t.post({ date: '2026-03-12', dr: [[usd2, 1500, { currencyAmount: '1000' }]], cr: [['702', 1500]] });
    const r = await t.call('POST', '/revaluation', body({ accountId: t.acc(usd2), rates: [{ currencyId: 3, rate: '1.4999' }] }));
    expect(r.status, r.text).toBe(201);
    const e = await entry(t, r.body.entries[0].id);
    expect(lines(e.debits)).toEqual([[t.acc('624'), '0.10']]);
    expect(e.credits).toEqual([expect.objectContaining({ accountId: t.acc(usd2), amount: '0.10', currencyAmount: '0.00' })]);
  });

  it('acceptance 6: a rate 1.234565 is used and stored as 1.23457', async () => {
    const p = await t.call('POST', '/revaluation/preview', body({ accountId: t.acc(usd1), rates: [{ currencyId: 3, rate: '1.234565' }] }));
    expect(p.body[0]).toMatchObject({ rate: '1.23457', newAmount: '1481.48' });
    const put = await t.call('PUT', '/revaluation/rates', { date: '2026-04-01', rates: [{ currencyId: 3, rate: '1.234565' }] });
    expect(put.body.find((x: { iso: string }) => x.iso === 'USD').rate).toBe('1.23457');
  });

  it('acceptance 2: a locked month is refused with strWrongAccountingMonth; another year with strWrongAccountingDate', async () => {
    const years = (await t.call('GET', '/years')).body;
    await t.call('PUT', `/years/${years[0].id}/locks`, { months: [4] });
    try {
      const r = await t.call('POST', '/revaluation', body({ date: '2026-04-30', accountId: t.acc(usd1), rates: [{ currencyId: 3, rate: '1.3' }] }));
      expect(r.status).toBe(422);
      expect(keys(r)).toEqual(['strWrongAccountingMonth']);
    } finally {
      await t.call('PUT', `/years/${years[0].id}/locks`, { months: [] });
    }
    const other = await t.call('POST', '/revaluation', body({ date: '2025-12-31', accountId: t.acc(usd1), rates: [{ currencyId: 3, rate: '1.3' }] }));
    expect(keys(other)).toEqual(['strWrongAccountingDate']);
  });

  it('account checks: none selected, not a currency account', async () => {
    expect(keys(await t.call('POST', '/revaluation', body({ rates: [] })))).toEqual(['strAccountNotSelectedError']);
    expect(keys(await t.call('POST', '/revaluation', body({ accountId: t.acc('503'), rates: [] })))).toEqual(['strIncorrectCurrencySubAccount']);
  });

  it('acceptance 4: a row without a difference is not listed and cannot be posted; a missing rate is refused (no 1.0 fallback)', async () => {
    await t.post({ date: '2026-03-15', dr: [[gbp, 100, { currencyAmount: '100' }]], cr: [['702', 100]] });
    const p = await t.call('POST', '/revaluation/preview', body({ accountId: t.acc(gbp), rates: [{ currencyId: 4, rate: '1.00004' }] }));
    expect(p.body).toEqual([]);
    const r = await t.call('POST', '/revaluation', body({ accountId: t.acc(gbp), rates: [{ currencyId: 4, rate: '1.00004' }] }));
    expect(keys(r)).toEqual(['strZeroReevaluationSumError']);
    const missing = await t.call('POST', '/revaluation', body({ all: true, rates: [{ currencyId: 3, rate: '1' }] }));
    expect(keys(missing)).toEqual(['strExchangeRateNotSetError']);
    const zero = await t.call('POST', '/revaluation', body({ all: true, rates: [{ currencyId: 3, rate: '1' }, { currencyId: 4, rate: '0' }] }));
    expect(keys(zero)).toEqual(['strExchangeRateNotSetError']);
  });

  it('acceptance 5: all accounts -> one МО per row with consecutive numbers, in one transaction', async () => {
    const r = await t.call('POST', '/revaluation', body({ date: '2026-05-31', all: true, rates: [{ currencyId: 3, rate: '1' }, { currencyId: 4, rate: '1.2' }] }));
    expect(r.status, r.text).toBe(201);
    expect(r.body.entries.map((e: { accountId: number; direction: string; amount: string }) => [e.accountId, e.direction, e.amount])).toEqual([
      [t.acc(usd1), 'positive', '90.00'], // 1200 * 1 - 1110
      [t.acc(usd2), 'negative', '499.90'], // 1000 * 1 - 1499.90
      [t.acc(gbp), 'positive', '20.00'], // 100 * 1.2 - 100
    ]);
    const docs = await Promise.all(r.body.entries.map((e: { id: number }) => entry(t, e.id)));
    const numbers = docs.map((d) => Number(d.documentNumber));
    expect(numbers[1]).toBe(numbers[0]! + 1);
    expect(numbers[2]).toBe(numbers[0]! + 2);
    for (const d of docs) expect([d.debits.length, d.credits.length, d.documentTypeId]).toEqual([1, 1, 10]);
  });

  it('ECB download: converted to the base currency; any failure is 503 strCurrenciesServiceUnavailableOrHoliday', async () => {
    const prev = process.env.ECB_RATES_URL;
    try {
      process.env.ECB_RATES_URL = 'http://127.0.0.1:9/eurofxref.xml';
      const down = await t.call('POST', '/revaluation/rates/download', { date: '2026-06-30' });
      expect(down.status).toBe(503);
      expect(down.body.error).toBe('Избраната дата на осчетоводяване е почивен ден или услугата за валутни справки е временно неактивна.');
      const xml = "<gesmes:Envelope><Cube><Cube time='2026-06-30'><Cube currency='USD' rate='1.0810'/><Cube currency='GBP' rate='0.8500'/></Cube></Cube></gesmes:Envelope>";
      process.env.ECB_RATES_URL = `data:text/xml,${encodeURIComponent(xml)}`;
      const ok = await t.call('POST', '/revaluation/rates/download', { date: '2026-06-30' });
      expect(ok.status, ok.text).toBe(200);
      const rate = (iso: string) => ok.body.find((x: { iso: string }) => x.iso === iso)?.rate;
      expect([rate('USD'), rate('GBP'), rate('BGN')]).toEqual(['0.92507', '1.17647', '0.51129']);
      // A holiday (no fixing for the date) is the same failure.
      expect((await t.call('POST', '/revaluation/rates/download', { date: '2026-07-01' })).status).toBe(503);
    } finally {
      if (prev === undefined) delete process.env.ECB_RATES_URL;
      else process.env.ECB_RATES_URL = prev;
    }
  });

  it('partner tab: one row per (account, partner), the partner leg carries the company; sign checks', async () => {
    const sub = await t.call('POST', '/accounts', { parentId: t.acc('411'), description: 'Клиенти в USD', accountCategoryId: 10, currencyId: 3 });
    expect(sub.status, sub.text).toBe(201);
    await t.reloadAccounts();
    const acc = sub.body.number as string;
    const p1 = await t.partner('Клиент USD 1', [acc]);
    const p2 = await t.partner('Клиент USD 2', [acc]);
    await t.post({ date: '2026-06-01', partner: p1, dr: [[acc, 900, { currencyAmount: '1000' }]], cr: [['702', 900]] });
    await t.post({ date: '2026-06-02', partner: p2, dr: [['702', 90]], cr: [[acc, 90, { currencyAmount: '100' }]] });
    const bal = await t.call('GET', `/revaluation/balances?tab=partner&date=2026-06-30&accountId=${t.acc(acc)}`);
    expect(bal.body.rows.map((r: { companyId: number; bookNet: string; curNet: string }) => [r.companyId, r.bookNet, r.curNet]))
      .toEqual([[p1, '900.00', '1000.00'], [p2, '-90.00', '-100.00']]);
    const partner = (extra: Record<string, unknown>) => ({ tab: 'partner', date: '2026-06-30', accountId: t.acc(acc), ...extra });
    // Active account with a credit balance (partner 2).
    expect(keys(await t.call('POST', '/revaluation', partner({ rate: '0.95' })))).toEqual(['strActiveAccountReevaluationError']);
    expect(keys(await t.call('POST', '/revaluation', partner({ companyId: p1, rate: '0' })))).toEqual(['strExchangeRateNotSetError']);
    expect(keys(await t.call('POST', '/revaluation', partner({ accountId: t.acc(usd1), rate: '1' })))).toEqual(['strPartnerAccountNotSelected']);
    const r = await t.call('POST', '/revaluation', partner({ companyId: p1, rate: '0.95' }));
    expect(r.status, r.text).toBe(201);
    const e = await entry(t, r.body.entries[0].id);
    expect(e.debits).toEqual([expect.objectContaining({ accountId: t.acc(acc), companyId: p1, amount: '50.00', currencyAmount: '0.00' })]);
    expect(lines(e.credits)).toEqual([[t.acc('724'), '50.00']]);
  });

  it('acceptance 3: without a 624 account the screen reports strReevaluationAccountsNotDefined', async () => {
    const d = await t.driver.company(t.companyDb);
    await d.execute(sql`UPDATE accounts SET account_category_id = NULL WHERE account_category_id = 28`);
    try {
      const r = await t.call('POST', '/revaluation', body({ accountId: t.acc(usd1), rates: [{ currencyId: 3, rate: '2' }] }));
      expect(keys(r)).toEqual(['strReevaluationAccountsNotDefined']);
      expect((await t.call('GET', '/revaluation/setup')).body.expense).toBeNull();
    } finally {
      await d.execute(sql`UPDATE accounts SET account_category_id = 28 WHERE number = '624'`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('closing of income/expense accounts (02c 3)', () => {

  const close = (b: Record<string, unknown>) => t.call('POST', '/closings', { percentDistribution: false, ...b });
  const count = async () => (await queryRows<{ n: number }>(await t.driver.company(t.companyDb), sql`SELECT count(*)::int AS n FROM accountings`))[0]!.n;

  it('acceptance 1: 602 with Dt 1 200 / Ct 200 -> Dr 123 / Cr 602 1 000.00, "Приключване на група 60"', async () => {
    await t.post({ date: '2026-01-10', dr: [['602', 1200]], cr: [['503', 1200]] });
    await t.post({ date: '2026-01-20', dr: [['503', 200]], cr: [['602', 200]] });
    const rows = (await t.call('GET', '/closings/turnovers?mode=economic&from=2026-01-01&to=2026-01-31')).body;
    expect(rows.map((r: { number: string; turnover: string }) => [r.number, r.turnover])).toEqual([['602', '1000.00']]);
    const r = await close({ mode: 'economic', from: '2026-01-01', to: '2026-01-31', sources: [{ accountId: t.acc('602'), amount: '1000' }], targets: [{ accountId: t.acc('123'), percent: 100 }] });
    expect(r.status, r.text).toBe(201);
    expect(r.body.entries).toHaveLength(1);
    const e = await entry(t, r.body.entries[0].id);
    expect(e).toMatchObject({ documentTypeId: 10, term: 'Приключване на група 60', accountingDate: '2026-01-31' });
    expect([lines(e.debits), lines(e.credits)]).toEqual([[[t.acc('123'), '1000.00']], [[t.acc('602'), '1000.00']]]);
    // Closed: the row is no longer listed.
    expect((await t.call('GET', '/closings/turnovers?mode=economic&from=2026-01-01&to=2026-01-31')).body).toEqual([]);
  });

  it('acceptance 2: algorithm A with 70 % / 30 % on 100.01 -> two entries 70.01 and 30.00', async () => {
    await t.post({ date: '2026-02-10', dr: [['611', '100.01']], cr: [['503', '100.01']] });
    const r = await close({ mode: 'costs', from: '2026-02-01', to: '2026-02-28', sources: [{ accountId: t.acc('611'), amount: '100.01' }], targets: [{ accountId: t.acc('123'), percent: 70 }, { accountId: t.acc('122'), percent: 30 }] });
    expect(r.status, r.text).toBe(201);
    const es = await Promise.all(r.body.entries.map((x: { id: number }) => entry(t, x.id)));
    expect(es.map((e) => [lines(e.debits), lines(e.credits), e.term])).toEqual([
      [[[t.acc('123'), '70.01']], [[t.acc('611'), '70.01']], 'Приключване на разходи'],
      [[[t.acc('122'), '30.00']], [[t.acc('611'), '30.00']], 'Приключване на разходи'],
    ]);
  });

  it('acceptances 6 and 7: percent distribution 60/30 is refused (nothing written), 60/40 posts one entry', async () => {
    await t.post({ date: '2026-03-10', dr: [['609', 100]], cr: [['503', 100]] });
    const base = { mode: 'economic', from: '2026-03-01', to: '2026-03-31', sources: [{ accountId: t.acc('609'), amount: '100' }], percentDistribution: true };
    const before = await count();
    const bad = await close({ ...base, targets: [{ accountId: t.acc('123'), percent: 60 }, { accountId: t.acc('122'), percent: 30 }] });
    expect(bad.status).toBe(422);
    expect(keys(bad)).toEqual(['strInvalidSumPercentDistribution']);
    expect(await count()).toBe(before);
    const ok = await close({ ...base, targets: [{ accountId: t.acc('123'), percent: 60 }, { accountId: t.acc('122'), percent: 40 }] });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.entries).toHaveLength(1);
    const e = await entry(t, ok.body.entries[0].id);
    expect([lines(e.debits), lines(e.credits)]).toEqual([[[t.acc('123'), '60.00'], [t.acc('122'), '40.00']], [[t.acc('609'), '100.00']]]);
  });

  it('acceptance 5: revenue 701 credit 500 -> Dr 701 / Cr 123, "Приключване на приходи"', async () => {
    await t.post({ date: '2026-04-10', dr: [['503', 500]], cr: [['701', 500]] });
    const rows = (await t.call('GET', '/closings/turnovers?mode=revenue&from=2026-04-01&to=2026-04-30')).body;
    expect(rows.map((r: { number: string; turnover: string }) => [r.number, r.turnover])).toEqual([['701', '500.00']]);
    const r = await close({ mode: 'revenue', from: '2026-04-01', to: '2026-04-30', sources: [{ accountId: t.acc('701'), amount: '500' }], targets: [{ accountId: t.acc('123'), percent: 100 }] });
    expect(r.status, r.text).toBe(201);
    const e = await entry(t, r.body.entries[0].id);
    expect([lines(e.debits), lines(e.credits), e.term]).toEqual([[[t.acc('701'), '500.00']], [[t.acc('123'), '500.00']], 'Приключване на приходи']);
  });

  it('acceptance 10: a single target at 150 % warns, needs confirmation and then closes the full amount only', async () => {
    await t.post({ date: '2026-06-10', dr: [['601', 80]], cr: [['503', 80]] });
    const b = { mode: 'economic', from: '2026-06-01', to: '2026-06-30', sources: [{ accountId: t.acc('601'), amount: '80' }], targets: [{ accountId: t.acc('123'), percent: 150 }] };
    const before = await count();
    const w = await close(b);
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ posted: false, warnings: [{ key: 'strInvalidConcludeAccountsPercent', severity: 'warning' }] });
    expect(await count()).toBe(before);
    const ok = await close({ ...b, confirm: true });
    expect(ok.status, ok.text).toBe(201);
    const e = await entry(t, ok.body.entries[0].id);
    expect([lines(e.debits), lines(e.credits)]).toEqual([[[t.acc('123'), '80.00']], [[t.acc('601'), '80.00']]]);
  });

  it('critical validations: locked month, amount above turnover, no target, no source', async () => {
    await t.post({ date: '2026-05-10', dr: [['602', 50]], cr: [['503', 50]] });
    const b = { mode: 'economic', from: '2026-05-01', to: '2026-05-31', sources: [{ accountId: t.acc('602'), amount: '50' }], targets: [{ accountId: t.acc('123'), percent: 100 }] };
    const years = (await t.call('GET', '/years')).body;
    await t.call('PUT', `/years/${years[0].id}/locks`, { months: [5] });
    try {
      expect(keys(await close(b))).toEqual(['strWrongAccountingMonth']);
    } finally {
      await t.call('PUT', `/years/${years[0].id}/locks`, { months: [] });
    }
    expect(keys(await close({ ...b, sources: [{ accountId: t.acc('602'), amount: '60' }] }))).toEqual(['strInvalidConcludeAmount']);
    expect(keys(await close({ ...b, targets: [{ accountId: null, percent: 100 }] }))).toEqual(['strInvalidConcludeToAccount']);
    expect(keys(await close({ ...b, sources: [] }))).toEqual(['strInvalidConcludeAccountsNumber']);
    expect(keys(await close({ ...b, targets: [{ accountId: t.acc('123'), percent: 70 }, { accountId: t.acc('122'), percent: 40 }] }))).toEqual(['strInvalidSumPercent']);
  });

  it('acceptance 9: a net debit of 0.004 is hidden and cannot be closed', async () => {
    const a = await t.post({ date: '2026-07-10', dr: [['603', 100]], cr: [['503', 100]] });
    await t.post({ date: '2026-07-11', dr: [['503', 100]], cr: [['603', 100]] });
    const d = await t.driver.company(t.companyDb);
    await d.execute(sql`UPDATE accounting_details SET amount = amount + 0.004 WHERE accounting_id = ${a.id} AND sign = 1`);
    await d.execute(sql`UPDATE accounting_details SET ref_amount = ref_amount + 0.004 WHERE accounting_id = ${a.id} AND sign = -1`);
    expect((await t.call('GET', '/closings/turnovers?mode=economic&from=2026-07-01&to=2026-07-31')).body).toEqual([]);
    const r = await close({ mode: 'economic', from: '2026-07-01', to: '2026-07-31', sources: [{ accountId: t.acc('603'), amount: '0.004' }], targets: [{ accountId: t.acc('123'), percent: 100 }] });
    expect(keys(r)).toEqual(['strInvalidConcludeAmount']);
  });

  it('automatic closing: accounts with a ConcludeAccountID, active debit / passive credit surpluses, one МО per row', async () => {
    for (const n of ['606', '702']) {
      const r = await t.call('PUT', `/accounts/${t.acc(n)}`, { concludeAccountId: t.acc('123') });
      expect(r.status, r.text).toBe(200);
    }
    await t.post({ date: '2026-08-10', dr: [['606', 300]], cr: [['503', 300]] });
    await t.post({ date: '2026-08-11', dr: [['503', 200]], cr: [['702', 200]] });
    await t.post({ date: '2026-08-12', dr: [['607', 70]], cr: [['503', 70]] }); // no ConcludeAccountID: never listed
    const rows = (await t.call('GET', '/closings/auto?from=2026-08-01&to=2026-08-31')).body;
    expect(rows.map((r: { number: string; amount: string; debitAccountId: number; creditAccountId: number }) => [r.number, r.amount, r.debitAccountId, r.creditAccountId])).toEqual([
      ['606', '300.00', t.acc('123'), t.acc('606')],
      ['702', '200.00', t.acc('702'), t.acc('123')],
    ]);
    const r = await t.call('POST', '/closings/auto', { from: '2026-08-01', to: '2026-08-31' });
    expect(r.status, r.text).toBe(201);
    expect(r.body.message).toBe('Сметките са успешно приключени.');
    const es = await Promise.all(r.body.entries.map((x: { id: number }) => entry(t, x.id)));
    expect(es.map((e) => [e.term, e.documentTypeId, e.accountingDate])).toEqual([
      ['Автоматично приключване на сметки', 10, '2026-08-31'], ['Автоматично приключване на сметки', 10, '2026-08-31'],
    ]);
    expect((await t.call('GET', '/closings/auto?from=2026-08-01&to=2026-08-31')).body).toEqual([]);
    const again = await t.call('POST', '/closings/auto', { from: '2026-08-01', to: '2026-08-31' });
    expect(again.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('year-end transfer of balances (01b 6.4)', () => {
  let yearId = 0;
  let sup1 = 0, sup2 = 0, sup3 = 0;
  let inv2Doc = 0;
  beforeAll(async () => {
    yearId = (await t.call('GET', '/years')).body[0].id;
    // 501: 1000 + 250 - 400 = 850 debit.
    await t.post({ date: '2026-02-01', dr: [['501', 1000]], cr: [['702', 1000]] });
    await t.post({ date: '2026-02-02', dr: [['501', 250]], cr: [['702', 250]] });
    await t.post({ date: '2026-02-03', dr: [['609', 400]], cr: [['501', 400]] });
    sup1 = await t.partner('Платен доставчик', ['401']);
    sup2 = await t.partner('Доставчик D-17', ['401']);
    sup3 = await t.partner('Доставчик D-30', ['401']);
    const d = await t.driver.company(t.companyDb);
    const inv1 = await t.post({ date: '2026-03-01', docNumber: 'D-1', partner: sup1, dr: [['602', 600]], cr: [['401', 600]] });
    const pay1 = await t.post({ date: '2026-03-05', docType: 9, docNumber: '1', partner: sup1, dr: [['401', 600]], cr: [['503', 600]] });
    const inv2 = await t.post({ date: '2026-03-10', docNumber: 'D-17', partner: sup2, dr: [['602', 600]], cr: [['401', 600]] });
    const pay2 = await t.post({ date: '2026-03-15', docType: 9, docNumber: '2', partner: sup2, dr: [['401', 200]], cr: [['503', 200]] });
    await t.post({ date: '2026-04-01', docNumber: 'D-30', partner: sup3, dr: [['602', 500]], cr: [['401', 500]] });
    await insertPaymentLinks(d, [
      { paymentAccountingId: pay1.id, refAccountingId: inv1.id, documentId: null, accountId: t.acc('401'), companyId: sup1, amount: '600' },
      { paymentAccountingId: pay2.id, refAccountingId: inv2.id, documentId: null, accountId: t.acc('401'), companyId: sup2, amount: '200' },
    ]);
    inv2Doc = (await queryRows<{ document_id: number }>(d, sql`SELECT document_id FROM accountings WHERE id = ${inv2.id}`))[0]!.document_id;
  });
  // Last user of the shared company.
  afterAll(() => t.close());

  const openings = async (year: number) => queryRows<{ id: number; number: string; accounting_date: string; is_initial_balance: boolean; is_initial_correspondence: boolean; document_id: number | null; account: string; company_id: number | null; dr: string; cr: string }>(
    await t.driver.company(t.companyDb), sql`
      SELECT a.id, a.number, a.accounting_date::text, a.is_initial_balance, a.is_initial_correspondence, a.document_id, ac.number AS account, d.company_id,
        SUM(d.amount)::numeric(19,2)::text AS dr, SUM(d.ref_amount)::numeric(19,2)::text AS cr
      FROM accountings a JOIN financial_years fy ON fy.id = a.financial_year_id JOIN accounting_details d ON d.accounting_id = a.id JOIN accounts ac ON ac.id = d.account_id
      WHERE fy.year = ${year} AND a.is_initial_balance
      GROUP BY a.id, ac.number, d.company_id ORDER BY ac.number, d.company_id`);

  it('creates the next year and carries 850.00 on 501 as an opening dated 01.01 (number empty, not by correspondence)', async () => {
    const info = (await t.call('GET', `/years/${yearId}/conclude-info`)).body;
    expect(info).toMatchObject({ year: 2026, nextYear: 2027, nextExists: false, canConclude: true, isEuroChangeover: false });
    const r = await t.call('POST', `/years/${yearId}/conclude`, {});
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ message: 'Счетоводната година 2026 е приключена успешно!', nextYearCreated: true });
    const years = (await t.call('GET', '/years')).body as { year: number; isConcluded: boolean }[];
    expect(years.map((y) => [y.year, y.isConcluded])).toEqual([[2026, true], [2027, true]]);
    const rows = await openings(2027);
    expect(rows.filter((o) => o.account === '501')).toEqual([expect.objectContaining({
      number: '', accounting_date: '2027-01-01', is_initial_balance: true, is_initial_correspondence: false, dr: '850.00', cr: '0.00',
    })]);
    // Each opening has DebitBalance on its debit leg and CreditBalance on its credit leg; the set as a whole balances.
    const total = rows.reduce((s, o) => s + Number(o.dr) - Number(o.cr), 0);
    expect(Math.abs(total)).toBeLessThan(0.001);
  });

  it('a fully paid supplier invoice is not carried; a partially paid one is carried with its document', async () => {
    const rows = await openings(2027);
    expect(rows.filter((o) => o.company_id === sup1)).toEqual([]);
    expect(rows.filter((o) => o.company_id === sup2)).toEqual([expect.objectContaining({ account: '401', dr: '0.00', cr: '400.00', document_id: inv2Doc })]);
    expect(rows.filter((o) => o.company_id === sup3)).toEqual([expect.objectContaining({ account: '401', cr: '500.00' })]);
  });

  it('re-running is idempotent and re-links the payments of the replaced openings', async () => {
    expect((await t.call('PUT', '/years/active', { year: 2027 })).status).toBe(200);
    const d = await t.driver.company(t.companyDb);
    const first = await openings(2027);
    const opening2 = first.find((o) => o.company_id === sup2)!;
    // A 2027 payment against the carried invoice, and one directly against the 2026 invoice D-30.
    const pay = await t.post({ date: '2027-02-01', docType: 9, docNumber: '1', partner: sup2, dr: [['401', 100]], cr: [['503', 100]] });
    const pay3 = await t.post({ date: '2027-02-02', docType: 9, docNumber: '2', partner: sup3, dr: [['401', 500]], cr: [['503', 500]] });
    const inv3 = (await queryRows<{ id: number }>(d, sql`SELECT a.id FROM accountings a JOIN documents doc ON doc.id = a.document_id WHERE doc.number = 'D-30'`))[0]!.id;
    await insertPaymentLinks(d, [
      { paymentAccountingId: pay.id, refAccountingId: opening2.id, documentId: null, accountId: t.acc('401'), companyId: sup2, amount: '100' },
      { paymentAccountingId: pay3.id, refAccountingId: inv3, documentId: null, accountId: t.acc('401'), companyId: sup3, amount: '500' },
    ]);
    const r = await t.call('POST', `/years/${yearId}/conclude`, {});
    expect(r.status, r.text).toBe(200);
    const second = await openings(2027);
    expect(second.map((o) => [o.account, o.company_id, o.dr, o.cr])).toEqual(first.map((o) => [o.account, o.company_id, o.dr, o.cr]));
    expect(second.find((o) => o.company_id === sup2)!.id).not.toBe(opening2.id);
    const items = await openItems(d, { startDate: '2027-01-01', endDate: '2027-12-31' });
    // 400 carried - 100 paid in 2027; D-30 fully paid in 2027 through its opening.
    expect(items.filter((i) => i.companyId === sup2).map((i) => [i.isInitialBalance, i.open])).toEqual([[true, '-300.00']]);
    expect(items.filter((i) => i.companyId === sup3)).toEqual([]);
    const third = await t.call('POST', `/years/${yearId}/conclude`, {});
    expect(third.status).toBe(200);
    const again = await openItems(d, { startDate: '2027-01-01', endDate: '2027-12-31' });
    expect(again.filter((i) => [sup2, sup3].includes(i.companyId)).map((i) => [i.companyId, i.open])).toEqual([[sup2, '-300.00']]);
  });

  it('refuses when the next year is locked', async () => {
    const next = (await t.call('GET', '/years')).body.find((y: { year: number }) => y.year === 2027);
    await t.call('PUT', `/years/${next.id}/locks`, { lockYear: true });
    const info = (await t.call('GET', `/years/${yearId}/conclude-info`)).body;
    expect(info).toMatchObject({ canConclude: false, nextLocked: true, reason: 'Не е възможно прехвърляне на салда към заключена счетоводна година.' });
    const r = await t.call('POST', `/years/${yearId}/conclude`, {});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Не е възможно прехвърляне на салда към заключена счетоводна година.');
  });
});

// ---------------------------------------------------------------------------
describe('euro changeover 2025 BGN -> 2026 EUR (04b 4)', () => {
  let e: TestCompany;
  let sup = 0;
  const bgn: Record<string, number> = {};
  beforeAll(async () => {
    e = await createTestCompany({ year: 2025 });
    sup = await e.partner('Доставчик BGN', ['401']);
    // 501 1000 debit vs 702 600 + 701 400 credit: 511.29 vs 306.78 + 204.52 -> 0.01 difference.
    await e.post({ date: '2025-05-01', dr: [['501', 1000]], cr: [['702', 600], ['701', 400]] });
    await e.post({ date: '2025-06-01', docNumber: 'F-1', partner: sup, dr: [['602', 1000]], cr: [['401', 1000]] });
    for (const n of ['501', '701', '702', '602', '401', '123', '609']) bgn[n] = e.acc(n);
  }, 60_000);
  afterAll(() => e.close());

  it('converts the openings at 1.95583 per row and books the difference on the chosen account', async () => {
    const yearId = (await e.call('GET', '/years')).body[0].id;
    expect((await e.call('GET', `/years/${yearId}/conclude-info`)).body).toMatchObject({ year: 2025, nextYear: 2026, isEuroChangeover: true });
    // A 2026 posting made on the BGN chart is re-pointed to the EUR chart.
    expect((await e.call('POST', '/years', { year: 2026 })).status).toBe(201);
    expect((await e.call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
    const wrong = await e.post({ date: '2026-01-15', dr: [['501', 100, { currencyAmount: '195.58' }]], cr: [['702', 100, { currencyAmount: '195.58' }]] });
    const missing = await e.call('POST', `/years/${yearId}/conclude`, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('Не е избрана сметка за обиране на разлики от превалутирането!');
    // The account may be picked on the 2025 (BGN) chart; its EUR counterpart is used.
    const r = await e.call('POST', `/years/${yearId}/conclude`, { differencesAccountId: bgn['609'] });
    expect(r.status, r.text).toBe(200);
    expect(r.body.difference).toBe('0.01');
    await e.reloadAccounts();
    const d = await e.driver.company(e.companyDb);
    const rows = await queryRows<{ number: string; is_euro: boolean; company_id: number | null; dr: string; cr: string }>(d, sql`
      SELECT ac.number, ac.is_euro, dt.company_id, SUM(dt.amount)::numeric(19,2)::text AS dr, SUM(dt.ref_amount)::numeric(19,2)::text AS cr
      FROM accountings a JOIN financial_years fy ON fy.id = a.financial_year_id JOIN accounting_details dt ON dt.accounting_id = a.id JOIN accounts ac ON ac.id = dt.account_id
      WHERE fy.year = 2026 AND a.is_initial_balance GROUP BY ac.number, ac.is_euro, dt.company_id ORDER BY ac.number`);
    expect(rows.map((x) => [x.number, x.is_euro, x.company_id, x.dr, x.cr])).toEqual([
      ['401', true, sup, '0.00', '511.29'],
      ['501', true, null, '511.29', '0.00'],
      ['602', true, null, '511.29', '0.00'],
      ['609', true, null, '0.01', '0.00'],
      ['701', true, null, '0.00', '204.52'],
      ['702', true, null, '0.00', '306.78'],
    ]);
    const dr = rows.reduce((s, x) => s + Number(x.dr), 0), cr = rows.reduce((s, x) => s + Number(x.cr), 0);
    expect(dr.toFixed(2)).toBe(cr.toFixed(2));
    // BGN accounts are mapped to the EUR accounts with the same number; the partner is linked to the EUR account.
    const mapped = await queryRows<{ mapped: string | null }>(d, sql`SELECT m.number AS mapped FROM accounts a LEFT JOIN accounts m ON m.id = a.mapped_account_id WHERE a.id = ${bgn['501']!} AND m.is_euro`);
    expect(mapped).toEqual([{ mapped: '501' }]);
    const links = await queryRows<{ n: number }>(d, sql`SELECT count(*)::int AS n FROM company_accounts WHERE company_id = ${sup} AND account_id = ${e.acc('401')}`);
    expect(links[0]!.n).toBe(1);
    const moved = await entry(e, wrong.id);
    expect([lines(moved.debits), lines(moved.credits)]).toEqual([[[e.acc('501'), '100.00']], [[e.acc('702'), '100.00']]]);
    expect(e.acc('501')).not.toBe(bgn['501']);
    // The chosen account is remembered (as its EUR account).
    const cfg = await queryRows<{ value: string }>(d, sql`SELECT value FROM configuration WHERE key = 'AccountForCollectingDifferences'`);
    expect(cfg.map((c) => Number(c.value))).toEqual([e.acc('609')]);
  });
});
