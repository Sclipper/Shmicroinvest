/**
 * Off-site backups (the cloud archive of spec 01b 2 and 04b 3, adapted): the
 * company backups go to S3-compatible object storage instead of Microinvest's
 * SFTP servers. Pure rules: the schedule, object names and the prune rule.
 */
import { BACKUP_EXTENSION, parseBackupFileName } from './backup.ts';

/** Daily run times ("HH:MM", local company time) of an off-site schedule; null = no automatic runs. */
export interface OffsiteSchedule { times: string[] }

/**
 * Parses the schedule setting: "02:00", "daily 02:00", "daily@02:00" or
 * several times separated by commas ("02:00, 14:30"); "", "off", "none",
 * "manual" = no automatic runs. Throws on anything else.
 */
export function parseOffsiteSchedule(text: string | undefined | null): OffsiteSchedule | null {
  const t = (text ?? '').trim().toLowerCase();
  if (!t || ['off', 'none', 'manual', 'no', 'false', '0'].includes(t)) return null;
  const times = t.replace(/^daily\s*@?\s*/, '').split(/[,;\s]+/).filter(Boolean).map((x) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(x);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Invalid off-site backup schedule "${text}" (expected e.g. "daily 02:00")`);
    return `${m[1]!.padStart(2, '0')}:${m[2]}`;
  });
  if (!times.length) throw new Error(`Invalid off-site backup schedule "${text}"`);
  return { times: [...new Set(times)].sort() };
}

/**
 * The scheduled run that is due at `now` ("YYYY-MM-DD HH:MM", local time):
 * the latest of today's run times already reached, when it is later than the
 * last run made (same form). A server that was down at the run time catches
 * up on the same day; earlier days are not repeated.
 */
export function dueOffsiteRun(schedule: OffsiteSchedule, now: string, lastRun: string | null): string | null {
  const day = now.slice(0, 10);
  const time = now.slice(11, 16);
  const reached = schedule.times.filter((x) => x <= time).pop();
  if (!reached) return null;
  const slot = `${day} ${reached}`;
  return !lastRun || slot > lastRun ? slot : null;
}

/** Object name of a backup in the storage: the backup file name as a ZIP, as Delta names its archives. */
export function offsiteObjectName(backupFileName: string): string {
  return backupFileName.endsWith(BACKUP_EXTENSION) ? `${backupFileName.slice(0, -BACKUP_EXTENSION.length)}.zip` : `${backupFileName}.zip`;
}

export interface OffsiteObject { key: string; size: number; lastModified: string }

/**
 * Prune rule after an upload (FtpService, 04b 3: older files with the same
 * prefix are deleted, sorted by last write time): of the other archives
 * whose name has the new file's prefix ("<product> - <company> - ", the name
 * up to its date; Delta cut at the second "-", which a company name with a
 * dash breaks) the newest `keep - 1` stay, so `keep` archives remain with the
 * new one. Delta keeps 2; the default here is 14. Returns the keys to delete.
 */
export function offsitePruneKeys(newKey: string, objects: OffsiteObject[], keep: number): string[] {
  const base = (k: string) => k.slice(k.lastIndexOf('/') + 1);
  const folder = (k: string) => k.slice(0, k.lastIndexOf('/') + 1);
  const name = base(newKey);
  const cut = name.lastIndexOf(' - ');
  if (cut < 0) return [];
  const prefix = folder(newKey) + name.slice(0, cut + 3);
  // Same LastModified (S3 keeps seconds): the date and time in the name decide.
  const stamp = (k: string) => {
    const p = parseBackupFileName(base(k));
    return p ? `${p.date} ${p.time}` : '';
  };
  const older = objects
    .filter((o) => o.key !== newKey && o.key.startsWith(prefix) && !o.key.slice(prefix.length).includes('/') && parseBackupFileName(base(o.key)))
    .sort((a, b) => (a.lastModified === b.lastModified ? stamp(a.key).localeCompare(stamp(b.key)) || a.key.localeCompare(b.key) : a.lastModified < b.lastModified ? -1 : 1));
  return older.slice(0, Math.max(0, older.length - Math.max(1, keep) + 1)).map((o) => o.key);
}
