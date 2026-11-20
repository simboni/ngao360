import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { AppointmentsService } from './appointments.service';

/** Appointments and the office diary. To implement: docs/API_CONTRACT.md §10.1. */
@RequireModule('office')
@Controller('office/appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}
}
