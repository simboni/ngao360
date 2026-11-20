'use client';

import type { RegistryImportReport } from '@ngao360/shared';
import { AlertTriangle, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Chip, Notice } from '@/components/admin/primitives';
import { formatNumber } from '@/lib/format';

/** Registry import validation report (blueprint 6.2): totals, hierarchy, issues and the diff with the approved version. */
export function ImportReportView({ report }: { report: RegistryImportReport }) {
  const [severity, setSeverity] = useState<'ALL' | 'ERROR' | 'WARNING'>('ALL');
  const issues = report.issues.filter((i) => severity === 'ALL' || i.severity === severity);
  const t = report.totals;
  const h = report.hierarchy;
  return (
    <div className="space-y-4">
      {report.fatal ? (
        <Notice tone="danger" title="This file cannot be imported">
          Fix the file-level problems below and validate again.
        </Notice>
      ) : t.errors > 0 ? (
        <Notice tone="warning" title={`${formatNumber(t.rowsRejected)} rows will be rejected`}>
          Rows with errors are left out; everything else is imported. Fix the source and import into a new version if the registry must be complete.
        </Notice>
      ) : (
        <Notice tone="success" title="No errors found">
          {t.warnings > 0 ? `${formatNumber(t.warnings)} warnings to review.` : 'The file is ready to import.'}
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          ['Rows read', t.rowsRead],
          ['Accepted', t.rowsAccepted],
          ['Rejected', t.rowsRejected],
          ['Errors', t.errors],
          ['Warnings', t.warnings],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-lg border border-line p-2">
            <p className="text-meta text-slate">{label}</p>
            <p className="text-section font-semibold text-navy">{formatNumber(value as number)}</p>
          </div>
        ))}
      </div>

      <div>
        <p className="ngao-label">Hierarchy found</p>
        <p className="text-body text-ink">
          {formatNumber(h.counties)} counties · {formatNumber(h.constituencies)} constituencies · {formatNumber(h.wards)} wards · {formatNumber(h.pollingCentres)} polling centres · {formatNumber(h.stations)} stations ·{' '}
          {formatNumber(h.registeredVotersTotal)} registered voters
          {h.stationsWithoutRegisteredVoters > 0 ? ` (${formatNumber(h.stationsWithoutRegisteredVoters)} stations without a figure; never estimated)` : ''}
        </p>
      </div>

      {report.diff ? (
        <div>
          <p className="ngao-label">Compared with {report.diff.comparedWithVersion ? `approved version ${report.diff.comparedWithVersion}` : 'nothing (no approved version yet)'}</p>
          <div className="flex flex-wrap gap-2">
            <Chip tone="info">{formatNumber(report.diff.added)} added</Chip>
            <Chip tone={report.diff.removed ? 'warning' : 'neutral'}>{formatNumber(report.diff.removed)} removed</Chip>
            <Chip>{formatNumber(report.diff.renamed)} renamed</Chip>
            <Chip>{formatNumber(report.diff.moved)} moved</Chip>
            <Chip>{formatNumber(report.diff.registeredVotersChanged)} voter figures changed</Chip>
            <Chip>{formatNumber(report.diff.unchanged)} unchanged</Chip>
          </div>
        </div>
      ) : null}

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="ngao-label mb-0">Issues ({formatNumber(report.issues.length)}{report.issuesTruncated ? '+, list truncated' : ''})</p>
          <div role="radiogroup" aria-label="Filter issues" className="flex gap-1 text-meta">
            {(['ALL', 'ERROR', 'WARNING'] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={severity === s} onClick={() => setSeverity(s)} className={`rounded-md border px-2 py-0.5 ${severity === s ? 'border-teal bg-teal/10 text-navy' : 'border-line text-slate hover:bg-cloud'}`}>
                {s === 'ALL' ? 'All' : s === 'ERROR' ? 'Errors' : 'Warnings'}
              </button>
            ))}
          </div>
        </div>
        {issues.length === 0 ? (
          <p className="text-meta text-slate">No issues.</p>
        ) : (
          <div className="max-h-64 overflow-auto rounded-lg border border-line">
            <table className="w-full text-meta">
              <thead className="sticky top-0 bg-cloud text-left text-slate">
                <tr>
                  <th scope="col" className="px-2 py-1">Line</th>
                  <th scope="col" className="px-2 py-1">Severity</th>
                  <th scope="col" className="px-2 py-1">Column</th>
                  <th scope="col" className="px-2 py-1">Problem</th>
                </tr>
              </thead>
              <tbody>
                {issues.slice(0, 500).map((i, idx) => (
                  <tr key={`${i.row}-${i.code}-${idx}`} className="border-t border-line">
                    <td className="px-2 py-1 tabular-nums">{i.row || 'File'}</td>
                    <td className="px-2 py-1">
                      <span className={`inline-flex items-center gap-1 ${i.severity === 'ERROR' ? 'text-error' : 'text-[#7a5a17]'}`}>
                        {i.severity === 'ERROR' ? <XCircle className="h-3 w-3" aria-hidden /> : <AlertTriangle className="h-3 w-3" aria-hidden />}
                        {i.severity === 'ERROR' ? 'Error' : 'Warning'}
                      </span>
                    </td>
                    <td className="px-2 py-1 font-mono">{i.column ?? '—'}</td>
                    <td className="px-2 py-1">{i.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
