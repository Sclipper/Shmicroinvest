import { and, eq, ilike, inArray, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  DataImportError, IDENTIFIER_PLACEHOLDER, bankCodeFromIban, bulstatFromVat, critical, isCompanyCategory, isLeaf, isMonthLocked, msg,
  normalizeIban, usableIdentifier, type ExchangeMessage,
} from '@shmi/core';
import * as s from '../../db/company/schema/index.ts';
import type { DbOrTx } from '../../db/provider.ts';
import type { ActiveYear, AppEnv } from '../../context.ts';
import { ApiError } from '../../lib/errors.ts';
import { baseCurrencyId } from '../journal.ts';

/** An uploaded file: multipart/form-data (field "file") or JSON { fileName, contentBase64 | text }. */
export interface Upload { fileName: string; bytes: Uint8Array; fields: Record<string, unknown> }

export async function readUpload(c: Context<AppEnv>): Promise<Upload> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    const fields: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) {
      if (k === 'file') continue;
      const text = typeof v === 'string' ? v : '';
      try {
        fields[k] = JSON.parse(text);
      } catch {
        fields[k] = text;
      }
    }
    if (!file || typeof file === 'string') throw new ApiError(400, msg('strFilePathNotSpecified'));
    return { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()), fields };
  }
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new ApiError(400, msg('strFilePathNotSpecified'));
  const { fileName, contentBase64, text, ...fields } = body;
  let bytes: Uint8Array;
  if (typeof contentBase64 === 'string') bytes = new Uint8Array(Buffer.from(contentBase64, 'base64'));
  else if (typeof text === 'string') bytes = new TextEncoder().encode(text);
  else throw new ApiError(400, msg('strFilePathNotSpecified'));
  return { fileName: typeof fileName === 'string' ? fileName : 'file', bytes, fields };
}

/** DataImportError -> 422 with the spec messages; anything else is rethrown. */
export function asApiError(e: unknown, wrapKey: 'strOperationsImportErrorOccured' | null = 'strOperationsImportErrorOccured'): never {
  if (e instanceof DataImportError) {
    const messages = [...e.messages, ...e.details.map((d): ExchangeMessage => ({ key: 'detail', text: d, severity: 'critical' }))];
    const text = wrapKey ? msg(wrapKey, e.messages.map((m) => m.text).join(' ')) : e.message;
    throw new ApiError(422, text, messages);
  }
  throw e;
}

/** Runs an import step, turning DataImportError into the 422 response. */
export async function importStep<T>(fn: () => Promise<T>, wrap = true): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!wrap) return asApiError(e, null);
    if (e instanceof ApiError && e.status === 422 && e.messages?.length) {
      throw new ApiError(422, msg('strOperationsImportErrorOccured', e.messages.map((m) => m.text).join(' ')), e.messages);
    }
    return asApiError(e);
  }
}

export interface ImportAccount {
  id: number; number: string; description: string; categoryId: number | null; currencyId: number; productId: number | null;
  isForeignCurrency: boolean; isMaterial: boolean; isLeaf: boolean; parentId: number | null;
}

/** Chart of the active year (BGN up to 2025, EUR from 2026) indexed by number. */
export async function loadChart(db: DbOrTx, year: number) {
  const isEuro = year >= 2026;
  const base = await baseCurrencyId(db, year);
  const rows = await db.select().from(s.accounts).where(eq(s.accounts.isEuro, isEuro));
  const byNumber = new Map<string, ImportAccount>();
  const byId = new Map<number, ImportAccount>();
  let root: ImportAccount | null = null;
  for (const r of rows) {
    const a: ImportAccount = {
      id: r.id, number: r.number, description: r.description, categoryId: r.accountCategoryId, currencyId: r.currencyId, productId: r.productId,
      isForeignCurrency: r.currencyId !== base, isMaterial: r.productId != null, isLeaf: isLeaf({ left: r.leftIndex, right: r.rightIndex }) && r.number !== '0',
      parentId: r.parentId,
    };
    if (r.number === '0' && r.parentId == null) root = a;
    else byNumber.set(r.number, a);
    byId.set(r.id, a);
  }
  const categories = await db.select().from(s.accountCategories);
  /** Category -> account: first account with that category, else the account whose number equals the category code. */
  const byCategory = (categoryId: number): ImportAccount | null => {
    const leaf = [...byNumber.values()].filter((a) => a.categoryId === categoryId).sort((x, y) => x.number.localeCompare(y.number));
    if (leaf.length) return leaf.find((a) => a.isLeaf) ?? leaf[0]!;
    const code = categories.find((c) => c.id === categoryId)?.code;
    return code ? byNumber.get(code) ?? null : null;
  };
  return { isEuro, baseCurrencyId: base, byNumber, byId, root, byCategory, categories };
}
export type Chart = Awaited<ReturnType<typeof loadChart>>;

