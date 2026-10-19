import { Hono } from 'hono';
import { zValidator } from '../lib/validate.ts';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import * as cat from '../db/catalog/schema.ts';
import * as s from '../db/company/schema/index.ts';
import type { AppEnv } from '../context.ts';
import { ApiError } from '../lib/errors.ts';
import { verifyPassword, isStrongPassword } from '../lib/password.ts';
import { createSession, destroySession, readSession, permissionResolver, todayInSofia } from '../session.ts';
import { PRODUCT_VERSION, seedCompany } from '../services/companySetup.ts';
import { logActivity } from '../services/audit.ts';
import { applyLoginYear } from '../services/years.ts';
import { logApp } from '../services/appLog.ts';
import { transferEntities } from '../services/transfer.ts';

/** Physical name of a new company database: delta_<yyMMddHHmmss><random>. */
function newDatabaseName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `delta_${stamp}${randomBytes(2).toString('hex')}`;
}

const failedLogins = new Map<string, { count: number; until: number }>();

export const authRoutes = new Hono<AppEnv>()
  /** Company list for the login screen ("Избор на фирма"). */
  .get('/companies', async (c) => {
    const catalog = await c.var.driver.catalog();
    const rows = await catalog.select().from(cat.companiesCatalog).orderBy(asc(cat.companiesCatalog.companyName));
    return c.json(rows.map((r) => ({ name: r.name, companyName: r.companyName, version: r.version })));
  })

  /** Users that can log in to a company (non-deleted). */
  .get('/companies/:db/users', async (c) => {
    const catalog = await c.var.driver.catalog();
    const [row] = await catalog.select().from(cat.companiesCatalog).where(eq(cat.companiesCatalog.name, c.req.param('db')));
    if (!row) throw new ApiError(404, 'Фирмата не е намерена.');
    const db = await c.var.driver.company(row.name);
    const users = await db.select({ id: s.users.id, name: s.users.name }).from(s.users).where(eq(s.users.isDeleted, false)).orderBy(asc(s.users.name));
    return c.json(users);
  })

  /**
   * New company (Нова фирма). Allowed for anybody while the server has no
   * company yet (first run); afterwards only for a logged-in user with
   * UI_File_NewCompany.
   */
  .post('/companies', zValidator('json', z.object({
    companyName: z.string().trim().min(1).max(255),
    adminName: z.string().trim().min(1).max(255),
    adminPassword: z.string().max(200),
    year: z.number().int().min(1901).max(2078),
    bulstat: z.string().trim().max(50).optional(),
    chartTemplate: z.enum(['commercial', 'nonProfit', 'budget']).nullable().optional(),
    /** Data carried over from the active company (01b 1.2 TransferEntities). */
    transfer: z.object({ chartOfAccounts: z.boolean().optional(), users: z.boolean().optional(), partners: z.boolean().optional(), accountings: z.boolean().optional() }).optional(),
  })), async (c) => {
    const body = c.req.valid('json');
    const catalog = await c.var.driver.catalog();
    const existing = await catalog.select().from(cat.companiesCatalog);
    let sourceDb: string | null = null;
    if (existing.length > 0) {
      const session = await readSession(c);
      if (!session?.companyDb || !session.userId) throw new ApiError(403, 'Само влязъл потребител може да създава нови фирми.');
      const db = await c.var.driver.company(session.companyDb);
      const [u] = await db.select().from(s.users).where(eq(s.users.id, session.userId));
      if (!u || !(await permissionResolver(db, u.userRoleId))('UI_File_NewCompany')) throw new ApiError(403, 'Нямате права за тази операция.');
      sourceDb = session.companyDb;
    }
    const transfer = body.transfer && Object.values(body.transfer).some(Boolean) ? body.transfer : null;
    if (transfer && !sourceDb) throw new ApiError(400, 'Няма активна фирма, от която да се прехвърлят данни.');
    const copiesChart = !!(transfer?.chartOfAccounts || transfer?.accountings);
    if (!isStrongPassword(body.adminPassword)) throw new ApiError(400, 'Паролата трябва да е поне 6 символа.');
    const name = newDatabaseName();
    const db = await c.var.driver.createCompanyDatabase(name);
    try {
      await db.transaction(async (tx) => {
        await seedCompany(tx, { ...body, chartTemplate: copiesChart ? null : body.chartTemplate ?? 'commercial' });
        if (transfer) await transferEntities(await c.var.driver.company(sourceDb!), tx, transfer);
      });
    } catch (e) {
      await c.var.driver.dropCompanyDatabase(name);
      throw e;
    }
    await catalog.insert(cat.companiesCatalog).values({ name, companyName: body.companyName, version: PRODUCT_VERSION });
    await createSession(c, name, 1);
    return c.json({ name, companyName: body.companyName }, 201);
  })

  .post('/login', zValidator('json', z.object({
    companyDb: z.string(),
    userId: z.number().int(),
    password: z.string(),
  })), async (c) => {
    const { companyDb, userId, password } = c.req.valid('json');
    const key = `${companyDb}:${userId}`;
    const f = failedLogins.get(key);
    if (f && f.until > Date.now()) throw new ApiError(429, 'Твърде много неуспешни опити. Опитайте отново след малко.');
    const catalog = await c.var.driver.catalog();
    const [row] = await catalog.select().from(cat.companiesCatalog).where(eq(cat.companiesCatalog.name, companyDb));
    if (!row) throw new ApiError(404, 'Фирмата не е намерена.');
    const db = await c.var.driver.company(companyDb);
    const [u] = await db.select().from(s.users).where(and(eq(s.users.id, userId), eq(s.users.isDeleted, false)));
    if (!u || !(await verifyPassword(password, u.passwordHash))) {
      // Three consecutive failures -> short lock-out (Delta sleeps 5 s client-side).
      const count = (f?.count ?? 0) + 1;
      failedLogins.set(key, { count: count >= 3 ? 0 : count, until: count >= 3 ? Date.now() + 5000 : 0 });
      await logApp({ level: 'warning', message: `Неуспешно вписване на потребител ${u?.name ?? userId}`, company: companyDb, user: u?.name ?? null });
      throw new ApiError(401, 'Въведено е грешно потребителско име или парола!');
    }
    failedLogins.delete(key);
    await destroySession(c);
    await createSession(c, companyDb, u.id);
    // OpenLoginWindow: 2026 without the euro chart falls back to 2025 (06 4.1).
    await applyLoginYear(db, u.id, todayInSofia());
    await logActivity(db, u.id, 'login', 'identification', null, 'Вписване');
    await logApp({ level: 'info', message: `Вписване на потребител ${u.name}`, company: companyDb, user: u.name });
    return c.json({ ok: true });
  })

  .post('/logout', async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  });
