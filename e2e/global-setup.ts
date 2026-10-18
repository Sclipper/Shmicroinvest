import { request } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { ADMIN, BASE_URL, COMPANY, STATEMENTS_COMPANY } from './tests/fixtures.ts';

/** Creates the test company (first run) and stores the admin session. */
export default async function globalSetup() {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const res = await ctx.post('/api/companies', {
    data: { companyName: COMPANY.name, bulstat: COMPANY.bulstat, adminName: ADMIN.name, adminPassword: ADMIN.password, year: 2026 },
  });
  if (res.status() !== 201) throw new Error(`Company setup failed: ${res.status()} ${await res.text()}`);
  mkdirSync('.auth', { recursive: true });
  await ctx.storageState({ path: '.auth/admin.json' });
  // A second company for specs that need data no other spec touches; the admin session above stays valid.
  const own = await ctx.post('/api/companies', {
    data: { companyName: STATEMENTS_COMPANY.name, adminName: ADMIN.name, adminPassword: ADMIN.password, year: 2026 },
  });
  if (own.status() !== 201) throw new Error(`Company setup failed: ${own.status()} ${await own.text()}`);
  await ctx.storageState({ path: STATEMENTS_COMPANY.state });
  await ctx.dispose();
}
