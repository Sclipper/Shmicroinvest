import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Registration key. Without SHMI_SETUP_TOKEN registration is free: anybody
 * who opens the login screen can create a company and its administrator.
 * With it, creating a company without being logged in needs that key.
 */
export function setupToken(): string | null {
  return process.env.SHMI_SETUP_TOKEN?.trim() || null;
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export function setupTokenMatches(given: string | null | undefined): boolean {
  const token = setupToken();
  if (!token) return true;
  if (!given) return false;
  return timingSafeEqual(digest(given.trim()), digest(token));
}
