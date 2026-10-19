import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AppEnv } from './context.ts';
import type { DbDriver } from './db/provider.ts';
import { ApiError } from './lib/errors.ts';
import { requireCompany } from './session.ts';
import { authRoutes } from './routes/auth.ts';
import { sessionRoutes } from './routes/session.ts';
import { chartRoutes } from './routes/chart.ts';
import { nomenclatureRoutes } from './routes/nomenclatures.ts';
import { journalRoutes } from './routes/journal.ts';
import { reportRoutes } from './routes/reports.ts';
import { userRoutes } from './routes/users.ts';
import { paymentsRoutes } from './routes/payments.ts';
import { paymentDocumentsRoutes } from './routes/paymentDocuments.ts';
import { closingsRoutes } from './routes/closings.ts';
import { partnerReportsRoutes } from './routes/partnerReports.ts';
import { platformRoutes } from './routes/platform.ts';
import { initialBalanceRoutes } from './routes/initialBalances.ts';
import { logApp } from './services/appLog.ts';
import { statementRoutes } from './routes/statements.ts';
import { reportVariantRoutes } from './routes/reportVariants.ts';
import { journalExtraRoutes } from './routes/journalExtras.ts';
import { templateRoutes } from './routes/templates.ts';
import { stockRoutes } from './routes/stock.ts';
import { settingsExtraRoutes } from './routes/settingsExtras.ts';
import { vatRoutes } from './routes/vat.ts';
import { assetRoutes } from './routes/assets.ts';
import { exchangeRoutes } from './routes/exchange.ts';
import { bankRoutes } from './routes/bank.ts';
import { companyOpsRoutes } from './routes/companyOps.ts';

const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

export function createApp(driver: DbDriver, opts: { serveWeb?: boolean } = {}) {
  const api = new Hono<AppEnv>()
    .route('/', authRoutes)
    .use('*', requireCompany)
    .route('/', sessionRoutes)
    .route('/', chartRoutes)
    .route('/', nomenclatureRoutes)
    .route('/', journalRoutes)
    .route('/', reportRoutes)
    .route('/', userRoutes)
    .route('/', paymentsRoutes)
    .route('/', paymentDocumentsRoutes)
    .route('/', closingsRoutes)
    .route('/', partnerReportsRoutes)
    .route('/', platformRoutes)
    .route('/', initialBalanceRoutes)
    .route('/', statementRoutes)
    .route('/', reportVariantRoutes)
    .route('/', journalExtraRoutes)
    .route('/', templateRoutes)
    .route('/', stockRoutes)
    .route('/', settingsExtraRoutes)
    .route('/', vatRoutes)
    .route('/', assetRoutes)
    .route('/', exchangeRoutes)
    .route('/', bankRoutes)
    .route('/', companyOpsRoutes);

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('driver', driver);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message, messages: err.messages, code: err.code }, err.status);
    // Data exceptions (class 22: a non-numeric id, an impossible date, a value out of range) are bad input, not server faults.
    const pgCode = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
    if (typeof pgCode === 'string' && pgCode.startsWith('22')) return c.json({ error: 'Невалидни данни.' }, 400);
    console.error(err);
    void logApp({ level: 'error', message: `${c.req.method} ${c.req.path}: ${err.message}`, details: err.stack, company: c.get('session')?.companyDb ?? null, user: c.get('user')?.name ?? null });
    return c.json({ error: 'Възникна неочаквана грешка.' }, 500);
  });
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api', api);
  app.notFound((c) => c.json({ error: 'Не е намерено.' }, 404));

  if (opts.serveWeb && existsSync(WEB_DIST)) {
    app.use('/*', serveStatic({ root: path.relative(process.cwd(), WEB_DIST) }));
    const index = path.join(WEB_DIST, 'index.html');
    app.get('*', async (c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Не е намерено.' }, 404) : c.html(await readFile(index, 'utf8'))));
  }
  return app;
}

export type ApiType = ReturnType<typeof createApp>;
