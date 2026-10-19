/**
 * Response times of the heavy endpoints on a big company (see seed-volume.ts).
 *
 *   node apps/server/scripts/perf.ts [--db=<database>] [--data-dir=apps/server/.data-perf]
 *     [--runs=3] [--only=<regex>] [--skip=<regex>] [--json=<file>] [--in-place] [--verbose] [--case-timeout=<ms>] [--reset-stats]
 *
 * Every case goes through the app (app.request with a session, as the browser
 * does) and runs --runs times; the table shows p50 and max with the budget of
 * its group: interactive < 500 ms, report < 2 s, year-end < 30 s.
 *
 * PGlite: the data dir is copied to a temporary directory first, because some
 * cases write (entry save, payment binding, depreciation posting, closing,
 * year conclusion, backup); --in-place measures on the original instead.
 * Postgres (DATABASE_URL): runs on the database itself.
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { exec, queryRows } from '../src/db/provider.ts';
import { acquireTestSlot } from '../../../scripts/test-slots.ts';
import { DEFAULT_DATA_DIR, apiClient, fmtMs, openDriver, parseArgs } from './lib.ts';

const o = parseArgs();
const RUNS = Number(o.runs ?? 3);
const only = o.only ? new RegExp(o.only, 'i') : null;
const skip = o.skip ? new RegExp(o.skip, 'i') : null;
/** Stop the run when one request takes longer (the engine stays busy with it, so later cases would wait). */
const CASE_TIMEOUT = Number(o['case-timeout'] ?? 0);

const release = await acquireTestSlot(`perf (pid ${process.pid})`);
let dataDir = o['data-dir'] ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
let scratch: string | null = null;
if (!process.env.DATABASE_URL && !o['in-place']) {
  if (!existsSync(dataDir)) throw new Error(`No data dir ${dataDir}: run seed-volume.ts first.`);
  scratch = mkdtempSync(path.join(tmpdir(), 'shmi-perf-'));
  cpSync(dataDir, scratch, { recursive: true });
  dataDir = scratch;
  const dir = scratch;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(130);
  });
}
const driver = openDriver(dataDir);
const api = apiClient(driver);

const companies = await api.must<{ name: string; companyName: string }[]>('GET', '/companies');
const dbName = o.db ?? companies.map((c) => c.name).sort().pop();
if (!dbName) throw new Error('No company.');
await api.must('POST', '/login', { companyDb: dbName, userId: 1, password: 'secret1' });
const db = await driver.company(dbName);
if (o['reset-stats']) {
  // A database that was never analyzed (as PGlite left it before the server ran ANALYZE): for before/after runs.
  await exec(db, sql`DELETE FROM pg_statistic WHERE starelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)`);
  await exec(db, sql`UPDATE pg_class SET reltuples = -1, relpages = 0, relallvisible = 0 WHERE relnamespace = 'public'::regnamespace`);
  console.log('Planner statistics removed.');
}
if ('maintain' in driver) {
  // Up-to-date planner statistics first, as the server analyzes a company when it opens it.
  await (driver as { maintain: (n: string) => Promise<number> }).maintain(dbName);
}

const one = async <T>(q: ReturnType<typeof sql>) => (await queryRows<T>(db, q))[0]!;
const counts = await one<Record<string, number>>(sql`SELECT (SELECT count(*)::int FROM accountings) AS entries, (SELECT count(*)::int FROM accounting_details) AS legs,
  (SELECT count(*)::int FROM companies) AS partners, (SELECT count(*)::int FROM accounting_payment_details) AS links, (SELECT count(*)::int FROM fixed_assets) AS assets`);
console.log(`Company ${dbName}: ${JSON.stringify(counts)}`);

await api.must('PUT', '/years/active', { year: 2026, force: true });
await api.must('PUT', '/session/working-date', { date: '2026-10-19' });

/* ---- fixtures from the data ---- */
const years = await api.must<{ id: number; year: number }[]>('GET', '/years');
const y2025 = years.find((y) => y.year === 2025)!.id;
const accounts = await api.must<{ id: number; number: string; productId: number | null }[]>('GET', '/accounts');
const acc = (n: string) => accounts.find((a) => a.number === n)!.id;
const bigClient = await one<{ id: number }>(sql`SELECT d.company_id AS id FROM accounting_details d JOIN accounts ac ON ac.id = d.account_id
  WHERE ac.number = '411' AND ac.is_euro GROUP BY d.company_id ORDER BY count(*) DESC LIMIT 1`);
