import { Hono } from 'hono';
import { z } from 'zod';
import { ENTRY_FOLLOW_UP_MESSAGES as M } from '@shmi/core';
import type { AppEnv } from '../context.ts';
import { zValidator } from '../lib/validate.ts';
import { ApiError } from '../lib/errors.ts';
import { requireAnyPermission, requirePermission, workingDate } from '../session.ts';
import { entryCard, entryFixing, protocolMainId, refreshCurrencyFixings } from '../services/entryFollowUps.ts';
import { getProtocol, protocolPrint } from '../services/vat/protocols.ts';
import { logActivity } from '../services/audit.ts';

const ADD = 'UI_Operations_Accounting';
const EDIT = 'UI_Edit_Accountings';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Entry editor follow-ups (02a 2, 7; 03a 5.4; 05 7.11). */
export const entryFollowUpRoutes = new Hono<AppEnv>()
  /** Fixing of the date for the editor's currency lines (Ctrl+F12, AutomaticFillExchangeRate). */
  .get('/journal/fixing', requireAnyPermission(ADD, EDIT), zValidator('query', z.object({
    date, currencyIds: z.string().regex(/^\d+(,\d+)*$/), download: z.enum(['0', '1']).optional(),
  })), async (c) => {
    const q = c.req.valid('query');
    const ids = q.currencyIds.split(',').map(Number);
    return c.json(await c.var.db.transaction((tx) => entryFixing(tx, c.var.year.year, q.date, ids, { download: q.download !== '0' })));
  })

  /** "Обновяване на фиксингите от БНБ" of the currencies screen (03a 5.4), for the working date by default. */
  .post('/currencies/refresh-fixings', requirePermission('UI_Edit_Currencies'), zValidator('json', z.object({ date: date.optional() })), async (c) => {
    const d = c.req.valid('json').date ?? workingDate(c.var.session);
    const r = await c.var.db.transaction((tx) => refreshCurrencyFixings(tx, c.var.year.year, d));
    await logActivity(c.var.db, c.var.user.id, 'edit', 'currency', null, `Обновяване на фиксингите от БНБ към ${d}`);
    return c.json(r);
  })

  /** Entry card print data (AccountingReport, 05 7.11). */
  .get('/journal/entries/:id/print', requireAnyPermission(ADD, EDIT), async (c) => c.json(await entryCard(c.var.db, Number(c.req.param('id')))))

  /** "Печат / Експорт на протокол по ЗДДС" of the list (02a 7): the selected entry or the protocol accounting itself. */
  .get('/journal/entries/:id/protocol', requireAnyPermission(ADD, EDIT), async (c) => {
    const db = c.var.db;
    const mainId = await protocolMainId(db, Number(c.req.param('id')));
    if (!(await getProtocol(db, mainId))) throw new ApiError(404, M.strNoProtocolForAccounting, undefined, 'noProtocol');
    return c.json(await protocolPrint(db, mainId));
  });
