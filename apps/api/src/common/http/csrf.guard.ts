import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { CSRF_HEADER, ERROR_CODES } from '@ngao360/shared';
import type { Request } from 'express';
import { AppException } from './app-exception';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated requests: state-changing requests must
 * carry the custom header `x-ngao-client`. Browsers cannot send custom headers
 * cross-origin without a CORS preflight, which only WEB_ORIGIN passes. Requests
 * authenticated with an Authorization bearer header (non-browser clients) are exempt.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE.has(req.method)) return true;
    if (req.header('authorization')?.startsWith('Bearer ')) return true;
    if (req.header(CSRF_HEADER)) return true;
    throw new AppException(
      ERROR_CODES.CSRF_HEADER_MISSING,
      HttpStatus.FORBIDDEN,
      `Missing ${CSRF_HEADER} header`,
    );
  }
}
