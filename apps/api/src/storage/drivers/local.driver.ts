import { createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { SignedUrlOptions, StorageDriver } from '../storage.types';

export interface LocalTokenPayload {
  k: string;
  exp: number;
  f?: string;
  m?: string;
  d?: 'inline' | 'attachment';
}

/** Filesystem driver for development and tests. Files are written read-only (0o444). */
export class LocalStorageDriver implements StorageDriver {
  readonly kind = 'LOCAL' as const;
  private readonly root: string;

  constructor(
    root: string,
    private readonly signingSecret: string,
  ) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return p;
  }

  async putIfAbsent(key: string, body: Buffer): Promise<'created' | 'exists'> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    try {
      await writeFile(p, body, { flag: 'wx', mode: 0o444 });
      return 'created';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw err;
    }
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.signingSecret).update(payload).digest('base64url');
  }

  /** Relative URL served by FilesController (proxied through the web app at /api). */
  async signedUrl(key: string, opts: SignedUrlOptions): Promise<string> {
    const payload: LocalTokenPayload = {
      k: key,
      exp: Math.floor(Date.now() / 1000) + opts.ttlSeconds,
      ...(opts.filename ? { f: opts.filename } : {}),
      ...(opts.mimeType ? { m: opts.mimeType } : {}),
      ...(opts.disposition ? { d: opts.disposition } : {}),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `/api/files/local/${body}.${this.sign(body)}`;
  }

  verifyToken(token: string): LocalTokenPayload | null {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LocalTokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  }

  async healthCheck(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await access(this.root, constants.W_OK);
  }
}
