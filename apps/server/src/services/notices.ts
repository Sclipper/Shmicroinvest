import { sql } from 'drizzle-orm';
import { turnoverWindow, vatAccountMissingNotice, vatRegistrationNotice, vatRegistrationTurnover, type ShellNotice } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { exec, type DbOrTx } from '../db/provider.ts';
import type { ActiveYear } from '../context.ts';
import { vatCategoryAccounts } from './vat/load.ts';
import { cashAndReceivablesLimitCheck } from './cashReports.ts';

/** Оборот за регистрация по ЗДДС (03a 3.3): the 12 months up to the month of `workingDate`. */
export async function vatRegistrationTurnoverFor(db: DbOrTx, year: number, workingDate: string) {
  const end = workingDate.slice(0, 7);
  const months = turnoverWindow(end);
  const rows = (await exec(db, sql`
    SELECT to_char(a.accounting_date, 'YYYY-MM') AS month,
      sum(CASE WHEN ra.number LIKE '70%' OR ra.number LIKE '412%' THEN d.amount ELSE 0 END)
      - sum(CASE WHEN da.number LIKE '123%' AND ra.number LIKE '70%' THEN d.amount ELSE 0 END) AS amount
    FROM accounting_details d
    JOIN accountings a ON a.id = d.accounting_id
    JOIN accounts da ON da.id = d.account_id
    JOIN accounts ra ON ra.id = d.ref_account_id
    WHERE d.sign = 1 AND NOT a.is_initial_balance
      AND a.accounting_date >= ${`${months[0]}-01`}::date AND a.accounting_date < (${`${end}-01`}::date + interval '1 month')
    GROUP BY 1`)).rows as { month: string; amount: string }[];
  return vatRegistrationTurnover(rows, end, year);
}

/**
 * Start-up notices of the "Съобщения" panel (06 2.1): the missing VAT
 * accounts (strVATAccountMissing, 02b 12), the VAT registration threshold
 * and the cash-and-receivables limit (when the user may see that report).
 */
export async function shellNotices(db: DbOrTx, o: { year: ActiveYear; workingDate: string; userId: number; canSeeCashLimit: boolean }): Promise<ShellNotice[]> {
  const out: ShellNotice[] = [];
  const [my] = await db.select().from(s.myCompany).limit(1);
  const isEuro = o.year.year >= 2026;
  const [{ count }] = (await exec(db, sql`SELECT count(*)::int AS count FROM accounts WHERE is_euro = ${isEuro} AND number <> '0'`)).rows as [{ count: number }];
  // An empty chart is reported by the start page; VAT accounts matter for a VAT-registered company.
  if (count > 0 && my?.isVat) {
    const present = (await vatCategoryAccounts(db)).filter((a) => a.isEuro === isEuro).map((a) => a.categoryId);
    const n = vatAccountMissingNotice(present);
    if (n) out.push(n);
  }
  if (my && !my.isVat && !my.isNotVat) {
    const t = await vatRegistrationTurnoverFor(db, o.year.year, o.workingDate);
    const n = vatRegistrationNotice({ isVat: my.isVat, isNotVat: my.isNotVat, total: t.total, limit: t.limit, currency: t.currency as 'BGN' | 'EUR', exceeded: t.exceeded });
    if (n) out.push(n);
  }
  if (o.canSeeCashLimit) {
    const y = o.year;
    const end = o.workingDate < y.startDate ? y.startDate : o.workingDate > `${y.year}-12-31` ? `${y.year}-12-31` : o.workingDate;
    const c = await cashAndReceivablesLimitCheck(db, { startDate: y.startDate, workingDate: end, userId: o.userId });
    if (c.message) out.push({ key: 'strCashAndReceivablesLimitExceeded', level: 'warning', text: c.message, screen: 'cashAndReceivables', screenLabel: 'Касова наличност и вземания' });
  }
  return out;
}
