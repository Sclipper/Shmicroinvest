import { readFileSync } from 'node:fs';
import {
  DataImportError, critical, dueOffsiteRun, msg, offsiteObjectName, offsitePruneKeys, parseBackupFileName, parseOffsiteSchedule, zipStore,
  type OffsiteSchedule,
} from '@shmi/core';
import * as cat from '../../db/catalog/schema.ts';
import type { DbDriver } from '../../db/provider.ts';
import { logApp } from '../appLog.ts';
import { buildBackup } from '../exchange/backup.ts';
import { S3Client, type S3Config } from './s3.ts';

/**
 * Off-site backups (the cloud archive of 01b 2 / 04b 3, adapted): every
 * company's backup, as a ZIP (password-protected when a password is set), in
 * S3-compatible object storage, on a daily schedule and on demand after
 * "Архивиране"; the restore screen lists and restores them. Configured by
 * environment variables (all optional; without a bucket the feature is off):
 *
 *   SHMI_BACKUP_S3_ENDPOINT     https://s3.eu-central-1.amazonaws.com, https://fsn1.your-objectstorage.com,
 *                               https://s3.eu-central-003.backblazeb2.com, http://127.0.0.1:9000 (MinIO)
 *   SHMI_BACKUP_S3_REGION       us-east-1 (default), eu-central-1, fsn1, eu-central-003 ...
 *   SHMI_BACKUP_S3_BUCKET       bucket name (required)
 *   SHMI_BACKUP_S3_ACCESS_KEY   access key id (required)
 *   SHMI_BACKUP_S3_SECRET_KEY   secret access key (or SHMI_BACKUP_S3_SECRET_KEY_FILE: a file holding it)
 *   SHMI_BACKUP_S3_PATH_STYLE   true/false; default: virtual-hosted URLs for *.amazonaws.com, path-style elsewhere
 *   SHMI_BACKUP_PREFIX          key prefix, default "shmelta/"; archives go to <prefix><database>/<file>.zip
 *   SHMI_BACKUP_SCHEDULE        "daily 02:00" (default), "02:00,14:00", or "off" (uploads on demand only)
 *   SHMI_BACKUP_KEEP            archives kept per company (prune rule of 04b 3), default 14
 *   SHMI_BACKUP_ZIP_PASSWORD    password of the uploaded ZIPs (optional; a user's own ZipPassword is used
 *                               for the uploads that user starts)
 *   SHMI_BACKUP_TIMEOUT_MS      request timeout, default 60000
 */

export interface OffsiteSettings {
  s3: S3Config;
  prefix: string;
  schedule: OffsiteSchedule | null;
  keep: number;
  zipPassword: string | null;
}

type Env = Record<string, string | undefined>;

/** The settings from the environment; null when no storage is configured. Throws on an incomplete configuration. */
export function offsiteSettings(env: Env = process.env): OffsiteSettings | null {
  const bucket = env.SHMI_BACKUP_S3_BUCKET?.trim();
  if (!bucket) return null;
  const endpoint = env.SHMI_BACKUP_S3_ENDPOINT?.trim() || `https://s3.${env.SHMI_BACKUP_S3_REGION?.trim() || 'us-east-1'}.amazonaws.com`;
  const accessKeyId = env.SHMI_BACKUP_S3_ACCESS_KEY?.trim() ?? '';
  let secretAccessKey = env.SHMI_BACKUP_S3_SECRET_KEY ?? '';
  if (!secretAccessKey && env.SHMI_BACKUP_S3_SECRET_KEY_FILE) secretAccessKey = readFileSync(env.SHMI_BACKUP_S3_SECRET_KEY_FILE, 'utf8').trim();
  if (!accessKeyId || !secretAccessKey) throw new Error('Off-site backups: SHMI_BACKUP_S3_ACCESS_KEY and SHMI_BACKUP_S3_SECRET_KEY are required with SHMI_BACKUP_S3_BUCKET');
  const host = new URL(endpoint).hostname;
  const pathStyleEnv = env.SHMI_BACKUP_S3_PATH_STYLE?.trim().toLowerCase();
  const pathStyle = pathStyleEnv ? ['1', 'true', 'yes'].includes(pathStyleEnv) : !host.endsWith('amazonaws.com');
  let prefix = (env.SHMI_BACKUP_PREFIX ?? 'shmelta/').trim().replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  const keep = env.SHMI_BACKUP_KEEP ? Number(env.SHMI_BACKUP_KEEP) : 14;
  if (!Number.isInteger(keep) || keep < 1) throw new Error('Off-site backups: SHMI_BACKUP_KEEP must be a whole number of at least 1');
  return {
    s3: { endpoint, region: env.SHMI_BACKUP_S3_REGION?.trim() || 'us-east-1', bucket, accessKeyId, secretAccessKey, pathStyle, timeoutMs: Number(env.SHMI_BACKUP_TIMEOUT_MS) || 60_000 },
    prefix,
    schedule: parseOffsiteSchedule(env.SHMI_BACKUP_SCHEDULE ?? 'daily 02:00'),
    keep,
    zipPassword: env.SHMI_BACKUP_ZIP_PASSWORD || null,
  };
}

/** The storage settings for a request: strCloudArchiveNotConfigured when there are none. */
export function requireOffsite(env: Env = process.env): OffsiteSettings {
  const s = offsiteSettings(env);
  if (!s) throw new DataImportError(critical('strCloudArchiveNotConfigured'));
  return s;
}

/** A storage failure (network, credentials, bucket): strCannotConnectToCloud with the cause as detail. */
function cannotConnect(e: unknown): never {
  if (e instanceof DataImportError) throw e;
  throw new DataImportError(critical('strCannotConnectToCloud'), [(e as Error)?.message ?? String(e)]);
}

