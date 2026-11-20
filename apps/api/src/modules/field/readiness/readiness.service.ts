import { Injectable } from '@nestjs/common';

/**
 * Readiness checklists per station code and cycle; the checklist status is derived
 * from its items with deriveReadinessStatus() on every change.
 */
@Injectable()
export class ReadinessService {}
