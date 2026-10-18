import { defineConfig } from 'vitest/config';

// Each test file runs in-memory PGlite companies (~150 MB each); cap parallel files to keep memory bounded.
export default defineConfig({ test: { maxWorkers: 2, testTimeout: 20_000, hookTimeout: 60_000 } });
