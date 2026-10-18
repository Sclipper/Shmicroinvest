import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';

/** Activity log (spec 01b section 8): add / edit / delete / print / export / login. */
export async function logActivity(db: DbOrTx, userId: number | null, activity: string, entityType: string, entityId: number | null, description?: string) {
  await db.insert(s.dataActivityLog).values({ userId, activity, entityType, entityId, description: description ?? null });
}
