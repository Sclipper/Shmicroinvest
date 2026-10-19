import { eq } from 'drizzle-orm';
import * as s from '../db/company/schema/index.ts';
import { PostgresDriver, type DbDriver, type DbOrTx } from '../db/provider.ts';
import { getConfig, setConfig } from './config.ts';

/**
 * GDPR self-check (06 9, 07 4). Delta checks its own users, the OS users and
 * the antivirus; the web rebuild keeps the user rules and replaces the
 * machine checks with the ones a server deployment controls: the database
 * connection and the transport.
 */
export type GdprStatus = 'verified' | 'warning' | 'error';
export interface GdprRule {
  group: string;
  rule: string;
  status: GdprStatus;
  details?: string;
}

const PASSWORD_FLAG = 'GDPRPasswordCompliant';

/** Lower (Latin or Cyrillic), upper, digit, non-alphanumeric and at least 6 characters. */
export function isGdprPassword(pw: string): boolean {
  return pw.length >= 6 && /[a-zа-я]/.test(pw) && /[A-ZА-Я]/.test(pw) && /\d/.test(pw) && /[^a-zA-Zа-яА-Я0-9]/.test(pw);
}

/** Two or more words in the user name. */
export const isFullName = (name: string) => /^\s*\S+(\s+\S+)+\s*$/.test(name);

/** Passwords are stored hashed, so their quality is recorded when they are set. */
export async function recordPasswordQuality(db: DbOrTx, userId: number, password: string) {
  await setConfig(db, PASSWORD_FLAG, isGdprPassword(password) ? 'True' : 'False', userId);
}

export async function runGdprValidation(db: DbOrTx, driver: DbDriver, opts: { https: boolean }) {
  const rules: GdprRule[] = [];
  const users = await db.select({ id: s.users.id, name: s.users.name, hash: s.users.passwordHash }).from(s.users).where(eq(s.users.isDeleted, false));
  const G = 'Потребители на програмата';
  rules.push({
    group: G,
    rule: 'Поне двама потребители',
    status: users.length >= 2 ? 'verified' : 'error',
    details: users.length >= 2 ? undefined : `Дефиниран${users.length === 1 ? ' е 1 потребител' : 'и са 0 потребители'}. Всяко лице трябва да работи със собствен потребител.`,
  });
  const shortNames = users.filter((u) => !isFullName(u.name));
  rules.push({
    group: G,
    rule: 'Имената на потребителите съдържат име и фамилия',
    status: shortNames.length ? 'warning' : 'verified',
    details: shortNames.length ? `Без име и фамилия: ${shortNames.map((u) => u.name).join(', ')}` : undefined,
  });
  const noPassword = users.filter((u) => !u.hash);
  rules.push({
    group: G,
    rule: 'Всички потребители имат парола',
    status: noPassword.length ? 'error' : 'verified',
    details: noPassword.length ? `Без парола: ${noPassword.map((u) => u.name).join(', ')}` : undefined,
  });
  const weak: string[] = [];
  const unknown: string[] = [];
  for (const u of users.filter((x) => x.hash)) {
    const flag = await getConfig(db, PASSWORD_FLAG, u.id);
    if (flag === 'False') weak.push(u.name);
    else if (flag == null) unknown.push(u.name);
  }
  rules.push({
    group: G,
    rule: 'Сложни пароли (малка и главна буква, цифра, специален знак, поне 6 символа)',
    status: weak.length ? 'error' : unknown.length ? 'warning' : 'verified',
    details: weak.length ? `Слаба парола: ${weak.join(', ')}` : unknown.length ? `Неизвестна сложност (сменете паролата): ${unknown.join(', ')}` : undefined,
  });

  const S = 'Сървър и връзка';
  if (driver.kind === 'pglite') {
    rules.push({ group: S, rule: 'Базата данни е достъпна само за сървъра на програмата', status: 'verified', details: 'Вградена база данни (PGlite) в папката с данни на сървъра.' });
  } else {
    const hasPassword = driver instanceof PostgresDriver && driver.connectionHasPassword();
    rules.push({ group: S, rule: 'Връзката към базата данни е защитена с парола', status: hasPassword ? 'verified' : 'error' });
  }
  rules.push({
    group: S,
    rule: 'Криптирана връзка (HTTPS)',
    status: opts.https ? 'verified' : 'warning',
    details: opts.https ? undefined : 'Програмата е отворена през некриптирана връзка (HTTP).',
  });
  const overall: GdprStatus = rules.some((r) => r.status === 'error') ? 'error' : rules.some((r) => r.status === 'warning') ? 'warning' : 'verified';
  return { rules, overall };
}
