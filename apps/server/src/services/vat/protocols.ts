import { asc, eq, inArray, sql } from 'drizzle-orm';
import {
  BGN_PER_EUR, CHANNEL, dec, EURO_CHANGEOVER_DATE, hasCritical, ICA_TYPE, isLeaf, isMonthLocked, protocolBase, protocolTemplate, protocolVat,
  VAT_DIARY_CODES, VAT_DOC, VAT_MESSAGES, validateProtocol, type ValidationMessage,
} from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import { queryRows, type DbOrTx } from '../../db/provider.ts';
import type { ActiveYear } from '../../context.ts';
import { ApiError, notFound } from '../../lib/errors.ts';
import { logActivity } from '../audit.ts';
import { peekNextNumber, reserveNumber } from '../sequences.ts';
import { vatAccountsForYear } from './load.ts';

/**
 * Protocols under art. 117 ZDDS (ICAViewModel, spec 02b 7 and 19). The
 * protocol is a second accounting with the main accounting's number and
 * financial year, document type 13 (ПЗДДС), linked by IcaAccountingID.
 */

async function termId(db: DbOrTx, text: string) {
  const t = text.trim();
  if (!t) return null;
  const [found] = await db.select({ id: s.terms.id }).from(s.terms).where(eq(s.terms.description, t)).limit(1);
  if (found) return found.id;
  const [row] = await db.insert(s.terms).values({ description: t.slice(0, 255) }).returning({ id: s.terms.id });
  return row!.id;
}

async function mainAccounting(db: DbOrTx, id: number) {
  const [a] = await db.select().from(s.accountings).where(eq(s.accountings.id, id));
  if (!a) throw notFound('Контирането');
  const doc = a.documentId ? (await db.select().from(s.documents).where(eq(s.documents.id, a.documentId)))[0] : undefined;
  const details = await db.select().from(s.accountingDetails).where(eq(s.accountingDetails.accountingId, id)).orderBy(asc(s.accountingDetails.position));
  return { a, doc, details };
}

async function protocolRow(db: DbOrTx, main: typeof s.accountings.$inferSelect) {
  if (!main.icaAccountingId) return null;
  const [p] = await db.select().from(s.accountings).where(eq(s.accountings.id, main.icaAccountingId));
  return p ?? null;
}

/** Current protocol of an accounting in dialog shape (or null). */
export async function getProtocol(db: DbOrTx, mainId: number) {
  const { a } = await mainAccounting(db, mainId);
  const p = await protocolRow(db, a);
  if (!p) return null;
  const doc = p.documentId ? (await db.select().from(s.documents).where(eq(s.documents.id, p.documentId)))[0] : undefined;
  const details = await db.select().from(s.accountingDetails).where(eq(s.accountingDetails.accountingId, p.id)).orderBy(asc(s.accountingDetails.position));
  const base = await db.select().from(s.vatBaseLines).where(eq(s.vatBaseLines.accountingId, p.id)).orderBy(asc(s.vatBaseLines.id));
  const codes = await db.select().from(s.accountingExtendedDetails).where(eq(s.accountingExtendedDetails.accountingId, p.id));
  const term = p.termId ? (await db.select().from(s.terms).where(eq(s.terms.id, p.termId)))[0]?.description ?? '' : '';
  const debit = details.find((d) => d.sign === 1);
  const vat = debit?.amount ?? '0';
  const b = base.find((l) => l.sign === 1)?.amount ?? '0';
  const purchaseTermId = debit?.vatTermId ?? base.find((l) => l.sign === 1)?.vatTermId ?? null;
  const vatAccs = await vatAccountsForYear(db, Number(p.accountingDate.slice(0, 4)));
  const expenseAccountId = debit && debit.accountId !== vatAccs.purchases?.id ? debit.accountId : null;
  return {
    id: p.id, icaType: p.icaType, documentNumber: doc?.number ?? '', documentDate: doc?.date ?? p.date, viesMonth: p.viesMonth,
    term, purchaseTermId, base: dec(b).toFixed(2), vat: dec(vat).toFixed(2), expenseAccountId, vatDiaryCode: codes[0]?.vatDiaryCode ?? null,
  };
}

