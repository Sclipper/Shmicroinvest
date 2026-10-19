import { serve } from '@hono/node-server';
import path from 'node:path';
import { createApp } from './app.ts';
import { PgliteDriver, createDriver } from './db/provider.ts';
import * as cat from './db/catalog/schema.ts';
import { configureAppLog, logApp } from './services/appLog.ts';
import { ensureSecretKey } from './services/email.ts';
import { setupToken, setupTokenGenerated } from './services/setup.ts';
import { APP_VERSION, PATHS, isProduction, trustProxy } from './runtime.ts';

/** Where the data lives, for the start-up log (the database password is never printed). */
function describeStorage(driver: ReturnType<typeof createDriver>) {
  if (driver instanceof PgliteDriver) return `PGlite (вградена база данни) в ${driver.dataDir}`;
  try {
    const u = new URL(process.env.DATABASE_URL!);
    return `PostgreSQL ${u.hostname}:${u.port || 5432}, каталог ${u.pathname.slice(1) || '(по подразбиране)'}, потребител ${decodeURIComponent(u.username) || '(по подразбиране)'}`;
  } catch {
    return 'PostgreSQL (DATABASE_URL)';
  }
}

function fail(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

const production = isProduction();

// A persistent secret keeps the stored SMTP passwords readable after a restart or a redeploy.
if (production && !process.env.SHMI_SECRET && !process.env.SHMI_SECRET_FILE && !process.env.DATA_DIR) {
  fail('NODE_ENV=production requires a persistent secret: set SHMI_SECRET, or SHMI_SECRET_FILE / DATA_DIR pointing to persistent storage.');
}
let secretInfo: ReturnType<typeof ensureSecretKey>;
try {
  secretInfo = ensureSecretKey();
} catch (e) {
  fail(`cannot read or create the secret key file (${(e as Error).message}). Set SHMI_SECRET or a writable SHMI_SECRET_FILE.`);
}

const driver = createDriver();
const app = createApp(driver, { serveWeb: true });
if (driver instanceof PgliteDriver && driver.dataDir) configureAppLog(process.env.APP_LOG ?? path.join(driver.dataDir, 'shmelta.log'));
else if (process.env.APP_LOG) configureAppLog(process.env.APP_LOG);
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '0.0.0.0';

// Migrations run here, before the port opens: a failing database stops the start instead of serving errors.
try {
  const catalog = await driver.catalog();
  const [any] = await catalog.select({ name: cat.companiesCatalog.name }).from(cat.companiesCatalog).limit(1);
  console.log(`Shmicroinvest Shmelta Pro ${APP_VERSION} (${production ? 'production' : process.env.NODE_ENV ?? 'development'})`);
  console.log(`Данни: ${describeStorage(driver)}`);
  console.log(`Ключ за паролите: ${secretInfo.source === 'env' ? 'SHMI_SECRET' : secretInfo.file}`);
  console.log(`Уеб интерфейс: ${PATHS.webDist}${trustProxy() ? '; зад обратен прокси (TRUST_PROXY=1)' : ''}`);
  if (!any) {
    const token = setupToken();
    if (token && setupTokenGenerated()) {
      console.log(`Първо стартиране: ключ за инсталация (SHMI_SETUP_TOKEN) ${token}`);
      console.log('Въведете го при създаването на първата фирма, или задайте SHMI_SETUP_TOKEN предварително.');
    } else if (token) console.log('Първо стартиране: създаването на първата фирма изисква SHMI_SETUP_TOKEN.');
    else console.log('Първо стартиране: първата фирма може да се създаде без ключ (задайте SHMI_SETUP_TOKEN за публичен адрес).');
  }
} catch (e) {
  console.error(e);
  fail(`database not available: ${(e as Error).message}`);
}

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Shmicroinvest Shmelta Pro API on http://${hostname}:${info.port} (${driver.kind})`);
  void logApp({ level: 'info', message: `Стартиране на сървъра ${APP_VERSION} (${driver.kind}), порт ${info.port}` });
});

const shutdown = async () => {
  server.close();
  await driver.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
