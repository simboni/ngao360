export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');

export interface SignedUrlOptions {
  ttlSeconds: number;
  filename?: string;
  mimeType?: string;
  /** 'inline' to view in the browser (images/PDF), 'attachment' to download. */
  disposition?: 'inline' | 'attachment';
}

/**
 * Object-storage driver. Implementations must never overwrite an existing key:
 * originals are immutable (content-addressed by SHA-256).
 */
export interface StorageDriver {
  readonly kind: 'LOCAL' | 'S3';
  /** Write only if the key does not exist. */
  putIfAbsent(key: string, body: Buffer, mimeType: string): Promise<'created' | 'exists'>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  signedUrl(key: string, opts: SignedUrlOptions): Promise<string>;
  healthCheck(): Promise<void>;
  /** Optional start-up check that write protection (e.g. S3 Object Lock) is in place. Throws if not. */
  assertObjectLockReady?(): Promise<void>;
}
