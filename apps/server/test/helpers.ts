import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { PgliteDriver, PostgresDriver, type DbDriver } from '../src/db/provider.ts';

export interface CallResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
  text: string;
}

type Line = [account: string, amount: string | number, extra?: Record<string, unknown>];

export interface EntrySpec {
  date: string;
  docType?: number | null;
  docNumber?: string;
  docDate?: string;
  term?: string;
  partner?: number | null;
  dr: Line[];
  cr: Line[];
  [k: string]: unknown;
}

/**
 * Postgres test mode (TEST_DATABASE_URL=postgres://user:pass@host:port/postgres):
 * every test driver gets a catalog database of its own (shmit_<random>) on that
 * server; it and every company database created through it are dropped on close().
 */
class TestPostgresDriver extends PostgresDriver {
  private created = new Set<string>();
  private adminUrl: string;
  private catalogName: string;
  private closed = false;
  constructor(adminUrl: string, catalogName: string, url: string) {
    super(url);
    this.adminUrl = adminUrl;
    this.catalogName = catalogName;
  }

  override async createCompanyDatabase(name: string) {
    this.created.add(name);
    return super.createCompanyDatabase(name);
  }

  override async close() {
    if (this.closed) return;
    this.closed = true;
    await super.close();
    const admin = new pg.Client({ connectionString: this.adminUrl });
    await admin.connect();
    try {
      for (const name of [...this.created, this.catalogName]) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
}

/** Drivers not closed by their test file; slot-setup.ts closes them after the file. */
export const openTestDrivers = new Set<DbDriver>();

/** The storage of a test server: in-memory PGlite, or a real Postgres server with TEST_DATABASE_URL. */
export async function createTestDriver(): Promise<DbDriver> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) return new PgliteDriver();
  const catalogName = `shmit_${process.pid}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${catalogName}" ENCODING 'UTF8'`);
  } finally {
    await admin.end();
  }
  const u = new URL(adminUrl);
  u.pathname = '/' + catalogName;
  const driver = new TestPostgresDriver(adminUrl, catalogName, u.toString());
  openTestDrivers.add(driver);
  const close = driver.close.bind(driver);
  driver.close = async () => {
    openTestDrivers.delete(driver);
    await close();
  };
  return driver;
}

/**
 * Test harness: an in-memory server with one freshly created company and a
 * logged-in administrator. Each test file gets its own instance.
 */
export async function createTestCompany(opts: { year?: number; companyName?: string; bulstat?: string; chartTemplate?: 'commercial' | 'nonProfit' | 'budget' } = {}) {
  const driver = await createTestDriver();
  const app = createApp(driver);
  let cookie = '';

  async function call<T = any>(method: string, url: string, body?: unknown): Promise<CallResult<T>> {
    const res = await app.request(`/api${url}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const set of res.headers.getSetCookie()) cookie = set.split(';')[0]!;
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T, headers: res.headers, text };
  }

  const created = await call('POST', '/companies', {
    companyName: opts.companyName ?? 'Тест ООД', bulstat: opts.bulstat ?? '831641791',
    adminName: 'Администратор', adminPassword: 'secret1', year: opts.year ?? 2026, chartTemplate: opts.chartTemplate,
  });
  expect(created.status, created.text).toBe(201);
  const companyDb = created.body.name as string;

  let accounts: { id: number; number: string }[] = (await call('GET', '/accounts')).body;
  const reloadAccounts = async () => {
    accounts = (await call('GET', '/accounts')).body;
  };
  const acc = (n: string) => {
    const a = accounts.find((x) => x.number === n);
    if (!a) throw new Error(`No account ${n}`);
    return a.id;
  };

  /** Creates a partner linked to the given accounts and returns its id. */
  async function partner(name: string, accountNumbers: string[] = ['411'], extra: Record<string, unknown> = {}) {
    const r = await call('POST', '/partners', { name, accountIds: accountNumbers.map(acc), ...extra });
    expect(r.status, r.text).toBe(201);
    return r.body.id as number;
  }

  const line = ([account, amount, extra]: Line) => ({ accountId: acc(account), amount: String(amount), ...extra });

  /** Posts a journal entry; asserts success and returns { id, number, warnings }. */
  async function post(e: EntrySpec) {
    const r = await tryPost(e);
    expect(r.status, r.text).toBe(201);
    return r.body as { id: number; number: string; warnings: { key: string }[] };
  }

  function tryPost(e: EntrySpec) {
    const { date, docType, docNumber, docDate, term, partner: companyId, dr, cr, ...rest } = e;
    return call('POST', '/entries', {
      accountingDate: date, documentDate: docDate ?? date, documentTypeId: docType === undefined ? 1 : docType,
      documentNumber: docNumber ?? String(Math.floor(Math.random() * 1e9)), term: term ?? 'Тест', companyId: companyId ?? null,
      debits: dr.map(line), credits: cr.map(line), ...rest,
    });
  }

  const session = { get: () => cookie, set: (v: string) => { cookie = v; } };

  return { driver, app, call, session, acc, reloadAccounts, partner, post, tryPost, companyDb, close: () => driver.close() };
}

export type TestCompany = Awaited<ReturnType<typeof createTestCompany>>;
