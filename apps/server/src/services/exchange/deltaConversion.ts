import { and, eq, ne, sql } from 'drizzle-orm';
import MDBReader from 'mdb-reader';
import {
  DELTA_DEFAULT_PARTNER, DELTA_FALLBACK_DOCUMENT_TYPE, DataImportError, ZERO, critical, dec, deltaAccountFeatures, deltaImportsChart, deltaImportsOperations,
  deltaRepairCp1251, deltaYearTables, isCompanyCategory, mapDeltaChart, mapDeltaCompany, mapDeltaPartner, mapDeltaYear, msg, normalizeIban,
  requiresDocumentNumber, warning, type DeltaAccounting, type DeltaImportType, type DeltaOpening, type DeltaRow, type DeltaSource,
  type Dec, type ExchangeMessage,
} from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import type { CompanyDb, DbOrTx } from '../../db/provider.ts';
import type { ActiveYear } from '../../context.ts';
import { ApiError } from '../../lib/errors.ts';
import { logApp } from '../appLog.ts';
import { documentNumberUsed } from '../autoEntries.ts';
import { accountSeparator, rebuildAccountsTree } from '../chart.ts';
import { saveInitialBalances, type BalanceRowInput } from '../initialBalances.ts';
import { saveEntry, type LineInput } from '../journal.ts';
import { reserveNumber } from '../sequences.ts';
import { addFinancialYear } from '../years.ts';
import { addPartnerAccounts, bankIdForIban, countRows, findOrCreatePartner, loadChart, throwIf, type Chart } from './common.ts';
import { importChartAccount, type ImportCtx } from './transfer.ts';

/**
 * "Импорт от Microinvest Делта" (spec 04a 7): reads the legacy Access
 * database (MAINACCT.MDB) with a pure-JS Jet reader and converts it into the
 * active, empty company. The mapping rules are in @shmi/core
 * (exchange/deltaConversion.ts); this module reads the file and writes the
 * result through the same services as the other importers (partner matching,
 * chart import, number reservation, saveEntry validation, opening balances).
 *
 * The legacy database is in leva: the chart goes into the BGN chart and the
 * Year tables up to 2025 are converted, each into its financial year (created
 * when missing). Everything runs in one transaction; any error aborts the run.
 */

// ---------------------------------------------------------------------------
// File layer

const unrecognized = () => new DataImportError(critical('strErrorMDBUnrecognizedDatabaseFormat'));
const readError = (detail: string) => new DataImportError(critical('strErrorReadingMDBFile', detail));

/** Opens the Jet file; anything that is not an Access database is strErrorMDBUnrecognizedDatabaseFormat. */
export function openDeltaMdb(bytes: Uint8Array) {
  if (!bytes.length) throw new DataImportError(critical('strErrorMDBFileNotFound'));
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Page 0 is the database definition page: type 0, "Standard Jet DB" at offset 4.
  if (buffer.length < 2048 || buffer[0] !== 0 || !['Standard Jet DB', 'Standard ACE DB'].includes(buffer.subarray(4, 19).toString('latin1'))) throw unrecognized();
  try {
    const reader = new MDBReader(buffer);
    return { reader, names: reader.getTableNames(), isJet3: buffer[0x14] === 0 };
  } catch {
    throw unrecognized();
  }
}

/**
 * Reads the tables of 7 into plain rows. Jet 3 (Access 97) text is in the
 * Windows code page; it is decoded as windows-1251 (Bulgarian).
 */
export function readDeltaMdb(bytes: Uint8Array, type: DeltaImportType = 'all'): DeltaSource {
  const { reader, names, isJet3 } = openDeltaMdb(bytes);
  const fix = (rows: Record<string, unknown>[]): DeltaRow[] => {
    if (!isJet3) return rows as DeltaRow[];
    for (const r of rows) for (const k of Object.keys(r)) if (typeof r[k] === 'string') r[k] = deltaRepairCp1251(r[k] as string);
    return rows as DeltaRow[];
  };
  const find = (n: string) => names.find((x) => x.toLowerCase() === n.toLowerCase());
  const read = (name: string): DeltaRow[] => {
    try {
      return fix(reader.getTable(name).getData() as Record<string, unknown>[]);
    } catch (e) {
      throw readError(`${name}: ${(e as Error).message}`);
    }
  };
  const table = (n: string, required: boolean) => {
    const name = find(n);
    if (!name) {
      if (required) throw readError(msg('strDeltaConversionMissingTable', n));
      return [];
    }
    return read(name);
  };
  const chart = deltaImportsChart(type);
  const ops = deltaImportsOperations(type);
  return {
    system: table('System', false)[0] ?? null,
    accts: chart ? table('Accts', true) : [],
    priznaci: chart ? table('Priznaci', true) : [],
    part: table('Part', true),
    years: ops ? deltaYearTables(names).map((t) => ({ ...t, rows: read(t.table) })) : [],
  };
}

