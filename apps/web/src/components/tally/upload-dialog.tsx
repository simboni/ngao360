'use client';

import {
  ALLOWED_SOURCE_MIME_TYPES,
  type Contest,
  type CreateSubmission,
  CreateSubmissionSchema,
  type ElectionCycle,
  HASH_CAVEAT,
  IMAGE_QUALITY_LEVELS,
  type ImageQuality,
  MAX_SOURCE_FILE_BYTES,
  SUBMISSION_SOURCE_TYPE_LABELS,
  SUBMISSION_SOURCE_TYPES,
  type SubmissionDetail,
  type SubmissionSourceType,
} from '@ngao360/shared';
import { FileUp } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from './dialog';
import { describeError } from './errors';
import { SelectField } from './fields';
import { formatBytes, newIdempotencyKey, sha256Hex } from './file-hash';
import { EMPTY_GEO, GeographyCascade, type GeoSelection } from './geography-cascade';
import { Notice } from './notice';
import { tallyApi } from './tally-api';
import { useAsync } from './use-async';

const QUALITY_LABELS: Record<ImageQuality, string> = {
  GOOD: 'Good',
  ACCEPTABLE: 'Acceptable',
  POOR: 'Poor (opens an image-quality case)',
  ILLEGIBLE: 'Illegible (opens an image-quality case)',
};

const TALLY_CENTRE_LEVEL: Record<string, string> = { CONSTITUENCY: 'CONSTITUENCY', COUNTY: 'COUNTY', NATIONAL: 'NATIONAL' };

