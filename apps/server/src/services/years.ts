import { asc, eq, sql } from 'drizzle-orm';
import { EURO_FLAGS, defaultActiveYear, loginActiveYear } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { exec, type DbOrTx } from '../db/provider.ts';
import { applyChartTemplate, chartTemplateType } from './chart.ts';
import { getConfig, setConfig } from './config.ts';

/** Financial years: create, delete and the euro-chart guard (spec 01b 6.3, 06 4.1). */

const count = async (db: DbOrTx, q: ReturnType<typeof sql>) => ((await exec(db, q)).rows[0] as { n: number }).n;

/**
 * The euro chart is initialised when the EUR chart exists and either the
 * company never had a BGN chart (started in 2026) or the BGN chart was mapped
 * to it by the changeover: the euro conversion (04b 4) or the 2025 -> 2026
 * year-end transfer, both of which set AreAccountsMappedToEuro.
 */
export async function euroChartInitialised(db: DbOrTx) {
  if ((await count(db, sql`SELECT count(*)::int AS n FROM accounts WHERE is_euro AND number <> '0'`)) === 0) return false;
  if ((await count(db, sql`SELECT count(*)::int AS n FROM accounts WHERE NOT is_euro AND number <> '0'`)) === 0) return true;
  return (await getConfig(db, EURO_FLAGS.mapping)) === 'True';
}

/**
 * AddFinancialYear: inserts the year, a new series for every yearly-reset
 * channel, copies each user's numbering series (UserSequences, deleted users
 * too) from the nearest earlier year, or the nearest later one, and seeds the
 * EUR chart for a EUR year when it is empty. A copied series that resets
 * yearly becomes the year's new series of its channel ("[#]", from 1; the
 * custom format is lost as in Delta); the others are shared.
 */
export async function addFinancialYear(tx: DbOrTx, year: number) {
  const before = await tx.select().from(s.financialYears).orderBy(asc(s.financialYears.year));
  const [fy] = await tx.insert(s.financialYears).values({ year, startDate: `${year}-01-01` }).returning();
  const resetting = await tx.select().from(s.sequences).where(eq(s.sequences.isNumberResetNextYear, true));
  const fresh = new Map<number, number>();
  for (const channel of [...new Set(resetting.map((r) => r.channel))]) {
    const [row] = await tx.insert(s.sequences).values({ channel, financialYearId: fy!.id, isNumberResetNextYear: true }).returning({ id: s.sequences.id });
    fresh.set(channel, row!.id);
  }
  const source = before.filter((y) => y.year < year).pop() ?? before.find((y) => y.year > year);
  if (source) {
    const mine = await tx.select({ userId: s.userSequences.userId, seq: s.sequences }).from(s.userSequences)
      .innerJoin(s.sequences, eq(s.sequences.id, s.userSequences.sequenceId))
      .where(eq(s.userSequences.financialYearId, source.id));
    for (const m of mine) {
      let sequenceId = m.seq.id;
      if (m.seq.isNumberResetNextYear) {
        sequenceId = fresh.get(m.seq.channel) ?? (await tx.insert(s.sequences).values({ channel: m.seq.channel, financialYearId: fy!.id, isNumberResetNextYear: true }).returning({ id: s.sequences.id }))[0]!.id;
        fresh.set(m.seq.channel, sequenceId);
      }
      await tx.insert(s.userSequences).values({ userId: m.userId, sequenceId, financialYearId: fy!.id });
    }
  }
  await ensureEuroChart(tx, year);
  return fy!;
}

/** A EUR year needs the EUR chart; seed it from the template when empty. */
export async function ensureEuroChart(tx: DbOrTx, year: number) {
  if (year < 2026) return;
  if ((await count(tx, sql`SELECT count(*)::int AS n FROM accounts WHERE is_euro AND number <> '0'`)) > 0) return;
  const type = await chartTemplateType(tx);
  if (type) await applyChartTemplate(tx, type, true);
}

/**
 * DeleteFinancialYear (the earliest year): its template-schedule and
 * reschedule periods become unprocessed, reschedules that only cover the
 * year go, the numbering of the year is dropped (series still used by later
 * years move to `nextYearId`), then the year with its entries and openings.
 */
export async function deleteFinancialYear(tx: DbOrTx, fy: { id: number; year: number }, nextYearId: number | null) {
  const from = `${fy.year}-01-01`;
  const to = `${fy.year}-12-31`;
  await exec(tx, sql`UPDATE accounting_template_schedules SET accounting_id = NULL, is_processed = false WHERE date BETWEEN ${from} AND ${to}`);
  await exec(tx, sql`UPDATE accounting_reschedule_details SET accounting_id = NULL, is_processed = false WHERE month BETWEEN ${from} AND ${to}`);
  await exec(tx, sql`
    DELETE FROM accounting_reschedules r
    WHERE r.from_date <= ${to} AND r.to_date >= ${from}
      AND NOT EXISTS (SELECT 1 FROM accounting_reschedule_details d WHERE d.reschedule_id = r.id AND (d.month < ${from} OR d.month > ${to}))`);
  await exec(tx, sql`DELETE FROM user_sequences WHERE financial_year_id = ${fy.id}`);
  if (nextYearId) {
    await exec(tx, sql`
      UPDATE sequences SET financial_year_id = ${nextYearId}
      WHERE financial_year_id = ${fy.id}
        AND (EXISTS (SELECT 1 FROM accountings a WHERE a.sequence_id = sequences.id AND a.financial_year_id <> ${fy.id})
          OR EXISTS (SELECT 1 FROM user_sequences u WHERE u.sequence_id = sequences.id))`);
  }
  await tx.delete(s.financialYears).where(eq(s.financialYears.id, fy.id));
}

/**
 * Login (OpenLoginWindow, 06 4.1): the user's year, or the default one when
 * none is stored; 2026 without the euro chart falls back to 2025.
 */
export async function applyLoginYear(db: DbOrTx, userId: number, today: string) {
  const years = (await db.select({ year: s.financialYears.year }).from(s.financialYears)).map((y) => y.year);
  const stored = Number(await getConfig(db, 'ActiveFinancialYear', userId)) || null;
  const year = stored && years.includes(stored) ? stored : defaultActiveYear(years, today);
  if (year == null) return null;
  const chosen = year === 2026 ? loginActiveYear(year, await euroChartInitialised(db), years) : year;
  if (chosen !== year) await setConfig(db, 'ActiveFinancialYear', String(chosen), userId);
  return chosen;
}
