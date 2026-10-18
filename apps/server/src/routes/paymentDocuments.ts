import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import {
  documentSumToText, encodeWindows1251, findBankByIban, formattedQtty, PAYMENT_DOCUMENT_MESSAGES, PAYMENT_DOCUMENT_PERMISSIONS,
  PAYMENT_DOCUMENT_TYPES_DEF, validatePaymentDocument, type PaymentDocumentTypeId,
} from '@shmi/core';
import * as s from '../db/company/schema/index.ts';
import type { AppEnv } from '../context.ts';
import { ApiError, forbidden, notFound } from '../lib/errors.ts';
import { zValidator } from '../lib/validate.ts';
import { workingDate } from '../session.ts';
import { logActivity } from '../services/audit.ts';
import {
  applicationNow, copyDraft, exportDocuments, getDocument, listDocuments, paymentsDiary, recentBranches, saveDocuments, softDelete,
  suggestions,
} from '../services/paymentDocuments.ts';

/** Payment documents (Платежни документи, spec 02c 1): registry per type, forms, diary, UBB export. */

const typeSchema = z.coerce.number().int().refine((t) => PAYMENT_DOCUMENT_PERMISSIONS[t] !== undefined, 'Невалиден тип на документа');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}/);
const str = z.string().nullable().optional();
const int = z.number().int().nullable().optional();

const documentBody = z.object({
  id: z.number().int().nullable().optional(),
  bankName: str, bankBranch: str, bankAddress: str, issuePlace: str, issueDate: str,
  personName: str, personIban: str, personBank: str, personBic: str,
  currency: str, qtty: z.union([z.string(), z.number()]).transform(String).nullable().optional(), inWords: str,
  autorizedPerson: str, idNumber: str, egn: str, lnch: str, receivedBy: str,
  customer: str, customerIban: str, customerBic: str, duePerson: str,
  reason: str, reasonEx: str, executionDate: str, taxes: int, paymentSystem: str, paymentType: int, paymentType2: int,
  documentDate: str, documentTypeCode: int, documentNumber: str, startDate: str, endDate: str,
  bulstat: str, ebkParagraph: str, kid: str, budgetCode: str, sebra: str, rowsCount: str, controlCode: str,
});

const idsBody = z.object({ ids: z.array(z.number().int()).max(5000) });

async function guard(c: Context<AppEnv>, type: number) {
  const key = PAYMENT_DOCUMENT_PERMISSIONS[type];
  if (!key || !(await c.var.can(key))) throw forbidden();
}

/** Loads the documents of an id list and checks the permission of their (single) type. */
async function guardIds(c: Context<AppEnv>, ids: number[]) {
  if (!ids.length) return null;
  const rows = await c.var.db.selectDistinct({ t: s.paymentDocuments.documentType }).from(s.paymentDocuments).where(inArray(s.paymentDocuments.id, ids));
  for (const r of rows) await guard(c, r.t);
  return rows.length === 1 ? rows[0]!.t : null;
}

