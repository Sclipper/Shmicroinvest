import { eq } from 'drizzle-orm';
import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';

/**
 * Called before a journal entry is deleted (spec 03b 12.3, 12.4): a deleted
 * monthly depreciation posting makes its schedule row pending again
 * (DeleteDepreciationSchedule); a deleted write-off or revaluation posting only
 * loses its link (spDeleteAccounting: "НЕ изтрива актива, а само контировката").
 */
export async function releaseAssetLinks(db: DbOrTx, accountingId: number) {
  await db.update(s.depreciationSchedules).set({ isProcessed: false, accountingId: null }).where(eq(s.depreciationSchedules.accountingId, accountingId));
  await db.update(s.fixedAssets).set({ terminationAccountingId: null }).where(eq(s.fixedAssets.terminationAccountingId, accountingId));
  await db.update(s.revaluationReserves).set({ accountingId: null }).where(eq(s.revaluationReserves.accountingId, accountingId));
}
