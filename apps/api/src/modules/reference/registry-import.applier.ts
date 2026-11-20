/**
 * Writes validated registry rows into a DRAFT registry version.
 *
 * - Stations always belong to exactly one registry version (no overwrite of an
 *   earlier version; the approved version stays untouched until a new one is
 *   approved).
 * - Geographic units are shared across versions of a cycle when code, name and
 *   parent are unchanged, so contests, tally centres and role assignments keep
 *   pointing at the same county/constituency/ward. A unit whose name or parent
 *   changed is NOT edited in place: a new unit is created with the new
 *   sourceVersion and the change is reported as a warning.
 */
import { randomUUID } from 'node:crypto';
import type { GeographicUnitType, Prisma, TenantTx } from '@ngao360/db';
import {
  appendReportIssue,
  diffRegistry,
  type RegistryImportReport,
  type RegistryRow,
  type StationSnapshot,
} from './reference-shared';

export interface ApplyTarget {
  tenantId: string;
  registryVersionId: string;
  electionCycleId: string;
  version: string;
}

export interface ApplyResult {
  unitsCreated: number;
  unitsReused: number;
  stationsCreated: number;
}

const TYPE_ORDER: GeographicUnitType[] = ['COUNTY', 'CONSTITUENCY', 'WARD', 'POLLING_CENTRE'];
const STATION_CHUNK = 1_000;

interface ExistingUnit {
  id: string;
  type: GeographicUnitType;
  officialCode: string;
  officialName: string;
  parentId: string | null;
  path: string;
}

export async function applyRegistryRows(
  tx: TenantTx,
  target: ApplyTarget,
  rows: readonly RegistryRow[],
  report: RegistryImportReport,
): Promise<ApplyResult> {
  const existing = await tx.geographicUnit.findMany({
    where: { electionCycleId: target.electionCycleId },
    select: { id: true, type: true, officialCode: true, officialName: true, parentId: true, path: true },
    orderBy: { createdAt: 'desc' },
  });
  const byKey = new Map<string, ExistingUnit[]>();
  for (const u of existing) {
    const k = `${u.type}|${u.officialCode}`;
    byKey.set(k, [...(byKey.get(k) ?? []), u]);
  }

  const resolved = new Map<string, { id: string; path: string }>();
  const created: Prisma.GeographicUnitCreateManyInput[] = [];
  let reused = 0;

  const resolve = (type: GeographicUnitType, code: string, name: string, parentKey: string | null, line: number): string => {
    const key = `${type}|${code}`;
    const done = resolved.get(key);
    if (done) return key;
    const parent = parentKey ? resolved.get(parentKey)! : null;
    const parentId = parent?.id ?? null;
    const candidates = byKey.get(key) ?? [];
    const match = candidates.find((c) => c.officialName === name && c.parentId === parentId);
    if (match) {
      resolved.set(key, { id: match.id, path: match.path });
      reused++;
      return key;
    }
    const prior = candidates[0];
    if (prior) {
      const renamed = prior.officialName !== name;
      appendReportIssue(report, {
        row: line,
        column: null,
        code: renamed ? 'UNIT_RENAMED' : 'UNIT_REPARENTED',
        severity: 'WARNING',
        message: renamed
          ? `${type.toLowerCase()} ${code} was "${prior.officialName}" and is "${name}" in this file; a new unit was created for version ${target.version} (the existing unit is unchanged)`
          : `${type.toLowerCase()} ${code} has a different parent in this file; a new unit was created for version ${target.version} (the existing unit is unchanged)`,
      });
    }
    const id = randomUUID();
    const path = `${parent?.path ?? '/'}${id}/`;
    created.push({
      id,
      tenantId: target.tenantId,
      electionCycleId: target.electionCycleId,
      registryVersionId: target.registryVersionId,
      type,
      parentId,
      officialCode: code,
      officialName: name,
      path,
      sourceVersion: target.version,
    });
    resolved.set(key, { id, path });
    return key;
  };

  const stations: Prisma.PollingStationCreateManyInput[] = [];
  for (const r of rows) {
    const countyKey = resolve('COUNTY', r.countyCode, r.countyName, null, r.line);
    const constituencyKey = resolve('CONSTITUENCY', r.constituencyCode, r.constituencyName, countyKey, r.line);
    const wardKey = resolve('WARD', r.wardCode, r.wardName, constituencyKey, r.line);
    const centreKey = r.centreCode && r.centreName ? resolve('POLLING_CENTRE', r.centreCode, r.centreName, wardKey, r.line) : null;
    const wardId = resolved.get(wardKey)!.id;
    const centreId = centreKey ? resolved.get(centreKey)!.id : null;
    stations.push({
      tenantId: target.tenantId,
      electionCycleId: target.electionCycleId,
      registryVersionId: target.registryVersionId,
      geographicUnitId: centreId ?? wardId,
      countyId: resolved.get(countyKey)!.id,
      constituencyId: resolved.get(constituencyKey)!.id,
      wardId,
      pollingCentreId: centreId,
      code: r.stationCode,
      name: r.stationName,
      streamNumber: r.streamNumber,
      registeredVoters: r.registeredVoters,
      status: 'ACTIVE',
      latitude: r.latitude,
      longitude: r.longitude,
      locationSource: r.locationSource,
    });
  }

  // Parents before children (foreign key on parent_id).
  for (const type of TYPE_ORDER) {
    const batch = created.filter((u) => u.type === type);
    if (batch.length > 0) await tx.geographicUnit.createMany({ data: batch });
  }
  for (let i = 0; i < stations.length; i += STATION_CHUNK) {
    await tx.pollingStation.createMany({ data: stations.slice(i, i + STATION_CHUNK) });
  }
  return { unitsCreated: created.length, unitsReused: reused, stationsCreated: stations.length };
}

/** Diff the new rows against the cycle's currently approved registry version (if any). */
export async function diffAgainstApproved(
  tx: TenantTx,
  electionCycleId: string,
  rows: readonly RegistryRow[],
): Promise<RegistryImportReport['diff']> {
  const approved = await tx.registryVersion.findFirst({
    where: { electionCycleId, status: 'APPROVED' },
    orderBy: { approvedAt: 'desc' },
    select: { id: true, version: true },
  });
  const next: StationSnapshot[] = rows.map((r) => ({
    code: r.stationCode,
    name: r.stationName,
    wardCode: r.wardCode,
    registeredVoters: r.registeredVoters,
  }));
  if (!approved) return diffRegistry([], next, null);
  const prev = await tx.pollingStation.findMany({
    where: { registryVersionId: approved.id },
    select: { code: true, name: true, registeredVoters: true, ward: { select: { officialCode: true } } },
  });
  return diffRegistry(
    prev.map((p) => ({ code: p.code, name: p.name, wardCode: p.ward.officialCode, registeredVoters: p.registeredVoters })),
    next,
    approved.version,
  );
}
