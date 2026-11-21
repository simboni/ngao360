'use client';

import type { AgentDetail } from '@ngao360/shared';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ErasureDialog } from '@/components/privacy/erasure-dialog';
import { useTallyActions } from '@/components/tally/action-provider';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { agentErasureBlock } from './agent-erasure-model';

/**
 * Data-subject erasure of an agent's national ID, phone, M-Pesa number and next of kin (API §16,
 * `POST /field/agents/:id/sensitive/erase`, re-authentication, audited; also for withdrawn agents).
 * The button stays visible and is disabled with the reason when the erasure is not available.
 */
export function EraseAgentData({ agent, onErased }: { agent: AgentDetail; onErased: (next: AgentDetail) => void }) {
  const { run } = useTallyActions();
  const [open, setOpen] = useState(false);
  const block = agentErasureBlock(agent);

  return (
    <Card>
      <CardHeader title="Erase personal data" description="For a data-subject request. Withdrawn agents are also erased automatically when retention ends." />
      <CardBody className="space-y-2">
        <Button size="sm" variant="danger" disabled={block !== null} onClick={() => setOpen(true)} aria-describedby="agent-erase-note">
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Erase personal data
        </Button>
        <p id="agent-erase-note" className="text-meta text-slate">
          {block ?? 'Erased data can never be entered again on this record. Recorded in the audit log.'}
        </p>
      </CardBody>
      <ErasureDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Erase agent personal data"
        reference={agent.reference}
        erases="national ID number, phone number, M-Pesa number and next-of-kin details."
        keeps="the agent’s name, deployments, trainings, accreditation and status history, and the audit trail."
        onConfirm={async (reason) => {
          const next = await run(() => api.post<AgentDetail>(`/field/agents/${encodeURIComponent(agent.id)}/sensitive/erase`, { reason }));
          onErased(next);
        }}
      />
    </Card>
  );
}
