import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { dec, round2 } from '@shmi/core';
import type { AppEnv } from '../context.ts';
import * as s from '../db/company/schema/index.ts';
import { exec } from '../db/provider.ts';
import { zValidator } from '../lib/validate.ts';
import { notFound } from '../lib/errors.ts';
import { requirePermission, workingDate } from '../session.ts';
import { deleteEntry, loadEntry, saveEntry } from '../services/journal.ts';
import {
  addAttachment, assertCorrespondence, copyDraft, correspondenceToEntry, duplicateDocuments, entryFilterConditions, expensesDraft,
  group60Drafts, listAttachments, listCorrespondences, massEdit, neighbor, reorder, REORDER_TYPES, saveFastEntry, saveReversal,
  validateFastEntry, voidCheck, voidMany,
} from '../services/journalExtras.ts';
import { logActivity } from '../services/audit.ts';

const ADD = 'UI_Operations_Accounting';
const DELETE = 'UI_Edit_Accountings_DeleteAccounting';
const EDIT = 'UI_Edit_Accountings';
const FAST = 'UI_Operations_FastAccounting';
const MASS = 'UI_Edit_Administration_EditAccountings';
const REORDER = 'UI_Edit_Administration_ReorderDocuments';
const CORRESPONDENCE = 'UI_Operations_ChartOfAccounts_InitialCorrespondence';

const amount = z.string().regex(/^-?\d+(\.\d+)?$/, 'Невалидна сума.');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.number().int();
const optId = id.nullable().optional();
const ids = z.object({ ids: z.array(id) });

const fastRow = z.object({
  templateId: optId,
  documentTypeId: id.nullable(),
  documentNumber: z.string().max(50).default(''),
  date,
  debitAccountId: id.nullable(),
  creditAccountId: id.nullable(),
  amount,
  debitVatTermId: optId,
  creditVatTermId: optId,
  companyId: optId,
  term: z.string().max(255).default(''),
  paymentAccountId: optId,
});

const massBody = z.object({
  ids: z.array(id),
  newAccountingDate: date.nullable().optional(),
  newDocumentDate: date.nullable().optional(),
  newViesMonth: date.nullable().optional(),
  newCompanyId: optId,
  newTerm: z.string().max(255).nullable().optional(),
  newReference: z.string().max(255).nullable().optional(),
  newOptionalReference: z.string().max(255).nullable().optional(),
  newParagraph: z.string().max(255).nullable().optional(),
  fromDebitAccount: z.string().max(30).nullable().optional(),
  fromCreditAccount: z.string().max(30).nullable().optional(),
  newAccount: z.string().max(30).nullable().optional(),
  force: z.boolean().optional(),
});

const correspondenceBody = z.object({
  date: date.nullable().optional(),
  debitAccountId: id,
  creditAccountId: id,
  amount,
  debitCompanyId: optId,
  creditCompanyId: optId,
  documentTypeId: optId,
  documentNumber: z.string().max(50).nullable().optional(),
  documentDate: date.nullable().optional(),
  debitCurrencyAmount: amount.nullable().optional(),
  creditCurrencyAmount: amount.nullable().optional(),
  debitQuantity: amount.nullable().optional(),
  creditQuantity: amount.nullable().optional(),
});

const ctxOf = (c: { var: AppEnv['Variables'] }, force?: boolean) => ({ year: c.var.year, userId: c.var.user.id, branchId: c.var.session.state.branchId ?? 1, force });

