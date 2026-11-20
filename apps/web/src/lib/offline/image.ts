/**
 * Photo preparation before a photo is queued (blueprint 11.3 low bandwidth;
 * 15 privacy). The image is decoded and drawn onto a canvas at most
 * `MAX_EDGE` pixels on its long edge and re-encoded as JPEG. Re-encoding
 * from pixels drops every metadata block of the original file: EXIF
 * (including GPS position, camera serial and time), XMP and IPTC. If the
 * phone cannot decode the photo (e.g. HEIC on some browsers), it is refused
 * rather than uploaded with its metadata.
 */
export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.8;
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;

export interface PreparedPhoto {
  bytes: ArrayBuffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  /** Original size, to show what was saved. */
  originalBytes: number;
}

export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoError';
  }
}

/** Target size keeping the aspect ratio, never upscaling. */
export function fitWithin(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    // 'from-image' applies the EXIF orientation before the metadata is dropped.
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function preparePhoto(file: File | Blob): Promise<PreparedPhoto> {
  if (!file.type.startsWith('image/')) throw new PhotoError('Choose a photo (image file)');
  if (file.size > MAX_INPUT_BYTES) throw new PhotoError('This photo is too large (over 25 MB)');
  let decoded: Awaited<ReturnType<typeof decode>>;
  try {
    decoded = await decode(file);
  } catch {
    throw new PhotoError('This phone cannot read this photo format. Take the photo again with the camera.');
  }
  try {
    const size = fitWithin(decoded.width, decoded.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new PhotoError('This phone cannot prepare the photo');
    ctx.drawImage(decoded.source, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) throw new PhotoError('This phone cannot prepare the photo');
    const bytes = await blob.arrayBuffer();
    // Belt and braces: a canvas never writes EXIF, but refuse rather than queue metadata.
    if (jpegHasExif(bytes)) throw new PhotoError('This phone could not remove the photo’s hidden location data');
    return { bytes, mimeType: 'image/jpeg', ...size, originalBytes: file.size };
  } finally {
    decoded.close();
  }
}

/** True when the bytes start like a JPEG and contain no EXIF (APP1 "Exif") segment. Used as a final check. */
export function jpegHasExif(bytes: ArrayBuffer): boolean {
  const b = new Uint8Array(bytes);
  if (b[0] !== 0xff || b[1] !== 0xd8) return false;
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) return true;
    i += 2 + len;
  }
  return false;
}
