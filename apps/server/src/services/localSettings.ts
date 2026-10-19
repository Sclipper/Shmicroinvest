import type { DbOrTx } from '../db/provider.ts';
import { badRequest } from '../lib/errors.ts';
import { getConfig, setConfig } from './config.ts';
import { decryptSecret, encryptSecret } from './email.ts';

/**
 * Delta's local configuration keys (ConfigurationKeyBase, 06 3.2) that still
 * mean something on the web. Delta keeps them per Windows user in an XML
 * file; here they are per-user rows of the configuration table.
 * - ZipPassword / IsZipPasswordEnabled: password of the backup and export ZIPs.
 * - EmailUserName / EmailSignature: sender display name and signature of report e-mails.
 * - IsFileOpenAutomatically: open an exported file after the export. A web
 *   page cannot open a downloaded file with a desktop program; the setting is
 *   kept (and shown) only, the browser's own "open when done" option applies.
 */
export const LOCAL_SETTINGS: Record<string, string> = {
  EmailUserName: '',
  EmailSignature: '',
  IsZipPasswordEnabled: 'False',
  IsFileOpenAutomatically: 'False',
};
/** Stored encrypted (encryptSecret), never sent back. */
export const ZIP_PASSWORD_KEY = 'ZipPassword';

export const LOCAL_SETTINGS_MESSAGES = {
  zipPasswordMissing: 'Въведете парола за ZIP архивите.',
} as const;

export async function readLocalSettings(db: DbOrTx, userId: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, d] of Object.entries(LOCAL_SETTINGS)) out[k] = (await getConfig(db, k, userId)) ?? d;
  out.HasZipPassword = (await getConfig(db, ZIP_PASSWORD_KEY, userId)) ? 'True' : 'False';
  return out;
}

/** Saves the local keys among `values`; returns the keys it did not handle. */
export async function saveLocalSettings(db: DbOrTx, userId: number, values: Record<string, string>): Promise<Record<string, string>> {
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (k === ZIP_PASSWORD_KEY) await setConfig(db, ZIP_PASSWORD_KEY, encryptSecret(v), userId);
    else if (k in LOCAL_SETTINGS) await setConfig(db, k, k === 'EmailUserName' ? v.trim().slice(0, 100) : v.slice(0, 2000), userId);
    else rest[k] = v;
  }
  if ((await getConfig(db, 'IsZipPasswordEnabled', userId)) === 'True' && !(await getConfig(db, ZIP_PASSWORD_KEY, userId))) {
    throw badRequest(LOCAL_SETTINGS_MESSAGES.zipPasswordMissing);
  }
  return rest;
}

/** The ZIP password when IsZipPasswordEnabled is on, else null. */
export async function zipPasswordOf(db: DbOrTx, userId: number): Promise<string | null> {
  if ((await getConfig(db, 'IsZipPasswordEnabled', userId)) !== 'True') return null;
  const password = decryptSecret(await getConfig(db, ZIP_PASSWORD_KEY, userId));
  // Never fall back to an unprotected file: the key file changed or the value is damaged.
  if (!password) throw badRequest('Паролата за ZIP архивите не може да бъде прочетена. Въведете я отново в Настройки > Лични.');
  return password;
}

/** Sender display name and signature of the user's report e-mails. */
export async function emailIdentity(db: DbOrTx, userId: number) {
  return { userName: ((await getConfig(db, 'EmailUserName', userId)) ?? '').trim(), signature: ((await getConfig(db, 'EmailSignature', userId)) ?? '').trimEnd() };
}