/** strOperationDateInLockedMonth pre-check (3.7 step 9). */
export function checkDates(dates: string[], fy: ActiveYear): ExchangeMessage[] {
  const out: ExchangeMessage[] = [];
  const seen = new Set<string>();
  for (const d of dates) {
    const m = Number(d.slice(5, 7));
    if (Number(d.slice(0, 4)) === fy.year && isMonthLocked(fy.lockedMonths, m) && !seen.has(d.slice(0, 7))) {
      seen.add(d.slice(0, 7));
      out.push(critical('strOperationDateInLockedMonth', `${d.slice(5, 7)}.${d.slice(0, 4)}`));
    }
  }
  return out;
}

export async function bankIdForIban(db: DbOrTx, iban: string): Promise<number | null> {
  const code = bankCodeFromIban(iban);
  if (!code) return null;
  const [b] = await db.select().from(s.banks).where(ilike(s.banks.code, `${code}%`)).limit(1);
  return b?.id ?? null;
}

export interface IncomingPartner {
  name: string;
  contactName?: string | null;
  bulstat?: string | null;
  vatNumber?: string | null;
  ibans?: string[];
  address?: { city?: string | null; address?: string | null; phone?: string | null; postalCode?: string | null } | null;
  accountIds?: number[];
}

/**
 * Partner matching (04a 3.6): Bulstat, VAT number, IBAN, then exact name
 * (a name-only match is discarded when the record carries a usable
 * identifier). A matched partner is never updated; only missing partner
 * accounts and IBANs are added. Returns null for a partner without a name.
 */
export async function findOrCreatePartner(db: DbOrTx, p: IncomingPartner, cache?: Map<string, number>): Promise<{ id: number; created: boolean } | null> {
  const name = p.name.trim().slice(0, 255);
  if (!name) return null;
  const bulstat = usableIdentifier(p.bulstat);
  const vat = usableIdentifier(p.vatNumber);
  const ibans = (p.ibans ?? []).map((i) => normalizeIban(i)).filter(Boolean);
  const key = `${name.toLowerCase()}|${bulstat ?? ''}|${vat ?? ''}|${ibans.join(',')}`;
  const cached = cache?.get(key);
  if (cached) {
    await addPartnerAccounts(db, cached, p.accountIds ?? []);
    return { id: cached, created: false };
  }
  const live = eq(s.companies.isDeleted, false);
  let id: number | null = null;
  if (bulstat) id = (await db.select({ id: s.companies.id }).from(s.companies).where(and(live, eq(s.companies.bulstat, bulstat))).limit(1))[0]?.id ?? null;
  if (!id && vat) id = (await db.select({ id: s.companies.id }).from(s.companies).where(and(live, eq(s.companies.vatNumber, vat))).limit(1))[0]?.id ?? null;
  if (!id && ibans.length) {
    const [r] = await db.select({ id: s.bankAccounts.ownerId }).from(s.bankAccounts)
      .innerJoin(s.companies, eq(s.companies.id, s.bankAccounts.ownerId))
      .where(and(eq(s.bankAccounts.ownerType, 'company'), inArray(s.bankAccounts.account, ibans), live)).limit(1);
    id = r?.id ?? null;
  }
  if (!id && !bulstat && !vat) id = (await db.select({ id: s.companies.id }).from(s.companies).where(and(live, eq(s.companies.name, name))).limit(1))[0]?.id ?? null;
  let created = false;
  if (!id) {
    const [row] = await db.insert(s.companies).values({
      name, contactName: p.contactName?.trim() || null, bulstat: bulstat ?? bulstatFromVat(vat) ?? (p.bulstat?.trim() === IDENTIFIER_PLACEHOLDER ? IDENTIFIER_PLACEHOLDER : null),
      vatNumber: vat, isVat: !!vat,
    }).returning({ id: s.companies.id });
    id = row!.id;
    created = true;
    const a = p.address;
    if (a && (a.city?.trim() || a.address?.trim() || a.phone?.trim())) {
      await db.insert(s.addresses).values({
        ownerType: 'company', ownerId: id, city: a.city?.trim().slice(0, 50) || null, address: a.address?.trim().slice(0, 255) || null,
        phone: a.phone?.trim().slice(0, 100) || null, postalCode: a.postalCode?.trim().slice(0, 10) || null, isPrimary: true,
      });
    }
  }
  await addPartnerIbans(db, id, ibans);
  await addPartnerAccounts(db, id, p.accountIds ?? []);
  cache?.set(key, id);
  return { id, created };
}

