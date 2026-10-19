import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { EMAIL_MESSAGES, maskSecret, parseEmailList, validateReportEmail, validateSmtpSettings, type EmailMessage } from '@shmi/core';
import type { DbOrTx } from '../db/provider.ts';
import { ApiError } from '../lib/errors.ts';
import { getConfig, setConfig } from './config.ts';
import { logApp } from './appLog.ts';

/**
 * Outgoing e-mail (04b 3, 06 3.2 SmtpConfiguration): the company's SMTP
 * server and sending a report as an attachment. The password is stored
 * encrypted (symmetric, as Delta's local configuration) and never returned.
 */

const KEYS = {
  host: 'SmtpHost', port: 'SmtpPort', userName: 'SmtpUserName', password: 'SmtpPassword', email: 'SmtpEmail', enableSsl: 'SmtpEnableSSL',
} as const;

export interface SmtpConfig {
  host: string;
  port: number;
  userName: string;
  password: string;
  email: string;
  enableSsl: boolean;
}

/* ---- password encryption (AES-256-GCM) --------------------------------- */

/**
 * The key is SHMI_SECRET when set; otherwise a random key kept in a file next
 * to the data (SHMI_SECRET_FILE, default <DATA_DIR>/secret.key), created on
 * first use. It is never stored in a company database, so backups and dumps
 * do not carry what is needed to decrypt the password. Tests use a per-process key.
 */
let cachedKey: Buffer | null = null;
function secretKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (process.env.SHMI_SECRET) return (cachedKey = createHash('sha256').update(process.env.SHMI_SECRET).digest());
  if (process.env.VITEST) return (cachedKey = randomBytes(32));
  const file = process.env.SHMI_SECRET_FILE ?? path.join(process.env.DATA_DIR ?? path.resolve(import.meta.dirname, '../../.data'), 'secret.key');
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  }
  return (cachedKey = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'));
}