const folderOf = (s: OffsiteSettings, database: string) => `${s.prefix}${database}/`;

/**
 * Uploads a backup file as `<prefix><database>/<name>.zip`, then prunes the
 * company's older archives (keep N, 04b 3).
 */
export async function uploadOffsite(s: OffsiteSettings, database: string, backup: { fileName: string; data: Uint8Array }, password: string | null, now = new Date()) {
  const client = new S3Client(s.s3);
  const name = offsiteObjectName(backup.fileName);
  const key = folderOf(s, database) + name;
  const zip = zipStore([{ name: backup.fileName, data: backup.data }], now, password);
  try {
    await client.put(key, zip);
    const existing = await client.list(folderOf(s, database));
    const prune = offsitePruneKeys(key, existing, s.keep);
    for (const k of prune) await client.delete(k);
    return { key, name, size: zip.length, pruned: prune, message: msg('strZipArchivedToCloud', name) };
  } catch (e) {
    cannotConnect(e);
  }
}

export interface OffsiteArchive {
  key: string;
  name: string;
  database: string;
  companyName: string;
  date: string | null;
  size: number;
  lastModified: string;
}

/** The archives in the storage (newest first); only files named like backups. */
export async function listOffsiteArchives(s: OffsiteSettings): Promise<OffsiteArchive[]> {
  let objects;
  try {
    objects = await new S3Client(s.s3).list(s.prefix);
  } catch (e) {
    cannotConnect(e);
  }
  const out: OffsiteArchive[] = [];
  for (const o of objects) {
    const rest = o.key.slice(s.prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || rest.indexOf('/', slash + 1) >= 0) continue;
    const name = rest.slice(slash + 1);
    const parsed = parseBackupFileName(name);
    if (!parsed || !name.toLowerCase().endsWith('.zip')) continue;
    out.push({ key: o.key, name, database: rest.slice(0, slash), companyName: parsed.company, date: `${parsed.date} ${parsed.time}`, size: o.size, lastModified: o.lastModified });
  }
  return out.sort((a, b) => (a.lastModified === b.lastModified ? b.key.localeCompare(a.key) : a.lastModified < b.lastModified ? 1 : -1));
}

/** Downloads one archive (a key under the prefix, as listed). */
export async function fetchOffsiteArchive(s: OffsiteSettings, key: string): Promise<Uint8Array> {
  const rest = key.startsWith(s.prefix) ? key.slice(s.prefix.length) : null;
  if (!rest || rest.split('/').length !== 2 || rest.split('/').some((p) => !p || p === '.' || p === '..') || !rest.toLowerCase().endsWith('.zip')) {
    throw new DataImportError(critical('strCloudArchiveNotFound', key));
  }
  try {
    return await new S3Client(s.s3).get(key);
  } catch (e) {
    if ((e as { status?: number }).status === 404) throw new DataImportError(critical('strCloudArchiveNotFound', rest.split('/')[1]!));
    cannotConnect(e);
  }
}

export interface OffsiteRunResult { database: string; companyName: string; ok: boolean; name?: string; pruned?: number; error?: string }

/** Last automatic (or "all companies") run, for the restore screen and the log. */
export const offsiteState: { lastRun: { slot: string; at: string; results: OffsiteRunResult[] } | null; running: boolean } = { lastRun: null, running: false };

/** Backs up every company of the catalog to the storage; one failing company does not stop the others. */
export async function runOffsiteBackups(driver: DbDriver, s: OffsiteSettings, now = new Date()): Promise<OffsiteRunResult[]> {
  const catalog = await driver.catalog();
  const companies = await catalog.select({ name: cat.companiesCatalog.name, companyName: cat.companiesCatalog.companyName }).from(cat.companiesCatalog);
  const results: OffsiteRunResult[] = [];
  for (const c of companies) {
    try {
      const backup = await buildBackup(driver, c.name, now);
      const r = await uploadOffsite(s, c.name, backup, s.zipPassword, now);
      results.push({ database: c.name, companyName: backup.companyName, ok: true, name: r.name, pruned: r.pruned.length });
      await logApp({ level: 'info', message: msg('strZipArchivedToCloud', r.name), company: c.name });
    } catch (e) {
      const error = e instanceof DataImportError ? e.message : (e as Error).message;
      results.push({ database: c.name, companyName: c.companyName, ok: false, error });
      await logApp({ level: 'error', message: msg('strCannotConnectToCloud'), details: error, company: c.name });
    }
  }
  return results;
}

/** "YYYY-MM-DD HH:MM" in the company time zone. */
export function localMinute(d: Date, tz = process.env.TZ_COMPANY ?? 'Europe/Sofia') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * The daily schedule: checked every minute; a run time that passes while the
 * server runs starts a run of every company (no catch-up of runs missed
 * while the server was down). Returns a stop function.
 */
export function startOffsiteScheduler(driver: DbDriver, s: OffsiteSettings, o: { intervalMs?: number; now?: () => Date } = {}) {
  const schedule = s.schedule;
  if (!schedule) return () => {};
  const now = o.now ?? (() => new Date());
  let last = localMinute(now());
  const tick = async () => {
    if (offsiteState.running) return;
    const slot = dueOffsiteRun(schedule, localMinute(now()), last);
    if (!slot) return;
    last = slot;
    offsiteState.running = true;
    try {
      const results = await runOffsiteBackups(driver, s, now());
      offsiteState.lastRun = { slot, at: now().toISOString(), results };
    } finally {
      offsiteState.running = false;
    }
  };
  const timer = setInterval(() => void tick().catch((e) => logApp({ level: 'error', message: msg('strCannotConnectToCloud'), details: (e as Error).message })), o.intervalMs ?? 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
