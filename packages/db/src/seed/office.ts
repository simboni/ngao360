/* eslint-disable no-console -- CLI seed script output */
/**
 * NGAO360 Office seed: a SYNTHETIC County Governor's office tenant for Bungoma
 * (slug `bungoma-governor`) with the `office` module and public portal
 * enabled, an institution registry, office demo users (one per office role),
 * correspondence, appointments, meetings, citizen cases across every stage and
 * development projects with milestones and mixed verification states.
 *
 * Every person, organisation name, case, letter, amount and project is
 * invented. Only "Bungoma" and its county code (039) are real public reference
 * data; constituencies and wards are the synthetic registry names. Institution
 * names are generic and carry "(synthetic)".
 *
 * Idempotent: records are keyed by their reference; a re-run leaves existing
 * rows untouched. Runs as the schema owner (RLS bypassed).
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import type {
  AppointmentStatus,
  CaseEventType,
  CommitmentSource,
  CorrespondenceCategory,
  CorrespondenceStatus,
  FundingSource,
  InstitutionType,
  PrismaClient,
  ProjectCategory,
  ScopeType,
} from '@prisma/client';
import {
  CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION,
  CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
  type CaseCategory,
  type CaseStatus,
  formatPublicReference,
  formatTrackingCode,
  type OfficeModuleConfig,
  OfficeModuleConfigSchema,
  type ProjectStatus,
  type SystemRoleKey,
} from '@ngao360/shared';
import { provisionSystemRoles } from '../provisioning';
import { BUNGOMA_CODE } from './reference-data';
import { SYNTHETIC_CONSTITUENCIES, SYNTHETIC_REGISTRY_VERSION, syntheticBungomaRows } from './synthetic-bungoma';

export const OFFICE_TENANT_SLUG = 'bungoma-governor';
export const OFFICE_TENANT_NAME = "Office of the Governor, Bungoma County (synthetic demo)";
const DOMAIN = 'bungoma-office.example.org';
const GEOGRAPHY_CYCLE_NAME = 'Administrative geography (office reference, synthetic)';
const SEED_YEAR = 2026;

export interface OfficeSeedOptions {
  passwordHash: string;
  /** Applies SEED_DEMO_MFA to users whose role requires MFA (from index.ts). */
  applyDemoMfa: (tenantId: string, userId: string) => Promise<unknown>;
  mfaRoles: ReadonlySet<string>;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const sha = (s: string) => createHash('sha256').update(s).digest();
