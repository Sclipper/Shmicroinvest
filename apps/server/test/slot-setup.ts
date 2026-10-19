import { afterAll } from 'vitest';
import { acquireTestSlot } from '../../../scripts/test-slots.ts';
import { openTestDrivers } from './helpers.ts';

// Each test file holds a machine-wide test slot while it runs (scripts/test-slots.ts).
const release = await acquireTestSlot(`server tests (pid ${process.pid})`);
afterAll(async () => {
  // Postgres test mode: drop the databases of test servers the file did not close.
  for (const d of [...openTestDrivers]) await d.close().catch(() => undefined);
  release();
});
