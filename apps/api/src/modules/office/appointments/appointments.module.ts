import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './meetings.service';

/** Appointments and meetings. Owner: correspondence/appointments agent. */
@Module({
  controllers: [AppointmentsController, MeetingsController],
  providers: [AppointmentsService, MeetingsService],
  exports: [AppointmentsService, MeetingsService],
})
export class AppointmentsModule {}
