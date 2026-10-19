/**
 * Smoke test of a running server (the release bundle, a Docker container or
 * a deployment): health, the UI and its headers, first-run setup with the
 * token, login, an entry, a report, an Excel file, a backup and its restore.
 *
 *   node scripts/release-smoke.ts http://localhost:3000 [setup-token]
 *
 * On a server that already has the smoke company it logs in instead of
 * creating it. Exits non-zero on the first failure.
 */
export {};

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const token = process.argv[3] ?? process.env.SHMI_SETUP_TOKEN;
const COMPANY = 'Смоук Тест ООД';
const PASSWORD = 'smoke-Pa55!';

let cookie = '';
async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any; bytes: Uint8Array; headers: Headers }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) cookie = c.split(';')[0]!;
  const bytes = new Uint8Array(await res.arrayBuffer());
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch { /* not JSON */ }
  return { status: res.status, json, bytes, headers: res.headers };
}

function check(ok: unknown, what: string, detail?: unknown): asserts ok {
  if (!ok) {
    console.error(`FAIL ${what}`, detail ?? '');
    process.exit(1);
  }
  console.log(`ok   ${what}`);
}

const health = await call('GET', '/api/health');
check(health.status === 200 && health.json?.ok === true && typeof health.json.version === 'string', `health ${JSON.stringify(health.json)}`);

const page = await fetch(base + '/');
const html = await page.text();
check(page.status === 200 && html.includes('<div id="root">'), 'UI index.html');
check(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), 'CSP header');
check(page.headers.get('x-content-type-options') === 'nosniff', 'nosniff header');
const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
check(script && (await fetch(base + script)).status === 200, `UI bundle ${script}`);

const setup = await call('GET', '/api/setup');
check(setup.status === 200, `setup status ${JSON.stringify(setup.json)}`);
const companies = (await call('GET', '/api/companies')).json as { name: string; companyName: string }[];
let db = companies.find((c) => c.companyName === COMPANY)?.name;
if (!db) {
  const body = { companyName: COMPANY, adminName: 'Администратор', adminPassword: PASSWORD, year: 2026, bulstat: '831641791', setupToken: token };
  if (setup.json.setupTokenRequired) {
    const without = await call('POST', '/api/companies', { ...body, setupToken: undefined });
    check(without.status === 403, 'first company refused without the setup token');
  }
  const created = await call('POST', '/api/companies', body);
  check(created.status === 201, 'first company created', created.json);
  db = created.json.name as string;
} else {
  const login = await call('POST', '/api/login', { companyDb: db, userId: 1, password: PASSWORD });
  check(login.status === 200, 'login', login.json);
}

const session = await call('GET', '/api/session');
check(session.status === 200 && session.json.baseCurrency === 'EUR', 'session (EUR year)');
const accounts = (await call('GET', '/api/accounts')).json as { id: number; number: string }[];
const acc = (n: string) => accounts.find((a) => a.number === n)!.id;
const today = '2026-03-15';
const entry = await call('POST', '/api/entries', {
  accountingDate: today, documentDate: today, documentTypeId: 1, documentNumber: String(Date.now() % 1e9), term: 'Смоук', companyId: null,
  debits: [{ accountId: acc('501'), amount: '120.50' }], credits: [{ accountId: acc('101'), amount: '120.50' }],
});
check(entry.status === 201, 'journal entry posted', entry.json);
const tb = await call('GET', '/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
check(tb.status === 200 && Number(tb.json.totals?.debitTurnover) >= 120.5, `trial balance turnover ${tb.json.totals?.debitTurnover}`);

const tpl = await call('POST', '/api/exchange/excel/template', {
  entity: 'operations', mapping: { sheetName: 'Данни', startingRow: 2, endingRow: 100, columns: { Accounts: 'A', Sums: 'B', Date: 'C' } },
});
check(tpl.status === 200 && tpl.bytes[0] === 0x50 && tpl.bytes[1] === 0x4b, 'Excel template (.xlsx)');

const backup = await call('POST', '/api/backups');
check(backup.status === 201, 'backup created', backup.json);
const file = await call('GET', `/api/backups/${backup.json.id}/download`);
check(file.status === 200 && file.bytes.length > 100, `backup downloaded (${file.bytes.length} bytes)`);
const restored = await call('POST', '/api/backups/restore', { id: backup.json.id, mode: 'new' });
check(restored.status === 200 && restored.json.asNew, 'backup restored as a new company', restored.json);
const after = await call('GET', '/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
check(after.status === 200 && JSON.stringify(after.json) === JSON.stringify(tb.json), 'restored company has the same trial balance');

check((await call('POST', '/api/logout')).status === 200, 'logout');
check((await call('GET', '/api/session')).status === 401, 'session ended');
console.log(`smoke test passed against ${base} (${health.json.version})`);
