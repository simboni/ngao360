import {
  GetObjectCommand,
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
}

/** S3 / MinIO driver. Bucket must be private; objects are served via short-lived signed URLs. */
export class S3StorageDriver implements StorageDriver {
  readonly kind = 'S3' as const;
  private readonly client: S3Client;

  constructor(private readonly opts: S3DriverOptions) {
    this.client = new S3Client({
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
}
