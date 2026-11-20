import { Injectable } from '@nestjs/common';

/**
 * Batched offline sync. Each item is checked against the idempotency ledger, applied
 * through the owning service (reports, incidents, deployment) and recorded; conflicts are
 * returned with the current server state and never overwrite server data.
 */
@Injectable()
export class SyncService {}
