import { describe, expect, it } from 'vitest';
import { checkMigrations, currentMigrations, readLock } from '../scripts/migration-checksums.ts';

/**
 * Released migrations are frozen (AGENTS.md): schema changes add a new
 * migration with `pnpm --filter @shmi/server db:generate`, which also records
 * it in src/db/migrations.lock.json. This fails when a recorded migration is
 * edited, renamed or removed, or a new one is not recorded.
 */
describe('migration lock', () => {
  it('every migration is recorded and unchanged', () => {
    expect(checkMigrations()).toEqual([]);
  });

  it('includes the 1.0.0 baselines', () => {
    const lock = readLock();
    expect(Object.keys(lock)).toEqual(expect.arrayContaining(['company/0000_baseline_1_0_0', 'catalog/0000_baseline_1_0_0']));
  });

  it('detects an edited, a removed and an unrecorded migration', () => {
    const lock = readLock();
    const current = currentMigrations();
    const key = 'company/0000_baseline_1_0_0';
    expect(checkMigrations(lock, { ...current, [key]: { ...current[key]!, sql: '0'.repeat(64) } })).toEqual([`${key}: released migration SQL was modified`]);
    const { [key]: _removed, ...rest } = current;
    expect(checkMigrations(lock, rest)).toEqual([`${key}: released migration was removed`]);
    expect(checkMigrations(lock, { ...current, 'company/0001_new': { when: 1, sql: 'a', snapshot: 'b' } })).toEqual([
      'company/0001_new: new migration is not recorded (run: pnpm --filter @shmi/server db:lock)',
    ]);
  });
});
