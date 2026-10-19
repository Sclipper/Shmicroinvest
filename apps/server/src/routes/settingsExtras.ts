import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  DEFAULT_SHORTCUTS, duplicateShortcutWarnings, effectiveShortcuts, isAllowedEditableGesture, JOURNAL_EXTRA_MESSAGES as X,
  MANDATORY_DOCUMENT_TYPES, sequenceEditorValues, sequencePreview, sequenceStorage, validateSequence, type ValidationMessage,
} from '@shmi/core';
import type { AppEnv } from '../context.ts';
import * as s from '../db/company/schema/index.ts';
import * as cat from '../db/catalog/schema.ts';
import type { DbOrTx } from '../db/provider.ts';
import { zValidator } from '../lib/validate.ts';
import { ApiError, badRequest, notFound } from '../lib/errors.ts';
import { requirePermission } from '../session.ts';
import { getConfig, setConfig } from '../services/config.ts';
import { readLocalSettings, saveLocalSettings } from '../services/localSettings.ts';
import { findSequence, formatSequenceNumber } from '../services/sequences.ts';
import { logActivity } from '../services/audit.ts';

const SEQUENCES = 'UI_Other_Settings_Sequences';
const DOCUMENT_TYPES = 'UI_Other_Settings_DocumentTypes';
const DATABASE = 'UI_Other_Settings_Database';

/** Human names of the numbering channels (01a 9.2 / the document types using them). */
export const CHANNEL_NAMES: Record<number, string> = {
  1: 'Контировки', 2: 'Фактури, ДИ, КИ', 3: 'Отчети за продажби', 4: 'Приходни касови ордери', 5: 'Разходни касови ордери',
  6: 'Мемориални ордери', 7: 'Протоколи по ЗДДС', 8: 'Канал 8', 9: 'Инвентаризационни описи', 10: 'Авансови отчети',
  11: 'Вносни бележки', 12: 'Бюджетни платежни нареждания', 13: 'Банкови ордери за валута', 14: 'Складови разписки',
  15: 'Искания за отпускане на материали', 16: 'Изпълнителни листове', 17: 'Заявки за плащане', 18: 'Канал 18',
  19: 'Регистър изпращане ЕС', 20: 'Регистър получаване ЕС', 21: 'Протоколи по ЗДДС за гориво', 22: 'Отчети за продажби на горива',
  23: 'Отчети за продажби на хляб', 24: 'Отчети за продажби на брашно', 999: 'Потребителски формули',
};

const critical = (key: keyof typeof X): ValidationMessage => ({ key, text: X[key], severity: 'critical' });

const sequenceBody = z.object({
  channel: z.number().int(),
  prefix: z.string().max(40).default(''),
  separator: z.string().max(5).default(''),
  selectedNumberLength: z.number().int().min(0).max(9),
  startNumber: z.number().int().min(1),
  isNumberResetNextYear: z.boolean().default(false),
});

async function sequenceRows(db: DbOrTx, fyId: number, userId: number) {
  const rows = await db.select().from(s.sequences)
    .where(or(eq(s.sequences.financialYearId, fyId), isNull(s.sequences.financialYearId)))
    .orderBy(asc(s.sequences.channel), asc(s.sequences.id));
  const usage = rows.length
    ? await db.select({ sequenceId: s.userSequences.sequenceId, n: sql<number>`count(*)::int` }).from(s.userSequences)
      .where(inArray(s.userSequences.sequenceId, rows.map((r) => r.id))).groupBy(s.userSequences.sequenceId)
    : [];
  const used = new Map(usage.map((u) => [u.sequenceId, u.n]));
  const active = new Map<number, number>();
  for (const ch of new Set(rows.map((r) => r.channel))) {
    const a = await findSequence(db, ch, fyId, userId);
    if (a) active.set(ch, a.id);
  }
  return rows.map((r) => {
    const ed = sequenceEditorValues(r);
    return {
      ...r, channelName: CHANNEL_NAMES[r.channel] ?? `Канал ${r.channel}`, ...ed,
      preview: sequencePreview(ed.prefix, ed.selectedNumberLength, ed.startNumber),
      next: formatSequenceNumber(r, r.lastNumber + 1),
      users: used.get(r.id) ?? 0, isActive: active.get(r.channel) === r.id,
    };
  });
}

/** Parent setting off -> its dependent settings are stored false (06 3.5). */
export const SETTING_CHILDREN: Record<string, string[]> = {
  IsAllowAccountingAttachments: ['IsShowAccountingAttachmentsInList'],
  IsAllowAccountingAutomaticEnd: ['IsShowSeperateAccountingsForeachAccountGroup60'],
  IsBindingDocumentsEnabled: ['IsAutomaticOpenBindingDocumentsEnabled'],
};

