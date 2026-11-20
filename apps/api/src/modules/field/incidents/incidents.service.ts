import { Injectable } from '@nestjs/common';

/**
 * Incidents (blueprint 7.3). The original report is immutable (DB trigger); triage,
 * assignment, escalation, notes, corrections, referrals, resolution and closure are
 * incident_events. Closure needs a reviewer other than the reporter and the resolver.
 * The restricted subject record needs field.incidents.view_subject and every read is audited.
 */
@Injectable()
export class IncidentsService {}
