import { describe, expect, it } from 'vitest';
import { findRoleSodConflicts } from '../admin';
import { PERMISSION_DEFINITIONS } from '../permissions';
import { FIELD_ROLE_KEYS, getSystemRole, SYSTEM_ROLES } from '../roles';
import { PERMISSION_MODULE_TENANT_MODULES, TENANT_MODULES } from '../modules';
import {
  CreateAgentSchema,
  RevealAgentSensitiveSchema,
} from './agents';
import { FieldModuleConfigSchema, maskNationalId, maskPhone, normaliseKenyanMsisdn } from './common';
import {
  canTransitionDeployment,
  canTransitionIncident,
  DEFAULT_INCIDENT_SEVERITY,
  deriveReadinessStatus,
  INCIDENT_CATEGORIES,
  INCIDENT_CATEGORY_LABELS,
  shiftsOverlap,
} from './enums';
import { CreateIncidentSchema } from './incidents';
import { findNonFactualQuestions, FieldReportTemplateSchemaSchema, validateFieldAnswers } from './reports';
import { canonicalPayload, SyncRequestSchema } from './sync';
import { completeness, deriveStationStatus, WAR_ROOM_LABEL } from './warroom';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('field module and permissions', () => {
  it('field is a tenant module, off by default; the War Room needs field and tally', () => {
    expect(TENANT_MODULES.find((m) => m.key === 'field')?.defaultEnabled).toBe(false);
    expect(PERMISSION_MODULE_TENANT_MODULES.warroom).toEqual(['field', 'tally']);
  });

  it('revealing agent personal data is high-risk (MFA) and its own permission', () => {
    const def = PERMISSION_DEFINITIONS.find((p) => p.key === 'field.agents.reveal_sensitive');
    expect(def?.highRisk).toBe(true);
    expect(getSystemRole('DEPLOYMENT_PLANNER').permissions).not.toContain('field.agents.reveal_sensitive');
    expect(getSystemRole('WAR_ROOM_OBSERVER').permissions).not.toContain('field.agents.reveal_sensitive');
  });

  it('field roles never hold office permissions or result-changing tally permissions', () => {
    for (const key of FIELD_ROLE_KEYS) {
      for (const p of getSystemRole(key).permissions) {
        expect(p.startsWith('office.')).toBe(false);
        expect(['tally.capture', 'tally.verify', 'tally.approve', 'tally.exclude', 'tally.release', 'tally.discrepancy.resolve']).not.toContain(p);
      }
    }
  });

  it('no system role breaks a role-level separation-of-duties rule', () => {
    for (const role of SYSTEM_ROLES) expect(findRoleSodConflicts(role.permissions)).toEqual([]);
  });

  it('resolving and closing incidents, and field agents administering agents, are separated', () => {
    expect(findRoleSodConflicts(['field.incidents.resolve', 'field.incidents.close']).map((c) => c.ruleId)).toContain('incident-resolve-vs-close');
    expect(findRoleSodConflicts(['field.deployment.checkin', 'field.agents.view']).map((c) => c.ruleId)).toContain('field-agent-vs-agent-admin');
  });

  it('the mobile agent role can check in, report and upload forms, and nothing else of field', () => {
    const p = getSystemRole('POLLING_AGENT').permissions;
    expect(p).toEqual(expect.arrayContaining(['field.deployment.checkin', 'field.reports.submit', 'field.incidents.report', 'tally.submit']));
    expect(p.filter((k) => k.startsWith('field.') || k.startsWith('warroom.')).sort()).toEqual(
      ['field.deployment.checkin', 'field.incidents.report', 'field.reports.submit'].sort(),
    );
  });
});

describe('agent personal data', () => {
  it('normalises Kenyan mobile numbers and masks them', () => {
    expect(normaliseKenyanMsisdn('0712 345 678')).toBe('+254712345678');
    expect(normaliseKenyanMsisdn('+254 112-345-678')).toBe('+254112345678');
    expect(normaliseKenyanMsisdn('12345')).toBeNull();
    expect(maskPhone('+254712345678')).toBe('+254 ••• ••• 678');
    expect(maskNationalId('12345678')).toBe('••••• 678');
  });

  it('agent registration needs the privacy notice and only takes sensitive values in their own block', () => {
    const base = { givenName: 'Synthetic', familyName: 'Agent', homeWardId: uuid(1) };
    expect(CreateAgentSchema.safeParse(base).success).toBe(false);
    const ok = CreateAgentSchema.parse({ ...base, privacyNoticeAcknowledged: true, sensitive: { phone: '0700000001' } });
    expect(ok.sensitive.phone).toBe('+254700000001');
    expect(RevealAgentSensitiveSchema.safeParse({ fields: [], reason: 'Payment run' }).success).toBe(false);
  });
});