// ---------------------------------------------------------------------------
// Conversion

export interface DeltaConversionResult {
  type: DeltaImportType;
  myCompany: boolean;
  accounts: number;
  /** Partners created (Part rows and the default partner "Служебен партньор"). */
  partners: number;
  /** Part rows matched to an existing partner (same Bulstat, VAT number or name). */
  partnersMatched: number;
  accountings: number;
  openingBalances: number;
  years: { year: number; table: string; accountings: number; openingBalances: number; skipped: number }[];
  warnings: ExchangeMessage[];
}

/** strAccountsAlreadyExist / strImportDatabaseNotEmptyError (7, preconditions). */
export async function deltaPreconditions(db: DbOrTx, type: DeltaImportType): Promise<ExchangeMessage[]> {
  const out: ExchangeMessage[] = [];
  if (deltaImportsChart(type)) {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(s.accounts).where(and(eq(s.accounts.isEuro, false), ne(s.accounts.number, '0')));
    if (r!.n > 0) out.push(critical('strAccountsAlreadyExist'));
  }
  const [p] = await db.select({ n: sql<number>`count(*)::int` }).from(s.companies).where(eq(s.companies.isDeleted, false));
  if ((await countRows(db, s.accountings)) > 0 || p!.n > 0) out.push(critical('strImportDatabaseNotEmptyError'));
  return out;
}

/** The legacy amounts are in leva: the BGN chart (any year up to 2025). */
const BGN_YEAR = 2025;

/** The run stops (and its transaction rolls back) once the client cancelled it (strCancelTransferWarning, 7). */
function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DataImportError(critical('strTransferCancelled'));
}

