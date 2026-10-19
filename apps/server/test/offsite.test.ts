import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unzipStore, ZipPasswordError } from '@shmi/core';
import { createTestCompany, type TestCompany } from './helpers.ts';
import { startS3Mock, type S3Mock } from './s3Mock.ts';
import { S3Client, signV4 } from '../src/services/offsite/s3.ts';
import { offsiteSettings, runOffsiteBackups, startOffsiteScheduler, uploadOffsite, offsiteState } from '../src/services/offsite/offsite.ts';
import { buildBackup } from '../src/services/exchange/backup.ts';

/** Off-site backups to S3-compatible storage (cloud archive of 01b 2 / 04b 3, adapted). */

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', amzDate: '20130524T000000Z' };
const sig = (h: Record<string, string>) => /Signature=([0-9a-f]+)/.exec(h.authorization!)![1];

describe('SigV4 (AWS S3 documentation examples)', () => {
  it('GET object with a Range header', () => {
    const h = signV4({ ...AWS, method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' }, payloadHash: EMPTY });
    expect(sig(h)).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('PUT object with an encoded key and extra headers', () => {
    const payloadHash = createHash('sha256').update('Welcome to Amazon S3.').digest('hex');
    const h = signV4({ ...AWS, method: 'PUT', host: 'examplebucket.s3.amazonaws.com', path: '/test$file.text', headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payloadHash });
    expect(sig(h)).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('GET bucket (list objects) with a query string', () => {
    const h = signV4({ ...AWS, method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/', query: { 'max-keys': '2', prefix: 'J' }, payloadHash: EMPTY });
    expect(sig(h)).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });
});

describe('settings from the environment', () => {
  it('off without a bucket; defaults; path-style except on AWS; incomplete settings refused', () => {
    expect(offsiteSettings({})).toBeNull();
    const s = offsiteSettings({ SHMI_BACKUP_S3_BUCKET: 'b', SHMI_BACKUP_S3_ACCESS_KEY: 'k', SHMI_BACKUP_S3_SECRET_KEY: 's', SHMI_BACKUP_S3_ENDPOINT: 'https://fsn1.your-objectstorage.com', SHMI_BACKUP_S3_REGION: 'fsn1' })!;
    expect(s).toMatchObject({ prefix: 'shmelta/', keep: 14, schedule: { times: ['02:00'] }, zipPassword: null, s3: { pathStyle: true, region: 'fsn1' } });
    const aws = offsiteSettings({ SHMI_BACKUP_S3_BUCKET: 'b', SHMI_BACKUP_S3_ACCESS_KEY: 'k', SHMI_BACKUP_S3_SECRET_KEY: 's', SHMI_BACKUP_S3_REGION: 'eu-central-1', SHMI_BACKUP_SCHEDULE: 'off', SHMI_BACKUP_PREFIX: 'firm', SHMI_BACKUP_KEEP: '3' })!;
    expect(aws).toMatchObject({ prefix: 'firm/', keep: 3, schedule: null, s3: { endpoint: 'https://s3.eu-central-1.amazonaws.com', pathStyle: false } });
    expect(() => offsiteSettings({ SHMI_BACKUP_S3_BUCKET: 'b' })).toThrow(/ACCESS_KEY/);
    expect(() => offsiteSettings({ SHMI_BACKUP_S3_BUCKET: 'b', SHMI_BACKUP_S3_ACCESS_KEY: 'k', SHMI_BACKUP_S3_SECRET_KEY: 's', SHMI_BACKUP_KEEP: '0' })).toThrow(/KEEP/);
    expect(() => offsiteSettings({ SHMI_BACKUP_S3_BUCKET: 'b', SHMI_BACKUP_S3_ACCESS_KEY: 'k', SHMI_BACKUP_S3_SECRET_KEY: 's', SHMI_BACKUP_SCHEDULE: 'нощем' })).toThrow(/schedule/);
  });
});

let s3: S3Mock;
let t: TestCompany;
const ENV = { SHMI_BACKUP_S3_BUCKET: 'backups', SHMI_BACKUP_S3_ACCESS_KEY: 'TESTKEY', SHMI_BACKUP_S3_SECRET_KEY: 'TESTSECRET', SHMI_BACKUP_PREFIX: 'test/', SHMI_BACKUP_KEEP: '3', SHMI_BACKUP_SCHEDULE: 'off' };
const setEnv = (extra: Record<string, string | undefined> = {}) => {
  for (const [k, v] of Object.entries({ ...ENV, SHMI_BACKUP_S3_ENDPOINT: s3.url, ...extra })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

beforeAll(async () => {
  s3 = await startS3Mock({ maxKeys: 2 });
  setEnv();
  t = await createTestCompany({ companyName: 'Облак ООД' });
}, 60_000);
afterAll(async () => {
  for (const k of [...Object.keys(ENV), 'SHMI_BACKUP_S3_ENDPOINT', 'SHMI_BACKUP_ZIP_PASSWORD']) delete process.env[k];
  await t.close();
  await s3.close();
});

const keys = () => [...s3.objects.keys()].sort();

describe('off-site archive', () => {
  it('a backup offers the upload; the upload is a ZIP of the backup under <prefix><database>/', async () => {
    const b = await t.call('POST', '/backups');
    expect(b.status, b.text).toBe(201);
    expect(b.body.cloudQuestion).toBe('Архивирането на фирмата завърши успешно. Желаете ли архивът да бъде качен и в облака?');
    const up = await t.call('POST', `/backups/${b.body.id}/offsite`);
    expect(up.status, up.text).toBe(200);
    const name = (b.body.fileName as string).replace(/\.shbak$/, '.zip');
    expect(up.body).toMatchObject({ key: `test/${t.companyDb}/${name}`, name, message: `Архивът „${name}“ е качен в облака успешно.` });
    const zip = s3.objects.get(up.body.key)!.data;
    expect([...unzipStore(zip, null).keys()]).toEqual([b.body.fileName]);
  });

  it('lists the archives for the restore screen (administrators)', async () => {
    const r = await t.call('GET', '/backups/offsite');
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ configured: true, keep: 3, schedule: null });
    expect(r.body.archives).toHaveLength(1);
    expect(r.body.archives[0]).toMatchObject({ database: t.companyDb, companyName: 'Облак ООД' });
  });

  it('keeps the newest N archives of a company (prune rule), across list pages', async () => {
    const s = offsiteSettings()!;
    const before = keys();
    for (const day of ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']) {
      const backup = await buildBackup(t.driver, t.companyDb, new Date(`${day}T02:00:00`));
      await uploadOffsite(s, t.companyDb, backup, null, new Date(`${day}T02:00:00`));
    }
    const after = keys().filter((k) => k.startsWith(`test/${t.companyDb}/`));
    // 3 kept: the newest uploads (the first archive and 01-02.03 pruned).
    expect(after.map((k) => k.replace(/.* - /, ''))).toEqual(['03.03.2026_02.00.zip', '04.03.2026_02.00.zip', '05.03.2026_02.00.zip']);
    expect(before.every((k) => !after.includes(k))).toBe(true);
    // Another company's archives are not touched by the prune of this one.
    s3.objects.set('test/other_db/Shmelta Pro - Облак ООД - 01.01.2026_02.00.zip', { data: new Uint8Array([1]), lastModified: new Date('2026-01-01') });
    const backup = await buildBackup(t.driver, t.companyDb, new Date('2026-03-06T02:00:00'));
    await uploadOffsite(s, t.companyDb, backup, null, new Date('2026-03-06T02:00:00'));
    expect(s3.objects.has('test/other_db/Shmelta Pro - Облак ООД - 01.01.2026_02.00.zip')).toBe(true);
    s3.objects.delete('test/other_db/Shmelta Pro - Облак ООД - 01.01.2026_02.00.zip');
  });

  it('restores a listed archive as a new company', async () => {
    const partner = await t.partner('Добавен след архива ООД');
    expect(partner).toBeGreaterThan(0);
    const list = (await t.call('GET', '/backups/offsite')).body.archives as { key: string; name: string }[];
    const newest = list[0]!;
    expect(newest.name).toContain('06.03.2026_02.00');
    const r = await t.call('POST', '/backups/offsite/restore', { key: newest.key, mode: 'new' });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ asNew: true, companyName: 'Облак ООД', message: 'Архивът е възстановен успешно като нова фирма „Облак ООД“.' });
    expect(r.body.database).not.toBe(t.companyDb);
    // The session moved to the restored company: the partner added after the backup is not there.
    const partners = (await t.call('GET', '/partners')).body as { name: string }[];
    expect(partners.some((p) => p.name === 'Добавен след архива ООД')).toBe(false);
    expect((await t.call('POST', '/login', { companyDb: t.companyDb, userId: 1, password: 'secret1' })).status).toBe(200);
  });

  it('ZIP password: uploads are protected; restore uses the typed, the storage or the user\'s password', async () => {
    setEnv({ SHMI_BACKUP_ZIP_PASSWORD: 'tajna-123' });
    const b = await t.call('POST', '/backups');
    const up = await t.call('POST', `/backups/${b.body.id}/offsite`);
    expect(up.status, up.text).toBe(200);
    expect(() => unzipStore(s3.objects.get(up.body.key)!.data, null)).toThrow(ZipPasswordError);
    // The storage password changed: the old archives need the typed one.
    setEnv({ SHMI_BACKUP_ZIP_PASSWORD: 'druga' });
    const wrong = await t.call('POST', '/backups/offsite/restore', { key: up.body.key, mode: 'new' });
    expect([wrong.status, wrong.body.error]).toEqual([422, 'Архивът е защитен с парола. Въведената парола е грешна или липсва.']);
    const ok = await t.call('POST', '/backups/offsite/restore', { key: up.body.key, mode: 'new', zipPassword: 'tajna-123' });
    expect(ok.status, ok.text).toBe(200);
    expect((await t.call('POST', '/login', { companyDb: t.companyDb, userId: 1, password: 'secret1' })).status).toBe(200);
    setEnv({ SHMI_BACKUP_ZIP_PASSWORD: undefined });
  });

  it('storage down, wrong credentials, unknown keys and no configuration give clear messages', async () => {
    const b = await t.call('POST', '/backups');
    s3.failWith = 503;
    const down = await t.call('POST', `/backups/${b.body.id}/offsite`);
    expect([down.status, down.body.error.split('\n')[0]]).toEqual([422, 'Няма връзка с облачното хранилище за архиви. Проверете настройките и връзката с интернет.']);
    expect((await t.call('GET', '/backups/offsite')).status).toBe(422);
    s3.failWith = null;
    setEnv({ SHMI_BACKUP_S3_SECRET_KEY: 'wrong' });
    const denied = await t.call('POST', `/backups/${b.body.id}/offsite`);
    expect(denied.status).toBe(422);
    expect(denied.body.messages.map((m: { text: string }) => m.text).join(' ')).toContain('SignatureDoesNotMatch');
    setEnv();
    const missing = await t.call('POST', '/backups/offsite/restore', { key: `test/${t.companyDb}/Shmelta Pro - Облак ООД - 01.01.2020_02.00.zip`, mode: 'new' });
    expect([missing.status, missing.body.error]).toEqual([422, 'Архивът „Shmelta Pro - Облак ООД - 01.01.2020_02.00.zip“ не е намерен в облака.']);
    const outside = await t.call('POST', '/backups/offsite/restore', { key: 'test/../secret.zip', mode: 'new' });
    expect(outside.status).toBe(422);
    setEnv({ SHMI_BACKUP_S3_BUCKET: undefined });
    expect((await t.call('GET', '/backups/offsite')).body).toMatchObject({ configured: false, archives: [] });
    expect((await t.call('POST', '/backups')).body.cloudQuestion).toBeNull();
    const off = await t.call('POST', `/backups/${b.body.id}/offsite`);
    expect([off.status, off.body.error]).toEqual([422, 'Не е настроено облачно хранилище за архиви.']);
    setEnv();
  });

  it('listing and restoring remote archives needs an administrator', async () => {
    const u = await t.call('POST', '/users', { name: 'Оператор', password: 'parola1', roleId: 5 });
    expect(u.status, u.text).toBe(201);
    expect((await t.call('POST', '/login', { companyDb: t.companyDb, userId: u.body.id, password: 'parola1' })).status).toBe(200);
    expect((await t.call('GET', '/backups/offsite')).status).toBe(403);
    expect((await t.call('POST', '/backups/offsite/restore', { key: 'test/x/y.zip', mode: 'new' })).status).toBe(403);
    expect((await t.call('POST', '/login', { companyDb: t.companyDb, userId: 1, password: 'secret1' })).status).toBe(200);
  });

  it('the daily schedule backs up every company once at its time', async () => {
    const other = await createTestCompany({ companyName: 'Втора ООД' });
    try {
      // Both companies live in their own PGlite drivers; the run of each test company covers its catalog.
      let clock = new Date('2026-10-20T01:58:00+03:00');
      const s = { ...offsiteSettings()!, schedule: { times: ['02:00'] } };
      const before = s3.objects.size;
      const stop = startOffsiteScheduler(other.driver, s, { intervalMs: 20, now: () => clock });
      await new Promise((r) => setTimeout(r, 100));
      expect(s3.objects.size).toBe(before);
      clock = new Date('2026-10-20T02:00:30+03:00');
      await vi_waitFor(() => offsiteState.lastRun?.slot === '2026-10-20 02:00');
      stop();
      expect(offsiteState.lastRun!.results).toEqual([expect.objectContaining({ database: other.companyDb, companyName: 'Втора ООД', ok: true })]);
      expect(keys().filter((k) => k.startsWith(`test/${other.companyDb}/`))).toHaveLength(1);
      // The manual "all companies" run does the same.
      const runAll = await runOffsiteBackups(t.driver, offsiteSettings()!);
      expect(runAll.every((r) => r.ok)).toBe(true);
    } finally {
      await other.close();
    }
  });

  it('S3Client.list pages through truncated results', async () => {
    const c = new S3Client(offsiteSettings()!.s3);
    const all = await c.list('test/');
    expect(all.length).toBe(keys().filter((k) => k.startsWith('test/')).length);
    expect(all.length).toBeGreaterThan(2);
    expect(s3.requests.some((r) => r.method === 'GET')).toBe(true);
  });
});

async function vi_waitFor(cond: () => boolean, timeoutMs = 20_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
