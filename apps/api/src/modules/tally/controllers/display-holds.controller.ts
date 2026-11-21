import { Controller } from '@nestjs/common';

/**
 * Display holds and redacted copies over HTTP (API contract §35; today CLI only:
 * `pnpm demo:redact-34a`). Owner: field-pin. Routes to add here:
 *   GET  /tally/sources/holds                      list holds in scope (tally.source.download)
 *   GET  /tally/sources/holds/:holdId              detail + signed URL of the redacted copy only
 *   POST /tally/sources/holds/:holdId/redacted-copy attach a redacted copy (tally.approve, re-auth;
 *        not the uploader, not the declarer) via DisplayHoldsService.attachRedactedCopy
 *   POST /tally/sources/holds/:holdId/confirm       confirm a declared redaction (tally.approve, re-auth)
 * The original is never served while held and never altered.
 */
@Controller('tally/sources/holds')
export class DisplayHoldsController {}
