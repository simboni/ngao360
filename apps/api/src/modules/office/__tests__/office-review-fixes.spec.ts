/**
 * Unit regressions for Office review findings that need no database:
 * request metadata in audit events, server-side image cleaning, appointment
 * time comparison and staff contact minimisation.
 */
import sharp from 'sharp';
import { AuditService } from '../../../audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import type { PrismaService } from '../../../prisma/prisma.service';
import { ImageSanitizeError, isSanitizableImage, sanitizeImage } from '../../../storage/image-sanitize';
import { assertEndAfterStart } from '../appointments/appointments.service';
import { minimalContact } from '../cases/cases.service';

const TENANT = '99999999-9999-4999-8999-999999999999';

describe('audit request metadata', () => {
  const svc = new AuditService({} as PrismaService);
  const build = (omit?: boolean) =>
    RequestContext.run({ requestId: 'req-1', ip: '10.0.0.9', userAgent: 'SyntheticPhone/1' }, () =>
      svc.buildEvent({ tenantId: TENANT, actorId: null, actorType: 'SYSTEM', action: 'office.case.public_submitted', entityType: 'CitizenCase', omitRequestMetadata: omit }),
    );
  it('keeps IP and user agent by default (staff actions)', () => {
    expect(build()).toMatchObject({ sourceIp: '10.0.0.9', userAgent: 'SyntheticPhone/1' });
  });
  it('drops them for anonymous portal events', () => {
    expect(build(true)).toMatchObject({ sourceIp: null, userAgent: null, requestId: 'req-1' });
  });
});

describe('sanitizeImage', () => {
  it('removes EXIF (location, device, owner) and applies the orientation', async () => {
    const marker = 'SYNTHETIC-GPS-MARKER';
    const src = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#336699' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExifMerge({ IFD0: { ImageDescription: marker, Make: 'SyntheticPhone' } })
      .toBuffer();
    expect(src.includes(Buffer.from(marker))).toBe(true);
    const out = await sanitizeImage(src, 'image/jpeg');
    expect(out.buffer.includes(Buffer.from(marker))).toBe(false);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.exif).toBeUndefined();
    // Orientation 6 (rotate 90°) is baked into the pixels.
    expect([meta.width, meta.height]).toEqual([10, 20]);
    expect(out).toMatchObject({ mimeType: 'image/jpeg', extension: 'jpg' });
  });
  it('refuses HEIC and undecodable data', async () => {
    expect(isSanitizableImage('image/heic')).toBe(false);
    await expect(sanitizeImage(Buffer.from('x'), 'image/heic')).rejects.toBeInstanceOf(ImageSanitizeError);
    await expect(sanitizeImage(Buffer.from('not an image'), 'image/png')).rejects.toBeInstanceOf(ImageSanitizeError);
  });
});

describe('assertEndAfterStart', () => {
  it('compares instants, not strings with different offsets', () => {
    // 10:00+03:00 is 07:00Z, before 09:00Z.
    expect(() => assertEndAfterStart('2026-11-20T09:00:00Z', '2026-11-20T10:00:00+03:00', 'confirmedEnd')).toThrow(/end must be after the start/);
    // 09:00Z is after 10:00+03:00 (07:00Z): valid although the string sorts lower.
    expect(() => assertEndAfterStart('2026-11-20T10:00:00+03:00', '2026-11-20T09:00:00Z', 'confirmedEnd')).not.toThrow();
    expect(() => assertEndAfterStart('2026-11-20T09:00:00Z', '2026-11-20T09:00:00Z', 'preferredEnd')).toThrow();
    expect(() => assertEndAfterStart(undefined, '2026-11-20T09:00:00Z', 'preferredEnd')).not.toThrow();
  });
});

describe('minimalContact (staff-recorded cases)', () => {
  it('keeps only the chosen channel, and only with consent', () => {
    expect(() => minimalContact({ preference: 'NONE', phone: '0712000111' }, false)).toThrow();
    expect(() => minimalContact({ preference: 'PHONE', phone: '0712000111' }, false)).toThrow();
    expect(() => minimalContact({ preference: 'PHONE', phone: '0712000111', email: 'a@example.org' }, true)).toThrow();
    expect(minimalContact({ preference: 'NONE', name: 'Synthetic' }, false)).toMatchObject({ name: 'Synthetic', phone: undefined, email: undefined });
    expect(minimalContact({ preference: 'EMAIL', email: 'a@example.org' }, true)).toMatchObject({ email: 'a@example.org', phone: undefined });
  });
});
