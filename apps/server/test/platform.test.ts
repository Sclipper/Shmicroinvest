import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isFullName, isGdprPassword } from '../src/services/gdpr.ts';
import { createTestCompany, type TestCompany } from './helpers.ts';

let t: TestCompany;
beforeAll(async () => {
  t = await createTestCompany();
}, 60_000);
afterAll(() => t.close());

const rule = (body: { rules: { rule: string; status: string }[] }, prefix: string) => body.rules.find((r) => r.rule.startsWith(prefix))!.status;

describe('GDPR validator (06 9)', () => {
  it('password and name rules', () => {
    expect(isGdprPassword('Pa$$w0rd')).toBe(true);
    expect(isGdprPassword('Пар0ла!А')).toBe(true); // Cyrillic letters count
    expect(isGdprPassword('Pa$w0')).toBe(false); // too short
    expect(isGdprPassword('pa$$w0rd')).toBe(false); // no upper
    expect(isGdprPassword('Passw0rd')).toBe(false); // no special
    expect(isGdprPassword('Pa$$word')).toBe(false); // no digit
    expect(isFullName('Иван Петров')).toBe(true);
    expect(isFullName('Администратор')).toBe(false);
  });

  it('fails with one user and a weak password, passes the user rules after fixing them', async () => {
    let r = await t.call('GET', '/gdpr/validate');
    expect(r.status).toBe(200);
    expect(rule(r.body, 'Поне двама')).toBe('error');
    expect(rule(r.body, 'Сложни пароли')).toBe('error'); // 'secret1' at company creation
    expect(rule(r.body, 'Имената')).toBe('warning');
    expect(r.body.overall).toBe('error');

    await t.call('POST', '/users', { name: 'Иван Петров', password: 'Pa$$w0rd', roleId: 5 });
    await t.call('PUT', '/me/password', { current: 'secret1', password: 'Adm1n!pass' });
    r = await t.call('GET', '/gdpr/validate');
    expect(rule(r.body, 'Поне двама')).toBe('verified');
    expect(rule(r.body, 'Сложни пароли')).toBe('verified');
    expect(rule(r.body, 'Всички потребители имат парола')).toBe('verified');
    // Embedded database (or a password-protected Postgres connection) is verified; plain HTTP in tests is only a warning.
    expect(rule(r.body, t.driver.kind === 'pglite' ? 'Базата данни' : 'Връзката към базата данни')).toBe('verified');
    expect(rule(r.body, 'Криптирана')).toBe('warning');
    expect(r.body.overall).toBe('warning');
  });
});

describe('platform services', () => {
  it('settings with an unknown key are refused as a whole', async () => {
    const value = async () => (await t.call('GET', '/settings')).body.find((x: { key: string }) => x.key === 'IsOptionalReferenceEnabled').value;
    const before = await value();
    const r = await t.call('PUT', '/settings', { IsOptionalReferenceEnabled: before === 'True' ? 'False' : 'True', Foo: 'x' });
    expect(r.status).toBe(400);
    expect(await value()).toBe(before);
  });

  it('logs logins and failed logins in the application log', async () => {
    const saved = t.session.get();
    await t.call('POST', '/login', { companyDb: t.companyDb, userId: 1, password: 'wrong' });
    t.session.set(saved);
    const log = (await t.call('GET', '/app-log')).body as { level: string; message: string }[];
    expect(log[0]).toMatchObject({ level: 'warning', message: 'Неуспешно вписване на потребител Администратор' });
  });

  it('a failure in the browser (strProblemExporting) is written to the log of the company and the user', async () => {
    const r = await t.call('POST', '/app-log/client-error', { context: 'Експорт: Оборотна ведомост (PDF)', message: 'Failed to fetch dynamically imported module', details: 'TypeError: Failed to fetch\n    at reportFile' });
    expect(r.status, r.text).toBe(200);
    const log = (await t.call('GET', '/app-log')).body as { level: string; message: string; company?: string; user?: string; details?: string }[];
    expect(log[0]).toMatchObject({ level: 'error', message: 'Експорт: Оборотна ведомост (PDF): Failed to fetch dynamically imported module', company: t.companyDb, user: 'Администратор' });
    expect(log[0]!.details).toContain('reportFile');
    expect((await t.call('POST', '/app-log/client-error', { context: '', message: 'x' })).status).toBe(400);
    expect((await t.call('POST', '/app-log/client-error', { context: 'x', message: 'y'.repeat(2001) })).status).toBe(400);
  });

  it('shows only the entries of the active company', async () => {
    const { logApp } = await import('../src/services/appLog.ts');
    await logApp({ level: 'error', message: 'Грешка в друга фирма', company: 'other_company_db' });
    const log = (await t.call('GET', '/app-log')).body as { message: string; company?: string }[];
    expect(log.map((e) => e.message)).not.toContain('Грешка в друга фирма');
    expect(log.every((e) => !e.company || e.company === t.companyDb)).toBe(true);
  });

  it('reports the active database (Ctrl+Shift+F8) and the version', async () => {
    const info = (await t.call('GET', '/session/database-info')).body;
    expect(info).toMatchObject({ company: 'Тест ООД', database: t.companyDb, version: '1.01.089' });
    expect(info.engine).toMatch(/PostgreSQL/);
    expect((await t.call('GET', '/version')).body.version).toBe('1.01.089');
  });
});

describe('bad input', () => {
  it('a non-numeric id or limit is a 400 with a Bulgarian message, not a 500', async () => {
    const r = await t.call('GET', '/accounts/abc/delete-info');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Невалидни данни.');
    expect((await t.call('GET', '/entries?limit=abc')).status).toBe(400);
    const z = await t.call('POST', '/partners', { name: 5 });
    expect(z.status).toBe(400);
    expect(z.body.error).toMatch(/^Невалидни данни \(name\): Невалиден вход/);
  });
});

describe('login lock-out', () => {
  it('locks a user out after three failures, also for the right password', async () => {
    const u = await t.call('POST', '/users', { name: 'Заключван', password: 'secret1', roleId: 5 });
    expect(u.status, u.text).toBe(201);
    const saved = t.session.get();
    try {
      for (let i = 0; i < 3; i++) expect((await t.call('POST', '/login', { companyDb: t.companyDb, userId: u.body.id, password: 'wrong' })).status).toBe(401);
      expect((await t.call('POST', '/login', { companyDb: t.companyDb, userId: u.body.id, password: 'secret1' })).status).toBe(429);
    } finally {
      t.session.set(saved);
    }
  });
});