/** Validate a chosen file against the shared upload rules (blueprint 15.1). */
export function checkSourceFile(file: { type: string; size: number }): string | null {
  if (!(ALLOWED_SOURCE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'Upload a JPEG, PNG, WebP, HEIC image or a PDF of the form.';
  }
  if (file.size > MAX_SOURCE_FILE_BYTES) return `The file is larger than ${formatBytes(MAX_SOURCE_FILE_BYTES)}.`;
  if (file.size === 0) return 'The file is empty.';
  return null;
}

/**
 * S18 upload dialog: contest, form template, geography (cascading) or tally
 * centre, source type and the original file. The original is stored unchanged
 * and hashed server-side; the hash shown here is computed in the browser so the
 * uploader can compare it with the stored record.
 */
export function UploadDialog({
  open,
  onClose,
  cycle,
  contests,
  initialContestId,
  onUploaded,
}: {
  open: boolean;
  onClose: () => void;
  cycle: ElectionCycle;
  contests: Contest[];
  initialContestId?: string | null;
  onUploaded: (s: SubmissionDetail) => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Upload result form"
      description="Upload a copy of a completed official form received through an authorised channel. The original file is preserved unchanged."
    >
      {open ? (
        <UploadForm cycle={cycle} contests={contests} initialContestId={initialContestId} onCancel={onClose} onUploaded={onUploaded} />
      ) : null}
    </Dialog>
  );
}

function UploadForm({
  cycle,
  contests,
  initialContestId,
  onCancel,
  onUploaded,
}: {
  cycle: ElectionCycle;
  contests: Contest[];
  initialContestId?: string | null;
  onCancel: () => void;
  onUploaded: (s: SubmissionDetail) => void;
}) {
  const [contestId, setContestId] = useState(initialContestId ?? contests[0]?.id ?? '');
  const contest = contests.find((c) => c.id === contestId) ?? null;
  const [templateId, setTemplateId] = useState('');
  const [geo, setGeo] = useState<GeoSelection>(EMPTY_GEO);
  const [tallyCentreId, setTallyCentreId] = useState('');
  const [sourceType, setSourceType] = useState<SubmissionSourceType>('CLERK_UPLOAD');
  const [imageQuality, setImageQuality] = useState<ImageQuality | ''>('');
  const [pageCount, setPageCount] = useState('');
  const [formSerial, setFormSerial] = useState('');
  const [stampObserved, setStampObserved] = useState<'' | 'yes' | 'no'>('');
  const [signatureObserved, setSignatureObserved] = useState<'' | 'yes' | 'no'>('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per dialog session, so a retried upload returns the original record.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const fileId = useId();
  const serialId = useId();
  const pagesId = useId();

  const templates = useAsync(() => tallyApi.formTemplates(cycle.id, contest!.officeType), [cycle.id, contest?.officeType], !!contest);
  const capturable = useMemo(
    () => (templates.data?.items ?? []).filter((t) => t.formLevel !== 'CERTIFICATE' && t.approvalState === 'APPROVED'),
    [templates.data],
  );
  const template = capturable.find((t) => t.id === templateId) ?? null;
  const stationLevel = template?.formLevel === 'POLLING_STATION';
  const centreLevel = template ? TALLY_CENTRE_LEVEL[template.formLevel] : undefined;
  const centres = useAsync(() => tallyApi.tallyCentres(cycle.id, centreLevel), [cycle.id, centreLevel], !!centreLevel);

  useEffect(() => {
    // Default to the station-level form (e.g. 37A) for the chosen contest.
    if (!templateId && capturable.length > 0) {
      setTemplateId((capturable.find((t) => t.formLevel === 'POLLING_STATION') ?? capturable[0]!).id);
    }
  }, [capturable, templateId]);

  const fixedCountyId = contest && ['GOVERNOR', 'SENATOR', 'WOMAN_REPRESENTATIVE'].includes(contest.officeType) ? contest.geographicUnitId : null;

  const onFile = async (f: File | null) => {
    setFile(f);
    setHash(null);
    setFileError(f ? checkSourceFile(f) : null);
    if (f && !checkSourceFile(f)) {
      try {
        setHash(await sha256Hex(f));
      } catch {
        setHash(null);
      }
    }
  };

  const metadata: CreateSubmission | null = useMemo(() => {
    if (!contest || !template) return null;
    const parsed = CreateSubmissionSchema.safeParse({
      electionCycleId: cycle.id,
      contestId: contest.id,
      formTemplateId: template.id,
      pollingStationId: stationLevel ? geo.pollingStationId || null : null,
      tallyCentreId: !stationLevel ? tallyCentreId || null : null,
      sourceType,
      idempotencyKey,
      declaration: {
        ...(formSerial.trim() ? { formSerial: formSerial.trim() } : {}),
        ...(stampObserved ? { stampObserved: stampObserved === 'yes' } : {}),
        ...(signatureObserved ? { presidingOfficerSignatureObserved: signatureObserved === 'yes' } : {}),
      },
      ...(imageQuality ? { imageQuality } : {}),
      ...(pageCount ? { pageCount: Number(pageCount) } : {}),
    });
    return parsed.success ? parsed.data : null;
  }, [contest, template, cycle.id, stationLevel, geo.pollingStationId, tallyCentreId, sourceType, idempotencyKey, formSerial, stampObserved, signatureObserved, imageQuality, pageCount]);

  const canSubmit = !!metadata && !!file && !fileError && !busy;

  const submit = async () => {
    if (!metadata || !file) return;
    setBusy(true);
    setError(null);
    try {
      onUploaded(await tallyApi.createSubmission(file, metadata));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <section className="grid gap-3 sm:grid-cols-2" aria-label="Contest and form">
        <SelectField
          label="Contest"
          value={contestId}
          onChange={(e) => {
            setContestId(e.target.value);
            setTemplateId('');
            setGeo(EMPTY_GEO);
          }}
          options={contests.map((c) => ({ value: c.id, label: c.name }))}
        />
        <SelectField
          label="Form and template version"
          value={templateId}
          onChange={(e) => {
            setTemplateId(e.target.value);
            setTallyCentreId('');
          }}
          placeholder={templates.loading ? 'Loading…' : capturable.length === 0 ? 'No approved templates' : undefined}
          options={capturable.map((t) => ({ value: t.id, label: `Form ${t.formNumber} v${t.version} · ${t.title}` }))}
          hint="Only approved templates for this cycle are listed."
        />
      </section>

      {template ? (
        stationLevel ? (
          <GeographyCascade electionCycleId={cycle.id} value={geo} onChange={setGeo} fixedCountyId={fixedCountyId} />
        ) : (
          <SelectField
            label="Tally centre"
            value={tallyCentreId}
            onChange={(e) => setTallyCentreId(e.target.value)}
            placeholder={centres.loading ? 'Loading…' : 'Select tally centre'}
            options={(centres.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.code} ${c.name}` }))}
          />
        )
      ) : null}

      <section className="grid gap-3 sm:grid-cols-3" aria-label="Source">
        <SelectField
          label="Source type"
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value as SubmissionSourceType)}
          options={SUBMISSION_SOURCE_TYPES.map((s) => ({ value: s, label: SUBMISSION_SOURCE_TYPE_LABELS[s] }))}
        />
        <SelectField
          label="Image quality (your observation)"
          value={imageQuality}
          onChange={(e) => setImageQuality(e.target.value as ImageQuality | '')}
          placeholder="Not recorded"
          options={IMAGE_QUALITY_LEVELS.map((q) => ({ value: q, label: QUALITY_LABELS[q] }))}
        />
        <div>
          <label htmlFor={pagesId} className="ngao-label">
            Page count
          </label>
          <input id={pagesId} type="number" min={1} max={20} className="ngao-input" value={pageCount} onChange={(e) => setPageCount(e.target.value)} />
        </div>
      </section>

      <details className="rounded-lg border border-line px-3 py-2">
        <summary className="cursor-pointer text-body font-medium text-ink">Declaration details (optional)</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor={serialId} className="ngao-label">
              Form serial as printed
            </label>
            <input id={serialId} className="ngao-input" maxLength={64} value={formSerial} onChange={(e) => setFormSerial(e.target.value)} />
          </div>
          <SelectField
            label="Stamp visible"
            value={stampObserved}
            onChange={(e) => setStampObserved(e.target.value as '' | 'yes' | 'no')}
            placeholder="Not recorded"
            options={[
              { value: 'yes', label: 'Yes, observed' },
              { value: 'no', label: 'No, not observed' },
            ]}
          />
          <SelectField
            label="Presiding officer signature visible"
            value={signatureObserved}
            onChange={(e) => setSignatureObserved(e.target.value as '' | 'yes' | 'no')}
            placeholder="Not recorded"
            options={[
              { value: 'yes', label: 'Yes, observed' },
              { value: 'no', label: 'No, not observed' },
            ]}
          />
        </div>
        <p className="mt-2 text-meta text-slate">These are human observations only. Software cannot establish that a stamp or signature is genuine.</p>
      </details>

      <section aria-label="File">
        <label htmlFor={fileId} className="ngao-label">
          Original form (image or PDF, up to {formatBytes(MAX_SOURCE_FILE_BYTES)})
        </label>
        <input
          id={fileId}
          type="file"
          accept={ALLOWED_SOURCE_MIME_TYPES.join(',')}
          aria-invalid={!!fileError}
          className="block w-full text-body file:mr-3 file:rounded-lg file:border file:border-line file:bg-cloud file:px-3 file:py-2 file:text-body file:font-medium"
          onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
        />
        {fileError ? <p className="mt-1 text-meta text-error">{fileError}</p> : null}
        {file && !fileError ? (
          <p className="mt-1 break-all text-meta text-slate">
            {file.name} · {formatBytes(file.size)} · SHA-256 {hash ?? 'calculating…'}
          </p>
        ) : null}
        <p className="mt-1 text-meta text-slate">{HASH_CAVEAT}</p>
      </section>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit} loading={busy}>
          <FileUp className="h-4 w-4" aria-hidden />
          Upload form
        </Button>
      </div>
    </form>
  );
}
