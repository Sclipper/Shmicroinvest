import { mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import pg from 'pg';
import * as companySchema from './company/schema/index.ts';
import * as catalogSchema from './catalog/schema.ts';
import { decodeLogicalDump, encodeLogicalDump, logicalDump, logicalRestore } from './logicalDump.ts';

export type CompanySchema = typeof companySchema;
export type CompanyDb = PgDatabase<PgQueryResultHKT, CompanySchema>;
export type CatalogDb = PgDatabase<PgQueryResultHKT, typeof catalogSchema>;
export type Tx = Parameters<Parameters<CompanyDb['transaction']>[0]>[0];
export type DbOrTx = CompanyDb | Tx;

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPANY_MIGRATIONS = path.join(here, 'company/migrations');
const CATALOG_MIGRATIONS = path.join(here, 'catalog/migrations');

/**
 * Storage driver. Mirrors Delta's "company = database" model: a catalog
 * database plus one database per company.
 *  - pglite: embedded Postgres, one data directory per database (or in memory for tests)
 *  - postgres: a real server; DATABASE_URL points at the catalog database and
 *    company databases are created next to it with CREATE DATABASE.
 */
export interface DbDriver {
  readonly kind: 'pglite' | 'postgres';
  catalog(): Promise<CatalogDb>;
  company(name: string): Promise<CompanyDb>;
  createCompanyDatabase(name: string): Promise<CompanyDb>;
  dropCompanyDatabase(name: string): Promise<void>;
  /** Raw dump of a company database (backup). */
  dump(name: string): Promise<Uint8Array>;
  /** Replace / create a company database from a dump. */
  restore(name: string, data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * Postgres settings for the embedded engine. Its defaults are sized for a
 * server (128 MB shared buffers, 80 MB of retained WAL), and every company is
 * its own instance, so a process with a few open companies used gigabytes.
 * A single-user database needs far less: about 90 MB per instance with these.
 */
const PGLITE_CONF = [
  'shared_buffers=16MB', 'max_connections=5', 'wal_buffers=1MB', 'min_wal_size=32MB', 'max_wal_size=64MB',
  'effective_cache_size=64MB', 'maintenance_work_mem=16MB',
];

/** A PGlite instance with the settings above; dir undefined = in memory. */
export function newPglite(dir?: string, opts: { loadDataDir?: Blob } = {}) {
  return new PGlite({ ...(dir ? { dataDir: dir } : {}), postgresqlconf: PGLITE_CONF, ...opts });
}

export const DB_NAME_RE = /^[a-z][a-z0-9_]{2,62}$/;

export class PgliteDriver implements DbDriver {
  readonly kind = 'pglite' as const;
  private catalogDb?: Promise<CatalogDb>;
  private companies = new Map<string, Promise<{ client: PGlite; db: CompanyDb }>>();
  private catalogClient?: PGlite;

  /** dataRoot = undefined -> everything in memory (tests). */
  private dataRoot?: string;
  constructor(dataRoot?: string) {
    this.dataRoot = dataRoot;
  }

  get dataDir() {
    return this.dataRoot;
  }

  private dir(name: string) {
    return this.dataRoot ? path.join(this.dataRoot, 'companies', name) : undefined;
  }

  catalog(): Promise<CatalogDb> {
    this.catalogDb ??= (async () => {
      if (this.dataRoot) await mkdir(this.dataRoot, { recursive: true });
      const client = newPglite(this.dataRoot ? path.join(this.dataRoot, 'catalog') : undefined);
      this.catalogClient = client;
      const db = drizzlePglite(client, { schema: catalogSchema });
      await migratePglite(db, { migrationsFolder: CATALOG_MIGRATIONS });
      return db as unknown as CatalogDb;
    })();
    return this.catalogDb;
  }

  private open(name: string, create: boolean) {
    let entry = this.companies.get(name);
    if (!entry) {
      entry = (async () => {
        const dir = this.dir(name);
        if (dir && !create && !existsSync(dir)) throw new Error(`Company database ${name} does not exist`);
        if (dir) await mkdir(path.dirname(dir), { recursive: true });
        const client = newPglite(dir);
        const db = drizzlePglite(client, { schema: companySchema });
        // Schema upgrade on open, like Delta's ValidateDatabase.
        await migratePglite(db, { migrationsFolder: COMPANY_MIGRATIONS });
        return { client, db: db as unknown as CompanyDb };
      })();
      entry.catch(() => this.companies.delete(name));
      this.companies.set(name, entry);
    }
    return entry;
  }

  async company(name: string) {
    if (!this.dataRoot && !this.companies.has(name)) throw new Error(`Company database ${name} does not exist`);
    return (await this.open(name, false)).db;
  }

  async createCompanyDatabase(name: string) {
    const dir = this.dir(name);
    if (dir && existsSync(dir)) throw new Error('Database already exists!');
    if (!dir && this.companies.has(name)) throw new Error('Database already exists!');
    return (await this.open(name, true)).db;
  }

  async dropCompanyDatabase(name: string) {
    const entry = this.companies.get(name);
    if (entry) {
      const { client } = await entry;
      await client.close();
      this.companies.delete(name);
    }
    const dir = this.dir(name);
    if (dir) await rm(dir, { recursive: true, force: true });
  }

  async dump(name: string) {
    const { client } = await this.open(name, false);
    const blob = await client.dumpDataDir('gzip');
    return new Uint8Array(await blob.arrayBuffer());
  }

  async restore(name: string, data: Uint8Array) {
    await this.dropCompanyDatabase(name);
    const dir = this.dir(name);
    if (dir) await mkdir(path.dirname(dir), { recursive: true });
    if (dir) {
      const client = newPglite(dir, { loadDataDir: new Blob([data as Uint8Array<ArrayBuffer>]) });
      await client.waitReady;
      await client.close();
    } else {
      // In-memory: keep the loaded instance.
      const c2 = newPglite(undefined, { loadDataDir: new Blob([data as Uint8Array<ArrayBuffer>]) });
      const db = drizzlePglite(c2, { schema: companySchema });
      await migratePglite(db, { migrationsFolder: COMPANY_MIGRATIONS });
      this.companies.set(name, Promise.resolve({ client: c2, db: db as unknown as CompanyDb }));
    }
  }

  async listDataDirs(): Promise<string[]> {
    if (!this.dataRoot) return [...this.companies.keys()];
    const dir = path.join(this.dataRoot, 'companies');
    if (!existsSync(dir)) return [];
    return readdir(dir);
  }

  async close() {
    for (const e of this.companies.values()) {
      try { (await e).client.close(); } catch { /* ignore */ }
    }
    this.companies.clear();
    await this.catalogClient?.close();
  }
}

export class PostgresDriver implements DbDriver {
  readonly kind = 'postgres' as const;
  private catalogPool: pg.Pool;
  private catalogDb?: Promise<CatalogDb>;
  private pools = new Map<string, { pool: pg.Pool; db: Promise<CompanyDb> }>();

  private url: string;
  constructor(url: string) {
    this.url = url;
    this.catalogPool = new pg.Pool({ connectionString: url, max: 5 });
  }

  private urlFor(name: string) {
    const u = new URL(this.url);
    u.pathname = '/' + name;
    return u.toString();
  }

  catalog() {
    this.catalogDb ??= (async () => {
      const db = drizzlePg(this.catalogPool, { schema: catalogSchema });
      await migratePg(db, { migrationsFolder: CATALOG_MIGRATIONS });
      return db as unknown as CatalogDb;
    })();
    return this.catalogDb;
  }

  async company(name: string) {
    let e = this.pools.get(name);
    if (!e) {
      const pool = new pg.Pool({ connectionString: this.urlFor(name), max: 10 });
      const db = (async () => {
        const d = drizzlePg(pool, { schema: companySchema });
        await migratePg(d, { migrationsFolder: COMPANY_MIGRATIONS });
        return d as unknown as CompanyDb;
      })();
      e = { pool, db };
      db.catch(() => this.pools.delete(name));
      this.pools.set(name, e);
    }
    return e.db;
  }

  async createCompanyDatabase(name: string) {
    if (!DB_NAME_RE.test(name)) throw new Error('Invalid database name');
    await this.catalogPool.query(`CREATE DATABASE "${name}" ENCODING 'UTF8'`);
    return this.company(name);
  }

  async dropCompanyDatabase(name: string) {
    if (!DB_NAME_RE.test(name)) throw new Error('Invalid database name');
    const e = this.pools.get(name);
    if (e) {
      await e.pool.end();
      this.pools.delete(name);
    }
    await this.catalogPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }

  /** Logical JSON dump (gzip), see logicalDump.ts. */
  async dump(name: string): Promise<Uint8Array> {
    return encodeLogicalDump(await logicalDump(await this.company(name)));
  }

  /** Re-creates the database and loads a logical dump into it. */
  async restore(name: string, data: Uint8Array): Promise<void> {
    const dump = decodeLogicalDump(data);
    await this.dropCompanyDatabase(name);
    const db = await this.createCompanyDatabase(name);
    await db.transaction((tx) => logicalRestore(tx, dump));
  }

  async close() {
    for (const e of this.pools.values()) await e.pool.end();
    await this.catalogPool.end();
  }
}

export function createDriver(): DbDriver {
  const url = process.env.DATABASE_URL;
  if (url) return new PostgresDriver(url);
  const root = process.env.DATA_DIR ?? path.resolve(here, '../../.data');
  return new PgliteDriver(root);
}

/** Typed rows of a raw SQL query (pg and PGlite both return { rows }). */
export async function queryRows<T>(db: DbOrTx, query: SQL): Promise<T[]> {
  const res = (await db.execute(query)) as unknown as { rows: T[] };
  return res.rows;
}

export async function exec(db: DbOrTx, query: SQL): Promise<{ rows: unknown[] }> {
  return (await db.execute(query)) as unknown as { rows: unknown[] };
}
