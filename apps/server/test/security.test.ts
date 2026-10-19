import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.ts';
import type { DbDriver } from '../src/db/provider.ts';
import { APP_VERSION } from '../src/runtime.ts';
import { createTestCompany, createTestDriver, type TestCompany } from './helpers.ts';

/**
 * Hardening for a public URL: first-run setup token, session cookie flags and
 * expiry, security headers, request body limits, login limiting by IP and
 * error responses without internals.
 */

const ENV_KEYS = ['SHMI_SETUP_TOKEN', 'NODE_ENV', 'TRUST_PROXY', 'MAX_JSON_BODY_MB', 'MAX_UPLOAD_MB', 'LOGIN_IP_MAX_FAILURES', 'SESSION_IDLE_MINUTES'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const firstCompany = { companyName: 'Първа ООД', adminName: 'Администратор', adminPassword: 'secret1', year: 2026 };

/** A server without any company (first run). */
async function emptyServer() {
  const driver = await createTestDriver();
  const app = createApp(driver);
  const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`/api${url}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { driver, app, req };
}

const drivers: DbDriver[] = [];
afterAll(async () => {
  for (const d of drivers) await d.close();
});

describe('first-run setup token', () => {
  it('needs no token in development without SHMI_SETUP_TOKEN', async () => {
    delete process.env.SHMI_SETUP_TOKEN;
    delete process.env.NODE_ENV;
    const s = await emptyServer();
    drivers.push(s.driver);
    expect(await (await s.req('GET', '/setup')).json()).toEqual({ firstRun: true, setupTokenRequired: false });
    expect((await s.req('POST', '/companies', firstCompany)).status).toBe(201);
    expect(await (await s.req('GET', '/setup')).json()).toEqual({ firstRun: false, setupTokenRequired: false });
  });

  it('requires SHMI_SETUP_TOKEN for the first company when it is set', async () => {
    process.env.SHMI_SETUP_TOKEN = 'tok-3f9a';
    const s = await emptyServer();
    drivers.push(s.driver);
    expect(await (await s.req('GET', '/setup')).json()).toEqual({ firstRun: true, setupTokenRequired: true });

    const missing = await s.req('POST', '/companies', firstCompany);
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ code: 'setupToken', error: 'Въведете ключа за инсталация (SHMI_SETUP_TOKEN).' });
    const wrong = await s.req('POST', '/companies', { ...firstCompany, setupToken: 'tok-0000' });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ code: 'setupToken', error: 'Невалиден ключ за инсталация.' });
    expect(await (await s.req('GET', '/companies')).json()).toEqual([]);

    const ok = await s.req('POST', '/companies', { ...firstCompany, setupToken: ' tok-3f9a ' });
    expect(ok.status).toBe(201);
    // Afterwards the token plays no part: only a logged-in user with the right creates companies.
    expect(await (await s.req('GET', '/setup')).json()).toEqual({ firstRun: false, setupTokenRequired: false });
    expect((await s.req('POST', '/companies', { ...firstCompany, setupToken: 'tok-3f9a' })).status).toBe(403);
  });

  it('always requires a token in production (generated when SHMI_SETUP_TOKEN is not set)', async () => {
    delete process.env.SHMI_SETUP_TOKEN;
    process.env.NODE_ENV = 'production';
    const s = await emptyServer();
    drivers.push(s.driver);
    expect(await (await s.req('GET', '/setup')).json()).toEqual({ firstRun: true, setupTokenRequired: true });
    expect((await s.req('POST', '/companies', firstCompany)).status).toBe(403);
    const { setupToken } = await import('../src/services/setup.ts');
    const token = setupToken();
    expect(token).toMatch(/^[\w-]{20,}$/);
    expect((await s.req('POST', '/companies', { ...firstCompany, setupToken: token })).status).toBe(201);
  });

  it('limits wrong setup tokens per client IP', async () => {
    process.env.SHMI_SETUP_TOKEN = 'tok-limit';
    process.env.TRUST_PROXY = '1';
    process.env.LOGIN_IP_MAX_FAILURES = '3';
    const s = await emptyServer();
    drivers.push(s.driver);
    const from = (ip: string) => ({ 'x-forwarded-for': `203.0.113.250, ${ip}` });
    for (let i = 0; i < 3; i++) expect((await s.req('POST', '/companies', { ...firstCompany, setupToken: 'nope' }, from('198.51.100.7'))).status).toBe(403);
    const blocked = await s.req('POST', '/companies', { ...firstCompany, setupToken: 'tok-limit' }, from('198.51.100.7'));
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ code: 'ipLimit' });
    expect((await s.req('POST', '/companies', { ...firstCompany, setupToken: 'tok-limit' }, from('198.51.100.8'))).status).toBe(201);
  });
});

describe('a server with a company', () => {
  let t: TestCompany;
  beforeAll(async () => {
    t = await createTestCompany();
  }, 60_000);
  afterAll(() => t.close());

  const login = (headers: Record<string, string> = {}, password = 'secret1', url = 'http://localhost/api/login') =>
    t.app.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ companyDb: t.companyDb, userId: 1, password }) });

  it('sets an HttpOnly, SameSite=Lax session cookie, Secure only over HTTPS', async () => {
    const plain = (await login()).headers.getSetCookie().at(-1)!;
    expect(plain).toMatch(/^shmi_sid=[\w-]{40,}; Max-Age=1209600; Path=\/; HttpOnly; SameSite=Lax$/);

    expect((await login({}, 'secret1', 'https://shmelta.example/api/login')).headers.getSetCookie().join()).toMatch(/; Secure/);

    // X-Forwarded-Proto counts only behind a trusted proxy.
    expect((await login({ 'x-forwarded-proto': 'https' })).headers.getSetCookie().join()).not.toMatch(/Secure/);
    process.env.TRUST_PROXY = '1';
    expect((await login({ 'x-forwarded-proto': 'https' })).headers.getSetCookie().join()).toMatch(/; HttpOnly; Secure; SameSite=Lax/);
  });

  it('ends a session after the idle timeout', async () => {
    const res = await login();
    const cookie = res.headers.getSetCookie().at(-1)!.split(';')[0]!;
    const get = () => t.app.request('/api/session', { headers: { cookie } });
    expect((await get()).status).toBe(200);
    const catalog = await t.driver.catalog();
    await catalog.execute(sql`UPDATE sessions SET last_seen_at = now() - interval '13 hours' WHERE id = ${cookie.split('=')[1]!}`);
    expect((await get()).status).toBe(401);
    // The expired session is gone, not only refused.
    const left = (await catalog.execute(sql`SELECT count(*)::int AS n FROM sessions WHERE id = ${cookie.split('=')[1]!}`)) as unknown as { rows: { n: number }[] };
    expect(left.rows[0]!.n).toBe(0);
  });

  it('honours SESSION_IDLE_MINUTES and the absolute lifetime', async () => {
    process.env.SESSION_IDLE_MINUTES = '5';
    const res = await login();
    const cookie = res.headers.getSetCookie().at(-1)!.split(';')[0]!;
    const id = cookie.split('=')[1]!;
    const catalog = await t.driver.catalog();
    await catalog.execute(sql`UPDATE sessions SET last_seen_at = now() - interval '6 minutes' WHERE id = ${id}`);
    expect((await t.app.request('/api/session', { headers: { cookie } })).status).toBe(401);

    delete process.env.SESSION_IDLE_MINUTES;
    const res2 = await login();
    const cookie2 = res2.headers.getSetCookie().at(-1)!.split(';')[0]!;
    await catalog.execute(sql`UPDATE sessions SET created_at = now() - interval '15 days' WHERE id = ${cookie2.split('=')[1]!}`);
    expect((await t.app.request('/api/session', { headers: { cookie: cookie2 } })).status).toBe(401);
  });

  it('sends the security headers on API and page responses', async () => {
    const r = await t.app.request('/api/health');
    expect(await r.json()).toEqual({ ok: true, version: APP_VERSION });
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('same-origin');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('permissions-policy')).toContain('camera=(self)');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('strict-transport-security')).toBeNull();
    // Not found and unauthorised responses carry them too.
    expect((await t.app.request('/api/nothing-here')).headers.get('x-content-type-options')).toBe('nosniff');

    expect((await t.app.request('https://shmelta.example/api/health')).headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect((await t.app.request('/api/health', { headers: { 'x-forwarded-proto': 'https' } })).headers.get('strict-transport-security')).toBeNull();
    process.env.TRUST_PROXY = '1';
    expect((await t.app.request('/api/health', { headers: { 'x-forwarded-proto': 'https' } })).headers.get('strict-transport-security')).toMatch(/max-age=/);
  });

  it('serves the web app with the same headers', async () => {
    const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'shmi-web-'));
    await mkdir(path.join(dir, 'assets'));
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>Ш</title>');
    await writeFile(path.join(dir, 'assets', 'app-1a2b.js'), 'console.log(1)');
    try {
      const app = createApp(t.driver, { serveWeb: true, webDist: dir });
      const page = await app.request('/');
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(page.headers.get('cache-control')).toBe('no-cache');
      const deep = await app.request('/some/client/route');
      expect(await deep.text()).toContain('<title>Ш</title>');
      expect(deep.headers.get('x-frame-options')).toBe('DENY');
      const asset = await app.request('/assets/app-1a2b.js');
      expect(asset.headers.get('cache-control')).toContain('immutable');
      expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
      // API paths never fall back to the page.
      expect((await app.request('/api/unknown')).headers.get('content-type')).toContain('application/json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('limits request bodies: small for JSON, larger for uploads', async () => {
    process.env.MAX_JSON_BODY_MB = '1';
    process.env.MAX_UPLOAD_MB = '3';
    const app = createApp(t.driver);
    const cookie = t.session.get();
    const big = (mb: number) => JSON.stringify({ text: 'x'.repeat(mb * 1024 * 1024) });
    const post = (url: string, body: string) => app.request(`/api${url}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body });

    const json = await post('/entries', big(1.5));
    expect(json.status).toBe(413);
    expect(await json.json()).toEqual({ error: 'Файлът или заявката е твърде голяма.', code: 'tooLarge' });

    // An import takes more: the body passes the limit and reaches the importer.
    const upload = await post('/exchange/text/import', big(1.5));
    expect(upload.status).not.toBe(413);
    expect((await post('/exchange/text/import', big(3.5))).status).toBe(413);

    // Without Content-Length (chunked) the limit still holds.
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode('x'.repeat(512 * 1024)));
        c.close();
      },
    });
    const chunked = await app.request('/api/entries', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: stream, duplex: 'half' } as RequestInit);
    expect(chunked.status).toBe(413);

    // Attachments (10 MB each by the spec) and backups are uploads too.
    const { isUploadRoute } = await import('../src/lib/security.ts');
    expect(isUploadRoute('/api/journal/entries/12/attachments')).toBe(true);
    expect(isUploadRoute('/api/backups/restore')).toBe(true);
    expect(isUploadRoute('/api/bank-statements/parse')).toBe(true);
    expect(isUploadRoute('/api/entries')).toBe(false);
  });

  it('limits failed logins per client IP besides the per-user lockout', async () => {
    process.env.TRUST_PROXY = '1';
    process.env.LOGIN_IP_MAX_FAILURES = '4';
    const app = createApp(t.driver);
    const attempt = (ip: string, password: string, userId = 999) =>
      app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ companyDb: t.companyDb, userId, password }) });
    // Different (unknown) users, so the per-user lockout does not kick in first.
    for (let i = 0; i < 4; i++) expect((await attempt('192.0.2.10', 'wrong', 900 + i)).status).toBe(401);
    const blocked = await attempt('192.0.2.10', 'secret1', 1);
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/^Твърде много неуспешни опити от този адрес/);
    expect((await attempt('192.0.2.11', 'secret1', 1)).status).toBe(200);
  });

  it('answers malformed JSON with 400 and hides internals of unexpected errors', async () => {
    const bad = await t.app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"companyDb":' });
    expect(bad.status).toBe(400);

    process.env.NODE_ENV = 'production';
    const driver = await createTestDriver();
    const app = createApp(driver);
    await driver.catalog();
    await driver.close();
    const origError = console.error;
    console.error = () => undefined;
    try {
      // The health check reports the unavailable database.
      expect((await app.request('/api/health')).status).toBe(503);
      const r = await app.request('/api/companies');
      expect(r.status).toBe(500);
      const text = await r.text();
      expect(JSON.parse(text)).toEqual({ error: 'Възникна неочаквана грешка.' });
      expect(text).not.toMatch(/at |\.ts:|Error:/);
    } finally {
      console.error = origError;
    }
  });
});