/** Defaults of the protocol dialog for a type (Type-setter, 02b 7.3). */
export async function protocolDefaults(db: DbOrTx, mainId: number, icaType: number, purchaseTermId: number | null, financialYearId: number) {
  const { a, doc, details } = await mainAccounting(db, mainId);
  const t = protocolTemplate(icaType, icaType === ICA_TYPE.BreadFlourAcquisition ? 3 : purchaseTermId);
  const vatAccs = await vatAccountsForYear(db, Number(a.accountingDate.slice(0, 4)));
  const vatIds = new Set([vatAccs.purchases?.id, vatAccs.sales?.id].filter((x): x is number => x != null));
  const base = protocolBase(icaType, details.filter((d) => d.sign === 1).map((d) => ({ amount: d.amount, isVat: vatIds.has(d.accountId) })));
  const vat = icaType === ICA_TYPE.BreadFlourAcquisition ? dec(0) : protocolVat(base);
  return {
    icaType, purchaseTermId: t.purchaseTermId, saleTermId: t.saleTermId, userTerm: t.userTerm,
    vatPair: t.vatPair, basePair: t.basePair, codes: t.codes, vatDiaryCode: t.defaultCode,
    codeTexts: VAT_DIARY_CODES.filter((c) => t.codes.includes(c.code)),
    term: t.defaultTerm, base: base.toFixed(2), vat: vat.toFixed(2),
    documentNumber: await peekNextNumber(db, CHANNEL.VatProtocol, financialYearId),
    documentDate: doc?.date ?? a.date, viesMonth: a.viesMonth,
  };
}

export interface ProtocolInput {
  icaType: number;
  purchaseTermId: number | null;
  documentNumber: string;
  documentDate: string;
  viesMonth: string;
  term?: string;
  base: string;
  vat: string;
  expenseAccountId?: number | null;
  vatDiaryCode?: string | null;
  force?: boolean;
}