/** Per-user options (Configuration rows with UserID). */
const USER_SETTINGS: Record<string, string> = {
  KeepAccountingOpen: 'False',
};

async function shortcutOverrides(db: DbOrTx, userId: number): Promise<Record<string, string>> {
  const raw = await getConfig(db, 'ShortcutKeys', userId);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, string>;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

async function shortcutList(db: DbOrTx, userId: number) {
  const overrides = await shortcutOverrides(db, userId);
  const eff = effectiveShortcuts(overrides);
  const rows = DEFAULT_SHORTCUTS.map((d) => ({ ...d, default: d.gesture, gesture: eff.get(d.id) ?? d.gesture }));
  return { rows, warnings: duplicateShortcutWarnings(rows) };
}

export const settingsExtraRoutes = new Hono<AppEnv>()
  // ---- 06 3.7 Номерация ----------------------------------------------------
  .get('/settings/sequences', requirePermission(SEQUENCES), async (c) => c.json(await sequenceRows(c.var.db, c.var.year.id, c.var.user.id)))

  .post('/settings/sequences/preview', zValidator('json', sequenceBody.partial({ channel: true })), async (c) => {
    const b = c.req.valid('json');
    return c.json({ preview: sequencePreview(b.prefix, b.selectedNumberLength, b.startNumber), messages: validateSequence(b.prefix, b.selectedNumberLength, b.startNumber) });
  })

  .post('/settings/sequences', requirePermission(SEQUENCES), zValidator('json', sequenceBody), async (c) => {
    const b = c.req.valid('json');
    const { db, year, user } = c.var;
    const errs = validateSequence(b.prefix, b.selectedNumberLength, b.startNumber);
    if (errs.length) throw new ApiError(422, X.strIncorrectSequenceData, errs);
    const st = sequenceStorage(b.prefix, b.separator, b.selectedNumberLength, b.startNumber);
    const [row] = await db.insert(s.sequences).values({ channel: b.channel, financialYearId: year.id, ...st, isNumberResetNextYear: b.isNumberResetNextYear }).returning();
    await logActivity(db, user.id, 'add', 'sequence', row!.id, `Номерация ${CHANNEL_NAMES[b.channel] ?? b.channel}`);
    return c.json(row, 201);
  })

  .put('/settings/sequences/:id', requirePermission(SEQUENCES), zValidator('json', sequenceBody), async (c) => {
    const b = c.req.valid('json');
    const { db, user } = c.var;
    const id = Number(c.req.param('id'));
    const errs = validateSequence(b.prefix, b.selectedNumberLength, b.startNumber);
    if (errs.length) throw new ApiError(422, X.strIncorrectSequenceData, errs);
    const st = sequenceStorage(b.prefix, b.separator, b.selectedNumberLength, b.startNumber);
    const [row] = await db.update(s.sequences).set({ ...st, isNumberResetNextYear: b.isNumberResetNextYear }).where(eq(s.sequences.id, id)).returning();
    if (!row) throw notFound('Номерацията');
    await logActivity(db, user.id, 'edit', 'sequence', id, `Номерация ${CHANNEL_NAMES[row.channel] ?? row.channel}`);
    return c.json(row);
  })

  .delete('/settings/sequences/:id', requirePermission(SEQUENCES), async (c) => {
    const { db, year } = c.var;
    const id = Number(c.req.param('id'));
    const [seq] = await db.select().from(s.sequences).where(eq(s.sequences.id, id));
    if (!seq) throw notFound('Номерацията');
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(s.userSequences).where(eq(s.userSequences.sequenceId, id))) as [{ n: number }];
    const [{ a }] = (await db.select({ a: sql<number>`count(*)::int` }).from(s.accountings).where(eq(s.accountings.sequenceId, id))) as [{ a: number }];
    if (n > 0 || a > 0) throw new ApiError(422, X.strSequenceInUse, [critical('strSequenceInUse')]);
    const siblings = await db.select({ id: s.sequences.id }).from(s.sequences)
      .where(and(eq(s.sequences.channel, seq.channel), or(eq(s.sequences.financialYearId, year.id), isNull(s.sequences.financialYearId))));
    if (seq.channel === 1 && siblings.length <= 1) throw new ApiError(422, X.strAccountingNumberationCannotBeDeactivated, [critical('strAccountingNumberationCannotBeDeactivated')]);
    await db.delete(s.sequences).where(eq(s.sequences.id, id));
    return c.json({ ok: true });
  })

  /** Make the series the user's active one for its channel in the active year. */
  .post('/settings/sequences/:id/activate', requirePermission(SEQUENCES), async (c) => {
    const { db, year, user } = c.var;
    const id = Number(c.req.param('id'));
    const [seq] = await db.select().from(s.sequences).where(eq(s.sequences.id, id));
    if (!seq) throw notFound('Номерацията');
    await db.transaction(async (tx) => {
      const mine = await tx.select({ id: s.userSequences.id }).from(s.userSequences)
        .innerJoin(s.sequences, eq(s.sequences.id, s.userSequences.sequenceId))
        .where(and(eq(s.userSequences.userId, user.id), eq(s.sequences.channel, seq.channel), or(eq(s.userSequences.financialYearId, year.id), isNull(s.userSequences.financialYearId))));
      if (mine.length) await tx.delete(s.userSequences).where(inArray(s.userSequences.id, mine.map((m) => m.id)));
      await tx.insert(s.userSequences).values({ userId: user.id, sequenceId: id, financialYearId: year.id });
    });
    return c.json({ ok: true });
  })

  /** Remove the user's choice for the channel; the first series then becomes active again. Channel 1 cannot be deactivated. */
  .post('/settings/sequences/:id/deactivate', requirePermission(SEQUENCES), async (c) => {
    const { db, year, user } = c.var;
    const id = Number(c.req.param('id'));
    const [seq] = await db.select().from(s.sequences).where(eq(s.sequences.id, id));
    if (!seq) throw notFound('Номерацията');
    if (seq.channel === 1) throw new ApiError(422, X.strAccountingNumberationCannotBeDeactivated, [critical('strAccountingNumberationCannotBeDeactivated')]);
    await db.delete(s.userSequences).where(and(eq(s.userSequences.userId, user.id), eq(s.userSequences.sequenceId, id),
      or(eq(s.userSequences.financialYearId, year.id), isNull(s.userSequences.financialYearId))));
    return c.json({ ok: true });
  })

  // ---- 06 3.8 Документи ------------------------------------------------------
  .get('/settings/document-types', requirePermission(DOCUMENT_TYPES), async (c) => {
    const { db } = c.var;
    const rows = await db.select().from(s.documentTypes).orderBy(asc(s.documentTypes.position), asc(s.documentTypes.id));
    const used = await db.select({ id: s.documents.documentTypeId, n: sql<number>`count(*)::int` }).from(s.documents)
      .innerJoin(s.accountings, eq(s.accountings.documentId, s.documents.id)).groupBy(s.documents.documentTypeId);
    const u = new Map(used.map((x) => [x.id, x.n]));
    return c.json(rows.map((r) => ({ ...r, accountings: u.get(r.id) ?? 0, isMandatory: MANDATORY_DOCUMENT_TYPES.includes(r.id) })));
  })

  /** Two-list editor result: `visible` = ids shown in the editors, in order. */
  .put('/settings/document-types', requirePermission(DOCUMENT_TYPES), zValidator('json', z.object({ visible: z.array(z.number().int()) })), async (c) => {
    const { db, user } = c.var;
    const { visible } = c.req.valid('json');
    const rows = await db.select().from(s.documentTypes);
    const keep = new Set(visible);
    const messages: ValidationMessage[] = [];
    const used = await db.select({ id: s.documents.documentTypeId }).from(s.documents)
      .innerJoin(s.accountings, eq(s.accountings.documentId, s.documents.id)).groupBy(s.documents.documentTypeId);
    const usedIds = new Set(used.map((x) => x.id));
    for (const r of rows) {
      if (!r.isVisible || keep.has(r.id)) continue;
      if (MANDATORY_DOCUMENT_TYPES.includes(r.id)) messages.push({ key: 'strErrorCannotDeleteDocumentTypeUsedByProgram', text: `${r.name}: ${X.strErrorCannotDeleteDocumentTypeUsedByProgram}`, severity: 'critical' });
      else if (usedIds.has(r.id)) messages.push({ key: 'strErrorCannotDeleteDocumentType', text: `${r.name}: ${X.strErrorCannotDeleteDocumentType}`, severity: 'critical' });
    }
    if (messages.length) throw new ApiError(422, messages[0]!.text, messages);
    await db.transaction(async (tx) => {
      for (const r of rows) {
        const pos = visible.indexOf(r.id);
        await tx.update(s.documentTypes).set({ isVisible: pos >= 0, position: pos >= 0 ? pos + 1 : 1000 + r.id }).where(eq(s.documentTypes.id, r.id));
      }
    });
    await logActivity(db, user.id, 'edit', 'documentTypes', null, 'Настройки на документите');
    return c.json({ ok: true });
  })

  // ---- 06 3.6 База данни --------------------------------------------------------
  .get('/settings/database', requirePermission(DATABASE), async (c) => {
    const catalog = await c.var.driver.catalog();
    const companies = await catalog.select().from(cat.companiesCatalog).orderBy(asc(cat.companiesCatalog.companyName));
    const current = companies.find((x) => x.name === c.var.session.companyDb);
    return c.json({
      server: c.var.driver.kind === 'pglite' ? 'PGlite (вграден)' : 'PostgreSQL',
      catalog: c.var.session.companyDb,
      companyName: current?.companyName ?? '',
      version: current?.version ?? '',
      companies: companies.map((x) => ({ name: x.name, companyName: x.companyName, version: x.version })),
    });
  })

  // ---- 06 2.6 Клавишни комбинации (Ctrl+K) ------------------------------------
  .get('/settings/shortcuts', async (c) => c.json(await shortcutList(c.var.db, c.var.user.id)))

  .put('/settings/shortcuts', zValidator('json', z.object({ overrides: z.record(z.string(), z.string()) })), async (c) => {
    const { db, user } = c.var;
    const { overrides } = c.req.valid('json');
    const ids = new Set(DEFAULT_SHORTCUTS.map((d) => d.id));
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(overrides)) {
      if (!ids.has(k)) throw badRequest(`Непозната клавишна комбинация ${k}.`);
      const def = DEFAULT_SHORTCUTS.find((d) => d.id === k)!;
      if (v && def.type === 'WindowEditable' && !isAllowedEditableGesture(v)) throw badRequest(`Недопустим клавиш: ${v}.`);
      if (v !== def.gesture) clean[k] = v;
    }
    await setConfig(db, 'ShortcutKeys', JSON.stringify(clean), user.id);
    return c.json(await shortcutList(db, user.id));
  })

  .delete('/settings/shortcuts', async (c) => {
    await setConfig(c.var.db, 'ShortcutKeys', '{}', c.var.user.id);
    return c.json(await shortcutList(c.var.db, c.var.user.id));
  })

  // ---- per-user options (keep-open etc.) -------------------------------------------
  .get('/settings/user', async (c) => {
    const out: Record<string, string> = {};
    for (const [k, d] of Object.entries(USER_SETTINGS)) out[k] = (await getConfig(c.var.db, k, c.var.user.id)) ?? d;
    return c.json({ ...out, ...(await readLocalSettings(c.var.db, c.var.user.id)) });
  })

  .put('/settings/user', zValidator('json', z.record(z.string(), z.string())), async (c) => {
    // Local keys of 06 3.2 (ZIP password, e-mail sender and signature) first; then the screen options.
    const rest = await c.var.db.transaction((tx) => saveLocalSettings(tx, c.var.user.id, c.req.valid('json')));
    for (const [k, v] of Object.entries(rest)) {
      if (!(k in USER_SETTINGS)) throw badRequest(`Непозната настройка ${k}.`);
      await setConfig(c.var.db, k, v, c.var.user.id);
    }
    return c.json({ ok: true });
  })

  // ---- last filter of every report, per user (GetPropertyStateValue / SavePropertyState, 05 1.2) ----
  .get('/settings/report-filters/:name', async (c) => {
    const raw = await getConfig(c.var.db, reportFilterKey(c.req.param('name')), c.var.user.id);
    let value: unknown = null;
    try {
      value = raw ? JSON.parse(raw) : null;
    } catch {
      value = null;
    }
    return c.json({ value: value && typeof value === 'object' && !Array.isArray(value) ? value : null });
  })

  .put('/settings/report-filters/:name', zValidator('json', z.record(z.string(), z.unknown())), async (c) => {
    const text = JSON.stringify(c.req.valid('json'));
    if (text.length > 20_000) throw badRequest('Филтърът е твърде голям.');
    await setConfig(c.var.db, reportFilterKey(c.req.param('name')), text, c.var.user.id);
    return c.json({ ok: true });
  });

/** Configuration key of a report's saved filter (Configuration.Key is 50 characters). */
function reportFilterKey(name: string) {
  if (!/^[A-Za-z0-9_:.-]{1,36}$/.test(name)) throw badRequest('Невалидно име на справка.');
  return `ReportFilter.${name}`;
}
