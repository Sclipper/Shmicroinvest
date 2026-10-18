import { and, asc, eq, sql } from 'drizzle-orm';
import {
  DECLARATION_CELLS, deklarLine, diaryTotals, fmtMessage, hasViesData, indexAccountings, isValidEgn, napFileBytes, napLineToString, napPurchaseLines,
  napSaleLines, purchaseDiary, saleDiary, VAT_MESSAGES, vatDeclaration, viesFileLines, viesPart1, viesPart2, viesTotals, zipStore,
  type DiaryRow, type ValidationMessage, type VatAccounting,
} from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import { queryRows, type DbOrTx } from '../../db/provider.ts';
import { ApiError } from '../../lib/errors.ts';
import { getConfig, setConfig } from '../config.ts';
import { loadVatAccountings } from './load.ts';

/**
 * "ДДС дневници, декларация и VIES" (UI_Reporting_VATDiary, spec 05 7,
 * 04a 1): the diaries, the VAT return, VIES and the four NAP files.
 */

export interface VatReportParams {
  from: string;
  to: string;
  kl33?: string;
  kl70?: string;
  kl71?: string;
  kl80?: string;
  kl81?: string;
  kl82?: string;
  autoFillCell71?: boolean;
  sortByEntry?: boolean;
  createVies?: boolean;
  subscriberName?: string;
  subscriberEgn?: string;
  /** 1 = Представляващ, 2 = Пълномощник. */
  subscriberRole?: number;
}

/** The screen's end is 23:59:59 of the last day: strict for sales, inclusive for purchases. */
const diaryOptions = (p: VatReportParams) => ({ start: p.from, end: `${p.to} 23:59:59`, sortByEntry: p.sortByEntry });

async function load(db: DbOrTx, p: { from: string; to: string }) {
  // Protocols may take their period from an accounting of an earlier export month; widen the window by a year.
  const from = `${Number(p.from.slice(0, 4)) - 1}${p.from.slice(4)}`;
  return loadVatAccountings(db, { from, to: p.to });
}

function serializeRow(r: DiaryRow) {
  return { ...r, cols: r.cols.map((c) => c.toFixed(2)) };
}

export async function myCompanyInfo(db: DbOrTx) {
  const [m] = await db.select().from(s.myCompany).limit(1);
  const [addr] = await db.select().from(s.addresses).where(and(eq(s.addresses.ownerType, 'my'), eq(s.addresses.ownerId, m!.id))).orderBy(asc(s.addresses.id)).limit(1);
  return { company: m!, address: addr ?? null };
}