export async function addPartnerIbans(db: DbOrTx, companyId: number, ibans: string[]) {
  if (!ibans.length) return;
  const have = await db.select({ account: s.bankAccounts.account }).from(s.bankAccounts)
    .where(and(eq(s.bankAccounts.ownerType, 'company'), eq(s.bankAccounts.ownerId, companyId)));
  const known = new Set(have.map((h) => normalizeIban(h.account)));
  for (const iban of new Set(ibans)) {
    if (known.has(iban)) continue;
    await db.insert(s.bankAccounts).values({ ownerType: 'company', ownerId: companyId, account: iban, bankId: await bankIdForIban(db, iban) });
  }
}

/** Partner accounts are extended with every partner-category account used (3.7 step 7). */
export async function addPartnerAccounts(db: DbOrTx, companyId: number, accountIds: number[]) {
  const ids = [...new Set(accountIds)];
  if (!ids.length) return;
  const accs = await db.select({ id: s.accounts.id, categoryId: s.accounts.accountCategoryId }).from(s.accounts).where(inArray(s.accounts.id, ids));
  const partnerIds = accs.filter((a) => isCompanyCategory(a.categoryId)).map((a) => a.id);
  if (!partnerIds.length) return;
  const have = await db.select({ accountId: s.companyAccounts.accountId }).from(s.companyAccounts)
    .where(and(eq(s.companyAccounts.companyId, companyId), inArray(s.companyAccounts.accountId, partnerIds)));
  const known = new Set(have.map((h) => h.accountId));
  const add = partnerIds.filter((x) => !known.has(x));
  if (add.length) await db.insert(s.companyAccounts).values(add.map((accountId) => ({ companyId, accountId })));
}

export async function documentTypesByShortName(db: DbOrTx) {
  const rows = await db.select().from(s.documentTypes);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.shortName.trim().toLowerCase(), r.id);
  return (short: string) => map.get(short.trim().toLowerCase()) ?? null;
}

export async function currencyIdsByIso(db: DbOrTx) {
  const rows = await db.select({ id: s.currencies.id, iso: s.currencies.isoCode }).from(s.currencies);
  return new Map(rows.map((r) => [r.iso.trim().toUpperCase(), r.id]));
}

/** Throws when DataImportError messages were collected. */
export function throwIf(messages: ExchangeMessage[]) {
  if (messages.length) throw new DataImportError(messages);
}

export const countRows = async (db: DbOrTx, table: typeof s.accountings) =>
  ((await db.select({ n: sql<number>`count(*)::int` }).from(table)) as [{ n: number }])[0].n;