export async function convertDelta(tx: DbOrTx, src: DeltaSource, type: DeltaImportType, ctx: ImportCtx, signal?: AbortSignal): Promise<DeltaConversionResult> {
  throwIf(await deltaPreconditions(tx, type));
  const result: DeltaConversionResult = { type, myCompany: false, accounts: 0, partners: 0, partnersMatched: 0, accountings: 0, openingBalances: 0, years: [], warnings: [] };
  const sep = await accountSeparator(tx);

  result.myCompany = await convertMyCompany(tx, src.system);

  // Chart (Сметкоплан).
  const chartRows = deltaImportsChart(type) ? mapDeltaChart(src.accts, src.priznaci, sep) : [];
  if (chartRows.length) {
    const chart = await loadChart(tx, BGN_YEAR);
    const fail = (number: string) => (key: 'currency' | 'category' | 'parent' | 'synthetic', value: string) =>
      new DataImportError(key === 'parent' ? critical('strAccountParentNotFound', number) : key === 'currency' ? critical('strXMLImportInvalidCurrencyForAccount', value, number) : critical('strXMLImportInvalidCategory', value, number));
    for (const a of chartRows) {
      checkCancelled(signal);
      // Foreign-currency flag: the account gets the non-base currency (EUR); a synthetic account stays in leva.
      const r = await importChartAccount(tx, chart, {
        number: a.number, description: a.description || a.number, englishDescription: '', categoryId: a.categoryId, parentNumber: a.parentNumber,
        currency: a.isForeignCurrency && a.parentNumber ? 'EUR' : undefined,
      }, { duplicate: 'reuse', fail: fail(a.number) });
      if (r.created) result.accounts++;
    }
    await rebuildAccountsTree(tx);
  }

  // Partners (Part), keyed by Part.ID.
  const partners = new Map<number, number>();
  const cache = new Map<string, number>();
  for (const row of src.part) {
    checkCancelled(signal);
    const p = mapDeltaPartner(row);
    const r = await findOrCreatePartner(tx, {
      name: p.name, contactName: p.contactName, bulstat: p.bulstat, vatNumber: p.vatNumber, address: { city: p.city, address: p.address, phone: p.phone },
    }, cache);
    if (!r) continue;
    partners.set(p.sourceId, r.id);
    if (!r.created) {
      result.partnersMatched++;
      continue;
    }
    result.partners++;
    if (p.priority) await tx.update(s.companies).set({ priority: p.priority }).where(eq(s.companies.id, r.id));
    if (p.bank) await addBankAccount(tx, 'company', r.id, p.bank);
  }

  if (!deltaImportsOperations(type)) return result;

  // Operations and opening balances (Year<YYYY>).
  const chart = await loadChart(tx, BGN_YEAR);
  const accountsById = new Map(mapDeltaChart(src.accts, src.priznaci, sep).filter((a) => a.sourceId).map((a) => [a.sourceId, a.number]));
  const features = deltaAccountFeatures(src.priznaci);
  const docTypes = await tx.select().from(s.documentTypes);
  const fallbackType = docTypes.find((d) => d.name === DELTA_FALLBACK_DOCUMENT_TYPE) ?? docTypes.find((d) => d.id === 5)!;
  const docType = (short: string) => docTypes.find((d) => d.shortName.trim().toLowerCase() === short.trim().toLowerCase()) ?? fallbackType;
  let defaultPartner: number | null = null;
  const partnerFor = async (sourceId: number | null) => {
    const id = sourceId ? partners.get(sourceId) : undefined;
    if (id) return id;
    if (!defaultPartner) {
      const r = (await findOrCreatePartner(tx, { name: msg('strDefaultPartner'), bulstat: DELTA_DEFAULT_PARTNER.bulstat, vatNumber: DELTA_DEFAULT_PARTNER.vatNumber }, cache))!;
      if (r.created) result.partners++;
      defaultPartner = r.id;
    }
    return defaultPartner;
  };
  const w = { chart, docType, partnerFor, partners, ctx };

  for (const t of src.years) {
    if (t.year > BGN_YEAR) {
      result.warnings.push(warning('strDeltaConversionEuroYearSkipped', t.table));
      continue;
    }
    const mapped = mapDeltaYear(t, features, { sep, accountsById, isValidAccount: (n) => chart.byNumber.has(n) });
    if (!mapped.accountings.length && !mapped.openings.length) continue;
    const fy = await ensureYear(tx, t.year);
    for (const a of mapped.accountings) {
      checkCancelled(signal);
      await saveDeltaAccounting(tx, a, fy, w);
    }
    const openings = await saveDeltaOpenings(tx, t.table, t.year, mapped.openings, fy, w);
    result.accountings += mapped.accountings.length;
    result.openingBalances += openings;
    result.years.push({ year: t.year, table: t.table, accountings: mapped.accountings.length, openingBalances: openings, skipped: mapped.skipped });
  }
  return result;
}

/**
 * The conversion in one transaction. Known failures carry strImportFromDeltaFailed
 * with their details; an unexpected one is written to the application log
 * (06 7.2) and reported as strImportFromDeltaFailedSeeErrLog. A cancelled run
 * (the client aborted the request after strCancelTransferWarning) rolls back.
 */
export async function runDeltaConversion(db: CompanyDb, src: DeltaSource, type: DeltaImportType, ctx: ImportCtx,
  opts: { signal?: AbortSignal; fileName?: string; company?: string | null; user?: string | null } = {}): Promise<DeltaConversionResult> {
  try {
    return await db.transaction((tx) => convertDelta(tx, src, type, ctx, opts.signal));
  } catch (e) {
    if (e instanceof DataImportError) throw new DataImportError([critical('strImportFromDeltaFailed'), ...e.messages], e.details);
    const err = e as Error;
    await logApp({ level: 'error', message: `${msg('strImportFromDeltaFailed')} ${opts.fileName ?? ''}: ${err?.message ?? String(e)}`, details: err?.stack, company: opts.company ?? null, user: opts.user ?? null });
    throw new DataImportError(critical('strImportFromDeltaFailedSeeErrLog'));
  }
}