const bigSupplier = await one<{ id: number }>(sql`SELECT d.company_id AS id FROM accounting_details d JOIN accounts ac ON ac.id = d.account_id
  WHERE ac.number = '401' AND ac.is_euro GROUP BY d.company_id ORDER BY count(*) DESC LIMIT 1`);
const sale = await one<{ id: number }>(sql`SELECT a.id FROM accountings a JOIN documents doc ON doc.id = a.document_id
  WHERE a.accounting_date BETWEEN '2026-06-01' AND '2026-06-30' AND doc.document_type_id = 1 AND a.transaction_type_id = 3 ORDER BY a.id LIMIT 1`);
const product = accounts.find((a) => a.productId)!.productId!;
const entryBody = (await api.must<Record<string, unknown>>('GET', `/entries/${sale.id}`));
const saleInput = (date: string, number: string) => ({
  ...entryBody, id: undefined, version: undefined, number: undefined, accountingDate: date, documentDate: date, documentNumber: number, force: true,
});
/** Open liability of a partner (for binding a new payment). */
async function openInvoice(companyId: number, account: string) {
  const r = await api.must<{ liabilities: { accountingId: number; openAbs: string; accountId: number }[] }>('GET', `/payments/open-items?companyId=${companyId}&account=${account}`);
  return r.liabilities[0];
}
let docNo = 9_000_000_000;

/* ---- cases ---- */
type Group = 'interactive' | 'report' | 'year-end';
const BUDGET: Record<Group, number> = { interactive: 500, report: 2000, 'year-end': 30_000 };
interface Case { name: string; group: Group; run: () => Promise<{ status: number; size?: number; rows?: number }> }
const get = (url: string) => async () => {
  const r = await api.call('GET', url);
  return { status: r.status, size: r.size, rows: Array.isArray(r.body) ? r.body.length : Array.isArray(r.body?.rows) ? r.body.rows.length : Array.isArray(r.body?.lines) ? r.body.lines.length : undefined };
};
const post = (url: string, body: unknown | (() => unknown | Promise<unknown>), method = 'POST') => async () => {
  const b = typeof body === 'function' ? await (body as () => unknown)() : body;
  const r = await api.call(method, url, b);
  return { status: r.status, size: r.size, rows: Array.isArray(r.body) ? r.body.length : undefined };
};

