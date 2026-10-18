/**
 * Company backup file names (spec 01b 2): "<product> - <company> - dd.MM.yyyy_HH.mm".
 */
export const BACKUP_PRODUCT_NAME = 'Shmelta Pro';
export const BACKUP_EXTENSION = '.shbak';
export const BACKUP_FORMAT_VERSION = 1;

/** Quotes removed; "/" and "\" -> "-"; only [a-zA-Zа-яА-Я0-9 _-] kept. */
export function sanitizeCompanyName(name: string): string {
  return name
    .replace(/["'„“”«»]/g, '')
    .replace(/[\\/]/g, '-')
    .replace(/[^a-zA-Zа-яА-Я0-9 _-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const pad = (n: number) => String(n).padStart(2, '0');

export function backupFileName(companyName: string, at: Date, product = BACKUP_PRODUCT_NAME): string {
  const stamp = `${pad(at.getDate())}.${pad(at.getMonth() + 1)}.${at.getFullYear()}_${pad(at.getHours())}.${pad(at.getMinutes())}`;
  return `${product} - ${sanitizeCompanyName(companyName) || 'Фирма'} - ${stamp}${BACKUP_EXTENSION}`;
}

export interface ParsedBackupName { product: string; company: string; date: string; time: string }

/** Parses "<product> - <company> - dd.MM.yyyy_HH.mm[.ext]"; null when it does not match. */
export function parseBackupFileName(fileName: string): ParsedBackupName | null {
  const base = fileName.replace(/\.(shbak|zip|bak|gz)$/i, '');
  const m = /^(.+?) - (.*) - (\d{2})\.(\d{2})\.(\d{4})_(\d{2})\.(\d{2})$/.exec(base);
  if (!m) return null;
  return { product: m[1]!, company: m[2]!, date: `${m[5]}-${m[4]}-${m[3]}`, time: `${m[6]}:${m[7]}` };
}

/** Header stored at the start of a backup file. */
export interface BackupHeader {
  format: number;
  product: string;
  version: string;
  companyName: string;
  database: string;
  createdAt: string;
  /** "pglite-datadir" (PGlite dumpDataDir) or "logical-json" (any driver). */
  kind: 'pglite-datadir' | 'logical-json';
}

/** Dotted version compare ("1.01.089"): -1, 0, 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
