import { defineConfig } from 'vitest/config';

// Each test file runs in-memory PGlite companies (~100-250 MB each, ~1.5-2 GB per file at peak).
// Parallel files are capped here and, across every checkout on the machine, by the
// test slots of scripts/test-slots.ts (SHMI_TEST_SLOTS, default 2).
export default defineConfig({ test: { maxWorkers: 2, testTimeout: 20_000, hookTimeout: 60_000, setupFiles: ['./test/slot-setup.ts'] } });
