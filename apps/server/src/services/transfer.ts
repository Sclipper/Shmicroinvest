import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/provider.ts';
import { queryRows } from '../db/provider.ts';
import { fixIdentity } from './companySetup.ts';

/**
 * Data carried over into a new company (TransferEntitiesViewModel /
 * DatabaseTransferService, 01b 1.2). Rows keep their ids so references stay
 * valid; financial years and sequences are matched by year and channel.
 */
export interface TransferOptions {
  chartOfAccounts?: boolean;
  users?: boolean;
  partners?: boolean;
  accountings?: boolean;
  /** Шаблони на контировки, with their schedules (01b 1.2 AccountingTemplates). */
  accountingTemplates?: boolean;
  /** Шаблони за банков импорт, with their condition formulas (01b 1.2 BankTemplates). */
  bankTemplates?: boolean;
}

type Row = Record<string, unknown>;

const columnsCache = new WeakMap<object, Map<string, string[]>>();
async function columns(db: DbOrTx, table: string) {
  let m = columnsCache.get(db);
  if (!m) columnsCache.set(db, (m = new Map()));
  if (!m.has(table)) {
    const rows = await queryRows<{ column_name: string }>(db, sql`SELECT column_name FROM information_schema.columns WHERE table_name = ${table} AND table_schema = current_schema() ORDER BY ordinal_position`);
    m.set(table, rows.map((r) => r.column_name));
  }
  return m.get(table)!;
}

async function tableExists(db: DbOrTx, table: string) {
  return (await columns(db, table)).length > 0;
}

const read = (db: DbOrTx, table: string, where = '') => queryRows<Row>(db, sql.raw(`SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''} ORDER BY 1`));

/** jsonb values (e.g. bank-template formulas) travel as JSON text; drizzle would expand an array into a record. */
const param = (v: unknown) => (v != null && typeof v === 'object' && !(v instanceof Date) && !(v instanceof Uint8Array) ? JSON.stringify(v) : v ?? null);

/** Inserts rows (columns common to both schemas); upsert replaces rows with the same id. */
async function write(db: DbOrTx, table: string, rows: Row[], mode: 'insert' | 'upsert' = 'insert') {
  if (!rows.length) return;
  const cols = (await columns(db, table)).filter((c) => c in rows[0]!);
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const values = sql.join(chunk.map((r) => sql`(${sql.join(cols.map((c) => sql`${param(r[c])}`), sql`, `)})`), sql`, `);
    const conflict: SQL = mode === 'upsert'
      ? sql.raw(` ON CONFLICT (id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`)
      : sql``;
    await db.execute(sql`INSERT INTO ${sql.identifier(table)} (${sql.join(cols.map((c) => sql.identifier(c)), sql`, `)}) VALUES ${values}${conflict}`);
  }
  if (cols.includes('id')) await fixIdentity(db, table);
}

async function copy(src: DbOrTx, dst: DbOrTx, table: string, o: { where?: string; mode?: 'insert' | 'upsert'; map?: (r: Row) => Row; replace?: boolean } = {}) {
  if (!(await tableExists(src, table)) || !(await tableExists(dst, table))) return 0;
  if (o.replace) await dst.execute(sql.raw(`DELETE FROM ${table}${o.where ? ` WHERE ${o.where}` : ''}`));
  const rows = (await read(src, table, o.where)).map(o.map ?? ((r) => r));
  await write(dst, table, rows, o.mode);
  return rows.length;
}

