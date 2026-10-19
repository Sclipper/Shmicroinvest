import { afterAll } from 'vitest';
import { acquireTestSlot } from '../../../scripts/test-slots.ts';

// Each test file holds a machine-wide test slot while it runs (scripts/test-slots.ts).
const release = await acquireTestSlot(`server tests (pid ${process.pid})`);
afterAll(release);