describe('workflows', () => {
  it('deployments: replaced and cancelled rows are final', () => {
    expect(canTransitionDeployment('ASSIGNED', 'CONFIRMED')).toBe(true);
    expect(canTransitionDeployment('CONFIRMED', 'CHECKED_IN')).toBe(true);
    expect(canTransitionDeployment('ASSIGNED', 'CHECKED_IN')).toBe(false);
    expect(canTransitionDeployment('REPLACED', 'ASSIGNED')).toBe(false);
    expect(shiftsOverlap('FULL_DAY', 'OPENING')).toBe(true);
    expect(shiftsOverlap('OPENING', 'CLOSING_AND_COUNTING')).toBe(false);
  });

  it('incidents follow reported → triaged → assigned → escalated → resolved → closed', () => {
    expect(canTransitionIncident('REPORTED', 'TRIAGED')).toBe(true);
    expect(canTransitionIncident('REPORTED', 'CLOSED')).toBe(false);
    expect(canTransitionIncident('RESOLVED', 'CLOSED')).toBe(true);
    expect(canTransitionIncident('CLOSED', 'TRIAGED')).toBe(true);
  });

  it('every incident category has a neutral label and a default severity', () => {
    for (const c of INCIDENT_CATEGORIES) {
      expect(INCIDENT_CATEGORY_LABELS[c]).toBeTruthy();
      expect(DEFAULT_INCIDENT_SEVERITY[c]).toBeTruthy();
      expect(INCIDENT_CATEGORY_LABELS[c]).not.toMatch(/fraud|rig|crimin|cheat/i);
    }
    const cfg = FieldModuleConfigSchema.parse({ incidentSeverityDefaults: { LOGISTICS: 'HIGH' } });
    expect(cfg.incidentSeverityDefaults.LOGISTICS).toBe('HIGH');
    expect(cfg.incidentSeverityDefaults.SECURITY).toBe('HIGH');
    expect(cfg.checkInLocationEnabled).toBe(false);
  });

  it('incident intake needs the privacy warning and a factual description', () => {
    const base = {
      clientIdempotencyKey: uuid(2),
      deviceId: 'device-abcdef12',
      clientCreatedAt: '2027-08-10T05:00:00.000Z',
      electionCycleId: uuid(3),
      category: 'MATERIALS',
      occurredAt: '2027-08-10T05:00:00.000Z',
      location: { pollingStationCode: '039001000100101' },
      description: 'Ballot papers for one stream arrived 40 minutes after opening time.',
    };
    expect(CreateIncidentSchema.safeParse(base).success).toBe(false);
    expect(CreateIncidentSchema.safeParse({ ...base, privacyWarningAcknowledged: true }).success).toBe(true);
    expect(CreateIncidentSchema.safeParse({ ...base, privacyWarningAcknowledged: true, location: {} }).success).toBe(false);
  });

  it('readiness status is derived from items', () => {
    expect(deriveReadinessStatus([])).toBe('NOT_STARTED');
    expect(deriveReadinessStatus([{ status: 'DONE' }, { status: 'NOT_APPLICABLE' }])).toBe('READY');
    expect(deriveReadinessStatus([{ status: 'DONE' }, { status: 'BLOCKED' }])).toBe('BLOCKED');
    expect(deriveReadinessStatus([{ status: 'DONE' }, { status: 'NOT_STARTED' }])).toBe('IN_PROGRESS');
  });
});

describe('field report templates', () => {
  const schema = FieldReportTemplateSchemaSchema.parse({
    sections: [
      {
        key: 'opening',
        title: 'Opening',
        questions: [
          { key: 'opened_on_time', label: 'Did the station open on time?', type: 'YES_NO', required: true },
          { key: 'opening_time', label: 'Opening time', type: 'TIME', required: true },
          { key: 'queue', label: 'Approximate queue length', type: 'NUMBER', min: 0, max: 5000 },
          { key: 'materials', label: 'Materials present', type: 'MULTI_CHOICE', options: [{ value: 'ballots', label: 'Ballots' }, { value: 'register', label: 'Register' }] },
        ],
      },
    ],
  });

  it('validates answers against the template version without changing them', () => {
    const answers = { opened_on_time: true, opening_time: '06:05', queue: 120, materials: ['ballots'] };
    expect(validateFieldAnswers(schema, answers)).toEqual([]);
    expect(validateFieldAnswers(schema, { opened_on_time: 'yes', queue: -1, extra: 1 }).map((i) => i.questionKey).sort()).toEqual(
      ['extra', 'opened_on_time', 'opening_time', 'queue'].sort(),
    );
    expect(answers.queue).toBe(120);
  });

  it('flags questions that would collect voter preferences or identity data', () => {
    const bad = FieldReportTemplateSchemaSchema.parse({
      sections: [{ key: 'section_one', title: 'Section', questions: [{ key: 'q_vote', label: 'Who did most voters say they voted for?', type: 'SHORT_TEXT' }] }],
    });
    expect(findNonFactualQuestions(bad)).toEqual(['q_vote']);
    expect(findNonFactualQuestions(schema)).toEqual([]);
  });
});

