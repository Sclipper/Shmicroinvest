import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { signV4 } from '../src/services/offsite/s3.ts';

/**
 * A minimal in-process S3 server for the off-site backup tests (path-style
 * PUT/GET/DELETE object, ListObjectsV2 with pages). Every request's SigV4
 * signature is recomputed from what actually arrived (method, decoded path,
 * query, host, body hash) and refused with SignatureDoesNotMatch when it
 * differs, so encoding mistakes between the signed and the sent request fail.
 */
export interface S3Mock {
  url: string;
  port: number;
  objects: Map<string, { data: Uint8Array; lastModified: Date }>;
  requests: { method: string; path: string }[];
  /** Answer every request with this HTTP status (simulates an outage) until cleared. */
  failWith: number | null;
  close: () => Promise<void>;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

export async function startS3Mock(o: { bucket?: string; accessKeyId?: string; secretAccessKey?: string; region?: string; port?: number; maxKeys?: number } = {}): Promise<S3Mock> {
  const bucket = o.bucket ?? 'backups';
  const accessKeyId = o.accessKeyId ?? 'TESTKEY';
  const secretAccessKey = o.secretAccessKey ?? 'TESTSECRET';
  const region = o.region ?? 'us-east-1';
  const objects = new Map<string, { data: Uint8Array; lastModified: Date }>();
  const requests: { method: string; path: string }[] = [];
  let clock = 0;
  const state = { failWith: null as number | null };
  const server: Server = createServer(async (req, res) => {
    const send = (status: number, text = '', type = 'application/xml') => {
      res.writeHead(status, { 'content-type': type });
      res.end(text);
    };
    const error = (status: number, code: string, message: string) => send(status, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`);
    try {
      const data = await body(req);
      const url = new URL(req.url ?? '/', 'http://x');
      const path = decodeURIComponent(url.pathname);
      requests.push({ method: req.method ?? '', path });
      if (state.failWith) return error(state.failWith, 'ServiceUnavailable', 'Mock outage');
      // Signature check.
      const auth = req.headers.authorization ?? '';
      const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(auth);
      if (!m || m[1] !== accessKeyId) return error(403, 'InvalidAccessKeyId', 'Unknown access key');
      const payloadHash = createHash('sha256').update(data).digest('hex');
      if (req.headers['x-amz-content-sha256'] !== payloadHash) return error(400, 'XAmzContentSHA256Mismatch', 'Payload hash mismatch');
      const signed = m[4]!.split(';');
      const extra: Record<string, string> = {};
      for (const h of signed) if (!['host', 'x-amz-date', 'x-amz-content-sha256'].includes(h)) extra[h] = String(req.headers[h] ?? '');
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;
      const expected = signV4({
        method: req.method ?? 'GET', host: String(req.headers.host), path, query, headers: extra, payloadHash,
        amzDate: String(req.headers['x-amz-date']), region: m[3]!, accessKeyId, secretAccessKey,
      }).authorization;
      if (m[3] !== region || expected !== auth) return error(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.');
      const [, b, ...rest] = path.split('/');
      if (b !== bucket) return error(404, 'NoSuchBucket', 'The specified bucket does not exist');
      const key = rest.join('/');
      if (req.method === 'GET' && !key) {
        const prefix = query.prefix ?? '';
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = query['continuation-token'] ? all.indexOf(query['continuation-token']) : 0;
        const page = all.slice(Math.max(0, start), Math.max(0, start) + (o.maxKeys ?? 1000));
        const next = all[Math.max(0, start) + page.length];
        return send(200, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextContinuationToken>${xml(next)}</NextContinuationToken>` : ''}${page.map((k) => `<Contents><Key>${xml(k)}</Key><LastModified>${objects.get(k)!.lastModified.toISOString()}</LastModified><Size>${objects.get(k)!.data.length}</Size></Contents>`).join('')}</ListBucketResult>`);
      }
      if (req.method === 'PUT') {
        const t = Math.max(Date.now(), clock + 1);
        clock = t;
        objects.set(key, { data, lastModified: new Date(t) });
        return send(200);
      }
      if (req.method === 'GET') {
        const obj = objects.get(key);
        if (!obj) return error(404, 'NoSuchKey', 'The specified key does not exist.');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': obj.data.length });
        return res.end(Buffer.from(obj.data));
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      return error(405, 'MethodNotAllowed', 'Not supported by the mock');
    } catch (e) {
      return error(500, 'InternalError', (e as Error).message);
    }
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, port, objects, requests,
    get failWith() { return state.failWith; },
    set failWith(v) { state.failWith = v; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
