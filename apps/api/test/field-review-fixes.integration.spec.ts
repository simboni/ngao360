/**
 * Regression suite for the field / War Room review findings (docs/STATUS.md,
 * "Field review findings"). Every security, privacy and integrity fix is pinned
 * here through the HTTP stack and the database, under RLS. All data synthetic
 * (Bungoma-like synthetic geography from field-fixtures).
 */
import { randomUUID } from 'node:crypto';
import type { PermissionKey } from '@ngao360/shared';
import { ClientSubmissionLedger } from '../src/modules/field/common/client-submission.ledger';
import { StationStatusRecorderService } from '../src/modules/field/warroom/station-status-recorder.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createFieldFixture,
  describeDb,
  type FieldFixture,
  offline,
  syntheticPng,
  type UnitKey,
} from './field-fixtures';

describeDb('Field review fixes', () => {
  let f: FieldFixture;
  let pastCycleId: string;

  /** Extra role assignment for a persona (optionally limited to a unit and/or an election cycle). */
  const grant = async (
    who: string,
    perms: PermissionKey[],
    opts: { unit?: UnitKey; cycleId?: string } = {},
  ) => {
    const role = await f.owner.role.create({
      data: {
        tenantId: f.tenantId,
        key: `R_EXTRA_${randomUUID().slice(0, 8)}`,
        name: 'Synthetic extra grant',
        permissions: { create: perms.map((k) => ({ tenantId: f.tenantId, permissionKey: k })) },
      },
    });
    const scope = opts.unit
      ? {
          scopeType: (opts.unit === 'county'
            ? 'COUNTY'
            : opts.unit.startsWith('k')
              ? 'CONSTITUENCY'
              : 'WARD') as 'COUNTY' | 'CONSTITUENCY' | 'WARD',
          geographicUnitId: f.units[opts.unit],
        }
      : { scopeType: 'ORGANISATION' as const };
    await f.owner.roleAssignment.create({
      data: {
        tenantId: f.tenantId,
        userId: f.users[who]!,
        roleId: role.id,
        reason: 'fixture',
        electionCycleId: opts.cycleId ?? null,
        ...scope,
      },
    });
  };

  const mkAgent = async (name: string, ward: UnitKey = 'w1', user?: string) => {
    const http = f.http('admin');
    const a = await http
      .post('/field/agents')
      .send({
        givenName: name,
        familyName: 'Synthetic',
        homeWardId: f.units[ward],
        privacyNoticeAcknowledged: true,
        sensitive: {
          phone: '+254700000111',
          mpesaNumber: '+254700000111',
          nationalIdNumber: '10000001',
        },
      })
      .expect(201);
    await http
      .post(`/field/agents/${a.body.id}/status`)
      .send({ expectedVersion: a.body.version, to: 'ACTIVE', reason: 'Ready' })
      .expect(200);
    if (user)
      await http
        .post(`/field/agents/${a.body.id}/user`)
        .send({ userId: f.users[user], reason: 'Mobile' })
        .expect(200);
    return a.body.id as string;
  };

  beforeAll(async () => {
    process.env.FIELD_WARROOM_RECORD_SECONDS = '0';
    f = await createFieldFixture({
      admin: {
        perms: [
          'field.agents.view',
          'field.agents.create',
          'field.agents.edit',
          'field.agents.reveal_sensitive',
          'field.deployment.view',
          'field.deployment.plan',
          'field.incidents.report',
          'field.readiness.view',
          'field.readiness.update',
        ],
      },
      planner2: { perms: ['field.agents.view', 'field.deployment.view', 'field.deployment.plan'] },
      coord: {
        perms: [
          'field.agents.view',
          'field.agents.edit',
          'field.agents.reveal_sensitive',
          'field.deployment.checkin',
        ],
      },
      wardCoord: { perms: ['field.agents.view', 'field.agents.reveal_sensitive'], scope: 'w1' },
      pastCoord: { perms: [] },
      agentA: {
        perms: ['field.deployment.checkin', 'field.incidents.report'],
        scope: 'station:F-001',
      },
      agentB: {
        perms: ['field.deployment.checkin', 'field.incidents.report'],
        scope: 'station:F-002',
      },
      desk: { perms: ['field.incidents.view', 'field.incidents.triage'] },
      legal: { perms: ['field.incidents.view', 'field.incidents.view_subject'] },
      viewer: { perms: ['field.incidents.view'] },
      observer: { perms: ['warroom.view'] },
      commander: { perms: ['warroom.view', 'tally.view'] },
      tallyW2: { perms: ['warroom.view'] },
      coordR1: { perms: ['field.readiness.view', 'field.readiness.update'] },
      coordR2: { perms: ['field.readiness.view', 'field.readiness.update'] },
    });
    const past = await f.owner.electionCycle.create({
      data: {
        tenantId: f.tenantId,
        name: 'Synthetic 2025 by-election',
        electionDate: new Date('2025-03-10'),
        legalConfigVersion: 'test',
        dataProvenance: 'SYNTHETIC',
        status: 'ACTIVE',
      },
    });
    pastCycleId = past.id;
    // A field coordinator grant limited to a past by-election cycle.
    await grant('pastCoord', ['field.agents.view', 'field.agents.reveal_sensitive'], {
      cycleId: pastCycleId,
    });
    // War Room org-wide, tally intake only for ward w2.
    await grant('tallyW2', ['tally.view'], { unit: 'w2' });
  }, 120_000);

  afterAll(async () => {
    delete process.env.FIELD_WARROOM_RECORD_SECONDS;
    await f?.close();
  });

  describe('agent personal data', () => {
    it('refuses to link or unlink your own agent record, and unlinking does not reopen it', async () => {
      const own = await mkAgent('Coordinator-agent', 'w1', 'coord');
      // The coordinator cannot unlink their own record (or link themself to another).
      const unlink = await f
        .http('coord')
        .post(`/field/agents/${own}/user`)
        .send({ userId: null, reason: 'Unlink' })
        .expect(403);
      expect(unlink.body.code).toBe('SEPARATION_OF_DUTIES');
      const other = await mkAgent('Other');
      await f
        .http('coord')
        .post(`/field/agents/${other}/user`)
        .send({ userId: f.users.coord, reason: 'Link self' })
        .expect(403);
      await f
        .http('coord')
        .post(`/field/agents/${own}/reveal`)
        .send({ fields: ['mpesaNumber'], reason: 'Payment run' })
        .expect(403);
      // An administrator unlinks it: the coordinator still cannot reveal or change it.
      await f
        .http('admin')
        .post(`/field/agents/${own}/user`)
        .send({ userId: null, reason: 'Account change' })
        .expect(200);
      const reveal = await f
        .http('coord')
        .post(`/field/agents/${own}/reveal`)
        .send({ fields: ['mpesaNumber'], reason: 'Payment run' });
      expect(reveal.status).toBe(403);
      expect(reveal.body.code).toBe('SEPARATION_OF_DUTIES');
      await f
        .http('coord')
        .put(`/field/agents/${own}/sensitive`)
        .send({ mpesaNumber: '+254711111111', reason: 'New number' })
        .expect(403);
      const detail = await f.http('coord').get(`/field/agents/${own}`).expect(200);
      expect(detail.body.allowedActions).not.toContain('reveal_sensitive');
      expect(detail.body.allowedActions).not.toContain('link_user');
      // Someone else still can.
      await f
        .http('admin')
        .post(`/field/agents/${own}/reveal`)
        .send({ fields: ['mpesaNumber'], reason: 'Payment run' })
        .expect(200);
    });

    it('a grant limited to a past cycle does not reach personal data', async () => {
      const a = await mkAgent('Past-cycle target');
      await f
        .http('pastCoord')
        .post(`/field/agents/${a}/reveal`)
        .send({ fields: ['phone'], reason: 'Payment run' })
        .expect(403);
      await f
        .http('pastCoord')
        .put(`/field/agents/${a}/sensitive`)
        .send({ phone: '+254722222222', reason: 'Fix' })
        .expect(403);
    });

    it('a ward coordinator cannot reveal an out-of-area agent deployed into the ward', async () => {
      const a = await mkAgent('Out-of-area', 'w2');
      await f
        .http('admin')
        .post('/field/deployments')
        .send({
          electionCycleId: f.cycleId,
          agentId: a,
          pollingStationCode: 'F-002',
          role: 'STATION_AGENT',
        })
        .expect(201);
      // Viewing the deployed agent is allowed (deployment area), personal data is not (home area only).
      await f.http('wardCoord').get(`/field/agents/${a}`).expect(200);
      await f
        .http('wardCoord')
        .post(`/field/agents/${a}/reveal`)
        .send({ fields: ['phone'], reason: 'Payment run' })
        .expect(403);
      const inArea = await mkAgent('In-area', 'w1');
      await f
        .http('wardCoord')
        .post(`/field/agents/${inArea}/reveal`)
        .send({ fields: ['phone'], reason: 'Payment run' })
        .expect(200);
    });
  });

  describe('station-scoped grants', () => {
    it('follow a code edit of their draft registry station', async () => {
      const o = f.owner;
      const draft = await o.registryVersion.create({
        data: {
          tenantId: f.tenantId,
          electionCycleId: f.cycleId,
          version: `draft-${randomUUID().slice(0, 6)}`,
          source: 'synthetic',
          status: 'DRAFT',
          stationCount: 1,
        },
      });
      const st = await o.pollingStation.create({
        data: {
          tenantId: f.tenantId,
          electionCycleId: f.cycleId,
          registryVersionId: draft.id,
          geographicUnitId: f.units.w1,
          countyId: f.units.county,
          constituencyId: f.units.k1,
          wardId: f.units.w1,
          code: 'D-001',
          name: 'Synthetic draft station',
        },
      });
      const role = await o.role.findFirstOrThrow({
        where: { tenantId: f.tenantId, assignments: { some: { userId: f.users.agentA } } },
      });
      const ra = await o.roleAssignment.create({
        data: {
          tenantId: f.tenantId,
          userId: f.users.agentB!,
          roleId: role.id,
          scopeType: 'POLLING_STATION',
          pollingStationId: st.id,
          reason: 'fixture',
        },
      });
      expect(
        (await o.roleAssignment.findUniqueOrThrow({ where: { id: ra.id } })).pollingStationCode,
      ).toBe('D-001');
      await o.pollingStation.update({ where: { id: st.id }, data: { code: 'D-099' } });
      expect(
        (await o.roleAssignment.findUniqueOrThrow({ where: { id: ra.id } })).pollingStationCode,
      ).toBe('D-099');
    });
  });

  describe('incident sensitivity', () => {
    it('withholds the content of classified incidents from viewers without the matching permission', async () => {
      const inc = (
        await f
          .http('agentA')
          .post('/field/incidents')
          .send({
            ...offline(),
            electionCycleId: f.cycleId,
            category: 'OTHER',
            occurredAt: new Date().toISOString(),
            location: { pollingStationCode: 'F-001' },
            description: 'Synthetic: a factual account that must stay restricted.',
            privacyWarningAcknowledged: true,
          })
          .expect(201)
      ).body;
      const t1 = await f
        .http('desk')
        .post(`/field/incidents/${inc.id}/triage`)
        .send({
          expectedVersion: inc.version,
          severity: 'MEDIUM',
          sensitivity: 'CONFIDENTIAL',
          note: 'Classified',
        })
        .expect(200);
      // CONFIDENTIAL: the desk (triage) and legal (view_subject) read it; a plain viewer does not.
      expect(
        (await f.http('desk').get(`/field/incidents/${inc.id}`).expect(200)).body.description,
      ).toMatch(/factual account/);
      const v = (await f.http('viewer').get(`/field/incidents/${inc.id}`).expect(200)).body;
      expect(v.description).not.toMatch(/factual account/);
      expect(v.contentRestricted).toBe(true);
      expect(
        v.events.every(
          (e: { note: string | null }) => e.note === null || !/Classified/.test(e.note),
        ),
      ).toBe(true);
      const list = (
        await f.http('viewer').get('/field/incidents?pageSize=100').expect(200)
      ).body.items.find((i: { id: string }) => i.id === inc.id);
      expect(list.descriptionPreview).not.toMatch(/factual account/);
      await f.http('viewer').get(`/field/incidents/${inc.id}/history`).expect(403);
      // HIGHLY_RESTRICTED: only view_subject holders.
      await f
        .http('desk')
        .post(`/field/incidents/${inc.id}/triage`)
        .send({
          expectedVersion: t1.body.version,
          severity: 'MEDIUM',
          sensitivity: 'HIGHLY_RESTRICTED',
          note: 'Restricted',
        })
        .expect(200);
      expect(
        (await f.http('desk').get(`/field/incidents/${inc.id}`).expect(200)).body.description,
      ).not.toMatch(/factual account/);
      await f.http('desk').get(`/field/incidents/${inc.id}/history`).expect(403);
      expect(
        (await f.http('legal').get(`/field/incidents/${inc.id}`).expect(200)).body.description,
      ).toMatch(/factual account/);
      await f.http('legal').get(`/field/incidents/${inc.id}/history`).expect(200);
    });
  });

  describe('War Room', () => {
    beforeAll(async () => {
      // F-005: a canonical, verified station form. F-003: an agent checked in then out.
      const o = f.owner;
      const contest = await o.contest.create({
        data: {
          tenantId: f.tenantId,
          electionCycleId: f.cycleId,
          officeType: 'GOVERNOR',
          name: 'Governor (synthetic)',
          geographicUnitId: f.units.county,
          formSeries: '37',
          status: 'ACTIVE',
        },
      });
      const form = await o.formTemplate.create({
        data: {
          tenantId: f.tenantId,
          electionCycleId: f.cycleId,
          contestType: 'GOVERNOR',
          formNumber: '37A',
          formLevel: 'POLLING_STATION',
          version: 1,
          title: 'Form 37A (synthetic)',
          effectiveDate: new Date('2027-01-01'),
          fieldSchema: {},
          validationRules: {},
          officialSource: 'synthetic',
          approvalState: 'APPROVED',
        },
      });
      const file = await o.storedFile.create({
        data: {
          tenantId: f.tenantId,
          sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          mimeType: 'image/png',
          sizeBytes: 10n,
          originalFilename: 'form.png',
          purpose: 'RESULT_FORM',
          storageDriver: 'LOCAL',
          storageKey: `synthetic/${randomUUID()}`,
          uploadedById: f.users.admin!,
        },
      });
      await o.resultSubmission.create({
        data: {
          tenantId: f.tenantId,
          reference: 'SUB-2027-009001',
          electionCycleId: f.cycleId,
          contestId: contest.id,
          formTemplateId: form.id,
          formNumber: '37A',
          pollingStationId: f.stationIds['F-005'],
          registryVersionId: f.registryId,
          submitterId: f.users.admin!,
          sourceFileId: file.id,
          sourceType: 'CLERK_UPLOAD',
          status: 'VERIFIED',
          isCanonical: true,
          idempotencyKey: randomUUID(),
        },
      });
      const agent = await mkAgent('Checked-out', 'w2');
      const dep = await f
        .http('admin')
        .post('/field/deployments')
        .send({
          electionCycleId: f.cycleId,
          agentId: agent,
          pollingStationCode: 'F-003',
          role: 'STATION_AGENT',
        })
        .expect(201);
      const now = new Date();
      await o.deployment.update({
        where: { id: dep.body.id },
        data: { status: 'CHECKED_OUT', confirmedAt: now, checkedInAt: now, checkedOutAt: now },
      });
    });

    it('does not show tally-derived statuses to a War Room observer without tally.view', async () => {
      const o = (await f.http('observer').get('/warroom/overview').expect(200)).body;
      const counts = Object.fromEntries(
        o.stationStatus.data.map((s: { status: string; count: number }) => [s.status, s.count]),
      );
      for (const s of ['FORM_RECEIVED', 'VERIFICATION_PENDING', 'VERIFIED_FOR_PARALLEL_TALLY'])
        expect(counts[s]).toBe(0);
      const rows = (await f.http('observer').get('/warroom/stations?pageSize=50').expect(200)).body
        .items;
      const f5 = rows.find(
        (r: { location: { station: { code: string } } }) => r.location.station.code === 'F-005',
      );
      expect(f5).toMatchObject({ status: 'NOT_ASSIGNED', formStatus: null });
      const detail = (await f.http('observer').get('/warroom/stations/F-005').expect(200)).body;
      expect(detail.status).toBe('NOT_ASSIGNED');
      // The commander (tally.view org-wide) sees it.
      const c = (await f.http('commander').get('/warroom/stations/F-005').expect(200)).body;
      expect(c.status).toBe('VERIFIED_FOR_PARALLEL_TALLY');
    });

    it('limits tally intake figures to the tally.view scope', async () => {
      const o = (await f.http('tallyW2').get('/warroom/overview').expect(200)).body;
      expect(o.formIntake.available).toBe(true);
      expect(o.formIntake.completeness.expected).toBe(2);
      expect(o.formIntake.data.received).toBe(0);
      expect(o.tallyVerification.data.verifiedStations).toBe(0);
      const c = (await f.http('commander').get('/warroom/overview').expect(200)).body;
      expect(c.formIntake.data.verified).toBe(1);
    });

    it('counts checked-out agents as assigned and checked in, consistent with completeness', async () => {
      const o = (await f.http('commander').get('/warroom/overview').expect(200)).body;
      const checkedInStations = o.agentOperations.completeness.reported;
      expect(o.agentOperations.data.checkedIn).toBeGreaterThanOrEqual(checkedInStations);
      expect(o.agentOperations.data.checkedIn).toBeGreaterThanOrEqual(1);
      expect(o.agentOperations.data.assignedSlots).toBeGreaterThanOrEqual(
        o.agentOperations.data.checkedIn,
      );
    });

    it('records derived statuses in a background run, not on reads, once per change', async () => {
      const recorder = f.app.get(StationStatusRecorderService);
      await f.http('commander').get('/warroom/stations?pageSize=50').expect(200);
      expect(
        await f.owner.stationStatusEvent.count({
          where: { tenantId: f.tenantId, source: 'DERIVED' },
        }),
      ).toBe(0);
      const [a, b] = await Promise.all([
        recorder.recordForTenant(f.tenantId),
        recorder.recordForTenant(f.tenantId),
      ]);
      expect((a?.changed ?? 0) + (b?.changed ?? 0)).toBeGreaterThan(0);
      const ss = await f.owner.stationStatus.findFirstOrThrow({
        where: { tenantId: f.tenantId, pollingStationCode: 'F-005' },
      });
      expect(ss.derivedStatus).toBe('VERIFIED_FOR_PARALLEL_TALLY');
      expect(
        await f.owner.stationStatusEvent.count({
          where: { stationStatusId: ss.id, source: 'DERIVED' },
        }),
      ).toBe(1);
      const again = await recorder.recordForTenant(f.tenantId);
      expect(again?.changed).toBe(0);
      expect(
        await f.owner.stationStatusEvent.count({
          where: { stationStatusId: ss.id, source: 'DERIVED' },
        }),
      ).toBe(1);
      expect(
        await f.owner.auditEvent.count({
          where: { tenantId: f.tenantId, action: 'warroom.station_status.derived_recorded' },
        }),
      ).toBe(1);
      // The observer's station history leaves out the tally-derived transition.
      const detail = (await f.http('observer').get('/warroom/stations/F-005').expect(200)).body;
      expect(
        detail.events.some(
          (e: { toStatus: string }) => e.toStatus === 'VERIFIED_FOR_PARALLEL_TALLY',
        ),
      ).toBe(false);
    });
  });

  describe('deployment', () => {
    it('never double-books an agent on overlapping shifts under concurrent planners', async () => {
      const agent = await mkAgent('Race');
      const [x, y] = await Promise.all([
        f
          .http('admin')
          .post('/field/deployments')
          .send({
            electionCycleId: f.cycleId,
            agentId: agent,
            pollingStationCode: 'F-004',
            role: 'STATION_AGENT',
            shift: 'FULL_DAY',
          }),
        f
          .http('planner2')
          .post('/field/deployments')
          .send({
            electionCycleId: f.cycleId,
            agentId: agent,
            pollingStationCode: 'F-006',
            role: 'STATION_AGENT',
            shift: 'OPENING',
          }),
      ]);
      expect([x.status, y.status].sort()).toEqual([201, 409]);
      expect(
        await f.owner.deployment.count({
          where: { agentId: agent, status: { in: ['ASSIGNED', 'CONFIRMED', 'CHECKED_IN'] } },
        }),
      ).toBe(1);
    });

    it('a check-in sent with the version from before the agent’s own confirmation is accepted', async () => {
      const agent = await mkAgent('Confirm-then-check-in', 'w1', 'agentB');
      const dep = await f
        .http('admin')
        .post('/field/deployments')
        .send({
          electionCycleId: f.cycleId,
          agentId: agent,
          pollingStationCode: 'F-002',
          role: 'CHIEF_AGENT',
        })
        .expect(201);
      const v = dep.body.version as number;
      await f
        .http('agentB')
        .post(`/field/deployments/${dep.body.id}/confirm`)
        .send({ ...offline(), expectedVersion: v })
        .expect(200);
      const ci = await f
        .http('agentB')
        .post(`/field/deployments/${dep.body.id}/check-in`)
        .send({ ...offline(), expectedVersion: v, checkedInAt: new Date().toISOString() });
      expect(ci.status).toBe(200);
      expect(ci.body.status).toBe('CHECKED_IN');
    });

    it('a coordinator change after the confirmation is still a conflict', async () => {
      const agent = await mkAgent('Changed-after-confirm', 'w1');
      await f
        .http('admin')
        .post(`/field/agents/${agent}/user`)
        .send({ userId: f.users.agentA, reason: 'Mobile' })
        .expect(200);
      const dep = await f
        .http('admin')
        .post('/field/deployments')
        .send({
          electionCycleId: f.cycleId,
          agentId: agent,
          pollingStationCode: 'F-001',
          role: 'STATION_AGENT',
          shift: 'OPENING',
        })
        .expect(201);
      const v = dep.body.version as number;
      const c = await f
        .http('agentA')
        .post(`/field/deployments/${dep.body.id}/confirm`)
        .send({ ...offline(), expectedVersion: v })
        .expect(200);
      await f
        .http('admin')
        .patch(`/field/deployments/${dep.body.id}`)
        .send({
          expectedVersion: c.body.version,
          instructions: 'Report to the gate',
          reason: 'Briefing',
        })
        .expect(200);
      await f
        .http('agentA')
        .post(`/field/deployments/${dep.body.id}/check-in`)
        .send({ ...offline(), expectedVersion: v, checkedInAt: new Date().toISOString() })
        .expect(409);
    });
  });

  describe('evidence uploads', () => {
    it('two people uploading identical bytes can both attach them', async () => {
      const png = syntheticPng();
      const up1 = await f
        .http('agentA')
        .post('/field/evidence')
        .attach('file', png, 'a.png')
        .expect(201);
      const up2 = await f
        .http('admin')
        .post('/field/evidence')
        .attach('file', png, 'b.png')
        .expect(200);
      expect(up2.body.fileId).toBe(up1.body.fileId);
      expect(up2.body.duplicate).toBe(true);
      const inc = await f
        .http('admin')
        .post('/field/incidents')
        .send({
          ...offline(),
          electionCycleId: f.cycleId,
          category: 'OTHER',
          occurredAt: new Date().toISOString(),
          location: { pollingStationCode: 'F-003' },
          description: 'Synthetic: photo of the queue.',
          privacyWarningAcknowledged: true,
          evidenceFileIds: [up2.body.fileId],
        });
      expect(inc.status).toBe(201);
      expect(inc.body.evidenceCount).toBe(1);
      // Someone who never uploaded the bytes still cannot attach the file.
      await f
        .http('desk')
        .post(`/field/incidents/${inc.body.id}/evidence`)
        .send({ fileIds: [up1.body.fileId] })
        .expect(400);
    });
  });

  describe('sync ledger', () => {
    it('a failure recorded after a concurrent acceptance never overwrites the ACCEPTED row', async () => {
      const ledger = f.app.get(ClientSubmissionLedger);
      const prisma = f.app.get(PrismaService);
      const auth = { tenantId: f.tenantId, userId: f.users.agentA! } as Parameters<
        ClientSubmissionLedger['check']
      >[1];
      const item = {
        idempotencyKey: randomUUID(),
        deviceId: 'device-race',
        kind: 'INCIDENT' as const,
        clientCreatedAt: new Date().toISOString(),
        payload: { a: 1 },
      };
      const hash = ClientSubmissionLedger.payloadHash(item.payload);
      const resultId = randomUUID();
      await prisma.withTenant(f.tenantId, (tx) =>
        ledger.record(tx, auth, item, hash, {
          outcome: 'ACCEPTED',
          resultType: 'Incident',
          resultId,
          resultReference: 'INC-2027-999999',
        }),
      );
      const accepted = await prisma.withTenant(f.tenantId, (tx) =>
        ledger.recordFailure(tx, auth, item, hash, {
          outcome: 'REJECTED',
          errorCode: 'VALIDATION_FAILED',
        }),
      );
      expect(accepted?.resultId).toBe(resultId);
      const row = await f.owner.clientSubmission.findFirstOrThrow({
        where: { tenantId: f.tenantId, idempotencyKey: item.idempotencyKey },
      });
      expect(row).toMatchObject({ outcome: 'ACCEPTED', resultId });
    });
  });

  describe('readiness', () => {
    it('concurrent updates of different items leave the checklist status consistent', async () => {
      await f
        .http('admin')
        .post('/field/readiness/generate')
        .send({
          electionCycleId: f.cycleId,
          geographicUnitId: f.units.w3,
          categories: ['MATERIALS', 'TRANSPORT'],
        })
        .expect(200);
      const list = (
        await f
          .http('admin')
          .get(`/field/readiness?electionCycleId=${f.cycleId}&wardId=${f.units.w3}&pageSize=50`)
          .expect(200)
      ).body;
      const checklist = list.items[0];
      const detail = (await f.http('admin').get(`/field/readiness/${checklist.id}`).expect(200))
        .body;
      const [i1, i2] = detail.items;
      await Promise.all([
        f
          .http('coordR1')
          .patch(`/field/readiness/${checklist.id}/items/${i1.id}`)
          .send({ expectedVersion: i1.version, status: 'DONE' })
          .expect(200),
        f
          .http('coordR2')
          .patch(`/field/readiness/${checklist.id}/items/${i2.id}`)
          .send({ expectedVersion: i2.version, status: 'DONE' })
          .expect(200),
      ]);
      const after = await f.owner.readinessChecklist.findUniqueOrThrow({
        where: { id: checklist.id },
      });
      expect(after.status).toBe('READY');
    });
  });
});
