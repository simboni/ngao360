import { Injectable } from '@nestjs/common';

/**
 * Agent registry (blueprint 6.3). Personal identifiers and contact details live in
 * agent_sensitive and are read only by the audited reveal (field.agents.reveal_sensitive + reauth);
 * agents.phone_masked / national_id_masked are refreshed whenever they change.
 */
@Injectable()
export class AgentsService {}
