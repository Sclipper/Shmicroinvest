import { mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PGlite, types as pgliteTypes } from '@electric-sql/pglite';
import { drizzle as drizzlePglite, PgliteSession } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { is, type SQL } from 'drizzle-orm';
import pg from 'pg';
import * as companySchema from './company/schema/index.ts';
import * as catalogSchema from './catalog/schema.ts';
import { decodeLogicalDump, encodeLogicalDump, logicalDump, logicalRestore } from './logicalDump.ts';
import { PATHS } from '../runtime.ts';

export type CompanySchema = typeof companySchema;
export type CompanyDb = PgDatabase<PgQueryResultHKT, CompanySchema>;
export type CatalogDb = PgDatabase<PgQueryResultHKT, typeof catalogSchema>;
export type Tx = Parameters<Parameters<CompanyDb['transaction']>[0]>[0];
export type DbOrTx = CompanyDb | Tx;

const COMPANY_MIGRATIONS = PATHS.companyMigrations;
const CATALOG_MIGRATIONS = PATHS.catalogMigrations;

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

/**
 * Autovacuum stand-in. PGlite runs Postgres as a single-user backend, so the
 * autovacuum launcher never starts: without this the planner has no
 * statistics at all (every table "never analyzed", estimated at 1 row) and
 * picks nested loops and bitmap ANDs that are fine on a test company but take
 * seconds on a busy one. Like autovacuum's defaults, a table is analyzed when
 * more than 50 + 10 % of its rows changed since the last ANALYZE (or it was
 * never analyzed) and vacuumed when it has more than 50 + 20 % dead rows or
 * 1000 + 20 % rows inserted since the last VACUUM (keeps the visibility map
 * for index-only scans). The activity counters live in memory, so a database
 * that was never analyzed is analyzed when it is opened.
 */
export async function pgliteMaintenance(client: PGlite) {
  // Activity counters are flushed when the backend goes idle; force it before reading them.
  await client.query('SELECT pg_stat_force_next_flush()');
  const { rows } = await client.query<{ relname: string; analyze: boolean; vacuum: boolean }>(`
    SELECT c.relname,
      (c.reltuples < 0 OR coalesce(st.n_mod_since_analyze, 0) > 50 + 0.1 * greatest(c.reltuples, 0)) AS analyze,
      (coalesce(st.n_dead_tup, 0) > 50 + 0.2 * greatest(c.reltuples, 0) OR coalesce(st.n_ins_since_vacuum, 0) > 1000 + 0.2 * greatest(c.reltuples, 0)) AS vacuum
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid
    WHERE c.relkind = 'r' AND n.nspname = 'public'`);
  for (const r of rows) {
    const table = `"${r.relname.replace(/"/g, '""')}"`;
    if (r.vacuum) await client.exec(`VACUUM ANALYZE ${table}`);
    else if (r.analyze) await client.exec(`ANALYZE ${table}`);
  }
  return rows.filter((r) => r.vacuum || r.analyze).length;
}

/** How often an open on-disk company is checked by pgliteMaintenance. */
export const PGLITE_MAINTENANCE_MS = Number(process.env.PGLITE_MAINTENANCE_MS ?? 60_000);

export class PgliteDriver implements DbDriver {
  readonly kind = 'pglite' as const;
  private catalogDb?: Promise<CatalogDb>;
  private companies = new Map<string, Promise<{ client: PGlite; db: CompanyDb }>>();
  private maintenance = new Map<string, ReturnType<typeof setInterval>>();
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
        if (dir) this.startMaintenance(name, client);
        return { client, db: db as unknown as CompanyDb };
      })();
      entry.catch(() => this.companies.delete(name));
      this.companies.set(name, entry);
    }
    return entry;
  }

  /** On-disk companies: statistics on open, then pgliteMaintenance every PGLITE_MAINTENANCE_MS (in-memory test companies skip it). */
  private startMaintenance(name: string, client: PGlite) {
    let running = false;
    const run = async () => {
      if (running || client.closed) return;
      running = true;
      try {
        await pgliteMaintenance(client);
      } catch {
        // Closed meanwhile, or busy: the next round retries.
      } finally {
        running = false;
      }
    };
    void run();
    if (PGLITE_MAINTENANCE_MS > 0) {
      const timer = setInterval(run, PGLITE_MAINTENANCE_MS);
      timer.unref();
      this.maintenance.set(name, timer);
    }
  }

  private stopMaintenance(name: string) {
    clearInterval(this.maintenance.get(name));
    this.maintenance.delete(name);
  }

  /** Runs the statistics/vacuum check of an open company now (after bulk changes: imports, year conclusion). */
  async maintain(name: string) {
    const entry = this.companies.get(name);
    if (!entry) return 0;
    return pgliteMaintenance((await entry).client);
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
      this.stopMaintenance(name);
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
    for (const name of [...this.maintenance.keys()]) this.stopMaintenance(name);
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
    this.catalogPool = this.newPool(url, 'catalog', 5);
  }

  /**
   * A pool per database. Idle connections that the server closes (a restart,
   * a dropped database, a hosted Postgres that ends idle sessions) emit
   * 'error' on the pool; without a listener that would end the process.
   */
  private newPool(connectionString: string, label: string, max = Number(process.env.PG_POOL_MAX) || 5) {
    const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
    pool.on('error', (err) => {
      if ((err as { code?: string }).code === '57P01') return; // terminated by the server: the pool replaces the connection
      console.warn(`[postgres] idle connection to ${label}: ${err.message}`);
    });
    return pool;
  }

  /** The connection is password-protected (GDPR check, 06 9). */
  connectionHasPassword() {
    try {
      return !!new URL(this.url).password || !!process.env.PGPASSWORD;
    } catch {
      return !!process.env.PGPASSWORD;
    }
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
      const pool = this.newPool(this.urlFor(name), name);
      const db = (async () => {
        const d = drizzlePg(pool, { schema: companySchema });
        await migratePg(d, { migrationsFolder: COMPANY_MIGRATIONS });
        return d as unknown as CompanyDb;
      })();
      e = { pool, db };
      db.catch(() => {
        // A missing database: forget the pool so a later create can open it again.
        this.pools.delete(name);
        void pool.end().catch(() => undefined);
      });
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
  const root = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : PATHS.defaultDataDir;
  return new PgliteDriver(root);
}

