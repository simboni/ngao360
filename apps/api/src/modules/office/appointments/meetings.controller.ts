import { Controller } from '@nestjs/common';
import { RequireModule } from '../../../tenant-modules/require-module.decorator';
import { MeetingsService } from './meetings.service';

/** Meetings, minutes, action items and decision log. To implement: docs/API_CONTRACT.md §10.2. */
@RequireModule('office')
@Controller('office/meetings')
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}
}
