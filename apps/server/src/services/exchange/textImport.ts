import {
  DataImportError, TXT_DOCUMENT_ALIASES, TRANSACTION_TYPE, VAT_TERMS, critical, isCompanyCategory, parseTextImport, txtOperationLines,
  ACCOUNT_CATEGORIES, type AccountRef, type TxtParseOptions,
} from '@shmi/core';
import type { DbOrTx } from '../../db/provider.ts';
import { saveEntry } from '../journal.ts';
import { checkDates, documentTypesByShortName, findOrCreatePartner, loadChart, throwIf, type Chart } from './common.ts';
import type { ImportCtx } from './transfer.ts';

/** Categories used by the operation kinds of the text format (wizard mapping). */
export const TXT_CATEGORIES = [3, 4, 10, 16, 17, 21, 24, 25, 61];

export async function textCategoryDefaults(db: DbOrTx, year: number) {
  const chart = await loadChart(db, year);
  return TXT_CATEGORIES.map((id) => {
    const a = chart.byCategory(id);
    return { categoryId: id, name: ACCOUNT_CATEGORIES.find((c) => c.id === id)?.description ?? String(id), accountId: a?.id ?? null, accountNumber: a?.number ?? null };
  });
}

const VAT_TYPE = new Map<number, number>(VAT_TERMS.map((t) => [t.id, t.transactionTypeId]));

/** Parses, validates and posts a pipe-delimited file in one transaction; nothing is saved when any row fails. */
export async function importTextFile(tx: DbOrTx, text: string, ctx: ImportCtx, opts: Omit<TxtParseOptions, 'activeYear'> & { categoryMap?: Record<number, number | null> }) {
  const ops = parseTextImport(text, { ...opts, activeYear: ctx.year.year });
  if (!ops.length) throw new DataImportError(critical('strImportFileHasNoDataErrorMessage'));
  throwIf(checkDates(ops.map((o) => o.date), ctx.year));
  const chart = await loadChart(tx, ctx.year.year);
  const docType = await documentTypesByShortName(tx);
  const resolve = (ref: AccountRef, row: number, chartArg: Chart) => {
    if ('number' in ref) {
      const a = chartArg.byNumber.get(ref.number);
      if (!a) throw new DataImportError(critical('strAccountNotFound', ref.number));
      return a;
    }
    const mapped = opts.categoryMap?.[ref.category];
    const a = mapped ? chartArg.byId.get(mapped) : mapped === null ? null : chartArg.byCategory(ref.category);
    if (!a) throw new DataImportError(critical('strAccountNotDefinedInCategory', ACCOUNT_CATEGORIES.find((c) => c.id === ref.category)?.description ?? ref.category, row));
    return a;
  };
  const cache = new Map<string, number>();
  let count = 0;
  for (const op of ops) {
    const l = txtOperationLines(op);
    const debits = l.debits.map((x) => ({ acc: resolve(x.ref, op.row, chart), amount: x.amount, vatTermId: x.vatTermId }));
    const credits = l.credits.map((x) => ({ acc: resolve(x.ref, op.row, chart), amount: x.amount, vatTermId: x.vatTermId }));
    const partnerAccounts = [...debits, ...credits].filter((x) => isCompanyCategory(x.acc.categoryId)).map((x) => x.acc.id);
    const partner = partnerAccounts.length || op.partner.name
      ? await findOrCreatePartner(tx, { name: op.partner.name, contactName: op.partner.contactName, bulstat: op.partner.bulstat, vatNumber: op.partner.vatNumber, address: { city: op.partner.city, address: op.partner.address }, accountIds: partnerAccounts }, cache)
      : null;
    const short = TXT_DOCUMENT_ALIASES[op.documentTypeShortName] ?? op.documentTypeShortName;
    await saveEntry(tx, {
      accountingDate: op.date, documentDate: op.date, documentTypeId: docType(short), documentNumber: op.documentNumber, companyId: partner?.id ?? null,
      term: op.term, reference: op.reference || null, transactionTypeId: VAT_TYPE.get(op.vatTermId) ?? TRANSACTION_TYPE.NotSet, source: 'import-txt',
      debits: debits.map((x) => ({ accountId: x.acc.id, amount: x.amount, vatTermId: x.vatTermId })),
      credits: credits.map((x) => ({ accountId: x.acc.id, amount: x.amount, vatTermId: x.vatTermId })),
    }, { year: ctx.year, userId: ctx.userId, skipHeaderChecks: true });
    count++;
  }
  return { accountings: count };
}
