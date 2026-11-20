'use client';

/**
 * Finance register export (API §27.1 POST /finance/exports; blueprint 10.2
 * step 7): needs finance.export AND reports.export_sensitive, a reason and a
 * fresh re-authentication. The file header carries generation time, filters,
 * classification and the unverified-limit label; the export is logged and
 * audited by the API.
 */
import type { FinanceExportRequest, SignedUrlResponse } from '@ngao360/shared';
import { Download, Lock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { FormField, SensitivityBadge, textareaClass } from '@/components/office/correspondence/office-common';
import { describeCampaignError } from '@/components/org/campaign-common';
import { Dialog } from '@/components/tally/dialog';
import { Notice } from '@/components/tally/notice';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { financeApi } from './finance-api';

export const FINANCE_REGISTER_LABELS: Record<FinanceExportRequest['register'], string> = {
  LEDGER: 'Full ledger',
  CONTRIBUTIONS: 'Contribution register',
  EXPENDITURE: 'Expenditure register',
  BUDGET_VS_ACTUAL: 'Budget vs actual',
};

/** Permissions a finance export needs (both, plus re-authentication). */
export const FINANCE_EXPORT_PERMISSIONS = ['finance.export', 'reports.export_sensitive'] as const;

export function missingExportPermissions(perms: ReadonlySet<string>): string[] {
  return FINANCE_EXPORT_PERMISSIONS.filter((p) => !perms.has(p));
}

export function FinanceExportDialog({
  open,
  onClose,
  defaultRegister = 'LEDGER',
  defaultFrom,
  defaultTo,
}: {
  open: boolean;
  onClose: () => void;
  defaultRegister?: FinanceExportRequest['register'];
  defaultFrom?: string;
  defaultTo?: string;
}) {
  const { me } = useAuth();
  const highRisk = useHighRisk();
  const perms = new Set<string>(me?.permissions ?? []);
  const missing = missingExportPermissions(perms);
  const [register, setRegister] = useState<FinanceExportRequest['register']>(defaultRegister);
  const [format, setFormat] = useState<FinanceExportRequest['format']>('XLSX');
  const [from, setFrom] = useState(defaultFrom ?? '');
  const [to, setTo] = useState(defaultTo ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SignedUrlResponse | null>(null);

  const close = () => {
    setResult(null);
    setError(null);
    setReason('');
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: FinanceExportRequest = { register, format, reason: reason.trim(), ...(from ? { from } : {}), ...(to ? { to } : {}) };
      setResult(await highRisk(() => financeApi.exportRegister(body)));
    } catch (err) {
      if (!(err instanceof Error && err.message === 'Confirmation cancelled')) setError(describeCampaignError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Export a finance register"
      description="Finance exports are sensitive. You will be asked to confirm your password; the export, its filters and your reason are recorded in the audit log."
    >
      {missing.length ? (
        <Notice tone="sod" title="You cannot export finance registers" className="mb-4">
          Exports need {FINANCE_EXPORT_PERMISSIONS.join(' and ')}. You are missing {missing.join(' and ')}. Ask an organisation owner if your role should export.
        </Notice>
      ) : null}
      {result ? (
        <div className="space-y-3">
          <Notice tone="success" title="Export ready">
            The file link expires {formatDateTime(result.expiresAt)}. SHA-256 <span className="font-mono text-[12px]">{result.sha256.slice(0, 16)}…</span>
          </Notice>
          <a href={result.url} className="inline-flex h-10 items-center gap-2 rounded-lg bg-teal px-4 text-body font-medium text-white hover:bg-teal/90" download>
            <Download className="h-4 w-4" aria-hidden />
            Download {FINANCE_REGISTER_LABELS[register]}
          </a>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-body text-ink">
            <Lock className="h-4 w-4 text-slate" aria-hidden />
            Data classification: <SensitivityBadge level={register === 'CONTRIBUTIONS' ? 'HIGHLY_RESTRICTED' : 'CONFIDENTIAL'} />
            {register === 'CONTRIBUTIONS' ? <span className="text-meta text-slate">(highly restricted when masked contributor identifiers are included)</span> : null}
          </div>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <FormField id="fx-register" label="Register" required>
              <select id="fx-register" className="ngao-input pr-8" value={register} onChange={(e) => setRegister(e.target.value as FinanceExportRequest['register'])}>
                {Object.entries(FINANCE_REGISTER_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField id="fx-format" label="Format" required>
              <select id="fx-format" className="ngao-input pr-8" value={format} onChange={(e) => setFormat(e.target.value as FinanceExportRequest['format'])}>
                <option value="XLSX">Excel (XLSX)</option>
                <option value="CSV">CSV</option>
                <option value="PDF">PDF</option>
              </select>
            </FormField>
            <FormField id="fx-from" label="From">
              <input id="fx-from" type="date" className="ngao-input" value={from} onChange={(e) => setFrom(e.target.value)} />
            </FormField>
            <FormField id="fx-to" label="To">
              <input id="fx-to" type="date" className="ngao-input" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </FormField>
          </div>
          <FormField id="fx-reason" label="Reason for the export" hint="Recorded with the export. At least 3 characters." required>
            <textarea id="fx-reason" className={textareaClass} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={2000} required />
          </FormField>
          <p className="mb-4 text-meta text-slate">
            The file starts with a header: title, generation time (Africa/Nairobi and UTC), who generated it, the filters, the classification, and the
            “Unverified” label wherever a finding relies on a limit setting that has not been verified.
          </p>
          {error ? (
            <Notice tone="error" className="mb-4">
              {error}
            </Notice>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={missing.length > 0 || reason.trim().length < 3}>
              <ShieldCheck className="h-4 w-4" aria-hidden />
              Confirm and export
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
