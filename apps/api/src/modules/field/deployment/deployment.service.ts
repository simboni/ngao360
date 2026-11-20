import { Injectable } from '@nestjs/common';

/**
 * Deployments keyed by station code (station lineage). Replacement keeps the original
 * row (REPLACED) and links the successor; deployment_events is append-only.
 */
@Injectable()
export class DeploymentService {}
