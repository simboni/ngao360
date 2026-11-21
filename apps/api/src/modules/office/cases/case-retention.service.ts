import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AUDIT_ACTIONS, JOB_KEYS } from '@ngao360/shared';
import { AuditService } from '../../../audit/audit.service';
import { AppConfig } from '../../../config/app-config';
import { JobScheduler } from '../../../platform/jobs/job-scheduler';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantModulesService } from '../../../tenant-modules/tenant-modules.service';
import { addMonths, nairobiToday, toDbDate } from '../common';
import { CASE_ENTITY } from './case-support';
import { CasesService } from './cases.service';
import { eraseAppointmentContactInTx } from '../appointments/appointments.service';

export interface RetentionRunResult {
  tenants: number;
  contactsErased: number;
  casesRedacted: number;
  appointmentContactsErased: number;
}

/**
 * Office retention (blueprint 15.2 storage limitation; the periods are the ones
 * the portal privacy notice states, from the office module configuration):
 *
 * - contact details are erased once `retentionUntil` (closure date plus
 *   `contactRetentionMonths`) has passed;
 * - closed cases are redacted `caseRetentionMonths` after closure: the
 *   description, location text, requester messages and photos are removed and
 *   an anonymised record stays.
 *
 * - appointment requester names and contact details are erased
 *   `contactRetentionMonths` after the appointment ended (declined, cancelled,
 *   completed or no-show).
 *
 * Retention runs for EVERY tenant, whatever its status (active, suspended,
 * archived) and whether or not the Office module is still switched on: the
 * periods the privacy notice promised keep applying to data already collected.
 * The periods come from the stored office configuration (defaults when none).
 *
 * Runs as the durable `office.retention` job (BullMQ repeatable job with a
 * `job_runs` record per run) every OFFICE_RETENTION_INTERVAL_MINUTES (0 = on
 * demand only). One schedule across API instances; each run is idempotent.
 */
@Injectable()
export class CaseRetentionService implements OnModuleInit {
  private readonly logger = new Logger(CaseRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly modules: TenantModulesService,
    private readonly cases: CasesService,
    private readonly config: AppConfig,
    private readonly jobs: JobScheduler,
  ) {}

  onModuleInit(): void {
    const minutes = this.config.values.OFFICE_RETENTION_INTERVAL_MINUTES;
    this.jobs.register({
      key: JOB_KEYS.OFFICE_RETENTION,
      everyMs: minutes > 0 ? minutes * 60_000 : 0,
      handler: async () => {
        const r = await this.runAll();
        if (r.contactsErased || r.casesRedacted || r.appointmentContactsErased) {
          this.logger.log(`Office retention: ${r.contactsErased} contacts erased, ${r.casesRedacted} cases redacted, ${r.appointmentContactsErased} appointment contacts erased`);
        }
        return { ...r };
      },
    });
  }

  /** One pass over every tenant (any status, Office module on or off). */
  async runAll(now = new Date()): Promise<RetentionRunResult> {
    const tenants = await this.prisma.client.tenant.findMany({ select: { id: true } });
    const total: RetentionRunResult = { tenants: 0, contactsErased: 0, casesRedacted: 0, appointmentContactsErased: 0 };
    for (const t of tenants) {
      const r = await this.runForTenant(t.id, now);
      if (r === null) continue;
      total.tenants += 1;
      total.contactsErased += r.contactsErased;
      total.casesRedacted += r.casesRedacted;
      total.appointmentContactsErased += r.appointmentContactsErased;
    }
    return total;
  }

  /** Returns null when the tenant holds no Office data. */
  runForTenant(tenantId: string, now = new Date()): Promise<Omit<RetentionRunResult, 'tenants'> | null> {
    return this.prisma.withTenant(
      tenantId,
      async (tx) => {
        // Deliberately no module or tenant-status check (see class comment).
        const [cases, appointments] = await Promise.all([tx.citizenCase.count(), tx.appointment.count()]);
        if (cases === 0 && appointments === 0) return null;
        const config = await this.modules.officeConfig(tx);
        const today = toDbDate(nairobiToday(now));

        const dueContacts = await tx.citizenCaseContact.findMany({
          where: { erasedAt: null, retentionUntil: { lt: today } },
          select: { caseId: true },
          take: 500,
        });
        for (const c of dueContacts) {
          await tx.citizenCaseContact.update({ where: { caseId: c.caseId }, data: { name: null, phone: null, email: null, preference: 'NONE', erasedAt: now } });
          await tx.citizenCase.updateMany({ where: { id: c.caseId, consentToContact: true }, data: { consentToContact: false } });
          await this.audit.record(
            {
              tenantId,
              actorId: null,
              actorType: 'SYSTEM',
              action: AUDIT_ACTIONS.CASE_CONTACT_ERASED,
              entityType: CASE_ENTITY,
              entityId: c.caseId,
              after: { erasedAt: now.toISOString(), trigger: 'RETENTION' },
              reason: `Contact retention period (${config.contactRetentionMonths} months after closure) ended`,
            },
            tx,
          );
        }

        const cutoff = addMonths(now, -config.caseRetentionMonths);
        const dueCases = await tx.citizenCase.findMany({
          where: { status: 'CLOSED', redactedAt: null, closedAt: { lt: cutoff } },
          select: { id: true, category: true, status: true },
          take: 500,
        });
        let casesRedacted = 0;
        for (const row of dueCases) {
          const done = await this.cases.redactInTx(
            tx,
            { tenantId, actorId: null },
            row,
            `Case retention period (${config.caseRetentionMonths} months after closure) ended`,
            'RETENTION',
          );
          if (done) casesRedacted += 1;
        }
        const appointmentCutoff = addMonths(now, -config.contactRetentionMonths);
        const dueAppointments = await tx.appointment.findMany({
          where: {
            contactErasedAt: null,
            status: { in: ['DECLINED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'] },
            OR: [
              { confirmedEnd: { lt: appointmentCutoff } },
              { confirmedEnd: null, confirmedStart: { lt: appointmentCutoff } },
              { confirmedEnd: null, confirmedStart: null, updatedAt: { lt: appointmentCutoff } },
            ],
          },
          select: { id: true },
          take: 500,
        });
        let appointmentContactsErased = 0;
        for (const a of dueAppointments) {
          const done = await eraseAppointmentContactInTx(tx, this.audit, {
            tenantId,
            actorId: null,
            appointmentId: a.id,
            reason: `Contact retention period (${config.contactRetentionMonths} months after the appointment) ended`,
            trigger: 'RETENTION',
          });
          if (done) appointmentContactsErased += 1;
        }
        return { contactsErased: dueContacts.length, casesRedacted, appointmentContactsErased };
      },
      { timeout: 120_000 },
    );
  }
}