interface Writer {
  chart: Chart;
  docType: (short: string) => typeof s.documentTypes.$inferSelect;
  partnerFor: (sourceId: number | null) => Promise<number>;
  partners: Map<number, number>;
  ctx: ImportCtx;
}

async function ensureYear(tx: DbOrTx, year: number): Promise<ActiveYear> {
  const [fy] = await tx.select().from(s.financialYears).where(eq(s.financialYears.year, year));
  const row = fy ?? (await addFinancialYear(tx, year));
  return { id: row.id, year: row.year, startDate: row.startDate, isLocked: row.isLocked, lockedMonths: row.lockedMonths, isConcluded: row.isConcluded };
}

/** saveEntry failures carry the table and the legacy accounting id. */
function wrapSaveError(e: unknown, head: ExchangeMessage): never {
  if (e instanceof ApiError && e.status === 422) {
    const details = (e.messages ?? []).filter((m) => m.severity === 'critical').map((m): ExchangeMessage => ({ key: m.key, text: m.text, severity: 'critical' }));
    throw new DataImportError([head, ...(details.length ? details : [{ key: 'error', text: e.message, severity: 'critical' as const }])]);
  }
  throw e;
}

async function saveDeltaAccounting(tx: DbOrTx, a: DeltaAccounting, fy: ActiveYear, w: Writer) {
  const header = a.partnerId ? w.partners.get(a.partnerId) ?? null : null;
  const used = new Map<number, number[]>();
  const line = async (l: DeltaAccounting['debits'][number]): Promise<LineInput> => {
    const acc = w.chart.byNumber.get(l.accountNumber)!;
    let companyId: number | null = null;
    if (isCompanyCategory(acc.categoryId)) {
      companyId = (l.partnerId ? w.partners.get(l.partnerId) : undefined) ?? header ?? (await w.partnerFor(null));
      used.set(companyId, [...(used.get(companyId) ?? []), acc.id]);
    }
    return { accountId: acc.id, amount: l.amount, vatTermId: l.vatTermId, companyId };
  };
  const debits: LineInput[] = [];
  const credits: LineInput[] = [];
  for (const l of a.debits) debits.push(await line(l));
  for (const l of a.credits) credits.push(await line(l));
  for (const [companyId, ids] of used) await addPartnerAccounts(tx, companyId, ids);

  const dt = w.docType(a.documentType);
  let number = a.documentNumber;
  if (!number) {
    if (dt.sequenceChannel) number = (await reserveNumber(tx, dt.sequenceChannel, fy.id, (n) => documentNumberUsed(tx, dt.id, fy.id, n), w.ctx.userId)).number;
    else if (requiresDocumentNumber(dt.id)) number = '0';
  }
  try {
    await saveEntry(tx, {
      accountingDate: a.date, documentDate: a.documentDate, documentTypeId: dt.id, documentNumber: number,
      companyId: header ?? [...used.keys()][0] ?? null, term: a.term, reference: a.reference || null,
      transactionTypeId: a.transactionTypeId, viesId: a.viesId, viesMonth: a.viesMonth, source: 'import-delta',
      debits, credits,
    }, { year: fy, userId: w.ctx.userId, skipHeaderChecks: true, ignoreKeys: ['strForeignCurrencyRequired'] });
  } catch (e) {
    wrapSaveError(e, critical('strDeltaConversionAccountingError', a.table, a.konId));
  }
}

/**
 * Opening balances of the year: one editor row per account (partner accounts:
 * per partner and document), saved through the opening-balance editor.
 */
