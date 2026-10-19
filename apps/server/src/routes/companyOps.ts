import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { isZip, msg, zipStore } from '@shmi/core';
import * as cat from '../db/catalog/schema.ts';
import * as s from '../db/company/schema/index.ts';
import type { AppEnv } from '../context.ts';
import { ApiError, notFound } from '../lib/errors.ts';
import { verifyPassword } from '../lib/password.ts';
import { zValidator } from '../lib/validate.ts';
import { createSession, requirePermission } from '../session.ts';
import { logActivity } from '../services/audit.ts';
import { backupData, backupFromZip, createBackup, deleteBackup, deleteCompany, listBackups, restoreBackup, type BackupScope } from '../services/exchange/backup.ts';
import { zipPasswordOf } from '../services/localSettings.ts';
import { importStep, readUpload } from '../services/exchange/common.ts';
import { convertDatabaseToEuro, euroMappingGrid } from '../services/exchange/euro.ts';
import { fetchOffsiteArchive, listOffsiteArchives, offsiteSettings, offsiteState, requireOffsite, runOffsiteBackups, uploadOffsite } from '../services/offsite/offsite.ts';

const download = (c: { header: (k: string, v: string) => void; body: (b: ArrayBuffer) => Response }, data: Uint8Array, name: string) => {
  c.header('content-type', 'application/octet-stream');
  c.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  return c.body(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
};

/** After a restore: keep the active user by id, else the first user (01b 2). */
async function switchTo(c: Parameters<typeof createSession>[0], database: string, userId: number) {
  const db = await c.var.driver.company(database);
  const users = await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.isDeleted, false));
  const same = users.find((u) => u.id === userId);
  await createSession(c, database, same?.id ?? users[0]?.id ?? 1);
}

const requireAdmin = (c: { var: AppEnv['Variables'] }) => {
  if (!c.var.user.isAdmin) throw new ApiError(403, 'Нямате права за тази операция.');
};

const scopeOf = (c: { var: AppEnv['Variables'] }): BackupScope => ({ database: c.var.session.companyDb!, isAdmin: !!c.var.user.isAdmin });

