/**
 * Production bundle: `pnpm release:bundle` writes release/ with
 *
 *   server.js            the API server and every JS dependency, bundled by esbuild for Node 22+
 *   server.js.map        source map (node --enable-source-maps server.js gives TS stack traces)
 *   server.js.LEGAL.txt  licence comments of the bundled packages
 *   web/                 the built UI (apps/web/dist, fonts included)
 *   migrations/          company and catalog migrations (run on start)
 *   node_modules/@electric-sql/pglite   the embedded database (wasm + data files)
 *   package.json         { "start": "node server.js" }, the one runtime dependency
 *   .env.example         every setting the server reads
 *
 * Why a bundle rather than shipping the sources with a pinned Node: the
 * sources are TypeScript run by Node 26's type stripping, which hosting
 * platforms (and Docker base images) do not all offer yet. esbuild turns them
 * into plain ES2023 JavaScript for Node 22+, inlines the dependencies (no
 * node_modules tree of a few hundred packages, no symlinks for upload-based
 * hosts) and keeps the release small. PGlite stays a package because it loads
 * its wasm and data files relative to its own module.
 *
 * Run with --skip-web to reuse an existing apps/web/dist.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'release');
const server = path.join(root, 'apps/server');
const MAX_BYTES = 250 * 1024 * 1024;

const serverPkg = JSON.parse(readFileSync(path.join(server, 'package.json'), 'utf8')) as { version: string };
const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };

const step = (s: string) => console.log(`[release] ${s}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. UI
if (!process.argv.includes('--skip-web')) {
  step('building the web app');
  execFileSync('pnpm', ['--filter', '@shmi/web', 'build'], { cwd: root, stdio: 'inherit' });
}
const webDist = path.join(root, 'apps/web/dist');
if (!existsSync(path.join(webDist, 'index.html'))) throw new Error('apps/web/dist is missing: build the web app first');
cpSync(webDist, path.join(out, 'web'), { recursive: true });

// 2. Server
step('bundling the server (esbuild, node22)');
await build({
  entryPoints: [path.join(server, 'src/index.ts')],
  outfile: path.join(out, 'server.js'),
  absWorkingDir: server,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  legalComments: 'linked',
  // Loads pglite.wasm / pglite.data next to its own module; pg-native is an optional addon of pg.
  external: ['@electric-sql/pglite', '@electric-sql/pglite/*', 'pg-native'],
  define: { 'process.env.SHMI_BUNDLED': '"1"' },
  // CommonJS dependencies (exceljs, nodemailer, pg) call require() and use __dirname.
  banner: {
    js: [
      "import { createRequire as __shmiCreateRequire } from 'node:module';",
      "import { fileURLToPath as __shmiFileURLToPath } from 'node:url';",
      "import { dirname as __shmiDirname } from 'node:path';",
      'const require = __shmiCreateRequire(import.meta.url);',
      'const __filename = __shmiFileURLToPath(import.meta.url);',
      'const __dirname = __shmiDirname(__filename);',
    ].join(' '),
  },
  logLevel: 'warning',
});

// 3. Migrations (applied on start; never edited once released, see AGENTS.md)
for (const kind of ['company', 'catalog'] as const) {
  cpSync(path.join(server, `src/db/${kind}/migrations`), path.join(out, 'migrations', kind), { recursive: true });
}

// 4. The embedded database package, as real files (no pnpm symlinks)
const pgliteDir = realpathSync(path.join(server, 'node_modules/@electric-sql/pglite'));
const pglitePkg = JSON.parse(readFileSync(path.join(pgliteDir, 'package.json'), 'utf8')) as { version: string; dependencies?: Record<string, string> };
if (Object.keys(pglitePkg.dependencies ?? {}).length) throw new Error('@electric-sql/pglite now has dependencies: copy them into the release too');
cpSync(pgliteDir, path.join(out, 'node_modules/@electric-sql/pglite'), {
  recursive: true,
  dereference: true,
  // Source maps and type declarations are not needed at run time.
  filter: (src) => !src.endsWith('.map') && !/\.d\.c?ts$/.test(src),
});

// 5. package.json and the settings reference
writeFileSync(path.join(out, 'package.json'), JSON.stringify({
  name: 'shmicroinvest-shmelta-pro',
  version: rootPkg.version,
  private: true,
  type: 'module',
  description: 'Shmicroinvest Shmelta Pro – production bundle',
  engines: { node: '>=22' },
  scripts: { start: 'node --enable-source-maps server.js' },
  dependencies: { '@electric-sql/pglite': pglitePkg.version },
}, null, 2) + '\n');
cpSync(path.join(root, '.env.example'), path.join(out, '.env.example'));
writeFileSync(path.join(out, 'VERSION'), serverPkg.version + '\n');

// 6. Size check
const size = (p: string): number => {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0);
};
const total = size(out);
const mib = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
for (const f of ['server.js', 'server.js.map', 'web', 'migrations', 'node_modules']) step(`  ${f.padEnd(14)} ${mib(size(path.join(out, f)))}`);
step(`release/ ${mib(total)} (limit ${mib(MAX_BYTES)})`);
if (total > MAX_BYTES) {
  console.error('[release] the bundle is larger than 250 MiB');
  process.exit(1);
}
step('start with: cd release && PORT=3000 DATA_DIR=/var/lib/shmelta node server.js');