describe('war room and sync', () => {
  it('completeness never zero-fills missing stations', () => {
    expect(completeness(10, 7)).toEqual({ expected: 10, reported: 7, missing: 3, ratio: 0.7 });
    expect(completeness(0, 0).ratio).toBeNull();
    expect(WAR_ROOM_LABEL).toMatch(/Unofficial, internal/);
  });

  it('derives the blueprint 7.2 station status', () => {
    const base = { manual: null, deploymentStatus: null, hasFieldUpdate: false, formStatus: null, openSevereIncident: false, pollsClosed: false } as const;
    expect(deriveStationStatus(base)).toBe('NOT_ASSIGNED');
    expect(deriveStationStatus({ ...base, deploymentStatus: 'CHECKED_IN' })).toBe('CHECKED_IN');
    expect(deriveStationStatus({ ...base, deploymentStatus: 'CHECKED_IN', pollsClosed: true })).toBe('FORM_EXPECTED');
    expect(deriveStationStatus({ ...base, formStatus: 'VERIFIED' })).toBe('VERIFIED_FOR_PARALLEL_TALLY');
    expect(deriveStationStatus({ ...base, formStatus: 'VERIFIED', openSevereIncident: true })).toBe('FLAGGED');
    expect(deriveStationStatus({ ...base, manual: 'CLOSED', openSevereIncident: true })).toBe('CLOSED');
  });

  it('after close of polls a checked-out station with no form is FORM_EXPECTED (review finding)', () => {
    const base = { manual: null, deploymentStatus: null, hasFieldUpdate: false, formStatus: 'NONE' as const, openSevereIncident: false, pollsClosed: true };
    expect(deriveStationStatus({ ...base, deploymentStatus: 'CHECKED_OUT' })).toBe('FORM_EXPECTED');
    expect(deriveStationStatus({ ...base, deploymentStatus: 'CONFIRMED' })).toBe('FORM_EXPECTED');
    expect(deriveStationStatus({ ...base, deploymentStatus: 'ASSIGNED' })).toBe('FORM_EXPECTED');
    expect(deriveStationStatus({ ...base, hasFieldUpdate: true })).toBe('FORM_EXPECTED');
    // No agent: the coverage gap stays visible as NOT_ASSIGNED.
    expect(deriveStationStatus(base)).toBe('NOT_ASSIGNED');
    // A form received ends the expectation.
    expect(deriveStationStatus({ ...base, deploymentStatus: 'CHECKED_OUT', formStatus: 'RECEIVED' })).toBe('FORM_RECEIVED');
    // Before close a checked-out station shows as checked in.
    expect(deriveStationStatus({ ...base, deploymentStatus: 'CHECKED_OUT', pollsClosed: false })).toBe('CHECKED_IN');
  });

  it('canonical payloads ignore key order (idempotent retries hash the same)', () => {
    expect(canonicalPayload({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonicalPayload({ a: { c: null, d: [1, 2] }, b: 1 }));
    expect(canonicalPayload({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('sync batches are typed by kind and bounded', () => {
    const item = {
      kind: 'CHECK_IN',
      idempotencyKey: uuid(9),
      deviceId: 'device-abcdef12',
      clientCreatedAt: '2027-08-10T03:00:00.000Z',
      payload: {
        deploymentId: uuid(10),
        expectedVersion: 2,
        clientIdempotencyKey: uuid(9),
        deviceId: 'device-abcdef12',
        clientCreatedAt: '2027-08-10T03:00:00.000Z',
        submittedOffline: true,
        checkedInAt: '2027-08-10T03:00:00.000Z',
      },
    };
    expect(SyncRequestSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(SyncRequestSchema.safeParse({ items: [] }).success).toBe(false);
    expect(SyncRequestSchema.safeParse({ items: [{ ...item, kind: 'DELETE_EVERYTHING' }] }).success).toBe(false);
  });
});
