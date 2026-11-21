/**
 * Pure rules behind the contact-verification and SMS-consent panels on /settings/account (CR AR9,
 * API contract §31.2). The API checks codes, the notice version and rate limits; these only decide
 * what to show. Addresses arrive masked and are never logged or stored by the browser.
 */
import { type ContactChannel, type ContactStatus, SMS_CONSENT_NOTICE } from '@ngao360/shared';

export const CONTACT_CHANNEL_LABELS: Record<ContactChannel, string> = { EMAIL: 'E-mail', SMS: 'Mobile phone (SMS)' };

export type ContactState = 'MISSING' | 'UNVERIFIED' | 'VERIFIED';

export function contactState(c: Pick<ContactStatus, 'addressMasked' | 'verifiedAt'> | null | undefined): ContactState {
  if (!c || !c.addressMasked) return 'MISSING';
  return c.verifiedAt ? 'VERIFIED' : 'UNVERIFIED';
}

export type SmsConsentState = 'NO_PHONE' | 'NOT_GIVEN' | 'GIVEN' | 'OUTDATED' | 'OPTED_OUT';

/** Consent is current only for the notice version shown now; an older version needs a new yes. */
export function smsConsentState(
  c: Pick<ContactStatus, 'addressMasked' | 'smsConsentVersion' | 'smsConsentAt' | 'smsOptedOutAt'> | null | undefined,
  currentVersion: string = SMS_CONSENT_NOTICE.version,
): SmsConsentState {
  if (!c || !c.addressMasked) return 'NO_PHONE';
  if (c.smsOptedOutAt) return 'OPTED_OUT';
  if (!c.smsConsentAt || !c.smsConsentVersion) return 'NOT_GIVEN';
  return c.smsConsentVersion === currentVersion ? 'GIVEN' : 'OUTDATED';
}

export const SMS_CONSENT_STATE_TEXT: Record<SmsConsentState, string> = {
  NO_PHONE: 'No mobile number on your account. Ask an administrator to add one before you can choose SMS.',
  NOT_GIVEN: 'You have not agreed to SMS messages. Nothing is sent to your phone by SMS.',
  GIVEN: 'You agreed to short service messages by SMS.',
  OUTDATED: 'The SMS notice changed since you agreed. Read it again and agree to keep receiving SMS.',
  OPTED_OUT: 'You turned SMS off. Nothing is sent to your phone by SMS.',
};

/** Keep only digits, at most six (what the code input accepts). */
export function sanitizeCode(input: string): string {
  return input.replace(/\D/g, '').slice(0, 6);
}

export function isCompleteCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** Why "send a code" is not offered for this contact, or null when it is. */
export function sendCodeBlocker(c: ContactStatus | null | undefined): string | null {
  const state = contactState(c);
  if (state === 'MISSING') return c?.channel === 'SMS' ? 'No mobile number on your account yet. Ask an administrator to add it.' : 'Your account has no e-mail address.';
  return null;
}

/** Plain explanation of what "deliverable" means for this channel right now. */
export function deliverabilityText(c: ContactStatus): string {
  if (c.deliverable) return c.channel === 'SMS' ? 'Security alerts and messages you chose can be sent by SMS.' : 'Security alerts and messages you chose can be sent by e-mail.';
  const state = contactState(c);
  if (state === 'MISSING') return 'Nothing can be sent on this channel.';
  if (state === 'UNVERIFIED') return 'Verify it before anything can be sent on this channel.';
  if (c.channel === 'SMS') return 'Verified, but SMS is off until you agree to the SMS notice below.';
  return 'Not deliverable yet.';
}
