import { Hono } from 'hono';
import { zValidator } from '../lib/validate.ts';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { CHANNEL } from '@shmi/core';
import type { AppEnv } from '../context.ts';
import { exec, type DbOrTx } from '../db/provider.ts';
import { requireAnyPermission, requirePermission, workingDate } from '../session.ts';
import { deleteEntry, loadEntry, reversalDraft, saveEntry, type SaveContext } from '../services/journal.ts';
import { autoPayment, bindEntry, fail, validateAutoPayment } from '../services/payments.ts';
import { peekNextNumber } from '../services/sequences.ts';
import { journalLines } from '../services/reports.ts';
import { journalFilterFromQuery } from './reports.ts';
import { entryFilterConditions } from '../services/journalExtras.ts';

const amount = z.string().regex(/^-?\d+(\.\d+)?$/, 'Невалидна сума.');
const optAmount = amount.nullable().optional();
const positiveAmount = z.string().regex(/^\d+(\.\d+)?$/, 'Невалидна сума.');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const lineBody = z.object({
  accountId: z.number().int(),
  amount,
  companyId: z.number().int().nullable().optional(),
  description: z.string().max(255).nullable().optional(),
  vatTermId: z.number().int().nullable().optional(),
  currencyAmount: optAmount,
  exchangeRate: optAmount,
  quantity: optAmount,
  price: optAmount,
  fixedRate: optAmount,
});

const entryBody = z.object({
  number: z.string().max(30).nullable().optional(),
  accountingDate: date,
  documentDate: date.nullable().optional(),
  documentTypeId: z.number().int().nullable(),
  documentNumber: z.string().max(50).nullable().optional(),
  companyId: z.number().int().nullable().optional(),
  term: z.string().max(255).default(''),
  reference: z.string().max(255).nullable().optional(),
  optionalReference: z.string().max(255).nullable().optional(),
  paragraph: z.string().max(255).nullable().optional(),
  transactionTypeId: z.number().int().optional(),
  viesId: z.number().int().nullable().optional(),
  viesMonth: date.nullable().optional(),
  dueDate: date.nullable().optional(),
  isInitialBalance: z.boolean().optional(),
  isInitialCorrespondence: z.boolean().optional(),
  source: z.string().max(30).optional(),
  icaType: z.number().int().optional(),
  deliveryDescription: z.string().nullable().optional(),
  /** Version from GET /entries/:id (optimistic concurrency, 01b 9); optional. */
  version: z.string().max(40).nullable().optional(),
  debits: z.array(lineBody).min(1),
  credits: z.array(lineBody).min(1),
  force: z.boolean().optional(),
  /** Entry editor: ask strAddAccountToCompanyConfirmation (409) and link the accounts with `force` (03a 2.9). */
  confirmAccountLinks: z.boolean().optional(),
  /** Entry editor: ask strAdd{Term|Reference|Paragraph}Confirmation (409) for texts not in their list (03a 8.1). */
  confirmTerms: z.boolean().optional(),
  /** Texts the user declined to add to the list: stored hidden. */
  hiddenTerms: z.array(z.enum(['term', 'reference', 'optionalReference', 'paragraph'])).optional(),
  /** Автоматично разплащане of the saved entry, in the same transaction. */
  payment: z.object({
    paymentAccountId: z.number().int().nullable(),
    documentTypeId: z.number().int().nullable().optional(),
    documentNumber: z.string().max(50).nullable().optional(),
  }).optional(),
  /** Обвързване of the saved entry with chosen documents, in the same transaction. */
  bindDocuments: z.array(z.object({ accountingId: z.number().int().positive(), amount: positiveAmount.nullable().optional(), currencyAmount: positiveAmount.nullable().optional() })).optional(),
});

/**
 * The entry editor's binding and auto payment run with the entry save, so a
 * failing payment leaves no entry without its payment (03a, EntryEditor).
 */
async function settle(tx: DbOrTx, ctx: SaveContext, entryId: number, input: Pick<EntryBody, 'debits' | 'credits' | 'companyId'>, payment?: EntryBody['payment'], documents?: EntryBody['bindDocuments']) {
  if (documents?.length) await bindEntry(tx, ctx.year, entryId, documents, ctx.userId);
  if (!payment) return;
  const lines = [...input.debits, ...input.credits].map((l) => ({ accountId: l.accountId, companyId: l.companyId ?? input.companyId ?? null }));
  const messages = await validateAutoPayment(tx, payment, { lines });
  if (messages.length) fail(messages);
  await autoPayment(tx, ctx, entryId, payment);
}
type EntryBody = z.infer<typeof entryBody>;

const ADD = 'UI_Operations_Accounting';
const EDIT = 'UI_Edit_Accountings';
const DELETE = 'UI_Edit_Accountings_DeleteAccounting';

