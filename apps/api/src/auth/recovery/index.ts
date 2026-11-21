/**
 * Recovery codes and assisted account recovery. Owner: auth-recovery. API contract §32.2–32.3.
 *
 * Planned files: recovery-codes.service.ts / .controller.ts (`/auth/recovery-codes*`,
 * `/auth/mfa/recovery`), account-recovery.service.ts / .controller.ts (`/admin/account-recovery*`,
 * `/auth/account-recovery/complete`). Tables: recovery_codes, account_recovery_requests (DB checks:
 * approver != requester != subject; transitions and expiry enforced by trigger). Recovery links
 * and invitations go through the outbox (MESSAGE_OUTBOX), never to the administrator in production
 * once a delivery channel is configured.
 */
export {};
