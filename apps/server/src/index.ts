import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { createDriver } from './db/provider.ts';

const driver = createDriver();
const app = createApp(driver, { serveWeb: true });
const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' }, (info) => {
  console.log(`Shmicroinvest API on http://localhost:${info.port} (${driver.kind})`);
});

const shutdown = async () => {
  server.close();
  await driver.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
