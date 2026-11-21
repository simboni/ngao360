/**
 * Browser side of passkeys (API contract §32.1): thin wrappers over @simplewebauthn/browser plus
 * the pure helpers the account and sign-in screens share. The server generates and verifies every
 * ceremony; this file only passes options to the authenticator and its answer back.
 */
import type { PasskeyOptionsResponse } from '@ngao360/shared';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && browserSupportsWebAuthn();
}

/** Ask the authenticator to create a passkey for the given server options. */
export async function createPasskey(opts: PasskeyOptionsResponse): Promise<Record<string, unknown>> {
  const res = await startRegistration({ optionsJSON: opts.options as unknown as PublicKeyCredentialCreationOptionsJSON });
  return res as unknown as Record<string, unknown>;
}

/** Ask the authenticator to sign the server's challenge. */
export async function signWithPasskey(opts: PasskeyOptionsResponse): Promise<Record<string, unknown>> {
  const res = await startAuthentication({ optionsJSON: opts.options as unknown as PublicKeyCredentialRequestOptionsJSON });
  return res as unknown as Record<string, unknown>;
}

/**
 * Plain-language message for an authenticator error. Cancelling the browser prompt is the common
 * case and is not an error worth alarming anyone about.
 */
export function describeWebauthnError(err: unknown): string | null {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'The passkey prompt was closed before it finished. Try again when you are ready.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  if (name === 'SecurityError') return 'Passkeys are not available on this address. Use the official NGAO360 web address.';
  if (name === 'NotSupportedError') return 'This browser or device does not support passkeys.';
  return null;
}

/** A sensible default name for a new passkey from the browser's user agent. */
export function suggestDeviceLabel(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  const os = /iphone|ipad/.test(ua)
    ? 'iPhone or iPad'
    : /android/.test(ua)
      ? 'Android device'
      : /mac os x|macintosh/.test(ua)
        ? 'Mac'
        : /windows/.test(ua)
          ? 'Windows PC'
          : /cros/.test(ua)
            ? 'Chromebook'
            : /linux/.test(ua)
              ? 'Linux computer'
              : 'This device';
  return os;
}

/** Normalise what someone types for a recovery code into XXXX-XXXX-XXXX-XXXX (best effort). */
export function formatRecoveryCodeInput(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return clean.match(/.{1,4}/g)?.join('-') ?? '';
}

/** Text for the "download codes" file. No account identifiers beyond the organisation code. */
export function recoveryCodesFileText(codes: string[], tenantSlug: string, generatedAt: string): string {
  return [
    'NGAO360 recovery codes',
    `Organisation code: ${tenantSlug}`,
    `Generated: ${generatedAt}`,
    '',
    'Each code works once, in place of your authenticator code or passkey at sign-in.',
    'Keep them somewhere safe and private. Creating new codes cancels these.',
    '',
    ...codes.map((c, i) => `${String(i + 1).padStart(2, ' ')}. ${c}`),
    '',
  ].join('\n');
}

/**
 * Read the one-time recovery link fragment `#tenant=<slug>&token=<token>`. The token stays in the
 * fragment so it never reaches a server log or a Referer header.
 */
export function parseRecoveryFragment(hash: string): { tenantSlug: string; token: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const tenantSlug = params.get('tenant')?.trim().toLowerCase() ?? '';
  const token = params.get('token')?.trim() ?? '';
  if (!tenantSlug || token.length < 20) return null;
  return { tenantSlug, token };
}