export const journalExtraRoutes = new Hono<AppEnv>()
  // ---- 5.3 copy, 7 navigation, 4.4 duplicate document --------------------
  .get('/journal/entries/:id/copy', requirePermission(ADD), async (c) =>
    c.json(await copyDraft(c.var.db, Number(c.req.param('id')), workingDate(c.var.session))))

  .get('/journal/entries/:id/neighbor', async (c) => {
    const dir = c.req.query('dir') === 'prev' ? 'prev' : 'next';
    return c.json({ entry: await neighbor(c.var.db, c.var.year, Number(c.req.param('id')), dir) });
  })

  .get('/journal/duplicate-document', async (c) => {
    const q = c.req.query();
    if (!q.documentTypeId || !q.documentNumber?.trim()) return c.json({ rows: [] });
    return c.json({
      rows: await duplicateDocuments(c.var.db, {
        documentTypeId: Number(q.documentTypeId), documentNumber: q.documentNumber,
        companyId: q.companyId ? Number(q.companyId) : null, transactionTypeId: q.transactionTypeId ? Number(q.transactionTypeId) : null,
        excludeId: q.excludeId ? Number(q.excludeId) : null,
      }),
    });
  })

  // ---- 5.1 void, 5.2 reversal -------------------------------------------
  .post('/journal/void-check', zValidator('json', ids), async (c) => c.json({ rows: await voidCheck(c.var.db, c.req.valid('json').ids) }))

  .post('/journal/void', requirePermission(DELETE), zValidator('json', ids), async (c) => {
    const { db, year, user } = c.var;
    return c.json(await db.transaction((tx) => voidMany(tx, c.req.valid('json').ids, year, user.id)));
  })

  .post('/journal/entries/:id/reversal', requirePermission(ADD), async (c) => {
    const { db, session } = c.var;
    const r = await db.transaction((tx) => saveReversal(tx, Number(c.req.param('id')), workingDate(session), ctxOf(c, true)));
    return c.json(r, 201);
  })

  // ---- 4.6 attachments ---------------------------------------------------
  .get('/journal/entries/:id/attachments', async (c) => c.json({ rows: await listAttachments(c.var.db, Number(c.req.param('id'))) }))

  /** Raw file body; name and description in the query string. */
  .post('/journal/entries/:id/attachments', requirePermission(EDIT), async (c) => {
    const fileName = c.req.query('fileName') ?? '';
    const data = new Uint8Array(await c.req.arrayBuffer());
    const r = await addAttachment(c.var.db, Number(c.req.param('id')), {
      fileName, description: c.req.query('description') ?? '', mimeType: c.req.header('content-type'), data,
    }, c.var.user.id);
    return c.json(r, 201);
  })

  .get('/journal/attachments/:id/download', async (c) => {
    const [a] = await c.var.db.select().from(s.accountingAttachments).where(eq(s.accountingAttachments.id, Number(c.req.param('id'))));
    if (!a) throw notFound('Файлът');
    return c.body(a.data as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': a.mimeType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
    });
  })

  .delete('/journal/attachments/:id', requirePermission(EDIT), async (c) => {
    const { db, user } = c.var;
    const [a] = await db.delete(s.accountingAttachments).where(eq(s.accountingAttachments.id, Number(c.req.param('id'))))
      .returning({ accountingId: s.accountingAttachments.accountingId, fileName: s.accountingAttachments.fileName });
    if (!a) throw notFound('Файлът');
    await logActivity(db, user.id, 'edit', 'accounting', a.accountingId, `Премахнат файл ${a.fileName}`);
    return c.json({ ok: true });
  })

  // ---- 6 mass edit (Редакция на контировки) ------------------------------
  /** Entries matching the AccountingFilter; the screen shows them for selection. */
  .get('/journal/mass-edit/search', requirePermission(MASS), async (c) => {
    const { db, year } = c.var;
    const where = sql.join(entryFilterConditions(c.req.query(), year), sql` AND `);
    const r = await exec(db, sql`
      SELECT a.id, a.number, a.accounting_date, a.vies_month, doc.number AS document_number, doc.date AS document_date, dt.short_name AS document_type,
        t.description AS term, r.description AS reference,
        (SELECT co.name FROM accounting_details x JOIN companies co ON co.id = x.company_id WHERE x.accounting_id = a.id LIMIT 1) AS company,
        (SELECT sum(x.amount) FROM accounting_details x WHERE x.accounting_id = a.id AND x.sign = 1) AS amount,
        (SELECT string_agg(DISTINCT da.number, ', ') FROM accounting_details x JOIN accounts da ON da.id = x.account_id WHERE x.accounting_id = a.id AND x.sign = 1) AS debit_accounts,
        (SELECT string_agg(DISTINCT ca.number, ', ') FROM accounting_details x JOIN accounts ca ON ca.id = x.account_id WHERE x.accounting_id = a.id AND x.sign = -1) AS credit_accounts
      FROM accountings a
      LEFT JOIN documents doc ON doc.id = a.document_id
      LEFT JOIN document_types dt ON dt.id = doc.document_type_id
      LEFT JOIN terms t ON t.id = a.term_id
      LEFT JOIN reference_texts r ON r.id = a.reference_id
      WHERE ${where}
      ORDER BY a.accounting_date, a.number, a.id
      LIMIT 5000`);
    return c.json({ rows: r.rows });
  })

  .post('/journal/mass-edit', requirePermission(MASS), zValidator('json', massBody), async (c) => {
    const { db, year, user } = c.var;
    return c.json(await db.transaction((tx) => massEdit(tx, c.req.valid('json'), year, user.id)));
  })

  // ---- 8.1 fast entry ----------------------------------------------------
  .post('/journal/fast-entry/validate', requirePermission(FAST), zValidator('json', z.object({ rows: z.array(fastRow) })), async (c) => {
    const { messages } = await validateFastEntry(c.var.db, c.req.valid('json').rows, c.var.year);
    return c.json({ messages });
  })

  .post('/journal/fast-entry', requirePermission(FAST), zValidator('json', z.object({ rows: z.array(fastRow), force: z.boolean().optional() })), async (c) => {
    const { rows, force } = c.req.valid('json');
    const r = await c.var.db.transaction((tx) => saveFastEntry(tx, rows, ctxOf(c, true), !!force));
    return c.json(r, 201);
  })

  // ---- 3 renumbering ----------------------------------------------------
  .post('/journal/reorder', requirePermission(REORDER),
    zValidator('json', z.object({ type: z.enum(Object.keys(REORDER_TYPES) as [keyof typeof REORDER_TYPES]), by: z.enum(['number', 'date']) })), async (c) => {
      const { type, by } = c.req.valid('json');
      const { db, year, user } = c.var;
      return c.json(await db.transaction((tx) => reorder(tx, type, by, year, user.id)));
    })

  // ---- 4.7 group 60, 4.5 expenses distribution ----------------------------
  .get('/journal/entries/:id/group60-drafts', async (c) => c.json({ drafts: await group60Drafts(c.var.db, Number(c.req.param('id'))) }))

  .post('/journal/entries/:id/expenses-draft', requirePermission(ADD),
    zValidator('json', z.object({ amount, side: z.enum(['debit', 'credit']), base: z.enum(['amount', 'quantity']) })), async (c) =>
      c.json(await expensesDraft(c.var.db, Number(c.req.param('id')), c.req.valid('json'), c.var.year, workingDate(c.var.session))))

  // ---- 01b 7 initial correspondences --------------------------------------
  .get('/initial-correspondences', requirePermission(CORRESPONDENCE), async (c) => c.json(await listCorrespondences(c.var.db, c.var.year)))

  .post('/initial-correspondences', requirePermission(CORRESPONDENCE), zValidator('json', correspondenceBody), async (c) => {
    const { db, year } = c.var;
    const r = await db.transaction((tx) => saveEntry(tx, correspondenceToEntry(c.req.valid('json'), year), ctxOf(c, true)));
    return c.json(r, 201);
  })

  .get('/initial-correspondences/:id', requirePermission(CORRESPONDENCE), async (c) => {
    await assertCorrespondence(c.var.db, Number(c.req.param('id')), c.var.year);
    return c.json(await loadEntry(c.var.db, Number(c.req.param('id'))));
  })

  .put('/initial-correspondences/:id', requirePermission(CORRESPONDENCE), zValidator('json', correspondenceBody), async (c) => {
    const { db, year } = c.var;
    const entryId = Number(c.req.param('id'));
    await assertCorrespondence(db, entryId, year);
    return c.json(await db.transaction((tx) => saveEntry(tx, correspondenceToEntry(c.req.valid('json'), year), ctxOf(c, true), entryId)));
  })

  .delete('/initial-correspondences/:id', requirePermission(CORRESPONDENCE), async (c) => {
    const { db, year, user } = c.var;
    const entryId = Number(c.req.param('id'));
    await assertCorrespondence(db, entryId, year);
    await db.transaction((tx) => deleteEntry(tx, entryId, year, user.id));
    return c.json({ ok: true });
  })

  /** Current balance of accounts (IsAccountingBalanceEnabled, 02a 4.7): active year up to the date, opening balances included. */
  .get('/journal/account-balances', async (c) => {
    const { db, year } = c.var;
    const ids = (c.req.query('ids') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return c.json({ rows: [] });
    const date = c.req.query('date') || `${year.year}-12-31`;
    const exclude = Number(c.req.query('excludeId') ?? 0);
    const r = await exec(db, sql`
      SELECT d.account_id, coalesce(sum(d.amount) FILTER (WHERE d.sign = 1), 0) AS debit, coalesce(sum(d.ref_amount) FILTER (WHERE d.sign = -1), 0) AS credit
      FROM accounting_details d JOIN accountings a ON a.id = d.accounting_id
      WHERE a.financial_year_id = ${year.id} AND a.accounting_date <= ${date} AND a.id <> ${exclude} AND NOT a.is_initial_correspondence
        AND d.account_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      GROUP BY d.account_id`);
    const rows = (r.rows as { account_id: number; debit: string; credit: string }[]).map((x) => ({
      accountId: x.account_id, debit: round2(x.debit).toFixed(2), credit: round2(x.credit).toFixed(2), balance: round2(dec(x.debit).minus(x.credit)).toFixed(2),
    }));
    return c.json({ rows });
  })

  /** Count of entries per attachment presence (list column helper). */
  .get('/journal/attachments-count', async (c) => {
    const r = await c.var.db.select({ n: sql<number>`count(*)::int` }).from(s.accountingAttachments)
      .innerJoin(s.accountings, and(eq(s.accountings.id, s.accountingAttachments.accountingId), eq(s.accountings.financialYearId, c.var.year.id)));
    return c.json({ count: r[0]?.n ?? 0 });
  });
