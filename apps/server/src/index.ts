import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import path from 'node:path';
import { PgliteDriver, createDriver } from './db/provider.ts';
import { configureAppLog, logApp } from './services/appLog.ts';
import { offsiteSettings, startOffsiteScheduler } from './services/offsite/offsite.ts';

const driver = createDriver();
const app = createApp(driver, { serveWeb: true });
if (driver instanceof PgliteDriver && driver.dataDir) configureAppLog(path.join(driver.dataDir, 'shmelta.log'));
else if (process.env.APP_LOG) configureAppLog(process.env.APP_LOG);
const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' }, (info) => {
  console.log(`Shmicroinvest Shmelta Pro API on http://localhost:${info.port} (${driver.kind})`);
  void logApp({ level: 'info', message: `Стартиране на сървъра (${driver.kind}), порт ${info.port}` });
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
