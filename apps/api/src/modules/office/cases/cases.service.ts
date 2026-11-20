import { Injectable } from '@nestjs/common';

/**
 * Citizen cases (blueprint 9.2). Contact details live in citizen_case_contacts
 * and are read only by the audited contact endpoint. Also used by the public
 * portal (PublicCasesController) for submission, tracking and feedback.
 */
@Injectable()
export class CasesService {}
