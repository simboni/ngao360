import sharp from 'sharp';

/** Image types the server can decode and re-encode (HEIC/HEVC is not among them). */
export const SANITIZABLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export function isSanitizableImage(mimeType: string): boolean {
  return (SANITIZABLE_IMAGE_TYPES as readonly string[]).includes(mimeType);
}

export class ImageSanitizeError extends Error {}

export interface SanitizedImage {
  buffer: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
}

/**
 * Decode an image and encode a fresh copy from its pixels only. Every metadata
 * block (EXIF with GPS position, device serial and capture time, XMP, IPTC, ICC
 * comments, PNG text chunks) is dropped, because sharp writes none unless asked
 * to. The EXIF orientation is applied to the pixels first, so the copy looks the
 * same. Re-encoding from pixels also discards anything appended to or hidden in
 * the original container.
 *
 * Browsers already shrink and re-encode portal photos, but not HEIC files, not
 * in browsers without createImageBitmap and not after a decode error, so the
 * server never relies on it.
 */
export async function sanitizeImage(input: Buffer, mimeType: string, maxEdge = 2048): Promise<SanitizedImage> {
  if (!isSanitizableImage(mimeType)) throw new ImageSanitizeError(`Cannot re-encode ${mimeType}`);
  try {
    const pipeline = sharp(input, { failOn: 'error', limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
    if (mimeType === 'image/png') return { buffer: await pipeline.png({ compressionLevel: 9 }).toBuffer(), mimeType: 'image/png', extension: 'png' };
    if (mimeType === 'image/webp') return { buffer: await pipeline.webp({ quality: 85 }).toBuffer(), mimeType: 'image/webp', extension: 'webp' };
    return { buffer: await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer(), mimeType: 'image/jpeg', extension: 'jpg' };
  } catch (err) {
    throw new ImageSanitizeError((err as Error).message);
  }
}
