import { Injectable } from '@nestjs/common';

/**
 * War Room aggregation. Station status is derived with deriveStationStatus() from
 * deployments, field reports, incidents and tally intake (matched by station code);
 * commanders may set FLAGGED or CLOSED with a reason (station_status_events, append-only).
 */
@Injectable()
export class WarRoomService {}
