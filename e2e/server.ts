/**
 * The e2e server: the API (apps/server/src/index.ts) with an in-process S3
 * mock as its off-site backup storage (SHMI_BACKUP_S3_*), so the cloud
 * archive screens run against a real HTTP/SigV4 round trip.
 */
import { startS3Mock } from '../apps/server/test/s3Mock.ts';

const s3 = await startS3Mock({ bucket: 'e2e-backups', accessKeyId: 'E2EKEY', secretAccessKey: 'e2e-secret-key' });
Object.assign(process.env, {
  SHMI_BACKUP_S3_ENDPOINT: s3.url,
  SHMI_BACKUP_S3_BUCKET: 'e2e-backups',
  SHMI_BACKUP_S3_ACCESS_KEY: 'E2EKEY',
  SHMI_BACKUP_S3_SECRET_KEY: 'e2e-secret-key',
  SHMI_BACKUP_SCHEDULE: 'off',
  SHMI_BACKUP_KEEP: '5',
});
await import('../apps/server/src/index.ts');
