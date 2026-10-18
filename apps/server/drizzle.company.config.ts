import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/company/schema/index.ts',
  out: './src/db/company/migrations',
});
