import { sql, type SQL } from 'drizzle-orm';
import { activityByDocuments } from '@shmi/core';
import { queryRows, type DbOrTx } from '../db/provider.ts';

/**
 * Действия по потребители (01b 8, 05 7.7): the activity log by menus
 * (spReport_UserActivities) and the processed documents per user
 * (spReport_UserActivitiesByDocuments). Days are Europe/Sofia days.
 */

export interface ActivityFilter {
  userId?: number;
  /** Activity code of the log row (add, edit, delete, print, export, login, logout). */
  activity?: string;
  entityType?: string;
  /** yyyy-MM-dd, inclusive. */
  from?: string;
  to?: string;
  /** Free text over user, entity and description. */
  q?: string;
  limit?: number;
}

const TZ = process.env.TZ_COMPANY ?? 'Europe/Sofia';

export async function activityLog(db: DbOrTx, f: ActivityFilter) {
  const conds: SQL[] = [sql`TRUE`];
  if (f.userId) conds.push(sql`l.user_id = ${f.userId}`);
  if (f.activity) conds.push(sql`l.activity = ${f.activity}`);
  if (f.entityType) conds.push(sql`l.entity_type = ${f.entityType}`);
  if (f.from) conds.push(sql`l.created_at >= (${f.from}::date::timestamp AT TIME ZONE ${TZ})`);
  if (f.to) conds.push(sql`l.created_at < ((${f.to}::date + 1)::timestamp AT TIME ZONE ${TZ})`);
  if (f.q?.trim()) {
    const like = `%${f.q.trim()}%`;
    conds.push(sql`(coalesce(u.name, '') ILIKE ${like} OR coalesce(l.description, '') ILIKE ${like} OR l.entity_type ILIKE ${like})`);
  }
  const rows = await queryRows<{ id: number; user_id: number | null; user: string | null; activity: string; entity_type: string; entity_id: number | null; description: string | null; created_at: string | Date }>(db, sql`
    SELECT l.id, l.user_id, u.name AS user, l.activity, l.entity_type, l.entity_id, l.description, l.created_at
    FROM data_activity_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY l.id DESC
    LIMIT ${Math.min(Math.max(f.limit ?? 1000, 1), 20_000)}`);
  return rows.map((r) => ({
    id: r.id, userId: r.user_id, user: r.user, activity: r.activity, entityType: r.entity_type, entityId: r.entity_id, description: r.description,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
  }));
}

/** "По документи": accountings of the window per user (by accounting date), initial balances and correspondences excluded. */
export async function activityDocuments(db: DbOrTx, f: { userId?: number; from: string; to: string }) {
  const rows = await queryRows<{ user_id: number | null; user_name: string | null; document_id: number | null; document_type_id: number | null }>(db, sql`
    SELECT a.user_id, u.name AS user_name, a.document_id, d.document_type_id
    FROM accountings a
    LEFT JOIN documents d ON d.id = a.document_id
    LEFT JOIN users u ON u.id = a.user_id
    WHERE NOT a.is_initial_balance AND NOT a.is_initial_correspondence
      AND a.accounting_date BETWEEN ${f.from}::date AND ${f.to}::date
      ${f.userId ? sql`AND a.user_id = ${f.userId}` : sql``}`);
  return activityByDocuments(rows.map((r) => ({ userId: r.user_id, userName: r.user_name, documentId: r.document_id, documentTypeId: r.document_type_id })));
}
