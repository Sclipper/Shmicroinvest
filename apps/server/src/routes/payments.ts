import { Hono } from 'hono';
import { z } from 'zod';
import { CLOSING_MODES } from '@shmi/core';
import type { AppEnv } from '../context.ts';
import { zValidator } from '../lib/validate.ts';
import { requirePermission } from '../session.ts';
import { peekDocumentNumber } from '../services/autoEntries.ts';
import { closeDocumentsForImport, proposeClosing, saveClosing } from '../services/documentsClosing.ts';
import {
  bindCandidates, bindDocuments, createPayment, deleteLink, deleteLinksOf, listLinks,
  partnerOpenItems, partnersWithBalances, paymentSettings, setPaymentAccount, validateAutoPayment, type PartnerTab,
} from '../services/payments.ts';

const PAY = 'UI_Operations_Payments';
const CLOSE = 'UI_Operations_AutoOperations_DocumentsClosing';

const amount = z.string().regex(/^-?\d+(\.\d+)?$/, 'Невалидна сума.');
const optAmount = amount.nullable().optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.number().int().positive();
const bindRow = z.object({ accountingId: id, amount: optAmount, currencyAmount: optAmount });

const paymentBody = z.object({
  companyId: id,
  accountId: id,
  paymentAccountId: z.number().int(),
  date,
  documentTypeId: z.number().int().nullable().optional(),
  documentNumber: z.string().max(50).nullable().optional(),
  documentDate: date.nullable().optional(),
  term: z.string().max(255).default(''),
  reference: z.string().max(255).nullable().optional(),
  amount,
  currencyAmount: optAmount,
  exchangeRate: optAmount,
  allocations: z.array(bindRow).default([]),
});

const bindBody = z.object({ accountId: id, companyId: id, liabilities: z.array(bindRow), payments: z.array(bindRow) });

const autoBody = z.object({
  paymentAccountId: z.number().int().nullable(),
  documentTypeId: z.number().int().nullable().optional(),
  documentNumber: z.string().max(50).nullable().optional(),
});

const closingFilter = z.object({
  endDate: date.optional(),
  companyId: id.optional(),
  companyName: z.string().optional(),
  accountNumber: z.string().optional(),
  documentNumber: z.string().optional(),
});

const ctxOf = (c: { var: AppEnv['Variables'] }) => ({ year: c.var.year, userId: c.var.user.id, branchId: c.var.session.state.branchId ?? 1 });
const num = (v: string | undefined) => (v ? Number(v) : undefined);

