import { GetObjectLockConfigurationCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { objectLockRetainUntil, S3StorageDriver } from '../drivers/s3.driver';
import { loadConfig } from '../../config/config.schema';

/** Records every command and serialises PutObject through the real SDK middleware stack (headers). */
function mockClient(reply: (cmd: unknown) => unknown = () => ({})): { client: S3Client; sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    client: {
      send: jest.fn(async (cmd: unknown) => {
        sent.push(cmd);
        return reply(cmd);
      }),
    } as unknown as S3Client,
  };
}

const NOW = new Date('2027-08-10T07:30:15.250Z');

describe('S3 driver: Object Lock retention on originals', () => {
  it('writes every original with COMPLIANCE retention for the configured days and If-None-Match', async () => {
    const { client, sent } = mockClient();
    const driver = new S3StorageDriver({
      region: 'af-south-1',
      bucket: 'ngao360-originals',
      forcePathStyle: false,
      objectLock: { mode: 'COMPLIANCE', days: 2555 },
      client,
      now: () => NOW,
    });
    await expect(driver.putIfAbsent('tenants/t1/sha256/ab/abcd', Buffer.from('form'), 'image/png')).resolves.toBe('created');
    expect(sent).toHaveLength(1);
    const cmd = sent[0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input.ObjectLockMode).toBe('COMPLIANCE');
    expect(cmd.input.ObjectLockRetainUntilDate).toEqual(new Date('2034-08-08T07:30:15.000Z'));
    expect(cmd.input.IfNoneMatch).toBe('*');
    expect(cmd.input.ServerSideEncryption).toBe('AES256');
    expect(cmd.input.ObjectLockLegalHoldStatus).toBeUndefined();
  });

  it('serialises the retention into the x-amz-object-lock-* request headers', async () => {
    // Real client with a request handler that captures the HTTP request instead of sending it.
    const { S3Client: RealClient } = await import('@aws-sdk/client-s3');
    const captured: Array<{ headers: Record<string, string> }> = [];
    const real = new RealClient({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestHandler: {
        handle: async (req: { headers: Record<string, string> }) => {
          captured.push({ headers: { ...req.headers } });
          const { Readable } = await import('node:stream');
          return { response: { statusCode: 200, headers: { etag: '"x"' }, body: Readable.from([]) } };
        },
      } as never,
    });
    const driver = new S3StorageDriver({
      endpoint: 'http://127.0.0.1:9',
      region: 'us-east-1',
      bucket: 'b',
      forcePathStyle: true,
      objectLock: { mode: 'COMPLIANCE', days: 30 },
      client: real,
      now: () => NOW,
    });
    await driver.putIfAbsent('k', Buffer.from('hello'), 'text/plain');
    expect(captured).toHaveLength(1);
    const h = captured[0]!.headers;
    expect(h['x-amz-object-lock-mode']).toBe('COMPLIANCE');
    expect(new Date(h['x-amz-object-lock-retain-until-date']!).toISOString()).toBe('2027-09-09T07:30:15.000Z');
    expect(h['if-none-match']).toBe('*');
    // S3 refuses retention without an integrity header; the SDK must have added one.
    expect(Object.keys(h).some((k) => k === 'content-md5' || k.startsWith('x-amz-checksum-'))).toBe(true);
  });

  it('writes without retention when Object Lock is off', async () => {
    const { client, sent } = mockClient();
    const driver = new S3StorageDriver({ region: 'r', bucket: 'b', forcePathStyle: true, endpoint: 'http://minio:9000', client });
    await driver.putIfAbsent('k', Buffer.from('x'), 'image/png');
    const cmd = sent[0] as PutObjectCommand;
    expect(cmd.input.ObjectLockMode).toBeUndefined();
    expect(cmd.input.ObjectLockRetainUntilDate).toBeUndefined();
  });

  it('refuses to start against a bucket without Object Lock, accepts one with it', async () => {
    const off = new S3StorageDriver({
      region: 'r',
      bucket: 'b',
      forcePathStyle: true,
      objectLock: { mode: 'COMPLIANCE', days: 1 },
      client: mockClient(() => ({ ObjectLockConfiguration: undefined })).client,
    });
    await expect(off.assertObjectLockReady()).rejects.toThrow(/does not have Object Lock enabled/);
    const { client, sent } = mockClient(() => ({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } }));
    const on = new S3StorageDriver({ region: 'r', bucket: 'b', forcePathStyle: true, objectLock: { mode: 'COMPLIANCE', days: 1 }, client });
    await expect(on.assertObjectLockReady()).resolves.toBeUndefined();
    expect(sent[0]).toBeInstanceOf(GetObjectLockConfigurationCommand);
    // No lock configured: no call at all.
    const none = mockClient();
    await new S3StorageDriver({ region: 'r', bucket: 'b', forcePathStyle: true, client: none.client }).assertObjectLockReady();
    expect(none.sent).toHaveLength(0);
  });

  it('computes retain-until in whole UTC seconds', () => {
    expect(objectLockRetainUntil(NOW, 1).toISOString()).toBe('2027-08-11T07:30:15.000Z');
  });

  it('production with S3 requires Object Lock unless explicitly waived', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://x',
      APP_DATABASE_URL: 'postgresql://y',
      COOKIE_SECURE: 'true',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      MESSAGING_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
      MESSAGING_HASH_KEY: Buffer.alloc(32, 3).toString('base64'),
      AGENT_DATA_KEY: Buffer.alloc(32, 4).toString('base64'),
      STORAGE_DRIVER: 's3',
    };
    expect(() => loadConfig(base)).toThrow(/S3_OBJECT_LOCK_MODE must be COMPLIANCE/);
    expect(loadConfig({ ...base, S3_OBJECT_LOCK_MODE: 'COMPLIANCE', S3_OBJECT_LOCK_DAYS: '3650' }).S3_OBJECT_LOCK_DAYS).toBe(3650);
    expect(loadConfig({ ...base, S3_OBJECT_LOCK_ALLOW_OFF: 'true' }).S3_OBJECT_LOCK_MODE).toBe('off');
  });
});