/** Save (create or replace) the protocol of an accounting. 409 `confirm` for strIncorrectViesOperation unless `force`. */
export async function saveProtocol(db: DbOrTx, mainId: number, input: ProtocolInput, ctx: { year: ActiveYear; userId: number }) {
  const { a, details } = await mainAccounting(db, mainId);
  if (a.financialYearId !== ctx.year.id) throw new ApiError(422, VAT_MESSAGES.strWrongAccountingDate);
  if (ctx.year.isLocked || isMonthLocked(ctx.year.lockedMonths, Number(a.accountingDate.slice(5, 7)))) {
    throw new ApiError(422, VAT_MESSAGES.strWrongAccountingMonth, [{ key: 'strWrongAccountingMonth', text: VAT_MESSAGES.strWrongAccountingMonth, severity: 'critical' }]);
  }
  const t = protocolTemplate(input.icaType, input.purchaseTermId);
  let expense: { id: number; isLeaf: boolean } | null = null;
  if (input.expenseAccountId) {
    const [acc] = await db.select().from(s.accounts).where(eq(s.accounts.id, input.expenseAccountId));
    if (acc) expense = { id: acc.id, isLeaf: isLeaf({ left: acc.leftIndex, right: acc.rightIndex }) };
  }
  const check = validateProtocol({
    icaType: input.icaType, purchaseTermId: input.purchaseTermId, documentNumber: input.documentNumber, base: input.base, vat: input.vat,
    expenseAccount: expense, vatDiaryCode: input.vatDiaryCode ?? t.defaultCode, mainViesId: a.viesId,
  });
  const messages: ValidationMessage[] = [...check.messages];
  const vatAccs = await vatAccountsForYear(db, ctx.year.year);
  if (t.vatPair && !vatAccs.purchases) messages.push({ key: 'strVatPurchasesAccountNotDefined', text: VAT_MESSAGES.strVatPurchasesAccountNotDefined, severity: 'critical' });
  if (t.vatPair && !vatAccs.sales) messages.push({ key: 'strVatSalesAccountNotDefined', text: VAT_MESSAGES.strVatSalesAccountNotDefined, severity: 'critical' });
  if (hasCritical(messages)) throw new ApiError(422, messages.find((m) => m.severity === 'critical')!.text, messages);
  if (check.confirm.length && !input.force) throw new ApiError(409, check.confirm[0]!.text, check.confirm, 'confirm');

  const old = await protocolRow(db, a);
  if (old) await db.delete(s.accountings).where(eq(s.accountings.id, old.id));

  // Document number: reserve from channel 7 when the user kept the proposed number.
  let number = input.documentNumber.trim();
  const proposed = await peekNextNumber(db, CHANNEL.VatProtocol, ctx.year.id);
  if (number && number === proposed) {
    number = (await reserveNumber(db, CHANNEL.VatProtocol, ctx.year.id, async (n) => {
      const rows = await queryRows<{ id: number }>(db, sql`SELECT id FROM documents WHERE document_type_id = ${VAT_DOC.VatProtocol} AND number = ${n} LIMIT 1`);
      return rows.length > 0;
    })).number;
  }
  const [doc] = await db.insert(s.documents).values({ number, date: input.documentDate, documentTypeId: VAT_DOC.VatProtocol }).returning({ id: s.documents.id });
  const partnerId = details.find((d) => d.companyId)?.companyId ?? null;
  const [p] = await db.insert(s.accountings).values({
    financialYearId: a.financialYearId, number: a.number, date: input.documentDate, accountingDate: a.accountingDate, viesMonth: input.viesMonth,
    documentId: doc!.id, termId: await termId(db, input.term || t.defaultTerm), transactionTypeId: t.transactionTypeId,
    viesId: 1, branchId: a.branchId, userId: ctx.userId, icaType: input.icaType, source: 'vat-protocol',
  }).returning({ id: s.accountings.id });
  const pid = p!.id;
  const V = dec(input.vat);
  const B = dec(input.base);
  if (t.vatPair) {
    const debitAcc = t.purchaseTermId === 3 && expense ? expense.id : vatAccs.purchases!.id;
    const creditAcc = vatAccs.sales!.id;
    await db.insert(s.accountingDetails).values([
      { accountingId: pid, accountId: debitAcc, refAccountId: creditAcc, companyId: partnerId, vatTermId: t.purchaseTermId, amount: V.toFixed(2), refAmount: '0.00', sign: 1, position: 0 },
      { accountingId: pid, accountId: creditAcc, refAccountId: debitAcc, companyId: partnerId, vatTermId: t.saleTermId, amount: '0.00', refAmount: V.toFixed(2), sign: -1, position: 1 },
    ]);
  }
  if (t.basePair) {
    await db.insert(s.vatBaseLines).values([
      { accountingId: pid, sign: 1, vatTermId: t.purchaseTermId, amount: B.toFixed(2), refAmount: '0.00', companyId: partnerId },
      { accountingId: pid, sign: -1, vatTermId: t.saleTermId, amount: '0.00', refAmount: B.toFixed(2), companyId: partnerId },
    ]);
  }
  const code = input.vatDiaryCode ?? t.defaultCode;
  if (code) await db.insert(s.accountingExtendedDetails).values({ accountingId: pid, vatDiaryCode: code });
  await db.update(s.accountings).set({ icaAccountingId: pid }).where(eq(s.accountings.id, a.id));
  await logActivity(db, ctx.userId, old ? 'edit' : 'add', 'accounting', pid, `Протокол по ЗДДС ${number} към контиране ${a.number}`);
  return { id: pid, documentNumber: number, warnings: messages.filter((m) => m.severity === 'warning') };
}

export async function deleteProtocol(db: DbOrTx, mainId: number, ctx: { year: ActiveYear; userId: number }) {
  const { a } = await mainAccounting(db, mainId);
  const p = await protocolRow(db, a);
  if (!p) throw notFound('Протоколът');
  if (ctx.year.isLocked || isMonthLocked(ctx.year.lockedMonths, Number(p.accountingDate.slice(5, 7)))) throw new ApiError(422, VAT_MESSAGES.strWrongAccountingMonth);
  await db.update(s.accountings).set({ icaAccountingId: null }).where(eq(s.accountings.id, a.id));
  await db.delete(s.accountings).where(eq(s.accountings.id, p.id));
  await logActivity(db, ctx.userId, 'delete', 'accounting', p.id, `Протокол по ЗДДС към контиране ${a.number}`);
}

