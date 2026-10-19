import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  ASSET_MESSAGES, assetMessage, changeRateFrom, DEPRECIATION_CATEGORIES, checkImprovement, computeRevaluation, convertScheduleToEur, D, dec,
  DEPRECIATION_CATEGORY, deriveMethod, endOfMonth, firstOfMonth, fmtMsg, dateBg, improvementDate, isLeaf, monthIndex,
  monthLabelBg, NO_END_DATE, pendingDefaultPeriod, postingReference, revaluationPrefill, sum, TERMINATION, terminateDefaults,
  terminationLines, toEur, validateCommonPercent, validPercentage, yearPlans, ZERO, type Dec, type ValidationMessage,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { CompanyDb, DbOrTx } from '../db/provider.ts';
import { ApiError, badRequest } from '../lib/errors.ts';
import { getBoolConfig } from './config.ts';
import { saveEntry, type EntryInput } from './journal.ts';
import { logActivity } from './audit.ts';
import { trialBalance } from './reports.ts';
import {
  computePlan, ensureRootLocation, ledgerIsEuro, loadAssetBundle, loadPlans, lockInfo, locationPaths, MEMORIAL_ORDER_TYPE,
  nextMemorialNumber, persistPlan, planLastProcessed, planReserve, type AssetCtx, type PlanInput, type StoredPlan,
} from './assets.ts';

const assertActive = (asset: typeof s.fixedAssets.$inferSelect) => {
  if (asset.terminationStatusId !== TERMINATION.NotTerminated) throw badRequest(ASSET_MESSAGES.strCantEditAssetDueToAssetTermination);
};

const planInputOf = (p: StoredPlan): PlanInput => ({
  depreciationAmount: p.dep.depreciationAmount, nonDepreciableAmount: p.dep.nonDepreciableAmount,
  acquisitionDate: p.dep.acquisitionDate, startDate: p.dep.startDate, calcType: p.dep.calcType as 'period' | 'rate',
  annualRate: p.dep.annualRate, activePeriodLength: p.dep.activePeriodLength,
  conservation: p.dep.conservationStartDate ? { start: p.dep.conservationStartDate, end: p.dep.conservationEndDate } : null,
  note: p.dep.note, serialNumber: p.dep.serialNumber,
});

async function optionalReference(db: DbOrTx, note: string | null | undefined) {
  return (await getBoolConfig(db, 'IsOptionalReferenceEnabled', false)) && note ? note.slice(0, 255) : null;
}

/* ------------------------------------------------------------------ */
/* Accounting requests (Заявки за осчетоводяване, 12.1-12.3)           */
/* ------------------------------------------------------------------ */

export interface RequestFilter {
  from?: string;
  to?: string;
  inventoryNumber?: string;
  name?: string;
}

export function requestDefaults(ctx: AssetCtx) {
  return pendingDefaultPeriod(ctx.year.year, ctx.appDate);
}

/** GetAllPendingSchedules: unprocessed САП rows of not written-off assets of the current ledger. */
export async function pendingRequests(db: DbOrTx, ctx: AssetCtx, f: RequestFilter) {
  const d = requestDefaults(ctx);
  const from = f.from ?? d.from;
  const to = f.to ?? d.to;
  const res = await db.execute(sql`
    SELECT ds.id, ds.month::text AS month, ds.amount::text AS amount, fa.id AS asset_id, fa.inventory_number, fa.name,
      da.number AS debit_account, ca.number AS credit_account
    FROM depreciation_schedules ds
    JOIN depreciations dep ON dep.id = ds.depreciation_id
    JOIN fixed_assets fa ON fa.accounting_depreciation_id = dep.id
    LEFT JOIN accounts da ON da.id = fa.debit_account_id
    LEFT JOIN accounts ca ON ca.id = fa.credit_account_id
    WHERE NOT ds.is_processed AND dep.is_accounting AND dep.final_date IS NULL AND fa.is_euro = ${ledgerIsEuro(ctx.year)}
      AND ds.month >= ${firstOfMonth(from)} AND ds.month <= ${to}
    ORDER BY ds.month, fa.name, fa.id`);
  type Row = { id: number; month: string; amount: string; asset_id: number; inventory_number: string; name: string; debit_account: string | null; credit_account: string | null };
  const lc = (x: string) => x.toLowerCase();
  const rows = (res as unknown as { rows: Row[] }).rows.filter((r) =>
    (!f.inventoryNumber || lc(r.inventory_number).startsWith(lc(f.inventoryNumber))) && (!f.name || lc(r.name).includes(lc(f.name))));
  return {
    from, to,
    rows: rows.map((r) => ({
      id: r.id, type: 'depreciation', month: r.month, year: Number(r.month.slice(0, 4)), monthNumber: Number(r.month.slice(5, 7)),
      amount: dec(r.amount).toFixed(2), assetId: r.asset_id, inventoryNumber: r.inventory_number, name: r.name,
      debitAccount: r.credit_account, creditAccount: r.debit_account,
    })),
    total: sum(rows.map((r) => r.amount)).toFixed(2),
  };
}

/**
 * "Контиране" (12.2): one memorial order per request, in list order, each in its
 * own transaction. Rows of another year are skipped with a warning; a row whose
 * entry fails validation (e.g. a locked month) stays pending without a message.
 */
