import { isEmail } from './validators.ts';

/**
 * Sending reports by e-mail (04b 3, 05 11.3, 07 5.1) and the company SMTP
 * settings (06 3.2 SmtpConfiguration). Texts with a dictionary key come from
 * the spec; the ones marked "rebuild" have no text in Delta.
 */
export const EMAIL_MESSAGES = {
  strEmailSendSuccessfully: 'Изпращането е успешно!',
  strEmailSendingFailed: 'Изпращането не беше успешно! Моля, проверете вашите данни.',
  /** Rebuild text (the key exists in 04b 3, the text is not in the spec). */
  strInvalidEmailTo: 'Невалиден e-mail адрес на получателя!',
  /** Rebuild text. */
  strInvalidEmailCC: 'Невалиден e-mail адрес в полето "Копие до"!',
  /** Rebuild text: Delta falls back to its relay; the web rebuild needs an SMTP server. */
  strNotConnectedToSenderaOrMissingSMTP: 'Няма настроен SMTP сървър за изпращане на e-mail. Въведете го в Настройки > E-mail.',
  /** Rebuild texts of the SMTP page. */
  strSmtpHostMissing: 'Не е въведен SMTP сървър!',
  strSmtpPortInvalid: 'Невалиден порт на SMTP сървъра!',
  strSmtpEmailInvalid: 'Невалиден e-mail адрес на подателя!',
  strEmailSubjectMissing: 'Не е въведена тема на писмото!',
} as const;
export type EmailMessageKey = keyof typeof EMAIL_MESSAGES;

export interface EmailMessage {
  key: EmailMessageKey;
  text: string;
  severity: 'critical';
}
const crit = (key: EmailMessageKey): EmailMessage => ({ key, text: EMAIL_MESSAGES[key], severity: 'critical' });

/** Addresses of a To / CC field: separated by ";" or ",", blanks dropped. */
export function parseEmailList(text: string | null | undefined): string[] {
  return (text ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

export interface ReportEmailInput {
  to: string;
  cc?: string | null;
  subject: string;
}

/** Validation of the report e-mail form (04b 3: To strInvalidEmailTo, CC strInvalidEmailCC). */
export function validateReportEmail(e: ReportEmailInput): EmailMessage[] {
  const out: EmailMessage[] = [];
  const to = parseEmailList(e.to);
  if (!to.length || to.some((a) => !isEmail(a))) out.push(crit('strInvalidEmailTo'));
  if (parseEmailList(e.cc).some((a) => !isEmail(a))) out.push(crit('strInvalidEmailCC'));
  if (!e.subject.trim()) out.push(crit('strEmailSubjectMissing'));
  return out;
}

export interface SmtpSettingsInput {
  host: string;
  port: number | string;
  userName?: string;
  email: string;
  enableSsl?: boolean;
}

export function validateSmtpSettings(s: SmtpSettingsInput): EmailMessage[] {
  const out: EmailMessage[] = [];
  if (!s.host.trim()) out.push(crit('strSmtpHostMissing'));
  const port = Number(s.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) out.push(crit('strSmtpPortInvalid'));
  if (!isEmail(s.email)) out.push(crit('strSmtpEmailInvalid'));
  return out;
}

/** A secret shown to the client: never the value, only that one is set and its last two characters. */
export function maskSecret(secret: string | null | undefined): string {
  if (!secret) return '';
  return `${'•'.repeat(6)}${secret.length > 6 ? secret.slice(-2) : ''}`;
}

/** Attachment name of a report: short name + end date "yyyy.MM.dd" + .xlsx (05 11.1). */
export function reportAttachmentName(shortName: string, endDate?: string | null): string {
  const clean = shortName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Справка';
  const date = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? ` ${endDate.replace(/-/g, '.')}` : '';
  return `${clean}${date}.xlsx`;
}
