import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { CONTENT_FORBIDDEN_FIELDS } from '@ngao360/shared';
import { AppException } from '../../../common/http/app-exception';

/**
 * Political boundary (blueprint 5.4, 15.2): request bodies that carry
 * recipient-list fields (voter ids, phone lists, target lists, SMS blasts) are
 * refused with 400 before validation strips them, so nobody mistakes the
 * platform for an outreach tool.
 */
@Injectable()
export class RefuseRecipientFieldsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const body = context.switchToHttp().getRequest<{ body?: unknown }>().body;
    if (body && typeof body === 'object') {
      const found = CONTENT_FORBIDDEN_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(body, k));
      if (found.length) {
        throw AppException.validation(
          'This platform does not hold recipient lists or send bulk messages',
          found.map((k) => ({ path: k, message: 'Recipient lists, voter data and bulk outreach are not supported' })),
        );
      }
    }
    return true;
  }
}
