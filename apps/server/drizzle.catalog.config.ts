import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/catalog/schema.ts',
  out: './src/db/catalog/migrations',
});
