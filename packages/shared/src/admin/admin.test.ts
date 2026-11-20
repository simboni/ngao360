import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '../roles';
import { auditEventsToCsv, computeEffectiveAccess, csvField, findRoleSodConflicts } from './index';

describe('role separation of duties', () => {
  it('refuses capture + verify, verify + approve and access admin + tally write', () => {
    expect(findRoleSodConflicts(['tally.capture', 'tally.verify']).map((c) => c.ruleId)).toEqual(['capture-vs-verify']);
    expect(findRoleSodConflicts(['tally.submit', 'tally.verify']).map((c) => c.ruleId)).toEqual(['capture-vs-verify']);
    expect(findRoleSodConflicts(['tally.verify', 'tally.approve']).map((c) => c.ruleId)).toEqual(['verify-vs-approve']);
    expect(findRoleSodConflicts(['roles.assign', 'tally.capture']).map((c) => c.ruleId)).toEqual(['access-admin-vs-tally-write']);
    expect(findRoleSodConflicts(['tally.view', 'tally.results.view', 'roles.configure'])).toEqual([]);
  });

  it('accepts every system role', () => {
    for (const role of SYSTEM_ROLES) expect({ key: role.key, c: findRoleSodConflicts(role.permissions) }).toEqual({ key: role.key, c: [] });
  });

  it('the organisation owner cannot change result values', () => {
    const owner = SYSTEM_ROLES.find((r) => r.key === 'ORGANISATION_OWNER')!;
    const access = computeEffectiveAccess(owner.permissions, owner.mfaRequired);
    expect(access.notes).toContain('Cannot change, verify or approve result values.');
    expect(access.mfaRequired).toBe(true);
    expect(access.modules).toContain('tally');
  });
});

describe('effective access', () => {
  it('lists modules, drops unknown keys and flags high-risk permissions', () => {
    const a = computeEffectiveAccess(['dashboard.view', 'users.create', 'nope.key']);
    expect(a.permissions.map((p) => p.key)).toEqual(['dashboard.view', 'users.create']);
    expect(a.modules).toEqual(['dashboard', 'users']);
    expect(a.highRiskCount).toBe(1);
    expect(a.mfaRequired).toBe(true);
    expect(a.notes).toContain('NGAO TALLY is hidden.');
  });
});

describe('audit CSV', () => {
  it('quotes fields and neutralises spreadsheet formulas', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField(null)).toBe('');
    const csv = auditEventsToCsv(
      [
        { seq: '1', occurredAt: '2027-08-10T10:00:00.000Z', actorId: null, actorName: null, actorType: 'SYSTEM', action: 'user.created', entityType: 'User', entityId: 'x', reason: 'line\nbreak', sourceIp: null, userAgent: null, requestId: null, beforeHash: null, afterHash: 'h', eventHash: 'e' },
      ],
      { exportedAt: '2027-08-10T10:00:00.000Z', exportedBy: 'Synthetic Admin', filters: 'none' },
    );
    const lines = csv.split('\r\n');
    expect(lines[0]).toMatch(/^# NGAO360 audit export/);
    expect(lines[1]).toBe('seq,occurred_at,actor_id,actor_name,actor_type,action,entity_type,entity_id,reason,source_ip,user_agent,request_id,before_hash,after_hash,event_hash');
    expect(csv).toContain('"line\nbreak"');
  });
});
