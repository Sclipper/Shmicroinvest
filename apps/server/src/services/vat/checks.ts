import { sql } from 'drizzle-orm';
import {
  compareWithNapFile, decodeCp1251, findDuplicateDocuments, findMissingDocuments, indexAccountings, napPurchaseLines, napSaleLines, parseDiaryFile,
  parseNapLine, ZERO, type Dec, type DocCheckItem, type NapCheckRow, type NapLine, type ParsedNapLine,
} from '@shmi/core';
import { queryRows, type DbOrTx } from '../../db/provider.ts';
import type { ActiveYear } from '../../context.ts';
import { ApiError } from '../../lib/errors.ts';
import { importDocuments, resolveImportAccounts, type ImportAccounts } from './import.ts';
import { loadVatAccountings } from './load.ts';
import { myCompanyInfo } from './reports.ts';

/**
 * Period checks (spec 04a 1.12, 05 7.7): "Дублирани и липсващи документи"
 * (UI_Reporting_Validation_AccountingsValidation) and "Проверка на документи
 * с файл от НАП" (UI_Reporting_Validation_AccountingsNAPFileValidation).
 */

/** Report type: 0 = all, 1 = duplicated, 2 = missing. */
export async function documentValidation(db: DbOrTx, p: { from: string; to: string; reportType?: number; channel?: string }) {
  const rows = await queryRows<{
    id: number; number: string; document_type_id: number; type_name: string; doc_number: string; doc_date: string; transaction_type_id: number;
    partner_id: number | null; partner_name: string | null; amount: string; ica_type: number; has_base: boolean;
  }>(db, sql`
    SELECT a.id, a.number, d.document_type_id, dt.name AS type_name, d.number AS doc_number, d.date::text AS doc_date, a.transaction_type_id,
      (SELECT x.company_id FROM accounting_details x WHERE x.accounting_id = a.id AND x.company_id IS NOT NULL ORDER BY x.position LIMIT 1) AS partner_id,
      (SELECT c.name FROM accounting_details x JOIN companies c ON c.id = x.company_id WHERE x.accounting_id = a.id ORDER BY x.position LIMIT 1) AS partner_name,
      coalesce((SELECT SUM(x.amount) FROM accounting_details x WHERE x.accounting_id = a.id AND x.sign = 1), 0)::text AS amount,
      a.ica_type, EXISTS (SELECT 1 FROM vat_base_lines v WHERE v.accounting_id = a.id) AS has_base
    FROM accountings a JOIN documents d ON d.id = a.document_id JOIN document_types dt ON dt.id = d.document_type_id
    WHERE NOT a.is_initial_balance AND NOT a.is_initial_correspondence AND a.accounting_date BETWEEN ${p.from} AND ${p.to}
    ORDER BY a.accounting_date, a.id`);
  const { company } = await myCompanyInfo(db);
  const items: DocCheckItem[] = rows.map((r) => ({
    accountingId: r.id, accountingNumber: r.number, documentTypeId: r.document_type_id, documentTypeName: r.type_name, documentNumber: r.doc_number,
    documentDate: r.doc_date, transactionTypeId: r.transaction_type_id, partnerId: r.partner_id, partnerName: r.partner_name ?? '', amount: r.amount, icaType: r.ica_type,
  }));
  const type = p.reportType ?? 0;
  const keep = (ch: string) => !p.channel || p.channel === ch;
  const missing = type === 1 ? [] : findMissingDocuments(items).filter((m) => keep(m.channel));
  const duplicated = type === 2 ? [] : findDuplicateDocuments(items, { companyIsVat: company.isVat }).filter((g) => keep(g.channel)).map((g) => ({
    channel: g.channel, documentNumber: g.documentNumber,
    rows: g.rows.map((r) => ({ ...r, amount: String(r.amount), transactionType: r.transactionTypeId === 2 ? 'Покупка' : r.transactionTypeId === 3 ? 'Продажба' : 'Неопределена' })),
  }));
  return { missing, duplicated };
}

