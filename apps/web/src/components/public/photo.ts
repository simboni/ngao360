/**
 * Optional S24 photo handling in the browser.
 *
 * - Checks type and size before upload (the API sniffs the bytes again).
 * - Re-encodes JPEG/PNG/WebP photos to a JPEG of at most 1600 px on the long
 *   side. That saves mobile data and drops hidden metadata such as GPS
 *   coordinates (EXIF), which the person may not know is in the file.
 * - HEIC is converted when the browser can decode it (Safari can). The server
 *   cannot decode HEIC, so it refuses HEIC uploads rather than keep a file it
 *   cannot strip of location data; the form asks for another photo instead.
 * - The server re-encodes every photo again, so metadata is removed even when
 *   this step is skipped.
 */

export type PhotoCheck = { ok: true } | { ok: false; reason: 'type' | 'size' };

const EXTENSION_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heic',
};

/** Best guess of the MIME type (some phones report HEIC with an empty type). */
export function photoType(file: { name: string; type: string }): string {
  if (file.type) return file.type.toLowerCase() === 'image/heif' ? 'image/heic' : file.type.toLowerCase();
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[ext] ?? '';
}

export function checkPhoto(file: { name: string; type: string; size: number }, maxBytes: number, accepted: readonly string[]): PhotoCheck {
  if (!accepted.includes(photoType(file))) return { ok: false, reason: 'type' };
  if (file.size > maxBytes) return { ok: false, reason: 'size' };
  return { ok: true };
}

export const MAX_PHOTO_EDGE = 1600;

/** Target size keeping the aspect ratio, never upscaling. */
export function scaledSize(width: number, height: number, maxEdge = MAX_PHOTO_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const k = maxEdge / longest;
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

export interface PreparedPhoto {
  blob: Blob;
  name: string;
  /** True when the photo was re-encoded (smaller, metadata removed). */
  processed: boolean;
}

/**
 * Re-encode in the browser when possible. Falls back to the original file
 * when the browser cannot decode it, or when the result would be larger.
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const original: PreparedPhoto = { blob: file, name: file.name, processed: false };
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return original;
  try {
    const bitmap = await createImageBitmap(file);
    const size = scaledSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return original;
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob) return original;
    // A neutral name: the original file name can contain a person's name.
    const name = 'photo.jpg';
    // Re-encoding always strips metadata, so the re-encoded copy is kept even
    // when it is not smaller than the original.
    return { blob, name, processed: true };
  } catch {
    return original;
  }
}

/** True when the photo would be refused by the server (HEIC the browser could not convert). */
export function needsConversion(file: { name: string; type: string }, prepared: PreparedPhoto): boolean {
  return photoType(file) === 'image/heic' && !prepared.processed;
}
