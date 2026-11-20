'use client';

import {
  type CreateDiscrepancy,
  CreateDiscrepancySchema,
  DISCREPANCY_REQUIRED_HANDLING,
  DISCREPANCY_SEVERITIES,
  DISCREPANCY_TYPE_LABELS,
  DISCREPANCY_TYPES,
  type DiscrepancyCaseDetail,
  type DiscrepancySeverity,
  type DiscrepancyType,
} from '@ngao360/shared';
import { Flag } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTallyActions } from './action-provider';
import { Dialog } from './dialog';
import { describeError } from './errors';
import { SelectField } from './fields';
import { Notice } from './notice';
import { tallyApi } from './tally-api';

const SEVERITY_LABELS: Record<DiscrepancySeverity, string> = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' };

/** Open a discrepancy case linked to a submission (POST /tally/discrepancies). Source values are never changed. */
export function FlagDiscrepancyDialog({
  open,
  onClose,
  submissionId,
  reference,
  defaultType = 'METADATA',
  details,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  submissionId: string;
  reference: string;
  defaultType?: DiscrepancyType;
  details?: Record<string, unknown>;
  onCreated: (c: DiscrepancyCaseDetail) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={`Flag a discrepancy on ${reference}`} description="Opens a case for review. The submission and its values stay exactly as they are.">
      {open ? <FlagForm submissionId={submissionId} reference={reference} defaultType={defaultType} details={details} onCancel={onClose} onCreated={onCreated} /> : null}
    </Dialog>
  );
}

function FlagForm({
  submissionId,
  reference,
  defaultType,
  details,
  onCancel,
  onCreated,
}: {
  submissionId: string;
  reference: string;
  defaultType: DiscrepancyType;
  details?: Record<string, unknown>;
  onCancel: () => void;
  onCreated: (c: DiscrepancyCaseDetail) => void;
}) {
  const { run } = useTallyActions();
  const [type, setType] = useState<DiscrepancyType>(defaultType);
  const [severity, setSeverity] = useState<DiscrepancySeverity>('MEDIUM');
  const [title, setTitle] = useState(`${DISCREPANCY_TYPE_LABELS[defaultType]} issue on ${reference}`);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descId = useId();

  const body: CreateDiscrepancy = {
    varianceType: type,
    severity,
    title: title.trim(),
    description: description.trim(),
    links: [{ submissionId, role: 'SOURCE_A' }],
    details: details ?? {},
  };
  const valid = CreateDiscrepancySchema.safeParse(body).success;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated(await run(() => tallyApi.createDiscrepancy(body)));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Issue type"
          value={type}
          onChange={(e) => {
            const t = e.target.value as DiscrepancyType;
            setType(t);
            setTitle(`${DISCREPANCY_TYPE_LABELS[t]} issue on ${reference}`);
          }}
          options={DISCREPANCY_TYPES.map((t) => ({ value: t, label: DISCREPANCY_TYPE_LABELS[t] }))}
        />
        <SelectField
          label="Severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as DiscrepancySeverity)}
          options={DISCREPANCY_SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABELS[s] }))}
        />
      </div>
      <Notice tone="info" title="Required handling">
        {DISCREPANCY_REQUIRED_HANDLING[type]}
      </Notice>
      <div>
        <label htmlFor={titleId} className="ngao-label">
          Title
        </label>
        <input id={titleId} className="ngao-input" maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label htmlFor={descId} className="ngao-label">
          What did you observe? Name the exact fields.
        </label>
        <textarea id={descId} rows={4} maxLength={4000} className="ngao-input h-auto py-2" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid} loading={busy}>
          <Flag className="h-4 w-4" aria-hidden />
          Open case
        </Button>
      </div>
    </form>
  );
}