export const paymentsRoutes = new Hono<AppEnv>()
  /** Left pane of F3: partners with open items. */
  .get('/payments/partners', requirePermission(PAY), async (c) => {
    const q = c.req.query();
    const tab = (['all', 'suppliers', 'clients'].includes(q.tab ?? '') ? q.tab : 'all') as PartnerTab;
    return c.json(await partnersWithBalances(c.var.db, c.var.year, { tab, accountNumber: q.account, inCurrency: q.inCurrency === '1', q: q.q }));
  })

  /** Centre and right panes of F3 for one partner. */
  .get('/payments/open-items', requirePermission(PAY), async (c) => {
    const q = c.req.query();
    if (!q.companyId) return c.json({ liabilities: [], payments: [], balance: '0.00', currencyBalance: '0.00' });
    return c.json(await partnerOpenItems(c.var.db, c.var.year, {
      companyId: Number(q.companyId), accountNumber: q.account, accountId: num(q.accountId),
      from: q.from, to: q.to, documentNumber: q.number, inCurrency: q.inCurrency === '1',
    }));
  })

  /** Open documents of one account and partner (BindingDocumentsView). */
  .get('/payments/candidates', async (c) => {
    const q = c.req.query();
    if (!q.accountId || !q.companyId) return c.json([]);
    return c.json(await bindCandidates(c.var.db, c.var.year, Number(q.accountId), Number(q.companyId), num(q.exclude)));
  })

  /** Remembered payment account (config PaymentAccount) and next ПКО/РКО numbers. */
  .get('/payments/settings', async (c) => {
    const { db, year, user } = c.var;
    const s = await paymentSettings(db, user.id);
    return c.json({ ...s, nextCashReceipt: await peekDocumentNumber(db, 8, year.id), nextCashPayment: await peekDocumentNumber(db, 9, year.id) });
  })

  .put('/payments/settings', zValidator('json', z.object({ paymentAccountId: z.number().int().nullable() })), async (c) => {
    await setPaymentAccount(c.var.db, c.var.user.id, c.req.valid('json').paymentAccountId);
    return c.json({ ok: true });
  })

  /** Разплащане (NewPaymentView): paying entry plus allocations, one transaction. */
  .post('/payments', requirePermission(PAY), zValidator('json', paymentBody), async (c) => {
    const input = c.req.valid('json');
    const r = await c.var.db.transaction(async (tx) => {
      const out = await createPayment(tx, ctxOf(c), input);
      await setPaymentAccount(tx, c.var.user.id, input.paymentAccountId);
      return out;
    });
    return c.json(r, 201);
  })

  /** Обвързване of selected liabilities with selected existing payments. */
  .post('/payments/bind', requirePermission(PAY), zValidator('json', bindBody), async (c) => {
    const input = c.req.valid('json');
    return c.json(await c.var.db.transaction((tx) => bindDocuments(tx, c.var.year, input, c.var.user.id)), 201);
  })

  /** EditPaymentsView: links filtered by partner, period, term, document. */
  .get('/payments/links', requirePermission(PAY), async (c) => {
    const q = c.req.query();
    return c.json(await listLinks(c.var.db, {
      companyId: num(q.companyId), accountingId: num(q.accountingId), startDate: q.from, endDate: q.to,
      term: q.term, documentTypeId: num(q.documentTypeId), documentNumber: q.number,
    }));
  })

  .delete('/payments/links/:id', requirePermission(PAY), async (c) => {
    await c.var.db.transaction((tx) => deleteLink(tx, Number(c.req.param('id')), c.var.user.id));
    return c.json({ ok: true });
  })

  /** "Изтриване на връзки" of the selected entries. */
  .post('/payments/links/delete', requirePermission(PAY), zValidator('json', z.object({ accountingIds: z.array(id) })), async (c) => {
    const n = await c.var.db.transaction((tx) => deleteLinksOf(tx, c.req.valid('json').accountingIds, c.var.user.id));
    return c.json({ deleted: n });
  })

  /** Pre-save checks of the entry editor's "Автоматично разплащане". */
  .post('/payments/validate-auto', zValidator('json', autoBody.extend({
    lines: z.array(z.object({ accountId: z.number().int(), companyId: z.number().int().nullable().optional() })),
  })), async (c) => {
    const { lines, ...o } = c.req.valid('json');
    return c.json({ messages: await validateAutoPayment(c.var.db, o, { lines }) });
  })

  /** Закриване на документи: proposals. */
  .get('/documents-closing', requirePermission(CLOSE), async (c) => {
    const q = c.req.query();
    const mode = CLOSING_MODES.find((m) => m.id === q.mode)?.id ?? 'amount';
    return c.json({
      modes: CLOSING_MODES,
      pairs: await proposeClosing(c.var.db, c.var.year, {
        mode, endDate: q.to, companyId: num(q.companyId), companyName: q.company, accountNumber: q.account, documentNumber: q.number,
      }),
    });
  })

  .post('/documents-closing', requirePermission(CLOSE), zValidator('json', closingFilter.extend({
    pairs: z.array(z.object({ liabilityAccountingId: id, paymentAccountingId: id })),
  })), async (c) => {
    const { pairs, ...f } = c.req.valid('json');
    const r = await c.var.db.transaction((tx) => saveClosing(tx, c.var.year, f, pairs, c.var.user.id));
    return c.json({ links: r }, 201);
  })

  /** CloseDocumentsForImport for imported entries (bank/Excel import). */
  .post('/documents-closing/import', requirePermission(CLOSE), zValidator('json', z.object({ accountingIds: z.array(id) })), async (c) => {
    const r = await c.var.db.transaction((tx) => closeDocumentsForImport(tx, c.var.year, c.req.valid('json').accountingIds, c.var.user.id));
    return c.json({ links: r }, 201);
  });
