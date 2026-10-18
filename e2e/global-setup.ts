import { request } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { ADMIN, BASE_URL, COMPANY } from './tests/fixtures.ts';

/** Creates the test company (first run) and stores the admin session. */
export default async function globalSetup() {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const res = await ctx.post('/api/companies', {
    data: { companyName: COMPANY.name, bulstat: COMPANY.bulstat, adminName: ADMIN.name, adminPassword: ADMIN.password, year: 2026 },
  });
  if (res.status() !== 201) throw new Error(`Company setup failed: ${res.status()} ${await res.text()}`);
  mkdirSync('.auth', { recursive: true });
  await ctx.storageState({ path: '.auth/admin.json' });
  await ctx.dispose();
}