export async function transferEntities(src: DbOrTx, dst: DbOrTx, opts: TransferOptions) {
  const counts: Record<string, number> = {};
  // Entries need the accounts and partners they post to.
  // Templates post to accounts: like entries they bring the chart along (01b 1.2 "chart of accounts (with ... templates)").
  const chart = !!(opts.chartOfAccounts || opts.accountings || opts.accountingTemplates || opts.bankTemplates);
  const partners = !!(opts.partners || opts.accountings);

  if (chart) {
    for (const t of ['account_categories', 'currencies']) await copy(src, dst, t, { mode: 'upsert' });
    await dst.execute(sql`DELETE FROM product_accounts`);
    await dst.execute(sql`DELETE FROM products`);
    await copy(src, dst, 'product_groups', { replace: true });
    counts.products = await copy(src, dst, 'products');
    await dst.execute(sql`DELETE FROM accounts`);
    counts.accounts = await copy(src, dst, 'accounts');
    await copy(src, dst, 'product_accounts');
    // The chart type goes with the chart (03a 1.1: an empty type asks for the selection again).
    const [type] = await queryRows<{ value: string }>(src, sql`SELECT value FROM configuration WHERE key = 'ChartOfAccountsType' AND user_id IS NULL`);
    if (type?.value) {
      await dst.execute(sql`DELETE FROM configuration WHERE key = 'ChartOfAccountsType' AND user_id IS NULL`);
      await dst.execute(sql`INSERT INTO configuration (key, value, user_id) VALUES ('ChartOfAccountsType', ${type.value}, NULL)`);
    }
  }

  if (opts.users) {
    await copy(src, dst, 'user_roles', { mode: 'upsert' });
    await copy(src, dst, 'user_role_permissions', { replace: true });
    // The new company's administrator (id 1) stays as entered in the form.
    counts.users = await copy(src, dst, 'users', { where: 'id <> 1' });
  }

  if (partners) {
    for (const t of ['countries', 'banks']) await copy(src, dst, t, { mode: 'upsert' });
    await copy(src, dst, 'company_groups', { replace: true });
    counts.partners = await copy(src, dst, 'companies');
    await copy(src, dst, 'addresses', { where: "owner_type = 'company'" });
    await copy(src, dst, 'bank_accounts', { where: "owner_type = 'company'", map: (r) => (chart ? r : { ...r, bank_statement_account_id: null }) });
    if (chart) await copy(src, dst, 'company_accounts');
  }

  if (opts.accountings) {
    await copy(src, dst, 'branches', { mode: 'upsert' });
    await copy(src, dst, 'document_types', { mode: 'upsert' });
    for (const t of ['terms', 'reference_texts', 'paragraphs']) await copy(src, dst, t, { replace: true });

    // Financial years by year; missing ones are created.
    const fyMap = new Map<number, number>();
    const dstYears = await read(dst, 'financial_years');
    for (const y of await read(src, 'financial_years')) {
      const same = dstYears.find((d) => d.year === y.year);
      if (same) {
        fyMap.set(y.id as number, same.id as number);
        await dst.execute(sql`UPDATE financial_years SET is_locked = ${y.is_locked}, locked_months = ${y.locked_months} WHERE id = ${same.id}`);
      } else {
        const { id: _id, ...rest } = y;
        void _id;
        const cols = Object.keys(rest);
        const [ins] = await queryRows<{ id: number }>(dst, sql`INSERT INTO financial_years (${sql.join(cols.map((c) => sql.identifier(c)), sql`, `)}) VALUES (${sql.join(cols.map((c) => sql`${rest[c] ?? null}`), sql`, `)}) RETURNING id`);
        fyMap.set(y.id as number, ins!.id);
      }
    }
    const fy = (v: unknown) => (v == null ? v : fyMap.get(v as number) ?? v);

    // Sequences by (channel, year): carry the last numbers.
    const seqMap = new Map<number, number>();
    const dstSeq = await read(dst, 'sequences');
    for (const q of await read(src, 'sequences')) {
      const year = fy(q.financial_year_id);
      const match = dstSeq.find((d) => d.channel === q.channel && (d.financial_year_id ?? null) === (year ?? null));
      if (match) {
        await dst.execute(sql`UPDATE sequences SET format = ${q.format}, last_number = ${q.last_number}, numeric_length = ${q.numeric_length}, is_number_reset_next_year = ${q.is_number_reset_next_year} WHERE id = ${match.id}`);
        seqMap.set(q.id as number, match.id as number);
      } else {
        const [ins] = await queryRows<{ id: number }>(dst, sql`INSERT INTO sequences (channel, financial_year_id, format, last_number, numeric_length, is_number_reset_next_year)
          VALUES (${q.channel}, ${year ?? null}, ${q.format}, ${q.last_number}, ${q.numeric_length}, ${q.is_number_reset_next_year}) RETURNING id`);
        seqMap.set(q.id as number, ins!.id);
      }
    }

    const keepUser = (v: unknown) => (opts.users || v == null ? v : 1);
    await copy(src, dst, 'documents');
    counts.accountings = await copy(src, dst, 'accountings', {
      map: (r) => ({ ...r, financial_year_id: fy(r.financial_year_id), user_id: keepUser(r.user_id), sequence_id: r.sequence_id == null ? null : seqMap.get(r.sequence_id as number) ?? null }),
    });
    for (const t of ['accounting_details', 'accounting_extended_details', 'accounting_attachments', 'accounting_payment_details']) await copy(src, dst, t);
    await copy(src, dst, 'account_initial_balances', { map: (r) => ({ ...r, financial_year_id: fy(r.financial_year_id) }) });
  }

  // Templates: partners and users that were not carried over are dropped from them.
  const partnerRef = (v: unknown) => (partners ? v : null);
  const userRef = (v: unknown) => (opts.users || v == null ? v : 1);
  if (opts.accountingTemplates || opts.bankTemplates) await copy(src, dst, 'document_types', { mode: 'upsert' });
  if (opts.accountingTemplates) {
    counts.accountingTemplates = await copy(src, dst, 'accounting_templates', { map: (r) => ({ ...r, company_id: partnerRef(r.company_id), user_id: userRef(r.user_id) }) });
    await copy(src, dst, 'accounting_template_details', { map: (r) => ({ ...r, company_id: partnerRef(r.company_id) }) });
    await copy(src, dst, 'schedules');
    // Generated schedule rows point to entries; they come only with the entries.
    if (opts.accountings) await copy(src, dst, 'accounting_template_schedules');
  }
  if (opts.bankTemplates) {
    await copy(src, dst, 'banks', { mode: 'upsert' });
    counts.bankTemplates = await copy(src, dst, 'bank_templates', { map: (r) => ({ ...r, company_id: partnerRef(r.company_id), user_id: userRef(r.user_id) }) });
    await copy(src, dst, 'bank_template_details', { map: (r) => ({ ...r, company_id: partnerRef(r.company_id) }) });
  }
  return counts;
}
