import { sql } from 'drizzle-orm';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DbOrTx } from './provider.ts';

/**
 * Driver-independent logical dump of a company database: every table of the
 * public schema as JSON rows. Works the same on PGlite and on a Postgres
 * server (used for Postgres backups and for cross-driver restores).
 */
export interface LogicalDump {
  format: 'shmi-logical-1';
  tables: { name: string; rows: Record<string, unknown>[] }[];
}

const rowsOf = async <T>(db: DbOrTx, q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: T[] }).rows;
const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid table name ${name}`);
  return `"${name}"`;
};

async function tableNames(db: DbOrTx): Promise<string[]> {
  const rows = await rowsOf<{ table_name: string }>(db, sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  return rows.map((r) => r.table_name);
}

/** Tables ordered so that referenced tables come first (self references ignored). */
async function dependencyOrder(db: DbOrTx, names: string[]): Promise<string[]> {
  const fks = await rowsOf<{ child: string; parent: string }>(db, sql`
    SELECT c.relname AS child, p.relname AS parent
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_class p ON p.oid = k.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE k.contype = 'f' AND n.nspname = 'public'`);
  const deps = new Map(names.map((n) => [n, new Set<string>()]));
  for (const f of fks) if (f.child !== f.parent) deps.get(f.child)?.add(f.parent);
  const out: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (n: string) => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) return; // cycle: keep the current order
    state.set(n, 1);
    for (const d of deps.get(n) ?? []) visit(d);
    state.set(n, 2);
    out.push(n);
  };
  for (const n of names) visit(n);
  return out;
}

export async function logicalDump(db: DbOrTx): Promise<LogicalDump> {
  const names = await tableNames(db);
  const tables: LogicalDump['tables'] = [];
  for (const name of names) {
    const [r] = await rowsOf<{ rows: Record<string, unknown>[] | string }>(db, sql.raw(`SELECT coalesce(json_agg(t), '[]'::json) AS rows FROM ${ident(name)} t`));
    const rows = typeof r!.rows === 'string' ? JSON.parse(r!.rows) : r!.rows;
    tables.push({ name, rows });
  }
  return { format: 'shmi-logical-1', tables };
}

/**
 * Loads a logical dump into an (already migrated) database: all tables are
 * emptied, rows inserted in dependency order, identity counters reset.
 * Tables missing in the dump are left empty; tables unknown to the database
 * are ignored (the dump comes from another version).
 */
export async function logicalRestore(db: DbOrTx, dump: LogicalDump) {
  if (dump.format !== 'shmi-logical-1') throw new Error('Unknown dump format');
  const names = await tableNames(db);
  const known = new Set(names);
  const order = await dependencyOrder(db, names);
  await db.execute(sql.raw(`TRUNCATE ${names.map(ident).join(', ')} RESTART IDENTITY CASCADE`));
  const byName = new Map(dump.tables.map((t) => [t.name, t.rows]));
  for (const name of order) {
    const rows = byName.get(name);
    if (!known.has(name) || !rows?.length) continue;
    for (let i = 0; i < rows.length; i += 2000) {
      const chunk = JSON.stringify(rows.slice(i, i + 2000));
      await db.execute(sql`INSERT INTO ${sql.raw(ident(name))} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(NULL::${sql.raw(ident(name))}, ${chunk}::json)`);
    }
  }
  // Identity / serial counters.
  const seqs = await rowsOf<{ table_name: string; column_name: string }>(db, sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND (is_identity = 'YES' OR column_default LIKE 'nextval%')`);
  for (const sq of seqs) {
    const t = ident(sq.table_name);
    const c = ident(sq.column_name);
    await db.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${t}', '${sq.column_name}'), GREATEST((SELECT coalesce(max(${c}), 0) FROM ${t}), 1), (SELECT count(*) > 0 FROM ${t}))`));
  }
}

export const encodeLogicalDump = (d: LogicalDump) => new Uint8Array(gzipSync(Buffer.from(JSON.stringify(d), 'utf8')));
export const decodeLogicalDump = (bytes: Uint8Array): LogicalDump => JSON.parse(gunzipSync(bytes).toString('utf8')) as LogicalDump;
