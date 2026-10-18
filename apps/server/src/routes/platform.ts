import { Hono } from 'hono';
import type { AppEnv } from '../context.ts';
import { requirePermission } from '../session.ts';
import { readAppLog } from '../services/appLog.ts';
import { runGdprValidation } from '../services/gdpr.ts';
import { PRODUCT_VERSION } from '../services/companySetup.ts';

export const platformRoutes = new Hono<AppEnv>()
  /** GDPR проверка (Други, UI_Other_GDPRValidator; 06 9). */
  .get('/gdpr/validate', requirePermission('UI_Other_GDPRValidator'), async (c) => {
    const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
    return c.json(await runGdprValidation(c.var.db, c.var.driver, { https: proto === 'https' }));
  })

  /** Дневник на приложението (Помощ, UI_Help_ApplicationLog; 06 7.2). */
  .get('/app-log', requirePermission('UI_Help_ApplicationLog'), async (c) => c.json(await readAppLog(Number(c.req.query('limit') ?? 500))))

  /** Нови версии (UI_Help_UpdateCheck; 06 5): the web app is updated on the server, so it only reports the version. */
  .get('/version', (c) => c.json({ version: PRODUCT_VERSION, upToDate: true }));
