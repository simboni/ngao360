import { SetMetadata } from '@nestjs/common';

export const AUDIT_META_KEY = 'ngao:audit';

export interface AuditMeta {
  action: string;
  entityType: string;
  /** Dot path into the handler result for the entity id (default "id"). */
  idPath?: string;
}

/**
 * Convenience: record an audit event after the handler succeeds, with the
 * handler result as `after`. Prefer explicit AuditService.record(…, tx) inside
 * the service when a `before` state exists or atomicity matters.
 */
export const Audited = (meta: AuditMeta) => SetMetadata(AUDIT_META_KEY, meta);
