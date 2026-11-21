import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { AppointmentDetail, AppointmentSummary, Paginated } from '@ngao360/shared';
import type { AuthContext } from '../../../auth/auth.types';
import { CurrentAuth } from '../../../common/decorators/auth.decorators';
import { RequirePermission, RequireReauth } from '../../../rbac/require-permission.decorator';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import {
  AppointmentQueryDto,
  AppointmentTransitionDto,
  CreateAppointmentDto,
  EraseAppointmentContactDto,
  OfficeIdParamDto,
  UpdateAppointmentDto,
} from '../office.dto';
import { AppointmentsService } from './appointments.service';

/** Appointments and the office diary (docs/API_CONTRACT.md §10.1). Not geographic. */
@RequireModule('office')
@Controller('office/appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  @RequirePermission('office.appointments.view')
  list(@CurrentAuth() auth: AuthContext, @Query() q: AppointmentQueryDto): Promise<Paginated<AppointmentSummary>> {
    return this.appointments.list(auth, q);
  }

  @Get(':id')
  @RequirePermission('office.appointments.view')
  get(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto): Promise<AppointmentDetail> {
    return this.appointments.detail(auth, p.id);
  }

  @Post()
  @RequirePermission('office.appointments.manage')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateAppointmentDto): Promise<AppointmentDetail> {
    return this.appointments.create(auth, body);
  }

  @Patch(':id')
  @RequirePermission('office.appointments.manage')
  update(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: UpdateAppointmentDto): Promise<AppointmentDetail> {
    return this.appointments.update(auth, p.id, body);
  }

  @Post(':id/transition')
  @HttpCode(200)
  @RequirePermission('office.appointments.manage')
  transition(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: AppointmentTransitionDto): Promise<AppointmentDetail> {
    return this.appointments.transition(auth, p.id, body);
  }

  /** Erase the requester's name and contact details (data-subject request). */
  @Post(':id/contact/erase')
  @HttpCode(200)
  @RequirePermission('office.appointments.manage')
  @RequireReauth()
  eraseContact(@CurrentAuth() auth: AuthContext, @Param() p: OfficeIdParamDto, @Body() body: EraseAppointmentContactDto): Promise<AppointmentDetail> {
    return this.appointments.eraseContact(auth, p.id, body);
  }
}