/** Typed rows of a raw SQL query (pg and PGlite both return { rows }). */
export async function queryRows<T>(db: DbOrTx, query: SQL): Promise<T[]> {
  const res = (await db.execute(query)) as unknown as { rows: T[] };
  return res.rows;
}

type PgliteQuery = (query: string, params?: unknown[], options?: unknown) => Promise<{ rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number }[]; blob?: Blob }>;
// drizzle's PGlite session reads dates, timestamps and intervals as text; so does queryRowsBulk.
const asText = (v: string) => v;
const BULK_PARSERS = {
  [pgliteTypes.TIMESTAMP]: asText, [pgliteTypes.TIMESTAMPTZ]: asText, [pgliteTypes.INTERVAL]: asText, [pgliteTypes.DATE]: asText,
  1231: asText, 1115: asText, 1185: asText, 1187: asText, 1182: asText,
};
const COPY_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };
const unescapeCopy = (s: string) => s.replace(/\\(.)/g, (_, c: string) => COPY_ESCAPES[c] ?? c);

/** A bound value as a literal: quoted, so it stays of unknown type and is typed by its context like the parameter. */
function inlineParam(v: unknown): string | null {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'bigint' && typeof v !== 'boolean') return null;
  const s = String(v);
  return s.includes('\0') ? null : `'${s.replace(/'/g, "''")}'`;
}

/**
 * queryRows for big result sets (registers, open items of a whole year). PGlite
 * hands every row over as a protocol message, which costs about 2 µs a cell;
 * COPY (query) TO '/dev/blob' returns the rows as one text blob, about twice as
 * fast. COPY takes no parameters, so they are inlined as quoted literals. The
 * rows are the same as queryRows' (same names and value parsers); with Postgres
 * or a value that cannot be inlined it is queryRows.
 */
export async function queryRowsBulk<T>(db: DbOrTx, query: SQL): Promise<T[]> {
  const inner = db as unknown as { session?: { client?: { query?: PgliteQuery } }; dialect?: { sqlToQuery(q: SQL): { sql: string; params: unknown[] } } };
  if (!is(inner.session, PgliteSession) || !inner.dialect) return queryRows<T>(db, query);
  const client = (inner.session as unknown as { client: { query: PgliteQuery } }).client;
  const { sql: text, params } = inner.dialect.sqlToQuery(query);
  const literals = params.map(inlineParam);
  if (literals.some((l) => l === null)) return queryRows<T>(db, query);
  const inlined = text.replace(/\$(\d+)/g, (m, n: string) => literals[Number(n) - 1] ?? m);
  const run = client.query.bind(client);
  const { fields } = await run(`SELECT * FROM (${inlined}) _q LIMIT 0`);
  const res = await run(`COPY (${inlined}) TO '/dev/blob'`);
  const body = res.blob ? await res.blob.text() : '';
  const names = fields.map((f) => f.name), oids = fields.map((f) => f.dataTypeID);
  const out: Record<string, unknown>[] = [];
  for (let pos = 0; pos < body.length;) {
    let end = body.indexOf('\n', pos);
    if (end < 0) end = body.length;
    const cells = body.slice(pos, end).split('\t');
    pos = end + 1;
    const row: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i++) {
      const c = cells[i]!;
      row[names[i]!] = c === '\\N' ? null : pgliteTypes.parseType(c.includes('\\') ? unescapeCopy(c) : c, oids[i]!, BULK_PARSERS);
    }
    out.push(row);
  }
  return out as T[];
}

export async function exec(db: DbOrTx, query: SQL): Promise<{ rows: unknown[] }> {
  return (await db.execute(query)) as unknown as { rows: unknown[] };
}
