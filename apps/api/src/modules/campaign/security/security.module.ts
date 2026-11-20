import { Module } from '@nestjs/common';
import { BreachesController } from './breaches.controller';
import { BreachesService } from './breaches.service';

@Module({
  controllers: [BreachesController],
  providers: [BreachesService],
  exports: [BreachesService],
})
export class SecurityModule {}
