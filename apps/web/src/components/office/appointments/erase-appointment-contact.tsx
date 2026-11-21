'use client';

import type { AppointmentDetail } from '@ngao360/shared';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { TallyActionProvider, useTallyActions } from '@/components/tally/action-provider';
import { ErasureDialog } from '@/components/privacy/erasure-dialog';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { appointmentErasureBlock } from './appointment-model';

/**
 * Data-subject erasure of an appointment requester's name and contact details (API §10,
 * `POST /office/appointments/:id/contact/erase`, re-authentication, audited). The button stays
 * visible and is disabled with the reason when the erasure is not available.
 */
export function EraseAppointmentContact({ appt, onErased }: { appt: AppointmentDetail; onErased: (next: AppointmentDetail) => void }) {
  return (
    <TallyActionProvider>
      <EraseAppointmentContactInner appt={appt} onErased={onErased} />
    </TallyActionProvider>
  );
}

function EraseAppointmentContactInner({ appt, onErased }: { appt: AppointmentDetail; onErased: (next: AppointmentDetail) => void }) {
  const { can } = useAuth();
  const { run } = useTallyActions();
  const [open, setOpen] = useState(false);
  const block = appointmentErasureBlock(appt, can('office.appointments.manage'));

  return (
    <section aria-labelledby="appt-privacy">
      <h3 id="appt-privacy" className="mb-2 text-meta font-semibold uppercase tracking-wide text-slate">
        Privacy
      </h3>
      {appt.contactErasedAt ? (
        <p className="mb-2 text-body text-slate">Requester details erased on {formatDateTime(appt.contactErasedAt)}.</p>
      ) : null}
      <Button size="sm" variant="danger" disabled={block !== null} onClick={() => setOpen(true)} aria-describedby="appt-erase-note">
        <Trash2 className="h-3.5 w-3.5" aria-hidden /> Erase requester details
      </Button>
      <p id="appt-erase-note" className="mt-1 text-meta text-slate">
        {block ?? 'For a data-subject request. Ended appointments are also erased automatically when retention ends.'}
      </p>
      <ErasureDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Erase requester details"
        reference={appt.reference}
        erases="the requester’s name, organisation, phone number and email address."
        keeps="the appointment itself (purpose, timing, outcome) and its audit history."
        onConfirm={async (reason) => {
          const next = await run(() => api.post<AppointmentDetail>(`/office/appointments/${encodeURIComponent(appt.id)}/contact/erase`, { reason }));
          onErased(next);
        }}
      />
    </section>
  );
}
