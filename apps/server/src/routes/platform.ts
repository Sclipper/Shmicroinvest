import { Hono } from 'hono';
import type { AppEnv } from '../context.ts';
import { requirePermission } from '../session.ts';
import { z } from 'zod';
import { zValidator } from '../lib/validate.ts';
import { logApp, readAppLog } from '../services/appLog.ts';
import { runGdprValidation } from '../services/gdpr.ts';
import { PRODUCT_VERSION } from '../services/companySetup.ts';
import { isHttps } from '../lib/http.ts';

export const platformRoutes = new Hono<AppEnv>()
  /** GDPR проверка (Други, UI_Other_GDPRValidator; 06 9). */
  .get('/gdpr/validate', requirePermission('UI_Other_GDPRValidator'), async (c) => {
    return c.json(await runGdprValidation(c.var.db, c.var.driver, { https: isHttps(c) }));
  })

  /** Дневник на приложението (Помощ, UI_Help_ApplicationLog; 06 7.2). */
  .get('/app-log', requirePermission('UI_Help_ApplicationLog'), async (c) =>
    c.json(await readAppLog(Number(c.req.query('limit')) || 500, { company: c.var.session.companyDb!, isAdmin: !!c.var.user.isAdmin })))

  /**
   * A failure in the browser that the user is told is in the application log
   * (strProblemExporting: a report export built in the browser). Any logged-in
   * user; the entry belongs to the company and the user.
   */
  .post('/app-log/client-error', zValidator('json', z.object({
    context: z.string().trim().min(1).max(200),
    message: z.string().max(2000),
    details: z.string().max(20_000).optional(),
  })), async (c) => {
    const b = c.req.valid('json');
    await logApp({ level: 'error', message: `${b.context}: ${b.message}`, details: b.details, company: c.var.session.companyDb ?? null, user: c.var.user.name });
    return c.json({ ok: true });
  })

  /** Нови версии (UI_Help_UpdateCheck; 06 5): the web app is updated on the server, so it only reports the version. */
  .get('/version', (c) => c.json({ version: PRODUCT_VERSION, upToDate: true }));
