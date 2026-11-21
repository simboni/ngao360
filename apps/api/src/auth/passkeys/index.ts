/**
 * Passkeys (WebAuthn). Owner: auth-recovery. API contract §32.1.
 *
 * Planned files: passkeys.controller.ts (`/auth/passkeys/*`, `/auth/passkey/login/*`),
 * passkeys.service.ts (registration and authentication ceremonies, challenge store in
 * `webauthn_challenges`, counter checks), passkeys.mappers.ts. Tables: webauthn_credentials,
 * webauthn_challenges (migration 20261128000000_pilot_hardening_foundation). Config:
 * WEBAUTHN_RP_ID, WEBAUTHN_RP_NAME, WEBAUTHN_ORIGINS.
 */
export {};
