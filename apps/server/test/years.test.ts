import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { defaultActiveYear, listToMask, SCHEDULER_MODE } from '@shmi/core';
import { createTestCompany, type TestCompany } from './helpers.ts';
import * as schema from '../src/db/company/schema/index.ts';
import { todayInSofia } from '../src/session.ts';

/** Financial years (Счетоводна година, 01b 6.3; login 06 4.1; activity log 01b 8). */
let t: TestCompany;
let call: TestCompany['call'];
const id: Record<number, number> = {};
let reschedOnly2025: number;
let reschedAcross: number;
let sharedSeries: number;
const ADMIN = { userId: 1, password: 'secret1' };

const keys = (r: { body: { messages?: { key: string }[] } }) => (r.body.messages ?? []).map((m) => m.key);
const years = async () => {
  for (const y of (await call('GET', '/years')).body as { id: number; year: number }[]) id[y.year] = y.id;
};
const sessionYear = async () => (await call('GET', '/session')).body.year.year as number;
const login = (userId: number, password: string) => call('POST', '/login', { companyDb: t.companyDb, userId, password });
const log = async () => (await call('GET', '/activity?limit=50')).body as { activity: string; entityType: string; entityId: number; description: string }[];

beforeAll(async () => {
  t = await createTestCompany({ year: 2025, companyName: 'Години ООД' });
  call = t.call;
  await years();
  // 2025 work that the deletion of 2025 must clean up: reschedules and a template schedule.
  const card = (name: string, fromDate: string, toDate: string) => call('POST', '/reschedules', {
    name, amount: '300', documentTypeId: 1, documentNumber: name, documentDate: fromDate, fromDate, toDate, isRescheduleByDays: false,
    debitAccountId: t.acc('609'), creditAccountId: t.acc('651'), term: 'Разсрочване',
  });
  reschedOnly2025 = (await card('Само 2025', '2025-03-01', '2025-05-31')).body.id;
  reschedAcross = (await card('2025-2026', '2025-11-01', '2026-01-31')).body.id;
  expect((await call('POST', '/reschedules/process', { toMonth: '2025-12', ids: [reschedOnly2025, reschedAcross] })).status).toBe(200);
  const tpl = await call('POST', '/templates', {
    name: 'Наем', documentTypeId: 10, term: 'Наем', debits: [{ accountId: t.acc('602'), amount: '100' }], credits: [{ accountId: t.acc('503'), amount: '100' }],
    schedule: { mode: SCHEDULER_MODE.Monthly, interval: 1, weekDays: 0, months: listToMask([1, 2, 3]), days: listToMask([5]) },
  });
  expect(tpl.status, tpl.text).toBe(201);
  expect((await call('POST', `/templates/${tpl.body.id}/schedule/generate`)).status).toBe(200);
  const rows = (await call('GET', '/template-schedules?from=2025-01-01&to=2025-12-31')).body as { id: number }[];
  expect((await call('POST', '/template-schedules/process', { ids: rows.map((r) => r.id) })).status).toBe(200);
}, 60_000);
afterAll(() => t.close());

