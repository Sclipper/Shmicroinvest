import { Hono } from 'hono';
import { zValidator } from '../lib/validate.ts';
import { z } from 'zod';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { resolvePermission } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { AppEnv } from '../context.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { hashPassword, isStrongPassword, verifyPassword } from '../lib/password.ts';
import { requirePermission } from '../session.ts';
import { logActivity } from '../services/audit.ts';

const ADMIN_ROLE = 2;
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
    password: z.string().max(200),
    roleId: z.number().int(),
    email: z.string().max(255).nullable().optional(),
  })), async (c) => {
    const { db, user } = c.var;
    const b = c.req.valid('json');
    if (!isStrongPassword(b.password)) throw badRequest('Паролата трябва да е поне 6 символа.');
    const dup = await db.select().from(s.users).where(and(eq(s.users.name, b.name), eq(s.users.isDeleted, false)));
    if (dup.length) throw badRequest('Вече съществува потребител с това име.');
    if (b.roleId === 1) throw badRequest('Изберете потребителска група.');
    const [row] = await db.insert(s.users).values({ name: b.name, passwordHash: await hashPassword(b.password), userRoleId: b.roleId, email: b.email ?? null }).returning();
    await logActivity(db, user.id, 'add', 'user', row!.id, b.name);
    return c.json({ id: row!.id }, 201);
  })

  .put('/users/:id', requirePermission(USERS), zValidator('json', z.object({
    name: z.string().trim().min(1).max(255),
    roleId: z.number().int(),
    email: z.string().max(255).nullable().optional(),
    password: z.string().max(200).optional(),
  })), async (c) => {
    const { db, user } = c.var;
    const id = Number(c.req.param('id'));
    const b = c.req.valid('json');
    const [u] = await db.select().from(s.users).where(eq(s.users.id, id));
    if (!u) throw notFound('Потребителят');
    if (b.roleId === 1) throw badRequest('Изберете потребителска група.');
    if (u.userRoleId === ADMIN_ROLE && b.roleId !== ADMIN_ROLE && (await adminCount(c.var.db, id)) === 0) {
      throw badRequest('Трябва да има поне един потребител администратор.');
    }
    const patch: Partial<typeof s.users.$inferInsert> = { name: b.name, userRoleId: b.roleId, email: b.email ?? null };
    if (b.password !== undefined) {
      if (!isStrongPassword(b.password)) throw badRequest('Паролата трябва да е поне 6 символа.');
      patch.passwordHash = await hashPassword(b.password);
    }
    await db.update(s.users).set(patch).where(eq(s.users.id, id));
    await logActivity(db, user.id, 'edit', 'user', id, b.name);
    return c.json({ ok: true });
  })

  .delete('/users/:id', requirePermission(USERS), async (c) => {
    const { db, user } = c.var;
    const id = Number(c.req.param('id'));
    if (id === user.id) throw badRequest('Не можете да изтриете активния потребител.');
    const [u] = await db.select().from(s.users).where(eq(s.users.id, id));
    if (!u) throw notFound('Потребителят');
    if (u.userRoleId === ADMIN_ROLE && (await adminCount(db, id)) === 0) throw badRequest('Трябва да има поне един потребител администратор.');
    await db.update(s.users).set({ isDeleted: true }).where(eq(s.users.id, id));
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
    return c.json({ ok: true });
  })

  // ---- Roles ----
  .get('/roles', async (c) => c.json(await c.var.db.select().from(s.userRoles).orderBy(asc(s.userRoles.leftIndex))))

  .post('/roles', requirePermission(USERS), zValidator('json', z.object({ name: z.string().trim().min(1).max(50), copyFromId: z.number().int().optional() })), async (c) => {
    const { db } = c.var;
    const b = c.req.valid('json');
    const id = await db.transaction(async (tx) => {
      const [r] = await tx.insert(s.userRoles).values({ name: b.name, parentId: 1 }).returning();
      if (b.copyFromId) {
        const src = await tx.select().from(s.userRolePermissions).where(eq(s.userRolePermissions.userRoleId, b.copyFromId));
        if (src.length) await tx.insert(s.userRolePermissions).values(src.map((p) => ({ permissionId: p.permissionId, userRoleId: r!.id, value: p.value })));
      }
      await rebuildRoleTree(tx);
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
    });
    return c.json({ ok: true });
  })

  /** Audit log (Действия по потребители). */
  .get('/activity', requirePermission('UI_Reporting_UsersActivitiesReport'), async (c) => {
    const q = c.req.query();
    const rows = await c.var.db.select({
      id: s.dataActivityLog.id, userId: s.dataActivityLog.userId, user: s.users.name, activity: s.dataActivityLog.activity,
      entityType: s.dataActivityLog.entityType, entityId: s.dataActivityLog.entityId, description: s.dataActivityLog.description,
      createdAt: s.dataActivityLog.createdAt,
    }).from(s.dataActivityLog).leftJoin(s.users, eq(s.users.id, s.dataActivityLog.userId))
      .where(q.userId ? eq(s.dataActivityLog.userId, Number(q.userId)) : undefined)
      .orderBy(desc(s.dataActivityLog.id)).limit(Number(q.limit ?? 1000));
    return c.json(rows);
  });

async function adminCount(db: AppEnv['Variables']['db'], exceptId: number) {
  const r = await db.select({ id: s.users.id }).from(s.users)
    .where(and(eq(s.users.userRoleId, ADMIN_ROLE), eq(s.users.isDeleted, false), ne(s.users.id, exceptId)));
  return r.length;
}

async function rebuildRoleTree(db: Parameters<typeof adminCount>[0] | Parameters<Parameters<AppEnv['Variables']['db']['transaction']>[0]>[0]) {
  const rows = await db.select().from(s.userRoles);
  let n = 1;
  const visit = async (id: number, level: number) => {
    const left = n++;
    for (const k of rows.filter((r) => r.parentId === id).sort((a, b) => a.id - b.id)) await visit(k.id, level + 1);
    await db.update(s.userRoles).set({ leftIndex: left, rightIndex: n++, level }).where(eq(s.userRoles.id, id));
  };
  await visit(1, 0);
}
