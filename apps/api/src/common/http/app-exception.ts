import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode } from '@ngao360/shared';

/** Throw this for all expected errors so responses carry a stable `code`. */
export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    status: HttpStatus,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }

  static forbidden(message = 'You do not have permission to perform this action', details?: unknown) {
    return new AppException(ERROR_CODES.FORBIDDEN, HttpStatus.FORBIDDEN, message, details);
  }
  static outOfScope(message = 'This record is outside your assigned geography') {
    return new AppException(ERROR_CODES.OUT_OF_SCOPE, HttpStatus.FORBIDDEN, message);
  }
  static unauthenticated(message = 'Authentication required') {
    return new AppException(ERROR_CODES.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, message);
  }
  static notFound(message = 'Not found') {
    return new AppException(ERROR_CODES.NOT_FOUND, HttpStatus.NOT_FOUND, message);
  }
  static conflict(message: string, details?: unknown) {
    return new AppException(ERROR_CODES.CONFLICT, HttpStatus.CONFLICT, message, details);
  }
  static invalidTransition(from: string, to: string) {
    return new AppException(
      ERROR_CODES.INVALID_TRANSITION,
      HttpStatus.CONFLICT,
      `Status change from ${from} to ${to} is not allowed`,
      { from, to },
    );
  }
  /** Blueprint 3.2: submitter, verifier and approver must be different people. */
  static separationOfDuties(message: string) {
    return new AppException(ERROR_CODES.SEPARATION_OF_DUTIES, HttpStatus.FORBIDDEN, message);
  }
  static validation(message: string, details?: unknown) {
    return new AppException(ERROR_CODES.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, message, details);
  }
}
