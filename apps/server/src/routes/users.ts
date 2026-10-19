import { Hono } from 'hono';
import { zValidator } from '../lib/validate.ts';
import { z } from 'zod';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { resolvePermission, USER_SCREEN_MESSAGES, userPasswordChecks } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { AppEnv } from '../context.ts';
import type { DbOrTx } from '../db/provider.ts';
import { ApiError, badRequest, notFound } from '../lib/errors.ts';
import { hashPassword, isStrongPassword, verifyPassword } from '../lib/password.ts';
import { requirePermission } from '../session.ts';
import { logActivity } from '../services/audit.ts';
import { recordPasswordQuality } from '../services/gdpr.ts';

const ADMIN_ROLE = 2;

export const USER_MESSAGES = {
  ...USER_SCREEN_MESSAGES,
  strLastAdministrator: 'Трябва да има поне един потребител администратор.',
} as const;

/**
 * strUserPasswordMissing (warns) / strPasswordNotSecure (confirm), 01b 3.4:
 * a 409 "confirm" unless the client resends with `force`.
 */
function confirmPassword(password: string, force?: boolean) {
  const checks = userPasswordChecks(password);
  if (checks.length && !force) throw new ApiError(409, checks[0]!.text, checks, 'confirm');
}

/** Unique-index violation (23505), as raised by node-postgres and PGlite, possibly wrapped by drizzle. */
function isUniqueViolation(e: unknown): boolean {
  for (let x = e as { code?: string; cause?: unknown } | undefined, i = 0; x && i < 5; x = x.cause as typeof x, i++) if (x.code === '23505') return true;
  return false;
}

/** A user name taken by a non-deleted user (case-insensitive, as ix_users_name_active). */
async function nameTaken(db: DbOrTx, name: string, exceptId?: number) {
  const rows = await db.select({ id: s.users.id }).from(s.users)
    .where(and(sql`lower(${s.users.name}) = lower(${name})`, eq(s.users.isDeleted, false), exceptId ? ne(s.users.id, exceptId) : undefined));
  return rows.length > 0;
}

/** Runs a user write; a concurrent duplicate name (unique index) becomes strUserNameExists. */
async function guardName<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (isUniqueViolation(e)) throw badRequest(USER_MESSAGES.strUserNameExists);
    throw e;
  }
}
const USERS = 'UI_Edit_Administration_Users';

