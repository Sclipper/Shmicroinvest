import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { bankModelProperties, msg, type FormulaToken } from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { AppEnv } from '../context.ts';
import { ApiError, notFound } from '../lib/errors.ts';
import { zValidator } from '../lib/validate.ts';
import { requirePermission, workingDate } from '../session.ts';
import { logActivity } from '../services/audit.ts';
import { getConfig, setConfig } from '../services/config.ts';
import {
  EXCLUDED_IBANS_KEY, addDefaultTemplates, bindIbanToPartner, keywords, listTemplates, ownBankAccounts, parseStatementFile, postStatementRows, saveTemplate,
  validateTemplate, type TemplateInput,
} from '../services/exchange/bank.ts';
import { importStep, readUpload } from '../services/exchange/common.ts';

const IMPORT = 'UI_Operations_BankStatements_BankStatementsImport';
const TEMPLATES = 'UI_Operations_BankStatements_BankTemplatesImport';

const tokenBody = z.object({ type: z.enum(['property', 'operation', 'string', 'number']), value: z.string() });
const templateBody = z.object({
  bankId: z.number().int(),
  name: z.string().max(255),
  debitAccountId: z.number().int().nullable().optional(),
  creditAccountId: z.number().int().nullable().optional(),
  termText: z.string().max(255).optional(),
  referenceText: z.string().max(255).optional(),
  companyId: z.number().int().nullable().optional(),
  isOwnAccounts: z.boolean().optional(),
  mergeRowsOnImport: z.boolean().optional(),
  priority: z.number().int().min(1).max(10).optional(),
  formula: z.union([z.string(), z.array(tokenBody)]),
});

