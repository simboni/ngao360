import type { AgentDetail } from '@ngao360/shared';

/**
 * Why erasing an agent's personal data (API `POST /field/agents/:id/sensitive/erase`) is not
 * available, or null when it is. Mirrors the API: the same grant as revealing the data
 * (`field.agents.reveal_sensitive` over the agent's home area, `reveal_sensitive` in the allowed
 * actions, never on one's own record); nothing to erase once no value is held.
 */
export function agentErasureBlock(a: Pick<AgentDetail, 'allowedActions' | 'phoneMasked' | 'nationalIdMasked' | 'hasMpesaNumber' | 'hasNextOfKin'>): string | null {
  if (!a.allowedActions.includes('reveal_sensitive')) {
    return 'Erasing needs permission to handle this agent’s personal data in their home area, and nobody may erase their own agent record.';
  }
  if (!a.phoneMasked && !a.nationalIdMasked && !a.hasMpesaNumber && !a.hasNextOfKin) {
    return 'No personal data is held for this agent (never recorded, or already erased).';
  }
  return null;
}
