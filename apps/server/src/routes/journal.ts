import { Hono } from 'hono';
import { zValidator } from '../lib/validate.ts';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { CHANNEL } from '@shmi/core';
import type { AppEnv } from '../context.ts';
import { exec } from '../db/provider.ts';
import { requirePermission, workingDate } from '../session.ts';
import { deleteEntry, loadEntry, reversalDraft, saveEntry } from '../services/journal.ts';
import { peekNextNumber } from '../services/sequences.ts';
import { journalLines } from '../services/reports.ts';
import { entryFilterConditions } from '../services/journalExtras.ts';

const amount = z.string().regex(/^-?\d+(\.\d+)?$/, 'Невалидна сума.');
const optAmount = amount.nullable().optional();
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
  debits: z.array(lineBody).min(1),
  credits: z.array(lineBody).min(1),
  force: z.boolean().optional(),
});

const ADD = 'UI_Operations_Accounting';
const EDIT = 'UI_Edit_Accountings';
const DELETE = 'UI_Edit_Accountings_DeleteAccounting';

export const journalRoutes = new Hono<AppEnv>()
  /**
   * Operations list (Журнал на операциите): one row per entry with its
   * correspondences collapsed, filtered by period and free text, paged.
   */
  .get('/entries', async (c) => {
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

  /** Chronological register lines (Хронологичен регистър): debit/credit pairs. */
  .get('/journal-lines', async (c) => {
    const { year } = c.var;
    const q = c.req.query();
    return c.json(await journalLines(c.var.db, {
      startDate: q.from ?? `${year.year}-01-01`, endDate: q.to ?? `${year.year}-12-31`,
      byExportMonth: q.byExportMonth === '1',
      debitAccount: q.debit, creditAccount: q.credit, account: q.account,
      companyIds: q.companyId ? [Number(q.companyId)] : undefined,
      documentTypeId: q.documentTypeId ? Number(q.documentTypeId) : undefined,
      text: q.text, limit: q.limit ? Number(q.limit) : 5000,
    }));
  })

  .get('/entries/next-number', async (c) => c.json({ number: await peekNextNumber(c.var.db, CHANNEL.Accounting, c.var.year.id, c.var.user.id) }))

  .get('/entries/:id', async (c) => c.json(await loadEntry(c.var.db, Number(c.req.param('id')))))

  .get('/entries/:id/reversal', requirePermission(ADD), async (c) =>
    c.json(await reversalDraft(c.var.db, Number(c.req.param('id')), workingDate(c.var.session))))

  .post('/entries', requirePermission(ADD), zValidator('json', entryBody), async (c) => {
    const { force, ...input } = c.req.valid('json');
    const { db, year, user, session } = c.var;
    const r = await db.transaction((tx) => saveEntry(tx, input, { year, userId: user.id, branchId: session.state.branchId ?? 1, force }));
    return c.json(r, 201);
  })

  .put('/entries/:id', requirePermission(EDIT), zValidator('json', entryBody), async (c) => {
    const { force, ...input } = c.req.valid('json');
    const { db, year, user, session } = c.var;
    const r = await db.transaction((tx) => saveEntry(tx, input, { year, userId: user.id, branchId: session.state.branchId ?? 1, force }, Number(c.req.param('id'))));
    return c.json(r);
  })

  .delete('/entries/:id', requirePermission(DELETE), async (c) => {
    const { db, year, user } = c.var;
    await db.transaction((tx) => deleteEntry(tx, Number(c.req.param('id')), year, user.id));
    return c.json({ ok: true });
  });
