/**
 * Helpers shared by the reference module's services: pagination, mappers,
 * reference-specific errors and the re-authentication check for decisions whose
 * permission depends on the request body.
 */
import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '@ngao360/db';
import {
  ERROR_CODES,
  PaginationQuerySchema,
  UuidSchema,
  type CandidateReference,
  type Contest,
  type ElectionCycle,
  type FormFieldSchema,
  type FormTemplate,
  type GeographicUnit,
  type OfficialSource,
  type PaginationQuery,
  type PollingStation,
  type RegistryVersion,
  type TallyCentre,
  type ValidationRules,
} from '@ngao360/shared';
import { z } from 'zod';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';

/* ------------------------------- Errors ----------------------------------- */

export function immutable(message: string, details?: unknown): AppException {
  return new AppException(ERROR_CODES.IMMUTABLE_RECORD, HttpStatus.CONFLICT, message, details);
}

export function reauthRequired(): AppException {
  return new AppException(ERROR_CODES.REAUTH_REQUIRED, HttpStatus.UNAUTHORIZED, 'Please confirm your password to continue');
}

/** Same rule as RbacGuard's @RequireReauth, for decisions chosen in the body. */
export function assertRecentReauth(auth: AuthContext, windowSeconds: number): void {
  const now = Math.floor(Date.now() / 1000);
  if (auth.reauthAt === null || now - auth.reauthAt > windowSeconds) throw reauthRequired();
}

/* ----------------------------- Pagination --------------------------------- */