// ---------------------------------------------------------------------------
// "Протоколи по чл. 117 от ЗДДС" (spICAReport, spec 05 7.6)

export interface IcaReportFilter {
  from: string;
  to: string;
  companyIds?: number[];
  documentTypeId?: number | null;
  documentNumber?: string;
  icaType?: number;
}

const ICA_NAMES: Record<number, string> = {
  1: 'ВОП', 2: 'Получена услуга от ЕС', 3: 'Туристически услуги/стоки втора употреба', 4: 'Доставка по чл. 163а от ЗДДС', 5: 'Внос по чл. 167а от ЗДДС',
  6: 'Режим складиране на стоки до поискване', 7: 'Получена услуга от трета страна', 8: 'ВОП - хляб и брашно', 9: 'Доставка/внос на хляб и брашно',
};

export async function icaReport(db: DbOrTx, f: IcaReportFilter) {
  const convertProtocol = f.to >= EURO_CHANGEOVER_DATE;
  const rate = BGN_PER_EUR.toString();
  const protocols = await queryRows<{
    id: number; financial_year_id: number; number: string; accounting_date: string; doc_number: string; doc_date: string; ica_type: number;
    amount: string; term: string | null; reference: string | null;
  }>(db, sql`
    SELECT a.id, a.financial_year_id, a.number, a.accounting_date::text AS accounting_date, d.number AS doc_number, d.date::text AS doc_date, a.ica_type,
      MAX(CASE WHEN ad.amount <> 0 THEN ad.amount ELSE ad.ref_amount END)::text AS amount, t.description AS term, r.description AS reference
    FROM accountings a JOIN documents d ON d.id = a.document_id
    LEFT JOIN accounting_details ad ON ad.accounting_id = a.id AND ad.account_id IS NOT NULL AND ad.ref_account_id IS NOT NULL
    LEFT JOIN terms t ON t.id = a.term_id LEFT JOIN reference_texts r ON r.id = a.reference_id
    WHERE d.document_type_id = ${VAT_DOC.VatProtocol} AND NOT a.is_initial_balance AND a.accounting_date BETWEEN ${f.from} AND ${f.to}
      ${f.icaType ? sql`AND a.ica_type = ${f.icaType}` : sql``}
    GROUP BY a.id, d.number, d.date, t.description, r.description ORDER BY a.accounting_date, a.number, a.id`);
  if (!protocols.length) return { rows: [] };
  const pids = protocols.map((p) => p.id);
  const terms = await queryRows<{ accounting_id: number; vat_term_id: number; description: string }>(db, sql`
    SELECT DISTINCT x.accounting_id, x.vat_term_id, vt.description FROM (
      SELECT accounting_id, vat_term_id FROM accounting_details WHERE accounting_id IN (${sql.join(pids.map((i) => sql`${i}`), sql`, `)})
      UNION SELECT accounting_id, vat_term_id FROM vat_base_lines WHERE accounting_id IN (${sql.join(pids.map((i) => sql`${i}`), sql`, `)})
    ) x JOIN vat_terms vt ON vt.id = x.vat_term_id ORDER BY x.vat_term_id`);
  const label = (pid: number, lo: number, hi: number) => terms.filter((t) => t.accounting_id === pid && t.vat_term_id >= lo && t.vat_term_id <= hi).map((t) => `${t.vat_term_id}-${t.description}`).join('; ');

  const companyFilter = f.companyIds?.length
    ? sql`AND EXISTS (SELECT 1 FROM accounting_details x WHERE x.accounting_id = a.id AND x.company_id IN (${sql.join(f.companyIds.map((c) => sql`${c}`), sql`, `)}))`
    : sql``;
  const docs = await queryRows<{
    id: number; financial_year_id: number; number: string; accounting_date: string; doc_date: string; doc_type: string; doc_type_id: number; doc_number: string;
    company: string | null; amount: string; term: string | null; reference: string | null;
  }>(db, sql`
    SELECT a.id, a.financial_year_id, a.number, a.accounting_date::text AS accounting_date, d.date::text AS doc_date, dt.short_name AS doc_type, dt.id AS doc_type_id,
      d.number AS doc_number,
      (SELECT c.name FROM accounting_details x JOIN companies c ON c.id = x.company_id WHERE x.accounting_id = a.id ORDER BY x.position LIMIT 1) AS company,
      SUM(ad.amount / CASE WHEN a.accounting_date < ${EURO_CHANGEOVER_DATE} THEN ${sql.raw(rate)} ELSE 1 END)::text AS amount,
      t.description AS term, r.description AS reference
    FROM accountings a JOIN documents d ON d.id = a.document_id JOIN document_types dt ON dt.id = d.document_type_id
    JOIN accounting_details ad ON ad.accounting_id = a.id AND ad.sign = 1
    LEFT JOIN terms t ON t.id = a.term_id LEFT JOIN reference_texts r ON r.id = a.reference_id
    WHERE dt.id IN (1, 2, 3, 4) AND NOT a.is_initial_balance AND a.accounting_date BETWEEN ${f.from} AND ${f.to}
      AND (a.financial_year_id, a.number) IN (SELECT financial_year_id, number FROM accountings WHERE id IN (${sql.join(pids.map((i) => sql`${i}`), sql`, `)}))
      ${f.documentTypeId ? sql`AND dt.id = ${f.documentTypeId}` : sql``} ${companyFilter}
    GROUP BY a.id, d.date, dt.short_name, dt.id, d.number, t.description, r.description ORDER BY a.accounting_date, a.number, a.id`);
  const rows = [];
  for (const d of docs) {
    const p = protocols.find((x) => x.financial_year_id === d.financial_year_id && x.number === d.number);
    if (!p) continue;
    if (f.documentNumber && !d.doc_number.includes(f.documentNumber) && !p.doc_number.includes(f.documentNumber)) continue;
    const pAmount = dec(p.amount ?? 0);
    rows.push({
      accountingId: d.id, protocolAccountingId: p.id, accountingNumber: d.number, documentDate: d.doc_date, documentType: d.doc_type, documentNumber: d.doc_number,
      companyName: d.company ?? '', amount: dec(d.amount).toString(), term: d.term ?? '', reference: d.reference ?? '',
      icaDate: p.doc_date, icaNumber: p.doc_number,
      icaAmount: (convertProtocol && p.accounting_date < EURO_CHANGEOVER_DATE ? pAmount.div(BGN_PER_EUR) : pAmount).toString(),
      icaTermDesc: p.term ?? '', icaRefDesc: p.reference ?? '', purchaseVat: label(p.id, 2, 6), saleVat: label(p.id, 7, 18),
      icaType: ICA_NAMES[p.ica_type] ?? '',
    });
  }
  return { rows };
}

