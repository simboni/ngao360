/**
 * One-off, user-initiated location reading (blueprint 6.3: optional,
 * justified and disclosed; never continuous tracking). Called only after the
 * person taps a button that says what the location is for.
 */
import type { GeoPoint } from '@ngao360/shared';

/** False when the browser has no geolocation or the page's Permissions-Policy blocks it. */
export function geolocationAvailable(): boolean {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return false;
  const doc = document as Document & {
    permissionsPolicy?: { allowsFeature: (f: string) => boolean };
    featurePolicy?: { allowsFeature: (f: string) => boolean };
  };
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  return policy ? policy.allowsFeature('geolocation') : true;
}

export function readLocationOnce(timeoutMs = 15_000): Promise<GeoPoint> {
  return new Promise((resolve, reject) => {
    if (!geolocationAvailable()) {
      reject(new Error('This phone cannot share a location'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: Math.round(pos.coords.latitude * 1e6) / 1e6,
          longitude: Math.round(pos.coords.longitude * 1e6) / 1e6,
          accuracyMetres: Number.isFinite(pos.coords.accuracy) ? Math.min(100_000, Math.round(pos.coords.accuracy)) : null,
          capturedAt: new Date(pos.timestamp || Date.now()).toISOString(),
        }),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? 'Location permission was refused. You can continue without a location.'
              : 'The location could not be read. You can continue without it.',
          ),
        ),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}
