import { createHash, createHmac } from 'node:crypto';
import { child, children, parseXml } from '@shmi/core';

/**
 * A minimal S3 client (PUT, GET, DELETE, ListObjectsV2) with AWS Signature
 * Version 4, for the off-site backups. Written here instead of pulling in the
 * AWS SDK (dozens of packages for four calls); the signing follows the AWS
 * SigV4 documentation and is checked against its published S3 example. Works
 * with AWS S3, Hetzner Object Storage, Backblaze B2 (S3 API), MinIO, Garage
 * and SeaweedFS.
 */

export interface S3Config {
  /** "https://s3.eu-central-1.amazonaws.com", "https://fsn1.your-objectstorage.com", "http://127.0.0.1:9000". */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style URLs (endpoint/bucket/key) instead of virtual-hosted ones (bucket.endpoint/key). */
  pathStyle: boolean;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

export class S3Error extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const sha256Hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Uint8Array | string, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it (unreserved characters kept; "/" kept in paths only). */
export function awsUriEncode(s: string, keepSlash = false): string {
  let out = '';
  for (const byte of new TextEncoder().encode(s)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === '/')) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export interface SignInput {
  method: string;
  /** Host header value (with the port when not the default). */
  host: string;
  /** Path, not yet encoded ("/bucket/key with space"). */
  path: string;
  query?: Record<string, string>;
  /** Extra headers to sign (lower-case names). */
  headers?: Record<string, string>;
  payloadHash: string;
  /** "20130524T000000Z". */
  amzDate: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  service?: string;
}

/** SigV4 headers of a request: host, x-amz-date, x-amz-content-sha256 and Authorization. */
export function signV4(i: SignInput): Record<string, string> {
  const service = i.service ?? 's3';
  const headers: Record<string, string> = { ...(i.headers ?? {}), host: i.host, 'x-amz-content-sha256': i.payloadHash, 'x-amz-date': i.amzDate };
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonicalQuery = Object.entries(i.query ?? {})
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [i.method, awsUriEncode(i.path, true), canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), i.payloadHash].join('\n');
  const day = i.amzDate.slice(0, 8);
  const scope = `${day}/${i.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

const amzDateOf = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export interface S3Object { key: string; size: number; lastModified: string }

export class S3Client {
  readonly config: S3Config;
  constructor(config: S3Config) {
    this.config = config;
  }

  private target(key: string) {
    const base = new URL(this.config.endpoint);
    const prefixPath = base.pathname.replace(/\/+$/, '');
    if (this.config.pathStyle) return { origin: base.origin, host: base.host, path: `${prefixPath}/${this.config.bucket}${key ? `/${key}` : ''}`, protocol: base.protocol };
    const host = `${this.config.bucket}.${base.host}`;
    return { origin: `${base.protocol}//${host}`, host, path: `${prefixPath}/${key}`, protocol: base.protocol };
  }

  async request(method: string, key: string, o: { query?: Record<string, string>; body?: Uint8Array; headers?: Record<string, string> } = {}) {
    const t = this.target(key);
    const payloadHash = o.body ? sha256Hex(o.body) : EMPTY_SHA256;
    const headers = signV4({
      method, host: t.host, path: t.path, query: o.query, headers: o.headers, payloadHash, amzDate: amzDateOf(new Date()),
      region: this.config.region, accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey,
    });
    delete headers.host;
    const qs = Object.entries(o.query ?? {}).map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`).join('&');
    const url = `${t.origin}${awsUriEncode(t.path, true)}${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, {
      method, headers, body: o.body ? (o.body as Uint8Array<ArrayBuffer>) : undefined,
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? `HTTP${res.status}`;
      const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? res.statusText;
      throw new S3Error(res.status, code, `${method} ${key || '/'}: ${res.status} ${code} ${message}`.trim());
    }
    return res;
  }

  async put(key: string, body: Uint8Array, contentType = 'application/zip') {
    await this.request('PUT', key, { body, headers: { 'content-type': contentType } });
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.request('GET', key);
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(key: string) {
    await this.request('DELETE', key);
  }

  /** ListObjectsV2 of every object under the prefix (all pages). */
  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;
      const res = await this.request('GET', '', { query });
      const root = parseXml(await res.text());
      for (const c of children(root, 'Contents')) {
        out.push({ key: child(c, 'Key')?.text ?? '', size: Number(child(c, 'Size')?.text ?? 0), lastModified: new Date(child(c, 'LastModified')?.text ?? 0).toISOString() });
      }
      token = child(root, 'IsTruncated')?.text === 'true' ? child(root, 'NextContinuationToken')?.text : undefined;
      if (!token) break;
    }
    return out;
  }
}
