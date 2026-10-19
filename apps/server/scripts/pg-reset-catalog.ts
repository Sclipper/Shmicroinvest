/**
 * Fresh Postgres catalog for a test server (the e2e suite in Postgres mode):
 *
 *   node scripts/pg-reset-catalog.ts <admin-url> <catalog-name>
 *
 * Drops the company databases listed in the old catalog, then the catalog
 * itself, and creates it again. Prints the catalog's DATABASE_URL.
 */
import pg from 'pg';

const [adminUrl, catalog] = process.argv.slice(2);
if (!adminUrl || !catalog || !/^[a-z][a-z0-9_]{2,62}$/.test(catalog)) {
  console.error('usage: pg-reset-catalog.ts <admin-url> <catalog-name>');
  process.exit(2);
}

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
try {
  const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [catalog])).rowCount;
  if (exists) {
    const u = new URL(adminUrl);
    u.pathname = '/' + catalog;
    const old = new pg.Client({ connectionString: u.toString() });
    await old.connect();
    let names: string[] = [];
    try {
      names = (await old.query<{ name: string }>('SELECT name FROM companies_catalog')).rows.map((r) => r.name);
    } catch {
      // No catalog table yet.
    } finally {
      await old.end();
    }
    for (const n of names) if (/^[a-z][a-z0-9_]{2,62}$/.test(n)) await admin.query(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);
    await admin.query(`DROP DATABASE "${catalog}" WITH (FORCE)`);
  }
  await admin.query(`CREATE DATABASE "${catalog}" ENCODING 'UTF8'`);
} finally {
  await admin.end();
}
const u = new URL(adminUrl);
u.pathname = '/' + catalog;
console.log(u.toString());
