import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { nextReference, type TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  CASE_CATEGORY_LABELS,
  CASE_STATUS_PUBLIC_STAGE,
  CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
  ERROR_CODES,
  CITIZEN_FEEDBACK_LABELS,
  MAX_PUBLIC_PHOTO_BYTES,
  PUBLIC_CASE_STAGE_LABELS,
  PUBLIC_PHOTO_MIME_TYPES,
  type CaseStatus,
  type PublicCaseReceipt,
  type PublicCaseStatus,
  PublicCaseSubmissionSchema,
  type PublicCitizenFeedback,
  type PublicTrackRequest,
} from '@ngao360/shared';
import type { Queue } from 'bullmq';
import { AuditService } from '../../../audit/audit.service';
import { AppException } from '../../../common/http/app-exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { NOTIFICATION_QUEUE } from '../../../queue/queue.constants';
import { pathToUnitIds } from '../../../rbac/scope';
import { sniffMimeType } from '../../../storage/file-sniff';
import { StorageService } from '../../../storage/storage.service';
import {
  type OfficeUpload,
  allocatePublicReference,
  hashTrackingCode,
  notifyUser,
  resolveOfficeLocation,
  trackingCodeMatches,
} from '../common';
import { OFFICE_REFERENCE_PREFIX } from '../office.constants';
import { CASE_ENTITY, PUBLIC_TEXT, publicEventMessage } from './case-support';
import { CasesService } from './cases.service';

/** The resolved portal tenant (PublicPortalService.resolve). */
export interface PortalTenantRef {
  id: string;
  slug: string;
  config: {
    portalCountyUnitId: string | null;
    portalCaseCategories: readonly string[];
    portalServiceUserId: string | null;
    portalDisplayName: string;
  };
}

/** Queue job for a requester acknowledgement. Carries ids only; the sender looks up the contact itself. */
export interface CaseAcknowledgementJob {
  kind: 'office.case.acknowledgement';
  tenantId: string;
  caseId: string;
  channel: 'SMS' | 'EMAIL' | 'PHONE';
}

/** Compared against when a reference is unknown, so both failures take the same time. */
const DUMMY_HASH = hashTrackingCode('NOT-A-REAL-CODE');
const FEEDBACK_STATES: readonly CaseStatus[] = ['RESOLUTION_PROPOSED', 'CITIZEN_FEEDBACK'];

/**
 * Public-portal side of citizen cases (API contract §13.2–13.3): submission
 * without an account, tracking by reference + tracking code, and requester
 * feedback. Responses never contain internal notes, staff names, assignees,
 * contact details or other requesters' data.
 */
@Injectable()
export class CasePortalService {
  private readonly logger = new Logger(CasePortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly cases: CasesService,
    @Optional() @InjectQueue(NOTIFICATION_QUEUE) private readonly queue?: Queue,
  ) {}

