import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import path from 'node:path';
import { PgliteDriver, createDriver } from './db/provider.ts';
import { configureAppLog, logApp } from './services/appLog.ts';

const driver = createDriver();
const app = createApp(driver, { serveWeb: true });
if (driver instanceof PgliteDriver && driver.dataDir) configureAppLog(path.join(driver.dataDir, 'shmelta.log'));
else if (process.env.APP_LOG) configureAppLog(process.env.APP_LOG);
const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' }, (info) => {
  console.log(`Shmicroinvest Shmelta Pro API on http://localhost:${info.port} (${driver.kind})`);
  void logApp({ level: 'info', message: `Стартиране на сървъра (${driver.kind}), порт ${info.port}` });
});

const shutdown = async () => {
  server.close();
  await driver.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
