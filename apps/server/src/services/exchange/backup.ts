import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { desc, eq } from 'drizzle-orm';
import {
  BACKUP_FORMAT_VERSION, BACKUP_PRODUCT_NAME, backupFileName, compareVersions, critical, DataImportError, msg, type BackupHeader,
} from '@shmi/core';
import * as cat from '../../db/catalog/schema.ts';
import * as s from '../../db/company/schema/index.ts';
import type { CompanyDb, DbDriver } from '../../db/provider.ts';
import { decodeLogicalDump, encodeLogicalDump, logicalDump, logicalRestore } from '../../db/logicalDump.ts';
import { PRODUCT_VERSION } from '../companySetup.ts';

/**
 * Company backup and restore (spec 01b 2). A backup file is
 *   "SHMBAK1\n" + JSON header + "\n" + payload
 * where the payload is the PGlite data directory (dumpDataDir, gzip) or a
 * gzip'ed logical JSON dump (Postgres). Either kind restores on either driver.
 */
const MAGIC = 'SHMBAK1\n';

export function encodeBackup(header: BackupHeader, payload: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(MAGIC + JSON.stringify(header) + '\n');
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

export function decodeBackup(bytes: Uint8Array): { header: BackupHeader; payload: Uint8Array } {
  const magic = new TextDecoder().decode(bytes.slice(0, MAGIC.length));
  if (magic !== MAGIC) throw new DataImportError(critical('strInvalidChoosenFilePathError'));
  const nl = bytes.indexOf(10, MAGIC.length);
  if (nl < 0) throw new DataImportError(critical('strInvalidChoosenFilePathError'));
  let header: BackupHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.slice(MAGIC.length, nl)));
  } catch {
    throw new DataImportError(critical('strInvalidChoosenFilePathError'));
  }
  if (!header || header.format > BACKUP_FORMAT_VERSION || !['pglite-datadir', 'logical-json'].includes(header.kind)) throw new DataImportError(critical('strInvalidChoosenFilePathError'));
  return { header, payload: bytes.slice(nl + 1) };
}

/** Physical name of a restored company: delta_<yyMMddHHmmss><random> (same shape as a new company). */
export function newDatabaseName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `delta_${stamp}${randomBytes(2).toString('hex')}`;
}

async function companyName(db: CompanyDb) {
  const [sys] = await db.select().from(s.system).limit(1);
  return sys?.companyName ?? '';
}

/** Takes a backup of a company database and stores it in the catalog's backup store. */
export async function createBackup(driver: DbDriver, database: string, now = new Date()) {
  const db = await driver.company(database);
  const name = await companyName(db);
  const kind: BackupHeader['kind'] = driver.kind === 'pglite' ? 'pglite-datadir' : 'logical-json';
  const payload = await driver.dump(database);
  const header: BackupHeader = { format: BACKUP_FORMAT_VERSION, product: BACKUP_PRODUCT_NAME, version: PRODUCT_VERSION, companyName: name, database, createdAt: now.toISOString(), kind };
  const data = encodeBackup(header, payload);
  const fileName = backupFileName(name, now);
  const catalog = await driver.catalog();
  const [row] = await catalog.insert(cat.companyBackups).values({ fileName, companyName: name, database, version: PRODUCT_VERSION, kind, size: data.length, data }).returning({ id: cat.companyBackups.id });
  return { id: row!.id, fileName, size: data.length, companyName: name };
}

export async function listBackups(driver: DbDriver) {
  const catalog = await driver.catalog();
  return catalog.select({
    id: cat.companyBackups.id, fileName: cat.companyBackups.fileName, companyName: cat.companyBackups.companyName, database: cat.companyBackups.database,
    version: cat.companyBackups.version, kind: cat.companyBackups.kind, size: cat.companyBackups.size, createdAt: cat.companyBackups.createdAt,
  }).from(cat.companyBackups).orderBy(desc(cat.companyBackups.createdAt), desc(cat.companyBackups.id));
}

export async function backupData(driver: DbDriver, id: number) {
  const catalog = await driver.catalog();
  const [row] = await catalog.select().from(cat.companyBackups).where(eq(cat.companyBackups.id, id));
  return row ?? null;
}

/** Loads a backup payload into database `name` (replacing it when it exists). */
async function restoreInto(driver: DbDriver, name: string, header: BackupHeader, payload: Uint8Array, exists: boolean) {
  if (header.kind === 'pglite-datadir' && driver.kind === 'pglite') {
    await driver.restore(name, payload);
    return;
  }
  let logical = payload;
  if (header.kind === 'pglite-datadir') {
    // Data directory on a Postgres server: read it with a temporary PGlite.
    const tmp = new PGlite({ loadDataDir: new Blob([payload as Uint8Array<ArrayBuffer>]) });
    try {
      logical = encodeLogicalDump(await logicalDump(drizzlePglite(tmp) as unknown as CompanyDb));
    } finally {
      await tmp.close();
    }
  }
  if (driver.kind === 'postgres') {
    await driver.restore(name, logical);
    return;
  }
  const dump = decodeLogicalDump(logical);
  if (exists) await driver.dropCompanyDatabase(name);
  const db = await driver.createCompanyDatabase(name);
  await db.transaction((tx) => logicalRestore(tx, dump));
}

export interface RestoreResult { database: string; companyName: string; asNew: boolean; message: string }

/**
 * Restore (01b 2): into the current database (data replaced) or as a new
 * company. A backup made by a newer version is refused.
 */
export async function restoreBackup(driver: DbDriver, bytes: Uint8Array, target: { mode: 'current'; database: string } | { mode: 'new' }): Promise<RestoreResult> {
  const { header, payload } = decodeBackup(bytes);
  if (compareVersions(header.version, PRODUCT_VERSION) > 0) throw new DataImportError(critical('strInconsistentDatabaseVersion', header.version));
  const catalog = await driver.catalog();
  const name = target.mode === 'current' ? target.database : newDatabaseName();
  try {
    await restoreInto(driver, name, header, payload, target.mode === 'current');
  } catch (e) {
    if (e instanceof DataImportError) throw e;
    if (target.mode === 'new') await driver.dropCompanyDatabase(name).catch(() => undefined);
    throw new DataImportError(critical('strRestoreCompanyError'), [(e as Error).message]);
  }
  const db = await driver.company(name);
  const restoredName = (await companyName(db)) || header.companyName;
  await db.update(s.system).set({ version: PRODUCT_VERSION });
  if (target.mode === 'current') {
    await catalog.update(cat.companiesCatalog).set({ companyName: restoredName, version: PRODUCT_VERSION }).where(eq(cat.companiesCatalog.name, name));
  } else {
    await catalog.insert(cat.companiesCatalog).values({ name, companyName: restoredName, version: PRODUCT_VERSION });
  }
  return {
    database: name, companyName: restoredName, asNew: target.mode === 'new',
    message: target.mode === 'new' ? msg('strRestoreDatabaseBackupInDifferentDatabaseSucceded', restoredName) : msg('strRestoreDatabaseBackupSucceded'),
  };
}

/** Delete company (not a Delta feature, 01b 1.2): automatic backup, then drop and remove from the catalog. */
export async function deleteCompany(driver: DbDriver, database: string) {
  const backup = await createBackup(driver, database);
  await driver.dropCompanyDatabase(database);
  const catalog = await driver.catalog();
  await catalog.delete(cat.sessions).where(eq(cat.sessions.companyDb, database));
  await catalog.delete(cat.companiesCatalog).where(eq(cat.companiesCatalog.name, database));
  return { backup, message: msg('strDeleteCompanyDone', backup.companyName, backup.fileName) };
}
