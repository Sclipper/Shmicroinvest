import { and, eq, isNull } from 'drizzle-orm';
import * as s from '../db/company/schema/index.ts';
import type { DbOrTx } from '../db/provider.ts';

/** Per-company (userId null) or per-user settings in the configuration table (spec 01b 1.1, 06 3.4). */
export async function getConfig(db: DbOrTx, key: string, userId: number | null = null): Promise<string | null> {
  const rows = await db.select().from(s.configuration)
    .where(and(eq(s.configuration.key, key), userId == null ? isNull(s.configuration.userId) : eq(s.configuration.userId, userId)));
  return rows[0]?.value ?? null;
}

export async function setConfig(db: DbOrTx, key: string, value: string, userId: number | null = null) {
  const where = and(eq(s.configuration.key, key), userId == null ? isNull(s.configuration.userId) : eq(s.configuration.userId, userId));
  const rows = await db.select({ id: s.configuration.id }).from(s.configuration).where(where);
  if (rows.length) await db.update(s.configuration).set({ value }).where(where);
  else await db.insert(s.configuration).values({ key, value, userId });
}

export async function getBoolConfig(db: DbOrTx, key: string, fallback: boolean, userId: number | null = null) {
  const v = await getConfig(db, key, userId);
  return v == null ? fallback : v.toLowerCase() === 'true';
}

/** Settings shown on the "Настройки" screen with their defaults (spec 02a 1.4, 06 3.4). */
export const BASIC_SETTINGS: Record<string, { default: string; label: string }> = {
  AccountsSeparator: { default: '/', label: 'Разделител за подсметки' },
  IsOptionalReferenceEnabled: { default: 'False', label: 'Поле "Втора забележка" в прозорец Контиране' },
  IsParagraphEnabled: { default: 'False', label: 'Поле "Параграф" в прозорец Контиране' },
  IsAllowAccountingAttachments: { default: 'False', label: 'Прикачване на файлове към контиранията' },
  IsShowAccountingAttachmentsInList: { default: 'False', label: 'Показване на прикачените файлове в списъка с контировки' },
  IsAccountingBalanceEnabled: { default: 'True', label: 'Изчисляване на текущо салдо в прозорец Контиране' },
  DifferentAccountingNumberWarning: { default: 'False', label: 'Съобщение при запис на контиране с различен номер' },
  AutomaticFillExchangeRate: { default: 'False', label: 'Автоматично попълване на банков курс на база фиксинг' },
  IsBindingDocumentsEnabled: { default: 'True', label: 'Обвързване на документи в контиране' },
  IsAutomaticOpenBindingDocumentsEnabled: { default: 'False', label: 'Автоматично отваряне на обвързване на документи' },
  IsBindingBySumEnabled: { default: 'True', label: 'Обвързване по сума' },
  IsAllowAccountingAutomaticEnd: { default: 'False', label: 'Приключване на гр. 60 при контиране' },
  IsShowSeperateAccountingsForeachAccountGroup60: { default: 'False', label: 'Отделно контиране за всяка сметка от гр. 60' },
  QuantityFormat: { default: '3', label: 'Знаци след десетичната запетая за количество' },
  PriceFormat: { default: '3', label: 'Знаци след десетичната запетая за цена на СМЗ' },
  ExchangeRateFormat: { default: '5', label: 'Знаци след десетичната запетая за валутен курс' },
};