/** Defaults of the options screen (04a 1.2). */
export async function vatReportDefaults(db: DbOrTx, workingDate: string) {
  const { company } = await myCompanyInfo(db);
  const y = Number(workingDate.slice(0, 4));
  const m = Number(workingDate.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const kl33 = Number(await getConfig(db, 'Coefficient73'));
  return {
    from: `${py}-${String(pm).padStart(2, '0')}-01`,
    to: `${py}-${String(pm).padStart(2, '0')}-${last}`,
    kl33: Number.isFinite(kl33) ? kl33.toFixed(2) : '0.00',
    subscriberName: company.vatDeclarationSubscriberName ?? '',
    subscriberEgn: company.vatDeclarationSubscriberEgn ?? '',
    subscriberRole: company.vatDeclarationSubscriberRole ?? 1,
    companyName: company.name,
    vatId: company.vatId ?? '',
  };
}

/** CheckForMissingTerms (04a 1.3): purchase/sale entries without Основание block the report. */
export async function missingTermsMessage(db: DbOrTx): Promise<string | null> {
  const rows = await queryRows<{ year: number; number: string }>(db, sql`
    SELECT fy.year, a.number FROM accountings a JOIN financial_years fy ON fy.id = a.financial_year_id
    WHERE NOT a.is_initial_balance AND a.transaction_type_id IN (2, 3) AND a.term_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM accounting_extended_details e WHERE e.accounting_id = a.id)
    ORDER BY fy.year, a.number`);
  if (!rows.length) return null;
  const byYear = new Map<number, string[]>();
  for (const r of rows) byYear.set(r.year, [...(byYear.get(r.year) ?? []), r.number]);
  const list = [...byYear].map(([y, ns]) => `${y}г. - ${ns.join(', ')}`).join('; ');
  return fmtMessage('strAccountingsWithMissingTermsMessage', list);
}

/** Company checks for the declaration (02b 12): VAT number, declarant name, EGN, position. */
export async function companyVatMessages(db: DbOrTx, p: VatReportParams): Promise<ValidationMessage[]> {
  const { company } = await myCompanyInfo(db);
  const out: ValidationMessage[] = [];
  if (company.isVat && !company.vatId) out.push({ key: 'strMyCompanyVatNumberIsEmpty', text: VAT_MESSAGES.strMyCompanyVatNumberIsEmpty, severity: 'critical' });
  const name = p.subscriberName ?? company.vatDeclarationSubscriberName ?? '';
  const egn = p.subscriberEgn ?? company.vatDeclarationSubscriberEgn ?? '';
  if (!name.trim()) out.push({ key: 'strMyCompanyVATSubscriberNameIsEmpty', text: VAT_MESSAGES.strMyCompanyVATSubscriberNameIsEmpty, severity: 'warning' });
  if (!isValidEgn(egn)) out.push({ key: 'strMyCompanyVATSubscriberEGNIsInvalid', text: VAT_MESSAGES.strMyCompanyVATSubscriberEGNIsInvalid, severity: 'warning' });
  if (!company.vatDeclarationSubscriberPosition?.trim()) out.push({ key: 'strMyCompanyVATSubscriberPositionIsEmpty', text: VAT_MESSAGES.strMyCompanyVATSubscriberPositionIsEmpty, severity: 'warning' });
  return out;
}

export async function vatDiaries(db: DbOrTx, p: VatReportParams, list?: VatAccounting[]) {
  const accs = list ?? (await load(db, p));
  const ix = indexAccountings(accs);
  const o = { ...diaryOptions(p), addCashDocs: true };
  const sales = saleDiary(accs, o, ix);
  const purchases = purchaseDiary(accs, o, ix);
  return {
    sales: sales.map(serializeRow),
    purchases: purchases.map(serializeRow),
    salesTotals: diaryTotals(sales, 17).map((c) => c.toFixed(2)),
    purchasesTotals: diaryTotals(purchases, 7).map((c) => c.toFixed(2)),
  };
}

export async function vatDeclarationReport(db: DbOrTx, p: VatReportParams, list?: VatAccounting[]) {
  const accs = list ?? (await load(db, p));
  const { cells } = vatDeclaration(accs, diaryOptions(p), {
    kl33: p.kl33 || 0, kl70: p.kl70 || 0, kl71: p.kl71 || 0, kl80: p.kl80 || 0, kl81: p.kl81 || 0, kl82: p.kl82 || 0, autoFillCell71: p.autoFillCell71,
  });
  return Object.fromEntries(DECLARATION_CELLS.map((c) => [c, cells[c].toString()])) as Record<string, string>;
}

export async function viesReport(db: DbOrTx, p: { from: string; to: string }, list?: VatAccounting[]) {
  const accs = list ?? (await load(db, p));
  const part1 = viesPart1(accs, { start: p.from, end: p.to });
  const t = viesTotals(part1);
  return {
    part1: part1.map((r) => ({ ...r, k3: r.k3.toFixed(2), k4: r.k4.toFixed(2), k5: r.k5.toFixed(2) })),
    part2: viesPart2(accs, { start: p.from, end: p.to }),
    totals: { '01': t['01'].toFixed(2), '17': t['17'].toFixed(2), '02': t['02'] },
  };
}

/** Full run of the screen ("Всички"): declaration, diaries, VIES; persists KL33 as Coefficient73. */
export async function vatReport(db: DbOrTx, p: VatReportParams) {
  const missing = await missingTermsMessage(db);
  if (missing) throw new ApiError(422, missing, [{ key: 'strAccountingsWithMissingTermsMessage', text: missing, severity: 'critical' }]);
  const accs = await load(db, p);
  await setConfig(db, 'Coefficient73', String(Number(p.kl33 || 0)));
  const viesData = hasViesData(accs, { start: p.from, end: p.to });
  return {
    declaration: await vatDeclarationReport(db, p, accs),
    ...(await vatDiaries(db, p, accs)),
    vies: await viesReport(db, p, accs),
    hasViesData: viesData,
    info: !p.createVies && viesData ? VAT_MESSAGES.strHasViesDataMessage : null,
    messages: await companyVatMessages(db, p),
  };
}

export const NAP_FILES = ['POKUPKI.TXT', 'PRODAGBI.TXT', 'DEKLAR.TXT', 'VIES.TXT'] as const;
export type NapFileName = (typeof NAP_FILES)[number];

/** Generates the NAP files (NAPExportFiles); VIES.TXT only with createVies. */
export async function napFiles(db: DbOrTx, p: VatReportParams): Promise<{ folder: string; files: { name: NapFileName; data: Uint8Array; lines: string[] }[] }> {
  const missing = await missingTermsMessage(db);
  if (missing) throw new ApiError(422, missing, [{ key: 'strAccountingsWithMissingTermsMessage', text: missing, severity: 'critical' }]);
  const accs = await load(db, p);
  const { company, address } = await myCompanyInfo(db);
  await setConfig(db, 'Coefficient73', String(Number(p.kl33 || 0)));
  const ix = indexAccountings(accs);
  const o = { start: p.from, end: p.to, ownVatId: company.vatId ?? '' };
  const purchaseLines = napPurchaseLines(accs, o, ix);
  const saleLines = napSaleLines(accs, o, ix);
  const subscriberName = p.subscriberName ?? company.vatDeclarationSubscriberName ?? '';
  const subscriberEgn = p.subscriberEgn ?? company.vatDeclarationSubscriberEgn ?? '';
  const role = p.subscriberRole ?? company.vatDeclarationSubscriberRole ?? 1;
  const pLines = purchaseLines.map(napLineToString);
  const sLines = saleLines.map(napLineToString);
  const dLines = [deklarLine({
    ownVatId: company.vatId ?? '', companyName: company.name, periodEnd: p.to, subscriberEgn, subscriberName,
    saleLines, purchaseLines, kl33: p.kl33 || 0, kl70: p.kl70 || 0, kl71: p.kl71 || 0, kl80: p.kl80 || 0, kl81: p.kl81 || 0, kl82: p.kl82 || 0,
    autoFillCell71: p.autoFillCell71,
  })];
  const files: { name: NapFileName; data: Uint8Array; lines: string[] }[] = [
    { name: 'POKUPKI.TXT', lines: pLines, data: napFileBytes(pLines) },
    { name: 'PRODAGBI.TXT', lines: sLines, data: napFileBytes(sLines) },
    { name: 'DEKLAR.TXT', lines: dLines, data: napFileBytes(dLines) },
  ];
  if (p.createVies) {
    let vLines: string[];
    try {
      vLines = viesFileLines(accs, { start: p.from, end: p.to }, {
        periodEnd: p.to, ownVatId: company.vatId ?? '', companyName: company.name, companyAddress: address?.address ?? '',
        subscriber: { egn: subscriberEgn, name: subscriberName, city: address?.city ?? '', postalCode: address?.postalCode ?? '', address: address?.address ?? '', isProcurator: role === 2 },
      });
    } catch (e) {
      throw new ApiError(422, `${VAT_MESSAGES.strVatDiaryGenerateFilesReportError} ${(e as Error).message}`);
    }
    files.push({ name: 'VIES.TXT', lines: vLines, data: napFileBytes(vLines) });
  }
  return { folder: `${p.to.slice(5, 7)}.${p.to.slice(0, 4)}`, files };
}

export async function napZip(db: DbOrTx, p: VatReportParams) {
  const { folder, files } = await napFiles(db, p);
  return { folder, data: zipStore(files.map((f) => ({ name: `${folder}/${f.name}`, data: f.data }))) };
}
