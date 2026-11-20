'use client';

import { type CaseContact, type CaseDetail, CONTACT_PREFERENCE_LABELS, type ContactPreference } from '@ngao360/shared';
import { Eye, EyeOff, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import { ReasonDialog, useHighRisk } from '@/components/admin/reauth';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { casesApi } from './case-api';
import { describeCaseError } from './case-form';

/**
 * Requester contact (API §11 contact endpoints). Hidden until the officer
 * asks for it; each reveal is audited (`CASE_CONTACT_VIEWED`). The details
 * live only in this component's memory and are dropped when hidden.
 */
export function CaseContactCard({ detail }: { detail: CaseDetail }) {
  const { can } = useAuth();
  const highRisk = useHighRisk();
  const [contact, setContact] = useState<CaseContact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [erasing, setErasing] = useState(false);
  const canView = detail.allowedActions.includes('view_contact');
  const canErase = can('office.cases.close');

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      setContact(await casesApi.contact(detail.id));
    } catch (err) {
      setError(describeCaseError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Requester contact" description="Stored apart from the case. Never shared without consent." />
      <CardBody className="space-y-3 text-body">
        {!detail.hasContact ? (
          <p className="flex items-center gap-2 text-slate">
            <UserRound className="h-4 w-4" aria-hidden />
            No contact details were given. The requester follows progress with the reference and tracking code.
          </p>
        ) : (
          <>
            <p className="flex items-center gap-2 text-ink">
              <ShieldCheck className="h-4 w-4 text-deep-blue" aria-hidden />
              {detail.consentToContact ? 'The requester agreed to be contacted.' : 'The requester did not agree to be contacted.'}
            </p>
            {contact ? (
              <div className="rounded-lg border border-line bg-cloud p-3">
                {contact.erasedAt ? (
                  <p className="text-slate">Contact details were erased on {formatDateTime(contact.erasedAt)}.</p>
                ) : (
                  <dl className="space-y-1">
                    <Row label="Name" value={contact.name} />
                    <Row label="Phone" value={contact.phone} />
                    <Row label="Email" value={contact.email} />
                    <Row label="Prefers" value={CONTACT_PREFERENCE_LABELS[contact.preference as ContactPreference] ?? contact.preference} />
                    <Row label="Language" value={contact.preferredLanguage === 'sw' ? 'Kiswahili' : contact.preferredLanguage === 'en' ? 'English' : contact.preferredLanguage} />
                    <Row label="Delete after" value={contact.retentionUntil ?? 'Set when the case is closed'} />
                  </dl>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setContact(null)}>
                    <EyeOff className="h-3.5 w-3.5" aria-hidden />
                    Hide
                  </Button>
                  {canErase && !contact.erasedAt ? (
                    <Button size="sm" variant="danger" onClick={() => setErasing(true)}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      Erase contact details
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : canView ? (
              <Button size="sm" variant="secondary" loading={busy} onClick={() => void reveal()}>
                <Eye className="h-3.5 w-3.5" aria-hidden />
                Show contact details
              </Button>
            ) : (
              <p className="text-slate">You do not have access to contact details.</p>
            )}
            {canView && !contact ? <p className="text-meta text-slate">Showing the details is recorded in the audit log with your name.</p> : null}
          </>
        )}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </CardBody>
      <ReasonDialog
        open={erasing}
        onClose={() => setErasing(false)}
        title="Erase contact details"
        description="Use for a data-subject request or when retention ends. Name, phone and email are deleted; the case itself stays. This cannot be undone."
        confirmLabel="Erase"
        tone="danger"
        onConfirm={async (reason) => {
          setContact(await highRisk(() => casesApi.eraseContact(detail.id, { reason })));
        }}
      />
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
      <dt className="text-slate">{label}</dt>
      <dd className="break-words text-ink">{value || '—'}</dd>
    </div>
  );
}
