import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { bodyLimits as limits } from '../runtime.ts';
import { isHttps } from './http.ts';

/**
 * Content Security Policy of the single-page app. Scripts only from the
 * server itself; styles also inline (React 19 hoists the <style> elements of
 * the print layouts, and the hidden print frame writes its own). Downloads and
 * scanned pages use blob: URLs; the scanner needs the camera (Permissions-Policy).
 * External services (ECB, VIES, SMTP) are called by the server, not the browser.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Security headers on every response; HSTS only over HTTPS (directly or via a trusted proxy). */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set('Content-Security-Policy', CSP);
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('X-Frame-Options', 'DENY');
    h.set('Referrer-Policy', 'same-origin');
    h.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    if (isHttps(c)) h.set('Strict-Transport-Security', 'max-age=31536000');
    if (c.req.path.startsWith('/api/') && !h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  };
}

/**
 * Routes that take files (imports, bank statements, backups, attachments,
 * NAP files, report e-mails); every other API request is limited to
 * MAX_JSON_BODY_MB (default 4 MB). Uploads get MAX_UPLOAD_MB (default 100 MB).
 */
const UPLOAD_ROUTES: RegExp[] = [
  /^\/api\/exchange\//,
  /^\/api\/bank-statements\/parse$/,
  /^\/api\/backups\/restore$/,
  /^\/api\/assets\/import-excel$/,
  /^\/api\/journal\/entries\/\d+\/attachments$/,
  /^\/api\/vat\/(nap-check(\/import)?|import)$/,
  /^\/api\/email\/report$/,
];

export const isUploadRoute = (path: string) => UPLOAD_ROUTES.some((r) => r.test(path));

export function bodyLimits(): MiddlewareHandler {
  const tooLarge = (): never => {
    throw new HTTPException(413);
  };
  const { json, upload } = limits();
  const small = bodyLimit({ maxSize: json, onError: tooLarge });
  const large = bodyLimit({ maxSize: upload, onError: tooLarge });
  return (c, next) => (isUploadRoute(c.req.path) ? large(c, next) : small(c, next));
}
