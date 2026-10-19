import { eq } from 'drizzle-orm';
import {
  DataImportError, EXCEL_ENTITIES, cellDate, cellDecimal, cellText, columnIndex, comboId, critical, isCompanyCategory, normalizeIban,
  parseCharacter, parseDirection, parseExcelOperationRow, round2, validateExcelMapping, CHANNEL, DOCUMENT_TYPE,
  type ExcelEntity, type ExcelMapping, type ExcelSheet,
} from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import type { DbOrTx } from '../../db/provider.ts';
import { rebuildAccountsTree } from '../chart.ts';
import { saveEntry } from '../journal.ts';
import { reserveNumber } from '../sequences.ts';
import { checkDates, currencyIdsByIso, documentTypesByShortName, findOrCreatePartner, loadChart, throwIf } from './common.ts';
import { excelProductMessages, importProduct } from './products.ts';
import { importChartAccount, type ImportCtx } from './transfer.ts';

export interface ExcelImportResult { entity: ExcelEntity; rows: number; created: number; updated: number }

/** Row iterator over the mapped columns; fully empty rows are skipped. */
function* mappedRows(sheet: ExcelSheet, m: ExcelMapping, keys: string[]) {
  const cols = new Map(keys.filter((k) => m.columns[k]?.trim()).map((k) => [k, columnIndex(m.columns[k]!)!]));
  const last = Math.min(m.endingRow, sheet.rowCount);
  for (let r = Math.max(1, m.startingRow); r <= last; r++) {
    const get = (k: string) => {
      const c = cols.get(k);
      return c ? sheet.cell(r, c) : null;
    };
    if ([...cols.keys()].every((k) => cellText(get(k)) === '')) continue;
    yield { row: r, get };
  }
}

