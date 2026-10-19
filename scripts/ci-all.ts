/**
 * `pnpm ci:all`: the CI pipeline (.github/workflows/ci.yml) run locally, step by step,
 * stopping at the first failure.
 *
 *   typecheck → core tests → migration lock → server tests (PGlite) → web build
 *   → server tests on Postgres (when TEST_DATABASE_URL is set) → e2e → release bundle + smoke
 *
 * Flags: --skip-e2e, --skip-bundle. Postgres: TEST_DATABASE_URL=postgres://user:pw@host:5432/postgres.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const results: [string, string][] = [];

function run(name: string, cmd: string, cmdArgs: string[], env: Record<string, string> = {}, cwd = root) {
  console.log(`\n=== ${name}: ${cmd} ${cmdArgs.join(' ')}`);
  const started = Date.now();
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  if (r.status !== 0) {
    results.push([name, `FAILED (${secs}s)`]);
    summary();
    process.exit(r.status ?? 1);
  }
  results.push([name, `ok (${secs}s)`]);
}

function summary() {
  console.log('\n=== ci:all summary');
  for (const [n, s] of results) console.log(`${n.padEnd(34)} ${s}`);
}

run('typecheck', 'pnpm', ['typecheck']);
run('core unit tests', 'pnpm', ['--filter', '@shmi/core', 'test']);
run('migration lock', 'pnpm', ['--filter', '@shmi/server', 'db:check']);
run('server API tests (PGlite)', 'pnpm', ['--filter', '@shmi/server', 'test']);
run('web build', 'pnpm', ['--filter', '@shmi/web', 'build']);
if (process.env.TEST_DATABASE_URL) run('server API tests (PostgreSQL)', 'pnpm', ['--filter', '@shmi/server', 'test:pg']);
else results.push(['server API tests (PostgreSQL)', 'skipped (set TEST_DATABASE_URL)']);
if (!args.has('--skip-e2e')) run('e2e (Playwright)', 'pnpm', ['test:e2e']);
else results.push(['e2e (Playwright)', 'skipped']);

if (!args.has('--skip-bundle')) {
  run('release bundle', 'pnpm', ['release:bundle', '--', '--skip-web']);
  // The bundle runs from a directory outside the repository, as on a host.
  const dir = mkdtempSync(path.join(tmpdir(), 'shmelta-ci-'));
  cpSync(path.join(root, 'release'), path.join(dir, 'app'), { recursive: true });
  const port = String(4400 + Math.floor(Math.random() * 80));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(dir, 'app'),
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production', DATA_DIR: path.join(dir, 'data'), SHMI_SETUP_TOKEN: 'ci-token', PORT: port, DATABASE_URL: '' },
  });
  process.on('exit', () => server.kill('SIGTERM'));
  try {
    for (let i = 0; i < 60; i++) {
      if (await fetch(`http://localhost:${port}/api/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    run('release smoke test (PGlite)', process.execPath, [path.join(root, 'scripts/release-smoke.ts'), `http://localhost:${port}`, 'ci-token']);
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
    rmSync(dir, { recursive: true, force: true });
  }
}
summary();