export const bankRoutes = new Hono<AppEnv>()
  .get('/bank-statements/accounts', requirePermission(IMPORT), async (c) => c.json(await ownBankAccounts(c.var.db)))
  .get('/bank-statements/banks', async (c) => {
    const banks = await c.var.db.select().from(s.banks).where(eq(s.banks.isDeleted, false));
    return c.json(banks.map((b) => ({ ...b, properties: bankModelProperties(b.code) })));
  })
  .get('/bank-statements/keywords', requirePermission(IMPORT), async (c) => c.json(await keywords(c.var.db)))
  .post('/bank-statements/keywords', requirePermission(IMPORT), zValidator('json', z.object({ word: z.string().max(50) })), async (c) => {
    const word = c.req.valid('json').word.trim();
    if (!word) throw new ApiError(400, 'Въведете ключова дума.');
    await keywords(c.var.db);
    const [row] = await c.var.db.insert(s.bankImportKeywords).values({ word }).returning();
    return c.json(row, 201);
  })
  .delete('/bank-statements/keywords/:id', requirePermission(IMPORT), async (c) => {
    await c.var.db.delete(s.bankImportKeywords).where(eq(s.bankImportKeywords.id, Number(c.req.param('id'))));
    return c.json({ ok: true });
  })
  .get('/bank-statements/excluded-ibans', requirePermission(IMPORT), async (c) => c.json({ value: (await getConfig(c.var.db, EXCLUDED_IBANS_KEY)) ?? '' }))
  .put('/bank-statements/excluded-ibans', requirePermission(IMPORT), zValidator('json', z.object({ value: z.string().max(2000) })), async (c) => {
    await setConfig(c.var.db, EXCLUDED_IBANS_KEY, c.req.valid('json').value);
    return c.json({ ok: true });
  })
  /** Wizard step: reads the file and proposes postings (Alt+F1). */
  .post('/bank-statements/parse', requirePermission(IMPORT), async (c) => {
    const up = await readUpload(c);
    const o = z.object({
      bankAccountId: z.coerce.number().int(), termProperty: z.string().optional(), referenceProperty: z.string().optional(),
      mergeCriteria: z.enum(['none', 'all', 'date', 'month']).optional(), autoBind: z.boolean().optional(),
    }).parse(up.fields);
    const r = await importStep(() => parseStatementFile(c.var.db, up, o, { year: c.var.year, userId: c.var.user.id, today: workingDate(c.var.session) }), false);
    return c.json(r);
  })
  /** Apply: posts the given rows (the current page). */
  .post('/bank-statements/post', requirePermission(IMPORT), zValidator('json', z.object({
    customDocumentNumber: z.string().max(50).optional(),
    ownAccountsTransfer: z.boolean().optional(),
    force: z.boolean().optional(),
    rows: z.array(z.object({
      index: z.number().int(), date: z.string(), debitAccountId: z.number().int().nullable(), creditAccountId: z.number().int().nullable(),
      companyId: z.number().int().nullable(), companyName: z.string().optional(), term: z.string().max(255), reference: z.string().max(255).optional(),
      postAmount: z.string(), currencyAmount: z.string().nullable().optional(), exchangeRate: z.string().nullable().optional(),
      templateId: z.number().int().nullable().optional(), isOwnAccounts: z.boolean().optional(), documents: z.array(z.number().int()).optional(),
    })).min(1),
  })), async (c) => {
    const body = c.req.valid('json');
    const r = await importStep(() => c.var.db.transaction((tx) => postStatementRows(tx, body.rows, body, { year: c.var.year, userId: c.var.user.id, today: workingDate(c.var.session) })), false);
    await logActivity(c.var.db, c.var.user.id, 'import', 'bank', null, `Банково извлечение: ${r.posted} контирания`);
    return c.json(r);
  })
  .post('/bank-statements/bind-iban', requirePermission(IMPORT), zValidator('json', z.object({ companyId: z.number().int(), iban: z.string().max(50) })), async (c) => {
    const b = c.req.valid('json');
    const [p] = await c.var.db.select().from(s.companies).where(eq(s.companies.id, b.companyId));
    if (!p) throw notFound('Партньорът');
    await bindIbanToPartner(c.var.db, b.companyId, b.iban);
    return c.json({ ok: true, message: msg('strBindIbanToPartnerConfirm', b.iban, p.name) });
  })

  // ------------------------------------------------------------------ posting rules (03a 9)
  .get('/bank-templates', requirePermission(TEMPLATES), async (c) => {
    const bankId = Number(c.req.query('bankId')) || null;
    return c.json(await listTemplates(c.var.db, bankId, c.var.year.year >= 2026));
  })
  .post('/bank-templates/validate', requirePermission(TEMPLATES), zValidator('json', templateBody), async (c) => {
    return c.json(await validateTemplate(c.var.db, c.req.valid('json') as TemplateInput));
  })
  .post('/bank-templates', requirePermission(TEMPLATES), zValidator('json', templateBody), async (c) => {
    const r = await c.var.db.transaction((tx) => saveTemplate(tx, c.req.valid('json') as TemplateInput, c.var.user.id));
    return c.json(r, 201);
  })
  .put('/bank-templates/:id', requirePermission(TEMPLATES), zValidator('json', templateBody), async (c) => {
    const id = Number(c.req.param('id'));
    const [t] = await c.var.db.select().from(s.bankTemplates).where(eq(s.bankTemplates.id, id));
    if (!t) throw notFound('Шаблонът');
    return c.json(await c.var.db.transaction((tx) => saveTemplate(tx, c.req.valid('json') as TemplateInput, c.var.user.id, id)));
  })
  .post('/bank-templates/:id/copy', requirePermission(TEMPLATES), async (c) => {
    const id = Number(c.req.param('id'));
    const [t] = await c.var.db.select().from(s.bankTemplates).where(eq(s.bankTemplates.id, id));
    if (!t) throw notFound('Шаблонът');
    const r = await c.var.db.transaction(async (tx) => {
      const { id: _id, createdAt, ...rest } = t;
      void _id; void createdAt;
      const [n] = await tx.insert(s.bankTemplates).values({ ...rest, name: msg('strCopyAccountingTemplate', t.name).slice(0, 255) }).returning({ id: s.bankTemplates.id });
      const details = await tx.select().from(s.bankTemplateDetails).where(eq(s.bankTemplateDetails.templateId, id));
      if (details.length) await tx.insert(s.bankTemplateDetails).values(details.map(({ id: _d, ...d }) => ({ ...d, templateId: n!.id })));
      return n!;
    });
    return c.json(r, 201);
  })
  /** "Възстановяване на условието": restores the default formula. */
  .post('/bank-templates/:id/restore-condition', requirePermission(TEMPLATES), async (c) => {
    const id = Number(c.req.param('id'));
    const [t] = await c.var.db.select().from(s.bankTemplates).where(eq(s.bankTemplates.id, id));
    if (!t) throw notFound('Шаблонът');
    await c.var.db.update(s.bankTemplates).set({ formula: t.defaultFormula as FormulaToken[] }).where(eq(s.bankTemplates.id, id));
    return c.json({ formula: t.defaultFormula });
  })
  .delete('/bank-templates/:id', requirePermission(TEMPLATES), async (c) => {
    await c.var.db.delete(s.bankTemplates).where(eq(s.bankTemplates.id, Number(c.req.param('id'))));
    return c.json({ ok: true });
  })
  .post('/bank-templates/defaults', requirePermission(TEMPLATES), zValidator('json', z.object({ bankId: z.number().int() })), async (c) => {
    const n = await c.var.db.transaction((tx) => addDefaultTemplates(tx, c.req.valid('json').bankId, c.var.user.id));
    return c.json({ added: n });
  });
