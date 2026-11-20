'use client';

import type { RegistryVersion } from '@ngao360/shared';
import { REGISTRY_OPTIONAL_COLUMNS, REGISTRY_REQUIRED_COLUMNS, type RegistryImportOutcome } from '@ngao360/shared';
import { FileUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, Field, Notice, TextInput } from '@/components/admin/primitives';
import { describeError } from '@/components/admin/use-api';
import { api, ApiRequestError } from '@/lib/api-client';
import { formatNumber } from '@/lib/format';
import { ImportReportView } from './import-report';

type Step = 'choose' | 'validated' | 'importing' | 'done';

/**
 * CSV registry import (S12): validate first (dry run, nothing stored), review
 * the report, then import. Large files are queued and polled.
 */
export function RegistryImportDialog({ version, open, onClose, onImported }: { version: RegistryVersion; open: boolean; onClose: () => void; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [publicationDate, setPublicationDate] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [changeNotes, setChangeNotes] = useState('');
  const [step, setStep] = useState<Step>('choose');
  const [outcome, setOutcome] = useState<RegistryImportOutcome | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setPublicationDate('');
    setSourceUrl('');
    setChangeNotes('');
    setStep('choose');
    setOutcome(null);
    setError(null);
  }, [open]);
  useEffect(() => () => {
    if (poll.current) window.clearInterval(poll.current);
  }, []);

  const form = (dryRun: boolean) => {
    const fd = new FormData();
    fd.set('file', file!);
    fd.set('dryRun', String(dryRun));
    if (publicationDate) fd.set('publicationDate', publicationDate);
    if (sourceUrl) fd.set('sourceUrl', sourceUrl);
    if (changeNotes) fd.set('changeNotes', changeNotes);
    return fd;
  };

  const validate = async () => {
    setBusy(true);
    setError(null);
    try {
      setOutcome(await api.post<RegistryImportOutcome>(`/reference/registry-versions/${version.id}/import`, form(true)));
      setStep('validated');
    } catch (err) {
      const report = err instanceof ApiRequestError ? (err.body.details as { report?: RegistryImportOutcome['report'] } | undefined)?.report : undefined;
      if (report) {
        setOutcome({ registryVersionId: version.id, unitsCreated: 0, stationsCreated: 0, rowsRejected: report.totals.rowsRejected, errors: [], status: 'FAILED', dryRun: true, report });
        setStep('validated');
      } else setError(err);
    } finally {
      setBusy(false);
    }
  };

  const importNow = async () => {
    setBusy(true);
    setError(null);
    setStep('importing');
    try {
      const res = await api.post<RegistryImportOutcome>(`/reference/registry-versions/${version.id}/import`, form(false));
      setOutcome(res);
      if (res.status === 'QUEUED' || res.status === 'RUNNING') {
        poll.current = window.setInterval(async () => {
          try {
            const s = await api.get<RegistryImportOutcome>(`/reference/registry-versions/${version.id}/import-status`);
            setOutcome(s);
            if (s.status === 'COMPLETED' || s.status === 'FAILED') {
              if (poll.current) window.clearInterval(poll.current);
              setStep('done');
              setBusy(false);
              onImported();
            }
          } catch (err) {
            if (poll.current) window.clearInterval(poll.current);
            setError(err);
            setBusy(false);
          }
        }, 3000);
        return;
      }
      setStep('done');
      onImported();
    } catch (err) {
      setError(err);
      setStep('validated');
    }
    setBusy(false);
  };

  const fatal = outcome?.report.fatal ?? false;

  return (
    <Dialog open={open} onClose={onClose} size="lg" title={`Import stations into version ${version.version}`} description="The original file is stored unchanged with its SHA-256 hash. Imports never overwrite existing stations.">
      {step === 'choose' || (step === 'validated' && !outcome) ? (
        <>
          <Field label="CSV file" htmlFor="reg-file" required hint={`Required columns: ${REGISTRY_REQUIRED_COLUMNS.join(', ')}. Optional: ${REGISTRY_OPTIONAL_COLUMNS.join(', ')}.`}>
            <input id="reg-file" type="file" accept=".csv,text/csv" className="block w-full text-body file:mr-3 file:rounded-lg file:border file:border-line file:bg-cloud file:px-3 file:py-2" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            <Field label="Publication date of the source" htmlFor="reg-pub">
              <TextInput id="reg-pub" type="date" value={publicationDate} onChange={(e) => setPublicationDate(e.target.value)} />
            </Field>
            <Field label="Source URL" htmlFor="reg-url">
              <TextInput id="reg-url" type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://" />
            </Field>
          </div>
          <Field label="Change notes" htmlFor="reg-notes">
            <TextInput id="reg-notes" value={changeNotes} onChange={(e) => setChangeNotes(e.target.value)} maxLength={2000} />
          </Field>
        </>
      ) : null}

      {outcome && step !== 'choose' ? (
        <>
          {step === 'importing' ? (
            <Notice tone="info" className="mb-4" title={outcome.status === 'QUEUED' || outcome.status === 'RUNNING' ? `Import ${outcome.status.toLowerCase()}` : 'Importing…'}>
              Large registries are imported in the background. You can close this window; the status is kept with the version.
            </Notice>
          ) : null}
          {step === 'done' ? (
            outcome.status === 'FAILED' ? (
              <Notice tone="danger" className="mb-4" title="Import failed">
                {outcome.errors[0]?.message ?? 'The import did not complete.'}
              </Notice>
            ) : (
              <Notice tone="success" className="mb-4" title="Import complete">
                {formatNumber(outcome.stationsCreated)} stations and {formatNumber(outcome.unitsCreated)} geographic units were created. Review the stations, then ask an approver to approve this version.
              </Notice>
            )
          ) : null}
          <ImportReportView report={outcome.report} />
        </>
      ) : null}

      {error ? <Notice tone="danger" className="mt-4">{describeError(error)}</Notice> : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {step === 'done' ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {step === 'importing' ? 'Close' : 'Cancel'}
            </Button>
            {step === 'validated' ? (
              <Button variant="secondary" onClick={() => setStep('choose')} disabled={busy}>
                Choose another file
              </Button>
            ) : null}
            {step === 'choose' ? (
              <Button onClick={() => void validate()} loading={busy} disabled={!file}>
                <FileUp className="h-4 w-4" aria-hidden /> Validate file
              </Button>
            ) : null}
            {step === 'validated' ? (
              <Button onClick={() => void importNow()} loading={busy} disabled={fatal}>
                Import {formatNumber(outcome?.report.totals.rowsAccepted ?? 0)} rows
              </Button>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}