const daysAgo = (n: number) => new Date(Date.UTC(2026, 10, 20, 8, 0, 0) - n * 86_400_000);
const dateOnly = (n: number) => {
  const d = daysAgo(n);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const ref = (prefix: string, n: number) => `${prefix}-${SEED_YEAR}-${String(900000 + n).padStart(6, '0')}`;

/** Deterministic public reference and tracking code, so demos can track a known case. */
export function seedPublicReference(i: number): { publicReference: string; trackingCode: string; trackingCodeHash: string } {
  const publicReference = formatPublicReference('BG', sha(`ngao360-office-seed-ref:${i}`));
  const trackingCode = formatTrackingCode(sha(`ngao360-office-seed-track:${i}`));
  return { publicReference, trackingCode, trackingCodeHash: createHash('sha256').update(trackingCode).digest('hex') };
}

/* ------------------------------- Synthetic files ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A small solid-colour PNG with a tEXt label: a stand-in "photograph", clearly synthetic. */
function syntheticPng(label: string): Buffer {
  const h = sha(label);
  const w = 32;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([h[0]!, h[1]!, h[2]!], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: w }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from(`Comment\0SYNTHETIC DEMO IMAGE - ${label}`, 'latin1')),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
/** A one-page PDF stating it is a synthetic demo document. */
function syntheticPdf(title: string): Buffer {
  const text = `SYNTHETIC DEMO DOCUMENT - NOT A REAL RECORD. ${title}`.replace(/[()\\]/g, '');
  const stream = `BT /F1 10 Tf 40 760 Td (${text.slice(0, 110)}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * Store a synthetic file the way StorageService does (content-addressed key,
 * never overwritten). Bytes go to SEED_STORAGE_ROOT, else STORAGE_LOCAL_ROOT
 * resolved from apps/api (the API's working directory under `pnpm dev`).
 */
async function storeSyntheticFile(
  prisma: PrismaClient,
  tenantId: string,
  uploadedById: string,
  bytes: Buffer,
  mimeType: 'image/png' | 'application/pdf',
  filename: string,
  purpose: 'PROJECT_EVIDENCE' | 'CORRESPONDENCE' | 'CASE_EVIDENCE',
): Promise<string> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = await prisma.storedFile.findUnique({ where: { tenantId_sha256: { tenantId, sha256 } } });
  if (existing) return existing.id;
  const storageKey = `tenants/${tenantId}/sha256/${sha256.slice(0, 2)}/${sha256}`;
  const driver = (process.env.STORAGE_DRIVER ?? 'local').toLowerCase();
  if (driver === 'local') {
    const root =
      process.env.SEED_STORAGE_ROOT ??
      resolve(__dirname, '../../../../apps/api', process.env.STORAGE_LOCAL_ROOT ?? './storage');
    const path = join(root, storageKey);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, 'wx', 0o444);
      writeSync(fd, bytes);
      closeSync(fd);
    }
  }
  const file = await prisma.storedFile.create({
    data: {
      tenantId,
      sha256,
      mimeType,
      sizeBytes: BigInt(bytes.length),
      originalFilename: filename,
      purpose,
      storageDriver: driver === 's3' ? 'S3' : 'LOCAL',
      storageKey,
      malwareScanStatus: 'SKIPPED',
      uploadedById,
    },
  });
  return file.id;
}

/* -------------------------------------------------------------------------- */
/* Seed                                                                        */
/* -------------------------------------------------------------------------- */

export async function seedOffice(prisma: PrismaClient, opts: OfficeSeedOptions): Promise<void> {
  const tenant = await prisma.tenant.upsert({
    where: { slug: OFFICE_TENANT_SLUG },
    create: { slug: OFFICE_TENANT_SLUG, name: OFFICE_TENANT_NAME, displayName: OFFICE_TENANT_NAME, type: 'ELECTED_OFFICE' },
    update: { name: OFFICE_TENANT_NAME, displayName: OFFICE_TENANT_NAME, type: 'ELECTED_OFFICE' },
  });
  const tenantId = tenant.id;
  const roleIds = await provisionSystemRoles(prisma, tenantId);

  /* ------------------------------- Geography -------------------------------- */
  // Geographic units belong to an election cycle in the current schema, so the
  // office tenant carries a reference-only cycle for its county/constituency/ward tree.
  let cycle = await prisma.electionCycle.findFirst({ where: { tenantId, name: GEOGRAPHY_CYCLE_NAME } });
  cycle ??= await prisma.electionCycle.create({
    data: {
      tenantId,
      name: GEOGRAPHY_CYCLE_NAME,
      electionDate: new Date('2027-08-10T00:00:00Z'),
      legalConfigVersion: 'office-geography-reference',
      status: 'ACTIVE',
      dataProvenance: 'SYNTHETIC',
      officialSources: [{ title: 'Constitution of Kenya, 2010 — First Schedule (counties)', reference: 'County code and name only; constituencies and wards are synthetic' }],
    },
  });
  const ensureUnit = async (type: 'COUNTY' | 'CONSTITUENCY' | 'WARD', code: string, name: string, parent: { id: string; path: string } | null) => {
    const found = await prisma.geographicUnit.findFirst({ where: { tenantId, electionCycleId: cycle.id, type, officialCode: code } });
    if (found) return { id: found.id, path: found.path };
    const id = randomUUID();
    const path = `${parent?.path ?? '/'}${id}/`;
    await prisma.geographicUnit.create({
      data: { id, tenantId, electionCycleId: cycle.id, type, officialCode: code, officialName: name, parentId: parent?.id ?? null, path, sourceVersion: SYNTHETIC_REGISTRY_VERSION },
    });
    return { id, path };
  };
  const county = await ensureUnit('COUNTY', BUNGOMA_CODE, 'Bungoma', null);
  const constituencies = new Map<string, { id: string; path: string }>();
  const wards: Array<{ id: string; constituencyId: string; name: string }> = [];
  const seenWards = new Set<string>();
  for (const r of syntheticBungomaRows()) {
    let k = constituencies.get(r.constituency_code);
    if (!k) {
      k = await ensureUnit('CONSTITUENCY', r.constituency_code, r.constituency_name, county);
      constituencies.set(r.constituency_code, k);
    }
    if (!seenWards.has(r.ward_code)) {
      seenWards.add(r.ward_code);
      const w = await ensureUnit('WARD', r.ward_code, r.ward_name, k);
      wards.push({ id: w.id, constituencyId: k.id, name: r.ward_name });
    }
  }
  const c1 = constituencies.get(SYNTHETIC_CONSTITUENCIES[0].code)!;
  const loc = (wardIndex: number) => {
    const w = wards[wardIndex % wards.length]!;
    return { geographicUnitId: w.id, countyId: county.id, constituencyId: w.constituencyId, wardId: w.id };
  };

  /* ---------------------------------- Users --------------------------------- */
  const demoUsers: Array<{ key: string; email: string; displayName: string; role: SystemRoleKey; scope?: { type: ScopeType; unitId: string } }> = [
    { key: 'owner', email: `owner@${DOMAIN}`, displayName: 'Odera Owner (synthetic)', role: 'ORGANISATION_OWNER' },
    { key: 'admin', email: `officeadmin@${DOMAIN}`, displayName: 'Achieng Office Administrator (synthetic)', role: 'OFFICE_ADMINISTRATOR' },
    { key: 'caseofficer', email: `caseofficer@${DOMAIN}`, displayName: 'Kamau Case Officer (synthetic)', role: 'CASE_OFFICER' },
    { key: 'caseofficerNorth', email: `caseofficer.north@${DOMAIN}`, displayName: 'Nafula Case Officer North (synthetic)', role: 'CASE_OFFICER', scope: { type: 'CONSTITUENCY', unitId: c1.id } },
    { key: 'clerk', email: `clerk@${DOMAIN}`, displayName: 'Chebet Correspondence Clerk (synthetic)', role: 'CORRESPONDENCE_CLERK' },
    { key: 'projects', email: `projects@${DOMAIN}`, displayName: 'Pendo Projects Officer (synthetic)', role: 'PROJECTS_OFFICER' },
    { key: 'publicinfo', email: `publicinfo@${DOMAIN}`, displayName: 'Imani Public-Information Editor (synthetic)', role: 'PUBLIC_INFORMATION_EDITOR' },
  ];
  const u: Record<string, string> = {};
  for (const d of demoUsers) {
    const user = await prisma.user.upsert({
      where: { tenantId_email: { tenantId, email: d.email } },
      create: { tenantId, email: d.email, displayName: d.displayName, passwordHash: opts.passwordHash, status: 'ACTIVE', passwordChangedAt: new Date() },
      update: { displayName: d.displayName, passwordHash: opts.passwordHash, status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
    });
    u[d.key] = user.id;
    await prisma.roleAssignment.deleteMany({ where: { userId: user.id } });
    await prisma.roleAssignment.create({
      data: {
        tenantId,
        userId: user.id,
        roleId: roleIds[d.role]!,
        scopeType: d.scope?.type ?? 'ORGANISATION',
        geographicUnitId: d.scope?.unitId ?? null,
        reason: 'Seed (synthetic office demo)',
      },
    });
    if (opts.mfaRoles.has(d.role)) await opts.applyDemoMfa(tenantId, user.id);
  }
  const owner = u.owner!, admin = u.admin!, caseofficer = u.caseofficer!;
  const clerk = u.clerk!, projectsOfficer = u.projects!, publicinfo = u.publicinfo!;

  // Non-login service account that owns public-portal uploads (OfficeModuleConfig.portalServiceUserId).
  const portalService = await prisma.user.upsert({
    where: { tenantId_email: { tenantId, email: `portal-service@${OFFICE_TENANT_SLUG}.invalid` } },
    create: { tenantId, email: `portal-service@${OFFICE_TENANT_SLUG}.invalid`, displayName: 'Public portal (system account)', status: 'DEACTIVATED', passwordHash: null },
    update: { status: 'DEACTIVATED', passwordHash: null },
  });

  /* ----------------------------- Module activation ---------------------------- */
  const officeConfig: OfficeModuleConfig = OfficeModuleConfigSchema.parse({
    publicPortalEnabled: true,
    publicProjectsEnabled: true,
    portalDisplayName: OFFICE_TENANT_NAME,
    controllerName: OFFICE_TENANT_NAME,
    dataProtectionContact: `dataprotection@${DOMAIN} (synthetic)`,
    caseRetentionMonths: 36,
    contactRetentionMonths: 12,
    caseCloseRequiresSecondPerson: true,
    portalCountyUnitId: county.id,
    portalServiceUserId: portalService.id,
  });
  await prisma.tenantModule.upsert({
    where: { tenantId_moduleKey: { tenantId, moduleKey: 'office' } },
    create: { tenantId, moduleKey: 'office', enabled: true, config: officeConfig, updatedById: owner },
    update: { enabled: true, config: officeConfig },
  });
  // The governor's office workspace runs Office only; tally stays in the campaign tenant (blueprint 15.2).
  await prisma.tenantModule.upsert({
    where: { tenantId_moduleKey: { tenantId, moduleKey: 'tally' } },
    create: { tenantId, moduleKey: 'tally', enabled: false, config: {}, updatedById: owner },
    update: { enabled: false },
  });

  /* ------------------------------- Institutions ------------------------------- */
  const institutionDefs: Array<{ key: string; name: string; shortName?: string; type: InstitutionType; mandate: string }> = [
    { key: 'water', name: 'County Department of Water, Environment and Natural Resources (synthetic)', shortName: 'Water Dept', type: 'COUNTY_DEPARTMENT', mandate: 'County water services, boreholes, water pans and environment.' },
    { key: 'roads', name: 'County Department of Roads, Public Works and Transport (synthetic)', shortName: 'Roads Dept', type: 'COUNTY_DEPARTMENT', mandate: 'County roads, public works inspection and transport.' },
    { key: 'health', name: 'County Department of Health and Sanitation (synthetic)', shortName: 'Health Dept', type: 'COUNTY_DEPARTMENT', mandate: 'County health facilities, primary health care and sanitation.' },
    { key: 'education', name: 'County Department of Education and Vocational Training (synthetic)', shortName: 'Education Dept', type: 'COUNTY_DEPARTMENT', mandate: 'Early childhood education, vocational training centres and county bursaries.' },
    { key: 'agriculture', name: 'County Department of Agriculture, Livestock and Fisheries (synthetic)', shortName: 'Agriculture Dept', type: 'COUNTY_DEPARTMENT', mandate: 'Extension services, livestock and fisheries.' },
    { key: 'trade', name: 'County Department of Trade, Energy and Industrialisation (synthetic)', shortName: 'Trade Dept', type: 'COUNTY_DEPARTMENT', mandate: 'Markets, trade licensing and county energy programmes.' },
    { key: 'youth', name: 'County Department of Gender, Culture, Youth and Sports (synthetic)', shortName: 'Youth Dept', type: 'COUNTY_DEPARTMENT', mandate: 'Sports facilities, youth and social programmes.' },
    { key: 'watercompany', name: 'County Water and Sanitation Company (synthetic)', shortName: 'Water Co.', type: 'COUNTY_ENTITY', mandate: 'Piped water supply and sewerage in urban areas.' },
    { key: 'assembly', name: 'County Assembly (synthetic)', type: 'COUNTY_ASSEMBLY', mandate: 'County legislation, budget approval and oversight.' },
    { key: 'nationalroads', name: 'National Rural Roads Agency (synthetic)', shortName: 'Rural Roads Agency', type: 'NATIONAL_AGENCY', mandate: 'National rural road network (not a county function).' },
    { key: 'electrification', name: 'National Rural Electrification Agency (synthetic)', shortName: 'Electrification Agency', type: 'NATIONAL_AGENCY', mandate: 'Rural electrification and last-mile connections.' },
    { key: 'police', name: 'National Police Service — County Command (synthetic)', shortName: 'Police County Command', type: 'NATIONAL_AGENCY', mandate: 'Security and policing (a national function).' },
    { key: 'moe', name: 'Ministry of Education — County Education Office (synthetic)', shortName: 'County Education Office', type: 'NATIONAL_MINISTRY', mandate: 'Primary and secondary schools (a national function).' },
    { key: 'land', name: 'National Land Commission — County Office (synthetic)', shortName: 'Land Commission Office', type: 'STATE_CORPORATION', mandate: 'Public land management and historical land injustices.' },
    { key: 'cdfNorth', name: 'Synthetic Constituency North NG-CDF Committee (synthetic)', shortName: 'North NG-CDF', type: 'CONSTITUENCY_FUND', mandate: 'Constituency development fund projects in Synthetic Constituency North.' },
    { key: 'cdfSouth', name: 'Synthetic Constituency South NG-CDF Committee (synthetic)', shortName: 'South NG-CDF', type: 'CONSTITUENCY_FUND', mandate: 'Constituency development fund projects in Synthetic Constituency South.' },
    { key: 'partner', name: 'Synthetic Water Partnership Programme (synthetic)', type: 'DEVELOPMENT_PARTNER', mandate: 'Co-financing of rural water projects.' },
    { key: 'contractor', name: 'Synthetic Builders Ltd (synthetic)', type: 'CONTRACTOR', mandate: 'Civil works contractor.' },
  ];
  const inst: Record<string, string> = {};
  for (const d of institutionDefs) {
    const row = await prisma.institution.upsert({
      where: { tenantId_name: { tenantId, name: d.name } },
      create: {
        tenantId,
        name: d.name,
        shortName: d.shortName ?? null,
        type: d.type,
        mandate: d.mandate,
        contactEmail: `${d.key.toLowerCase()}@institutions.example.org`,
        physicalAddress: 'Synthetic address, Bungoma',
      },
      update: { shortName: d.shortName ?? null, type: d.type, mandate: d.mandate },
    });
    inst[d.key] = row.id;
  }

  /* ---------------------------------- Cases ---------------------------------- */
  interface CaseDef {
    category: CaseCategory;
    title: string;
    description: string;
    status: CaseStatus;
    source: 'PORTAL' | 'WALK_IN' | 'PHONE' | 'LETTER' | 'EMAIL' | 'SMS' | 'OUTREACH';
    priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
    ward: number;
    age: number;
    contact?: { name?: string; phone?: string; email?: string; preference: 'PHONE' | 'SMS' | 'EMAIL' };
    referTo?: string;
    closure?: 'RESOLVED' | 'REFERRED_OUT' | 'DUPLICATE' | 'OUT_OF_JURISDICTION' | 'NO_RESPONSE_FROM_REQUESTER' | 'WITHDRAWN' | 'ABUSIVE_OR_SPAM';
    assignee?: 'caseofficer' | 'caseofficerNorth';
  }
  const caseDefs: CaseDef[] = [
    { category: 'WATER_SANITATION', title: 'Market borehole not working', description: 'The hand pump borehole at the ward market has not produced water for two weeks. Traders fetch water from the river.', status: 'SUBMITTED', source: 'PORTAL', ward: 0, age: 1, contact: { name: 'Synthetic Resident A', phone: '0700 000 001', preference: 'SMS' } },
    { category: 'ROADS_TRANSPORT', title: 'Culvert blocked on feeder road', description: 'A culvert on the feeder road to the primary school is blocked and the road floods after rain.', status: 'SUBMITTED', source: 'PORTAL', ward: 6, age: 2 },
    { category: 'HEALTH', title: 'Dispensary out of basic medicines', description: 'Patients at the ward dispensary are told to buy basic medicines elsewhere. Request a stock check.', status: 'SUBMITTED', source: 'SMS', ward: 11, age: 1, contact: { phone: '0700 000 003', preference: 'SMS' } },
    { category: 'EDUCATION_BURSARY', title: 'Bursary application status', description: 'Applied for the county bursary for a vocational training course and have not heard back.', status: 'TRIAGE', source: 'WALK_IN', ward: 2, age: 4, contact: { name: 'Synthetic Resident D', phone: '0700 000 004', preference: 'PHONE' } },
    { category: 'AGRICULTURE_LIVESTOCK', title: 'Request for extension officer visit', description: 'Farmers group requests an extension officer visit about maize disease in the area.', status: 'TRIAGE', source: 'PORTAL', ward: 15, age: 3 },
    { category: 'SECURITY_REFERRAL', title: 'Repeated livestock theft', description: 'Several households report livestock theft at night over the last month.', status: 'TRIAGE', source: 'PHONE', ward: 20, age: 2, priority: 'HIGH' },
    { category: 'WATER_SANITATION', title: 'Burst pipe near health centre', description: 'Burst water pipe outside the health centre has been leaking for a week.', status: 'ASSIGNED', source: 'PORTAL', ward: 1, age: 6, assignee: 'caseofficerNorth', contact: { email: 'resident.g@public.example.org', preference: 'EMAIL' } },
    { category: 'TRADE_MARKETS', title: 'Market shed roof leaking', description: 'The roof of the county market shed leaks onto traders’ stalls when it rains.', status: 'ASSIGNED', source: 'LETTER', ward: 25, age: 7, assignee: 'caseofficer' },
    { category: 'ENVIRONMENT_WASTE', title: 'Uncollected refuse at bus stage', description: 'Refuse has not been collected at the bus stage for three weeks.', status: 'IN_PROGRESS', source: 'PORTAL', ward: 3, age: 10, assignee: 'caseofficerNorth' },
    { category: 'ROADS_TRANSPORT', title: 'Bridge approach eroded', description: 'The approach to the footbridge has eroded and pupils cross with difficulty.', status: 'IN_PROGRESS', source: 'OUTREACH', ward: 30, age: 12, assignee: 'caseofficer', priority: 'HIGH' },
    { category: 'SOCIAL_SUPPORT', title: 'Support for elderly resident', description: 'Neighbours request a welfare check and support for an elderly resident living alone.', status: 'IN_PROGRESS', source: 'WALK_IN', ward: 8, age: 9, assignee: 'caseofficer', contact: { name: 'Synthetic Neighbour K', phone: '0700 000 011', preference: 'PHONE' } },
    { category: 'ROADS_TRANSPORT', title: 'Potholes on rural access road', description: 'Large potholes on the rural access road to the sub-county offices.', status: 'REFERRED', source: 'PORTAL', ward: 33, age: 15, assignee: 'caseofficer', referTo: 'nationalroads' },
    { category: 'EDUCATION_BURSARY', title: 'Classroom roof blown off at primary school', description: 'Strong winds blew off part of a classroom roof at the primary school.', status: 'REFERRED', source: 'LETTER', ward: 4, age: 14, assignee: 'caseofficerNorth', referTo: 'moe' },
    { category: 'LAND_HOUSING', title: 'Encroachment on public land', description: 'A plot reserved for a public facility is being fenced by unknown persons.', status: 'REFERRED', source: 'WALK_IN', ward: 38, age: 20, assignee: 'caseofficer', referTo: 'land', priority: 'HIGH' },
    { category: 'WATER_SANITATION', title: 'Low water pressure in estate', description: 'Taps in the estate run dry most afternoons.', status: 'RESOLUTION_PROPOSED', source: 'PORTAL', ward: 5, age: 18, assignee: 'caseofficerNorth', contact: { phone: '0700 000 015', preference: 'SMS' } },
    { category: 'HEALTH', title: 'Maternity wing lights not working', description: 'Lights in the maternity wing of the health centre have not worked for a month.', status: 'RESOLUTION_PROPOSED', source: 'PHONE', ward: 13, age: 21, assignee: 'caseofficer' },
    { category: 'TRADE_MARKETS', title: 'Market toilets locked', description: 'The public toilets at the market are kept locked during market days.', status: 'CITIZEN_FEEDBACK', source: 'PORTAL', ward: 22, age: 25, assignee: 'caseofficer', contact: { name: 'Synthetic Trader Q', phone: '0700 000 017', preference: 'SMS' } },
    { category: 'AGRICULTURE_LIVESTOCK', title: 'Cattle dip not operational', description: 'The community cattle dip has had no acaricide for two months.', status: 'CITIZEN_FEEDBACK', source: 'OUTREACH', ward: 27, age: 28, assignee: 'caseofficer' },
    { category: 'WATER_SANITATION', title: 'Spring protection request', description: 'Community asks for the spring to be protected from contamination.', status: 'CLOSED', closure: 'RESOLVED', source: 'PORTAL', ward: 7, age: 45, assignee: 'caseofficerNorth' },
    { category: 'ROADS_TRANSPORT', title: 'Streetlight out at junction', description: 'The streetlight at the main junction has been off for weeks.', status: 'CLOSED', closure: 'RESOLVED', source: 'SMS', ward: 16, age: 40, assignee: 'caseofficer', contact: { phone: '0700 000 020', preference: 'SMS' } },
    { category: 'PUBLIC_SERVICE_COMPLAINT', title: 'Delay at county licensing desk', description: 'Long delays when applying for a single business permit at the county licensing desk.', status: 'CLOSED', closure: 'RESOLVED', source: 'EMAIL', ward: 23, age: 50, assignee: 'caseofficer' },
    { category: 'SECURITY_REFERRAL', title: 'Request for police patrols', description: 'Residents request regular night patrols near the shopping centre.', status: 'CLOSED', closure: 'REFERRED_OUT', source: 'WALK_IN', ward: 35, age: 60, assignee: 'caseofficer', referTo: 'police' },
    { category: 'WATER_SANITATION', title: 'Market borehole (second report)', description: 'Second report about the market borehole hand pump.', status: 'CLOSED', closure: 'DUPLICATE', source: 'PORTAL', ward: 0, age: 1 },
    { category: 'OTHER', title: 'Request outside county mandate', description: 'Request concerning a private family dispute.', status: 'CLOSED', closure: 'OUT_OF_JURISDICTION', source: 'PORTAL', ward: 41, age: 30 },
    { category: 'HEALTH', title: 'Ambulance response time (reopened)', description: 'Ambulance took several hours to reach the village; earlier response was not satisfactory.', status: 'REOPENED', source: 'PHONE', ward: 18, age: 35, assignee: 'caseofficer', priority: 'URGENT', contact: { name: 'Synthetic Resident Y', phone: '0700 000 025', preference: 'PHONE' } },
  ];

  const officerName = (k?: string) => (k ? u[k]! : null);
  let casesCreated = 0;
  const caseIds: string[] = [];
  for (const [i, d] of caseDefs.entries()) {
    const reference = ref('CASE', i + 1);
    const existing = await prisma.citizenCase.findUnique({ where: { tenantId_reference: { tenantId, reference } } });
    if (existing) {
      caseIds.push(existing.id);
      continue;
    }
    const pub = seedPublicReference(i + 1);
    const submittedAt = daysAgo(d.age);
    const assigneeId = officerName(d.assignee);
    const pastTriage = !['SUBMITTED', 'TRIAGE'].includes(d.status) || (d.status === 'CLOSED' && !!assigneeId);
    const resolutionStatuses: CaseStatus[] = ['RESOLUTION_PROPOSED', 'CITIZEN_FEEDBACK'];
    const proposed = resolutionStatuses.includes(d.status) || (d.status === 'CLOSED' && d.closure === 'RESOLVED') || d.status === 'REOPENED';
    const closed = d.status === 'CLOSED';
    const resolverId = assigneeId ?? caseofficer;
    const row = await prisma.citizenCase.create({
      data: {
        tenantId,
        reference,
        publicReference: pub.publicReference,
        trackingCodeHash: d.source === 'PORTAL' ? pub.trackingCodeHash : null,
        source: d.source,
        category: d.category,
        priority: d.priority ?? 'MEDIUM',
        title: d.title,
        description: `${d.description} (Synthetic demo request.)`,
        ...loc(d.ward),
        locationDescription: 'Synthetic landmark',
        privacyNoticeVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
        consentToContact: !!d.contact,
        status: d.status,
        assigneeId,
        triagedById: pastTriage ? admin : null,
        triagedAt: pastTriage ? daysAgo(d.age - 0.5) : null,
        // Older open cases are past their review date so the review-due view has content.
        nextReviewDate: closed ? null : dateOnly(d.age > 20 ? 1 : d.age > 10 ? -2 : -7),
        resolutionSummary: proposed ? 'The responsible department reports the repair is complete; a site visit confirmed water is flowing. (Synthetic)' : null,
        resolutionProposedById: proposed ? resolverId : null,
        resolutionProposedAt: proposed ? daysAgo(Math.max(d.age - 5, 0.2)) : null,
        closureReason: closed ? d.closure! : null,
        closureNote: closed ? 'Closed after review (synthetic demo).' : null,
        // Closed by the office administrator, a different person from the resolver (caseCloseRequiresSecondPerson).
        closedById: closed ? admin : null,
        closedAt: closed ? daysAgo(Math.max(d.age - 8, 0.1)) : null,
        duplicateOfId: d.closure === 'DUPLICATE' ? caseIds[0] ?? null : null,
        createdById: d.source === 'PORTAL' ? null : caseofficer,
        submittedAt,
        createdAt: submittedAt,
      },
    });
    caseIds.push(row.id);
    casesCreated++;
    if (d.contact) {
      await prisma.citizenCaseContact.create({
        data: {
          tenantId,
          caseId: row.id,
          name: d.contact.name ?? null,
          phone: d.contact.phone ?? null,
          email: d.contact.email ?? null,
          preference: d.contact.preference,
          retentionUntil: closed ? new Date(Date.UTC(2027, 10, 20)) : null,
        },
      });
    }

    // Timeline (append-only), oldest first.
    const ev = (type: CaseEventType, at: Date, extra: Record<string, unknown> = {}) =>
      prisma.caseEvent.create({
        data: { tenantId, caseId: row.id, type, visibility: 'INTERNAL', actorType: 'STAFF', actorId: admin, createdAt: at, ...extra },
      });
    await ev('SUBMITTED', submittedAt, {
      visibility: 'PUBLIC',
      actorType: d.source === 'PORTAL' ? 'REQUESTER' : 'STAFF',
      actorId: d.source === 'PORTAL' ? null : caseofficer,
      body: 'Request received.',
      toStatus: 'SUBMITTED',
    });
    if (d.status === 'SUBMITTED') continue;
    await ev('STATUS_CHANGED', daysAgo(d.age - 0.4), { fromStatus: 'SUBMITTED', toStatus: 'TRIAGE', body: 'Checked category, jurisdiction and duplicates.' });
    if (d.status === 'TRIAGE') continue;
    if (closed && !assigneeId) {
      await ev('CLOSED', daysAgo(Math.max(d.age - 0.8, 0.1)), { fromStatus: 'TRIAGE', toStatus: 'CLOSED', visibility: 'PUBLIC', body: d.closure === 'DUPLICATE' ? 'This request duplicates an earlier one, which is being handled.' : 'This matter is outside the mandate of this office.' });
      continue;
    }
    await ev('ASSIGNED', daysAgo(d.age - 0.5), { fromStatus: 'TRIAGE', toStatus: 'ASSIGNED', body: 'Assigned to a case officer.' });
    await ev('PUBLIC_UPDATE', daysAgo(d.age - 0.6), { visibility: 'PUBLIC', body: 'Your request has been assigned to an officer.' });
    if (d.status === 'ASSIGNED') continue;
    await ev('STATUS_CHANGED', daysAgo(d.age - 1), { actorId: resolverId, fromStatus: 'ASSIGNED', toStatus: 'IN_PROGRESS' });
    await ev('NOTE', daysAgo(d.age - 1.2), { actorId: resolverId, body: 'Called the ward administrator to confirm the location (synthetic internal note).' });
    if (d.referTo) {
      const referral = await prisma.caseReferral.create({
        data: {
          tenantId,
          caseId: row.id,
          institutionId: inst[d.referTo]!,
          referredAt: dateOnly(d.age - 2),
          contactPerson: 'Duty officer (synthetic)',
          contactDetail: 'Office line (synthetic)',
          followUpDate: dateOnly(d.age - 9),
          status: closed ? 'RESPONDED' : 'SENT',
          responseSummary: closed ? 'The institution confirmed it has taken up the matter (synthetic).' : null,
          requesterContactShared: false,
          referredById: resolverId,
        },
      });
      await ev('REFERRED', daysAgo(d.age - 2), { actorId: resolverId, fromStatus: 'IN_PROGRESS', toStatus: 'REFERRED', referralId: referral.id, body: 'Referred with the case summary; requester contact not shared.' });
      await ev('PUBLIC_UPDATE', daysAgo(d.age - 2), { actorId: resolverId, visibility: 'PUBLIC', body: 'Your request has been referred to the institution responsible for this matter.' });
    }
    if (d.status === 'IN_PROGRESS' || d.status === 'REFERRED') continue;
    if (proposed) {
      await ev('RESOLUTION_PROPOSED', daysAgo(Math.max(d.age - 5, 0.2)), { actorId: resolverId, visibility: 'PUBLIC', fromStatus: d.referTo ? 'REFERRED' : 'IN_PROGRESS', toStatus: 'RESOLUTION_PROPOSED', body: 'The responsible department reports the repair is complete. Please let us know if the problem continues.' });
    }
    if (d.status === 'CITIZEN_FEEDBACK') {
      await ev('STATUS_CHANGED', daysAgo(Math.max(d.age - 6, 0.2)), { actorId: resolverId, fromStatus: 'RESOLUTION_PROPOSED', toStatus: 'CITIZEN_FEEDBACK', body: 'Awaiting requester feedback.' });
    }
    if (closed) {
      await ev('CLOSED', daysAgo(Math.max(d.age - 8, 0.1)), { fromStatus: proposed ? 'RESOLUTION_PROPOSED' : 'REFERRED', toStatus: 'CLOSED', visibility: 'PUBLIC', body: 'Your request has been closed. Thank you for reporting it.' });
    }
    if (d.status === 'REOPENED') {
      await ev('CLOSED', daysAgo(d.age - 10), { fromStatus: 'RESOLUTION_PROPOSED', toStatus: 'CLOSED', visibility: 'PUBLIC', body: 'Your request has been closed.' });
      await ev('CITIZEN_FEEDBACK', daysAgo(d.age - 12), { actorType: 'REQUESTER', actorId: null, visibility: 'PUBLIC', body: 'The problem continues: response times are still very long. (Synthetic)' });
      await ev('REOPENED', daysAgo(d.age - 12.1), { fromStatus: 'CLOSED', toStatus: 'REOPENED', visibility: 'PUBLIC', body: 'Your request has been reopened for further review.' });
    }
  }

  /* ------------------------------ Correspondence ------------------------------ */
  type CorrDef = {
    direction: 'INCOMING' | 'OUTGOING';
    channel: 'POST' | 'HAND_DELIVERY' | 'EMAIL' | 'COURIER' | 'INTERNAL_MEMO' | 'OTHER';
    category: CorrespondenceCategory;
    sensitivity?: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'HIGHLY_RESTRICTED';
    subject: string;
    party: string;
    org?: string;
    status: CorrespondenceStatus;
    age: number;
    due?: number;
    assignee?: 'clerk' | 'admin';
    caseIndex?: number;
  };
  const corrDefs: CorrDef[] = [
    { direction: 'INCOMING', channel: 'POST', category: 'INVITATION', subject: 'Invitation to a county agricultural show (synthetic)', party: 'Show Committee Secretary', org: 'Synthetic Agricultural Society', status: 'RECEIVED', age: 1, due: -6 },
    { direction: 'INCOMING', channel: 'EMAIL', category: 'GOVERNMENT_CIRCULAR', subject: 'Circular on county budget calendar (synthetic)', party: 'Principal Secretary', org: 'Synthetic National Treasury Department', status: 'ASSIGNED', age: 3, due: -4, assignee: 'admin' },
    { direction: 'INCOMING', channel: 'HAND_DELIVERY', category: 'PETITION', subject: 'Petition on market toilets (synthetic)', party: 'Market Traders Association', org: 'Synthetic Traders Association', status: 'IN_PROGRESS', age: 9, due: 2, assignee: 'clerk', caseIndex: 16 },
    { direction: 'INCOMING', channel: 'POST', category: 'REQUEST_FOR_SUPPORT', subject: 'Request for support for a youth football tournament (synthetic)', party: 'Youth Group Chairperson', org: 'Synthetic Youth Sports Club', status: 'IN_PROGRESS', age: 12, due: -1, assignee: 'clerk' },
    { direction: 'INCOMING', channel: 'EMAIL', category: 'INTERGOVERNMENTAL', subject: 'Request for data on county health facilities (synthetic)', party: 'Director', org: 'Synthetic National Health Agency', status: 'RESPONDED', age: 20, due: 10, assignee: 'admin' },
    { direction: 'INCOMING', channel: 'COURIER', category: 'LEGAL', sensitivity: 'CONFIDENTIAL', subject: 'Notice of intention to sue (synthetic)', party: 'Advocate', org: 'Synthetic & Co. Advocates', status: 'ASSIGNED', age: 5, due: -9, assignee: 'admin' },
    { direction: 'INCOMING', channel: 'POST', category: 'COMPLAINT', subject: 'Complaint about road works dust (synthetic)', party: 'Synthetic Resident Z', status: 'FILED', age: 30, assignee: 'clerk' },
    { direction: 'INCOMING', channel: 'EMAIL', category: 'MEDIA', subject: 'Interview request on water projects (synthetic)', party: 'Producer', org: 'Synthetic Community Radio', status: 'RECEIVED', age: 0.5, due: -2 },
    { direction: 'INCOMING', channel: 'INTERNAL_MEMO', category: 'FINANCE', sensitivity: 'CONFIDENTIAL', subject: 'Quarterly expenditure report for the office (synthetic)', party: 'Chief Officer, Finance', org: 'County Treasury (synthetic)', status: 'FILED', age: 25, assignee: 'admin' },
    { direction: 'INCOMING', channel: 'POST', category: 'GENERAL', subject: 'Letter of appreciation from a school (synthetic)', party: 'Head Teacher', org: 'Synthetic Primary School', status: 'ARCHIVED', age: 90, assignee: 'clerk' },
    { direction: 'OUTGOING', channel: 'POST', category: 'INVITATION', subject: 'Acceptance of invitation to agricultural show (synthetic)', party: 'Show Committee Secretary', org: 'Synthetic Agricultural Society', status: 'DRAFT', age: 0.3 },
    { direction: 'OUTGOING', channel: 'EMAIL', category: 'INTERGOVERNMENTAL', subject: 'Response: county health facility data (synthetic)', party: 'Director', org: 'Synthetic National Health Agency', status: 'SENT', age: 12 },
    { direction: 'OUTGOING', channel: 'HAND_DELIVERY', category: 'PETITION', subject: 'Acknowledgement of traders’ petition (synthetic)', party: 'Market Traders Association', org: 'Synthetic Traders Association', status: 'SENT', age: 8, caseIndex: 16 },
    { direction: 'OUTGOING', channel: 'POST', category: 'REQUEST_FOR_SUPPORT', subject: 'Referral letter: classroom roof repair (synthetic)', party: 'County Director of Education', org: 'Ministry of Education — County Education Office (synthetic)', status: 'FILED', age: 13, caseIndex: 12 },
    { direction: 'OUTGOING', channel: 'EMAIL', category: 'GENERAL', subject: 'Thank-you letter to a community group (synthetic)', party: 'Chairperson', org: 'Synthetic Women’s Group', status: 'ARCHIVED', age: 70 },
  ];
  let inCount = 0, outCount = 0;
  for (const d of corrDefs) {
    const n = d.direction === 'INCOMING' ? ++inCount : ++outCount;
    const reference = ref(d.direction === 'INCOMING' ? 'COR-IN' : 'COR-OUT', n);
    if (await prisma.correspondence.findUnique({ where: { tenantId_reference: { tenantId, reference } } })) continue;
    const incoming = d.direction === 'INCOMING';
    await prisma.correspondence.create({
      data: {
        tenantId,
        reference,
        direction: d.direction,
        channel: d.channel,
        category: d.category,
        sensitivity: d.sensitivity ?? 'INTERNAL',
        subject: d.subject,
        senderName: incoming ? d.party : 'Office of the Governor (synthetic)',
        senderOrganisation: incoming ? d.org ?? null : null,
        recipientName: incoming ? null : d.party,
        recipientOrganisation: incoming ? null : d.org ?? null,
        externalReference: incoming ? `EXT/${SEED_YEAR}/${100 + n}` : null,
        documentDate: dateOnly(d.age + 1),
        receivedAt: incoming ? daysAgo(d.age) : null,
        sentAt: !incoming && d.status !== 'DRAFT' ? daysAgo(d.age) : null,
        responseDueDate: d.due !== undefined ? dateOnly(d.due) : null,
        status: d.status,
        assignedToId: d.assignee ? u[d.assignee]! : null,
        summary: 'Synthetic demo correspondence.',
        linkedCaseId: d.caseIndex !== undefined ? caseIds[d.caseIndex] ?? null : null,
        createdById: clerk,
        createdAt: daysAgo(d.age),
      },
    });
  }

  /* ------------------------------- Appointments ------------------------------- */
  type AptDef = { name: string; org?: string; purpose: string; status: AppointmentStatus; preferred: number; confirmed?: number; office: string; outcome?: string; followUp?: boolean; source: 'WALK_IN' | 'PHONE' | 'EMAIL' | 'LETTER' | 'REFERRAL' | 'OTHER' };
  const aptDefs: AptDef[] = [
    { name: 'Synthetic Visitor 1', org: 'Synthetic Farmers Cooperative', purpose: 'Discuss extension services for maize farmers', status: 'REQUESTED', preferred: -5, office: "Governor's office", source: 'LETTER' },
    { name: 'Synthetic Visitor 2', purpose: 'Follow up on a bursary application', status: 'REQUESTED', preferred: -3, office: 'County Secretary', source: 'PHONE' },
    { name: 'Synthetic Visitor 3', org: 'Synthetic Youth Sports Club', purpose: 'Present a proposal for a youth football tournament', status: 'CONFIRMED', preferred: -4, confirmed: -4, office: "Deputy Governor's office", source: 'WALK_IN' },
    { name: 'Synthetic Visitor 4', org: 'Synthetic Traders Association', purpose: 'Discuss the market toilets petition', status: 'CONFIRMED', preferred: -2, confirmed: -2, office: "Governor's office", source: 'LETTER' },
    { name: 'Synthetic Visitor 5', org: 'Synthetic Women’s Group', purpose: 'Courtesy call', status: 'RESCHEDULED', preferred: -1, confirmed: -6, office: "Governor's office", source: 'EMAIL' },
    { name: 'Synthetic Visitor 6', purpose: 'Land boundary concern', status: 'DECLINED', preferred: 3, office: 'County Secretary', source: 'WALK_IN' },
    { name: 'Synthetic Visitor 7', org: 'Synthetic Community Radio', purpose: 'Interview on water projects', status: 'CANCELLED', preferred: 2, office: 'Communications office', source: 'EMAIL' },
    { name: 'Synthetic Visitor 8', org: 'Synthetic Primary School', purpose: 'Request support for classroom repairs', status: 'COMPLETED', preferred: 10, confirmed: 9, office: "Deputy Governor's office", outcome: 'Advised that classroom repairs are a national function; office referred the matter to the County Education Office.', followUp: true, source: 'REFERRAL' },
    { name: 'Synthetic Visitor 9', org: 'Synthetic Health Workers Association', purpose: 'Staffing at the sub-county hospital', status: 'COMPLETED', preferred: 15, confirmed: 14, office: "Governor's office", outcome: 'Concerns noted and forwarded to the County Department of Health.', source: 'LETTER' },
    { name: 'Synthetic Visitor 10', purpose: 'Business permit delays', status: 'NO_SHOW', preferred: 6, confirmed: 6, office: 'County Secretary', source: 'PHONE' },
  ];
  for (const [i, d] of aptDefs.entries()) {
    const reference = ref('APT', i + 1);
    if (await prisma.appointment.findUnique({ where: { tenantId_reference: { tenantId, reference } } })) continue;
    await prisma.appointment.create({
      data: {
        tenantId,
        reference,
        source: d.source,
        requesterName: d.name,
        requesterOrganisation: d.org ?? null,
        contactPhone: `0700 100 ${String(i + 1).padStart(3, '0')}`,
        contactPreference: 'PHONE',
        purpose: d.purpose,
        preferredStart: daysAgo(d.preferred),
        confirmedStart: d.confirmed !== undefined ? daysAgo(d.confirmed) : null,
        confirmedEnd: d.confirmed !== undefined ? new Date(daysAgo(d.confirmed).getTime() + 30 * 60_000) : null,
        venue: d.confirmed !== undefined ? 'Governor’s office boardroom (synthetic)' : null,
        assignedOffice: d.office,
        assignedToId: clerk,
        status: d.status,
        outcome: d.outcome ?? null,
        outcomeRecordedAt: d.outcome ? daysAgo(d.confirmed ?? 0) : null,
        followUpRequired: !!d.followUp,
        followUpDate: d.followUp ? dateOnly(-7) : null,
        followUpNotes: d.followUp ? 'Check that the County Education Office acknowledged the referral.' : null,
        privacyNoticeVersion: CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION,
        linkedCaseId: i === 7 ? caseIds[12] ?? null : null,
        createdById: clerk,
      },
    });
  }

  /* --------------------------------- Meetings --------------------------------- */
  const meetingTitle = 'Weekly office coordination meeting (synthetic)';
  if (!(await prisma.meeting.findFirst({ where: { tenantId, title: meetingTitle } }))) {
    const m = await prisma.meeting.create({
      data: {
        tenantId,
        title: meetingTitle,
        scheduledStart: daysAgo(3),
        scheduledEnd: new Date(daysAgo(3).getTime() + 90 * 60_000),
        venue: 'Boardroom (synthetic)',
        status: 'HELD',
        agenda: [{ title: 'Open citizen cases past review date' }, { title: 'Correspondence due this week' }, { title: 'Project verification visits' }],
        participants: [
          { name: 'Achieng Office Administrator (synthetic)', userId: admin, role: 'Chair', attendance: 'PRESENT' },
          { name: 'Kamau Case Officer (synthetic)', userId: caseofficer, attendance: 'PRESENT' },
          { name: 'Pendo Projects Officer (synthetic)', userId: projectsOfficer, attendance: 'APOLOGY' },
        ],
        minutes: 'Synthetic minutes: reviewed overdue cases; agreed inspection visits for two water projects before any completion is published.',
        minutesRecordedById: admin,
        minutesRecordedAt: daysAgo(2.9),
        ownerId: admin,
      },
    });
    await prisma.meetingActionItem.createMany({
      data: [
        { tenantId, meetingId: m.id, description: 'Follow up referral on classroom roof with County Education Office', ownerId: caseofficer, dueDate: dateOnly(-2), status: 'OPEN' },
        { tenantId, meetingId: m.id, description: 'Arrange inspection of the completed water pan before verification', ownerId: projectsOfficer, dueDate: dateOnly(-5), status: 'OPEN' },
        { tenantId, meetingId: m.id, description: 'Reply to the budget calendar circular', ownerId: admin, dueDate: dateOnly(1), status: 'DONE', completedAt: daysAgo(1) },
      ],
    });
    await prisma.meetingDecision.create({
      data: { tenantId, meetingId: m.id, decision: 'No project is shown as complete on the portal until an inspection report is verified.', rationale: 'Blueprint 9.3: a photograph alone is not proof of completion.', recordedById: admin, recordedAt: daysAgo(2.9) },
    });
    await prisma.meeting.create({
      data: {
        tenantId,
        title: 'Briefing with County Department of Water (synthetic)',
        scheduledStart: daysAgo(-4),
        venue: 'Water department offices (synthetic)',
        status: 'SCHEDULED',
        agenda: [{ title: 'Status of rural water projects' }],
        participants: [{ name: 'Achieng Office Administrator (synthetic)', userId: admin, attendance: 'INVITED' }],
        ownerId: admin,
      },
    });
  }

  /* --------------------------------- Projects --------------------------------- */
  interface ProjectDef {
    name: string;
    category: ProjectCategory;
    status: ProjectStatus;
    responsible: string;
    implementing?: string;
    commitment: CommitmentSource;
    commitmentDetail: string;
    funding: FundingSource;
    allocation?: string;
    contract?: string;
    contractPublic?: boolean;
    expenditure?: string;
    expenditureVerified?: 'VERIFIED' | 'DISPUTED' | 'PENDING_VERIFICATION';
    ward: number;
    milestones: Array<[title: string, status: 'PLANNED' | 'IN_PROGRESS' | 'DONE' | 'DELAYED' | 'CANCELLED', verification?: 'VERIFIED' | 'DISPUTED']>;
    evidence?: Array<[type: 'PHOTO' | 'INSPECTION_REPORT' | 'COMPLETION_CERTIFICATE' | 'PAYMENT_RECORD' | 'CONTRACT_DOCUMENT', verification?: 'VERIFIED' | 'DISPUTED']>;
    publish?: string[];
    delayReason?: string;
  }
  const projectDefs: ProjectDef[] = [
    { name: 'Ward market borehole rehabilitation (synthetic)', category: 'WATER_SANITATION', status: 'VERIFIED_COMPLETED', responsible: 'water', implementing: 'contractor', commitment: 'ANNUAL_DEVELOPMENT_PLAN', commitmentDetail: 'Annual Development Plan 2025/26, water programme (synthetic reference)', funding: 'COUNTY_GOVERNMENT', allocation: '2500000.00', contract: '2350000.00', contractPublic: true, expenditure: '2310000.00', expenditureVerified: 'VERIFIED', ward: 0, milestones: [['Site survey', 'DONE', 'VERIFIED'], ['Drilling and casing', 'DONE', 'VERIFIED'], ['Pump installation and handover', 'DONE', 'VERIFIED']], evidence: [['PHOTO', 'VERIFIED'], ['INSPECTION_REPORT', 'VERIFIED'], ['COMPLETION_CERTIFICATE', 'VERIFIED']], publish: ['description', 'implementingAgency', 'fundingSource', 'approvedAllocation', 'contractAmount', 'expenditure', 'schedule', 'milestones', 'evidence'] },
    { name: 'Community water pan (synthetic)', category: 'WATER_SANITATION', status: 'COMPLETED', responsible: 'water', implementing: 'partner', commitment: 'DEVELOPMENT_PARTNER_AGREEMENT', commitmentDetail: 'Synthetic co-financing agreement', funding: 'DEVELOPMENT_PARTNER', allocation: '4000000.00', expenditure: '3800000.00', expenditureVerified: 'PENDING_VERIFICATION', ward: 7, milestones: [['Excavation', 'DONE', 'VERIFIED'], ['Lining and fencing', 'DONE']], evidence: [['PHOTO']], publish: ['description', 'fundingSource', 'schedule', 'milestones'] },
    { name: 'Health centre maternity wing (synthetic)', category: 'HEALTH', status: 'ONGOING', responsible: 'health', implementing: 'contractor', commitment: 'COUNTY_INTEGRATED_DEVELOPMENT_PLAN', commitmentDetail: 'CIDP 2023–2027, health infrastructure (synthetic reference)', funding: 'COUNTY_GOVERNMENT', allocation: '12000000.00', contract: '11500000.00', contractPublic: false, expenditure: '5200000.00', expenditureVerified: 'VERIFIED', ward: 13, milestones: [['Foundation', 'DONE', 'VERIFIED'], ['Walling', 'DONE'], ['Roofing', 'IN_PROGRESS'], ['Fit-out', 'PLANNED']], evidence: [['PHOTO', 'VERIFIED'], ['PAYMENT_RECORD', 'VERIFIED']], publish: ['description', 'implementingAgency', 'fundingSource', 'approvedAllocation', 'expenditure', 'schedule', 'milestones'] },
    { name: 'Feeder road grading, ward access roads (synthetic)', category: 'ROADS_INFRASTRUCTURE', status: 'ONGOING', responsible: 'roads', commitment: 'COUNTY_BUDGET', commitmentDetail: 'County budget 2025/26, roads vote (synthetic)', funding: 'COUNTY_GOVERNMENT', allocation: '6000000.00', expenditure: '1500000.00', ward: 30, milestones: [['Grading section 1', 'DONE'], ['Grading section 2', 'IN_PROGRESS'], ['Culverts', 'PLANNED']], evidence: [['PHOTO']] },
    { name: 'Rural access road upgrade (national agency) (synthetic)', category: 'ROADS_INFRASTRUCTURE', status: 'DELAYED', responsible: 'nationalroads', commitment: 'NATIONAL_BUDGET', commitmentDetail: 'National rural roads programme (synthetic reference)', funding: 'NATIONAL_GOVERNMENT', ward: 33, delayReason: 'Contract re-tendered by the national agency (synthetic).', milestones: [['Design', 'DONE'], ['Works', 'DELAYED']], publish: ['description', 'fundingSource', 'schedule'] },
    { name: 'Vocational training centre workshop (synthetic)', category: 'EDUCATION', status: 'PROCUREMENT', responsible: 'education', commitment: 'ANNUAL_DEVELOPMENT_PLAN', commitmentDetail: 'Annual Development Plan 2025/26 (synthetic reference)', funding: 'COUNTY_GOVERNMENT', allocation: '3500000.00', ward: 2, milestones: [['Tender advertised', 'DONE'], ['Contract award', 'IN_PROGRESS']] },
    { name: 'County market shed renovation (synthetic)', category: 'TRADE_MARKETS', status: 'FUNDED', responsible: 'trade', commitment: 'COUNTY_BUDGET', commitmentDetail: 'Supplementary budget (synthetic reference)', funding: 'COUNTY_GOVERNMENT', allocation: '1800000.00', ward: 25, milestones: [['Bill of quantities', 'PLANNED']] },
    { name: 'Ward sports ground levelling (synthetic)', category: 'YOUTH_SPORTS', status: 'APPROVED', responsible: 'youth', commitment: 'COUNTY_INTEGRATED_DEVELOPMENT_PLAN', commitmentDetail: 'CIDP 2023–2027 (synthetic reference)', funding: 'NOT_YET_IDENTIFIED', ward: 20, milestones: [] , publish: ['description'] },
    { name: 'Every ward a modern dairy cooler (pledge) (synthetic)', category: 'AGRICULTURE', status: 'COMMITTED', responsible: 'agriculture', commitment: 'MANIFESTO_PLEDGE', commitmentDetail: 'Campaign manifesto pledge (synthetic); not yet in an approved plan or budget', funding: 'NOT_YET_IDENTIFIED', ward: 27, milestones: [], publish: ['description'] },
    { name: 'Solar street lighting for market centres (synthetic)', category: 'ENERGY', status: 'PROPOSED', responsible: 'trade', implementing: 'electrification', commitment: 'CITIZEN_REQUEST', commitmentDetail: 'Raised in public participation forums (synthetic)', funding: 'NOT_YET_IDENTIFIED', ward: 16, milestones: [] },
    { name: 'Constituency classroom block (NG-CDF) (synthetic)', category: 'EDUCATION', status: 'ONGOING', responsible: 'cdfNorth', commitment: 'CONSTITUENCY_FUND', commitmentDetail: 'NG-CDF North project list (synthetic reference)', funding: 'CONSTITUENCY_FUND', allocation: '2800000.00', expenditure: '900000.00', expenditureVerified: 'DISPUTED', ward: 4, milestones: [['Foundation', 'DONE', 'DISPUTED'], ['Walling', 'IN_PROGRESS']], evidence: [['PHOTO', 'DISPUTED']], publish: ['description', 'fundingSource', 'schedule'] },
    { name: 'Dispensary staff housing (cancelled) (synthetic)', category: 'HEALTH', status: 'CANCELLED', responsible: 'health', commitment: 'ANNUAL_DEVELOPMENT_PLAN', commitmentDetail: 'Annual Development Plan 2024/25 (synthetic reference)', funding: 'COUNTY_GOVERNMENT', allocation: '1500000.00', ward: 11, milestones: [['Design', 'CANCELLED']] },
  ];
  let projectsCreated = 0;
  for (const [i, d] of projectDefs.entries()) {
    const reference = ref('PRJ', i + 1);
    if (await prisma.project.findUnique({ where: { tenantId_reference: { tenantId, reference } } })) continue;
    projectsCreated++;
    const completed = d.status === 'COMPLETED' || d.status === 'VERIFIED_COMPLETED';
    const verifiedCompletion = d.status === 'VERIFIED_COMPLETED';
    const published = !!d.publish;
    const project = await prisma.project.create({
      data: {
        tenantId,
        reference,
        name: d.name,
        description: `${d.name}. Synthetic demonstration record; the responsible institution named here is accountable for delivery.`,
        category: d.category,
        ...loc(d.ward),
        locationDescription: 'Synthetic site',
        responsibleInstitutionId: inst[d.responsible]!,
        implementingAgencyId: d.implementing ? inst[d.implementing]! : null,
        ownerName: 'Chief Officer of the responsible department (synthetic)',
        trackingOfficerId: projectsOfficer,
        approvalAuthority: d.status === 'COMMITTED' || d.status === 'PROPOSED' ? null : 'County Assembly budget approval (synthetic)',
        commitmentSource: d.commitment,
        commitmentSourceDetail: d.commitmentDetail,
        fundingSource: d.funding,
        approvedAllocation: d.allocation ?? null,
        allocationSource: d.allocation ? 'Approved budget estimates (synthetic)' : null,
        contractAmount: d.contract ?? null,
        contractAmountIsPublic: !!d.contractPublic,
        expenditureReported: d.expenditure ?? null,
        expenditureSource: d.expenditure ? 'Department expenditure return (synthetic)' : null,
        expenditureAsOf: d.expenditure ? dateOnly(14) : null,
        expenditureVerificationStatus: d.expenditureVerified ?? 'UNVERIFIED',
        expenditureVerifiedById: d.expenditureVerified === 'VERIFIED' || d.expenditureVerified === 'DISPUTED' ? admin : null,
        expenditureVerifiedAt: d.expenditureVerified === 'VERIFIED' || d.expenditureVerified === 'DISPUTED' ? daysAgo(10) : null,
        startDate: ['PROPOSED', 'COMMITTED', 'APPROVED', 'FUNDED'].includes(d.status) ? null : dateOnly(200),
        expectedCompletionDate: dateOnly(-120),
        actualCompletionDate: completed ? dateOnly(20) : null,
        delayReason: d.delayReason ?? null,
        status: d.status,
        completionReportedById: completed ? projectsOfficer : null,
        completionReportedAt: completed ? daysAgo(20) : null,
        // Verified by the office administrator: not the reporter, not the uploader.
        completionVerifiedById: verifiedCompletion ? admin : null,
        completionVerifiedAt: verifiedCompletion ? daysAgo(12) : null,
        completionVerificationNote: verifiedCompletion ? 'Inspection report and completion certificate checked against the site visit (synthetic).' : null,
        isPublic: published,
        publicFields: d.publish ?? [],
        publicSummary: published ? `${d.name}: public summary approved by the public-information editor (synthetic).` : null,
        publishedById: published ? publicinfo : null,
        publishedAt: published ? daysAgo(5) : null,
        createdById: projectsOfficer,
        createdAt: daysAgo(220),
      },
    });
    const milestoneIds: string[] = [];
    for (const [j, [title, status, verification]] of d.milestones.entries()) {
      const m = await prisma.projectMilestone.create({
        data: {
          tenantId,
          projectId: project.id,
          sequence: j + 1,
          title,
          plannedDate: dateOnly(180 - j * 40),
          actualDate: status === 'DONE' ? dateOnly(170 - j * 40) : null,
          status,
          verificationStatus: verification ?? 'UNVERIFIED',
          verifiedById: verification ? admin : null,
          verifiedAt: verification ? daysAgo(15) : null,
          verificationNote: verification === 'DISPUTED' ? 'Site visit found the work incomplete (synthetic).' : verification ? 'Checked on site (synthetic).' : null,
        },
      });
      milestoneIds.push(m.id);
    }
    for (const [j, [type, verification]] of (d.evidence ?? []).entries()) {
      const label = `${reference} ${type} ${j + 1}`;
      const isPhoto = type === 'PHOTO';
      const fileId = await storeSyntheticFile(
        prisma,
        tenantId,
        projectsOfficer,
        isPhoto ? syntheticPng(label) : syntheticPdf(label),
        isPhoto ? 'image/png' : 'application/pdf',
        `${reference.toLowerCase()}-${type.toLowerCase()}-${j + 1}.${isPhoto ? 'png' : 'pdf'}`,
        'PROJECT_EVIDENCE',
      );
      await prisma.projectEvidence.create({
        data: {
          tenantId,
          projectId: project.id,
          milestoneId: milestoneIds[Math.min(j, milestoneIds.length - 1)] ?? null,
          type,
          description: isPhoto ? 'Progress photograph of the site (synthetic).' : `${type.replace(/_/g, ' ').toLowerCase()} (synthetic).`,
          capturedOn: dateOnly(25 - j),
          sourceDescription: isPhoto ? 'Projects officer site visit (synthetic)' : 'Responsible department (synthetic)',
          storedFileId: fileId,
          uploadedById: projectsOfficer,
          uploadedAt: daysAgo(24 - j),
          verificationStatus: verification ?? 'UNVERIFIED',
          verifiedById: verification ? admin : null,
          verifiedAt: verification ? daysAgo(13) : null,
          verificationNote: verification === 'DISPUTED' ? 'Photograph does not match the reported stage (synthetic).' : verification ? 'Matches the site visit (synthetic).' : null,
          isPublic: verification === 'VERIFIED' && !!d.publish?.includes('evidence'),
        },
      });
    }
  }

  const sample = seedPublicReference(1);
  console.log(
    `  office tenant "${OFFICE_TENANT_SLUG}": office module ON (portal + public projects), ${institutionDefs.length} institutions, ` +
      `${demoUsers.length} users, ${caseDefs.length} cases (${casesCreated} new), ${corrDefs.length} correspondence, ` +
      `${aptDefs.length} appointments, 2 meetings, ${projectDefs.length} projects (${projectsCreated} new)`,
  );
  console.log(`  office demo tracking: reference ${sample.publicReference} with code ${sample.trackingCode} (synthetic) at /p/${OFFICE_TENANT_SLUG}/track`);
}
