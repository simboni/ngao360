import {
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { SignedUrlOptions, StorageDriver } from '../storage.types';

export interface S3DriverOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
  /** Object Lock retention for every object written (originals are content-addressed and immutable). */
  objectLock?: { mode: 'COMPLIANCE' | 'GOVERNANCE'; days: number } | null;
  /** Injected client (unit tests); production builds its own from the options above. */
  client?: S3Client;
  /** Clock for retention dates (unit tests). */
  now?: () => Date;
}

/** Retain-until date for an object written at `now` with `days` of retention (UTC, whole seconds). */
export function objectLockRetainUntil(now: Date, days: number): Date {
  const d = new Date(now.getTime() + days * 86_400_000);
  d.setUTCMilliseconds(0);
  return d;
}

/**
 * S3 / MinIO driver. Bucket must be private; objects are served via short-lived signed URLs.
 * With `objectLock` every write carries a retention (S3_OBJECT_LOCK_MODE / S3_OBJECT_LOCK_DAYS), so
 * an original cannot be deleted or overwritten in storage until it expires, even with the root key.
 */
export class S3StorageDriver implements StorageDriver {
  readonly kind = 'S3' as const;
  private readonly client: S3Client;

  constructor(private readonly opts: S3DriverOptions) {
    this.client = opts.client ?? new S3Client({
      region: opts.region,
      forcePathStyle: opts.forcePathStyle,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      ...(opts.accessKeyId && opts.secretAccessKey
        ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
        : {}),
    });
  }

  async putIfAbsent(key: string, body: Buffer, mimeType: string): Promise<'created' | 'exists'> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.opts.bucket,
          Key: key,
          Body: body,
          ContentType: mimeType,
          IfNoneMatch: '*',
          ServerSideEncryption: this.opts.endpoint ? undefined : 'AES256',
          // Object Lock: the SDK adds the Content-MD5 / checksum header S3 requires with retention.
          ...(this.opts.objectLock
            ? {
                ObjectLockMode: this.opts.objectLock.mode,
                ObjectLockRetainUntilDate: objectLockRetainUntil(this.opts.now?.() ?? new Date(), this.opts.objectLock.days),
              }
            : {}),
        }),
      );
      return 'created';
    } catch (err) {
      if (err instanceof S3ServiceException && (err.$metadata.httpStatusCode === 412 || err.name === 'PreconditionFailed')) {
        return 'exists';
      }
      throw err;
    }
  }

  async get(key: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    const bytes = await out.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Empty object ${key}`);
    return Buffer.from(bytes);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return true;
    } catch (err) {
      if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) return false;
      throw err;
    }
  }

  signedUrl(key: string, opts: SignedUrlOptions): Promise<string> {
    const disposition = opts.disposition ?? 'attachment';
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        ResponseContentDisposition: opts.filename
          ? `${disposition}; filename="${opts.filename.replace(/"/g, '')}"`
          : disposition,
        ...(opts.mimeType ? { ResponseContentType: opts.mimeType } : {}),
      }),
      { expiresIn: opts.ttlSeconds },
    );
  }

  async healthCheck(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
  }

  /**
   * Fails unless the bucket has Object Lock enabled when retention is configured, so a deployment
   * pointed at an unlocked bucket stops at start-up instead of writing unprotected originals.
   */
  async assertObjectLockReady(): Promise<void> {
    if (!this.opts.objectLock) return;
    const out = await this.client.send(new GetObjectLockConfigurationCommand({ Bucket: this.opts.bucket }));
    if (out.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled') {
      throw new Error(`S3 bucket ${this.opts.bucket} does not have Object Lock enabled (S3_OBJECT_LOCK_MODE=${this.opts.objectLock.mode})`);
    }
  }
}