export const companyOpsRoutes = new Hono<AppEnv>()
  /** "Активна фирма" (Ctrl+A). */
  .get('/company/active', async (c) => {
    const [sys] = await c.var.db.select().from(s.system).limit(1);
    const [my] = await c.var.db.select().from(s.myCompany).limit(1);
    const name = my?.name ?? sys?.companyName ?? '';
    return c.json({ database: c.var.session.companyDb, companyName: name, version: sys?.version, message: msg('strActiveCompanyInfo', name, my?.bulstat ?? '') });
  })

  // ------------------------------------------------------------------ backup / restore (01b 2)
  .get('/backups', requirePermission('UI_File_RestoreDatabaseBackup'), async (c) => c.json(await listBackups(c.var.driver, scopeOf(c))))
  .post('/backups', requirePermission('UI_File_BackupDatabase'), async (c) => {
    const r = await createBackup(c.var.driver, c.var.session.companyDb!);
    // With an off-site storage the success message offers the upload (strBackupDatabaseSuccededWithArchiveToCloudQuestion).
    const cloud = offsiteSettings() !== null;
    return c.json({ ...r, message: msg('strBackupDatabaseSucceded'), cloudQuestion: cloud ? msg('strBackupDatabaseSuccededWithArchiveToCloudQuestion') : null }, 201);
  })

  // ------------------------------------------------------------------ off-site (cloud) archive (01b 2, 04b 3)
  /** Archives in the storage, for the restore screen (administrators). */
  .get('/backups/offsite', requirePermission('UI_File_RestoreDatabaseBackup'), async (c) => {
    requireAdmin(c);
    const settings = offsiteSettings();
    if (!settings) return c.json({ configured: false, archives: [], schedule: null, keep: null, lastRun: null });
    const archives = await importStep(() => listOffsiteArchives(settings), false);
    return c.json({ configured: true, archives, schedule: settings.schedule?.times ?? null, keep: settings.keep, lastRun: offsiteState.lastRun });
  })
  /** Uploads a stored backup of the company (the "archive to cloud" offer after Архивиране). */
  .post('/backups/:id/offsite', requirePermission('UI_File_BackupDatabase'), async (c) => {
    const row = await backupData(c.var.driver, Number(c.req.param('id')), scopeOf(c));
    if (!row) throw notFound('Архивът');
    const r = await importStep(async () => {
      const settings = requireOffsite();
      const password = (await zipPasswordOf(c.var.db, c.var.user.id)) ?? settings.zipPassword;
      return uploadOffsite(settings, row.database, { fileName: row.fileName, data: row.data }, password);
    }, false);
    return c.json(r);
  })
  /** Backs up every company to the storage now (as the schedule does; administrators). */
  .post('/backups/offsite/run', requirePermission('UI_File_BackupDatabase'), async (c) => {
    requireAdmin(c);
    const settings = await importStep(async () => requireOffsite(), false);
    const results = await runOffsiteBackups(c.var.driver, settings);
    offsiteState.lastRun = { slot: 'manual', at: new Date().toISOString(), results };
    return c.json({ results });
  })
  /** Restores an archive of the storage (body { key, mode, zipPassword? }; administrators). */
  .post('/backups/offsite/restore', requirePermission('UI_File_RestoreDatabaseBackup'),
    zValidator('json', z.object({ key: z.string().min(1), mode: z.enum(['new', 'current']), zipPassword: z.string().optional() })), async (c) => {
      requireAdmin(c);
      const { key, mode, zipPassword } = c.req.valid('json');
      const bytes = await importStep(async () => {
        const settings = requireOffsite();
        const zip = await fetchOffsiteArchive(settings, key);
        // The password typed in the screen, the storage's, then the user's own ZipPassword.
        const own = await zipPasswordOf(c.var.db, c.var.user.id).catch(() => null);
        const candidates = [...new Set([zipPassword || null, settings.zipPassword, own].filter((p): p is string => !!p))];
        let last: unknown = null;
        for (const p of candidates.length ? candidates : [null]) {
          try {
            return backupFromZip(zip, p);
          } catch (e) {
            last = e;
          }
        }
        throw last;
      }, false);
      const current = c.var.session.companyDb!;
      const userId = c.var.user.id;
      const r = await importStep(() => restoreBackup(c.var.driver, bytes, mode === 'current' ? { mode, database: current } : { mode }), false);
      await switchTo(c, r.database, userId);
      return c.json(r);
    })
  .get('/backups/:id/download', requirePermission('UI_File_BackupDatabase'), async (c) => {
    const row = await backupData(c.var.driver, Number(c.req.param('id')), scopeOf(c));
    if (!row) throw notFound('Архивът');
    // ZipPassword / IsZipPasswordEnabled (06 3.2): the file goes out inside a password-protected ZIP.
    const password = await zipPasswordOf(c.var.db, c.var.user.id);
    if (password) return download(c, zipStore([{ name: row.fileName, data: row.data }], new Date(), password), `${row.fileName}.zip`);
    return download(c, row.data, row.fileName);
  })
  .delete('/backups/:id', requirePermission('UI_File_RestoreDatabaseBackup'), async (c) => {
    if (!(await deleteBackup(c.var.driver, Number(c.req.param('id')), scopeOf(c)))) throw notFound('Архивът');
    return c.json({ ok: true });
  })
  /** Restore from the store (body { id, mode }) or from an uploaded file (fields mode). */
  .post('/backups/restore', requirePermission('UI_File_RestoreDatabaseBackup'), async (c) => {
    let bytes: Uint8Array;
    let mode: 'current' | 'new';
    const type = c.req.header('content-type') ?? '';
    const json = type.includes('application/json') ? ((await c.req.raw.clone().json().catch(() => ({}))) as Record<string, unknown>) : {};
    if (typeof json.id === 'number') {
      const row = await backupData(c.var.driver, json.id, scopeOf(c));
      if (!row) throw notFound('Архивът');
      bytes = row.data;
      mode = json.mode === 'current' ? 'current' : 'new';
    } else {
      const up = await readUpload(c);
      mode = up.fields.mode === 'current' ? 'current' : 'new';
      // A password-protected backup ZIP: the password typed with the upload, else the user's ZipPassword.
      const typed = typeof up.fields.zipPassword === 'string' ? up.fields.zipPassword : null;
      bytes = isZip(up.bytes) ? await importStep(async () => backupFromZip(up.bytes, typed || (await zipPasswordOf(c.var.db, c.var.user.id))), false) : up.bytes;
    }
    const current = c.var.session.companyDb!;
    const userId = c.var.user.id;
    const r = await importStep(() => restoreBackup(c.var.driver, bytes, mode === 'current' ? { mode, database: current } : { mode }), false);
    await switchTo(c, r.database, userId);
    return c.json(r);
  })

  // ------------------------------------------------------------------ delete company (added; not in Delta)
  .post('/companies/:db/delete', zValidator('json', z.object({ userId: z.number().int(), password: z.string() })), async (c) => {
    const database = c.req.param('db');
    if (database === c.var.session.companyDb) throw new ApiError(400, msg('strCannotDeleteActiveCompany'));
    if (!c.var.user.isAdmin) throw new ApiError(403, 'Нямате права за тази операция.');
    const catalog = await c.var.driver.catalog();
    const [row] = await catalog.select().from(cat.companiesCatalog).where(eq(cat.companiesCatalog.name, database));
    if (!row) throw notFound('Фирмата');
    const target = await c.var.driver.company(database);
    const { userId, password } = c.req.valid('json');
    const [u] = await target.select().from(s.users).where(and(eq(s.users.id, userId), eq(s.users.isDeleted, false)));
    if (!u || u.userRoleId !== 2 || !(await verifyPassword(password, u.passwordHash))) throw new ApiError(401, 'Въведено е грешно потребителско име или парола!');
    const r = await deleteCompany(c.var.driver, database);
    await logActivity(c.var.db, c.var.user.id, 'delete', 'company', null, r.message);
    return c.json(r);
  })

  // ------------------------------------------------------------------ euro conversion (04b 4)
  .get('/euro-conversion', async (c) => {
    if (!c.var.user.isAdmin) throw new ApiError(403, 'Нямате права за тази операция.');
    return c.json(await euroMappingGrid(c.var.db));
  })
  .post('/euro-conversion', zValidator('json', z.object({
    relations: z.record(z.string(), z.number().int().nullable()).optional(),
    differencesAccountId: z.number().int().nullable().optional(),
    fixedAssets: z.boolean().optional(), templates: z.boolean().optional(), reschedules: z.boolean().optional(),
    backupFirst: z.boolean().optional(),
  })), async (c) => {
    if (!c.var.user.isAdmin) throw new ApiError(403, 'Нямате права за тази операция.');
    const body = c.req.valid('json');
    let backup: { fileName: string } | null = null;
    if (body.backupFirst) {
      try {
        backup = await createBackup(c.var.driver, c.var.session.companyDb!);
      } catch {
        throw new ApiError(500, msg('strErrorDatabaseBackupWhenConvertingToEuro'));
      }
    }
    const relations = Object.fromEntries(Object.entries(body.relations ?? {}).map(([k, v]) => [Number(k), v]));
    const r = await importStep(() => c.var.db.transaction((tx) => convertDatabaseToEuro(tx, { ...body, relations }, c.var.user.id)), false);
    await logActivity(c.var.db, c.var.user.id, 'edit', 'euro', null, r.message);
    return c.json({ ...r, backup });
  });
