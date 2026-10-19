import { Hono } from 'hono';
import { zValidator } from '../lib/validate.ts';
import { z } from 'zod';
import { asc, eq, sql } from 'drizzle-orm';
import {
  EURO_CHANGEOVER_YEAR, MONTH_SHORT_BG, PERMISSIONS, YEAR_MESSAGES, baseCurrencyForYear, formatMessage, lockMonth, lockedMonthList, needsPreviousConclusion,
  unlockMonth, lockYear, unlockYear, workingDateInYear,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { exec } from '../db/provider.ts';
import * as cat from '../db/catalog/schema.ts';
import type { AppEnv } from '../context.ts';
import { ApiError, badRequest } from '../lib/errors.ts';
import { requirePermission, updateSessionState, workingDate, todayInSofia, daysBetween } from '../session.ts';
import { getConfig, setConfig, BASIC_SETTINGS } from '../services/config.ts';
import { logActivity } from '../services/audit.ts';
import { addFinancialYear, deleteFinancialYear, euroChartInitialised } from '../services/years.ts';
import { PRODUCT_VERSION } from '../services/companySetup.ts';
import { SETTING_CHILDREN } from './settingsExtras.ts';

/** A Yes/No question of the year dialog (409, code = message key). */
const confirmation = (key: 'strSelect2026yearMessage' | 'strNextFinancialYearConcludePreviousWarning') =>
  new ApiError(409, YEAR_MESSAGES[key], [{ key, text: YEAR_MESSAGES[key], severity: 'warning' }], key);

export const sessionRoutes = new Hono<AppEnv>()
  /** Everything the shell needs: status bar cells, permissions, settings. */
  .get('/session', async (c) => {
    const { db, user, year, session } = c.var;
    const catalog = await c.var.driver.catalog();
    const [company] = await catalog.select().from(cat.companiesCatalog).where(eq(cat.companiesCatalog.name, session.companyDb!));
    const [my] = await db.select().from(s.myCompany).limit(1);
    const branchId = session.state.branchId ?? 1;
    const [branch] = await db.select().from(s.branches).where(eq(s.branches.id, branchId));
    const permissions: Record<string, boolean> = {};
    for (const [, key] of PERMISSIONS) permissions[key] = await c.var.can(key);
    const settings: Record<string, string> = {};
    for (const [key, def] of Object.entries(BASIC_SETTINGS)) settings[key] = (await getConfig(db, key)) ?? def.default;
    const [{ count }] = (await exec(db, 
      sql`SELECT count(*)::int AS count FROM accounts WHERE is_euro = ${year.year >= 2026} AND number <> '0'`)).rows as [{ count: number }];
    return c.json({
      company: { db: session.companyDb, name: my?.name ?? company?.companyName ?? '', bulstat: my?.bulstat ?? '', vatId: my?.vatId ?? '', isVat: my?.isVat ?? false },
      user,
      year,
      branch: branch ? { id: branch.id, name: branch.name } : null,
      workingDate: workingDate(session),
      baseCurrency: baseCurrencyForYear(year.year),
      chartIsEmpty: count === 0,
      permissions,
      settings,
    });
  })

  /** Hidden hotkey Ctrl+Shift+F8 (06 2.5): active database information. */
  .get('/session/database-info', async (c) => {
    const { driver, session } = c.var;
    const catalog = await driver.catalog();
    const [company] = await catalog.select().from(cat.companiesCatalog).where(eq(cat.companiesCatalog.name, session.companyDb!));
    const [{ version }] = (await exec(c.var.db, sql`SELECT version() AS version`)).rows as [{ version: string }];
    return c.json({
      server: driver.kind === 'pglite' ? 'PGlite (вграден)' : 'PostgreSQL',
      engine: version.split(',')[0],
      company: company?.companyName ?? '',
      database: session.companyDb,
      version: PRODUCT_VERSION,
    });
  })

  .put('/session/working-date', zValidator('json', z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })), async (c) => {
    const { date } = c.req.valid('json');
    const { db, year, user } = c.var;
    const y = Number(date.slice(0, 4));
    // Moving the working date into another year switches the active year (spec 01b 5).
    if (y !== year.year) {
      // The year changes with the date: same right as the year chooser (01b 5, status bar year button).
      if (!(await c.var.can('UI_Edit_ChangeActiveFinancialYear'))) throw new ApiError(403, 'Нямате права за тази операция.');
      const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.year, y));
      if (!fy) throw badRequest(`Не е намерена счетоводна година ${y}!`);
      if (fy.isLocked) throw badRequest('Избраната счетоводна година е заключена и не може да бъде избрана!');
      await setConfig(db, 'ActiveFinancialYear', String(y), user.id);
    }
    await updateSessionState(c, { appDateOffsetDays: daysBetween(todayInSofia(), date) });
    return c.json({ workingDate: date });
  })

  .put('/session/branch', zValidator('json', z.object({ branchId: z.number().int() })), async (c) => {
    const [b] = await c.var.db.select().from(s.branches).where(eq(s.branches.id, c.req.valid('json').branchId));
    if (!b) throw badRequest('Невалиден клон.');
    await updateSessionState(c, { branchId: b.id });
    return c.json({ ok: true });
  })

  // ---- Financial years (Счетоводна година, Ctrl+Y; spec 01b 6.3) ----
  .get('/years', async (c) => {
    const rows = await c.var.db.select().from(s.financialYears).orderBy(asc(s.financialYears.year));
    return c.json(rows);
  })

  .put('/years/active', requirePermission('UI_Edit_ChangeActiveFinancialYear'), zValidator('json', z.object({
    year: z.number().int(),
    /** Skips the strSelect2026yearMessage question (API callers that do the changeover themselves). */
    force: z.boolean().optional(),
  })), async (c) => {
    const { db, user, session } = c.var;
    const { year, force } = c.req.valid('json');
    const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.year, year));
    if (!fy) throw badRequest(formatMessage(YEAR_MESSAGES.strFinancialYearNotFound, year));
    if (fy.isLocked) throw badRequest(YEAR_MESSAGES.strChangeAccountingYearLockedWarning);
    // 2026 needs the euro changeover (the previous year concluded into the EUR chart).
    if (year === EURO_CHANGEOVER_YEAR && !force && !(await euroChartInitialised(db))) throw confirmation('strSelect2026yearMessage');
    await setConfig(db, 'ActiveFinancialYear', String(year), user.id);
    // Keep the working date inside the chosen year (the editor asks first when it moves forward, 01b 5).
    const target = workingDateInYear(workingDate(session), year);
    if (target) await updateSessionState(c, { appDateOffsetDays: daysBetween(todayInSofia(), target) });
    return c.json({ ok: true, workingDate: workingDate(session) });
  })

  .post('/years', requirePermission('UI_Edit_ChangeActiveFinancialYear'), zValidator('json', z.object({
    year: z.number().int().min(1901).max(2078),
    /** Creates the next year although the previous one is not concluded (strNextFinancialYearConcludePreviousWarning answered). */
    force: z.boolean().optional(),
  })), async (c) => {
    const { db, user } = c.var;
    const { year, force } = c.req.valid('json');
    const years = await db.select().from(s.financialYears).orderBy(asc(s.financialYears.year));
    if (years.some((y) => y.year === year)) throw badRequest('Тази счетоводна година вече съществува.');
    const last = years[years.length - 1]!;
    const first = years[0]!;
    if (year !== last.year + 1 && year !== first.year - 1) throw badRequest('Може да се създаде само следващата или предходната година.');
    if (!force && needsPreviousConclusion(years, year)) throw confirmation('strNextFinancialYearConcludePreviousWarning');
    const row = await db.transaction(async (tx) => {
      const fy = await addFinancialYear(tx, year);
      await logActivity(tx, user.id, 'add', 'financialYear', fy.id, `Счетоводна година ${year}`);
      return fy;
    });
    return c.json(row, 201);
  })

  .put('/years/:id/locks', requirePermission('UI_Edit_ChangeActiveFinancialYear'), zValidator('json', z.object({
    lockYear: z.boolean().optional(),
    months: z.array(z.number().int().min(1).max(12)).optional(),
  })), async (c) => {
    const { db, user } = c.var;
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');
    const [fy] = await db.select().from(s.financialYears).where(eq(s.financialYears.id, id));
    if (!fy) throw badRequest('Невалидна година.');
    let state = { isLocked: fy.isLocked, lockedMonths: fy.lockedMonths };
    if (body.lockYear === true) state = lockYear();
    else if (body.lockYear === false && !body.months) state = unlockYear();
    if (body.months) {
      const wanted = new Set(body.months);
      for (let m = 1; m <= 12; m++) state = wanted.has(m) ? lockMonth(state, m) : unlockMonth(state, m);
      if (body.lockYear === true) state = lockYear();
    }
    await db.update(s.financialYears).set(state).where(eq(s.financialYears.id, id));
    // 01b 8: Delta writes no log row for locks; the rebuild keeps an audit trail.
    const what = state.isLocked !== fy.isLocked
      ? `${state.isLocked ? 'Заключване' : 'Отключване'} на счетоводна година ${fy.year}`
      : state.lockedMonths !== fy.lockedMonths
        ? `Заключени месеци на ${fy.year}: ${lockedMonthList(state.lockedMonths).map((m) => MONTH_SHORT_BG[m - 1]).join(', ') || 'няма'}`
        : null;
    if (what) await logActivity(db, user.id, 'edit', 'financialYear', id, what);
    return c.json(state);
  })

  .delete('/years/:id', requirePermission('UI_Edit_ChangeActiveFinancialYear'), async (c) => {
    const { db, year, user } = c.var;
    const id = Number(c.req.param('id'));
    const years = await db.select().from(s.financialYears).orderBy(asc(s.financialYears.year));
    const fy = years.find((y) => y.id === id);
    if (!fy) throw badRequest('Невалидна година.');
    if (fy.isLocked) throw badRequest(YEAR_MESSAGES.strHelpCannotDeleteLockedYear);
    if (fy.id === year.id) throw badRequest(YEAR_MESSAGES.strHelpCannotDeleteCurrentFinancialYear);
    if (years[0]!.id !== fy.id) throw badRequest(YEAR_MESSAGES.strHelpCannotDeleteBecauseOfActivePreviousYear);
    await db.transaction(async (tx) => {
      await deleteFinancialYear(tx, fy, years[1]?.id ?? null);
      await logActivity(tx, user.id, 'delete', 'financialYear', id, `Счетоводна година ${fy.year}`);
    });
    return c.json({ ok: true, message: formatMessage(YEAR_MESSAGES.strDeleteFinancialYearDone, fy.year) });
  })

  // ---- Settings (Други > Настройки) ----
  .get('/settings', async (c) => {
    const out: { key: string; label: string; value: string; default: string }[] = [];
    for (const [key, def] of Object.entries(BASIC_SETTINGS)) {
      out.push({ key, label: def.label, default: def.default, value: (await getConfig(c.var.db, key)) ?? def.default });
    }
    return c.json(out);
  })
  .put('/settings', requirePermission('UI_Other_Settings'), zValidator('json', z.record(z.string(), z.string())), async (c) => {
    const body = c.req.valid('json');
    // Validate everything first, then write in one transaction.
    const unknown = Object.keys(body).find((k) => !(k in BASIC_SETTINGS));
    if (unknown) throw new ApiError(400, `Непозната настройка ${unknown}.`);
    await c.var.db.transaction(async (tx) => {
      for (const [k, v] of Object.entries(body)) await setConfig(tx, k, v);
      // 06 3.5: a parent option turned off clears its dependent options.
      for (const [parent, children] of Object.entries(SETTING_CHILDREN)) {
        if (body[parent] === 'False') for (const child of children) if (child in BASIC_SETTINGS) await setConfig(tx, child, 'False');
      }
    });
    return c.json({ ok: true });
  });

