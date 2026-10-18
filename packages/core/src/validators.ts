/**
 * Identifier checks used across partners, own company and payment documents
 * (spec 02c 1.4.1-1.4.2, 03a 2.3-2.4). These are the corrected versions: input
 * is normalised (upper case, separators removed) and malformed input returns
 * false instead of throwing.
 */

const digits = (s: string) => /^\d+$/.test(s);

/** IBAN mod-97 check. Spaces, "-" and "." are stripped; case is normalised. */
export function isValidIban(input: string): boolean {
  const s = normalizeIban(input);
  if (s.length < 5 || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

export function normalizeIban(input: string): string {
  return input.replace(/[\s\-.]/g, '').toUpperCase();
}

/** Bulgarian BIC is IBAN characters 5-8 (bank code); used to auto-fill the bank. */
export function bankCodeFromIban(iban: string): string | null {
  const s = normalizeIban(iban);
  return s.startsWith('BG') && s.length >= 8 ? s.slice(4, 8) : null;
}

/** ЕИК/Булстат: 9 digits, or 13 digits (EIK of a branch). */
export function isValidEik(input: string): boolean {
  const s = input.trim();
  if (!digits(s) || (s.length !== 9 && s.length !== 13)) return false;
  const d = [...s].map(Number);
  let a = 0;
  for (let i = 0; i < 8; i++) a += d[i]! * (i + 1);
  a %= 11;
  if (a === 10) {
    a = 0;
    for (let i = 0; i < 8; i++) a += d[i]! * (i + 3);
    a = (a % 11) % 10;
  }
  if (d[8] !== a) return false;
  if (s.length === 9) return true;
  const w1 = [2, 7, 3, 5];
  const w2 = [4, 9, 5, 7];
  let b = 0;
  for (let i = 0; i < 4; i++) b += d[8 + i]! * w1[i]!;
  b %= 11;
  if (b === 10) {
    b = 0;
    for (let i = 0; i < 4; i++) b += d[8 + i]! * w2[i]!;
    b = (b % 11) % 10;
  }
  return d[12] === b;
}

const EGN_WEIGHTS = [2, 4, 8, 5, 10, 9, 7, 3, 6];

/** ЕГН checksum only (IsEGNValid). */
export function isValidEgnChecksum(input: string): boolean {
  const s = input.trim();
  if (s.length !== 10 || !digits(s)) return false;
  const d = [...s].map(Number);
  let r = 0;
  for (let i = 0; i < 9; i++) r += d[i]! * EGN_WEIGHTS[i]!;
  r %= 11;
  if (r === 10) r = 0;
  return d[9] === r;
}

/** Birth date encoded in an EGN, or null when the date part is invalid. */
export function egnBirthDate(input: string): { year: number; month: number; day: number } | null {
  const s = input.trim();
  if (s.length !== 10 || !digits(s)) return null;
  const yy = Number(s.slice(0, 2));
  let mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));
  let year = 1900 + yy;
  if (mm > 40) { year = 2000 + yy; mm -= 40; }
  else if (mm > 20) { year = 1800 + yy; mm -= 20; }
  if (mm < 1 || mm > 12 || dd < 1) return null;
  const days = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  if (dd > days) return null;
  return { year, month: mm, day: dd };
}

/** ЕГН with checksum and birth-date validation (ValidateEGN). */
export function isValidEgn(input: string): boolean {
  return isValidEgnChecksum(input) && egnBirthDate(input) !== null;
}

/** ЛНЧ (personal number of a foreigner). */
export function isValidLnch(input: string): boolean {
  const s = input.trim();
  if (s.length !== 10 || !digits(s)) return false;
  const w = [21, 19, 17, 13, 11, 9, 7, 3, 1];
  const d = [...s].map(Number);
  let r = 0;
  for (let i = 0; i < 9; i++) r += d[i]! * w[i]!;
  return d[9] === r % 10;
}

/** VAT number: two-letter prefix plus at least one character (no checksum). */
export function isVatCode(input: string): boolean {
  return /^[A-Za-z]{2}.+$/.test(input.trim());
}

/** Partner identifier: EIK, or EGN, or the 15-nines placeholder used for individuals. */
export const BULSTAT_PLACEHOLDER = '999999999999999';
export function isValidPartnerIdentifier(input: string): boolean {
  const s = input.trim();
  return s === BULSTAT_PLACEHOLDER || isValidEik(s) || isValidEgnChecksum(s);
}

export function isEmail(input: string): boolean {
  return /^([a-zA-Z0-9_\-.+]+)@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.)|(([a-zA-Z0-9-]+\.)+))([a-zA-Z]{2,}|[0-9]{1,3})(\]?)$/.test(input.trim());
}

export type IdentifierKind = 'eik' | 'egn' | 'lnch' | 'iban' | 'vat' | 'unknown';

/** Validator screen (Проверка на ДДС номер, ЕИК, ЕГН, IBAN): detect what was typed. */
export function detectIdentifier(input: string): { kind: IdentifierKind; valid: boolean; details?: Record<string, string> } {
  const s = input.trim().replace(/\s/g, '');
  if (/^[A-Za-z]{2}\d{2}[A-Za-z0-9]{8,}$/.test(s) && s.length >= 15) {
    const valid = isValidIban(s);
    return { kind: 'iban', valid, details: { country: s.slice(0, 2).toUpperCase(), bankCode: bankCodeFromIban(s) ?? '' } };
  }
  if (/^[A-Za-z]{2}/.test(s)) {
    const rest = s.slice(2);
    if (s.toUpperCase().startsWith('BG') && digits(rest)) {
      const valid = rest.length === 10 ? isValidEgnChecksum(rest) : isValidEik(rest);
      return { kind: 'vat', valid, details: { country: 'BG' } };
    }
    return { kind: 'vat', valid: isVatCode(s), details: { country: s.slice(0, 2).toUpperCase() } };
  }
  if (digits(s) && (s.length === 9 || s.length === 13)) return { kind: 'eik', valid: isValidEik(s) };
  if (digits(s) && s.length === 10) {
    if (isValidEgn(s)) {
      const b = egnBirthDate(s)!;
      const sexDigit = Number(s[8]);
      return {
        kind: 'egn', valid: true,
        details: {
          birthDate: `${String(b.day).padStart(2, '0')}.${String(b.month).padStart(2, '0')}.${b.year}`,
          sex: sexDigit % 2 === 0 ? 'мъж' : 'жена',
        },
      };
    }
    if (isValidLnch(s)) return { kind: 'lnch', valid: true };
    return { kind: 'egn', valid: false };
  }
  return { kind: 'unknown', valid: false };
}
