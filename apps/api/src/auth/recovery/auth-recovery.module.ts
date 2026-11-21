import { Module, type OnModuleInit } from '@nestjs/common';
import { JOB_KEYS } from '@ngao360/shared';
import { JobScheduler } from '../../platform/jobs/job-scheduler';
import { AuthModule } from '../auth.module';
import { PasskeysController } from '../passkeys/passkeys.controller';
import { PasskeysService } from '../passkeys/passkeys.service';
import { AccountRecoveryService } from './account-recovery.service';
import { AccountRecoveryAdminController, RecoveryCodesController } from './recovery.controller';
import { RecoveryCodesService } from './recovery-codes.service';

/** Interval of the `auth.recovery_expiry` job. */
export const RECOVERY_EXPIRY_INTERVAL_MS = 15 * 60_000;

/**
 * Passkeys, recovery codes and assisted account recovery (API contract §32). Owner: auth-recovery.
 * Registers the `auth.recovery_expiry` durable job (expire overdue recovery requests, delete
 * spent WebAuthn challenges).
 */
@Module({
  imports: [AuthModule],
  controllers: [PasskeysController, RecoveryCodesController, AccountRecoveryAdminController],
  providers: [PasskeysService, RecoveryCodesService, AccountRecoveryService],
  exports: [PasskeysService, RecoveryCodesService, AccountRecoveryService],
})
export class AuthRecoveryModule implements OnModuleInit {
  constructor(
    private readonly scheduler: JobScheduler,
    private readonly recovery: AccountRecoveryService,
  ) {}

  onModuleInit(): void {
    if (this.scheduler.registered().some((d) => d.key === JOB_KEYS.AUTH_RECOVERY_EXPIRY)) return;
    this.scheduler.register({
      key: JOB_KEYS.AUTH_RECOVERY_EXPIRY,
      everyMs: RECOVERY_EXPIRY_INTERVAL_MS,
      handler: async () => this.recovery.runExpiry(),
    });
  }
}
