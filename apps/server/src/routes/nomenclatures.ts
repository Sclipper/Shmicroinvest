import { Hono } from 'hono';
import { lookupCompany } from '../services/companyLookup.ts';
import { zValidator } from '../lib/validate.ts';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import {
  BULSTAT_PLACEHOLDER, isCompanyCategory, isEmail, isValidEgn, isValidEik, isValidIban, isValidPartnerIdentifier, normalizeIban,
  bankCodeFromIban, detectIdentifier, type ValidationMessage,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import { exec } from '../db/provider.ts';
import type { AppEnv } from '../context.ts';
import type { DbOrTx } from '../db/provider.ts';
import { ApiError, badRequest, notFound } from '../lib/errors.ts';
import { requirePermission } from '../session.ts';
import { logActivity } from '../services/audit.ts';

const addressBody = z.object({
  id: z.number().int().optional(),
  addressTypeId: z.number().int().nullable().optional(),
  countryId: z.number().int().nullable().optional(),
  city: z.string().max(255).nullable().optional(),
  city1: z.string().max(50).nullable().optional(),
  postalCode: z.string().max(10).nullable().optional(),
  address: z.string().max(255).nullable().optional(),
  address1: z.string().max(255).nullable().optional(),
  phone: z.string().max(100).nullable().optional(),
});

const bankAccountBody = z.object({
  id: z.number().int().optional(),
  bankId: z.number().int().nullable().optional(),
  account: z.string().max(50),
  bankStatementAccountId: z.number().int().nullable().optional(),
  isEuro: z.boolean().optional(),
});

const partnerBody = z.object({
  name: z.string().trim().max(255),
  contactName: z.string().max(255).nullable().optional(),
  bulstat: z.string().trim().max(50).nullable().optional(),
  vatNumber: z.string().trim().max(50).nullable().optional(),
  isVat: z.boolean().default(false),
  priority: z.boolean().default(false),
  groupId: z.number().int().default(1),
  dueDays: z.number().int().default(0),
  email: z.string().max(255).nullable().optional(),
  isNotUsing: z.boolean().default(false),
  nameInOtherLanguage: z.string().nullable().optional(),
  code: z.string().nullable().optional(),
  accountIds: z.array(z.number().int()).default([]),
  addresses: z.array(addressBody).max(3).default([]),
  bankAccounts: z.array(bankAccountBody).default([]),
});
type PartnerBody = z.infer<typeof partnerBody>;

/** Partner validation (spec 03a 2.3). */
async function validatePartner(db: DbOrTx, b: PartnerBody, selfId?: number): Promise<ValidationMessage[]> {
  const msgs: ValidationMessage[] = [];
  const crit = (key: string, text: string) => msgs.push({ key, text, severity: 'critical' });
  const warn = (key: string, text: string) => msgs.push({ key, text, severity: 'warning' });
  if (!b.name) crit('strCompanyNameIsEmpty', 'Не е попълнено име на партньора');
  const bulstat = b.bulstat?.trim() ?? '';
  if (!bulstat) warn('strCompanyBulstatIsEmpty', 'Не е попълнен ЕИК на партньора');
  else if (!isValidPartnerIdentifier(bulstat)) warn('strInvalidEIKOrVAtNumber', 'Заличен или невалиден ЕИК/ДДС номер!');
  if (b.isVat && !b.vatNumber?.trim()) crit('strCompanyVatNumberIsEmpty', 'Не е попълнен ДДС номер на партньора');
  if (b.dueDays < 0 || b.dueDays > 999) crit('strDueDaysInvalid', 'Въведете положително число по-малко от 999 дни.');
  if (b.email?.trim() && !isEmail(b.email)) warn('strInvalidEmail', 'Невалиден E-mail!');
  for (const a of b.addresses) {
    if (a.postalCode && !/^\d{1,10}$/.test(a.postalCode)) crit('strInvalidAddressPostalCode', 'Невалиден пощенски код');
    if (!a.countryId) warn('strCountryNotSelected', 'Не е избрана държава.');
    if (a.city && a.city.length > 50) crit('strCityNameTooLong', 'Името на населеното място е твърде дълго');
  }
  const types = b.addresses.map((a) => a.addressTypeId).filter(Boolean);
  if (new Set(types).size !== types.length) crit('strDuplicateAddressType', 'Може да има само по един адрес от тип.');
  for (const ba of b.bankAccounts) {
    if (!ba.account.trim()) crit('strBankAccountNumberIsEmpty', 'Не е попълнен IBAN!');
    else if (!isValidIban(ba.account)) warn('strInvalidIBAN', 'Въведен е невалиден IBAN!');
  }
  if (hasLedgerAccountTwice(b.bankAccounts)) crit('strErrorAccountWithMultipleBankAccounts', LEDGER_TWICE);
  if (b.accountIds.length === 0) warn('strNoAccountsAttached', 'Не е прикачена нито една счетоводна сметка');
  // Duplicates (CheckForDuplicates): name, bulstat (not placeholder), code.
  const conds = [sql`lower(${s.companies.name}) = lower(${b.name})`];
  if (bulstat && bulstat !== BULSTAT_PLACEHOLDER) conds.push(eq(s.companies.bulstat, bulstat));
  if (b.code?.trim()) conds.push(eq(s.companies.code, b.code.trim()));
  const dup = await db.select().from(s.companies)
    .where(and(eq(s.companies.isDeleted, false), selfId ? ne(s.companies.id, selfId) : undefined, or(...conds))).limit(1);
  const d = dup[0];
  if (d) {
    if (bulstat && d.bulstat === bulstat && bulstat !== BULSTAT_PLACEHOLDER) crit('strCompanyBulstatExists', 'Вече съществува партньор с такъв ЕИК');
    else if (d.name.toLowerCase() === b.name.toLowerCase()) crit('strCompanyNameExists', 'Вече съществува партньор с такова име.');
    else crit('strCompanyCodeExists', 'Вече съществува партньор с такъв код');
  }
  if (b.accountIds.length) {
    // The account or one of its ancestors must carry a partner category (03a 2.9).
    const all = await db.select({ id: s.accounts.id, parentId: s.accounts.parentId, number: s.accounts.number, cat: s.accounts.accountCategoryId }).from(s.accounts);
    const byId = new Map(all.map((a) => [a.id, a]));
    for (const id of b.accountIds) {
      let a = byId.get(id);
      const number = a?.number;
      let ok = false;
      while (a) {
        if (isCompanyCategory(a.cat)) { ok = true; break; }
        a = a.parentId != null ? byId.get(a.parentId) : undefined;
      }
      if (!ok) crit('strAccountDoesNotSupportCompanies', `Сметка ${number ?? id}: Избраната сметка не може да бъде добавена, тъй като не поддържа работа с партньори!`);
    }
  }
  return msgs;
}

async function savePartnerChildren(db: DbOrTx, id: number, b: PartnerBody) {
  await db.delete(s.companyAccounts).where(eq(s.companyAccounts.companyId, id));
  if (b.accountIds.length) await db.insert(s.companyAccounts).values([...new Set(b.accountIds)].map((accountId) => ({ companyId: id, accountId })));
  await db.delete(s.addresses).where(and(eq(s.addresses.ownerType, 'company'), eq(s.addresses.ownerId, id)));
  if (b.addresses.length) await db.insert(s.addresses).values(b.addresses.map((a, i) => ({ ...a, id: undefined, ownerType: 'company', ownerId: id, isPrimary: i === 0 })));
  await db.delete(s.bankAccounts).where(and(eq(s.bankAccounts.ownerType, 'company'), eq(s.bankAccounts.ownerId, id)));
  if (b.bankAccounts.length) {
    await db.insert(s.bankAccounts).values(await Promise.all(b.bankAccounts.map(async (ba) => ({
      ownerType: 'company', ownerId: id, account: normalizeIban(ba.account), bankId: ba.bankId ?? (await bankIdFromIban(db, ba.account)),
      bankStatementAccountId: ba.bankStatementAccountId ?? null, isEuro: ba.isEuro ?? false,
    }))));
  }
}

async function bankIdFromIban(db: DbOrTx, iban: string) {
  const code = bankCodeFromIban(iban);
  if (!code) return null;
  const [b] = await db.select().from(s.banks).where(ilike(s.banks.code, `${code}%`)).limit(1);
  return b?.id ?? null;
}

async function loadPartner(db: DbOrTx, id: number) {
  const [p] = await db.select().from(s.companies).where(eq(s.companies.id, id));
  if (!p) throw notFound('Партньорът');
  const accounts = await db.select({ id: s.accounts.id, number: s.accounts.number, description: s.accounts.description })
    .from(s.companyAccounts).innerJoin(s.accounts, eq(s.accounts.id, s.companyAccounts.accountId)).where(eq(s.companyAccounts.companyId, id));
  const addresses = await db.select().from(s.addresses).where(and(eq(s.addresses.ownerType, 'company'), eq(s.addresses.ownerId, id)));
  const bankAccounts = await db.select().from(s.bankAccounts).where(and(eq(s.bankAccounts.ownerType, 'company'), eq(s.bankAccounts.ownerId, id)));
  return { ...p, priority: p.priority === 1, accounts, accountIds: accounts.map((a) => a.id), addresses, bankAccounts };
}

const myCompanyBody = z.object({
  name: z.string().trim().max(255),
  name1: z.string().max(255).nullable().optional(),
  contactName: z.string().max(255).nullable().optional(),
  contactName1: z.string().max(255).nullable().optional(),
  contactPosition: z.string().max(255).nullable().optional(),
  accountant: z.string().max(255).default(''),
  accountant1: z.string().max(255).nullable().optional(),
  email: z.string().max(255).nullable().optional(),
  bulstat: z.string().trim().max(50).default(''),
  vatId: z.string().trim().max(50).nullable().optional(),
  vatDeclarationSubscriberName: z.string().max(255).nullable().optional(),
  vatDeclarationSubscriberEgn: z.string().max(50).nullable().optional(),
  vatDeclarationSubscriberPosition: z.string().max(255).nullable().optional(),
  vatDeclarationSubscriberRole: z.number().int().nullable().optional(),
  isVat: z.boolean().default(false),
  isNotVat: z.boolean().default(false),
  addresses: z.array(addressBody).max(3).default([]),
  bankAccounts: z.array(bankAccountBody).default([]),
});

const LEDGER_TWICE = 'Една счетоводна сметка не може да бъде обвързана с повече от една банкова сметка!';
/** 03a 7.2: among normal (and among online) bank accounts a ledger account is linked at most once. */
export function hasLedgerAccountTwice(rows: { bankStatementAccountId?: number | null; isOnlineAccount?: boolean | null }[]) {
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.bankStatementAccountId == null) continue;
    const k = `${r.isOnlineAccount ? 'o' : 'n'}${r.bankStatementAccountId}`;
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

const rate = z.string().regex(/^\d+(\.\d+)?$/, 'Невалиден курс.');
const currencyBody = z.object({ isoCode: z.string().trim().max(50).optional(), name: z.string().trim().max(50).optional(), exchangeRate: rate.optional(), fixedRate: rate.optional() });

/** 03a 5.3: name required; ISO code of exactly 3 characters (length only), unique by exact match. */
async function validateCurrency(db: DbOrTx, b: { name?: string; isoCode?: string }, exceptId?: number) {
  const msgs: ValidationMessage[] = [];
  if (!b.name?.trim()) msgs.push({ key: 'strCurrencyNameError', text: 'Не е попълнено име на валута!', severity: 'critical' });
  const iso = b.isoCode ?? '';
  if (iso.length !== 3) msgs.push({ key: 'strCurrencyCodeLengthError', text: 'Зададен е невалиден код на валутата. Кодът трябва да се състои от три главни латински букви.', severity: 'critical' });
  else {
    const dup = await db.select({ id: s.currencies.id }).from(s.currencies).where(eq(s.currencies.isoCode, iso));
    if (dup.some((d) => d.id !== exceptId)) msgs.push({ key: 'strCurrencyCodeUniquenessError', text: 'Валута със зададения код вече съществува в базата от данни. Моля, задайте друг код.', severity: 'critical' });
  }
  if (msgs.length) throw new ApiError(422, 'Валутата не може да бъде записана.', msgs);
}

const countryBody = z.object({ code: z.string().max(10), name: z.string().max(200), nameInOtherLang: z.string().max(200).default('') });
/** 03a 6: name and a 1-3 character code required; foreign name only warns; no uniqueness. */
function validateCountry(b: z.infer<typeof countryBody>) {
  const msgs: ValidationMessage[] = [];
  if (!b.name.length) msgs.push({ key: 'strCountriesNameIsNotAdded', text: 'Не е въведено име на държава.', severity: 'critical' });
  else if (b.name.length > 80) msgs.push({ key: 'strNameIncorectFormat', text: 'Некоректен формат на име', severity: 'critical' });
  if (!b.code.length) msgs.push({ key: 'strCountriesCodeIsNotAdded', text: 'Не е въведен код на държава (от 1 до 3 символа).', severity: 'critical' });
  else if (b.code.length > 3) msgs.push({ key: 'strCodeIncorectFormat', text: 'Некоректен формат на код', severity: 'critical' });
  if (b.nameInOtherLang.length > 80) msgs.push({ key: 'strNameInOtherLangIncorectFormat', text: 'Некоректен формат на име на чужд език', severity: 'critical' });
  else if (!b.nameInOtherLang.length) msgs.push({ key: 'strCountriesNameInOtherLangIsNotAdded', text: 'Не е въведено име на държава на чужд език.', severity: 'warning' });
  if (msgs.some((m) => m.severity === 'critical')) throw new ApiError(422, 'Държавата не може да бъде записана.', msgs);
  return msgs;
}

const DICT_COLUMNS: Record<string, string[]> = { terms: ['term_id'], references: ['reference_id', 'optional_reference_id'], paragraphs: ['paragraph_id'] };
const DICT_TEXTS: Record<string, { one: string }> = {
  terms: { one: 'Избраните основания не могат да бъдат изтрити, защото участват в операции от тип Покупка/Продажба.' },
  references: { one: 'Избраните забележки не могат да бъдат изтрити, защото участват в операции от тип Покупка/Продажба.' },
  paragraphs: { one: 'Избраните параграфи не могат да бъдат изтрити, защото участват в операции от тип Покупка/Продажба.' },
};

/** Rename (all postings follow) and merge into an existing equal description (spDublicatedTerms / References). */
async function renameDictionary(db: DbOrTx, type: string, id: number, description: string, isHidden?: boolean) {
  const t = dictionaryTable(type);
  const cols = DICT_COLUMNS[type]!;
  const [row] = await db.select().from(t).where(eq(t.id, id));
  if (!row) throw notFound('Описанието');
  const [keeper] = await db.select().from(t).where(and(eq(t.description, description), sql`${t.id} <> ${id}`)).limit(1);
  if (keeper) {
    for (const col of cols) await db.execute(sql`UPDATE accountings SET ${sql.raw(col)} = ${keeper.id} WHERE ${sql.raw(col)} = ${id}`);
    await db.update(t).set({ usageFrequency: sql`${t.usageFrequency} + ${type === 'terms' ? row.usageFrequency : 0}`, ...(isHidden !== undefined ? { isHidden } : {}) }).where(eq(t.id, keeper.id));
    await db.delete(t).where(eq(t.id, id));
    return { ...keeper, merged: true };
  }
  const [updated] = await db.update(t).set({ description, ...(isHidden !== undefined ? { isHidden } : {}) }).where(eq(t.id, id)).returning();
  return updated;
}

/** Real deletion; refused when used in a Purchase or Sale posting, otherwise unlinked from every posting (03a 8.1). */
async function deleteDictionary(db: DbOrTx, type: string, id: number) {
  const t = dictionaryTable(type);
  const cols = DICT_COLUMNS[type]!;
  const usedIn = sql.join(cols.map((c) => sql`${sql.raw(c)} = ${id}`), sql` OR `);
  const sale = await exec(db, sql`SELECT 1 FROM accountings WHERE (${usedIn}) AND transaction_type_id IN (2, 3) LIMIT 1`);
  if (sale.rows.length) throw badRequest(DICT_TEXTS[type]!.one);
  for (const col of cols) await db.execute(sql`UPDATE accountings SET ${sql.raw(col)} = NULL WHERE ${sql.raw(col)} = ${id}`);
  await db.delete(t).where(eq(t.id, id));
}

const branchBody = z.object({
  code: z.string().max(50),
  name: z.string().max(50),
  contactName: z.string().max(50).nullable().optional(),
  address: addressBody.nullable().optional(),
});

function checkBranch(b: z.infer<typeof branchBody>) {
  const msgs: ValidationMessage[] = [];
  if (!b.name.trim()) msgs.push({ key: 'strBranchNameIsEmpty', text: 'Не е попълнено име на клона!', severity: 'critical' });
  if (!b.code.trim()) msgs.push({ key: 'strBranchCodeIsEmpty', text: 'Не е попълнен код на клона!', severity: 'critical' });
  if (msgs.length) throw new ApiError(422, 'Клонът не може да бъде записан:', msgs);
}

const dictionaryTable = (type: string) => {
  if (type === 'terms') return s.terms;
  if (type === 'references') return s.referenceTexts;
  if (type === 'paragraphs') return s.paragraphs;
  throw badRequest('Невалиден тип.');
};

export const nomenclatureRoutes = new Hono<AppEnv>()
  // ---- Lookups used by every screen ----
  .get('/lookups', async (c) => {
    const { db } = c.var;
    const [documentTypes, vatTerms, transactionTypes, vieses, icaTypes, currencies, countries, banks, addressTypes, branches, groups] = await Promise.all([
      db.select().from(s.documentTypes).orderBy(asc(s.documentTypes.position)),
      db.select().from(s.vatTerms).orderBy(asc(s.vatTerms.id)),
      db.select().from(s.transactionTypes).orderBy(asc(s.transactionTypes.id)),
      db.select().from(s.vieses).orderBy(asc(s.vieses.id)),
      db.select().from(s.icaTypes).orderBy(asc(s.icaTypes.id)),
      db.select().from(s.currencies).orderBy(asc(s.currencies.id)),
      db.select().from(s.countries).where(eq(s.countries.isDeleted, false)).orderBy(asc(s.countries.name)),
      db.select().from(s.banks).where(eq(s.banks.isDeleted, false)).orderBy(asc(s.banks.name)),
      db.select().from(s.addressTypes).orderBy(asc(s.addressTypes.id)),
      db.select().from(s.branches).where(eq(s.branches.isDeleted, false)).orderBy(asc(s.branches.id)),
      db.select().from(s.companyGroups).where(eq(s.companyGroups.isDeleted, false)).orderBy(asc(s.companyGroups.leftIndex)),
    ]);
    return c.json({ documentTypes, vatTerms, transactionTypes, vieses, icaTypes, currencies, countries, banks, addressTypes, branches, companyGroups: groups });
  })

  // ---- Partners (Партньори, Ctrl+P) ----
  .get('/partners', async (c) => {
    const { db } = c.var;
    const q = c.req.query('q')?.trim();
    const accountId = c.req.query('accountId');
    const includeUnused = c.req.query('all') === '1';
    const conds = [eq(s.companies.isDeleted, false)];
    if (!includeUnused) conds.push(eq(s.companies.isNotUsing, false));
    if (q) conds.push(or(ilike(s.companies.name, `%${q}%`), ilike(s.companies.bulstat, `%${q}%`), ilike(s.companies.vatNumber, `%${q}%`), ilike(s.companies.code, `%${q}%`))!);
    if (accountId) conds.push(sql`${s.companies.id} IN (SELECT company_id FROM company_accounts WHERE account_id = ${Number(accountId)})`);
    if (c.req.query('groupId')) conds.push(eq(s.companies.groupId, Number(c.req.query('groupId'))));
    const rows = await db.select({
      id: s.companies.id, name: s.companies.name, bulstat: s.companies.bulstat, vatNumber: s.companies.vatNumber,
      isVat: s.companies.isVat, priority: s.companies.priority, groupId: s.companies.groupId, isNotUsing: s.companies.isNotUsing,
      contactName: s.companies.contactName, dueDays: s.companies.dueDays,
      city: sql<string | null>`(SELECT city FROM addresses ad WHERE ad.owner_type = 'company' AND ad.owner_id = companies.id ORDER BY ad.is_primary DESC, ad.id LIMIT 1)`,
      address: sql<string | null>`(SELECT address FROM addresses ad WHERE ad.owner_type = 'company' AND ad.owner_id = companies.id ORDER BY ad.is_primary DESC, ad.id LIMIT 1)`,
    }).from(s.companies).where(and(...conds)).orderBy(desc(s.companies.priority), asc(s.companies.name)).limit(Number(c.req.query('limit') ?? 500));
    return c.json(rows);
  })

  /** Online lookup of a partner by EIK / VAT number (03a 2.5; VIES). */
  .get('/partners/lookup', requirePermission('UI_Edit_Companies'), async (c) => {
    const q = c.req.query();
    return c.json(await lookupCompany({ bulstat: q.bulstat, vatNumber: q.vatNumber, name: q.name }));
  })

  .get('/partners/:id', async (c) => c.json(await loadPartner(c.var.db, Number(c.req.param('id')))))

  .post('/partners/validate', zValidator('json', partnerBody.extend({ id: z.number().int().optional() })), async (c) => {
    const b = c.req.valid('json');
    return c.json(await validatePartner(c.var.db, b, b.id));
  })

  .post('/partners', requirePermission('UI_Edit_Companies'), zValidator('json', partnerBody), async (c) => {
    const b = c.req.valid('json');
    const { db, user } = c.var;
    const result = await db.transaction(async (tx) => {
      const msgs = await validatePartner(tx, b);
      if (msgs.some((m) => m.severity === 'critical')) throw new ApiError(422, 'Партньорът не може да бъде записан:', msgs);
      const [row] = await tx.insert(s.companies).values({
        ...b, priority: b.priority ? 1 : 0, bulstat: b.bulstat || null, vatNumber: b.vatNumber || null,
        lastModifiedDate: new Date(),
      }).returning();
      await savePartnerChildren(tx, row!.id, b);
      await logActivity(tx, user.id, 'add', 'partner', row!.id, b.name);
      return { id: row!.id, warnings: msgs };
    });
    return c.json(result, 201);
  })

  .put('/partners/:id', requirePermission('UI_Edit_Companies'), zValidator('json', partnerBody), async (c) => {
    const id = Number(c.req.param('id'));
    const b = c.req.valid('json');
    const { db, user } = c.var;
    const result = await db.transaction(async (tx) => {
      const msgs = await validatePartner(tx, b, id);
      if (msgs.some((m) => m.severity === 'critical')) throw new ApiError(422, 'Партньорът не може да бъде записан:', msgs);
      // Accounts used with this partner cannot be detached.
      const used = await exec(tx, sql`SELECT DISTINCT account_id FROM accounting_details WHERE company_id = ${id}`);
      const usedIds = (used.rows as { account_id: number }[]).map((r) => r.account_id).filter((a) => !b.accountIds.includes(a));
      const linked = usedIds.length ? await tx.select().from(s.companyAccounts).where(and(eq(s.companyAccounts.companyId, id), inArray(s.companyAccounts.accountId, usedIds))) : [];
      if (linked.length) throw badRequest('Сметката не може да бъде изтрита, защото участва в операции.');
      await tx.update(s.companies).set({
        ...b, priority: b.priority ? 1 : 0, bulstat: b.bulstat || null, vatNumber: b.vatNumber || null, lastModifiedDate: new Date(),
      }).where(eq(s.companies.id, id));
      await savePartnerChildren(tx, id, b);
      await logActivity(tx, user.id, 'edit', 'partner', id, b.name);
      return { id, warnings: msgs };
    });
    return c.json(result);
  })

  .delete('/partners/:id', requirePermission('UI_Edit_Companies'), async (c) => {
    const id = Number(c.req.param('id'));
    const { db, user } = c.var;
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(s.accountingDetails).where(eq(s.accountingDetails.companyId, id))) as [{ n: number }];
    if (n > 0) throw badRequest('Партньорът не може да бъде изтрит, тъй като участва в операции!');
    await db.transaction(async (tx) => {
      await tx.update(s.companies).set({ isDeleted: true, groupId: 1 }).where(eq(s.companies.id, id));
      await tx.delete(s.companyAccounts).where(eq(s.companyAccounts.companyId, id));
      await logActivity(tx, user.id, 'delete', 'partner', id);
    });
    return c.json({ ok: true });
  })

  // Partner groups (nested set kept by rebuild; the tree is small).
  .post('/partner-groups', requirePermission('UI_Edit_Companies'), zValidator('json', z.object({ name: z.string().trim().max(50).optional(), parentId: z.number().int().default(1) })), async (c) => {
    const { db } = c.var;
    const b = c.req.valid('json');
    let name = b.name;
    if (!name) {
      // strNewGroup + smallest free integer among the parent's children.
      const sibs = await db.select({ name: s.companyGroups.name }).from(s.companyGroups).where(and(eq(s.companyGroups.parentId, b.parentId), eq(s.companyGroups.isDeleted, false)));
      const used = new Set(sibs.map((x) => x.name));
      let n = 1;
      while (used.has(`Нова група ${n}`)) n++;
      name = `Нова група ${n}`;
    }
    const [row] = await db.insert(s.companyGroups).values({ name, parentId: b.parentId }).returning();
    await rebuildGroupTree(db);
    return c.json(row, 201);
  })
  .put('/partner-groups/:id', requirePermission('UI_Edit_Companies'), zValidator('json', z.object({ name: z.string().trim().min(1).max(50), parentId: z.number().int().optional() })), async (c) => {
    const id = Number(c.req.param('id'));
    if (id === 1) throw badRequest('Основната група не може да бъде редактирана.');
    await c.var.db.update(s.companyGroups).set(c.req.valid('json')).where(eq(s.companyGroups.id, id));
    await rebuildGroupTree(c.var.db);
    return c.json({ ok: true });
  })
  .delete('/partner-groups/:id', requirePermission('UI_Edit_Companies'), async (c) => {
    const id = Number(c.req.param('id'));
    const { db } = c.var;
    if (id === 1) throw badRequest('Основната група не може да бъде изтрита.');
    const subs = await db.select().from(s.companyGroups).where(and(eq(s.companyGroups.parentId, id), eq(s.companyGroups.isDeleted, false)));
    if (subs.length) throw badRequest('Избраната група не може да бъде изтрита, тъй като съдържа подгрупи!');
    const members = await db.select({ id: s.companies.id }).from(s.companies).where(and(eq(s.companies.groupId, id), eq(s.companies.isDeleted, false))).limit(1);
    if (members.length) throw badRequest('Избраната група не може да бъде изтрита, тъй като не е празна!');
    await db.delete(s.companyGroups).where(eq(s.companyGroups.id, id));
    await rebuildGroupTree(db);
    return c.json({ ok: true });
  })

  // ---- Branches of the own company (Клонове, 03a 2.8) ----
  .get('/branches', async (c) => {
    const { db } = c.var;
    const rows = await db.select().from(s.branches).where(eq(s.branches.isDeleted, false)).orderBy(asc(s.branches.id));
    const addrs = rows.length ? await db.select().from(s.addresses).where(and(eq(s.addresses.ownerType, 'branch'), inArray(s.addresses.ownerId, rows.map((r) => r.id)))) : [];
    return c.json(rows.map((r) => ({ ...r, address: addrs.find((a) => a.ownerId === r.id) ?? null })));
  })
  .post('/branches', requirePermission('UI_Edit_Administration_MyCompany'), zValidator('json', branchBody), async (c) => {
    const b = c.req.valid('json');
    checkBranch(b);
    const id = await c.var.db.transaction(async (tx) => {
      const [row] = await tx.insert(s.branches).values({ code: b.code.trim(), name: b.name.trim(), contactName: b.contactName ?? null }).returning();
      if (b.address) await tx.insert(s.addresses).values({ ...b.address, id: undefined, ownerType: 'branch', ownerId: row!.id, isPrimary: true });
      return row!.id;
    });
    return c.json({ id }, 201);
  })
  .put('/branches/:id', requirePermission('UI_Edit_Administration_MyCompany'), zValidator('json', branchBody), async (c) => {
    const id = Number(c.req.param('id'));
    const b = c.req.valid('json');
    checkBranch(b);
    await c.var.db.transaction(async (tx) => {
      await tx.update(s.branches).set({ code: b.code.trim(), name: b.name.trim(), contactName: b.contactName ?? null }).where(eq(s.branches.id, id));
      await tx.delete(s.addresses).where(and(eq(s.addresses.ownerType, 'branch'), eq(s.addresses.ownerId, id)));
      if (b.address) await tx.insert(s.addresses).values({ ...b.address, id: undefined, ownerType: 'branch', ownerId: id, isPrimary: true });
    });
    return c.json({ ok: true });
  })
  .delete('/branches/:id', requirePermission('UI_Edit_Administration_MyCompany'), async (c) => {
    const id = Number(c.req.param('id'));
    const { db, session } = c.var;
    if (id === 1) throw badRequest('Основният клон не може да бъде изтрит.');
    if ((session.state.branchId ?? 1) === id) throw badRequest('Активният клон не може да бъде изтрит.');
    const used = await db.select({ id: s.accountings.id }).from(s.accountings).where(eq(s.accountings.branchId, id)).limit(1);
    if (used.length) throw badRequest('Избраният клон не може да бъде изтрит, тъй като участва в операции!');
    await db.update(s.branches).set({ isDeleted: true }).where(eq(s.branches.id, id));
    return c.json({ ok: true });
  })

  // ---- Own company (Моята фирма, Ctrl+F) ----
  .get('/my-company', async (c) => {
    const { db } = c.var;
    const [m] = await db.select().from(s.myCompany).limit(1);
    const addresses = await db.select().from(s.addresses).where(and(eq(s.addresses.ownerType, 'my'), eq(s.addresses.ownerId, m!.id)));
    const bankAccounts = await db.select().from(s.bankAccounts).where(and(eq(s.bankAccounts.ownerType, 'my'), eq(s.bankAccounts.ownerId, m!.id)));
    return c.json({ ...m, addresses, bankAccounts });
  })
  .put('/my-company', requirePermission('UI_Edit_Administration_MyCompany'), zValidator('json', myCompanyBody), async (c) => {
    const { db, session } = c.var;
    const b = c.req.valid('json');
    // 03a 3.2 (MyCompanyViewModel).
    const msgs: ValidationMessage[] = [];
    const m3 = (key: string, text: string, severity: ValidationMessage['severity'] = 'warning') => msgs.push({ key, text, severity });
    if (!b.name.trim()) m3('strMyCompanyNameIsEmpty', 'Не е попълнено име на фирмата', 'critical');
    if (!b.bulstat) m3('strMyCompanyBulstatIsEmpty', 'Не е попълнен ЕИК за фирмата');
    else if (!isValidEik(b.bulstat)) m3('strInvalidBulstat', 'Невалиден ЕИК');
    if (b.isVat && !b.vatId?.trim()) m3('strMyCompanyVatNumberIsEmpty', 'Не е попълнен данъчен номер за фирмата', 'critical');
    if (!b.contactName?.trim()) m3('strMyCompanyContactNameIsEmpty', 'Не е въведен МОЛ на фирмата');
    if (b.email?.trim() && !isEmail(b.email.trim())) m3('strInvalidEmail', 'Невалиден e-mail адрес');
    if (b.isVat) {
      if (!b.vatDeclarationSubscriberName?.trim()) m3('strMyCompanyVATSubscriberNameIsEmpty', 'Не е попълнено име на подаващия ДДС декларацията');
      if (!isValidEgn(b.vatDeclarationSubscriberEgn ?? '')) m3('strMyCompanyVATSubscriberEGNIsInvalid', 'ЕГН на подаващия ДДС декларацията е невалидeн');
      if (!b.vatDeclarationSubscriberPosition?.trim()) m3('strMyCompanyVATSubscriberPositionIsEmpty', 'Не е попълнена длъжност за СД на подаващия ДДС декларацията');
    }
    if (b.isVat && b.isNotVat) m3('strVatFlags', 'Фирмата не може едновременно да е регистрирана и да не подлежи на регистрация по ЗДДС.', 'critical');
    for (const ba of b.bankAccounts) {
      if (!ba.account.trim()) m3('strBankAccountNumberIsEmpty', 'Не е попълнен IBAN!', 'critical');
      else if (!isValidIban(ba.account)) m3('strInvalidIBAN', 'Въведен е невалиден IBAN!');
    }
    if (hasLedgerAccountTwice(b.bankAccounts)) m3('strErrorAccountWithMultipleBankAccounts', LEDGER_TWICE, 'critical');
    if (msgs.some((m) => m.severity === 'critical')) throw new ApiError(422, 'Данните не могат да бъдат записани:', msgs);
    const [m] = await db.select().from(s.myCompany).limit(1);
    const { addresses, bankAccounts, ...fields } = b;
    await db.transaction(async (tx) => {
      await tx.update(s.myCompany).set(fields).where(eq(s.myCompany.id, m!.id));
      await tx.update(s.system).set({ companyName: b.name });
      await tx.delete(s.addresses).where(and(eq(s.addresses.ownerType, 'my'), eq(s.addresses.ownerId, m!.id)));
      if (addresses.length) await tx.insert(s.addresses).values(addresses.map((a, i) => ({ ...a, id: undefined, ownerType: 'my', ownerId: m!.id, isPrimary: i === 0 })));
      await tx.delete(s.bankAccounts).where(and(eq(s.bankAccounts.ownerType, 'my'), eq(s.bankAccounts.ownerId, m!.id)));
      if (bankAccounts.length) await tx.insert(s.bankAccounts).values(await Promise.all(bankAccounts.map(async (ba) => ({
        ownerType: 'my', ownerId: m!.id, account: normalizeIban(ba.account), bankId: ba.bankId ?? (await bankIdFromIban(tx, ba.account)),
        bankStatementAccountId: ba.bankStatementAccountId ?? null, isEuro: ba.isEuro ?? false,
      }))));
    });
    // Name sync: System.CompanyName, MyCompany.Name and the catalog row (spec 01a 10).
    const catalog = await c.var.driver.catalog();
    const { companiesCatalog } = await import('../db/catalog/schema.ts');
    await catalog.update(companiesCatalog).set({ companyName: b.name }).where(eq(companiesCatalog.name, session.companyDb!));
    return c.json({ ok: true, warnings: msgs });
  })

  // ---- Currencies ----
  .get('/currencies', async (c) => c.json(await c.var.db.select().from(s.currencies).orderBy(asc(s.currencies.id))))
  .post('/currencies', requirePermission('UI_Edit_Currencies'), zValidator('json', currencyBody), async (c) => {
    const b = c.req.valid('json');
    await validateCurrency(c.var.db, b);
    const rate = b.exchangeRate ?? b.fixedRate ?? '1';
    const [row] = await c.var.db.insert(s.currencies).values({ isoCode: b.isoCode!, name: b.name!, exchangeRate: rate, fixedRate: b.fixedRate ?? rate }).returning();
    return c.json(row, 201);
  })
  .put('/currencies/:id', requirePermission('UI_Edit_Currencies'), zValidator('json', currencyBody.extend({ rateDate: z.string().optional() })), async (c) => {
    const id = Number(c.req.param('id'));
    const b = c.req.valid('json');
    const [cur] = await c.var.db.select().from(s.currencies).where(eq(s.currencies.id, id));
    if (!cur) throw notFound('Валутата');
    if (['BGN', 'EUR'].includes(cur.isoCode) && (b.exchangeRate || b.fixedRate || (b.isoCode !== undefined && b.isoCode !== cur.isoCode))) throw badRequest('Курсът на лева и еврото е фиксиран.');
    await validateCurrency(c.var.db, { name: b.name ?? cur.name, isoCode: b.isoCode ?? cur.isoCode }, id);
    const [row] = await c.var.db.update(s.currencies).set(b).where(eq(s.currencies.id, id)).returning();
    return c.json(row);
  })
  .delete('/currencies/:id', requirePermission('UI_Edit_Currencies'), async (c) => {
    const id = Number(c.req.param('id'));
    const [cur] = await c.var.db.select().from(s.currencies).where(eq(s.currencies.id, id));
    if (!cur) throw notFound('Валутата');
    if (['BGN', 'EUR'].includes(cur.isoCode)) throw badRequest('Основните валути не могат да бъдат изтрити.');
    const used = await exec(c.var.db, sql`SELECT 1 FROM accounts WHERE currency_id = ${id} UNION ALL SELECT 1 FROM accounting_details WHERE currency_id = ${id} LIMIT 1`);
    if (used.rows.length) throw badRequest('Валутата не може да бъде изтрита, защото се използва за аналитичност на една или повече сметки.');
    await c.var.db.delete(s.currencies).where(eq(s.currencies.id, id));
    return c.json({ ok: true });
  })

  // ---- Countries ----
  .get('/countries', async (c) => c.json(await c.var.db.select().from(s.countries).where(eq(s.countries.isDeleted, false)).orderBy(asc(s.countries.name))))
  .post('/countries', requirePermission('UI_Edit_Administration_EditTermsAndReferences'), zValidator('json', countryBody), async (c) => {
    const warnings = validateCountry(c.req.valid('json'));
    const [row] = await c.var.db.insert(s.countries).values(c.req.valid('json')).returning();
    return c.json({ ...row, warnings }, 201);
  })
  .put('/countries/:id', requirePermission('UI_Edit_Administration_EditTermsAndReferences'), zValidator('json', countryBody), async (c) => {
    const warnings = validateCountry(c.req.valid('json'));
    const [row] = await c.var.db.update(s.countries).set(c.req.valid('json')).where(eq(s.countries.id, Number(c.req.param('id')))).returning();
    return c.json({ ...row, warnings });
  })
  .delete('/countries/:id', requirePermission('UI_Edit_Administration_EditTermsAndReferences'), async (c) => {
    const id = Number(c.req.param('id'));
    const used = await c.var.db.select({ id: s.addresses.id }).from(s.addresses).where(eq(s.addresses.countryId, id)).limit(1);
    if (used.length) throw badRequest('Държавата не може да бъде изтрита, тъй като е избрана към партньор/и.');
    await c.var.db.update(s.countries).set({ isDeleted: true }).where(eq(s.countries.id, id));
    return c.json({ ok: true });
  })

  // ---- Banks ----
  .get('/banks', async (c) => c.json(await c.var.db.select().from(s.banks).where(eq(s.banks.isDeleted, false)).orderBy(asc(s.banks.name))))
  .get('/banks/by-iban/:iban', async (c) => {
    const id = await bankIdFromIban(c.var.db, c.req.param('iban'));
    const [b] = id ? await c.var.db.select().from(s.banks).where(eq(s.banks.id, id)) : [];
    return c.json({ valid: isValidIban(c.req.param('iban')), bank: b ?? null });
  })

  // ---- Terms / references / paragraphs (Основания и забележки) ----
  .get('/dictionary/:type', async (c) => {
    const t = dictionaryTable(c.req.param('type'));
    const q = c.req.query('q')?.trim();
    const all = c.req.query('all') === '1';
    const rows = await c.var.db.select().from(t)
      .where(and(all ? undefined : eq(t.isHidden, false), q ? ilike(t.description, `%${q}%`) : undefined))
      .orderBy(desc(t.usageFrequency), asc(t.description)).limit(Number(c.req.query('limit') ?? 50));
    return c.json(rows);
  })
  // 03a 8.1: adding an existing description is skipped; renaming onto an existing one merges them.
  .post('/dictionary/:type', requirePermission('UI_Edit_Administration_EditTermsAndReferences'), zValidator('json', z.object({ description: z.string().trim().min(1).max(254), isHidden: z.boolean().optional() })), async (c) => {
    const t = dictionaryTable(c.req.param('type'));
    const b = c.req.valid('json');
    const [existing] = await c.var.db.select().from(t).where(eq(t.description, b.description)).limit(1);
    if (existing) return c.json(existing, 200);
    const [row] = await c.var.db.insert(t).values(b).returning();
    return c.json(row, 201);
  })
  .put('/dictionary/:type/:id', requirePermission('UI_Edit_Administration_EditTermsAndReferences'), zValidator('json', z.object({ description: z.string().trim().min(1).max(254), isHidden: z.boolean().optional() })), async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    const r = await c.var.db.transaction((tx) => renameDictionary(tx, type, id, c.req.valid('json').description, c.req.valid('json').isHidden));
    return c.json(r);
  })
  .delete('/dictionary/:type/:id', requirePermission('UI_Edit_Administration_EditTermsAndReferences'), async (c) => {
    const type = c.req.param('type');
    await c.var.db.transaction((tx) => deleteDictionary(tx, type, Number(c.req.param('id'))));
    return c.json({ ok: true });
  })

  // ---- Products (Дефиниране на СМЗ) ----
  .get('/products', async (c) => {
    const q = c.req.query('q')?.trim();
    const rows = await c.var.db.select().from(s.products)
      .where(and(eq(s.products.isDeleted, false), q ? or(ilike(s.products.name, `%${q}%`), ilike(s.products.code, `%${q}%`)) : undefined))
      .orderBy(asc(s.products.name));
    return c.json(rows);
  })
  .post('/products', requirePermission('UI_Operations_Products_DefineProducts'), zValidator('json', z.object({
    name: z.string().trim().min(1).max(255), code: z.string().max(50).nullable().optional(), measure: z.string().trim().min(1).max(50),
    price: z.string().default('0'),
  })), async (c) => {
    const [row] = await c.var.db.insert(s.products).values(c.req.valid('json')).returning();
    return c.json(row, 201);
  })
  .put('/products/:id', requirePermission('UI_Operations_Products_DefineProducts'), zValidator('json', z.object({
    name: z.string().trim().min(1).max(255), code: z.string().max(50).nullable().optional(), measure: z.string().trim().min(1).max(50),
    price: z.string().default('0'),
  })), async (c) => {
    const [row] = await c.var.db.update(s.products).set(c.req.valid('json')).where(eq(s.products.id, Number(c.req.param('id')))).returning();
    return c.json(row);
  })
  .delete('/products/:id', requirePermission('UI_Operations_Products_DefineProducts'), async (c) => {
    const id = Number(c.req.param('id'));
    const used = await c.var.db.select({ id: s.accountingDetails.id }).from(s.accountingDetails).where(eq(s.accountingDetails.productId, id)).limit(1);
    if (used.length) throw badRequest('Стоката участва в операции и не може да бъде изтрита.');
    await c.var.db.update(s.products).set({ isDeleted: true }).where(eq(s.products.id, id));
    return c.json({ ok: true });
  })

  // ---- Validator (Проверка на ДДС номер, ЕИК, ЕГН, IBAN) ----
  .get('/validator/:code', (c) => c.json(detectIdentifier(c.req.param('code'))));

async function rebuildGroupTree(db: DbOrTx) {
  const rows = await db.select().from(s.companyGroups).where(eq(s.companyGroups.isDeleted, false));
  const kids = new Map<number | null, typeof rows>();
  for (const r of rows) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r]);
  let n = 1;
  const visit = async (r: (typeof rows)[number], level: number) => {
    const left = n++;
    for (const k of (kids.get(r.id) ?? []).sort((a, b) => a.id - b.id)) await visit(k, level + 1);
    await db.update(s.companyGroups).set({ leftIndex: left, rightIndex: n++, level }).where(eq(s.companyGroups.id, r.id));
  };
  const root = rows.find((r) => r.id === 1);
  if (root) await visit(root, 1);
}