async function saveDeltaOpenings(tx: DbOrTx, table: string, year: number, openings: DeltaOpening[], fy: ActiveYear, w: Writer) {
  const byAccount = new Map<number, Map<string, BalanceRowInput & { net: Dec }>>();
  for (const o of openings) {
    const acc = w.chart.byNumber.get(o.accountNumber)!;
    const isPartner = isCompanyCategory(acc.categoryId);
    const companyId = isPartner ? await w.partnerFor(o.partnerId) : null;
    const dt = isPartner && o.documentNumber ? w.docType(o.documentType) : null;
    const key = isPartner ? `${companyId}|${dt?.id ?? ''}|${dt ? o.documentNumber : ''}` : '';
    const rows = byAccount.get(acc.id) ?? new Map();
    const r = rows.get(key) ?? {
      companyId, documentTypeId: dt?.id ?? null, documentNumber: dt ? o.documentNumber : null, documentDate: dt ? o.documentDate ?? `${year}-01-01` : null, net: ZERO,
    };
    r.net = r.net.plus(dec(o.debit)).minus(dec(o.credit));
    rows.set(key, r);
    byAccount.set(acc.id, rows);
    if (companyId) await addPartnerAccounts(tx, companyId, [acc.id]);
  }
  let count = 0;
  for (const [accountId, rows] of byAccount) {
    const list = [...rows.values()].filter((r) => !r.net.isZero()).map(({ net, ...r }) => ({
      ...r, debit: net.isPositive() ? net.toFixed(2) : '0', credit: net.isNegative() ? net.negated().toFixed(2) : '0',
    }));
    if (!list.length) continue;
    try {
      await saveInitialBalances(tx, fy, { userId: w.ctx.userId, branchId: 1, force: true }, accountId, `${year}-01-01`, list);
    } catch (e) {
      wrapSaveError(e, critical('strDeltaConversionOpeningError', w.chart.byId.get(accountId)?.number ?? accountId, table));
    }
    count += list.length;
  }
  return count;
}

/** MyCompany from the System row: names and identifiers, primary address, bank account (bank looked up or created by name). */
async function convertMyCompany(tx: DbOrTx, row: DeltaRow | null) {
  const c = mapDeltaCompany(row);
  if (!c) return false;
  const [my] = await tx.select().from(s.myCompany).orderBy(s.myCompany.id).limit(1);
  if (!my) return false;
  await tx.update(s.myCompany).set({
    name: c.name || my.name, bulstat: c.bulstat || my.bulstat, contactName: c.contactName || my.contactName, vatId: c.vatId || my.vatId,
    isVat: c.vatId ? true : my.isVat,
  }).where(eq(s.myCompany.id, my.id));
  if (c.city || c.address || c.phone) {
    const values = { city: c.city.slice(0, 50) || null, address: c.address || null, phone: c.phone.slice(0, 100) || null };
    const [primary] = await tx.select({ id: s.addresses.id }).from(s.addresses).where(and(eq(s.addresses.ownerType, 'my'), eq(s.addresses.ownerId, my.id))).orderBy(s.addresses.id).limit(1);
    if (primary) await tx.update(s.addresses).set(values).where(eq(s.addresses.id, primary.id));
    else await tx.insert(s.addresses).values({ ownerType: 'my', ownerId: my.id, ...values, isPrimary: true });
  }
  if (c.bankAccount) await addBankAccount(tx, 'my', my.id, { name: c.bankName, account: c.bankAccount, code: '' });
  return true;
}

/** Bank account of a partner or of the company; the bank is found by code or name, else created by name; without a name, by the IBAN. */
async function addBankAccount(tx: DbOrTx, ownerType: 'company' | 'my', ownerId: number, b: { name: string; account: string; code: string }) {
  const account = normalizeIban(b.account).slice(0, 50);
  if (!account) return;
  const [have] = await tx.select({ id: s.bankAccounts.id }).from(s.bankAccounts)
    .where(and(eq(s.bankAccounts.ownerType, ownerType), eq(s.bankAccounts.ownerId, ownerId), eq(s.bankAccounts.account, account))).limit(1);
  if (have) return;
  let bankId: number | null = null;
  if (b.code) bankId = (await tx.select({ id: s.banks.id }).from(s.banks).where(sql`lower(${s.banks.code}) = lower(${b.code})`).limit(1))[0]?.id ?? null;
  if (!bankId && b.name) {
    bankId = (await tx.select({ id: s.banks.id }).from(s.banks).where(sql`lower(${s.banks.name}) = lower(${b.name})`).limit(1))[0]?.id
      ?? (await tx.insert(s.banks).values({ name: b.name.slice(0, 255), code: b.code || null }).returning({ id: s.banks.id }))[0]!.id;
  }
  bankId ??= await bankIdForIban(tx, account);
  await tx.insert(s.bankAccounts).values({ ownerType, ownerId, account, bankId });
}
