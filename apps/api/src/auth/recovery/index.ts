/**
 * Recovery codes and assisted account recovery. Owner: auth-recovery. API contract §32.2–32.3.
 * Recovery links and security alerts go through the outbox (MESSAGE_OUTBOX), never to an
 * administrator once e-mail delivery is configured.
 */
export * from './auth-recovery.module';
export * from './account-recovery.service';
export * from './recovery-codes.service';
export * from './security-alerts.service';
