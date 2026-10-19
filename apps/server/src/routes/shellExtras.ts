import { Hono } from 'hono';
import { z } from 'zod';
import { USER_ACTIVITY_CODES } from '@shmi/core';
import type { AppEnv } from '../context.ts';
import { zValidator } from '../lib/validate.ts';
import { badRequest } from '../lib/errors.ts';
import { requirePermission, workingDate } from '../session.ts';
import { logActivity } from '../services/audit.ts';
import { shellNotices } from '../services/notices.ts';
import { activityDocuments, activityLog } from '../services/userActivities.ts';
import { saveSmtpSettings, sendReportEmail, sendTestEmail, smtpSettingsView } from '../services/email.ts';

const ACTIVITY_REPORT = 'UI_Reporting_UsersActivitiesReport';
const SETTINGS = 'UI_Other_Settings';
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

/**
 * Shell messages panel (06 2.1), Действия по потребители (01b 8, 05 7.7)
 * with the report print/export log, and e-mail (04b 3, 06 3.2).
 */
export const shellExtraRoutes = new Hono<AppEnv>()
  /** "Съобщения": start-up notices of the active company and year. */
  .get('/session/messages', async (c) => {
    const { db, year, session, user } = c.var;
    return c.json(await shellNotices(db, {
      year, workingDate: workingDate(session), userId: user.id,
      canSeeCashLimit: await c.var.can('UI_Reporting_CashReports_CashAndReceivables'),
    }));
  })

  // ---- Действия по потребители ------------------------------------------------
  /** "По менюта": the audit log, filtered on the server. */
  .get('/activity', requirePermission(ACTIVITY_REPORT), async (c) => {
    const q = c.req.query();
    for (const d of [q.from, q.to]) if (d && !isoDate.safeParse(d).success) throw badRequest('Невалидна дата.');
    if (q.activity && !USER_ACTIVITY_CODES.includes(q.activity)) throw badRequest('Невалиден тип действие.');
    return c.json(await activityLog(c.var.db, {
      userId: num(q.userId), activity: q.activity || undefined, entityType: q.entityType || undefined,
      from: q.from || undefined, to: q.to || undefined, q: q.q, limit: num(q.limit),
    }));
  })

  /** "По документи": processed documents per user in the period. */
  .get('/activity/by-documents', requirePermission(ACTIVITY_REPORT), async (c) => {
    const q = c.req.query();
    const from = q.from || `${c.var.year.year}-01-01`;
    const to = q.to || `${c.var.year.year}-12-31`;
    if (!isoDate.safeParse(from).success || !isoDate.safeParse(to).success) throw badRequest('Невалидна дата.');
    return c.json(await activityDocuments(c.var.db, { userId: num(q.userId), from, to }));
  })

  /**
   * Print / export of a report from the report frame (ЕкспортНаСправка /
   * ПечатНаСправка, 01b 8): trial balance, chronological and analytical
   * registers, ICA protocols and the other reports.
   */
  .post('/activity/log', zValidator('json', z.object({
    activity: z.enum(['print', 'export']),
    entityType: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,49}$/),
    description: z.string().max(500).optional(),
  })), async (c) => {
    const b = c.req.valid('json');
    await logActivity(c.var.db, c.var.user.id, b.activity, b.entityType, null, b.description);
    return c.json({ ok: true }, 201);
  })

  // ---- E-mail ----------------------------------------------------------------------
  .get('/settings/smtp', requirePermission(SETTINGS), async (c) => c.json(await smtpSettingsView(c.var.db)))

  .put('/settings/smtp', requirePermission(SETTINGS), zValidator('json', z.object({
    host: z.string().max(255),
    port: z.number().int(),
    userName: z.string().max(255).default(''),
    password: z.string().max(255).optional(),
    email: z.string().max(255).default(''),
    enableSsl: z.boolean().default(true),
  })), async (c) => {
    await saveSmtpSettings(c.var.db, c.req.valid('json'));
    await logActivity(c.var.db, c.var.user.id, 'edit', 'smtpConfiguration', null, 'Настройки за изпращане на e-mail');
    return c.json(await smtpSettingsView(c.var.db));
  })

  .post('/settings/smtp/test', requirePermission(SETTINGS), zValidator('json', z.object({ to: z.string().max(255).optional() })), async (c) =>
    c.json(await sendTestEmail(c.var.db, c.var.session.companyDb ?? '', c.req.valid('json').to)))

  /** "Изпращане по e-mail" from the report frame: the report as an .xlsx attachment. */
  .post('/email/report', zValidator('json', z.object({
    to: z.string().max(2000),
    cc: z.string().max(2000).optional(),
    subject: z.string().max(255),
    body: z.string().max(20_000).optional(),
    report: z.string().max(255).optional(),
    entityType: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,49}$/).optional(),
    attachment: z.object({ fileName: z.string().min(1).max(255), contentBase64: z.string().max(15_000_000) }),
  })), async (c) => {
    const b = c.req.valid('json');
    const r = await sendReportEmail(c.var.db, b, c.var.session.companyDb ?? '');
    await logActivity(c.var.db, c.var.user.id, 'export', b.entityType ?? 'report', null, `${b.report ?? b.attachment.fileName}: e-mail до ${b.to}`);
    return c.json(r);
  });
