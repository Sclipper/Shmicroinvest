import { serve } from '@hono/node-server';
import path from 'node:path';
import { createApp } from './app.ts';
import { PgliteDriver, createDriver } from './db/provider.ts';
import * as cat from './db/catalog/schema.ts';
import { configureAppLog, logApp } from './services/appLog.ts';
import { offsiteSettings, startOffsiteScheduler } from './services/offsite/offsite.ts';
import { ensureSecretKey } from './services/email.ts';
import { setupToken } from './services/setup.ts';
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
  console.log(setupToken() ? 'Регистрация: новите фирми изискват ключа SHMI_SETUP_TOKEN.' : 'Регистрация: свободна, всеки може да създаде фирма (задайте SHMI_SETUP_TOKEN, за да я ограничите).');
  if (!any) console.log('Първо стартиране: още няма създадена фирма.');
} catch (e) {
  console.error(e);
  fail(`database not available: ${(e as Error).message}`);
}

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Shmicroinvest Shmelta Pro API on http://${hostname}:${info.port} (${driver.kind})`);
  void logApp({ level: 'info', message: `Стартиране на сървъра ${APP_VERSION} (${driver.kind}), порт ${info.port}` });
});

// Off-site backups (SHMI_BACKUP_S3_*): the daily run of every company. A wrong configuration is logged, not fatal.
let stopOffsite = () => {};
try {
  const offsite = offsiteSettings();
  if (offsite) {
    stopOffsite = startOffsiteScheduler(driver, offsite);
    console.log(`Off-site backups to ${offsite.s3.endpoint} bucket ${offsite.s3.bucket}/${offsite.prefix} (${offsite.schedule ? `daily ${offsite.schedule.times.join(', ')}` : 'on demand'}, keep ${offsite.keep})`);
  }
} catch (e) {
  console.error((e as Error).message);
  void logApp({ level: 'error', message: 'Облачното архивиране не е стартирано: грешни настройки.', details: (e as Error).message });
}

const shutdown = async () => {
  stopOffsite();
  server.close();
  await driver.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