export async function postRequests(db: CompanyDb, ctx: AssetCtx, ids: number[]) {
  const posted: { scheduleId: number; accountingId: number; number: string; documentNumber: string }[] = [];
  const failed: number[] = [];
  let skippedOtherYear = 0;
  if (!ids.length) return { posted, failed, skippedOtherYear, warnings: [] as ValidationMessage[] };
  const res = await db.execute(sql`
    SELECT ds.id, ds.month::text AS month, ds.amount::text AS amount, ds.is_processed, fa.name, fa.inventory_number,
      fa.debit_account_id, fa.credit_account_id, dep.note, dep.final_date
    FROM depreciation_schedules ds
    JOIN depreciations dep ON dep.id = ds.depreciation_id
    JOIN fixed_assets fa ON fa.accounting_depreciation_id = dep.id
    WHERE ds.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  type Row = { id: number; month: string; amount: string; is_processed: boolean; name: string; inventory_number: string; debit_account_id: number | null; credit_account_id: number | null; note: string | null; final_date: string | null };
  const byId = new Map((res as unknown as { rows: Row[] }).rows.map((r) => [r.id, r]));
  const optionalEnabled = await getBoolConfig(db, 'IsOptionalReferenceEnabled', false);
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || r.is_processed || r.final_date) continue;
    if (Number(r.month.slice(0, 4)) !== ctx.year.year) {
      skippedOtherYear++;
      continue;
    }
    if (!r.debit_account_id || !r.credit_account_id) {
      failed.push(id);
      continue;
    }
    try {
      const out = await db.transaction(async (tx) => {
        // Claim the month first: a second request (double click, another user) finds it processed.
        const claimed = await tx.update(s.depreciationSchedules).set({ isProcessed: true })
          .where(and(eq(s.depreciationSchedules.id, id), eq(s.depreciationSchedules.isProcessed, false))).returning({ id: s.depreciationSchedules.id });
        if (!claimed.length) return null;
        const date = endOfMonth(r.month);
        const documentNumber = await nextMemorialNumber(tx, ctx.year);
        const entry: EntryInput = {
          accountingDate: date, documentDate: date, documentTypeId: MEMORIAL_ORDER_TYPE, documentNumber,
          term: ASSET_MESSAGES.strDepreciation, reference: postingReference(r.name, r.inventory_number),
          optionalReference: optionalEnabled && r.note ? r.note.slice(0, 255) : null, viesId: null, source: 'depreciation',
          // Dt "Разход за амортизация в сметка" (CreditAccount) / Kt "Амортизация в сметка" (DebitAccount).
          debits: [{ accountId: r.credit_account_id!, amount: dec(r.amount).toFixed(2) }],
          credits: [{ accountId: r.debit_account_id!, amount: dec(r.amount).toFixed(2) }],
        };
        const saved = await saveEntry(tx, entry, { year: ctx.year, userId: ctx.userId });
        await tx.update(s.depreciationSchedules).set({ accountingId: saved.id }).where(eq(s.depreciationSchedules.id, id));
        return { scheduleId: id, accountingId: saved.id, number: saved.number, documentNumber };
      });
      if (out) posted.push(out);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      failed.push(id);
    }
  }
  const warnings = skippedOtherYear ? [assetMessage('strAccountingRequestsFromAnotherYearFound', 'warning')] : [];
  return { posted, failed, skippedOtherYear, warnings };
}

/* ------------------------------------------------------------------ */
/* Write-off and restore (11)                                          */
/* ------------------------------------------------------------------ */

export async function terminateInfo(db: DbOrTx, ctx: AssetCtx, id: number) {
  const { asset, sap, dap } = await loadAssetBundle(db, id);
  const sapLp = planLastProcessed(sap, ctx.appDate);
  const dapLp = planLastProcessed(dap, ctx.appDate);
  const d = terminateDefaults(sapLp.lastProcessedDate, dapLp.lastProcessedDate, sap.dep.endDate, ctx.appDate);
  const reserve = planReserve(sap);
  return {
    ...d, minSapDate: d.sapDate, minDapDate: d.dapDate, sapEndDate: sap.dep.endDate === NO_END_DATE ? null : sap.dep.endDate,
    isRevalued: !reserve.isZero(), reserve: reserve.toFixed(2), accrued: sapLp.accrued.toFixed(2), name: asset.name, inventoryNumber: asset.inventoryNumber,
  };
}

export interface TerminateInput {
  type: number;
  sapDate: string;
  dapDate: string;
  operationAccountId?: number | null;
  revaluationAccountId?: number | null;
  profitAmount?: string | null;
}

export async function terminateAsset(db: DbOrTx, ctx: AssetCtx, id: number, input: TerminateInput) {
  const { asset, sap, dap } = await loadAssetBundle(db, id);
  assertActive(asset);
  const info = await terminateInfo(db, ctx, id);
  const msgs: ValidationMessage[] = [];
  const crit = (k: keyof typeof ASSET_MESSAGES, ...a: string[]) => msgs.push(assetMessage(k, 'critical', ...a));
  const t = input.type;
  if (t === TERMINATION.Expired && sap.dep.endDate !== NO_END_DATE && monthIndex(input.sapDate) < monthIndex(sap.dep.endDate)) {
    crit('strInvalidAssetExpiredOperationSelected', dateBg(sap.dep.endDate));
  }
  // Year checks apply to every operation; {0} prints the default date (defect-compatible).
  if (Number(input.sapDate.slice(0, 4)) !== ctx.year.year) crit('strInvalidAssetTerminationDateSAP_AccountingYear', dateBg(info.sapDate));
  if (Number(input.dapDate.slice(0, 4)) !== ctx.year.year) crit('strInvalidAssetTerminationDateDAP_AccountingYear', dateBg(info.dapDate));
  const residual = dec(sap.dep.nonDepreciableAmount);
  const needsOperationAccount = t === TERMINATION.Wasted || t === TERMINATION.Sold || (t === TERMINATION.Expired && residual.gt(0));
  if (needsOperationAccount && !input.operationAccountId) crit(t === TERMINATION.Sold ? 'strInvalidAssetSaleOperationAccount' : 'strInvalidAssetWasteOperationAccount');
  const ids = [input.operationAccountId, input.revaluationAccountId].filter((x): x is number => !!x);
  const accs = ids.length ? await db.select().from(s.accounts).where(inArray(s.accounts.id, ids)) : [];
  const leaf = (aid: number) => {
    const a = accs.find((x) => x.id === aid);
    return !!a && isLeaf({ left: a.leftIndex, right: a.rightIndex }) && a.number !== '0';
  };
  if (input.operationAccountId && !leaf(input.operationAccountId)) crit(t === TERMINATION.Sold ? 'strInvalidCreditAccountHasSubAccounts' : 'strInvalidDebitAccountHasSubAccounts');
  const reserve = planReserve(sap);
  const isPosting = t === TERMINATION.Wasted || t === TERMINATION.Sold || t === TERMINATION.Expired;
  if (isPosting && !reserve.isZero()) {
    if (!input.revaluationAccountId) crit('strMissingRevaluationAccount');
    else if (!leaf(input.revaluationAccountId)) crit('strInvalidRevaluationAccountHasSubAccounts');
  }
  if (t === TERMINATION.Sold && dec(input.profitAmount ?? 0).lte(0)) crit('strInvalidAssetProfitAmount');
  if (msgs.length) throw new ApiError(422, 'Активът не може да бъде отписан поради следните грешки:', msgs);

  let accountingId: number | null = null;
  let number: string | null = null;
  if (isPosting) {
    const lines = terminationLines({ type: t, depreciableAmount: sap.dep.depreciableAmount, nonDepreciableAmount: sap.dep.nonDepreciableAmount, accrued: info.accrued, reserve });
    const accountOf = (role: string) => (role === 'depreciation' ? asset.debitAccountId : role === 'operation' ? input.operationAccountId : role === 'revaluation' ? input.revaluationAccountId : asset.inventoryAccountId)!;
    const term = t === TERMINATION.Wasted ? ASSET_MESSAGES.strFixedAssetOperationTermWasted : t === TERMINATION.Sold ? ASSET_MESSAGES.strFixedAssetOperationTermSold : ASSET_MESSAGES.strFixedAssetOperationTermExpired;
    const entry: EntryInput = {
      accountingDate: input.sapDate, documentDate: input.sapDate, documentTypeId: MEMORIAL_ORDER_TYPE,
      documentNumber: await nextMemorialNumber(db, ctx.year), term,
      reference: fmtMsg(ASSET_MESSAGES.strFixedAssetOperationReference, asset.name, asset.inventoryNumber).slice(0, 255),
      optionalReference: await optionalReference(db, sap.dep.note), viesId: null, source: 'asset-writeoff',
      debits: lines.filter((l) => l.side === 'debit').map((l) => ({ accountId: accountOf(l.role), amount: l.amount.toFixed(2) })),
      credits: lines.filter((l) => l.side === 'credit').map((l) => ({ accountId: accountOf(l.role), amount: l.amount.toFixed(2) })),
    };
    // A positive reserve gives two credit lines; split into one-to-many entries is not allowed, so merge into many-to-one when needed.
    if (entry.debits.length > 1 && entry.credits.length > 1) {
      throw new ApiError(422, 'Активът не може да бъде отписан поради следните грешки:', [{ key: 'strManyToMany', text: 'Контирането може да бъде едно към едно, едно към много или много към едно.', severity: 'critical' }]);
    }
    const saved = await saveEntry(db, entry, { year: ctx.year, userId: ctx.userId });
    accountingId = saved.id;
    number = saved.number;
  }
  await db.update(s.fixedAssets).set({ terminationStatusId: t, terminationAccountingId: accountingId }).where(eq(s.fixedAssets.id, id));
  await db.update(s.depreciations).set({ finalDate: input.sapDate }).where(eq(s.depreciations.id, sap.dep.id));
  await db.update(s.depreciations).set({ finalDate: input.dapDate }).where(eq(s.depreciations.id, dap.dep.id));
  await logActivity(db, ctx.userId, 'edit', 'fixedAsset', id, `Отписване ${asset.inventoryNumber}`);
  return { accountingId, number };
}

export async function restoreAsset(db: DbOrTx, ctx: AssetCtx, id: number) {
  const { asset, sap, dap } = await loadAssetBundle(db, id);
  if (asset.terminationStatusId === TERMINATION.NotTerminated) throw badRequest('Избраният актив не е отписан.');
  // The write-off posting is not deleted; only the link is cleared (11.4).
  await db.update(s.fixedAssets).set({ terminationStatusId: TERMINATION.NotTerminated, terminationAccountingId: null }).where(eq(s.fixedAssets.id, id));
  await db.update(s.depreciations).set({ finalDate: null }).where(inArray(s.depreciations.id, [sap.dep.id, dap.dep.id]));
  await logActivity(db, ctx.userId, 'edit', 'fixedAsset', id, `Връщане на отписан актив ${asset.inventoryNumber}`);
}

/* ------------------------------------------------------------------ */
/* Improvement from the plan editor (9.1 path B)                       */
/* ------------------------------------------------------------------ */

async function saveRegenerated(db: DbOrTx, ctx: AssetCtx, assetId: number, isAccounting: boolean, mutate: (input: PlanInput) => void, opts: { iasMode?: boolean; reserve?: Dec } = {}) {
  const { asset, sap, dap } = await loadAssetBundle(db, assetId);
  const plan = isAccounting ? sap : dap;
  const input = planInputOf(plan);
  mutate(input);
  input.regenerate = true;
  const locks = await lockInfo(db);
  const p = computePlan({
    isAccounting, input, synchronized: asset.areDepreciationsSynchronized, wasSynchronized: asset.areDepreciationsSynchronized,
    categoryId: asset.categoryId, stored: plan, reserve: opts.reserve ?? planReserve(plan), locks, appDate: ctx.appDate, iasMode: opts.iasMode,
  });
  // Posted months keep their posting (the plan is regenerated around them).
  p.conflicts = [];
  await persistPlan(db, plan.dep.id, p, plan, ctx, null);
  if (isAccounting) await db.update(s.fixedAssets).set({ revaluationReserve: p.years.reduce((a, y) => a.plus(y.revaluationReserve), ZERO).toFixed(6) }).where(eq(s.fixedAssets.id, assetId));
  if (isAccounting && asset.areDepreciationsSynchronized && !opts.iasMode) {
    // CopyFrom(САП) into the synchronised ДАП (improvement list included).
    const copy = planInputOf(dap);
    Object.assign(copy, { depreciationAmount: input.depreciationAmount, nonDepreciableAmount: input.nonDepreciableAmount, regenerate: true });
    const t = computePlan({ isAccounting: false, input: copy, synchronized: true, wasSynchronized: true, categoryId: asset.categoryId, stored: dap, reserve: ZERO, locks, appDate: ctx.appDate });
    await persistPlan(db, dap.dep.id, t, dap, ctx, null);
    await db.delete(s.improvementsHistory).where(eq(s.improvementsHistory.depreciationId, dap.dep.id));
    const imps = await db.select().from(s.improvementsHistory).where(eq(s.improvementsHistory.depreciationId, sap.dep.id));
    if (imps.length) await db.insert(s.improvementsHistory).values(imps.map((i) => ({ depreciationId: dap.dep.id, improvementDate: i.improvementDate, newDepreciationAmount: i.newDepreciationAmount })));
  }
  return p;
}

async function addImprovementRows(db: DbOrTx, plan: StoredPlan, date: string, amount: string) {
  if (!plan.improvements.length) {
    await db.insert(s.improvementsHistory).values({ depreciationId: plan.dep.id, improvementDate: plan.dep.startDate, newDepreciationAmount: plan.dep.depreciationAmount });
  }
  await db.insert(s.improvementsHistory).values({ depreciationId: plan.dep.id, improvementDate: date, newDepreciationAmount: dec(amount).toFixed(6) });
}

/** "Подобрения" add button of the plan editor (Z75 with IAS mode off). */
export async function addImprovement(db: DbOrTx, ctx: AssetCtx, assetId: number, isAccounting: boolean, amount: string) {
  const { asset, sap, dap } = await loadAssetBundle(db, assetId);
  assertActive(asset);
  const plan = isAccounting ? sap : dap;
  const lp = planLastProcessed(plan, ctx.appDate);
  const notApplied = asset.categoryId === DEPRECIATION_CATEGORY.LandAndForests || (plan.dep.calcType === 'rate' && dec(plan.dep.annualRate).isZero());
  const err = checkImprovement({
    isAccounting, newAmount: amount, depreciationAmount: plan.dep.depreciationAmount, nonDepreciableAmount: plan.dep.nonDepreciableAmount,
    revaluationReserve: planReserve(plan), lastProcessedDate: lp.lastProcessedDate, startDate: plan.dep.startDate, notApplied,
  });
  if (err) throw new ApiError(422, ASSET_MESSAGES[err], [assetMessage(err)]);
  await addImprovementRows(db, plan, improvementDate(lp.lastProcessedDate), amount);
  await saveRegenerated(db, ctx, assetId, isAccounting, (i) => { i.depreciationAmount = dec(amount).toFixed(6); });
}

/** Removing one improvement (strRemoveSelectedImprovementConfirmation): the cost goes back to the previous value. */
export async function removeImprovement(db: DbOrTx, ctx: AssetCtx, assetId: number, improvementId: number) {
  const { asset, sap, dap } = await loadAssetBundle(db, assetId);
  assertActive(asset);
  const plan = [sap, dap].find((p) => p.improvements.some((i) => i.id === improvementId));
  if (!plan) throw badRequest('Подобрението не е намерено.');
  const rest = plan.improvements.filter((i) => i.id !== improvementId);
  await db.delete(s.improvementsHistory).where(eq(s.improvementsHistory.id, improvementId));
  let cost = rest.length ? rest.reduce((m, i) => D.max(m, dec(i.newDepreciationAmount)), ZERO) : dec(plan.dep.depreciationAmount);
  if (rest.length === 1) {
    // Only the base row is left.
    cost = dec(rest[0]!.newDepreciationAmount);
    await db.delete(s.improvementsHistory).where(eq(s.improvementsHistory.id, rest[0]!.id));
  }
  await saveRegenerated(db, ctx, assetId, plan.dep.isAccounting, (i) => { i.depreciationAmount = cost.toFixed(6); });
}

/* ------------------------------------------------------------------ */
/* IAS dialog: improvement (path A) and revaluation (9.0-9.2)           */
/* ------------------------------------------------------------------ */

async function impairmentAccounts(db: DbOrTx, isEuro: boolean) {
  const rows = await db.select().from(s.accounts).where(and(eq(s.accounts.isEuro, isEuro), inArray(s.accounts.accountCategoryId, [59, 60]))).orderBy(asc(s.accounts.number));
  const pick = (cat: number) => rows.find((a) => a.accountCategoryId === cat && isLeaf({ left: a.leftIndex, right: a.rightIndex }));
  return { loss: pick(59), income: pick(60) };
}

export async function iasInfo(db: DbOrTx, ctx: AssetCtx, id: number) {
  const { asset, sap } = await loadAssetBundle(db, id);
  const lp = planLastProcessed(sap, ctx.appDate);
  const isLand = asset.categoryId === DEPRECIATION_CATEGORY.LandAndForests;
  const acc = await impairmentAccounts(db, ledgerIsEuro(ctx.year));
  const reserves = await db.select().from(s.revaluationReserves).where(and(eq(s.revaluationReserves.fixedAssetId, id), eq(s.revaluationReserves.isDeleted, false))).orderBy(asc(s.revaluationReserves.date));
  return {
    name: asset.name, inventoryNumber: asset.inventoryNumber, isLand,
    improvementAmount: dec(sap.dep.depreciationAmount).toFixed(2),
    newAmount: revaluationPrefill(sap.dep.depreciableAmount, lp.accrued).toFixed(2),
    lastProcessedDate: lp.lastProcessedDate,
    operationDate: endOfMonth(lp.lastProcessedDate),
    acquisitionDate: sap.dep.acquisitionDate,
    reserve: planReserve(sap).toFixed(2),
    accountsDefined: Boolean(acc.loss && acc.income),
    reserves: reserves.map((r) => ({ date: r.date, amount: dec(r.amount).toFixed(2) })),
  };
}

export interface IasInput {
  mode: 'improvement' | 'revaluation';
  amount: string;
  withPosting?: boolean;
  accountId?: number | null;
  /** Land and forests only (RevaluationDate). */
  date?: string | null;
}

export async function applyIas(db: DbOrTx, ctx: AssetCtx, id: number, input: IasInput) {
  const { asset, sap } = await loadAssetBundle(db, id);
  assertActive(asset);
  const info = await iasInfo(db, ctx, id);
  if (!info.accountsDefined) throw new ApiError(422, ASSET_MESSAGES.strReevaluationAmountAccountsNotDefined, [assetMessage('strReevaluationAmountAccountsNotDefined')]);
  const fail = (k: keyof typeof ASSET_MESSAGES): never => { throw new ApiError(422, ASSET_MESSAGES[k], [assetMessage(k)]); };
  const lp = planLastProcessed(sap, ctx.appDate);
  const opDate = info.isLand ? input.date ?? info.operationDate : info.operationDate;

  if (input.mode === 'improvement') {
    if (info.isLand && opDate < sap.dep.acquisitionDate) fail('strImprovementRevaluationDateIsLessThanAcquisitionDate');
    if (dec(input.amount).lte(dec(sap.dep.depreciationAmount))) fail('strImprovementAmountIsLessThanAmount');
    const notApplied = info.isLand || (sap.dep.calcType === 'rate' && dec(sap.dep.annualRate).isZero());
    const err = checkImprovement({
      isAccounting: true, newAmount: input.amount, depreciationAmount: sap.dep.depreciationAmount, nonDepreciableAmount: sap.dep.nonDepreciableAmount,
      revaluationReserve: planReserve(sap), lastProcessedDate: lp.lastProcessedDate, startDate: sap.dep.startDate, notApplied,
    });
    if (err) fail(err);
    await addImprovementRows(db, sap, info.isLand ? opDate : improvementDate(lp.lastProcessedDate), input.amount);
    await saveRegenerated(db, ctx, id, true, (i) => { i.depreciationAmount = dec(input.amount).toFixed(6); }, { iasMode: true });
    await logActivity(db, ctx.userId, 'edit', 'fixedAsset', id, `Подобрение по МСС ${asset.inventoryNumber}`);
    return { accountingId: null, number: null, nrr: null };
  }

  // Revaluation / impairment (Z39).
  if (info.isLand && opDate < sap.dep.acquisitionDate) fail('strRevaluationDateIsLessThanAcquisitionDate');
  if (input.withPosting && Number(opDate.slice(0, 4)) !== ctx.year.year) fail('strAccountingYearFail');
  const lrr = planReserve(sap);
  const r = computeRevaluation({ newAmount: input.amount, depreciableAmount: sap.dep.depreciableAmount, accrued: lp.accrued, currentReserve: lrr });
  if (r.error) fail(r.error);
  if (input.withPosting && r.postingAmount.isZero()) fail('strZeroReevaluationSumError');
  let user: typeof s.accounts.$inferSelect | undefined;
  if (input.withPosting) {
    [user] = input.accountId ? await db.select().from(s.accounts).where(eq(s.accounts.id, input.accountId)) : [];
    if (!user || !isLeaf({ left: user.leftIndex, right: user.rightIndex })) fail('strInvalidAccountNumber');
  }
  const y = Number(opDate.slice(0, 4));
  await db.update(s.revaluationReserves).set({ isDeleted: true })
    .where(and(eq(s.revaluationReserves.fixedAssetId, id), eq(s.revaluationReserves.isDeleted, false), sql`extract(year from ${s.revaluationReserves.date}) = ${y}`));
  const [rr] = await db.insert(s.revaluationReserves).values({ fixedAssetId: id, date: opDate, amount: dec(input.amount).toFixed(6) }).returning();
  // The year slot of Y is overwritten with NRR (defect D1 compatible); the total is the sum of the slots.
  const slots = new Map(sap.years.map((x) => [Number(x.year.slice(0, 4)), dec(x.revaluationReserve)]));
  slots.set(y, r.nrr);
  const total = [...slots.values()].reduce((a, b) => a.plus(b), ZERO);
  const existingYear = sap.years.find((x) => Number(x.year.slice(0, 4)) === y);
  if (existingYear) await db.update(s.depreciationYearPlans).set({ revaluationReserve: r.nrr.toFixed(6) }).where(eq(s.depreciationYearPlans.id, existingYear.id));
  else await db.insert(s.depreciationYearPlans).values({ depreciationId: sap.dep.id, year: `${y}-01-01`, revaluationReserve: r.nrr.toFixed(6) });
  if (!info.isLand) {
    await saveRegenerated(db, ctx, id, true, () => {}, { iasMode: true, reserve: total });
  }
  await db.update(s.fixedAssets).set({ revaluationReserve: total.toFixed(6) }).where(eq(s.fixedAssets.id, id));

  let accountingId: number | null = null;
  let number: string | null = null;
  if (input.withPosting) {
    const acc = await impairmentAccounts(db, ledgerIsEuro(ctx.year));
    const amount = r.postingAmount.toFixed(2);
    const debit = r.isDecrease ? acc.loss!.id : user!.id;
    const credit = r.isDecrease ? user!.id : acc.income!.id;
    // One transaction with the reserve change and validated (defects D2 and D6 corrected: sequence number, Validate first).
    const saved = await saveEntry(db, {
      accountingDate: opDate, documentDate: opDate, documentTypeId: MEMORIAL_ORDER_TYPE, documentNumber: await nextMemorialNumber(db, ctx.year),
      term: ASSET_MESSAGES.strInternationalAccountingStandard, reference: postingReference(asset.name, asset.inventoryNumber),
      optionalReference: await optionalReference(db, sap.dep.note), viesId: null, source: 'asset-revaluation',
      debits: [{ accountId: debit, amount }], credits: [{ accountId: credit, amount }],
    }, { year: ctx.year, userId: ctx.userId });
    accountingId = saved.id;
    number = saved.number;
    await db.update(s.revaluationReserves).set({ accountingId }).where(eq(s.revaluationReserves.id, rr!.id));
  }
  await logActivity(db, ctx.userId, 'edit', 'fixedAsset', id, `Преоценка по МСС ${asset.inventoryNumber}`);
  return { accountingId, number, nrr: r.nrr.toFixed(2), totalReserve: total.toFixed(2) };
}

/* ------------------------------------------------------------------ */
/* Bulk change of common data (14.3)                                   */
/* ------------------------------------------------------------------ */

export interface CommonDataInput {
  ids: number[];
  mol?: string | null;
  sapRate?: string | null;
  dapRate?: string | null;
  confirm?: boolean;
}

export async function editCommonData(db: DbOrTx, ctx: AssetCtx, input: CommonDataInput) {
  const fy = ctx.year.year;
  const errors: ValidationMessage[] = [];
  for (const r of [input.sapRate, input.dapRate]) {
    if (r != null && r !== '') {
      const e = validateCommonPercent(r);
      if (e) errors.push(e);
    }
  }
  if (errors.length) throw new ApiError(422, errors[0]!.text, errors);
  const assets = input.ids.length ? await db.select().from(s.fixedAssets).where(inArray(s.fixedAssets.id, input.ids)) : [];
  const plans = await loadPlans(db, assets.flatMap((a) => [a.accountingDepreciationId, a.taxDepreciationId]));
  const changeRate = Boolean(input.sapRate || input.dapRate);
  const groups: Record<'land' | 'later' | 'worn' | 'accrued', string[]> = { land: [], later: [], worn: [], accrued: [] };
  const eligible = new Set<number>();
  for (const a of assets) {
    const sap = plans.get(a.accountingDepreciationId)!;
    const label = `${a.inventoryNumber} ${a.name}`;
    if (!changeRate) { eligible.add(a.id); continue; }
    if (a.categoryId === DEPRECIATION_CATEGORY.LandAndForests) { groups.land.push(label); continue; }
    if (Number(sap.dep.startDate.slice(0, 4)) > fy) { groups.later.push(label); continue; }
    const worn = [input.sapRate ? sap : null, input.dapRate ? plans.get(a.taxDepreciationId)! : null].some((p) => p && p.dep.endDate !== NO_END_DATE && Number(p.dep.endDate.slice(0, 4)) < fy);
    if (worn) { groups.worn.push(label); continue; }
    if (input.sapRate && sap.rows.some((r) => r.isProcessed && r.month.startsWith(`${fy}-`))) groups.accrued.push(label);
    eligible.add(a.id);
  }
  const warnings: { text: string; items: string[] }[] = [];
  if (groups.land.length) warnings.push({ text: ASSET_MESSAGES.strAttentionLandAndForests, items: groups.land });
  if (groups.later.length) warnings.push({ text: ASSET_MESSAGES.strAttentionStartInLaterYear, items: groups.later });
  if (groups.worn.length) warnings.push({ text: ASSET_MESSAGES.strAttentionWornOutInOtherYear, items: groups.worn });
  if (groups.accrued.length) warnings.push({ text: ASSET_MESSAGES.strAttentionThereAreAccountingsInTheseFixedAssets, items: groups.accrued });
  const confirmations: string[] = [];
  if (input.sapRate) confirmations.push(fmtMsg(ASSET_MESSAGES.strAttentionYouWillChangePercentageInSapDeprOfSomeAssets, fy), ASSET_MESSAGES.strConnectionBetweenSAPandAccountingsWillBeDeleted);
  if (input.dapRate) confirmations.push(fmtMsg(ASSET_MESSAGES.strAttentionYouWillChangePercentageInTaxDeprOfSomeAssets, fy));
  if (changeRate) confirmations.push(fmtMsg(ASSET_MESSAGES.strAutomaticApplicationDateChangeWillBeDone, fy));
  if (!input.confirm) return { applied: false, warnings, confirmations, protocol: [] };

  const protocol: { kind: 'mol' | 'sap' | 'dap'; inventoryNumber: string; name: string; from: string; to: string; cost: string; accrued: string; bookValue: string; inventoryAccount: string | null }[] = [];
  const accNumbers = new Map((await db.select({ id: s.accounts.id, number: s.accounts.number }).from(s.accounts)).map((a) => [a.id, a.number]));
  for (const a of assets.filter((x) => eligible.has(x.id))) {
    assertActive(a);
    const sap = plans.get(a.accountingDepreciationId)!;
    const accrued = sum(sap.rows.filter((r) => r.isProcessed).map((r) => r.amount));
    const base = { inventoryNumber: a.inventoryNumber, name: a.name, cost: dec(sap.dep.depreciationAmount).toFixed(2), accrued: accrued.toFixed(2), bookValue: dec(sap.dep.depreciationAmount).minus(accrued).toFixed(2), inventoryAccount: a.inventoryAccountId ? accNumbers.get(a.inventoryAccountId) ?? null : null };
    if (input.mol != null && input.mol !== '' && input.mol !== (a.personInCharge ?? '')) {
      await db.update(s.fixedAssets).set({ personInCharge: input.mol.slice(0, 255) }).where(eq(s.fixedAssets.id, a.id));
      protocol.push({ kind: 'mol', ...base, from: a.personInCharge ?? '', to: input.mol });
    }
    for (const [isAccounting, rate] of [[true, input.sapRate], [false, input.dapRate]] as const) {
      if (!rate) continue;
      const plan = plans.get(isAccounting ? a.accountingDepreciationId : a.taxDepreciationId)!;
      const da = dec(plan.dep.depreciableAmount);
      const baseAmount = isAccounting ? da.plus(planReserve(plan)) : da;
      const first = `${plan.dep.startDate.slice(0, 7)}-01`;
      const rows = changeRateFrom(plan.rows.map((r) => ({ month: r.month, amount: dec(r.amount) })), baseAmount, rate, fy, first);
      if (isAccounting) {
        // Postings of the changed months are unlinked (strConnectionBetweenSAPandAccountingsWillBeDeleted).
        await db.update(s.depreciationSchedules).set({ accountingId: null, isProcessed: false })
          .where(and(eq(s.depreciationSchedules.depreciationId, plan.dep.id), sql`${s.depreciationSchedules.month} >= ${`${fy}-01-01`}`));
      }
      const fresh = (await loadPlans(db, [plan.dep.id])).get(plan.dep.id)!;
      const yp = yearPlans(rows, baseAmount, rate);
      const reserveByYear = new Map(fresh.years.map((y) => [Number(y.year.slice(0, 4)), dec(y.revaluationReserve)]));
      const life = rows.length ? monthIndex(rows[rows.length - 1]!.month) - monthIndex(rows[0]!.month) + 1 : 0;
      await persistPlan(db, plan.dep.id, {
        isAccounting, input: { ...planInputOf(plan), calcType: 'rate', annualRate: rate }, notApplied: false, life, annualRate: dec(rate),
        startMonthIncluded: !isAccounting && !a.areDepreciationsSynchronized,
        rows: rows.map((r) => ({ ...r, isProcessed: isAccounting ? fresh.rows.find((x) => x.month === r.month)?.isProcessed ?? false : true })),
        endDate: rows.length ? rows[rows.length - 1]!.month : NO_END_DATE, methodId: deriveMethod(yp),
        years: yp.map((y) => ({ ...y, revaluationReserve: reserveByYear.get(y.year) ?? ZERO })), lastProcessedDate: plan.dep.startDate, accrued: ZERO,
        reserve: planReserve(plan), firstEditableMonthDate: plan.dep.startDate, regenerated: true, messages: [], conflicts: [],
      }, fresh, ctx, null);
      protocol.push({ kind: isAccounting ? 'sap' : 'dap', ...base, from: dec(validPercentage(plan.years.filter((y) => Number(y.year.slice(0, 4)) <= fy))).toDecimalPlaces(2).toString(), to: dec(rate).toDecimalPlaces(2).toString() });
    }
  }
  await logActivity(db, ctx.userId, 'edit', 'fixedAsset', null, `Промяна на общи данни на ${eligible.size} ДА`);
  return { applied: true, warnings, confirmations, protocol };
}

/* ------------------------------------------------------------------ */
/* EUR changeover (13)                                                 */
/* ------------------------------------------------------------------ */

export async function convertAssetsToEur(db: DbOrTx, ctx: AssetCtx) {
  if (ctx.year.year < 2026) throw badRequest('Конвертирането в евро се извършва в счетоводна година 2026 или следваща.');
  const bgn = await db.select().from(s.fixedAssets).where(eq(s.fixedAssets.isEuro, false));
  const already = new Set((await db.select({ src: s.fixedAssets.sourceAssetId }).from(s.fixedAssets).where(eq(s.fixedAssets.isEuro, true))).map((r) => r.src));
  const plans = await loadPlans(db, bgn.flatMap((a) => [a.accountingDepreciationId, a.taxDepreciationId]));
  const accounts = await db.select().from(s.accounts);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const eurByNumber = new Map(accounts.filter((a) => a.isEuro && isLeaf({ left: a.leftIndex, right: a.rightIndex })).map((a) => [a.number, a]));
  const mapAccount = (id: number | null) => {
    if (!id) return null;
    const a = byId.get(id);
    if (!a) return null;
    const mapped = a.mappedAccountId ? byId.get(a.mappedAccountId) : undefined;
    return (mapped?.isEuro ? mapped.id : undefined) ?? eurByNumber.get(a.number)?.id ?? null;
  };
  await ensureRootLocation(db);
  const created: { id: number; sourceId: number; inventoryNumber: string }[] = [];
  for (const a of bgn) {
    if (already.has(a.id)) continue;
    const sap = plans.get(a.accountingDepreciationId)!;
    const dap = plans.get(a.taxDepreciationId)!;
    if (sap.dep.finalDate && sap.dep.finalDate <= '2026-01-01') continue;
    const convertPlan = async (p: StoredPlan) => {
      const da = toEur(p.dep.depreciableAmount);
      const nda = toEur(p.dep.nonDepreciableAmount);
      const reserves = p.years.map((y) => ({ y, r: toEur(y.revaluationReserve) }));
      const reserve = reserves.reduce((acc, x) => acc.plus(x.r), ZERO);
      const base = p.dep.isAccounting ? da.plus(reserve) : da;
      const rows = convertScheduleToEur(p.rows.map((r) => ({ month: r.month, amount: dec(r.amount), isProcessed: p.dep.isAccounting ? r.isProcessed : true })), dec(p.dep.depreciableAmount).plus(p.dep.isAccounting ? planReserve(p) : ZERO));
      const yp = yearPlans(rows, base);
      const rate = validPercentage(p.years);
      const [dep] = await db.insert(s.depreciations).values({
        isAccounting: p.dep.isAccounting, methodId: deriveMethod(yp), depreciationAmount: da.plus(nda).toFixed(6), nonDepreciableAmount: nda.toFixed(6), depreciableAmount: da.toFixed(6),
        acquisitionDate: p.dep.acquisitionDate, startDate: p.dep.startDate, endDate: p.dep.endDate, finalDate: p.dep.finalDate,
        conservationStartDate: p.dep.conservationStartDate, conservationEndDate: p.dep.conservationEndDate, activePeriodLength: p.dep.activePeriodLength,
        annualRate: (rate.isZero() ? dec(p.dep.annualRate) : rate).toDecimalPlaces(15).toFixed(15), calcType: p.dep.calcType, note: p.dep.note, serialNumber: p.dep.serialNumber,
      }).returning();
      if (rows.length) await db.insert(s.depreciationSchedules).values(rows.map((r) => ({ depreciationId: dep!.id, month: r.month, amount: r.amount.toFixed(6), isProcessed: r.isProcessed })));
      const resByYear = new Map(reserves.map((x) => [Number(x.y.year.slice(0, 4)), x.r]));
      const years = yp.map((y) => ({ depreciationId: dep!.id, year: `${y.year}-01-01`, percentage: y.percentage.toDecimalPlaces(15).toFixed(15), amount: y.amount.toFixed(6), revaluationReserve: (resByYear.get(y.year) ?? ZERO).toFixed(6) }));
      for (const [y, r] of resByYear) if (!yp.some((x) => x.year === y) && !r.isZero()) years.push({ depreciationId: dep!.id, year: `${y}-01-01`, percentage: '0', amount: '0', revaluationReserve: r.toFixed(6) });
      if (years.length) await db.insert(s.depreciationYearPlans).values(years);
      if (p.improvements.length) await db.insert(s.improvementsHistory).values(p.improvements.map((i) => ({ depreciationId: dep!.id, improvementDate: i.improvementDate, newDepreciationAmount: toEur(i.newDepreciationAmount).toFixed(6) })));
      return { id: dep!.id, reserve };
    };
    const s1 = await convertPlan(sap);
    const s2 = await convertPlan(dap);
    const [row] = await db.insert(s.fixedAssets).values({
      inventoryNumber: a.inventoryNumber, name: a.name, personInCharge: a.personInCharge,
      debitAccountId: mapAccount(a.debitAccountId), creditAccountId: mapAccount(a.creditAccountId), inventoryAccountId: mapAccount(a.inventoryAccountId),
      revaluationReserve: s1.reserve.toFixed(6), categoryId: a.categoryId, accountingDepreciationId: s1.id, taxDepreciationId: s2.id,
      areDepreciationsSynchronized: a.areDepreciationsSynchronized, terminationStatusId: a.terminationStatusId, terminationAccountingId: null,
      locationId: a.locationId, isEuro: true, sourceAssetId: a.id,
    }).returning();
    const rr = await db.select().from(s.revaluationReserves).where(eq(s.revaluationReserves.fixedAssetId, a.id));
    if (rr.length) await db.insert(s.revaluationReserves).values(rr.map((x) => ({ fixedAssetId: row!.id, date: x.date, amount: toEur(x.amount).toFixed(6), isDeleted: x.isDeleted })));
    created.push({ id: row!.id, sourceId: a.id, inventoryNumber: a.inventoryNumber });
  }
  await logActivity(db, ctx.userId, 'add', 'fixedAsset', null, `Конвертиране на ${created.length} ДА в евро`);
  return { created };
}

/* ------------------------------------------------------------------ */
/* Reconciliation check (14.4)                                         */
/* ------------------------------------------------------------------ */

export async function reconcile(db: DbOrTx, ctx: AssetCtx, from: string, to: string) {
  const isEuro = ledgerIsEuro(ctx.year);
  const assets = await db.select().from(s.fixedAssets).where(and(eq(s.fixedAssets.isEuro, isEuro), eq(s.fixedAssets.terminationStatusId, TERMINATION.NotTerminated)));
  const plans = await loadPlans(db, assets.map((a) => a.accountingDepreciationId));
  const accounts = new Map((await db.select().from(s.accounts)).map((a) => [a.id, a]));
  const cost = new Map<string, Dec>();
  const acc = new Map<string, Dec>();
  for (const a of assets) {
    const p = plans.get(a.accountingDepreciationId)!;
    if (p.dep.startDate > to) continue;
    const inv = a.inventoryAccountId ? accounts.get(a.inventoryAccountId)?.number : undefined;
    if (inv && (inv.startsWith('20') || inv.startsWith('21'))) cost.set(inv, (cost.get(inv) ?? ZERO).plus(dec(p.dep.depreciationAmount)));
    const dep = a.debitAccountId ? accounts.get(a.debitAccountId)?.number : undefined;
    if (dep && (dep.startsWith('241') || dep.startsWith('242'))) {
      const accrued = sum(p.rows.filter((r) => r.isProcessed && r.month <= to).map((r) => r.amount));
      acc.set(dep, (acc.get(dep) ?? ZERO).plus(accrued));
    }
  }
  const tb = await trialBalance(db, { startDate: from, endDate: to, subAccountLevel: 10, showZeroRows: true });
  const balance = new Map(tb.rows.map((r) => [r.number, r]));
  const lines: string[] = [];
  const mismatches: { kind: 'cost' | 'accrued'; account: string; assets: string; balance: string; difference: string }[] = [];
  const costMis = [...cost].filter(([n, v]) => !v.eq(dec(balance.get(n)?.closingDebit ?? 0)));
  const accMis = [...acc].filter(([n, v]) => !v.eq(dec(balance.get(n)?.closingCredit ?? 0)));
  if (costMis.length) {
    lines.push(ASSET_MESSAGES.strDepreciationAmountMismatchHeader);
    for (const [n, v] of costMis) {
      const b = dec(balance.get(n)?.closingDebit ?? 0);
      lines.push(fmtMsg(ASSET_MESSAGES.strAccountDebitLine, n, v.toFixed(2), b.toFixed(2)), fmtMsg(ASSET_MESSAGES.strDifferenceFormat, v.minus(b).toFixed(2)));
      mismatches.push({ kind: 'cost', account: n, assets: v.toFixed(2), balance: b.toFixed(2), difference: v.minus(b).toFixed(2) });
    }
  }
  if (accMis.length) {
    lines.push(ASSET_MESSAGES.strAccruedDepreciationMismatchHeader);
    for (const [n, v] of accMis) {
      const b = dec(balance.get(n)?.closingCredit ?? 0);
      lines.push(fmtMsg(ASSET_MESSAGES.strAccountCreditLine, n, v.toFixed(2), b.toFixed(2)), fmtMsg(ASSET_MESSAGES.strDifferenceFormat, v.minus(b).toFixed(2)));
      mismatches.push({ kind: 'accrued', account: n, assets: v.toFixed(2), balance: b.toFixed(2), difference: v.minus(b).toFixed(2) });
    }
  }
  if (!mismatches.length) lines.push(ASSET_MESSAGES.strNoFixedAssetsError);
  return { ok: mismatches.length === 0, lines, mismatches };
}

/* ------------------------------------------------------------------ */
/* Protocols (spFixedAssetProtocol58, spScrappingFixedAssetProtocol)    */
/* ------------------------------------------------------------------ */

async function companyHeader(db: DbOrTx) {
  const [my] = await db.select().from(s.myCompany).limit(1);
  // Address of type 1, else type 2 (spScrappingFixedAssetProtocol).
  const addrs = my ? await db.select().from(s.addresses).where(and(eq(s.addresses.ownerType, 'my'), eq(s.addresses.ownerId, my.id))).orderBy(asc(s.addresses.addressTypeId)) : [];
  const a = addrs.find((x) => x.addressTypeId === 1) ?? addrs.find((x) => x.addressTypeId === 2) ?? addrs[0];
  return { companyName: my?.name ?? '', bulstat: my?.bulstat ?? '', address: a ? [a.postalCode, a.city, a.address].filter(Boolean).join(', ') : '' };
}

export async function protocol58(db: DbOrTx, ctx: AssetCtx, ids: number[]) {
  const assets = ids.length ? await db.select().from(s.fixedAssets).where(inArray(s.fixedAssets.id, ids)) : [];
  const plans = await loadPlans(db, assets.map((a) => a.taxDepreciationId));
  const paths = await locationPaths(db);
  const accounts = new Map((await db.select().from(s.accounts)).map((a) => [a.id, a]));
  const header = await companyHeader(db);
  return {
    ...header,
    rows: assets.map((a) => {
      const dap = plans.get(a.taxDepreciationId)!;
      const inv = a.inventoryAccountId ? accounts.get(a.inventoryAccountId) : undefined;
      const maxPct = dap.years.reduce((m, y) => D.max(m, dec(y.percentage)), ZERO);
      return {
        id: a.id, inventoryNumber: a.inventoryNumber, name: a.name, personInCharge: a.personInCharge ?? '', location: paths.get(a.locationId) ?? '',
        category: DEPRECIATION_CATEGORIES.find((c) => c.id === a.categoryId)?.description ?? '', accountNumber: inv?.number ?? '', accountDescription: inv?.description ?? '',
        dateOfCommissioning: dap.dep.startDate, depreciableAmount: dec(dap.dep.depreciableAmount).toFixed(2), currency: a.isEuro ? 'EUR' : 'BGN',
        percentage: maxPct.toDecimalPlaces(2).toFixed(2),
      };
    }),
  };
}

export async function scrappingProtocol(db: DbOrTx, ctx: AssetCtx, ids: number[]) {
  const assets = ids.length ? await db.select().from(s.fixedAssets).where(inArray(s.fixedAssets.id, ids)) : [];
  const plans = await loadPlans(db, assets.map((a) => a.accountingDepreciationId));
  const paths = await locationPaths(db);
  const header = await companyHeader(db);
  void ctx;
  return {
    ...header,
    rows: assets.map((a) => {
      const sap = plans.get(a.accountingDepreciationId)!;
      return {
        id: a.id, inventoryNumber: a.inventoryNumber, name: a.name, location: paths.get(a.locationId) ?? '',
        dateOfCommissioning: sap.dep.startDate, terminationDate: sap.dep.finalDate, depreciationAmount: dec(sap.dep.depreciationAmount).toFixed(2),
      };
    }),
  };
}

/** Asset information card (spFixedAssetInformation). */
export async function assetCard(db: DbOrTx, ctx: AssetCtx, id: number, date: string) {
  const { asset, sap, dap } = await loadAssetBundle(db, id);
  const paths = await locationPaths(db);
  const plan = (p: StoredPlan) => {
    const lp = planLastProcessed(p, ctx.appDate);
    return {
      method: p.dep.methodId === 2 ? 'Потребителски' : 'Линеен', startDate: p.dep.startDate, endDate: p.dep.endDate === NO_END_DATE ? null : p.dep.endDate,
      finalDate: p.dep.finalDate, life: p.dep.activePeriodLength, conservationStart: p.dep.conservationStartDate, conservationEnd: p.dep.conservationEndDate,
      note: p.dep.note, maxPercentage: p.years.reduce((m, y) => D.max(m, dec(y.percentage)), ZERO).toDecimalPlaces(2).toFixed(2),
      reserve: planReserve(p).toFixed(2), toDate: lp.lastProcessedDate,
      accrued: (p.dep.isAccounting ? sum(p.rows.filter((r) => r.isProcessed && r.month <= date).map((r) => r.amount)) : sum(p.rows.filter((r) => r.month <= date).map((r) => r.amount))).toFixed(2),
      cost: dec(p.dep.depreciationAmount).toFixed(2),
    };
  };
  return { inventoryNumber: asset.inventoryNumber, name: asset.name, personInCharge: asset.personInCharge, location: paths.get(asset.locationId) ?? '', accounting: plan(sap), tax: plan(dap) };
}

