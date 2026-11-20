import { Injectable, Logger } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  type PermissionKey,
  SYNC_ERROR_CODES,
  type SyncItem,
  type SyncItemResult,
  type SyncRequest,
  type SyncResponse,
  type SyncStatus,
} from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../auth/auth.types';
import { AllExceptionsFilter } from '../../../common/http/all-exceptions.filter';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { PermissionService } from '../../../rbac/permission.service';
import { scopeAllows } from '../../../rbac/scope';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { ClientSubmissionLedger, type LedgerItem } from '../common/client-submission.ledger';
import { fieldGeoLocation } from '../common/field-location';
import { StaleItemException, assertOfflineAge } from '../common/field-support';
import { DeploymentService } from '../deployment/deployment.service';
import { FIELD_ENTITY } from '../field.constants';
import { IncidentsService } from '../incidents/incidents.service';
import { ReportsService } from '../reports/reports.service';

/** Permission each item kind needs (missing → REJECTED FORBIDDEN). INCIDENT_NOTE is refined by the incident service. */
const KIND_PERMISSIONS: Record<SyncItem['kind'], PermissionKey[]> = {
  FIELD_REPORT: ['field.reports.submit'],
  INCIDENT: ['field.incidents.report'],
  INCIDENT_NOTE: ['field.incidents.report', 'field.incidents.triage', 'field.incidents.escalate'],
  CHECK_IN: ['field.deployment.checkin'],
  ASSIGNMENT_CONFIRMATION: ['field.deployment.checkin'],
};

const RESULT_TYPES: Record<SyncItem['kind'], string> = {
  FIELD_REPORT: FIELD_ENTITY.FIELD_REPORT,
  INCIDENT: FIELD_ENTITY.INCIDENT,
  INCIDENT_NOTE: 'IncidentEvent',
  CHECK_IN: FIELD_ENTITY.DEPLOYMENT,
  ASSIGNMENT_CONFIRMATION: FIELD_ENTITY.DEPLOYMENT,
};

type Applied = { id: string; type: string; reference: string | null };

