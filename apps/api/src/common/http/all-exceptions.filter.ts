import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@ngao360/db';
import { type ApiError, ERROR_CODES, type ErrorCode } from '@ngao360/shared';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { RequestContext } from '../context/request-context';
import { AppException } from './app-exception';

const STATUS_CODES: Record<number, ErrorCode> = {
  400: ERROR_CODES.VALIDATION_FAILED,
  401: ERROR_CODES.UNAUTHENTICATED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  413: ERROR_CODES.VALIDATION_FAILED,
  415: ERROR_CODES.VALIDATION_FAILED,
  429: ERROR_CODES.RATE_LIMITED,
};

/** Maps every error to the ApiError shape in @ngao360/shared. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const body = this.toApiError(exception);
    body.requestId = RequestContext.get()?.requestId;
    if (body.statusCode >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(body.statusCode).json(body);
  }

  toApiError(exception: unknown): ApiError {
    if (exception instanceof AppException) {
      const status = exception.getStatus();
      return {
        statusCode: status,
        error: HttpStatus[status] ?? 'Error',
        code: exception.code,
        message: exception.message,
        ...(exception.details !== undefined ? { details: exception.details } : {}),
      };
    }
    if (exception instanceof ZodError) {
      return {
        statusCode: 400,
        error: 'BAD_REQUEST',
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Some fields need attention',
        details: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }
    if (exception instanceof ThrottlerException) {
      return { statusCode: 429, error: 'TOO_MANY_REQUESTS', code: ERROR_CODES.RATE_LIMITED, message: 'Too many requests. Please wait and try again.' };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resp = exception.getResponse();
      const message =
        typeof resp === 'string' ? resp : ((resp as { message?: string | string[] }).message ?? exception.message);
      return {
        statusCode: status,
        error: HttpStatus[status] ?? 'Error',
        code: STATUS_CODES[status] ?? ERROR_CODES.INTERNAL,
        message: Array.isArray(message) ? message.join('; ') : message,
      };
    }
    const msg = exception instanceof Error ? exception.message : '';
    if (msg.includes('IMMUTABLE_RECORD')) {
      return { statusCode: 409, error: 'CONFLICT', code: ERROR_CODES.IMMUTABLE_RECORD, message: 'This record is immutable and cannot be changed or deleted' };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return { statusCode: 409, error: 'CONFLICT', code: ERROR_CODES.CONFLICT, message: 'A record with these details already exists', details: exception.meta };
      }
      if (exception.code === 'P2025') {
        return { statusCode: 404, error: 'NOT_FOUND', code: ERROR_CODES.NOT_FOUND, message: 'Not found' };
      }
      if (exception.code === 'P2003') {
        return { statusCode: 400, error: 'BAD_REQUEST', code: ERROR_CODES.VALIDATION_FAILED, message: 'A referenced record does not exist' };
      }
    }
    if (msg.includes('row-level security') || msg.includes('permission denied')) {
      return { statusCode: 403, error: 'FORBIDDEN', code: ERROR_CODES.FORBIDDEN, message: 'Access denied' };
    }
    return { statusCode: 500, error: 'INTERNAL_SERVER_ERROR', code: ERROR_CODES.INTERNAL, message: 'Something went wrong. The error has been logged.' };
  }
}
