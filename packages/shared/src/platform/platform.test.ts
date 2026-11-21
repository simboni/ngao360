import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_RECOVERY_TRANSITIONS,
  canTransitionAccountRecovery,
  canTransitionMessage,
  containsSecretKey,
  INTEGRATION_KINDS,
  INTEGRATION_PROVIDERS,
  IntegrationConfigSchemas,
  isScanClean,
  MALWARE_SCAN_STATUSES,
  MESSAGE_STATUS_TRANSITIONS,
  MESSAGE_TEMPLATE_KEYS,
  messageRetryDelayMs,
  RecoveryCodeSchema,
  UpdateIntegrationSettingSchema,
  WORKSPACE_SETUP_ITEM_KEYS,
  JOB_KEYS,
} from '../index';

describe('pilot hardening contracts', () => {
  it('only CLEAN counts as clean (fail closed)', () => {
    for (const s of MALWARE_SCAN_STATUSES) expect(isScanClean(s)).toBe(s === 'CLEAN');
  });

  it('outbox transitions match the trigger', () => {
    expect(canTransitionMessage('QUEUED', 'SENDING')).toBe(true);
    expect(canTransitionMessage('QUEUED', 'SENT')).toBe(false);
    expect(canTransitionMessage('FAILED', 'SENDING')).toBe(true);
    expect(canTransitionMessage('DEAD', 'QUEUED')).toBe(false);
    for (const final of ['SENT', 'SKIPPED', 'DEAD'] as const) expect(MESSAGE_STATUS_TRANSITIONS[final]).toEqual([]);
  });

  it('retry backoff grows and is capped at one hour', () => {
    expect(messageRetryDelayMs(1)).toBe(60_000);
    expect(messageRetryDelayMs(3)).toBe(240_000);
    expect(messageRetryDelayMs(30)).toBe(3_600_000);
  });

  it('account recovery cannot reopen', () => {
    expect(canTransitionAccountRecovery('PENDING', 'APPROVED')).toBe(true);
    expect(canTransitionAccountRecovery('APPROVED', 'COMPLETED')).toBe(true);
    expect(canTransitionAccountRecovery('PENDING', 'COMPLETED')).toBe(false);
    expect(ACCOUNT_RECOVERY_TRANSITIONS.REJECTED).toEqual([]);
  });

  it('keys follow the dotted format required by the DB checks', () => {
    const re = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
    for (const k of Object.values(MESSAGE_TEMPLATE_KEYS)) expect(k).toMatch(re);
    for (const k of Object.values(JOB_KEYS)) expect(k).toMatch(re);
    for (const k of WORKSPACE_SETUP_ITEM_KEYS) expect(k).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
  });

  it('integration settings refuse secrets at any depth', () => {
    expect(containsSecretKey({ senderId: 'NGAO360' })).toBe(false);
    expect(containsSecretKey({ siteKey: 'public-site-key' })).toBe(false);
    expect(containsSecretKey({ apiKey: 'x' })).toBe(true);
    expect(containsSecretKey({ nested: [{ smtp_password: 'x' }] })).toBe(true);
    expect(containsSecretKey({ secretKey: 'x' })).toBe(true);
    expect(UpdateIntegrationSettingSchema.safeParse({ provider: 'africastalking', enabled: true, config: { api_key: 'x' } }).success).toBe(false);
    expect(IntegrationConfigSchemas.sms.safeParse({ senderId: 'NGAO360' }).success).toBe(true);
    expect(IntegrationConfigSchemas.sms.safeParse({ senderId: 'NGAO360', username: 'x' }).success).toBe(false);
    for (const k of INTEGRATION_KINDS) expect(INTEGRATION_PROVIDERS[k].length).toBeGreaterThan(0);
  });

  it('recovery codes use an unambiguous alphabet', () => {
    expect(RecoveryCodeSchema.safeParse('k7qh-2mxd-9rtp-w3va').success).toBe(true);
    expect(RecoveryCodeSchema.safeParse('K7QH-2MXD-9RTP-W3V0').success).toBe(false);
  });
});
