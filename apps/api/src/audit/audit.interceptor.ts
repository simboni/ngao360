import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, mergeMap, type Observable } from 'rxjs';
import type { AppRequest } from '../common/http/app-request';
import { AUDIT_META_KEY, type AuditMeta } from './audit.decorator';
import { AuditService } from './audit.service';

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMeta | undefined>(AUDIT_META_KEY, context.getHandler());
    if (!meta) return next.handle();
    const req = context.switchToHttp().getRequest<AppRequest>();
    return next.handle().pipe(
      mergeMap((result) =>
        from(
          (async () => {
            if (req.auth) {
              const id = getPath(result, meta.idPath ?? 'id');
              await this.audit.record({
                tenantId: req.auth.tenantId,
                action: meta.action,
                entityType: meta.entityType,
                entityId: typeof id === 'string' ? id : null,
                after: result,
              });
            }
            return result;
          })(),
        ),
      ),
    );
  }
}