/** Runs one entity import in the given transaction; every error aborts the whole import (single save). */
export async function importExcel(tx: DbOrTx, sheets: ExcelSheet[], entity: ExcelEntity, m: ExcelMapping, ctx: ImportCtx): Promise<ExcelImportResult> {
  const errs = validateExcelMapping(entity, m, sheets.map((x) => x.name));
  throwIf(errs);
  const sheet = sheets.find((x) => x.name === m.sheetName)!;
  const def = EXCEL_ENTITIES[entity];
  const keys = def.columns.filter((c) => !c.ica || m.hasIcaColumns).map((c) => c.key);
  const letter = (k: string) => (m.columns[k] ?? '').trim().toUpperCase();
  const rows = [...mappedRows(sheet, m, keys)];
  if (!rows.length) throw new DataImportError(critical('strImportFileHasNoDataErrorMessage'));
  const cellErr = (row: number, k: string, v: string) => new DataImportError(critical('strInvalidDataFormatInExcelCell', row, letter(k), v));
  let created = 0;
  let updated = 0;
  // Conflict mode (5.2, corrected D7): Error (default) keeps the entity-specific behaviour (partners and
  // products matched and reused, a duplicate account number is an error); Update overwrites the matched
  // partner, account or product. Operations and initial balances are always inserted.
  const update = m.conflictMode === 'update';

  if (entity === 'operations') {
    const chart = await loadChart(tx, ctx.year.year);
    const docType = await documentTypesByShortName(tx);
    const viesIds = new Set((await tx.select({ id: s.vieses.id }).from(s.vieses)).map((v) => v.id));
    const icaTypeIds = new Set((await tx.select({ id: s.icaTypes.id }).from(s.icaTypes)).map((v) => v.id));
    const vatP = chart.byCategory(16);
    const vatS = chart.byCategory(17);
    const drafts = rows.map(({ row, get }) => parseExcelOperationRow(get, letter, row, {
      activeYear: ctx.year.year, account: (n) => chart.byNumber.get(n) ?? null, vatPurchaseAccount: vatP, vatSaleAccount: vatS,
      documentTypeByShortName: docType, viesIds, icaTypeIds, hasIcaColumns: !!m.hasIcaColumns,
      protocolDocumentTypeId: DOCUMENT_TYPE.VatProtocol, invoiceDocumentTypeId: DOCUMENT_TYPE.Invoice ?? 1,
    }));
    throwIf(checkDates(drafts.map((d) => d.accountingDate), ctx.year));
    const cache = new Map<string, number>();
    for (const d of drafts) {
      const partnerAccounts = [...d.debits, ...d.credits].filter((l) => isCompanyCategory(l.account.categoryId)).map((l) => l.account.id);
      const partner = d.partner?.name ? await findOrCreatePartner(tx, {
        name: d.partner.name, bulstat: d.partner.bulstat, vatNumber: d.partner.vatNumber, ibans: d.partner.iban ? [normalizeIban(d.partner.iban)] : [], accountIds: partnerAccounts,
      }, cache) : null;
      const line = (l: (typeof d.debits)[number]) => ({
        accountId: l.account.id, amount: l.amount, vatTermId: l.vatTermId, currencyAmount: l.currencyAmount ?? null, exchangeRate: l.exchangeRate ?? null,
        quantity: l.quantity ?? null, price: l.price ?? null,
      });
      const saved = await saveEntry(tx, {
        accountingDate: d.accountingDate, documentDate: d.documentDate, documentTypeId: d.documentTypeId, documentNumber: d.documentNumber,
        companyId: partner?.id ?? null, term: d.term, reference: d.reference || null, optionalReference: d.optionalReference || null,
        transactionTypeId: d.transactionTypeId, viesId: d.viesId, viesMonth: d.viesMonth, source: 'import-excel',
        debits: d.debits.map(line), credits: d.credits.map(line),
      }, { year: ctx.year, userId: ctx.userId, skipHeaderChecks: true });
      if (d.ica && vatS && d.ica.debitAccount) {
        const ica = d.ica;
        const number = ica.documentNumber ?? (await reserveNumber(tx, CHANNEL.VatProtocol, ctx.year.id, async () => false)).number;
        // A protocol is built even without VAT: call-off stock (type 6, codes 41-58), 163a and the
        // bread/flour types carry no ICAVAT but must reach the VAT diaries (04a 5.3 ICA items 3-7).
        const amount = round2(ica.vatAmount);
        const icaEntry = await saveEntry(tx, {
          accountingDate: ica.accountingDate, documentDate: ica.documentDate, documentTypeId: ica.documentTypeId, documentNumber: number,
          companyId: partner?.id ?? null, term: ica.term, reference: ica.reference || null, transactionTypeId: ica.transactionTypeId, viesMonth: ica.viesMonth,
          icaType: ica.icaType, deliveryDescription: ica.deliveryDescription || null, source: 'import-excel',
          debits: [{ accountId: ica.debitAccount!.id, amount: amount.toFixed(2), vatTermId: ica.vatTermId }],
          credits: [{ accountId: vatS.id, amount: amount.toFixed(2), vatTermId: ica.vatTermId }],
        }, { year: ctx.year, userId: ctx.userId, skipHeaderChecks: true });
        if (ica.vatDiaryCode) await tx.insert(s.accountingExtendedDetails).values({ accountingId: icaEntry.id, vatDiaryCode: ica.vatDiaryCode });
        await tx.update(s.accountings).set({ icaAccountingId: icaEntry.id, icaType: ica.icaType }).where(eq(s.accountings.id, saved.id));
      }
      created++;
    }
    return { entity, rows: rows.length, created, updated };
  }

  if (entity === 'partners') {
    const chart = await loadChart(tx, ctx.year.year);
    for (const { row, get } of rows) {
      const name = cellText(get('CompanyName'), 254);
      if (!name) throw cellErr(row, 'CompanyName', '');
      const accText = cellText(get('CompanyAccounts'));
      const ids = accText.split(';').map((x) => x.trim()).filter(Boolean).map((n) => {
        const a = chart.byNumber.get(n);
        if (!a || !isCompanyCategory(a.categoryId)) throw new DataImportError(critical('strInvalidCompanyAccountCategory', row, letter('CompanyAccounts'), n));
        return a.id;
      });
      const iban = cellText(get('IBAN'), 50);
      const r = await findOrCreatePartner(tx, {
        name, contactName: cellText(get('ContactName'), 254), bulstat: cellText(get('Bulstat'), 50), vatNumber: cellText(get('VATNumber'), 50),
        ibans: iban ? [iban] : [], address: { city: cellText(get('City'), 50), address: cellText(get('Address'), 254), phone: cellText(get('Phone'), 100) }, accountIds: ids,
      }, undefined, { update });
      if (r?.created) created++;
      if (r?.updated) updated++;
    }
    return { entity, rows: rows.length, created, updated };
  }

  if (entity === 'chart') {
    const chart = await loadChart(tx, ctx.year.year);
    for (const { row, get } of rows) {
      const number = cellText(get('Number'), 50);
      if (!number) throw cellErr(row, 'Number', '');
      const description = cellText(get('Description'), 254);
      if (!description) throw cellErr(row, 'Description', '');
      const catText = cellText(get('Category'));
      const categoryId = catText ? comboId(catText) : null;
      if (catText && categoryId === null) throw cellErr(row, 'Category', catText);
      const ch = parseCharacter(cellText(get('Character')));
      if (!ch.ok) throw cellErr(row, 'Character', cellText(get('Character')));
      const r = await importChartAccount(tx, chart, { number, description, englishDescription: cellText(get('EnglishDescription'), 254), currency: cellText(get('Currency')) || undefined, categoryId, isActive: ch.isActive }, {
        duplicate: update ? 'update' : new DataImportError(critical('strNotUniqueAccountNumberInExcel', row, letter('Number'), number)),
        fail: (key, value) => key === 'parent' ? new DataImportError(critical('strAccountParentNotFound', value))
          : key === 'currency' ? cellErr(row, 'Currency', value) : key === 'category' ? cellErr(row, 'Category', catText) : cellErr(row, 'Currency', value),
      });
      if (r.created) created++;
      if (r.updated) updated++;
    }
    await rebuildAccountsTree(tx);
    return { entity, rows: rows.length, created, updated };
  }

  if (entity === 'products') {
    const chart = await loadChart(tx, ctx.year.year);
    for (const { row, get } of rows) {
      const name = cellText(get('ProductName'), 254);
      if (!name) throw cellErr(row, 'ProductName', '');
      const supply = cellText(get('IncrementAccount'), 50);
      if (!supply) throw new DataImportError(critical('strProductAccountNotFound', row, letter('IncrementAccount'), ''));
      const r = await importProduct(tx, chart, { name, code: cellText(get('ProductCode'), 50), measure: cellText(get('Measure'), 50), price: '0', supplyAccountNumber: supply, releaseAccountNumber: cellText(get('DecrementAccount'), 50) || null }, excelProductMessages(row, letter), { update });
      if (r.created) created++;
      if (r.updated) updated++;
    }
    return { entity, rows: rows.length, created, updated };
  }

  // Initial balances (5.4): one accounting per row, dated at the year's start.
  const years = await tx.select().from(s.financialYears);
  const docType = await documentTypesByShortName(tx);
  const charts = new Map<number, Awaited<ReturnType<typeof loadChart>>>();
  const isos = await currencyIdsByIso(tx);
  void isos;
  const cache = new Map<string, number>();
  for (const { row, get } of rows) {
    const yText = cellText(get('FinancialYear'));
    const fy = years.find((y) => String(y.year) === yText);
    if (!fy) throw cellErr(row, 'FinancialYear', yText);
    let chart = charts.get(fy.year);
    if (!chart) charts.set(fy.year, (chart = await loadChart(tx, fy.year)));
    const number = cellText(get('AccountNumber'), 50);
    const acc = chart.byNumber.get(number);
    if (!acc) throw new DataImportError(critical('strAccountNotFound', number));
    const dir = parseDirection(cellText(get('Direction')));
    if (dir === null) throw cellErr(row, 'Direction', cellText(get('Direction')));
    const bal = cellDecimal(get('Balance'));
    if (bal === null) throw cellErr(row, 'Balance', cellText(get('Balance')));
    const amount = round2(bal).toFixed(2);
    const typeText = cellText(get('DocumentType'));
    const docNo = cellText(get('DocumentNumber'), 50);
    const docDateText = cellText(get('DocumentDate'));
    let documentId: number | null = null;
    if (typeText) {
      const t = docType(typeText);
      if (!t) throw cellErr(row, 'DocumentType', typeText);
      const dd = docDateText ? cellDate(get('DocumentDate')) : fy.startDate;
      if (!dd) throw cellErr(row, 'DocumentDate', docDateText);
      const [d] = await tx.insert(s.documents).values({ number: docNo, date: dd, documentTypeId: t }).returning({ id: s.documents.id });
      documentId = d!.id;
    } else if (docNo || docDateText) throw new DataImportError(critical('strDocumentTypeMissingError', row));
    let companyId: number | null = null;
    if (isCompanyCategory(acc.categoryId)) {
      const name = cellText(get('CompanyName'), 254);
      if (!name) throw new DataImportError(critical('strInvalidPartnerField', row, letter('CompanyName')));
      companyId = (await findOrCreatePartner(tx, { name, accountIds: [acc.id] }, cache))!.id;
    }
    let currency: { currencyId: number; currencyAmount: string; exchangeRate: string; fixedRate: string } | null = null;
    if (acc.isForeignCurrency) {
      const ca = cellDecimal(get('CurrencyBalance'));
      const rate = cellDecimal(get('ExchangeRate'));
      if (ca === null) throw cellErr(row, 'CurrencyBalance', cellText(get('CurrencyBalance')));
      if (rate === null) throw cellErr(row, 'ExchangeRate', cellText(get('ExchangeRate')));
      currency = { currencyId: acc.currencyId, currencyAmount: round2(ca).toFixed(2), exchangeRate: rate.toFixed(6), fixedRate: rate.toFixed(6) };
    }
    let material: { productId: number; quantity: string; price: string } | null = null;
    if (acc.isMaterial && acc.productId) {
      const q = cellDecimal(get('Quantity'));
      const p = cellDecimal(get('SalePrice'));
      if (q === null) throw cellErr(row, 'Quantity', cellText(get('Quantity')));
      material = { productId: acc.productId, quantity: q.toFixed(6), price: (p ?? (q.isZero() ? round2(0) : round2(bal).div(q))).toFixed(6) };
    }
    const [head] = await tx.insert(s.accountings).values({
      financialYearId: fy.id, number: '', date: fy.startDate, accountingDate: fy.startDate, viesMonth: fy.startDate, documentId, transactionTypeId: 1,
      userId: ctx.userId, isInitialBalance: true, source: 'import-excel',
    }).returning({ id: s.accountings.id });
    await tx.insert(s.accountingDetails).values({
      accountingId: head!.id, accountId: acc.id, refAccountId: acc.id, companyId, vatTermId: 1, sign: dir,
      amount: dir === 1 ? amount : '0', refAmount: dir === 1 ? '0' : amount,
      currencyId: currency?.currencyId ?? null, currencyAmount: currency?.currencyAmount ?? null, exchangeRate: currency?.exchangeRate ?? null, fixedRate: currency?.fixedRate ?? null,
      productId: material?.productId ?? null, quantity: material?.quantity ?? null, price: material?.price ?? null, position: 0,
    });
    await tx.insert(s.accountInitialBalances).values({ accountId: acc.id, accountingId: head!.id, companyId, documentId, financialYearId: fy.id });
    created++;
  }
  return { entity, rows: rows.length, created, updated };
}

/** Builds an empty template workbook for an entity (with the setup sheet filled from the mapping). */
export function excelTemplateRows(entity: ExcelEntity, m: ExcelMapping) {
  const def = EXCEL_ENTITIES[entity];
  const setup = [['Sheet с данни', m.sheetName], ['Начален ред', m.startingRow], ['Краен ред', m.endingRow], ...def.columns.filter((c) => m.columns[c.key]).map((c) => [c.caption, m.columns[c.key]])];
  return { setupSheet: def.setupSheet, setup };
}