  /** Validate and record a parsed submission (abuse checks already passed). */
  async submitParsed(
    tenant: PortalTenantRef,
    dto: ReturnType<typeof PublicCaseSubmissionSchema.parse>,
    photo: OfficeUpload | undefined,
  ): Promise<PublicCaseReceipt> {
    if (dto.privacyNoticeVersion !== CURRENT_PORTAL_PRIVACY_NOTICE_VERSION) {
      throw AppException.conflict('The privacy notice has changed. Please reload the page and read it again.', {
        currentVersion: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
      });
    }
    if (!tenant.config.portalCaseCategories.includes(dto.category)) {
      throw AppException.validation('This type of request is not accepted here', [{ path: ['category'], message: 'Choose another category' }]);
    }
    let photoMime: string | null = null;
    if (photo) {
      if (photo.size > MAX_PUBLIC_PHOTO_BYTES || photo.buffer.length > MAX_PUBLIC_PHOTO_BYTES) {
        throw AppException.validation(`Photos must be ${MAX_PUBLIC_PHOTO_BYTES / (1024 * 1024)} MB or smaller`, [{ path: ['photo'], message: 'Too large' }]);
      }
      photoMime = sniffMimeType(photo.buffer);
      if (!photoMime || !(PUBLIC_PHOTO_MIME_TYPES as readonly string[]).includes(photoMime)) {
        throw AppException.validation('Upload a JPEG, PNG, WebP or HEIC photo', [{ path: ['photo'], message: 'Unsupported file' }]);
      }
      if (!tenant.config.portalServiceUserId) {
        throw AppException.validation('Photos cannot be accepted at the moment. Please submit without a photo.', [{ path: ['photo'], message: 'Not accepted' }]);
      }
    }

    const contactGiven = dto.contactPreference !== 'NONE' && dto.consentToContact;
    let ackChannel: CaseAcknowledgementJob['channel'] | null = null;
    const receipt = await this.prisma.withTenant(
      tenant.id,
      async (tx) => {
        const location = await this.portalLocation(tx, tenant, dto.geographicUnitId);
        const reference = await nextReference(tx, tenant.id, OFFICE_REFERENCE_PREFIX.CASE);
        const { publicReference, trackingCode, trackingCodeHash } = await allocatePublicReference(tx, tenant.slug);
        const unitName = location.unitName;
        const title = `${CASE_CATEGORY_LABELS[dto.category]}${unitName ? ` — ${unitName}` : ''}`.slice(0, 160);
        const submittedAt = new Date();
        const row = await tx.citizenCase.create({
          data: {
            tenantId: tenant.id,
            reference,
            publicReference,
            trackingCodeHash,
            source: 'PORTAL',
            category: dto.category,
            title,
            description: dto.description,
            geographicUnitId: location.geographicUnitId,
            countyId: location.countyId,
            constituencyId: location.constituencyId,
            wardId: location.wardId,
            locationDescription: dto.locationDescription ?? null,
            privacyNoticeVersion: dto.privacyNoticeVersion,
            consentToContact: contactGiven,
            status: 'SUBMITTED',
            createdById: null,
            submittedAt,
          },
        });
        if (contactGiven) {
          // Minimal data: only the channel the person chose, plus an optional name.
          const usePhone = dto.contactPreference === 'PHONE' || dto.contactPreference === 'SMS';
          await tx.citizenCaseContact.create({
            data: {
              tenantId: tenant.id,
              caseId: row.id,
              name: dto.name ?? null,
              phone: usePhone ? (dto.phone ?? null) : null,
              email: dto.contactPreference === 'EMAIL' ? (dto.email ?? null) : null,
              preference: dto.contactPreference,
            },
          });
          ackChannel = dto.contactPreference as CaseAcknowledgementJob['channel'];
        }
        await tx.caseEvent.create({
          data: { tenantId: tenant.id, caseId: row.id, type: 'SUBMITTED', visibility: 'PUBLIC', actorType: 'REQUESTER', toStatus: 'SUBMITTED' },
        });
        let storedFileId: string | null = null;
        if (photo && tenant.config.portalServiceUserId) {
          const { file } = await this.storage.storeImmutable(
            {
              tenantId: tenant.id,
              uploadedById: tenant.config.portalServiceUserId,
              buffer: photo.buffer,
              declaredMimeType: photoMime ?? photo.mimetype,
              originalFilename: (photo.originalname || 'photo').slice(0, 120),
              purpose: 'CASE_EVIDENCE',
            },
            tx,
          );
          storedFileId = file.id;
          await tx.caseEvent.create({
            data: {
              tenantId: tenant.id,
              caseId: row.id,
              type: 'EVIDENCE_ADDED',
              visibility: 'INTERNAL',
              actorType: 'REQUESTER',
              body: 'Photo submitted with the request',
              storedFileId: file.id,
            },
          });
        }
        const duplicates = await this.cases.findPossibleDuplicates(tx, row);
        if (duplicates.length > 0) {
          await tx.caseEvent.create({
            data: {
              tenantId: tenant.id,
              caseId: row.id,
              type: 'NOTE',
              visibility: 'INTERNAL',
              actorType: 'SYSTEM',
              body: `Possible duplicate of ${duplicates.map((d) => d.reference).join(', ')} (same category and area, similar description). Check during triage.`,
            },
          });
        }
        await this.audit.record(
          {
            tenantId: tenant.id,
            actorId: null,
            actorType: 'SYSTEM',
            action: AUDIT_ACTIONS.CASE_PUBLIC_SUBMITTED,
            entityType: CASE_ENTITY,
            entityId: row.id,
            after: {
              reference,
              publicReference,
              category: dto.category,
              geographicUnitId: location.geographicUnitId,
              contactPreference: dto.contactPreference,
              consentToContact: contactGiven,
              hasPhoto: !!storedFileId,
              storedFileId,
              possibleDuplicates: duplicates.length,
              privacyNoticeVersion: dto.privacyNoticeVersion,
            },
          },
          tx,
        );
        return {
          publicReference,
          trackingCode,
          submittedAt: submittedAt.toISOString(),
          acknowledgement:
            `Thank you. Your request ${publicReference} has been received by ${tenant.config.portalDisplayName}. ` +
            'Keep the reference and tracking code: you need both to check progress. The tracking code is shown only once.',
          privacyNoticeVersion: dto.privacyNoticeVersion,
          trackPath: `/p/${tenant.slug}/track`,
          caseId: row.id,
        };
      },
      { timeout: 60_000 },
    );
    if (ackChannel) await this.queueAcknowledgement({ kind: 'office.case.acknowledgement', tenantId: tenant.id, caseId: receipt.caseId, channel: ackChannel });
    const { caseId: _caseId, ...out } = receipt;
    return out;
  }