export const journalRoutes = new Hono<AppEnv>()
  /**
   * Operations list (Журнал на операциите): one row per entry with its
   * correspondences collapsed, filtered by period and free text, paged.
   */
  .get('/entries', requirePermission(EDIT), async (c) => {
    const { db, year } = c.var;
    const q = c.req.query();
    const limit = Math.min(Number(q.limit ?? 200), 2000);
    const offset = Number(q.offset ?? 0);
    const conds = entryFilterConditions(q, year);
    const where = sql.join(conds, sql` AND `);
    const rows = await exec(db, sql`
      SELECT a.id, a.number, a.accounting_date, a.vies_month, a.is_initial_balance, a.source,
        doc.number AS document_number, doc.date AS document_date, dt.name AS document_type,
        t.description AS term, r.description AS reference,
        (SELECT co.name FROM accounting_details x JOIN companies co ON co.id = x.company_id WHERE x.accounting_id = a.id LIMIT 1) AS company,
        (SELECT sum(x.amount) FROM accounting_details x WHERE x.accounting_id = a.id AND x.sign = 1) AS amount,
        (SELECT string_agg(DISTINCT da.number, ', ') FROM accounting_details x JOIN accounts da ON da.id = x.account_id WHERE x.accounting_id = a.id AND x.sign = 1) AS debit_accounts,
        (SELECT string_agg(DISTINCT ca.number, ', ') FROM accounting_details x JOIN accounts ca ON ca.id = x.account_id WHERE x.accounting_id = a.id AND x.sign = -1) AS credit_accounts,
        u.name AS user_name,
        (SELECT count(*)::int FROM accounting_attachments x WHERE x.accounting_id = a.id) AS attachments
      FROM accountings a
      LEFT JOIN documents doc ON doc.id = a.document_id
      LEFT JOIN document_types dt ON dt.id = doc.document_type_id
      LEFT JOIN terms t ON t.id = a.term_id
      LEFT JOIN reference_texts r ON r.id = a.reference_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE ${where}
      ORDER BY a.accounting_date DESC, a.number DESC, a.id DESC
      LIMIT ${limit} OFFSET ${offset}`);
    const [{ total }] = (await exec(db, sql`
      SELECT count(*)::int AS total FROM accountings a
      LEFT JOIN documents doc ON doc.id = a.document_id
      LEFT JOIN terms t ON t.id = a.term_id
      LEFT JOIN reference_texts r ON r.id = a.reference_id
      WHERE ${where}`)).rows as [{ total: number }];
    return c.json({ rows: rows.rows, total });
  })

  /** Chronological register lines (Хронологичен регистър, 05 5): debit/credit pairs with every filter of the options screen. */
  .get('/journal-lines', requirePermission('UI_Reporting_ChronologicalReport'), async (c) => {
    const q = c.req.query();
    return c.json(await journalLines(c.var.db, {
      ...journalFilterFromQuery(q, c.var.year.year),
      mapToReportChart: true,
      limit: q.limit ? Math.min(Number(q.limit), 20000) : 5000,
    }));
  })

  .get('/entries/next-number', async (c) => c.json({ number: await peekNextNumber(c.var.db, CHANNEL.Accounting, c.var.year.id, c.var.user.id) }))

  // The entry editor opens entries for posting (Контиране) and for editing (Редакция на контиране).
  .get('/entries/:id', requireAnyPermission(ADD, EDIT), async (c) => c.json(await loadEntry(c.var.db, Number(c.req.param('id')))))

  .get('/entries/:id/reversal', requirePermission(ADD), async (c) =>
    c.json(await reversalDraft(c.var.db, Number(c.req.param('id')), workingDate(c.var.session))))

  .post('/entries', requirePermission(ADD), zValidator('json', entryBody), async (c) => {
    const { force, payment, bindDocuments, confirmAccountLinks, confirmTerms, hiddenTerms, ...input } = c.req.valid('json');
    const { db, year, user, session } = c.var;
    const ctx = { year, userId: user.id, branchId: session.state.branchId ?? 1 };
    const r = await db.transaction(async (tx) => {
      const saved = await saveEntry(tx, input, { ...ctx, force, confirm: true, confirmAccountLinks, confirmTerms, hiddenTerms });
      await settle(tx, ctx, saved.id, input, payment, bindDocuments);
      return saved;
    });
    return c.json(r, 201);
  })

  .put('/entries/:id', requirePermission(EDIT), zValidator('json', entryBody), async (c) => {
    const { force, payment, bindDocuments, confirmAccountLinks, confirmTerms, hiddenTerms, ...input } = c.req.valid('json');
    const { db, year, user, session } = c.var;
    const ctx = { year, userId: user.id, branchId: session.state.branchId ?? 1 };
    const r = await db.transaction(async (tx) => {
      const saved = await saveEntry(tx, input, { ...ctx, force, confirm: true, confirmAccountLinks, confirmTerms, hiddenTerms }, Number(c.req.param('id')));
      await settle(tx, ctx, saved.id, input, payment, bindDocuments);
      return saved;
    });
    return c.json(r);
  })

  .delete('/entries/:id', requirePermission(DELETE), async (c) => {
    const { db, year, user } = c.var;
    await db.transaction((tx) => deleteEntry(tx, Number(c.req.param('id')), year, user.id));
    return c.json({ ok: true });
  });
