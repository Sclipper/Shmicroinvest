import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

/**
 * Runtime settings shared by the server modules: the release version, where
 * the bundled files are, and the production switches read from the
 * environment (see .env.example for the full list).
 */

/** Version of this release (package.json; the bundle inlines it). */
export const APP_VERSION: string = pkg.version;

/**
 * The release bundle (scripts/release-bundle.ts) is one server.js next to
 * web/ and migrations/; it sets SHMI_BUNDLED at build time. From the sources
 * the folders are found relative to this file.
 */
const BUNDLED = process.env.SHMI_BUNDLED === '1';
const here = path.dirname(fileURLToPath(import.meta.url));

export const PATHS = {
  companyMigrations: BUNDLED ? path.join(here, 'migrations/company') : path.join(here, 'db/company/migrations'),
  catalogMigrations: BUNDLED ? path.join(here, 'migrations/catalog') : path.join(here, 'db/catalog/migrations'),
  webDist: process.env.WEB_DIST ? path.resolve(process.env.WEB_DIST) : BUNDLED ? path.join(here, 'web') : path.resolve(here, '../../web/dist'),
  /** Default data directory of the embedded database (DATA_DIR overrides it). */
  defaultDataDir: BUNDLED ? path.join(here, 'data') : path.resolve(here, '../.data'),
};

export const isProduction = () => process.env.NODE_ENV === 'production';

/** TRUST_PROXY=1: the server runs behind a reverse proxy (Caddy, nginx, a PaaS router) that sets X-Forwarded-*. */
export const trustProxy = () => ['1', 'true', 'yes'].includes((process.env.TRUST_PROXY ?? '').toLowerCase());

const num = (v: string | undefined, def: number) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : def;
};

/** Sessions: idle timeout and absolute lifetime (minutes / days). */
export const sessionIdleMs = () => num(process.env.SESSION_IDLE_MINUTES, 12 * 60) * 60_000;
export const sessionMaxAgeMs = () => num(process.env.SESSION_MAX_AGE_DAYS, 14) * 86400_000;

/** Request body limits in bytes: ordinary JSON requests and file uploads (imports, backups). */
export const bodyLimits = () => ({
  json: num(process.env.MAX_JSON_BODY_MB, 4) * 1024 * 1024,
  upload: num(process.env.MAX_UPLOAD_MB, 100) * 1024 * 1024,
});

/** Failed logins (and setup-token attempts) allowed per client IP in LOGIN_IP_WINDOW_MINUTES. */
export const loginIpLimit = () => ({
  max: num(process.env.LOGIN_IP_MAX_FAILURES, 20),
  windowMs: num(process.env.LOGIN_IP_WINDOW_MINUTES, 15) * 60_000,
});
