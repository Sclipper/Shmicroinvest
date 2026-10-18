import { request } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { ADMIN, BASE_URL, COMPANY, MODULE_COMPANIES, moduleState, type ModuleKey } from './tests/fixtures.ts';

/** Creates the test company (first run) and stores the admin session. */
export default async function globalSetup() {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const res = await ctx.post('/api/companies', {
    data: { companyName: COMPANY.name, bulstat: COMPANY.bulstat, adminName: ADMIN.name, adminPassword: ADMIN.password, year: 2026 },
  });
  if (res.status() !== 201) throw new Error(`Company setup failed: ${res.status()} ${await res.text()}`);
  mkdirSync('.auth', { recursive: true });
  await ctx.storageState({ path: '.auth/admin.json' });
  // One company per module spec; the admin session above stays valid.
  for (const [key, name] of Object.entries(MODULE_COMPANIES) as [ModuleKey, string][]) {
    const own = await ctx.post('/api/companies', { data: { companyName: name, adminName: ADMIN.name, adminPassword: ADMIN.password, year: 2026 } });
    if (own.status() !== 201) throw new Error(`Company setup failed: ${own.status()} ${await own.text()}`);
    await ctx.storageState({ path: moduleState(key) });
  }
  await ctx.dispose();
}