export const paymentDocumentsRoutes = new Hono<AppEnv>()
  .get('/payment-documents', zValidator('query', z.object({
    type: typeSchema,
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    text: z.string().optional(),
    bankId: z.coerce.number().int().optional(),
    deleted: z.enum(['0', '1', 'true', 'false']).optional(),
  })), async (c) => {
    const q = c.req.valid('query');
    await guard(c, q.type);
    const docs = await listDocuments(c.var.db, {
      type: q.type, from: q.from, to: q.to, text: q.text, bankId: q.bankId, includeDeleted: q.deleted === '1' || q.deleted === 'true',
    });
    return c.json(docs);
  })

  .get('/payment-documents/suggestions', zValidator('query', z.object({ type: typeSchema })), async (c) => {
    const { type } = c.req.valid('query');
    await guard(c, type);
    return c.json(await suggestions(c.var.db, type));
  })

  .get('/payment-documents/branches', async (c) => c.json(await recentBranches(c.var.db)))

  .get('/payment-documents/bank-by-iban/:iban', async (c) => {
    const banks = await c.var.db.select({ id: s.banks.id, code: s.banks.code, name: s.banks.name }).from(s.banks).where(eq(s.banks.isDeleted, false));
    const bank = findBankByIban(decodeURIComponent(c.req.param('iban')), banks);
    return c.json(bank ? { id: 'id' in bank ? bank.id : null, code: bank.code, name: bank.name } : null);
  })

  .get('/payment-documents/diary', zValidator('query', z.object({ ids: z.string().regex(/^\d+(,\d+)*$/) })), async (c) => {
    const ids = c.req.valid('query').ids.split(',').map(Number);
    await guardIds(c, ids);
    return c.json(await paymentsDiary(c.var.db, ids));
  })

  .get('/payment-documents/:id{[0-9]+}', async (c) => {
    const d = await getDocument(c.var.db, Number(c.req.param('id')));
    if (!d) throw notFound('Документът');
    await guard(c, d.documentType);
    return c.json(d);
  })

  /** Validate(): the NonCritical messages of the form, plus the amount in words and the printed amount. */
  .post('/payment-documents/validate', zValidator('json', z.object({ type: typeSchema, document: documentBody })), async (c) => {
    const { type, document } = c.req.valid('json');
    await guard(c, type);
    return c.json({
      messages: validatePaymentDocument(type, document),
      inWords: documentSumToText(document.qtty, document.currency),
      formattedQtty: formattedQtty(document.qtty),
    });
  })

  /** ApplyChanges: writes every changed document of the list without a validation gate. */
  .post('/payment-documents/batch', zValidator('json', z.object({ type: typeSchema, documents: z.array(documentBody).max(1000) })), async (c) => {
    const { type, documents } = c.req.valid('json');
    await guard(c, type);
    const now = applicationNow(workingDate(c.var.session));
    let saved;
    try {
      saved = await c.var.db.transaction((tx) => saveDocuments(tx, c.var.user.id, type, documents, now));
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('payment document')) throw notFound('Документът');
      throw e;
    }
    return c.json({ documents: saved, message: PAYMENT_DOCUMENT_MESSAGES.strPaymentDocumentSaved });
  })

  /** "Нов документ от избрания": unsaved clone of the selected document. */
  .post('/payment-documents/:id{[0-9]+}/copy', async (c) => {
    const d = await getDocument(c.var.db, Number(c.req.param('id')));
    if (!d) throw notFound('Документът');
    await guard(c, d.documentType);
    return c.json(copyDraft(d, applicationNow(workingDate(c.var.session))));
  })

  .post('/payment-documents/delete', zValidator('json', idsBody.extend({ type: typeSchema })), async (c) => {
    const { ids, type } = c.req.valid('json');
    await guard(c, type);
    const deleted = await c.var.db.transaction((tx) => softDelete(tx, c.var.user.id, type, ids));
    return c.json({ deleted });
  })

  /** Print of the checked documents: refused for deleted ones; logs the print activity. */
  .post('/payment-documents/print', zValidator('json', idsBody), async (c) => {
    const { ids } = c.req.valid('json');
    await guardIds(c, ids);
    const rows = ids.length ? await c.var.db.select().from(s.paymentDocuments).where(inArray(s.paymentDocuments.id, ids)) : [];
    if (rows.some((r) => r.isDeleted)) {
      const m = { key: 'strCannotPrintDeletedDocuments', text: PAYMENT_DOCUMENT_MESSAGES.strCannotPrintDeletedDocuments, severity: 'critical' as const };
      throw new ApiError(422, m.text, [m]);
    }
    for (const r of rows) {
      const def = PAYMENT_DOCUMENT_TYPES_DEF[r.documentType as PaymentDocumentTypeId];
      await logActivity(c.var.db, c.var.user.id, 'print', def?.entityType ?? 'Document', r.id, def?.report);
    }
    return c.json({ ok: true, printed: rows.length });
  })

  /** "Експорт -> към ОББ": the Windows-1251 text file of the checked documents, or the refusal messages. */
  .post('/payment-documents/export', zValidator('json', idsBody.extend({ type: typeSchema, bankId: z.number().int().nullable().optional() })), async (c) => {
    const { ids, type, bankId } = c.req.valid('json');
    await guard(c, type);
    const r = await c.var.db.transaction((tx) => exportDocuments(tx, c.var.user.id, type, ids, bankId ?? null));
    if (!r.ok) throw new ApiError(422, r.messages[0]!.text, r.messages);
    const bytes = encodeWindows1251(r.content!);
    return c.body(bytes.buffer as ArrayBuffer, 200, {
      'content-type': 'text/plain; charset=windows-1251',
      'content-disposition': `attachment; filename="${r.fileName}"`,
      'x-export-file-name': r.fileName!,
    });
  });