/** Print data of a protocol (VOPProtocol.rpt): main entry, protocol header, VAT and base. */
export async function protocolPrint(db: DbOrTx, mainId: number) {
  const { a, doc, details } = await mainAccounting(db, mainId);
  const p = await getProtocol(db, mainId);
  if (!p) throw notFound('Протоколът');
  const partnerId = details.find((d) => d.companyId)?.companyId;
  const [partner] = partnerId ? await db.select().from(s.companies).where(eq(s.companies.id, partnerId)) : [];
  const [my] = await db.select().from(s.myCompany).limit(1);
  const terms = await db.select().from(s.vatTerms).where(inArray(s.vatTerms.id, [p.purchaseTermId ?? 0, protocolTemplate(p.icaType, p.purchaseTermId).saleTermId]));
  return {
    company: { name: my?.name ?? '', vatId: my?.vatId ?? '', bulstat: my?.bulstat ?? '' },
    partner: partner ? { name: partner.name, vatNumber: partner.vatNumber ?? '', bulstat: partner.bulstat ?? '' } : null,
    main: { number: a.number, documentNumber: doc?.number ?? '', documentDate: doc?.date ?? a.date, accountingDate: a.accountingDate },
    protocol: { ...p, typeName: ICA_NAMES[p.icaType] ?? '', total: dec(p.base).plus(p.vat).toFixed(2) },
    terms: terms.map((t) => ({ id: t.id, description: t.description })),
  };
}