describe('financial years (01b 6.3)', () => {
  it('asks to conclude the previous year before creating the next one and copies the users\' numbering', async () => {
    // A shared series and a yearly-reset series chosen by the admin in 2025.
    const series = async (channel: number, prefix: string, reset: boolean) => {
      const r = await call('POST', '/settings/sequences', { channel, prefix, separator: '-', selectedNumberLength: 6, startNumber: 1, isNumberResetNextYear: reset });
      expect(r.status, r.text).toBe(201);
      expect((await call('POST', `/settings/sequences/${r.body.id}/activate`)).status).toBe(200);
      return r.body.id as number;
    };
    const shared = await series(2, 'СП', false);
    sharedSeries = shared;
    const reset = await series(3, 'НУ', true);

    const ask = await call('POST', '/years', { year: 2026 });
    expect([ask.status, ask.body.code, keys(ask)]).toEqual([409, 'strNextFinancialYearConcludePreviousWarning', ['strNextFinancialYearConcludePreviousWarning']]);
    expect(ask.body.error).toBe('За да бъде създадена следващата счетоводна година, годината преди нея трябва да бъде приключена. Желаете ли да продължите?');
    expect((await call('GET', '/years')).body).toHaveLength(1);
    const made = await call('POST', '/years', { year: 2026, force: true });
    expect(made.status, made.text).toBe(201);
    await years();
    // An earlier year is created without the question.
    expect((await call('POST', '/years', { year: 2024 })).status).toBe(201);
    await years();

    const db = await t.driver.company(t.companyDb);
    const copied = await db.select({ seq: schema.sequences }).from(schema.userSequences)
      .innerJoin(schema.sequences, eq(schema.sequences.id, schema.userSequences.sequenceId))
      .where(and(eq(schema.userSequences.userId, 1), eq(schema.userSequences.financialYearId, id[2026]!)));
    const byChannel = new Map(copied.map((c) => [c.seq.channel, c.seq]));
    expect(byChannel.get(2)!.id).toBe(shared);
    // The yearly-reset series starts again from 1 with the plain format in the new year.
    expect(byChannel.get(3)!.id).not.toBe(reset);
    expect(byChannel.get(3)).toMatchObject({ format: '[#]', lastNumber: 0, numericLength: 10, isNumberResetNextYear: true, financialYearId: id[2026] });

    const added = (await log()).filter((r) => r.entityType === 'financialYear' && r.activity === 'add').map((r) => r.description);
    expect(added).toEqual(['Счетоводна година 2024', 'Счетоводна година 2026']);
  });

  it('2026 needs the euro changeover; at login an unconverted 2026 falls back to 2025 (06 4.1)', async () => {
    const ask = await call('PUT', '/years/active', { year: 2026 });
    expect([ask.status, ask.body.code]).toEqual([409, 'strSelect2026yearMessage']);
    expect(ask.body.error).toBe('За да преминете в счетоводна година 2026, годината преди нея трябва да бъде приключена. Желаете ли да продължите?');
    expect(await sessionYear()).toBe(2025);
    // Stored 2026 (forced through the API), then a new login: back to 2025.
    expect((await call('PUT', '/years/active', { year: 2026, force: true })).status).toBe(200);
    expect(await sessionYear()).toBe(2026);
    expect((await login(ADMIN.userId, ADMIN.password)).status).toBe(200);
    expect(await sessionYear()).toBe(2025);

    // The 2025 -> 2026 transfer maps the chart: 2026 is selectable and kept at login.
    const done = await call('POST', `/years/${id[2025]}/conclude`, {});
    expect(done.status, done.text).toBe(200);
    expect((await call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
    expect((await login(ADMIN.userId, ADMIN.password)).status).toBe(200);
    expect(await sessionYear()).toBe(2026);
    expect((await log()).some((r) => r.entityType === 'financialYear' && r.entityId === id[2025] && r.description === 'Счетоводната година 2025 е приключена успешно!')).toBe(true);
  });

  it('a user without a stored year starts in the current year, not the latest', async () => {
    expect((await call('POST', '/years', { year: 2027, force: true })).status).toBe(201);
    await years();
    const u = await call('POST', '/users', { name: 'Нов счетоводител', password: 'parola1', roleId: 2 });
    expect(u.status, u.text).toBe(201);
    expect((await login(u.body.id, 'parola1')).status).toBe(200);
    const expected = defaultActiveYear(Object.keys(id).map(Number), todayInSofia());
    expect(await sessionYear()).toBe(expected);
    expect(expected).not.toBe(2027);
    expect((await login(ADMIN.userId, ADMIN.password)).status).toBe(200);
  });

  it('moves the working date with the chosen year', async () => {
    const before = (await call('GET', '/session')).body.workingDate as string;
    const r = await call('PUT', '/years/active', { year: 2027 });
    expect(r.status, r.text).toBe(200);
    const s = (await call('GET', '/session')).body;
    expect([s.year.year, s.workingDate.slice(0, 4), s.workingDate.slice(5)]).toEqual([2027, '2027', before.slice(5) === '02-29' ? '02-28' : before.slice(5)]);
    expect((await call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
  });

  it('logs locking and unlocking (01b 8)', async () => {
    expect((await call('PUT', `/years/${id[2027]}/locks`, { lockYear: true })).status).toBe(200);
    expect((await call('PUT', `/years/${id[2027]}/locks`, { lockYear: false })).status).toBe(200);
    expect((await call('PUT', `/years/${id[2027]}/locks`, { months: [1, 2] })).status).toBe(200);
    const rows = (await log()).filter((r) => r.entityType === 'financialYear' && r.entityId === id[2027]).map((r) => r.description);
    expect(rows.slice(0, 3)).toEqual(['Заключени месеци на 2027: Ян, Фев', 'Отключване на счетоводна година 2027', 'Заключване на счетоводна година 2027']);
    await call('PUT', `/years/${id[2027]}/locks`, { months: [] });
  });

  it('deletes the earliest year: schedules and reschedules become unprocessed, reschedules of that year only go', async () => {
    // Only the earliest year can go: 2024, then 2025.
    const notFirst = await call('DELETE', `/years/${id[2025]}`);
    expect(notFirst.body.error).toBe('Счетоводната година не може да бъде изтрита, защото има активни години преди нея.');
    expect((await call('DELETE', `/years/${id[2024]}`)).status).toBe(200);
    const r = await call('DELETE', `/years/${id[2025]}`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.message).toBe('Счетоводната година 2025 е изтрита успешно!');

    expect((await call('GET', `/reschedules/${reschedOnly2025}`)).status).toBe(404);
    const card = (await call('GET', `/reschedules/${reschedAcross}`)).body as { details: { month: string; isProcessed: boolean; accountingId: number | null }[] };
    expect(card.details.map((d) => [d.month.slice(0, 7), d.isProcessed])).toEqual([['2025-11', false], ['2025-12', false], ['2026-01', false]]);
    const schedules = (await call('GET', '/template-schedules?processed=all&from=2025-01-01&to=2025-12-31')).body as { isProcessed: boolean; accountingId: number | null }[];
    expect(schedules).toHaveLength(3);
    expect(schedules.every((x) => !x.isProcessed && x.accountingId === null)).toBe(true);
    // The 2026 numbering still works after its 2025 series went.
    await t.reloadAccounts();
    const e = await t.post({ date: '2026-03-01', dr: [['501', 1]], cr: [['101', 1]] });
    expect(e.number).toMatch(/^\d+$/);
    // The shared series created in 2025 and still used in 2026 moves to 2026.
    const db = await t.driver.company(t.companyDb);
    const [moved] = await db.select().from(schema.sequences).where(eq(schema.sequences.id, sharedSeries));
    expect(moved?.financialYearId).toBe(id[2026]);
    const deleted = (await log()).filter((x) => x.entityType === 'financialYear' && x.activity === 'delete').map((x) => x.description);
    expect(deleted).toEqual(['Счетоводна година 2025', 'Счетоводна година 2024']);
  });
});
