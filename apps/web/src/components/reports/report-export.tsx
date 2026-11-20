'use client';

/**
 * Report export (blueprint 10.2 steps 6–7; API §28 POST /reports/exports).
 * Shows the classification, the permissions the export needs (from the
 * preview's `exportRequirements`) and, for sensitive results and finance, asks
 * for a reason and a fresh re-authentication. The file carries generation
 * time, filters, applied scope, classification and the dataset disclaimer.
 */
import { type ExportFormat, PARALLEL_TALLY_DISCLAIMER, type ReportDefinition, type ReportPreview } from '@ngao360/shared';
import { Download, Lock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { FormField, SensitivityBadge, textareaClass } from '@/components/office/correspondence/office-common';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { missingPermissions } from './report-model';
import { type ReportExportResult, reportsApi } from './reports-api';

const isCancelled = (err: unknown) => err instanceof Error && err.message === 'Confirmation cancelled';

export function ReportExportPanel({
  preview,
  definition,
  templateId,
}: {
  preview: ReportPreview | null;
  /** The definition being exported (ignored when `templateId` is given and unchanged). */
  definition: ReportDefinition | null;
  templateId?: string | null;
}) {
  const { me } = useAuth();
  const highRisk = useHighRisk();
  const held = new Set<string>(me?.permissions ?? []);
  const [format, setFormat] = useState<ExportFormat>('XLSX');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReportExportResult | null>(null);

  if (!preview || !definition) return <p className="text-body text-slate">Run the preview first: the export uses the same definition and shows what it needs.</p>;

  const req = preview.exportRequirements;
  const missing = missingPermissions(req.permissions, held);
  const sensitive = req.reauth;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { format, ...(templateId ? { templateId } : { definition }), ...(reason.trim() ? { reason: reason.trim() } : {}) };
      const run = () => reportsApi.createExport(body);
      setResult(sensitive ? await highRisk(run) : await run());
    } catch (err) {
      if (!isCancelled(err)) setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-body text-ink">
        <Lock className="h-4 w-4 text-slate" aria-hidden />
        Data classification of this export: <SensitivityBadge level={preview.classification} />
      </div>
      <ul className="list-disc space-y-1 pl-5 text-body text-ink">
        <li>
          Needs: {req.permissions.join(', ')}
          {sensitive ? ' and a password confirmation' : ''}.
        </li>
        <li>Rows: {preview.rowCount.toLocaleString('en-KE')} matching your scope ({preview.appliedScope}).</li>
        <li>Filters: {preview.filtersDescription || 'none'}.</li>
        <li>The file header records the report name, generation time (Africa/Nairobi and UTC), you as generator, the filters, scope and classification.</li>
      </ul>
      {preview.disclaimer ? (
        <Notice tone="warning" title={preview.disclaimer === PARALLEL_TALLY_DISCLAIMER ? 'Unofficial: internal parallel tally' : 'Disclaimer carried in the file'}>
          {preview.disclaimer}
        </Notice>
      ) : null}
      {!req.allowed || missing.length ? (
        <Notice tone="sod" title="You cannot export this report">
          {missing.length ? `You are missing ${missing.join(', ')}.` : 'The API does not allow this export for you.'} You can still preview it and save it as a template.
        </Notice>
      ) : result ? (
        <div className="space-y-3">
          <Notice tone="success" title="Export ready and recorded">
            {result.rowCount.toLocaleString('en-KE')} rows · generated {formatDateTime(result.generatedAt)} · link expires {formatDateTime(result.expiresAt)}
            {result.sha256 ? (
              <>
                {' '}
                · SHA-256 <span className="font-mono text-[12px]">{result.sha256.slice(0, 16)}…</span>
              </>
            ) : null}
          </Notice>
          <a href={result.url} download className="inline-flex h-10 items-center gap-2 rounded-lg bg-teal px-4 text-body font-medium text-white hover:bg-teal/90">
            <Download className="h-4 w-4" aria-hidden />
            Download ({result.format})
          </a>
          <div>
            <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
              Export again
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="max-w-xl">
          <FormField id="rx-format" label="Format" required>
            <select id="rx-format" className="ngao-input pr-8" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
              <option value="XLSX">Excel (XLSX)</option>
              <option value="CSV">CSV</option>
              <option value="PDF">PDF</option>
            </select>
          </FormField>
          <FormField
            id="rx-reason"
            label="Reason for the export"
            required={sensitive}
            hint={sensitive ? 'Sensitive export: the reason is recorded with the export and in the audit log.' : 'Recorded with the export.'}
          >
            <textarea id="rx-reason" className={textareaClass} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          {error ? <Notice tone="error" className="mb-4">{error}</Notice> : null}
          <Button type="submit" loading={busy} disabled={sensitive && reason.trim().length < 3}>
            {sensitive ? <ShieldCheck className="h-4 w-4" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
            {sensitive ? 'Confirm and export' : 'Export'}
          </Button>
        </form>
      )}
    </div>
  );
}
