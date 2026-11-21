/**
 * NGAO360 Office end-to-end rehearsal for a County Governor's office (blueprint
 * 9, 15.2, 17), driven through the real HTTP stack with the real system roles,
 * real password sign-in and TOTP for the roles that need MFA:
 *
 *   Citizen case
 *     a citizen submits a request on the public portal (no account) → gets a
 *       public reference and a one-time tracking code
 *     the office administrator triages and assigns it to a case officer
 *     the case officer adds an internal note and a public update, refers it to
 *       the responsible institution, records the institution's answer and
 *       proposes a resolution
 *     the citizen tracks the request and sees only public updates (no notes,
 *       no staff names, no contact details), then confirms the resolution
 *     the administrator (not the proposer) closes it; the citizen sees "Closed"
 *     a data-protection request removes the requester's personal content
 *       (re-auth); no IP address or device data was ever stored for them
 *
 *   Project
 *     the projects officer records a project naming the institution legally
 *       responsible, uploads a photograph and an inspection report and reports
 *       completion
 *     nobody verifies their own upload; the administrator verifies the evidence
 *     a photograph alone is refused as proof; completion is verified with the
 *       report after re-authentication
 *     the public-information editor publishes selected fields; the public
 *       endpoint shows only those fields and verified evidence, and always names
 *       the responsible institution; photographs are served re-encoded without
 *       metadata, documents only after a clean scan; editing a published field
 *       takes the project off the portal until it is approved again
 *
 * Everything is SYNTHETIC (fictional Bungoma geography, people and institutions)
 * in a fresh tenant with a random slug. Requires TEST_DATABASE_URL (owner) and
 * TEST_APP_DATABASE_URL (runtime role ngao_app, RLS enforced); skipped otherwise.
 */
import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import {
  createPrismaClient,
  currentTotpStep,
  generateTotpSecret,
  type PrismaClient,
  provisionSystemRoles,
  sealSecret,
  syncPermissionCatalogue,
  totpAt,
} from '@ngao360/db';
import { CURRENT_PORTAL_PRIVACY_NOTICE_VERSION, PROJECT_PUBLIC_DISCLAIMER, type SystemRoleKey } from '@ngao360/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { syntheticPng } from './office-fixtures';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const d = OWNER_URL && APP_URL ? describe : describe.skip;

jest.setTimeout(120_000);

const PASSWORD = 'Office-Rehearsal-Password-2027';
const MFA_KEY = Buffer.alloc(32, 11).toString('base64');
const JWT_SECRET = 'office-rehearsal-access-secret-office-rehearsal-access-01';

type Persona = 'admin' | 'caseOfficer' | 'projects' | 'editor';
const PERSONAS: Record<Persona, SystemRoleKey> = {
  admin: 'OFFICE_ADMINISTRATOR',
  caseOfficer: 'CASE_OFFICER',
  projects: 'PROJECTS_OFFICER',
  editor: 'PUBLIC_INFORMATION_EDITOR',
};
const MFA_ROLES = new Set<SystemRoleKey>(['OFFICE_ADMINISTRATOR', 'PUBLIC_INFORMATION_EDITOR']);

