import { randomBytes } from 'node:crypto';
import { and, eq, lt, or } from 'drizzle-orm';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import { defaultActiveYear, resolvePermission } from '@shmi/core';
import * as cat from './db/catalog/schema.ts';
import * as s from './db/company/schema/index.ts';
import type { AppEnv, SessionInfo, ActiveYear } from './context.ts';
import { ApiError } from './lib/errors.ts';
import { getConfig } from './services/config.ts';
import type { CompanyDb } from './db/provider.ts';
import { isHttps } from './lib/http.ts';
import { sessionIdleMs, sessionMaxAgeMs } from './runtime.ts';

const COOKIE = 'shmi_sid';

/**
 * The session cookie: HttpOnly, SameSite=Lax, Secure over HTTPS (also behind
 * a TLS-terminating proxy with TRUST_PROXY=1). A session ends after
 * SESSION_IDLE_MINUTES without requests (default 12 h) and at the latest
 * SESSION_MAX_AGE_DAYS after the login (default 14).
 */

export async function createSession(c: Context<AppEnv>, companyDb: string, userId: number) {
  const catalog = await c.var.driver.catalog();
  const id = randomBytes(32).toString('base64url');
  await catalog.insert(cat.sessions).values({ id, companyDb, userId, userAgent: c.req.header('user-agent') ?? null });
  setCookie(c, COOKIE, id, {
    httpOnly: true, sameSite: 'Lax', path: '/', secure: isHttps(c),
    maxAge: Math.floor(sessionMaxAgeMs() / 1000),
  });
  // Opportunistic clean-up of expired sessions.
  await catalog.delete(cat.sessions).where(or(
    lt(cat.sessions.lastSeenAt, new Date(Date.now() - sessionIdleMs())),
    lt(cat.sessions.createdAt, new Date(Date.now() - sessionMaxAgeMs())),
  ));
  return id;
}

export async function destroySession(c: Context<AppEnv>) {
  const id = getCookie(c, COOKIE);
  if (id) {
    const catalog = await c.var.driver.catalog();
    await catalog.delete(cat.sessions).where(eq(cat.sessions.id, id));
  }
  deleteCookie(c, COOKIE, { path: '/', httpOnly: true, sameSite: 'Lax', secure: isHttps(c) });
}

export async function readSession(c: Context<AppEnv>): Promise<SessionInfo | null> {
  const id = getCookie(c, COOKIE);
  if (!id) return null;
  const catalog = await c.var.driver.catalog();
  const [row] = await catalog.select().from(cat.sessions).where(eq(cat.sessions.id, id));
  if (!row) return null;
  const now = Date.now();
  if (now - row.lastSeenAt.getTime() > sessionIdleMs() || now - row.createdAt.getTime() > sessionMaxAgeMs()) {
    await catalog.delete(cat.sessions).where(eq(cat.sessions.id, id));
    deleteCookie(c, COOKIE, { path: '/', httpOnly: true, sameSite: 'Lax', secure: isHttps(c) });
    return null;
  }
  if (now - row.lastSeenAt.getTime() > 60_000) {
    await catalog.update(cat.sessions).set({ lastSeenAt: new Date() }).where(eq(cat.sessions.id, id));
  }
  return { id: row.id, companyDb: row.companyDb, userId: row.userId, state: row.state ?? {} };
}

export async function updateSessionState(c: Context<AppEnv>, patch: SessionInfo['state']) {
  const catalog = await c.var.driver.catalog();
  const state = { ...c.var.session.state, ...patch };
  await catalog.update(cat.sessions).set({ state }).where(eq(cat.sessions.id, c.var.session.id));
  c.var.session.state = state;
}

/** Resolve the user's active financial year (Configuration.ActiveFinancialYear per user). */
export async function activeYear(db: CompanyDb, userId: number): Promise<ActiveYear> {
  const stored = await getConfig(db, 'ActiveFinancialYear', userId);
  const years = await db.select().from(s.financialYears).orderBy(s.financialYears.year);
  if (!years.length) throw new ApiError(500, 'Няма счетоводна година.');
  // No stored year: the current calendar year, not the latest one (06 4.1).
  const wanted = (stored ? years.find((y) => y.year === Number(stored)) : undefined)
    ?? years.find((y) => y.year === defaultActiveYear(years.map((x) => x.year), todayInSofia()));
  const fy = wanted ?? years[years.length - 1]!;
  return { id: fy.id, year: fy.year, startDate: fy.startDate, isLocked: fy.isLocked, lockedMonths: fy.lockedMonths, isConcluded: fy.isConcluded };
}

export async function permissionResolver(db: CompanyDb, roleId: number) {
  const perms = await db.select().from(s.permissions);
  const byKey = new Map(perms.map((p) => [p.key, p]));
  const byId = new Map(perms.map((p) => [p.id, p]));
  const rows = await db.select().from(s.userRolePermissions).where(eq(s.userRolePermissions.userRoleId, roleId));
  const values = new Map(rows.map((r) => [r.permissionId, r.value]));
  return (key: string) => resolvePermission(key, byKey, byId, values);
}

/** Requires a logged-in session bound to a company; sets db, user, year and can(). */
export const requireCompany: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await readSession(c);
  if (!session?.companyDb || !session.userId) throw new ApiError(401, 'Моля, влезте в системата.');
  c.set('session', session);
  let db: CompanyDb;
  try {
    db = await c.var.driver.company(session.companyDb);
  } catch {
    await destroySession(c);
    throw new ApiError(401, 'Фирмата не е достъпна.');
  }
  c.set('db', db);
  const [u] = await db.select().from(s.users).where(and(eq(s.users.id, session.userId), eq(s.users.isDeleted, false)));
  if (!u) {
    await destroySession(c);
    throw new ApiError(401, 'Потребителят не съществува.');
  }
  c.set('user', { id: u.id, name: u.name, roleId: u.userRoleId, isAdmin: u.userRoleId === 2 });
  c.set('year', await activeYear(db, u.id));
  let resolver: ((k: string) => boolean) | undefined;
  c.set('can', async (key: string) => {
    resolver ??= await permissionResolver(db, u.userRoleId);
    return resolver(key);
  });
  await next();
};

/** Route guard by permission key (menu keys of spec 06 1.3). */
export function requirePermission(...keys: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    for (const k of keys) if (!(await c.var.can(k))) throw new ApiError(403, 'Нямате права за тази операция.');
    await next();
  };
}

/** Passes when the user holds at least one of the keys (a route shared by screens with different rights). */
export function requireAnyPermission(...keys: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    for (const k of keys) if (await c.var.can(k)) return next();
    throw new ApiError(403, 'Нямате права за тази операция.');
  };
}

/** Working date = today + per-session offset (ApplicationDate, spec 01b 5). */
export function workingDate(session: SessionInfo): string {
  return addDays(todayInSofia(), session.state.appDateOffsetDays ?? 0);
}

export function todayInSofia(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ_COMPANY ?? 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400_000);
}