// ---------------------------------------------------------------------------
// NAP-file check

const sumCols = (c: Dec[], idx: number[]) => idx.reduce((a, i) => a.plus(c[i] ?? ZERO), ZERO);
/** Purchase base P9+P10+P12+P15, VAT P11+P13; sales base S9, VAT S10. */
const amounts = (kind: 'purchase' | 'sale', c: Dec[]) =>
  kind === 'purchase' ? { base: sumCols(c, [0, 1, 3, 6]), vat: sumCols(c, [2, 4]) } : { base: c[0] ?? ZERO, vat: c[1] ?? ZERO };

const toRow = (kind: 'purchase' | 'sale', l: ParsedNapLine | NapLine, source?: string): NapCheckRow => {
  const a = amounts(kind, l.cols);
  return { partnerId: l.partnerVat, partnerName: l.partnerName, documentCode: l.documentCode, documentNumber: l.documentNumber, documentDate: l.documentDate.slice(0, 10), base: a.base.toFixed(2), vat: a.vat.toFixed(2), source };
};

function parseFile(bytes: Uint8Array, kind: 'purchase' | 'sale') {
  const lines = decodeCp1251(bytes).split(/\r?\n/).filter((l) => l.trim());
  const out: ParsedNapLine[] = [];
  for (const [i, l] of lines.entries()) {
    const p = parseNapLine(l, kind === 'purchase' ? 7 : 17);
    if (!p) throw new ApiError(422, `Невалиден формат на данните на ред ${i + 1} от файла за импорт.`);
    out.push(p);
  }
  return out;
}

export async function napFileCheck(db: DbOrTx, p: { from: string; to: string; kind: 'purchase' | 'sale'; file: Uint8Array }) {
  const fileLines = parseFile(p.file, p.kind);
  const accs = await loadVatAccountings(db, { from: `${Number(p.from.slice(0, 4)) - 1}${p.from.slice(4)}`, to: p.to });
  const { company } = await myCompanyInfo(db);
  const o = { start: p.from, end: p.to, ownVatId: company.vatId ?? '' };
  const ix = indexAccountings(accs);
  const booked = (p.kind === 'purchase' ? napPurchaseLines(accs, o, ix) : napSaleLines(accs, o, ix)).map((l) => toRow(p.kind, l, p.kind === 'purchase' ? 'Дневник покупки' : 'Дневник продажби'));
  const fileRows = fileLines.map((l) => toRow(p.kind, l));
  const r = compareWithNapFile(fileRows, booked);
  const dates = fileLines.map((l) => l.documentDate).sort();
  return { ...r, fileStartDate: dates[0] ?? null, fileEndDate: dates[dates.length - 1] ?? null };
}

/** "Импорт на липсващите документи": posts the file lines that have no booked counterpart. */
export async function importMissingFromNapFile(db: DbOrTx, ctx: { year: ActiveYear; userId: number; branchId?: number }, p: { from: string; to: string; kind: 'purchase' | 'sale'; file: Uint8Array; accounts?: Partial<ImportAccounts> }) {
  const check = await napFileCheck(db, p);
  const key = (r: { partnerId: string; documentNumber: string; documentDate: string }) => [r.partnerId.trim(), r.documentNumber.trim(), r.documentDate].join('\u0001');
  const wanted = new Set(check.missing.map(key));
  const parsed = parseDiaryFile(decodeCp1251(p.file), p.kind);
  if (parsed.error) throw new ApiError(422, parsed.error);
  const docs = parsed.documents.filter((d) => wanted.has(key({ partnerId: d.line.partnerVat, documentNumber: d.line.documentNumber, documentDate: d.line.documentDate })));
  const acc = await resolveImportAccounts(db, ctx.year.year, p.accounts);
  const res = await importDocuments(db, ctx, docs, acc);
  return { imported: res.created.length, partnersCreated: res.partnersCreated };
}
