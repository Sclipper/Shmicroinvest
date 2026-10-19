import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { sql } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
import { entryFollowUpRoutes } from './routes/entryFollowUps.ts';
import { templateRoutes } from './routes/templates.ts';
import { stockRoutes } from './routes/stock.ts';
import { settingsExtraRoutes } from './routes/settingsExtras.ts';
import { vatRoutes } from './routes/vat.ts';
import { assetRoutes } from './routes/assets.ts';
import { exchangeRoutes } from './routes/exchange.ts';
import { bankRoutes } from './routes/bank.ts';
import { companyOpsRoutes } from './routes/companyOps.ts';
import { shellExtraRoutes } from './routes/shellExtras.ts';
import { APP_VERSION, PATHS, isProduction, loginIpLimit } from './runtime.ts';
import { bodyLimits as bodyLimitMiddleware, securityHeaders } from './lib/security.ts';
import { FailureLimiter } from './lib/rateLimit.ts';

export function createApp(driver: DbDriver, opts: { serveWeb?: boolean; webDist?: string } = {}) {
  const WEB_DIST = opts.webDist ?? PATHS.webDist;
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
    .route('/', entryFollowUpRoutes)
    .route('/', templateRoutes)
    .route('/', stockRoutes)
    .route('/', settingsExtraRoutes)
    .route('/', vatRoutes)
    .route('/', assetRoutes)
    .route('/', exchangeRoutes)
    .route('/', bankRoutes)
    .route('/', companyOpsRoutes)
    .route('/', shellExtraRoutes);

  const app = new Hono<AppEnv>();
  const loginLimiter = new FailureLimiter(loginIpLimit());
  app.use('*', async (c, next) => {
    c.set('driver', driver);
    c.set('loginLimiter', loginLimiter);
    await next();
  });
  app.use('*', securityHeaders());
  app.use('/api/*', bodyLimitMiddleware());
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message, messages: err.messages, code: err.code }, err.status);
    if (err instanceof HTTPException) {
      if (err.status === 413) return c.json({ error: 'Файлът или заявката е твърде голяма.', code: 'tooLarge' }, 413);
      return c.json({ error: err.status < 500 ? 'Невалидна заявка.' : 'Възникна неочаквана грешка.' }, err.status);
    }
    // A request body that is not valid JSON.
    if (err instanceof SyntaxError && /JSON/.test(err.message)) return c.json({ error: 'Невалидни данни.' }, 400);
    // Data exceptions (class 22: a non-numeric id, an impossible date, a value out of range) are bad input, not server faults.
    const pgCode = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
    if (typeof pgCode === 'string' && pgCode.startsWith('22')) return c.json({ error: 'Невалидни данни.' }, 400);
    console.error(isProduction() ? `${c.req.method} ${c.req.path}: ${err.stack ?? err.message}` : err);
    void logApp({ level: 'error', message: `${c.req.method} ${c.req.path}: ${err.message}`, details: err.stack, company: c.get('session')?.companyDb ?? null, user: c.get('user')?.name ?? null });
    return c.json({ error: 'Възникна неочаквана грешка.' }, 500);
  });
  // Health for load balancers and container health checks: the catalog database answers a query.
  app.get('/api/health', async (c) => {
    try {
      await (await driver.catalog()).execute(sql`SELECT 1`);
      return c.json({ ok: true, version: APP_VERSION });
    } catch {
      return c.json({ ok: false, version: APP_VERSION }, 503);
    }
  });
  app.route('/api', api);
  app.notFound((c) => c.json({ error: 'Не е намерено.' }, 404));

  if (opts.serveWeb && existsSync(WEB_DIST)) {
    // Hashed build assets never change; index.html must be revalidated so a new release is picked up.
    app.use('/*', async (c, next) => {
      await next();
      if (c.res.status !== 200 || c.req.path.startsWith('/api/')) return;
      if (c.req.path.startsWith('/assets/')) c.header('Cache-Control', 'public, max-age=31536000, immutable');
      else if (c.res.headers.get('content-type')?.startsWith('text/html')) c.header('Cache-Control', 'no-cache');
    });
    app.use('/*', serveStatic({ root: WEB_DIST }));
    const index = path.join(WEB_DIST, 'index.html');
    let html: string | undefined;
    app.get('*', async (c) => {
      if (c.req.path.startsWith('/api/')) return c.json({ error: 'Не е намерено.' }, 404);
      html ??= await readFile(index, 'utf8');
      return c.html(html);
    });
  }
  return app;
}

export type ApiType = ReturnType<typeof createApp>;
