import { defineConfig } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { acquireTestSlot } from '../scripts/test-slots.ts';

const PORT = Number(process.env.E2E_PORT ?? 4310);
export const BASE_URL = `http://localhost:${PORT}`;

// The runner process (not its workers, which load this file too) holds one
// machine-wide test slot for the whole run: web build, server and Chrome (scripts/test-slots.ts).
const g = globalThis as { shmiTestSlot?: Promise<unknown> };
if (!process.env.TEST_WORKER_INDEX) g.shmiTestSlot ??= acquireTestSlot(`e2e (port ${PORT}, pid ${process.pid})`);
await g.shmiTestSlot;

/** Use the orb's Chrome for Testing when no Playwright browser is installed. */
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    const root = path.join(homedir(), '.agent-browser', 'browsers');
    const dir = readdirSync(root).filter((d) => d.startsWith('chrome-')).sort().pop();
    return dir ? path.join(root, dir, 'chrome') : undefined;
  } catch {
    return undefined;
  }
}

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: BASE_URL,
    storageState: '.auth/admin.json',
    viewport: { width: 1440, height: 900 },
    locale: 'bg-BG',
    timezoneId: 'Europe/Sofia',
    launchOptions: { executablePath: chromePath() },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `rm -rf .e2e-data && pnpm --filter @shmi/web build >/dev/null && DATA_DIR=$PWD/.e2e-data PORT=${PORT} MAIL_TRANSPORT=json node ./server.ts`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
