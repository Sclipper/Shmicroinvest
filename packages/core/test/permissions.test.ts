import { describe, expect, it } from 'vitest';
import { PERMISSIONS, resolvePermission } from '../src/index.ts';

describe('asset report permissions (03b 1)', () => {
  it('the МОЛ stocktake report has its own row under the assets reports group, so denying the group denies it', () => {
    const rows = PERMISSIONS.map(([id, key, , parentId]) => ({ id, key, parentId, defaultValue: true }));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const group = byKey.get('UI_Reporting_Depreciations')!.id;
    expect(resolvePermission('UI_Reporting_Depreciations_InventoryListMOL', byKey, byId, new Map([[group, false]]))).toBe(false);
    expect(resolvePermission('UI_Reporting_Depreciations_InventoryListMOL', byKey, byId, new Map())).toBe(true);
  });
});

describe('permission keys (01b 3.6)', () => {
  it('every UI_ key used by the server, the web app and core is seeded, so none fails open', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dirname, '../../..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) { if (f !== 'node_modules' && f !== 'migrations') walk(p); } else if (/\.tsx?$/.test(f)) files.push(p);
      }
    };
    for (const d of ['apps/server/src', 'apps/web/src', 'packages/core/src']) walk(join(root, d));
    const seeded = new Set(PERMISSIONS.map(([, key]) => key));
    const used = new Set(files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/'(UI_[A-Za-z_]+)'/g)].map((m) => m[1]!)));
    expect([...used].filter((k) => !seeded.has(k))).toEqual([]);
  });
});
