import { Module } from '@nestjs/common';

/**
 * Passkeys, recovery codes and assisted account recovery (API contract §32). Owner: auth-recovery.
 * Registered in AppModule so controllers and providers can be added here without touching
 * app.module.ts or auth.module.ts. Import AuthModule here when AuthService / TokenService are needed.
 */
@Module({})
export class AuthRecoveryModule {}
