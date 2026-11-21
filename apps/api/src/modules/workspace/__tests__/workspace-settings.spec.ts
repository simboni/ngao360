import { backupIsCurrent, effectiveSignInPolicy, isValidTimeZone, readWorkspaceSettings, retentionChangeNeedsNewNotice } from '../workspace-settings';

describe('workspace settings rules', () => {
  it('reads malformed settings as safe defaults and keeps valid sections', () => {
    const s = readWorkspaceSettings({ logoFileId: 'not-a-uuid', security: { mfaPolicy: 'NOBODY' }, environment: 'OFFICE', defaultCountyCode: '39' });
    expect(s.logoFileId).toBeNull();
    expect(s.security.mfaPolicy).toBe('PRIVILEGED_ROLES');
    expect(s.environment).toBe('OFFICE');
    expect(s.defaultCountyCode).toBeNull();
    expect(readWorkspaceSettings(null).dataProtection).toBeNull();
  });

  it('a tenant policy only tightens the server limits', () => {
    const server = 7 * 24 * 3600;
    expect(effectiveSignInPolicy({ mfaPolicy: 'PRIVILEGED_ROLES', sessionMaxHours: null, idleTimeoutMinutes: null }, server)).toEqual({
      mfaForEveryone: false,
      refreshTtlSeconds: server,
      idleTimeoutSeconds: null,
    });
    expect(effectiveSignInPolicy({ mfaPolicy: 'ALL_USERS', sessionMaxHours: 12, idleTimeoutMinutes: 30 }, server)).toEqual({
      mfaForEveryone: true,
      refreshTtlSeconds: 12 * 3600,
      idleTimeoutSeconds: 1800,
    });
    expect(effectiveSignInPolicy({ mfaPolicy: 'ALL_USERS', sessionMaxHours: 720, idleTimeoutMinutes: null }, 3600).refreshTtlSeconds).toBe(3600);
  });

  it('retention changes in either direction need a new notice once periods are stated', () => {
    const stated = { noticeVersion: 'v1', contactRetentionMonths: 12, caseRetentionMonths: 36 };
    expect(retentionChangeNeedsNewNotice(null, { contactRetentionMonths: 1, caseRetentionMonths: 1 })).toBe(false);
    expect(retentionChangeNeedsNewNotice(stated, { contactRetentionMonths: 12, caseRetentionMonths: 36 })).toBe(false);
    expect(retentionChangeNeedsNewNotice(stated, { contactRetentionMonths: 6, caseRetentionMonths: 36 })).toBe(true);
    expect(retentionChangeNeedsNewNotice(stated, { contactRetentionMonths: 24, caseRetentionMonths: 36 })).toBe(true);
  });

  it('a backup test counts only when successful and recent', () => {
    const now = new Date('2026-11-21T10:00:00Z');
    const base = { backupReference: 'r', note: 'n', recordedById: null, recordedAt: now.toISOString() };
    expect(backupIsCurrent(null, now)).toBe(false);
    expect(backupIsCurrent({ ...base, testedOn: '2026-11-01', outcome: 'RESTORED_OK' }, now)).toBe(true);
    expect(backupIsCurrent({ ...base, testedOn: '2026-11-01', outcome: 'RESTORED_WITH_ISSUES' }, now)).toBe(false);
    expect(backupIsCurrent({ ...base, testedOn: '2026-07-01', outcome: 'RESTORED_OK' }, now)).toBe(false);
  });

  it('checks IANA time zones', () => {
    expect(isValidTimeZone('Africa/Nairobi')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