const cases: Case[] = [
  // Interactive
  { name: 'GET /accounts (chart of the year)', group: 'interactive', run: get('/accounts') },
  { name: 'GET /partners (picker, first 500)', group: 'interactive', run: get('/partners') },
  { name: 'GET /partners?q= (picker search)', group: 'interactive', run: get(`/partners?q=${encodeURIComponent('Витоша')}`) },
  { name: 'journal list: page 1 (200 rows)', group: 'interactive', run: get('/entries?limit=200') },
  { name: 'journal list: page 100 (offset 19800)', group: 'interactive', run: get('/entries?limit=200&offset=19800') },
  { name: 'journal list: free text', group: 'interactive', run: get(`/entries?limit=200&text=${encodeURIComponent('Пирин')}`) },
  { name: 'journal list: partner filter', group: 'interactive', run: get(`/entries?limit=200&companyId=${bigClient.id}`) },
  { name: 'journal list: account 411 + month', group: 'interactive', run: get('/entries?limit=200&account=411&from=2026-03-01&to=2026-03-31') },
  { name: 'journal list: amount range', group: 'interactive', run: get('/entries?limit=200&amountFrom=1000&amountTo=2000') },
  { name: 'entry open (GET /entries/:id)', group: 'interactive', run: get(`/entries/${sale.id}`) },
  { name: 'entry save unchanged (PUT /entries/:id)', group: 'interactive', run: async () => {
    const e = await api.must<Record<string, unknown>>('GET', `/entries/${sale.id}`);
    const r = await api.call('PUT', `/entries/${sale.id}`, { ...e, force: true });
    return { status: r.status };
  } },
  { name: 'entry save new sale (POST /entries)', group: 'interactive', run: post('/entries', () => saleInput('2026-10-05', String(++docNo))) },
  { name: 'editor account balances', group: 'interactive', run: get(`/journal/account-balances?ids=${acc('411')},${acc('503')},${acc('401')}&date=2026-10-19`) },
  { name: 'next entry number', group: 'interactive', run: get('/entries/next-number') },
  { name: 'payments: partners with balances (F3)', group: 'interactive', run: get('/payments/partners?tab=all') },
  { name: 'payments: open items of a partner', group: 'interactive', run: get(`/payments/open-items?companyId=${bigClient.id}`) },
  { name: 'payments: bind candidates', group: 'interactive', run: get(`/payments/candidates?accountId=${acc('411')}&companyId=${bigClient.id}`) },
  { name: 'payments: links of a partner', group: 'interactive', run: get(`/payments/links?companyId=${bigClient.id}`) },
  { name: 'bank statement: open documents', group: 'interactive', run: get(`/bank-statements/open-documents?companyId=${bigClient.id}&accountId=${acc('411')}`) },
  { name: 'payment entry bound to an invoice', group: 'interactive', run: post('/entries', async () => {
    const inv = await openInvoice(bigSupplier.id, '401');
    const amount = inv ? (Number(inv.openAbs) > 10 ? '10.00' : inv.openAbs) : '10.00';
    return {
      accountingDate: '2026-10-06', documentDate: '2026-10-06', documentTypeId: 11, documentNumber: `BI${++docNo}`, companyId: bigSupplier.id, term: 'Плащане', force: true,
      debits: [{ accountId: acc('401'), amount, companyId: bigSupplier.id }], credits: [{ accountId: acc('503'), amount }],
      bindDocuments: inv ? [{ accountingId: inv.accountingId, amount }] : undefined,
    };
  }) },
  { name: 'bank statement post (5 bound rows)', group: 'interactive', run: post('/bank-statements/post', async () => {
    const r = await api.must<{ liabilities: { accountingId: number; openAbs: string }[] }>('GET', `/payments/open-items?companyId=${bigClient.id}&account=411`);
    return {
      force: true,
      rows: r.liabilities.slice(0, 5).map((l, i) => ({
        index: i, date: '2026-10-07', debitAccountId: acc('503'), creditAccountId: acc('411'), companyId: bigClient.id, term: 'Плащане от клиент',
        postAmount: Number(l.openAbs) > 5 ? '5.00' : l.openAbs, documents: [{ accountingId: l.accountingId, amount: Number(l.openAbs) > 5 ? '5.00' : l.openAbs }],
      })),
    };
  }) },
  { name: 'stock: average price of a product', group: 'interactive', run: get(`/stock/average-price?productId=${product}&date=2026-10-19`) },
  { name: 'assets: pending depreciation (Oct)', group: 'interactive', run: get('/accounting-requests?from=2026-10-01&to=2026-10-31') },
  { name: 'assets: list', group: 'interactive', run: get('/assets') },

  // Reports
  { name: 'trial balance 2026, synthetic', group: 'report', run: get('/reports/trial-balance?from=2026-01-01&to=2026-09-30') },
  { name: 'trial balance 2026, all levels', group: 'report', run: get('/reports/trial-balance?from=2026-01-01&to=2026-09-30&level=5') },
  { name: 'trial balance 2026, one month', group: 'report', run: get('/reports/trial-balance?from=2026-03-01&to=2026-03-31&level=2') },
  { name: 'trial balance 2025 (BGN), all levels', group: 'report', run: get('/reports/trial-balance?from=2025-01-01&to=2025-12-31&level=5') },
  { name: 'trial balance by months', group: 'report', run: get('/reports/trial-balance-months?from=2026-01-01&to=2026-09-30') },
  { name: 'trial balance by partners (411)', group: 'report', run: get('/reports/partner-turnover?account=411&from=2026-01-01&to=2026-09-30') },
  { name: 'chronological register, quarter', group: 'report', run: get('/journal-lines?from=2026-01-01&to=2026-03-31&limit=20000') },
  { name: 'chronological register, account 503', group: 'report', run: get('/journal-lines?from=2026-01-01&to=2026-09-30&account=503&limit=20000') },
  { name: 'chronological register, text filter', group: 'report', run: get(`/journal-lines?from=2026-01-01&to=2026-09-30&text=${encodeURIComponent('Пирин')}&limit=20000`) },
  { name: 'analytical register 411, 9 months', group: 'report', run: get('/reports/analytical?account=411&from=2026-01-01&to=2026-09-30') },
  { name: 'analytical register 503, 9 months', group: 'report', run: get('/reports/analytical?account=503&from=2026-01-01&to=2026-09-30') },
  { name: 'analytical register 411, partner', group: 'report', run: get(`/reports/analytical?account=411&from=2026-01-01&to=2026-09-30&companyId=${bigClient.id}`) },
  { name: 'general ledger with balances', group: 'report', run: get('/reports/general-ledger?from=2026-01-01&to=2026-09-30') },
  { name: 'general ledger, all levels', group: 'report', run: get('/reports/general-ledger?from=2026-01-01&to=2026-09-30&level=5') },
  { name: 'partner debts by partner', group: 'report', run: get('/reports/partner-debts?to=2026-09-30&level=partner') },
  { name: 'partner debts by document', group: 'report', run: get('/reports/partner-debts?to=2026-09-30&level=document') },
  { name: 'partner debts by entry (with allocations)', group: 'report', run: get('/reports/partner-debts?to=2026-09-30&level=accounting') },
  { name: 'overdue documents', group: 'report', run: get('/reports/overdues?to=2026-09-30') },
  { name: 'partner movement 411', group: 'report', run: get(`/reports/partner-movement?from=2026-01-01&to=2026-09-30&account=411&companyId=${bigClient.id}`) },
  { name: 'received/issued documents', group: 'report', run: get('/reports/received-issued?from=2026-01-01&to=2026-09-30') },
  { name: 'payments report', group: 'report', run: get('/reports/payments?from=2026-01-01&to=2026-09-30') },
  { name: 'confirmation letters', group: 'report', run: get('/reports/confirmation-letter?to=2026-09-30') },
  { name: 'documents closing proposal', group: 'report', run: get('/documents-closing?mode=amount&to=2026-09-30') },
  { name: 'partners report', group: 'report', run: get('/reports/companies') },
  { name: 'cash book 501', group: 'report', run: get('/reports/cash-book?from=2026-01-01&to=2026-09-30&account=501') },
  { name: 'cash and receivables', group: 'report', run: get('/reports/cash-and-receivables?from=2026-01-01&to=2026-09-30') },
  { name: 'VAT diaries (month)', group: 'report', run: post('/vat/diaries', { from: '2026-03-01', to: '2026-03-31', kl33: '0' }) },
  { name: 'VAT declaration (month)', group: 'report', run: post('/vat/declaration', { from: '2026-03-01', to: '2026-03-31', kl33: '0' }) },
  { name: 'VAT report (month)', group: 'report', run: post('/vat/report', { from: '2026-03-01', to: '2026-03-31', kl33: '0' }) },
  { name: 'VAT NAP files (month)', group: 'report', run: post('/vat/files', { from: '2026-03-01', to: '2026-03-31', kl33: '0' }) },
  { name: 'VAT closing calculation', group: 'report', run: post('/vat/closing/calculate', { from: '2026-09-01', to: '2026-09-30' }) },
  { name: 'financial statements 2026', group: 'report', run: get('/statements/report?from=2026-01-01&to=2026-09-30') },
  { name: 'financial statements 2025', group: 'report', run: get('/statements/report?from=2025-01-01&to=2025-12-31') },
  { name: 'stock: average price report', group: 'report', run: get('/reports/stock/average-price?from=2026-01-01&to=2026-09-30') },
  { name: 'stock: goods movement', group: 'report', run: get('/reports/stock/goods-movement?from=2026-01-01&to=2026-09-30') },
  { name: 'stock: inventory list', group: 'report', run: get('/reports/stock/inventory-list?date=2026-09-30') },
  { name: 'stock: sales report', group: 'report', run: get('/reports/stock/sales?from=2026-01-01&to=2026-09-30') },
  { name: 'stock: write-off candidates', group: 'report', run: get('/stock/write-offs?from=2026-09-01&to=2026-09-30&date=2026-09-30') },
  { name: 'assets: monthly quotas 2026', group: 'report', run: get('/reports/assets/quotas?year=2026') },
  { name: 'assets: depreciation plan', group: 'report', run: get('/reports/assets/plan?month=2026-09-01') },
  { name: 'assets: inventory book', group: 'report', run: get('/reports/assets/inventory-book?toDate=2026-09-30') },
  { name: 'assets: check against the ledger', group: 'report', run: get('/assets/check?from=2026-01-01&to=2026-09-30') },
  { name: 'auto closing candidates', group: 'report', run: get('/closings/auto?from=2026-01-01&to=2026-09-30') },
  { name: 'activity log', group: 'report', run: get('/activity') },

  // Year-end and bulk operations
  { name: 'post depreciation of October (all assets)', group: 'year-end', run: async () => {
    const p = await api.must<{ rows: { id: number }[] }>('GET', '/accounting-requests?from=2026-10-01&to=2026-10-31');
    const r = await api.call('POST', '/accounting-requests/post', { ids: p.rows.map((x) => x.id) });
    return { status: r.status, rows: p.rows.length };
  } },
  { name: 'auto closing of 6/7 (Jan-Sep 2026)', group: 'year-end', run: post('/closings/auto', { from: '2026-01-01', to: '2026-09-30' }) },
  { name: 'conclude 2025 into 2026 (euro changeover)', group: 'year-end', run: async () => {
    const diff = accounts.find((a) => a.number === '123')!.id;
    const r = await api.call('POST', `/years/${y2025}/conclude`, { differencesAccountId: diff });
    return { status: r.status };
  } },
  { name: 'backup (POST /backups)', group: 'year-end', run: post('/backups', {}) },
];

