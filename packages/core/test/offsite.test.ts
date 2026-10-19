import { describe, expect, it } from 'vitest';
import { dueOffsiteRun, offsiteObjectName, offsitePruneKeys, parseOffsiteSchedule } from '../src/index.ts';

/** Off-site (cloud) archive rules: schedule, object names, the prune rule of 04b 3. */

describe('schedule', () => {
  it('parses daily times and "off"', () => {
    expect(parseOffsiteSchedule('daily 02:00')).toEqual({ times: ['02:00'] });
    expect(parseOffsiteSchedule('daily@2:00')).toEqual({ times: ['02:00'] });
    expect(parseOffsiteSchedule('14:30, 02:00,14:30')).toEqual({ times: ['02:00', '14:30'] });
    for (const off of ['', 'off', 'OFF', 'none', 'manual', undefined, null]) expect(parseOffsiteSchedule(off)).toBeNull();
    for (const bad of ['25:00', '02:60', 'weekly', 'daily']) expect(() => parseOffsiteSchedule(bad)).toThrow();
  });

  it('the run due now: once per run time, same-day catch-up, never twice', () => {
    const s = { times: ['02:00', '14:00'] };
    expect(dueOffsiteRun(s, '2026-10-19 01:59', null)).toBeNull();
    expect(dueOffsiteRun(s, '2026-10-19 02:00', '2026-10-19 01:59')).toBe('2026-10-19 02:00');
    expect(dueOffsiteRun(s, '2026-10-19 02:01', '2026-10-19 02:00')).toBeNull();
    expect(dueOffsiteRun(s, '2026-10-19 15:10', '2026-10-19 02:00')).toBe('2026-10-19 14:00');
    expect(dueOffsiteRun(s, '2026-10-20 01:00', '2026-10-19 14:00')).toBeNull();
    expect(dueOffsiteRun(s, '2026-10-20 02:00', '2026-10-19 14:00')).toBe('2026-10-20 02:00');
  });
});

describe('object names and the prune rule', () => {
  it('names the archive like Delta: the backup name as .zip', () => {
    expect(offsiteObjectName('Shmelta Pro - Тест ООД - 19.10.2026_02.00.shbak')).toBe('Shmelta Pro - Тест ООД - 19.10.2026_02.00.zip');
  });

  const obj = (name: string, lastModified: string, folder = 'p/db1/') => ({ key: folder + name, size: 1, lastModified });
  const n = (d: string) => `Shmelta Pro - Тест-1 ООД - ${d}_02.00.zip`;

  it('keeps the newest N archives of the same prefix (by last write time), the new one included', () => {
    const objects = [
      obj(n('01.03.2026'), '2026-03-01T00:00:00.000Z'), obj(n('02.03.2026'), '2026-03-02T00:00:00.000Z'), obj(n('03.03.2026'), '2026-03-03T00:00:00.000Z'),
      obj(n('04.03.2026'), '2026-03-04T00:00:00.000Z'),
      // Another company with a name sharing the start (Delta's cut at the second "-" would take it), another folder, a foreign file.
      obj('Shmelta Pro - Тест-2 ООД - 01.01.2026_02.00.zip', '2026-01-01T00:00:00.000Z'), obj(n('01.01.2026'), '2026-01-01T00:00:00.000Z', 'p/db2/'), obj('notes.txt', '2020-01-01T00:00:00.000Z'),
    ];
    expect(offsitePruneKeys(`p/db1/${n('04.03.2026')}`, objects, 3)).toEqual([`p/db1/${n('01.03.2026')}`]);
    // Delta's rule: 2 kept.
    expect(offsitePruneKeys(`p/db1/${n('04.03.2026')}`, objects, 2)).toEqual([`p/db1/${n('01.03.2026')}`, `p/db1/${n('02.03.2026')}`]);
    expect(offsitePruneKeys(`p/db1/${n('04.03.2026')}`, objects, 1)).toHaveLength(3);
    expect(offsitePruneKeys(`p/db1/${n('04.03.2026')}`, objects, 14)).toEqual([]);
  });

  it('same last write time: the date in the name decides (not the dd.MM text order)', () => {
    const same = '2026-03-05T00:00:00.000Z';
    const objects = [obj(n('31.01.2026'), same), obj(n('01.02.2026'), same), obj(n('02.02.2026'), same)];
    expect(offsitePruneKeys(`p/db1/${n('02.02.2026')}`, objects, 2)).toEqual([`p/db1/${n('31.01.2026')}`]);
  });
});