/** Decodable synthetic PNG carrying a text metadata chunk (stands in for EXIF location data). */
const png = () => syntheticPng('SYNTHETIC-GPS 0.5636N 34.5606E');
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n% synthetic inspection report (rehearsal)\n'), randomBytes(48)]);
const ip = () => {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${(b[2]! % 250) + 1}`;
};

d('NGAO360 Office governor rehearsal (synthetic)', () => {
  let owner: PrismaClient;
  let app: INestApplication;
  let storageRoot: string;
  const slug = `office-rehearsal-${randomUUID().slice(0, 8)}`;
  let tenantId: string;
  const units = {} as Record<'county' | 'kanduyi' | 'webuye' | 'township' | 'mihuu', string>;
  const userIds = {} as Record<Persona, string>;
  const displayNames = {} as Record<Persona, string>;
  const totpSecrets: Partial<Record<Persona, string>> = {};
  const lastStep: Partial<Record<Persona, number>> = {};
  const agents = {} as Record<Persona, ReturnType<typeof request.agent>>;

  // Shared state across the ordered steps.
  const REQUESTER = { name: 'Synthetic Citizen Wekesa', phone: '0722 555123' };
  const INTERNAL_NOTE = 'INTERNAL-ONLY: ward administrator says the contractor left site last month';
  const REFERRAL_NOTE = 'INTERNAL-ONLY: roads agency mandate covers this crossing';
  let publicReference: string;
  let trackingCode: string;
  let caseId: string;
  let caseVersion: number;
  let institutionId: string;
  let roadsDeptId: string;
  let projectId: string;
  let projectVersion: number;
  let photoId: string;
  let reportId: string;

  /* --------------------------------- helpers --------------------------------- */

  /**
   * A fresh TOTP code for this persona, never reusing a step (the server refuses replays).
   * The previous step's code is used only early in the current 30 s step: near a boundary a
   * slow run would present it after it left the server's window. When the usable steps are
   * used up, wait for the next step rather than send a code that may be refused.
   */
  const nextCode = async (who: Persona): Promise<string> => {
    const secret = totpSecrets[who]!;
    for (;;) {
      const now = currentTotpStep();
      const secondsIntoStep = Math.floor(Date.now() / 1000) % 30;
      let step = secondsIntoStep < 20 ? now - 1 : now;
      while (lastStep[who] !== undefined && step <= lastStep[who]!) step++;
      if (step <= now + 1) {
        lastStep[who] = step;
        return totpAt(secret, step);
      }
      await new Promise((resolve) => setTimeout(resolve, (30 - secondsIntoStep) * 1000 + 250));
    }
  };

  const http = (who: Persona) => {
    const a = agents[who];
    return {
      get: (p: string) => a.get(`/api${p}`),
      post: (p: string) => a.post(`/api${p}`).set('x-ngao-client', 'web'),
      put: (p: string) => a.put(`/api${p}`).set('x-ngao-client', 'web'),
      patch: (p: string) => a.patch(`/api${p}`).set('x-ngao-client', 'web'),
    };
  };

  /** A member of the public: no cookies, no token, their own client IP. */
  const citizen = (clientIp = ip()) => {
    const agent = request(app.getHttpServer());
    return {
      get: (p: string) => agent.get(`/api${p}`).set('x-forwarded-for', clientIp),
      post: (p: string) => agent.post(`/api${p}`).set('x-ngao-client', 'web').set('x-forwarded-for', clientIp),
    };
  };

  async function signIn(who: Persona): Promise<void> {
    agents[who] = request.agent(app.getHttpServer());
    const res = await http(who).post('/auth/login').send({ tenantSlug: slug, email: `${who.toLowerCase()}@office-rehearsal.example.org`, password: PASSWORD });
    expect(res.status).toBe(200);
    if (res.body.status === 'MFA_REQUIRED') {
      const mfa = await http(who).post('/auth/mfa/verify').send({ challengeToken: res.body.challengeToken, code: await nextCode(who) });
      expect(mfa.status).toBe(200);
      expect(mfa.body.mfaVerified).toBe(true);
    } else {
      expect(res.body.status).toBe('AUTHENTICATED');
    }
  }

  async function reauth(who: Persona): Promise<void> {
    const res = await http(who).post('/auth/reauth').send({ password: PASSWORD, ...(totpSecrets[who] ? { code: await nextCode(who) } : {}) });
    expect(res.status).toBe(200);
  }

  const track = () => citizen().post(`/public/${slug}/track`).send({ publicReference, trackingCode });

  /** Nothing on the tracking page may identify staff, the requester or internal work. */
  function expectNoLeak(body: unknown): void {
    const text = JSON.stringify(body);
    const forbidden = [
      INTERNAL_NOTE,
      REFERRAL_NOTE,
      'INTERNAL-ONLY',
      REQUESTER.name,
      REQUESTER.phone,
      caseId,
      ...Object.values(userIds),
      ...Object.values(displayNames),
    ];
    for (const s of forbidden) expect(text).not.toContain(s);
  }

  /* ---------------------------------- setup ---------------------------------- */

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'ngao-office-rehearsal-'));
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: OWNER_URL,
      APP_DATABASE_URL: APP_URL,
      QUEUES_ENABLED: 'false',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: storageRoot,
      JWT_ACCESS_SECRET: JWT_SECRET,
      JWT_REFRESH_SECRET: `${JWT_SECRET}-refresh`,
      MFA_ENCRYPTION_KEY: MFA_KEY,
      RATE_LIMIT_MAX: '100000',
      AUTH_RATE_LIMIT_MAX: '100000',
    });
    owner = createPrismaClient({ url: OWNER_URL!, log: [] });

    // Same provisioning as `pnpm db:seed`: permission catalogue and system roles.
    await syncPermissionCatalogue(owner);
    const name = 'Office of the Governor (synthetic rehearsal)';
    tenantId = (await owner.tenant.create({ data: { slug, name, displayName: name, type: 'ELECTED_OFFICE' } })).id;
    const roleIds = await provisionSystemRoles(owner, tenantId);

    // Synthetic administrative geography (fictional codes).
    const cycle = await owner.electionCycle.create({
      data: { tenantId, name: 'Administrative geography (synthetic)', electionDate: new Date('2027-08-10'), legalConfigVersion: 'rehearsal', dataProvenance: 'SYNTHETIC', status: 'ACTIVE' },
    });
    const unit = async (key: keyof typeof units, type: 'COUNTY' | 'CONSTITUENCY' | 'WARD', code: string, unitName: string, parent?: { id: string; path: string }) => {
      const id = randomUUID();
      const path = `${parent?.path ?? '/'}${id}/`;
      await owner.geographicUnit.create({
        data: { id, tenantId, electionCycleId: cycle.id, type, parentId: parent?.id ?? null, officialCode: code, officialName: unitName, path, sourceVersion: 'synthetic-rehearsal' },
      });
      units[key] = id;
      return { id, path };
    };
    const county = await unit('county', 'COUNTY', 'S39', 'Bungoma (synthetic)');
    const kanduyi = await unit('kanduyi', 'CONSTITUENCY', 'S39-1', 'Kanduyi (synthetic)', county);
    const webuye = await unit('webuye', 'CONSTITUENCY', 'S39-2', 'Webuye East (synthetic)', county);
    await unit('township', 'WARD', 'S39-1-1', 'Township (synthetic)', kanduyi);
    await unit('mihuu', 'WARD', 'S39-2-1', 'Mihuu (synthetic)', webuye);

    const svc = await owner.user.create({
      data: { tenantId, email: `portal-service@${slug}.invalid`, displayName: 'Public portal (service account)', status: 'DEACTIVATED', passwordHash: null },
    });
    await owner.tenantModule.create({
      data: {
        tenantId,
        moduleKey: 'office',
        enabled: true,
        config: {
          publicPortalEnabled: true,
          publicProjectsEnabled: true,
          portalDisplayName: name,
          controllerName: name,
          dataProtectionContact: 'dpo@office-rehearsal.example.org',
          portalCountyUnitId: units.county,
          portalServiceUserId: svc.id,
        },
      },
    });

    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    for (const [persona, role] of Object.entries(PERSONAS) as Array<[Persona, SystemRoleKey]>) {
      displayNames[persona] = `Rehearsal ${persona} (synthetic)`;
      const user = await owner.user.create({
        data: { tenantId, email: `${persona.toLowerCase()}@office-rehearsal.example.org`, displayName: displayNames[persona], passwordHash, status: 'ACTIVE', passwordChangedAt: new Date() },
      });
      userIds[persona] = user.id;
      await owner.roleAssignment.create({ data: { tenantId, userId: user.id, roleId: roleIds[role]!, scopeType: 'ORGANISATION', reason: 'Office rehearsal (synthetic)' } });
      if (MFA_ROLES.has(role)) {
        const secret = generateTotpSecret();
        totpSecrets[persona] = secret;
        await owner.mfaFactor.create({
          data: { tenantId, userId: user.id, type: 'TOTP', status: 'ACTIVE', label: 'Rehearsal authenticator', secretEncrypted: sealSecret(secret, MFA_KEY), verifiedAt: new Date() },
        });
        await owner.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
      }
    }

    const { createApp } = await import('../src/main');
    app = await createApp();
    await app.init();
    for (const p of Object.keys(PERSONAS) as Persona[]) await signIn(p);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await owner?.$disconnect();
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  /* ------------------------------- citizen case ------------------------------- */

  it('office roles hold Office permissions only: no tally or campaign access (blueprint 15.2)', async () => {
    for (const p of Object.keys(PERSONAS) as Persona[]) {
      const me = await http(p).get('/auth/me').expect(200);
      expect(me.body.permissions.filter((k: string) => k.startsWith('tally.'))).toEqual([]);
    }
    const officer = await http('caseOfficer').get('/auth/me');
    expect(officer.body.permissions).toEqual(expect.arrayContaining(['office.cases.manage', 'office.cases.referral']));
    expect(officer.body.permissions).not.toContain('office.cases.close');
    await http('caseOfficer').get('/tally/submissions').expect(403);
  });

  it('a citizen submits a request on the public portal without an account and gets a reference', async () => {
    const portal = await citizen().get(`/public/${slug}/portal`).expect(200);
    expect(portal.body.privacyNotice.version).toBe(CURRENT_PORTAL_PRIVACY_NOTICE_VERSION);
    const headings = portal.body.privacyNotice.sections.map((s: { heading: string }) => s.heading);
    expect(headings).toEqual(expect.arrayContaining(['What we collect', 'Why we collect it', 'Who receives it', 'How long we keep it']));
    expect(portal.body.wards.map((w: { id: string }) => w.id)).toContain(units.township);

    const payload = {
      category: 'ROADS_TRANSPORT',
      description: 'Synthetic rehearsal: the footbridge over the stream behind Township market has collapsed; pupils walk 3 km round.',
      geographicUnitId: units.township,
      locationDescription: 'Behind the synthetic Township market',
      contactPreference: 'SMS',
      name: REQUESTER.name,
      phone: REQUESTER.phone,
      consentToContact: true,
      privacyNoticeVersion: portal.body.privacyNotice.version,
      privacyNoticeAcknowledged: true,
    };
    const res = await citizen()
      .post(`/public/${slug}/requests`)
      .field('payload', JSON.stringify(payload))
      .attach('photo', png(), { filename: 'Wekesa-home-bridge.png', contentType: 'image/png' })
      .expect(201);
    expect(res.body.trackingCode).toMatch(/^[0-9A-Z]{8}$/);
    expect(res.body.trackPath).toBe(`/p/${slug}/track`);
    ({ publicReference, trackingCode } = res.body);

    const tracked = await track().expect(200);
    expect(tracked.body).toMatchObject({ publicReference, stage: 'RECEIVED', feedbackAllowed: false });
  });

  it('the administrator finds it in triage, triages it and assigns it to a case officer', async () => {
    const list = await http('admin').get('/office/cases?view=triage&pageSize=50').expect(200);
    const row = list.body.items.find((c: { publicReference: string }) => c.publicReference === publicReference);
    expect(row).toMatchObject({ status: 'SUBMITTED', source: 'PORTAL' });
    expect(JSON.stringify(row)).not.toContain(REQUESTER.phone);
    caseId = row.id;

    const detail = await http('admin').get(`/office/cases/${caseId}`).expect(200);
    expect(JSON.stringify(detail.body)).not.toContain(REQUESTER.phone);
    caseVersion = detail.body.version;
    // Assigning before triage is refused: triage first.
    const early = await http('admin').post(`/office/cases/${caseId}/assign`).send({ assigneeId: userIds.caseOfficer, expectedVersion: caseVersion }).expect(409);
    expect(early.body.code).toBe('INVALID_TRANSITION');

    const triaged = await http('admin').post(`/office/cases/${caseId}/transition`).send({ to: 'TRIAGE', reason: 'Genuine request within county mandate', expectedVersion: caseVersion }).expect(200);
    expect(triaged.body.status).toBe('TRIAGE');
    caseVersion = triaged.body.version;

    const officers = await http('admin').get(`/office/cases/${caseId}/assignable-officers`).expect(200);
    expect(officers.body.map((u: { id: string }) => u.id)).toEqual(expect.arrayContaining([userIds.caseOfficer, userIds.admin]));
    expect(officers.body.map((u: { id: string }) => u.id)).not.toContain(userIds.projects);

    const assigned = await http('admin').post(`/office/cases/${caseId}/assign`).send({ assigneeId: userIds.caseOfficer, expectedVersion: caseVersion }).expect(200);
    expect(assigned.body).toMatchObject({ status: 'ASSIGNED', assignee: { id: userIds.caseOfficer } });
    expect(assigned.body.nextReviewDate).toEqual(expect.any(String));
    caseVersion = assigned.body.version;
  });

  it('the case officer notes, updates the requester and refers the case to the responsible institution', async () => {
    const inst = await http('admin')
      .post('/office/institutions')
      .send({ name: 'Synthetic Kenya Rural Roads Authority (Bungoma region)', type: 'NATIONAL_AGENCY', mandate: 'Rural roads and crossings (synthetic)' })
      .expect(201);
    institutionId = inst.body.id;

    const officer = http('caseOfficer');
    await officer.post(`/office/cases/${caseId}/events`).send({ type: 'NOTE', body: INTERNAL_NOTE }).expect(201);
    await officer.post(`/office/cases/${caseId}/events`).send({ type: 'PUBLIC_UPDATE', body: 'An officer visited the site and confirmed the crossing is unsafe.' }).expect(201);
    const referred = await officer
      .post(`/office/cases/${caseId}/referrals`)
      .send({ institutionId, referredAt: '2026-11-20', note: REFERRAL_NOTE, expectedVersion: caseVersion })
      .expect(200);
    expect(referred.body.status).toBe('REFERRED');
    caseVersion = referred.body.version;
    const referralId = referred.body.referrals[0].id as string;
    await officer
      .patch(`/office/cases/${caseId}/referrals/${referralId}`)
      .send({ status: 'RESPONDED', responseSummary: 'Agency will install a temporary crossing (synthetic)', note: 'Agency engineer replied by letter' })
      .expect(200);

    const tracked = await track().expect(200);
    expect(tracked.body.stage).toBe('REFERRED');
    expect(tracked.body.referredTo).toEqual(['Synthetic Kenya Rural Roads Authority (Bungoma region)']);
    expectNoLeak(tracked.body);
  });

  it('the case officer proposes a resolution but cannot close the case', async () => {
    const officer = http('caseOfficer');
    const back = await officer.post(`/office/cases/${caseId}/transition`).send({ to: 'IN_PROGRESS', reason: 'Following up the agency answer', expectedVersion: caseVersion }).expect(200);
    caseVersion = back.body.version;
    const proposed = await officer
      .post(`/office/cases/${caseId}/propose-resolution`)
      .send({ summary: 'The roads agency installed a temporary footbridge; a permanent bridge is in its 2027 plan.', internalNote: 'Confirmed by the ward administrator', expectedVersion: caseVersion })
      .expect(200);
    expect(proposed.body).toMatchObject({ status: 'RESOLUTION_PROPOSED', resolution: { proposedBy: { id: userIds.caseOfficer } } });
    caseVersion = proposed.body.version;
    const refused = await officer.post(`/office/cases/${caseId}/close`).send({ closureReason: 'RESOLVED', note: 'done', expectedVersion: caseVersion }).expect(403);
    expect(refused.body.code).toBe('FORBIDDEN');
  });

  it('the citizen tracks the request and sees only public updates, then confirms the resolution', async () => {
    const tracked = await track().expect(200);
    expect(tracked.body).toMatchObject({ stage: 'RESOLUTION_PROPOSED', feedbackAllowed: true });
    const messages: string[] = tracked.body.updates.map((u: { message: string }) => u.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'Your request has been assigned to an officer.',
        'An officer visited the site and confirmed the crossing is unsafe.',
        'Referred to Synthetic Kenya Rural Roads Authority (Bungoma region).',
        'Request received.',
        'Proposed resolution: The roads agency installed a temporary footbridge; a permanent bridge is in its 2027 plan.',
      ]),
    );
    for (const u of tracked.body.updates) expect(Object.keys(u).sort()).toEqual(['at', 'message']);
    expectNoLeak(tracked.body);

    // Another office's reference/code pair never matches; a wrong code looks like an unknown reference.
    const wrong = await citizen().post(`/public/${slug}/track`).send({ publicReference, trackingCode: 'ZZZZZZZZ' }).expect(404);
    const unknown = await citizen().post(`/public/${slug}/track`).send({ publicReference: 'OR-0000-0000', trackingCode }).expect(404);
    expect(wrong.body.message).toBe(unknown.body.message);

    await citizen()
      .post(`/public/${slug}/track/feedback`)
      .send({ publicReference, trackingCode, response: 'CONFIRM_RESOLVED', message: 'Thank you, the children can cross again.' })
      .expect(200);
    const d1 = await http('admin').get(`/office/cases/${caseId}`).expect(200);
    expect(d1.body.status).toBe('CITIZEN_FEEDBACK');
    expect(d1.body.allowedActions).toContain('close');
    caseVersion = d1.body.version;
  });

  it('the administrator, not the proposer, closes the case; the citizen sees it closed', async () => {
    const closed = await http('admin')
      .post(`/office/cases/${caseId}/close`)
      .send({ closureReason: 'RESOLVED', note: 'Requester confirmed the temporary crossing', expectedVersion: caseVersion })
      .expect(200);
    expect(closed.body).toMatchObject({ status: 'CLOSED', closure: { reason: 'RESOLVED', closedBy: { id: userIds.admin } } });

    const tracked = await track().expect(200);
    expect(tracked.body.stage).toBe('CLOSED');
    expect(tracked.body.feedbackAllowed).toBe(false);
    expectNoLeak(tracked.body);

    // Every step is in the append-only audit trail, with no contact values in it.
    const audit = await owner.auditEvent.findMany({ where: { tenantId, entityId: caseId }, orderBy: { occurredAt: 'asc' } });
    const actions = audit.map((a) => a.action);
    for (const a of ['office.case.public_submitted', 'office.case.status_changed', 'office.case.assigned', 'office.case.referred', 'office.case.closed']) {
      expect(actions).toContain(a);
    }
    const snapshots = JSON.stringify(audit.map((a) => [a.before, a.after]));
    expect(snapshots).not.toContain(REQUESTER.phone);
    expect(snapshots).not.toContain(REQUESTER.name);
    expect(snapshots).not.toContain(INTERNAL_NOTE);
    const history = await http('admin').get(`/office/cases/${caseId}/history`).expect(200);
    expect(history.body.length).toBeGreaterThanOrEqual(audit.length);
    // The anonymous requester's IP address and device are never stored.
    const portalEvents = audit.filter((a) => a.action === 'office.case.public_submitted' || a.action === 'office.case.citizen_feedback');
    expect(portalEvents.length).toBe(2);
    for (const e of portalEvents) expect([e.sourceIp, e.userAgent]).toEqual([null, null]);
  });

  it('a data-protection request removes the requester’s personal details; the anonymised record stays', async () => {
    // The portal photo was stored without its metadata and under a neutral name.
    const detail = await http('admin').get(`/office/cases/${caseId}`).expect(200);
    const photo = detail.body.events.find((e: { type: string; file: unknown }) => e.type === 'EVIDENCE_ADDED' && e.file);
    expect(photo.file.originalFilename).toBe('portal-photo.png');
    const stored = await owner.storedFile.findUniqueOrThrow({ where: { id: photo.file.id } });
    const bytes = readFileSync(join(storageRoot, stored.storageKey));
    expect(bytes.includes(Buffer.from('SYNTHETIC-GPS'))).toBe(false);

    await http('admin').post(`/office/cases/${caseId}/redact`).send({ reason: 'Requester asked for their details to be removed' }).expect(401);
    await reauth('admin');
    const redacted = await http('admin').post(`/office/cases/${caseId}/redact`).send({ reason: 'Requester asked for their details to be removed' }).expect(200);
    expect(redacted.body).toMatchObject({ status: 'CLOSED', redactedAt: expect.any(String), description: '[Personal content removed]' });
    expect(redacted.body.allowedActions).not.toContain('reopen');
    expect(JSON.stringify(redacted.body)).not.toContain('Thank you, the children can cross again.');
    expect(redacted.body.events.some((e: { file: unknown }) => e.file)).toBe(false);
    const contact = await http('admin').get(`/office/cases/${caseId}/contact`).expect(200);
    expect(contact.body).toMatchObject({ name: null, phone: null, erasedAt: expect.any(String) });
    // The requester can still see that the request was handled and closed.
    const tracked = await track().expect(200);
    expect(tracked.body.stage).toBe('CLOSED');
    expect(JSON.stringify(tracked.body)).not.toContain('Thank you, the children can cross again.');
    const audit = await owner.auditEvent.findFirstOrThrow({ where: { tenantId, entityId: caseId, action: 'office.case.redacted' } });
    expect(audit.actorId).toBe(userIds.admin);
  });

  /* --------------------------------- project ---------------------------------- */

  it('the projects officer records a project naming the institution legally responsible', async () => {
    roadsDeptId = (
      await http('admin').post('/office/institutions').send({ name: 'Synthetic County Department of Roads and Public Works', type: 'COUNTY_DEPARTMENT' }).expect(201)
    ).body.id;
    const res = await http('projects')
      .post('/office/projects')
      .send({
        name: 'Mihuu ward feeder road culverts (synthetic)',
        category: 'ROADS_INFRASTRUCTURE',
        geographicUnitId: units.mihuu,
        responsibleInstitutionId: roadsDeptId,
        commitmentSource: 'COUNTY_BUDGET',
        fundingSource: 'COUNTY_GOVERNMENT',
        approvedAllocation: '3800000',
        contractAmount: '3650000',
        contractAmountIsPublic: false,
        initialStatus: 'APPROVED',
        approvalAuthority: 'County Assembly budget approval (synthetic)',
        description: 'Internal description: procurement file reference PF-SYN-0099 (synthetic).',
      })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'APPROVED', stageKind: 'APPROVED', responsibleInstitution: { id: roadsDeptId }, isPublic: false });
    ({ id: projectId, version: projectVersion } = res.body);
  });

  it('evidence is uploaded; the uploader cannot verify it and a different user does', async () => {
    const upload = (meta: Record<string, unknown>, file: Buffer, filename: string, contentType: string) =>
      http('projects').post(`/office/projects/${projectId}/evidence`).field('metadata', JSON.stringify(meta)).attach('file', file, { filename, contentType });
    photoId = (await upload({ type: 'PHOTO', description: 'Synthetic photograph of the finished culverts', capturedOn: '2026-11-18' }, png(), 'culverts.png', 'image/png').expect(201)).body.id;
    const report = await upload({ type: 'INSPECTION_REPORT', description: 'Synthetic county inspectorate report', sourceDescription: 'County inspectorate (synthetic)' }, pdf(), 'inspection.pdf', 'application/pdf').expect(201);
    reportId = report.body.id;
    expect(report.body).toMatchObject({ verificationStatus: 'PENDING_VERIFICATION', uploadedBy: { id: userIds.projects } });

    // The projects officer has no verify permission at all; the administrator verifies.
    await http('projects').post(`/office/projects/${projectId}/evidence/${reportId}/verify`).send({ status: 'VERIFIED', note: 'mine' }).expect(403);
    for (const id of [photoId, reportId]) {
      const v = await http('admin').post(`/office/projects/${projectId}/evidence/${id}/verify`).send({ status: 'VERIFIED', note: 'Checked against the inspectorate register' }).expect(200);
      expect(v.body).toMatchObject({ verificationStatus: 'VERIFIED', verifiedBy: { id: userIds.admin } });
    }
  });

  it('reported completion is not verified completion; a photograph alone is not proof', async () => {
    projectVersion = (await http('projects').post(`/office/projects/${projectId}/transition`).send({ to: 'ONGOING', reason: 'Works started', expectedVersion: projectVersion }).expect(200)).body.version;
    const reported = await http('projects')
      .post(`/office/projects/${projectId}/transition`)
      .send({ to: 'COMPLETED', reason: 'Contractor reports completion', actualCompletionDate: '2026-11-15', expectedVersion: projectVersion })
      .expect(200);
    expect(reported.body).toMatchObject({ stageKind: 'REPORTED_COMPLETE', completion: { reportedBy: { id: userIds.projects }, verifiedBy: null } });
    projectVersion = reported.body.version;

    await reauth('admin');
    const photoOnly = await http('admin')
      .post(`/office/projects/${projectId}/verify-completion`)
      .send({ evidenceIds: [photoId], note: 'Photo shows finished culverts', expectedVersion: projectVersion })
      .expect(400);
    expect(photoOnly.body.message).toMatch(/photograph alone/i);

    const verified = await http('admin')
      .post(`/office/projects/${projectId}/verify-completion`)
      .send({ evidenceIds: [reportId, photoId], note: 'Inspection report confirms completion to specification', expectedVersion: projectVersion })
      .expect(200);
    expect(verified.body).toMatchObject({ status: 'VERIFIED_COMPLETED', stageKind: 'VERIFIED_COMPLETE', completion: { verifiedBy: { id: userIds.admin } } });
    projectVersion = verified.body.version;
  });

  it('the public-information editor publishes approved fields; the public page shows only those', async () => {
    await citizen().get(`/public/${slug}/projects/${projectId}`).expect(404);
    // Documents and photos reach the public only after a clean malware scan (recorded by the scanner).
    for (const evidenceId of [reportId, photoId]) {
      const ev = await owner.projectEvidence.findUniqueOrThrow({ where: { id: evidenceId } });
      await owner.storedFile.update({ where: { id: ev.storedFileId }, data: { malwareScanStatus: 'CLEAN', scannedAt: new Date() } });
    }
    const body = { isPublic: true, publicFields: ['schedule', 'evidence'], publicEvidenceIds: [reportId, photoId], reason: 'Publish verified completion', expectedVersion: projectVersion };
    await http('projects').put(`/office/projects/${projectId}/publication`).send(body).expect(403);
    const stale = await http('editor').put(`/office/projects/${projectId}/publication`).send(body).expect(401);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
    await reauth('editor');
    const published = await http('editor').put(`/office/projects/${projectId}/publication`).send(body).expect(200);
    expect(published.body.publication).toMatchObject({ isPublic: true, publishedBy: { id: userIds.editor } });

    const res = await citizen().get(`/public/${slug}/projects/${projectId}`).expect(200);
    expect(res.body).toMatchObject({
      name: 'Mihuu ward feeder road culverts (synthetic)',
      stageKind: 'VERIFIED_COMPLETE',
      completionVerificationLabel: 'Completion verified',
      responsibleInstitution: { name: 'Synthetic County Department of Roads and Public Works' },
      commitmentSourceLabel: expect.any(String),
      disclaimer: PROJECT_PUBLIC_DISCLAIMER,
      schedule: expect.objectContaining({ actualCompletionDate: '2026-11-15' }),
    });
    for (const hidden of ['contractAmount', 'approvedAllocation', 'description', 'projectOwner', 'expenditure', 'milestones']) {
      expect(res.body).not.toHaveProperty(hidden);
    }
    expect(res.body.evidence.map((e: { id: string }) => e.id).sort()).toEqual([reportId, photoId].sort());
    const text = JSON.stringify(res.body);
    for (const s of ['3650000', '3800000', 'PF-SYN-0099', ...Object.values(displayNames), ...Object.values(userIds)]) expect(text).not.toContain(s);

    await citizen().get(`/public/${slug}/projects/${projectId}/evidence/${reportId}/file`).expect(302);
    // The photograph is re-encoded for the public: no metadata, neutral file name.
    const photo = await citizen().get(`/public/${slug}/projects/${projectId}/evidence/${photoId}/file`).buffer(true).expect(200);
    expect(photo.headers['content-type']).toBe('image/png');
    expect(photo.headers['content-disposition']).toBe(`inline; filename="evidence-${photoId}.png"`);
    expect((photo.body as Buffer).includes(Buffer.from('SYNTHETIC-GPS'))).toBe(false);

    // Editing a published field takes the project off the portal until it is approved again.
    const edited = await http('projects').patch(`/office/projects/${projectId}`).send({ name: 'Mihuu culverts (renamed, synthetic)', expectedVersion: published.body.version }).expect(200);
    expect(edited.body.publication.isPublic).toBe(false);
    await citizen().get(`/public/${slug}/projects/${projectId}`).expect(404);
    await reauth('editor');
    const republished = await http('editor')
      .put(`/office/projects/${projectId}/publication`)
      .send({ ...body, reason: 'Approve the new name', expectedVersion: edited.body.version })
      .expect(200);
    expect(republished.body.publication.isPublic).toBe(true);
    const renamed = await citizen().get(`/public/${slug}/projects/${projectId}`).expect(200);
    expect(renamed.body.name).toBe('Mihuu culverts (renamed, synthetic)');
    const list = await citizen().get(`/public/${slug}/projects`).expect(200);
    expect(list.body.items.map((p: { id: string }) => p.id)).toEqual([projectId]);

    // Staff preview uses the same code path as the public page.
    const preview = await http('projects').get(`/office/projects/${projectId}/public-preview`).expect(200);
    expect(preview.body).toEqual(renamed.body);

    const audit = await owner.auditEvent.findMany({ where: { tenantId, entityId: projectId } });
    const actions = new Set(audit.map((a) => a.action));
    for (const a of ['office.project.created', 'office.project.status_changed', 'office.project.completion_verified', 'office.project.publication_changed']) {
      expect(actions).toContain(a);
    }
  });
});
