import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { trustProxy } from '../runtime.ts';

/**
 * The request came over HTTPS: directly, or (TRUST_PROXY=1) through a
 * reverse proxy that terminated TLS and set X-Forwarded-Proto.
 */
export function isHttps(c: Context): boolean {
  if (new URL(c.req.url).protocol === 'https:') return true;
  if (!trustProxy()) return false;
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return proto === 'https';
}

/**
 * Client IP for rate limiting. Behind a trusted proxy it is the last entry of
 * X-Forwarded-For (the address the proxy itself saw; earlier entries are
 * supplied by the client and can be forged). Otherwise the socket address.
 */
export function clientIp(c: Context): string {
  if (trustProxy()) {
    const xff = c.req.header('x-forwarded-for');
    const last = xff?.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
    const real = c.req.header('x-real-ip')?.trim();
    if (real) return real;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    // app.request() in tests has no socket.
    return 'unknown';
  }
}