export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), data]).toString('base64')}`;
}

export function decryptSecret(stored: string | null | undefined): string {
  if (!stored?.startsWith('v1:')) return '';
  try {
    const raw = Buffer.from(stored.slice(3), 'base64');
    const d = createDecipheriv('aes-256-gcm', secretKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/* ---- settings ------------------------------------------------------------ */

export async function loadSmtpConfig(db: DbOrTx): Promise<SmtpConfig | null> {
  const host = (await getConfig(db, KEYS.host))?.trim() ?? '';
  if (!host) return null;
  return {
    host,
    port: Number(await getConfig(db, KEYS.port)) || 587,
    userName: (await getConfig(db, KEYS.userName)) ?? '',
    password: decryptSecret(await getConfig(db, KEYS.password)),
    email: (await getConfig(db, KEYS.email)) ?? '',
    enableSsl: (await getConfig(db, KEYS.enableSsl)) === 'True',
  };
}

/** What the client sees: everything but the password, which is only masked. */
export async function smtpSettingsView(db: DbOrTx) {
  const c = await loadSmtpConfig(db);
  return {
    host: c?.host ?? '', port: c?.port ?? 587, userName: c?.userName ?? '', email: c?.email ?? '', enableSsl: c?.enableSsl ?? false,
    hasPassword: !!c?.password, password: maskSecret(c?.password),
  };
}

export interface SmtpInput {
  host: string;
  port: number;
  userName: string;
  /** undefined = keep the stored password; '' = remove it. */
  password?: string;
  email: string;
  enableSsl: boolean;
}

const fail = (messages: EmailMessage[]): never => {
  throw new ApiError(422, messages[0]!.text, messages);
};

export async function saveSmtpSettings(db: DbOrTx, input: SmtpInput) {
  if (!input.host.trim()) {
    // Clearing the host switches e-mail off.
    for (const k of Object.values(KEYS)) await setConfig(db, k, '');
    return;
  }
  const errors = validateSmtpSettings(input);
  if (errors.length) fail(errors);
  await setConfig(db, KEYS.host, input.host.trim());
  await setConfig(db, KEYS.port, String(input.port));
  await setConfig(db, KEYS.userName, input.userName.trim());
  await setConfig(db, KEYS.email, input.email.trim());
  await setConfig(db, KEYS.enableSsl, input.enableSsl ? 'True' : 'False');
  if (input.password !== undefined) await setConfig(db, KEYS.password, encryptSecret(input.password));
}

/* ---- transport ------------------------------------------------------------ */

export interface OutboxMessage {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: { filename: string; size: number }[];
}

/** Messages sent through the JSON transport (MAIL_TRANSPORT=json, tests and e2e). */
export const MAIL_OUTBOX: OutboxMessage[] = [];

type TransportFactory = (c: SmtpConfig) => Transporter;
let transportFactory: TransportFactory | null = null;

/** Test hook: replace the SMTP transport (null restores the default). */
export function setMailTransportFactory(f: TransportFactory | null) {
  transportFactory = f;
}

function transport(c: SmtpConfig): Transporter {
  if (transportFactory) return transportFactory(c);
  if (process.env.MAIL_TRANSPORT === 'json') return nodemailer.createTransport({ jsonTransport: true });
  return nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.port === 465 || (c.enableSsl && c.port !== 587 && c.port !== 25),
    requireTLS: c.enableSsl && c.port !== 465,
    auth: c.userName ? { user: c.userName, pass: c.password } : undefined,
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000,
  });
}

export interface SendInput {
  to: string;
  cc?: string | null;
  subject: string;
  body?: string | null;
  attachment?: { fileName: string; contentBase64: string } | null;
}

async function send(c: SmtpConfig, input: SendInput, company: string) {
  const to = parseEmailList(input.to);
  const cc = parseEmailList(input.cc);
  const attachments = input.attachment ? [{ filename: input.attachment.fileName, content: Buffer.from(input.attachment.contentBase64, 'base64') }] : [];
  const sizes = attachments.map((a) => ({ filename: a.filename, size: a.content.length }));
  const message = { from: c.email, to, cc, subject: input.subject.trim(), text: input.body ?? '', attachments };
  try {
    await transport(c).sendMail(message);
  } catch (e) {
    await logApp({ level: 'error', message: `Неуспешно изпращане на e-mail: ${(e as Error).message}`, company, user: null });
    throw new ApiError(422, EMAIL_MESSAGES.strEmailSendingFailed, [{ key: 'strEmailSendingFailed', text: EMAIL_MESSAGES.strEmailSendingFailed, severity: 'critical' }]);
  }
  if (transportFactory || process.env.MAIL_TRANSPORT === 'json') {
    MAIL_OUTBOX.push({ from: c.email, to, cc, subject: message.subject, text: message.text, attachments: sizes });
    if (MAIL_OUTBOX.length > 50) MAIL_OUTBOX.shift();
  }
}

const notConfigured = (): never => {
  throw new ApiError(422, EMAIL_MESSAGES.strNotConnectedToSenderaOrMissingSMTP, [{ key: 'strNotConnectedToSenderaOrMissingSMTP', text: EMAIL_MESSAGES.strNotConnectedToSenderaOrMissingSMTP, severity: 'critical' }]);
};

/** "Изпращане по e-mail" of a report: validation (strInvalidEmailTo / CC), then the company SMTP server. */
export async function sendReportEmail(db: DbOrTx, input: SendInput, company: string) {
  const errors = validateReportEmail({ to: input.to, cc: input.cc, subject: input.subject });
  if (errors.length) fail(errors);
  const c = await loadSmtpConfig(db);
  if (!c) notConfigured();
  await send(c!, input, company);
  return { message: EMAIL_MESSAGES.strEmailSendSuccessfully };
}

/** Test button of the SMTP page: a short message to the sender address (or `to`). */
export async function sendTestEmail(db: DbOrTx, company: string, to?: string) {
  const c = await loadSmtpConfig(db);
  if (!c) notConfigured();
  const recipient = to?.trim() || c!.email;
  const errors = validateReportEmail({ to: recipient, subject: 'test' });
  if (errors.length) fail(errors);
  await send(c!, { to: recipient, subject: `Тестово съобщение от Шмелта Про (${company})`, body: 'Настройките за изпращане на e-mail са верни.' }, company);
  return { message: EMAIL_MESSAGES.strEmailSendSuccessfully, to: recipient };
}
