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
    // Embedded database is verified; plain HTTP in tests is only a warning.
    expect(rule(r.body, 'Базата данни')).toBe('verified');
    expect(rule(r.body, 'Криптирана')).toBe('warning');
    expect(r.body.overall).toBe('warning');
  });
});

describe('platform services', () => {
  it('logs logins and failed logins in the application log', async () => {
    const saved = t.session.get();
    await t.call('POST', '/login', { companyDb: t.companyDb, userId: 1, password: 'wrong' });
    t.session.set(saved);
    const log = (await t.call('GET', '/app-log')).body as { level: string; message: string }[];
    expect(log[0]).toMatchObject({ level: 'warning', message: 'Неуспешно вписване на потребител Администратор' });
  });

  it('reports the active database (Ctrl+Shift+F8) and the version', async () => {
    const info = (await t.call('GET', '/session/database-info')).body;
    expect(info).toMatchObject({ company: 'Тест ООД', database: t.companyDb, version: '1.01.089' });
    expect(info.engine).toMatch(/PostgreSQL/);
    expect((await t.call('GET', '/version')).body.version).toBe('1.01.089');
  });
});
