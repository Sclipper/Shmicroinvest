/**
 * Released migrations are frozen: a database that already ran a migration
 * never runs it again, so editing one would leave old and new installations
 * with different schemas. src/db/migrations.lock.json records, for every
 * migration, the SHA-256 of its SQL and snapshot and its journal timestamp.
 *
 *   node scripts/migration-checksums.ts --check   fail when a recorded migration changed or disappeared,
 *                                                 or a migration is not recorded yet
 *   node scripts/migration-checksums.ts --add     record new migrations (never rewrites recorded ones);
 *                                                 `pnpm db:generate` runs it after drizzle-kit
 *
 * test/migrations.test.ts runs the check with the server tests.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DB_DIR = path.resolve(import.meta.dirname, '../src/db');
export const LOCK_FILE = path.join(DB_DIR, 'migrations.lock.json');
const KINDS = ['company', 'catalog'] as const;

export interface LockEntry { when: number; sql: string; snapshot: string }
export type Lock = Record<string, LockEntry>;

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The migrations on disk, keyed "<kind>/<tag>". */
export function currentMigrations(): Lock {
  const out: Lock = {};
  for (const kind of KINDS) {
    const dir = path.join(DB_DIR, kind, 'migrations');
    const journal = JSON.parse(readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
    for (const e of journal.entries) {
      const snapshot = path.join(dir, 'meta', `${String(e.idx).padStart(4, '0')}_snapshot.json`);
      out[`${kind}/${e.tag}`] = { when: e.when, sql: sha256(path.join(dir, `${e.tag}.sql`)), snapshot: existsSync(snapshot) ? sha256(snapshot) : '' };
    }
  }
  return out;
}

export function readLock(): Lock {
  return existsSync(LOCK_FILE) ? (JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as Lock) : {};
}

/** Problems of the migrations against the lock (empty = fine). */
export function checkMigrations(lock = readLock(), current = currentMigrations()): string[] {
  const problems: string[] = [];
  for (const [key, locked] of Object.entries(lock)) {
    const now = current[key];
    if (!now) problems.push(`${key}: released migration was removed`);
    else {
      if (now.sql !== locked.sql) problems.push(`${key}: released migration SQL was modified`);
      if (now.snapshot !== locked.snapshot) problems.push(`${key}: released migration snapshot was modified`);
      if (now.when !== locked.when) problems.push(`${key}: journal timestamp of a released migration changed`);
    }
  }
  for (const key of Object.keys(current)) if (!lock[key]) problems.push(`${key}: new migration is not recorded (run: pnpm --filter @shmi/server db:lock)`);
  return problems;
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === '--add') {
    const lock = readLock();
    const current = currentMigrations();
    const changed = checkMigrations(lock, current).filter((p) => !p.includes('not recorded'));
    if (changed.length) {
      console.error(`Released migrations must not change; add a new migration instead:\n  ${changed.join('\n  ')}`);
      process.exit(1);
    }
    const added = Object.keys(current).filter((k) => !lock[k]);
    for (const k of added) lock[k] = current[k]!;
    writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + '\n');
    console.log(added.length ? `Recorded ${added.join(', ')}` : 'No new migrations.');
  } else if (mode === '--check') {
    const problems = checkMigrations();
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    console.log('Migrations match migrations.lock.json.');
  } else {
    console.error('usage: migration-checksums.ts --check | --add');
    process.exit(2);
  }
}
