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
import { platformRoutes } from './routes/platform.ts';
import { logApp } from './services/appLog.ts';

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
    .route('/', platformRoutes);

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('driver', driver);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.message, messages: err.messages, code: err.code }, err.status);
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
