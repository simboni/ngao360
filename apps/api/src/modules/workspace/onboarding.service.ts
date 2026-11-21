import { Injectable } from '@nestjs/common';
import type { TenantTx } from '@ngao360/db';
import {
  AUDIT_ACTIONS,
  type OnboardingResponse,
  type UpdateSetupItem,
  WORKSPACE_SETUP_ITEMS,
  type WorkspaceSetupItem,
  type WorkspaceSetupItemDefinition,
} from '@ngao360/shared';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth.types';
import { AppException } from '../../common/http/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import { loadMfaPosture } from './mfa-posture';
import { backupIsCurrent, readWorkspaceSettings } from './workspace-settings';

interface Detection {
  detected: boolean;
  evidence: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * S03 onboarding checklist (API contract §33.2). Completion of most steps is read from the data
 * (registry approved, templates approved, roles assigned, MFA enrolled by privileged users,
 * privacy notice reviewed, retention set, backup verified), so the checklist cannot claim a
 * step that is not actually done: DONE is accepted only while the data shows it, and an item
 * whose data later regresses shows as incomplete again. Skipping needs a note.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  get(auth: AuthContext): Promise<OnboardingResponse> {
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      await this.ensureRows(tx, auth.tenantId);
      return this.build(tx, auth.tenantId);
    });
  }

  update(auth: AuthContext, itemKey: string, dto: UpdateSetupItem): Promise<WorkspaceSetupItem> {
    const def = WORKSPACE_SETUP_ITEMS.find((i) => i.key === itemKey);
    if (!def) throw AppException.notFound('Unknown onboarding step');
    const note = dto.note?.trim() || null;
    if (dto.status === 'SKIPPED' && (!note || note.length < 3)) {
      throw AppException.validation('Say why this step is skipped', [{ path: ['note'], message: 'Say why this step is skipped' }]);
    }
    return this.prisma.withTenant(auth.tenantId, async (tx) => {
      await this.ensureRows(tx, auth.tenantId);
      if (dto.status === 'DONE' && def.autoDetect) {
        const d = await this.detect(tx, auth.tenantId, def);
        if (!d.detected) {
          throw AppException.conflict('This step is complete when the work is done: the data does not show it yet', {
            reason: 'NOT_DETECTED',
            evidence: d.evidence,
          });
        }
      }
      const before = await tx.workspaceSetupItem.findFirstOrThrow({ where: { itemKey } });
      const done = dto.status !== 'PENDING';
      await tx.workspaceSetupItem.update({
        where: { id: before.id },
        data: {
          status: dto.status,
          note,
          completedById: done ? auth.userId : null,
          completedAt: done ? new Date() : null,
        },
      });
      await this.audit.record(
        {
          tenantId: auth.tenantId,
          action: AUDIT_ACTIONS.WORKSPACE_SETUP_ITEM_UPDATED,
          entityType: 'WorkspaceSetupItem',
          entityId: itemKey,
          before: { status: before.status, note: before.note },
          after: { status: dto.status, note },
          reason: note,
        },
        tx,
      );
      const all = await this.build(tx, auth.tenantId);
      return all.items.find((i) => i.key === itemKey)!;
    });
  }

  /** Mark a step DONE from another workspace action (profile saved), unless already completed. */
  async markDone(tx: TenantTx, tenantId: string, userId: string, itemKey: string, note: string | null = null): Promise<void> {
    await this.ensureRows(tx, tenantId);
    const row = await tx.workspaceSetupItem.findFirst({ where: { itemKey } });
    if (!row || row.status !== 'PENDING') return;
    await tx.workspaceSetupItem.update({ where: { id: row.id }, data: { status: 'DONE', note, completedById: userId, completedAt: new Date() } });
    await this.audit.record(
      {
        tenantId,
        action: AUDIT_ACTIONS.WORKSPACE_SETUP_ITEM_UPDATED,
        entityType: 'WorkspaceSetupItem',
        entityId: itemKey,
        before: { status: 'PENDING' },
        after: { status: 'DONE', note },
      },
      tx,
    );
  }

  /** Create missing PENDING rows (first read, or items added after the workspace was created). */
  async ensureRows(tx: TenantTx, tenantId: string): Promise<void> {
    await tx.workspaceSetupItem.createMany({
      data: WORKSPACE_SETUP_ITEMS.map((i) => ({ tenantId, itemKey: i.key })),
      skipDuplicates: true,
    });
  }

  private async build(tx: TenantTx, tenantId: string): Promise<OnboardingResponse> {
    const rows = await tx.workspaceSetupItem.findMany({ include: { completedBy: { select: { id: true, displayName: true } } } });
    const detections = await this.detectAll(tx, tenantId);
    const items: WorkspaceSetupItem[] = WORKSPACE_SETUP_ITEMS.map((def) => {
      const row = rows.find((r) => r.itemKey === def.key);
      const status = row?.status ?? 'PENDING';
      const d = detections.get(def.key) ?? { detected: false, evidence: null };
      const complete = def.autoDetect ? d.detected || status === 'SKIPPED' : status !== 'PENDING';
      return {
        key: def.key,
        label: def.label,
        description: def.description,
        href: def.href,
        status,
        detected: d.detected,
        note: row?.note ?? null,
        completedBy: row?.completedBy ?? null,
        completedAt: row?.completedAt?.toISOString() ?? null,
        autoDetect: def.autoDetect,
        complete,
        evidence: d.evidence,
      };
    });
    return { items, completed: items.filter((i) => i.complete).length, total: items.length };
  }

  private async detect(tx: TenantTx, tenantId: string, def: WorkspaceSetupItemDefinition): Promise<Detection> {
    return (await this.detectAll(tx, tenantId)).get(def.key) ?? { detected: false, evidence: null };
  }

  /** Read-only checks against the tenant's data (RLS applies). Counts only. */
  async detectAll(tx: TenantTx, tenantId: string, now = new Date()): Promise<Map<string, Detection>> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
    const settings = readWorkspaceSettings(tenant.settings);
    const activeAssignment = { revokedAt: null, validFrom: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
    const [registryVersions, approvedRegistries, stations, templates, approvedTemplates, teams, departments, people, withRoles, posture] =
      await Promise.all([
        tx.registryVersion.count(),
        tx.registryVersion.count({ where: { status: 'APPROVED' } }),
        tx.pollingStation.count(),
        tx.formTemplate.count(),
        tx.formTemplate.count({ where: { approvalState: 'APPROVED' } }),
        tx.team.count(),
        tx.department.count(),
        // System accounts (e.g. the portal service account) have no password and never an invitation.
        tx.user.count({ where: { OR: [{ status: 'INVITED' }, { status: 'ACTIVE', passwordHash: { not: null } }] } }),
        tx.user.count({ where: { status: { in: ['ACTIVE', 'INVITED'] }, roleAssignments: { some: activeAssignment } } }),
        loadMfaPosture(tx, settings.security.mfaPolicy, now),
      ]);

    const map = new Map<string, Detection>();
    map.set('reference.import', {
      detected: registryVersions > 0 && stations > 0,
      evidence: `${plural(registryVersions, 'registry version')}, ${plural(stations, 'polling station')}`,
    });
    map.set('registry.approved', {
      detected: approvedRegistries > 0,
      evidence: approvedRegistries > 0 ? `${plural(approvedRegistries, 'approved registry version')}` : `None of ${plural(registryVersions, 'registry version')} approved`,
    });
    map.set('forms.approved', {
      detected: approvedTemplates > 0,
      evidence: `${approvedTemplates} of ${plural(templates, 'form template')} approved`,
    });
    map.set('org.teams', { detected: teams > 0, evidence: `${plural(departments, 'department')}, ${plural(teams, 'team')}` });
    map.set('users.invite', { detected: people > 1, evidence: `${plural(people, 'person', 'people')} invited or active` });
    map.set('roles.configure', { detected: withRoles > 1, evidence: `${plural(withRoles, 'person', 'people')} with a role` });
    map.set('security.mfa_enrolled', {
      detected: posture.privilegedUsers > 0 && posture.privilegedWithoutMfa === 0,
      evidence: `${posture.privilegedUsers - posture.privilegedWithoutMfa} of ${plural(posture.privilegedUsers, 'privileged user')} use MFA`,
    });
    const dp = settings.dataProtection;
    map.set('privacy.notice_reviewed', {
      detected: !!dp?.reviewedAt,
      evidence: dp ? `Privacy notice ${dp.privacyNoticeVersion}${dp.reviewedAt ? ', reviewed' : ', not yet reviewed in this organisation'}` : 'No data-protection contact recorded',
    });
    map.set('retention.set', {
      detected: !!settings.retention.reviewedAt,
      evidence: settings.retention.reviewedAt ? 'Retention reviewed and saved' : 'Retention not reviewed yet',
    });
    const last = settings.backup.last;
    map.set('backup.verified', {
      detected: backupIsCurrent(last, now),
      evidence: last ? `Last restore test ${last.testedOn}: ${last.outcome.replace(/_/g, ' ').toLowerCase()}` : 'No restore test recorded',
    });
    return map;
  }
}
