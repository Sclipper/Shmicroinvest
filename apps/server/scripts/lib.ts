import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.ts';
import { createDriver, type DbDriver } from '../src/db/provider.ts';

/**
 * Shared bits of the volume seed (seed-volume.ts) and the perf script
 * (perf.ts): command-line options, the storage driver (PGlite on disk under
 * DATA_DIR, or Postgres with DATABASE_URL) and an in-process API client with
 * a session cookie.
 */

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Default data root of the scripts; kept apart from the dev server's apps/server/.data. */
export const DEFAULT_DATA_DIR = path.resolve(SCRIPTS_DIR, '../.data-perf');

/** --key=value / --flag options. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]!] = m[2] ?? 'true';
  }
  return out;
}

export function openDriver(dataDir?: string): DbDriver {
  if (!process.env.DATABASE_URL) process.env.DATA_DIR = dataDir ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
  return createDriver();
}

export interface ApiResult<T = any> { status: number; body: T; text: string; size: number; headers: Headers; ms: number }

/** In-process client of the Hono app (app.request), keeping the session cookie like a browser. */
export function apiClient(driver: DbDriver) {
  const app = createApp(driver);
  let cookie = '';
  async function raw(method: string, url: string, body?: unknown) {
    const t0 = performance.now();
    const res = await app.request(`/api${url}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const set of res.headers.getSetCookie()) cookie = set.split(';')[0]!;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { res, bytes, ms: performance.now() - t0 };
  }
  async function call<T = any>(method: string, url: string, body?: unknown): Promise<ApiResult<T>> {
    const { res, bytes, ms } = await raw(method, url, body);
    const text = (res.headers.get('content-type') ?? '').includes('json') || (res.headers.get('content-type') ?? '').startsWith('text') ? new TextDecoder().decode(bytes) : '';
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T, text: text.slice(0, 2000), size: bytes.length, headers: res.headers, ms };
  }
  /** Like call, but throws on an unexpected status. */
  async function must<T = any>(method: string, url: string, body?: unknown, ok: number[] = [200, 201]): Promise<T> {
    const r = await call<T>(method, url, body);
    if (!ok.includes(r.status)) throw new Error(`${method} ${url}: ${r.status} ${r.text}`);
    return r.body;
  }
  return { app, call, must, raw, cookie: { get: () => cookie, set: (v: string) => { cookie = v; } } };
}
export type ApiClient = ReturnType<typeof apiClient>;

/** Deterministic PRNG (mulberry32) so a seed size always produces the same company. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}

export const fmtMs = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