/* ---- run ---- */
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]!;
};
const results: { name: string; group: Group; p50: number; max: number; status: number; size?: number; rows?: number; ok: boolean }[] = [];
for (const c of cases) {
  if (only && !only.test(c.name)) continue;
  if (skip && skip.test(c.name)) continue;
  if (o.verbose) process.stderr.write(`[perf] ${c.name}\n`);
  const times: number[] = [];
  let last: Awaited<ReturnType<Case['run']>> = { status: 0 };
  let timedOut = false;
  for (let i = 0; i < RUNS && !timedOut; i++) {
    const t = performance.now();
    if (CASE_TIMEOUT) {
      let timer: NodeJS.Timeout | undefined;
      const r = await Promise.race([c.run(), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CASE_TIMEOUT); })]);
      clearTimeout(timer);
      if (r) last = r;
      else timedOut = true;
    } else last = await c.run();
    times.push(performance.now() - t);
  }
  if (timedOut) {
    console.log(`${c.group.padEnd(11)} ${c.name.padEnd(46)} over ${fmtMs(CASE_TIMEOUT)}: TIMEOUT, stopping (rerun with --skip)`);
    results.push({ name: c.name, group: c.group, p50: CASE_TIMEOUT, max: CASE_TIMEOUT, status: 0, ok: false });
    if (o.json) writeFileSync(o.json, JSON.stringify({ counts, runs: RUNS, results, timedOut: c.name }, null, 2));
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    process.exit(2);
  }
  const p50 = pct(times, 0.5), max = Math.max(...times);
  const ok = last.status >= 200 && last.status < 300;
  results.push({ name: c.name, group: c.group, p50, max, status: last.status, size: last.size, rows: last.rows, ok });
  const flag = !ok ? 'ERR' : p50 > BUDGET[c.group] ? 'SLOW' : '';
  console.log(`${c.group.padEnd(11)} ${c.name.padEnd(46)} p50 ${fmtMs(p50).padStart(8)}  max ${fmtMs(max).padStart(8)}  ${String(last.status)}${last.rows !== undefined ? `  ${last.rows} rows` : ''}${last.size ? `  ${Math.round(last.size / 1024)} KB` : ''}  ${flag}`);
}

const slow = results.filter((r) => r.ok && r.p50 > BUDGET[r.group]);
const errors = results.filter((r) => !r.ok);
console.log(`\n${results.length} cases, ${slow.length} over budget, ${errors.length} errors.`);
if (o.json) writeFileSync(o.json, JSON.stringify({ counts, runs: RUNS, results }, null, 2));

await driver.close();
if (scratch) rmSync(scratch, { recursive: true, force: true });
release();