  track(tenant: PortalTenantRef, dto: PublicTrackRequest): Promise<PublicCaseStatus> {
    return this.prisma.withTenant(tenant.id, async (tx) => {
      const row = await this.lookup(tx, dto);
      return this.publicStatus(tx, row.id);
    });
  }

  feedback(tenant: PortalTenantRef, dto: PublicCitizenFeedback): Promise<PublicCaseStatus> {
    return this.prisma.withTenant(tenant.id, async (tx) => {
      const row = await this.lookup(tx, dto);
      if (!FEEDBACK_STATES.includes(row.status)) {
        throw new AppException(ERROR_CODES.CONFLICT, HttpStatus.CONFLICT, 'Feedback can be given once a resolution has been proposed.');
      }
      let to: CaseStatus = row.status;
      if (dto.response === 'CONFIRM_RESOLVED' && row.status === 'RESOLUTION_PROPOSED') to = 'CITIZEN_FEEDBACK';
      if (dto.response === 'DISPUTE') to = 'IN_PROGRESS';
      const body = `${CITIZEN_FEEDBACK_LABELS[dto.response]}${dto.message ? `: ${dto.message}` : '.'}`;
      const result = await tx.citizenCase.updateMany({
        where: { id: row.id, version: row.version },
        data: { status: to, version: { increment: 1 } },
      });
      if (result.count === 0) throw AppException.conflict('Your request was updated at the same moment. Please try again.');
      await tx.caseEvent.create({
        data: {
          tenantId: tenant.id,
          caseId: row.id,
          type: 'CITIZEN_FEEDBACK',
          visibility: 'PUBLIC',
          actorType: 'REQUESTER',
          body,
          fromStatus: to !== row.status ? row.status : null,
          toStatus: to !== row.status ? to : null,
        },
      });
      if (dto.response === 'DISPUTE') {
        await tx.caseEvent.create({
          data: { tenantId: tenant.id, caseId: row.id, type: 'PUBLIC_UPDATE', visibility: 'PUBLIC', actorType: 'SYSTEM', body: PUBLIC_TEXT.disputed },
        });
        if (row.assigneeId) {
          await notifyUser(tx, {
            tenantId: tenant.id,
            userId: row.assigneeId,
            type: 'case.disputed',
            title: `Case ${row.reference}: the requester disputes the resolution`,
            body: `The requester of case ${row.reference} says the issue is not resolved. The case is back in progress.`,
            link: `/office/cases/${row.id}`,
          });
        }
      }
      await this.audit.record(
        {
          tenantId: tenant.id,
          actorId: null,
          actorType: 'SYSTEM',
          action: AUDIT_ACTIONS.CASE_CITIZEN_FEEDBACK,
          entityType: CASE_ENTITY,
          entityId: row.id,
          before: { status: row.status },
          after: { status: to, response: dto.response, hasMessage: !!dto.message },
        },
        tx,
      );
      return this.publicStatus(tx, row.id);
    });
  }