export function pageArgs(q: PaginationQuery): { skip: number; take: number } {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

/** Map a client `sort` key onto an allowed column; unknown keys fall back. */
export function sortArgs<K extends string>(
  q: PaginationQuery,
  allowed: readonly K[],
  fallback: K,
): Record<K, 'asc' | 'desc'> {
  const key = (allowed as readonly string[]).includes(q.sort ?? '') ? (q.sort as K) : fallback;
  return { [key]: q.order } as Record<K, 'asc' | 'desc'>;
}

export const CycleListQuerySchema = PaginationQuerySchema.extend({ electionCycleId: UuidSchema });

export const RegistryVersionListQuerySchema = CycleListQuerySchema;
export type RegistryVersionListQuery = z.infer<typeof RegistryVersionListQuerySchema>;

/* ------------------------------- Mappers ---------------------------------- */

export function isoDate(d: Date): string;
export function isoDate(d: Date | null): string | null;
export function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** 'YYYY-MM-DD' → Date at UTC midnight (for @db.Date columns). */
export function dateOnly(s: string): Date;
export function dateOnly(s: string | null | undefined): Date | null | undefined;
export function dateOnly(s: string | null | undefined): Date | null | undefined {
  if (s === null) return null;
  if (s === undefined) return undefined;
  return new Date(`${s}T00:00:00.000Z`);
}

type Row<T extends Prisma.ModelName> = Prisma.TypeMap['model'][T]['payload']['scalars'];

export function toElectionCycle(r: Row<'ElectionCycle'>): ElectionCycle {
  return {
    id: r.id,
    name: r.name,
    electionDate: isoDate(r.electionDate),
    jurisdiction: r.jurisdiction,
    legalConfigVersion: r.legalConfigVersion,
    status: r.status,
    dataProvenance: r.dataProvenance,
    officialSources: (Array.isArray(r.officialSources) ? r.officialSources : []) as OfficialSource[],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toGeographicUnit(r: Row<'GeographicUnit'>, childCount?: number): GeographicUnit {
  return {
    id: r.id,
    electionCycleId: r.electionCycleId,
    type: r.type,
    parentId: r.parentId,
    officialCode: r.officialCode,
    officialName: r.officialName,
    path: r.path,
    sourceVersion: r.sourceVersion,
    validFrom: isoDate(r.validFrom),
    validTo: isoDate(r.validTo),
    ...(childCount !== undefined ? { childCount } : {}),
  };
}

export function toRegistryVersion(r: Row<'RegistryVersion'>): RegistryVersion {
  return {
    id: r.id,
    electionCycleId: r.electionCycleId,
    version: r.version,
    source: r.source,
    status: r.status,
    stationCount: r.stationCount,
    importedAt: r.importedAt.toISOString(),
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    approvedById: r.approvedById,
    notes: r.notes,
  };
}

export const STATION_NAME_INCLUDE = {
  county: { select: { officialName: true } },
  constituency: { select: { officialName: true } },
  ward: { select: { officialName: true } },
  pollingCentre: { select: { officialName: true } },
} as const;

type StationWithNames = Row<'PollingStation'> & {
  county?: { officialName: string };
  constituency?: { officialName: string };
  ward?: { officialName: string };
  pollingCentre?: { officialName: string } | null;
};

export function toPollingStation(r: StationWithNames): PollingStation {
  return {
    id: r.id,
    electionCycleId: r.electionCycleId,
    registryVersionId: r.registryVersionId,
    geographicUnitId: r.geographicUnitId,
    countyId: r.countyId,
    constituencyId: r.constituencyId,
    wardId: r.wardId,
    pollingCentreId: r.pollingCentreId,
    code: r.code,
    name: r.name,
    streamNumber: r.streamNumber,
    registeredVoters: r.registeredVoters,
    status: r.status,
    latitude: r.latitude === null ? null : Number(r.latitude),
    longitude: r.longitude === null ? null : Number(r.longitude),
    locationSource: r.locationSource,
    ...(r.county ? { countyName: r.county.officialName } : {}),
    ...(r.constituency ? { constituencyName: r.constituency.officialName } : {}),
    ...(r.ward ? { wardName: r.ward.officialName } : {}),
    ...(r.pollingCentre !== undefined ? { pollingCentreName: r.pollingCentre?.officialName ?? null } : {}),
  };
}

export function toTallyCentre(r: Row<'TallyCentre'>): TallyCentre {
  return {
    id: r.id,
    electionCycleId: r.electionCycleId,
    level: r.level,
    geographicUnitId: r.geographicUnitId,
    code: r.code,
    name: r.name,
  };
}

export function toContest(r: Row<'Contest'>, candidateCount?: number): Contest {
  return {
    id: r.id,
    electionCycleId: r.electionCycleId,
    officeType: r.officeType,
    name: r.name,
    geographicUnitId: r.geographicUnitId,
    formSeries: r.formSeries,
    status: r.status,
    ...(candidateCount !== undefined ? { candidateCount } : {}),
  };
}

export function toCandidate(r: Row<'CandidateReference'>): CandidateReference {
  return {
    id: r.id,
    contestId: r.contestId,
    candidateNameAsPublished: r.candidateNameAsPublished,
    partyLabel: r.partyLabel,
    isIndependent: r.isIndependent,
    ballotOrder: r.ballotOrder,
    referenceCode: r.referenceCode,
    source: r.source,
  };
}

export function toFormTemplate(r: Row<'FormTemplate'>): FormTemplate {
  return {
    id: r.id,
    electionCycleId: r.electionCycleId,
    contestType: r.contestType,
    formNumber: r.formNumber,
    formLevel: r.formLevel,
    version: r.version,
    title: r.title,
    effectiveDate: isoDate(r.effectiveDate),
    fieldSchema: r.fieldSchema as unknown as FormFieldSchema,
    validationRules: r.validationRules as unknown as ValidationRules,
    officialSource: r.officialSource,
    officialSourceUrl: r.officialSourceUrl,
    approvalState: r.approvalState,
    approvedById: r.approvedById,
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Case-insensitive "contains" filter for free-text search. */
export function contains(q: string | undefined): { contains: string; mode: 'insensitive' } | undefined {
  return q ? { contains: q, mode: 'insensitive' } : undefined;
}
