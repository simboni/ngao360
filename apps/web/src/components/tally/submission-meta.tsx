import { SUBMISSION_SOURCE_TYPE_LABELS, type SubmissionDetail } from '@ngao360/shared';
import Link from 'next/link';
import { formatDateTime } from '@/lib/format';
import { CanonicalBadge, DuplicateBadge } from './badges';
import { MetaRow } from './fields';
import { formatBytes, shortHash } from './file-hash';
import { locationLabel } from './links';

/** Submission identity, geography, document and declaration metadata (blueprint 8.3 / 11.1). */
export function SubmissionMeta({ s, compact = false }: { s: SubmissionDetail; compact?: boolean }) {
  const d = s.declaration;
  return (
    <div className="space-y-3">
      <dl>
        <MetaRow label="Contest">{s.contestName}</MetaRow>
        <MetaRow label="Form">
          {s.formNumber} · template v{s.formTemplateVersion}
        </MetaRow>
        <MetaRow label={s.pollingStationId ? 'Polling station' : 'Tally centre'}>{locationLabel(s)}</MetaRow>
        {s.pollingStationId ? <MetaRow label="Ward / constituency">{[s.wardName, s.constituencyName].filter(Boolean).join(' · ') || '—'}</MetaRow> : null}
        <MetaRow label="County">{s.countyName}</MetaRow>
        <MetaRow label="Source">{SUBMISSION_SOURCE_TYPE_LABELS[s.sourceType]}</MetaRow>
        <MetaRow label="Submitter">{s.submitter.displayName}</MetaRow>
        <MetaRow label="Uploaded">{formatDateTime(s.submittedAt ?? s.createdAt)}</MetaRow>
        {!compact ? (
          <>
            <MetaRow label="File">
              {s.sourceFile.originalFilename} ({formatBytes(s.sourceFile.sizeBytes)})
            </MetaRow>
            <MetaRow label="SHA-256">
              <span className="font-mono text-meta" title={s.sourceFile.sha256}>
                {shortHash(s.sourceFile.sha256, 20)}
              </span>
            </MetaRow>
            <MetaRow label="Image quality">{s.imageQuality ? s.imageQuality.toLowerCase() : 'Not recorded'}</MetaRow>
            {d.formSerial ? <MetaRow label="Form serial (printed)">{d.formSerial}</MetaRow> : null}
            {d.stampObserved !== undefined ? <MetaRow label="Stamp observed">{d.stampObserved ? 'Yes (observation only)' : 'No'}</MetaRow> : null}
            {d.presidingOfficerSignatureObserved !== undefined ? (
              <MetaRow label="Signature observed">{d.presidingOfficerSignatureObserved ? 'Yes (observation only)' : 'No'}</MetaRow>
            ) : null}
            {d.sourceCopyNotes ? <MetaRow label="Source notes">{d.sourceCopyNotes}</MetaRow> : null}
          </>
        ) : null}
      </dl>
      {s.duplicateFlag || s.relatedSubmissionIds.length > 0 ? (
        <div className="rounded-lg border border-gold/40 bg-gold/5 p-2 text-meta">
          <div className="mb-1 flex flex-wrap gap-1">
            {s.duplicateFlag ? <DuplicateBadge /> : null}
            {s.isCanonical && s.duplicateFlag ? <CanonicalBadge /> : null}
          </div>
          <p className="text-slate">Related records for the same station and form:</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {s.relatedSubmissionIds.map((id) => (
              <li key={id}>
                <Link href={`/tally/capture/${id}`} className="text-deep-blue hover:underline">
                  {id.slice(0, 8)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