  /* -------------------------------- Internals -------------------------------- */

  /** Same 404 for an unknown reference and a wrong code (constant-time compare on both paths). */
  private async lookup(tx: TenantTx, dto: PublicTrackRequest) {
    // RLS limits the lookup to the portal tenant.
    const row = await tx.citizenCase.findFirst({
      where: { publicReference: dto.publicReference },
      select: { id: true, status: true, version: true, trackingCodeHash: true, assigneeId: true, reference: true },
    });
    const ok = trackingCodeMatches(dto.trackingCode, row?.trackingCodeHash ?? DUMMY_HASH);
    if (!row || !ok) throw AppException.notFound('We could not find a request with that reference and tracking code.');
    return row;
  }

  private async publicStatus(tx: TenantTx, id: string): Promise<PublicCaseStatus> {
    const c = await tx.citizenCase.findUniqueOrThrow({
      where: { id },
      select: {
        publicReference: true,
        category: true,
        status: true,
        submittedAt: true,
        county: { select: { officialName: true } },
        constituency: { select: { officialName: true } },
        ward: { select: { officialName: true } },
        events: {
          where: { visibility: 'PUBLIC' },
          select: { type: true, body: true, toStatus: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
        referrals: { select: { institution: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
      },
    });
    const stage = CASE_STATUS_PUBLIC_STAGE[c.status];
    const updates = c.events.map((e) => ({ at: e.createdAt.toISOString(), message: publicEventMessage(e) }));
    const last = c.events.at(-1)?.createdAt ?? c.submittedAt;
    return {
      publicReference: c.publicReference,
      category: c.category,
      categoryLabel: CASE_CATEGORY_LABELS[c.category],
      locationName: c.ward?.officialName ?? c.constituency?.officialName ?? c.county?.officialName ?? null,
      stage,
      stageLabel: PUBLIC_CASE_STAGE_LABELS[stage],
      submittedAt: c.submittedAt.toISOString(),
      lastUpdatedAt: last.toISOString(),
      updates,
      referredTo: [...new Set(c.referrals.map((r) => r.institution.name))],
      feedbackAllowed: FEEDBACK_STATES.includes(c.status),
    };
  }

  /** Ward or constituency inside the portal county (polling centres and other counties are refused). */
  private async portalLocation(tx: TenantTx, tenant: PortalTenantRef, unitId: string | undefined) {
    if (!unitId) return { geographicUnitId: null, countyId: tenant.config.portalCountyUnitId, constituencyId: null, wardId: null, unitName: null };
    const unit = await tx.geographicUnit.findUnique({ where: { id: unitId }, select: { id: true, type: true, path: true, officialName: true } });
    const county = tenant.config.portalCountyUnitId;
    const inside = !!unit && !!county && pathToUnitIds(unit.path).includes(county);
    if (!unit || !inside || (unit.type !== 'WARD' && unit.type !== 'CONSTITUENCY')) {
      throw AppException.validation('Choose a ward or constituency from the list', [{ path: ['geographicUnitId'], message: 'Not in this county' }]);
    }
    const cols = await resolveOfficeLocation(tx, unit.id);
    return { ...cols, unitName: unit.officialName };
  }

  private async queueAcknowledgement(job: CaseAcknowledgementJob): Promise<void> {
    if (!this.queue) {
      this.logger.debug(`Queues disabled; acknowledgement for case ${job.caseId} not queued`);
      return;
    }
    try {
      await this.queue.add('office.case.acknowledgement', job, { attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: 1000 });
    } catch (err) {
      // The request is recorded; a failed acknowledgement must not lose it.
      this.logger.warn(`Could not queue acknowledgement for case ${job.caseId}: ${(err as Error).message}`);
    }
  }
}