/**
 * Batched offline sync (blueprint 13.4; API contract §22). Each item is
 * checked against the idempotency ledger and applied in its own tenant
 * transaction through the owning service, with exactly the direct endpoint's
 * checks; one failing item never rolls back another. Conflicts are returned
 * with the current server state and never overwrite server data.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly errors = new AllExceptionsFilter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly modules: TenantModulesService,
    private readonly ledger: ClientSubmissionLedger,
    private readonly reports: ReportsService,
    private readonly incidents: IncidentsService,
    private readonly deployments: DeploymentService,
  ) {}

  async sync(auth: AuthContext, req: SyncRequest): Promise<SyncResponse> {
    const results: SyncItemResult[] = [];
    for (const item of req.items) results.push(await this.syncItem(auth, item));
    return { results, serverTime: new Date().toISOString() };
  }

  private base(item: SyncItem): Pick<SyncItemResult, 'idempotencyKey' | 'kind'> {
    return { idempotencyKey: item.idempotencyKey, kind: item.kind };
  }

  private ledgerItem(item: SyncItem): LedgerItem {
    return { idempotencyKey: item.idempotencyKey, deviceId: item.deviceId, kind: item.kind, clientCreatedAt: item.clientCreatedAt, payload: item.payload };
  }

  private async apply(tx: TenantTx, auth: AuthContext, item: SyncItem): Promise<Applied> {
    const ctx = { via: 'sync' as const, deviceId: item.deviceId };
    switch (item.kind) {
      case 'FIELD_REPORT': {
        const r = await this.reports.submitInTx(tx, auth, item.payload, ctx);
        return { id: r.id, type: FIELD_ENTITY.FIELD_REPORT, reference: r.reference };
      }
      case 'INCIDENT': {
        const r = await this.incidents.reportInTx(tx, auth, item.payload, ctx);
        return { id: r.id, type: FIELD_ENTITY.INCIDENT, reference: r.reference };
      }
      case 'INCIDENT_NOTE': {
        const e = await this.incidents.addEventInTx(tx, auth, item.payload.incidentId, item.payload.event, ctx);
        return { id: e.id, type: 'IncidentEvent', reference: null };
      }
      case 'CHECK_IN':
      case 'ASSIGNMENT_CONFIRMATION': {
        const { deploymentId, ...dto } = item.payload;
        // Same geography rule as the direct endpoint's guard (field.deployment.checkin over the deployment).
        const d = await tx.deployment.findUnique({
          where: { id: deploymentId },
          select: { electionCycleId: true, pollingStationCode: true, countyId: true, constituencyId: true, wardId: true, pollingCentreId: true },
        });
        if (!d) throw AppException.notFound('Assignment not found');
        if (!scopeAllows(this.permissions.scopeFor(auth, 'field.deployment.checkin'), fieldGeoLocation(d))) throw AppException.outOfScope();
        const r =
          item.kind === 'CHECK_IN'
            ? await this.deployments.checkInInTx(tx, auth, deploymentId, dto as typeof item.payload, ctx)
            : await this.deployments.confirmInTx(tx, auth, deploymentId, dto as typeof item.payload, ctx);
        return { id: r.id, type: FIELD_ENTITY.DEPLOYMENT, reference: r.location.station?.code ?? null };
      }
    }
  }

  private async load(tx: TenantTx, auth: AuthContext, kind: SyncItem['kind'], id: string): Promise<Applied> {
    if (kind === 'FIELD_REPORT') {
      const r = await tx.fieldReport.findUnique({ where: { id }, select: { id: true, reference: true } });
      return { id, type: FIELD_ENTITY.FIELD_REPORT, reference: r?.reference ?? null };
    }
    if (kind === 'INCIDENT') {
      const r = await tx.incident.findUnique({ where: { id }, select: { reference: true } });
      return { id, type: FIELD_ENTITY.INCIDENT, reference: r?.reference ?? null };
    }
    if (kind === 'INCIDENT_NOTE') return { id, type: 'IncidentEvent', reference: null };
    const d = await tx.deployment.findUnique({ where: { id }, select: { pollingStationCode: true } });
    return { id, type: FIELD_ENTITY.DEPLOYMENT, reference: d?.pollingStationCode ?? null };
  }

  private async syncItem(auth: AuthContext, item: SyncItem): Promise<SyncItemResult> {
    const empty = { replayed: false, resultType: null, resultId: null, reference: null, serverState: null };
    if (!KIND_PERMISSIONS[item.kind].some((p) => auth.permissions.has(p))) {
      return { ...this.base(item), ...empty, outcome: 'REJECTED', errorCode: ERROR_CODES.FORBIDDEN, message: 'You do not have permission to send this kind of item' };
    }
    const payloadKey = (item.payload as { clientIdempotencyKey?: string }).clientIdempotencyKey;
    if (payloadKey !== undefined && payloadKey !== item.idempotencyKey) {
      return { ...this.base(item), ...empty, outcome: 'REJECTED', errorCode: ERROR_CODES.VALIDATION_FAILED, message: 'The item key does not match the record key' };
    }
    try {
      const { replayed, result } = await this.prisma.tenantTx((tx) =>
        this.ledger.run<Applied>(
          tx,
          auth,
          this.ledgerItem(item),
          { type: RESULT_TYPES[item.kind], id: (r) => r.id, reference: (r) => r.reference },
          async () => {
            assertOfflineAge(await this.modules.fieldConfig(tx), item.clientCreatedAt);
            return this.apply(tx, auth, item);
          },
          (resultId) => this.load(tx, auth, item.kind, resultId),
        ),
      );
      return { ...this.base(item), outcome: 'ACCEPTED', replayed, resultType: result.type, resultId: result.id, reference: result.reference, errorCode: null, message: null, serverState: null };
    } catch (e) {
      return this.failure(auth, item, e);
    }
  }

  private async failure(auth: AuthContext, item: SyncItem, e: unknown): Promise<SyncItemResult> {
    const err = this.errors.toApiError(e);
    const empty = { replayed: false, resultType: null, resultId: null, reference: null };
    if (err.statusCode >= 500) {
      this.logger.error(e instanceof Error ? e.stack : String(e));
      // Not recorded: the device keeps the item and retries with the same key.
      return { ...this.base(item), ...empty, outcome: 'REJECTED', errorCode: ERROR_CODES.INTERNAL, message: 'The server could not process this item. It will be retried.', serverState: null };
    }
    const details = (err.details ?? {}) as { reason?: string; serverState?: unknown };
    let outcome: 'REJECTED' | 'CONFLICT' = 'REJECTED';
    let errorCode: string = err.code;
    let serverState: Record<string, unknown> | null = null;
    if (err.code === ERROR_CODES.IDEMPOTENCY_KEY_REUSED) {
      outcome = 'CONFLICT';
      errorCode = SYNC_ERROR_CODES.IDEMPOTENCY_KEY_REUSED;
    } else if (err.code === ERROR_CODES.CONFLICT && details.reason === SYNC_ERROR_CODES.SERVER_CHANGED) {
      outcome = 'CONFLICT';
      errorCode = SYNC_ERROR_CODES.SERVER_CHANGED;
      serverState = (details.serverState ?? null) as Record<string, unknown> | null;
    } else if (e instanceof StaleItemException) {
      errorCode = SYNC_ERROR_CODES.STALE;
    }
    await this.prisma.tenantTx(async (tx) => {
      // A reused key keeps its original ledger row; anything else records the outcome (re-evaluated on retry).
      if (errorCode !== SYNC_ERROR_CODES.IDEMPOTENCY_KEY_REUSED) {
        await this.ledger.record(tx, auth, this.ledgerItem(item), ClientSubmissionLedger.payloadHash(item.payload), { outcome, errorCode });
      }
      if (outcome === 'CONFLICT') {
        await this.audit.record(
          {
            tenantId: auth.tenantId,
            action: AUDIT_ACTIONS.SYNC_CONFLICT_RECORDED,
            entityType: FIELD_ENTITY.CLIENT_SUBMISSION,
            entityId: item.idempotencyKey,
            after: { kind: item.kind, idempotencyKey: item.idempotencyKey, code: errorCode, deviceId: item.deviceId },
          },
          tx,
        );
      }
    });
    return { ...this.base(item), ...empty, outcome, errorCode, message: err.message, serverState };
  }

  status(auth: AuthContext, deviceId: string): Promise<SyncStatus> {
    return this.prisma.tenantTx(async (tx) => {
      const where = { userId: auth.userId, deviceId };
      const [agg, accepted, conflicts] = await Promise.all([
        tx.clientSubmission.aggregate({ where, _max: { lastSeenAt: true } }),
        tx.clientSubmission.count({ where: { ...where, outcome: 'ACCEPTED' } }),
        tx.clientSubmission.findMany({ where: { ...where, outcome: 'CONFLICT' }, orderBy: { lastSeenAt: 'desc' }, take: 100 }),
      ]);
      return {
        deviceId,
        lastReceivedAt: agg._max.lastSeenAt ? agg._max.lastSeenAt.toISOString() : null,
        accepted,
        conflicts: conflicts.map((c) => ({
          idempotencyKey: c.idempotencyKey,
          kind: c.kind,
          outcome: c.outcome,
          replayed: false,
          resultType: c.resultType,
          resultId: c.resultId,
          reference: c.resultReference,
          errorCode: c.errorCode,
          message: null,
          serverState: null,
        })),
        serverTime: new Date().toISOString(),
      };
    });
  }
}
