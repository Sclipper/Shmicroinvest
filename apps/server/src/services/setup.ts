import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isProduction } from '../runtime.ts';

/**
 * First-run setup token. While the server has no company, anybody who opens
 * it could create the first company and its administrator; on a public URL
 * that needs the token. It is SHMI_SETUP_TOKEN when set; in production
 * (NODE_ENV=production) without it a random token is generated at start and
 * printed to the server log. Elsewhere (development, tests) none is needed.
 */
let generated: string | null = null;

export function setupToken(): string | null {
  const env = process.env.SHMI_SETUP_TOKEN?.trim();
  if (env) return env;
  if (!isProduction()) return null;
  return (generated ??= randomBytes(18).toString('base64url'));
}

/** The token was generated (not configured), so the log has to show it. */
export const setupTokenGenerated = () => !process.env.SHMI_SETUP_TOKEN?.trim() && isProduction();

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export function setupTokenMatches(given: string | null | undefined): boolean {
  const token = setupToken();
  if (!token) return true;
  if (!given) return false;
  return timingSafeEqual(digest(given.trim()), digest(token));
}