/** Users, roles and the role permission tree (spec 01b section 3). */
export const userRoutes = new Hono<AppEnv>()
  .get('/users', requirePermission(USERS), async (c) => {
    const rows = await c.var.db.select({ id: s.users.id, name: s.users.name, roleId: s.users.userRoleId, email: s.users.email, hasPassword: s.users.passwordHash })
      .from(s.users).where(eq(s.users.isDeleted, false)).orderBy(asc(s.users.name));
    return c.json(rows.map((r) => ({ ...r, hasPassword: r.hasPassword !== '' })));
  })

  .post('/users', requirePermission(USERS), zValidator('json', z.object({
    name: z.string().trim().min(1, 'Не е въведено име на потребителя.').max(255),
    password: z.string().max(200).default(''),
    roleId: z.number().int(),
    email: z.string().max(255).nullable().optional(),
    force: z.boolean().optional(),
  })), async (c) => {
    const { db, user } = c.var;
    const b = c.req.valid('json');
    if (await nameTaken(db, b.name)) throw badRequest(USER_MESSAGES.strUserNameExists);
    if (b.roleId === 1) throw badRequest(USER_MESSAGES.strSelectBaseUserRoleToAddUserOrRole);
    confirmPassword(b.password, b.force);
    const passwordHash = await hashPassword(b.password);
    const [row] = await guardName(() => db.insert(s.users).values({ name: b.name, passwordHash, userRoleId: b.roleId, email: b.email ?? null }).returning());
    await recordPasswordQuality(db, row!.id, b.password);
    await logActivity(db, user.id, 'add', 'user', row!.id, b.name);
    return c.json({ id: row!.id }, 201);
  })

  .put('/users/:id', requirePermission(USERS), zValidator('json', z.object({
    name: z.string().trim().min(1).max(255),
    roleId: z.number().int(),
    email: z.string().max(255).nullable().optional(),
    password: z.string().max(200).optional(),
    force: z.boolean().optional(),
  })), async (c) => {
    const { db, user } = c.var;
    const id = Number(c.req.param('id'));
    const b = c.req.valid('json');
    const [u] = await db.select().from(s.users).where(eq(s.users.id, id));
    if (!u) throw notFound('Потребителят');
    if (b.roleId === 1) throw badRequest(USER_MESSAGES.strSelectBaseUserRoleToAddUserOrRole);
    if (await nameTaken(db, b.name, id)) throw badRequest(USER_MESSAGES.strUserNameExists);
    const patch: Partial<typeof s.users.$inferInsert> = { name: b.name, userRoleId: b.roleId, email: b.email ?? null };
    if (b.password !== undefined) {
      confirmPassword(b.password, b.force);
      patch.passwordHash = await hashPassword(b.password);
    }
    await guardName(() => db.transaction(async (tx) => {
      // The last-administrator rule holds under concurrency: the administrators are locked first.
      if (u.userRoleId === ADMIN_ROLE && b.roleId !== ADMIN_ROLE && (await lockedAdminCount(tx, id)) === 0) throw badRequest(USER_MESSAGES.strLastAdministrator);
      await tx.update(s.users).set(patch).where(eq(s.users.id, id));
    }));
    if (b.password !== undefined) await recordPasswordQuality(db, id, b.password);
    await logActivity(db, user.id, 'edit', 'user', id, b.name);
    return c.json({ ok: true });
  })

  .delete('/users/:id', requirePermission(USERS), async (c) => {
    const { db, user } = c.var;
    const id = Number(c.req.param('id'));
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(s.users).where(eq(s.users.isDeleted, false))) as [{ n: number }];
    if (n <= 1) throw new ApiError(422, USER_MESSAGES.strUserCountValidation, [{ key: 'strUserCountValidation', text: USER_MESSAGES.strUserCountValidation, severity: 'critical' }]);
    if (id === user.id) throw badRequest('Не можете да изтриете активния потребител.');
    const [u] = await db.select().from(s.users).where(eq(s.users.id, id));
    if (!u) throw notFound('Потребителят');
    // strUserHasOperations (01b 3.4): a user referenced by entries is not deleted.
    const [used] = await db.select({ id: s.accountings.id }).from(s.accountings).where(eq(s.accountings.userId, id)).limit(1);
    if (used) throw new ApiError(422, USER_MESSAGES.strUserHasOperations, [{ key: 'strUserHasOperations', text: USER_MESSAGES.strUserHasOperations, severity: 'critical' }]);
    await db.transaction(async (tx) => {
      if (u.userRoleId === ADMIN_ROLE && (await lockedAdminCount(tx, id)) === 0) throw badRequest(USER_MESSAGES.strLastAdministrator);
      await tx.update(s.users).set({ isDeleted: true }).where(eq(s.users.id, id));
    });
    await logActivity(db, user.id, 'delete', 'user', id, u.name);
    return c.json({ ok: true });
  })

  /** Own password change; available to every user. */
  .put('/me/password', zValidator('json', z.object({ current: z.string(), password: z.string().max(200) })), async (c) => {
    const { db, user } = c.var;
    const b = c.req.valid('json');
    const [u] = await db.select().from(s.users).where(eq(s.users.id, user.id));
    if (!(await verifyPassword(b.current, u!.passwordHash))) throw badRequest('Грешна текуща парола.');
    if (!isStrongPassword(b.password)) throw badRequest('Паролата трябва да е поне 6 символа.');
    await db.update(s.users).set({ passwordHash: await hashPassword(b.password) }).where(eq(s.users.id, user.id));
    await recordPasswordQuality(db, user.id, b.password);
    return c.json({ ok: true });
  })

  // ---- Roles ----
  .get('/roles', async (c) => c.json(await c.var.db.select().from(s.userRoles).orderBy(asc(s.userRoles.leftIndex))))

  .post('/roles', requirePermission(USERS), zValidator('json', z.object({ name: z.string().trim().min(1).max(50), copyFromId: z.number().int().optional(), parentId: z.number().int().optional() })), async (c) => {
    const { db } = c.var;
    const b = c.req.valid('json');
    // Groups are one level under the base group "Потребителски групи" (01b 3.4).
    if (b.parentId !== undefined && b.parentId !== 1) throw badRequest(USER_MESSAGES.strSelectBaseUserRoleToAddUserOrRole);
    const id = await db.transaction(async (tx) => {
      const [r] = await tx.insert(s.userRoles).values({ name: b.name, parentId: 1 }).returning();
      if (b.copyFromId) {
        const src = await tx.select().from(s.userRolePermissions).where(eq(s.userRolePermissions.userRoleId, b.copyFromId));
        if (src.length) await tx.insert(s.userRolePermissions).values(src.map((p) => ({ permissionId: p.permissionId, userRoleId: r!.id, value: p.value })));
      }
      await rebuildRoleTree(tx);
      await logActivity(tx, c.var.user.id, 'add', 'userRole', r!.id, `Потребителска група ${b.name}`);
      return r!.id;
    });
    return c.json({ id }, 201);
  })

  .put('/roles/:id', requirePermission(USERS), zValidator('json', z.object({ name: z.string().trim().min(1).max(50) })), async (c) => {
    const id = Number(c.req.param('id'));
    const [r] = await c.var.db.select().from(s.userRoles).where(eq(s.userRoles.id, id));
    if (!r) throw notFound('Групата');
    if (r.isReadOnly) throw badRequest('Тази група не може да бъде редактирана.');
    await c.var.db.update(s.userRoles).set(c.req.valid('json')).where(eq(s.userRoles.id, id));
    await logActivity(c.var.db, c.var.user.id, 'edit', 'userRole', id, `Потребителска група ${c.req.valid('json').name}`);
    return c.json({ ok: true });
  })

  .delete('/roles/:id', requirePermission(USERS), async (c) => {
    const { db } = c.var;
    const id = Number(c.req.param('id'));
    const [r] = await db.select().from(s.userRoles).where(eq(s.userRoles.id, id));
    if (!r) throw notFound('Групата');
    if (r.isReadOnly) throw badRequest('Тази група не може да бъде изтрита.');
    const members = await db.select({ id: s.users.id }).from(s.users).where(and(eq(s.users.userRoleId, id), eq(s.users.isDeleted, false))).limit(1);
    if (members.length) throw badRequest('Групата не може да бъде изтрита, тъй като в нея има потребители.');
    await db.transaction(async (tx) => {
      // Deleted users keep their group reference; park them on the root so the group row can go.
      await tx.update(s.users).set({ userRoleId: 1 }).where(and(eq(s.users.userRoleId, id), eq(s.users.isDeleted, true)));
      await tx.delete(s.userRoles).where(eq(s.userRoles.id, id));
      await rebuildRoleTree(tx);
      await logActivity(tx, c.var.user.id, 'delete', 'userRole', id, `Потребителска група ${r.name}`);
    });
    return c.json({ ok: true });
  })

  /** Permission tree with explicit and effective values for a role. */
  .get('/roles/:id/permissions', requirePermission(USERS), async (c) => {
    const { db } = c.var;
    const roleId = Number(c.req.param('id'));
    const perms = await db.select().from(s.permissions).orderBy(asc(s.permissions.parentId), asc(s.permissions.groupOrder));
    const rows = await db.select().from(s.userRolePermissions).where(eq(s.userRolePermissions.userRoleId, roleId));
    const values = new Map(rows.map((r) => [r.permissionId, r.value]));
    const byKey = new Map(perms.map((p) => [p.key, p]));
    const byId = new Map(perms.map((p) => [p.id, p]));
    return c.json(perms.map((p) => ({
      id: p.id, key: p.key, name: p.name, parentId: p.parentId, groupOrder: p.groupOrder,
      value: values.get(p.id) ?? null,
      effective: roleId === ADMIN_ROLE ? true : resolvePermission(p.key, byKey, byId, values),
    })));
  })

  /** Set explicit values ({permissionId: true|false|null}); null removes the override. */
  .put('/roles/:id/permissions', requirePermission(USERS), zValidator('json', z.record(z.string(), z.boolean().nullable())), async (c) => {
    const { db } = c.var;
    const roleId = Number(c.req.param('id'));
    if (roleId === ADMIN_ROLE || roleId === 1) throw badRequest('Правата на администратора не могат да бъдат променяни.');
    const body = c.req.valid('json');
    await db.transaction(async (tx) => {
      for (const [k, v] of Object.entries(body)) {
        const permissionId = Number(k);
        await tx.delete(s.userRolePermissions).where(and(eq(s.userRolePermissions.userRoleId, roleId), eq(s.userRolePermissions.permissionId, permissionId)));
        if (v !== null) await tx.insert(s.userRolePermissions).values({ userRoleId: roleId, permissionId, value: v });
      }
      // 01b 8: Delta does not log permission changes; the rebuild keeps an audit trail.
      const [role] = await tx.select({ name: s.userRoles.name }).from(s.userRoles).where(eq(s.userRoles.id, roleId));
      await logActivity(tx, c.var.user.id, 'edit', 'userRolePermissions', roleId, `Права на група ${role?.name ?? roleId} (${Object.keys(body).length})`);
    });
    return c.json({ ok: true });
  });

/** Other non-deleted administrators, with their rows locked to the end of the transaction (SELECT ... FOR UPDATE). */
async function lockedAdminCount(db: DbOrTx, exceptId: number) {
  const r = await db.select({ id: s.users.id }).from(s.users)
    .where(and(eq(s.users.userRoleId, ADMIN_ROLE), eq(s.users.isDeleted, false))).for('update');
  return r.filter((x) => x.id !== exceptId).length;
}

async function rebuildRoleTree(db: DbOrTx) {
  const rows = await db.select().from(s.userRoles);
  let n = 1;
  const visit = async (id: number, level: number) => {
    const left = n++;
    for (const k of rows.filter((r) => r.parentId === id).sort((a, b) => a.id - b.id)) await visit(k.id, level + 1);
    await db.update(s.userRoles).set({ leftIndex: left, rightIndex: n++, level }).where(eq(s.userRoles.id, id));
  };
  await visit(1, 0);
}
