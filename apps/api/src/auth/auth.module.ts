import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from './token.service';
import { SecurityAlertsService } from './recovery/security-alerts.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, TokenService, JwtAuthGuard, SecurityAlertsService],
  exports: [AuthService, TokenService, JwtAuthGuard, SecurityAlertsService],
})
export class AuthModule {}
