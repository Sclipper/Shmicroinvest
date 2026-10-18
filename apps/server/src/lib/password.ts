import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/**
 * Salted scrypt hash. Delta stores a reversible cipher; the spec recommends a
 * salted slow hash for a rebuild (01b section 4). Empty password -> ''.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password === '') return '';
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored === '') return password === '';
  const [kind, saltB64, hashB64] = stored.split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

/** Password rule from the users screen: at least 6 characters (01b 3.4). */
export function isStrongPassword(pw: string): boolean {
  return pw.length >= 6;
}
