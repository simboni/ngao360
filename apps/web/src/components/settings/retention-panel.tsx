'use client';

/**
 * Data retention (S30): the organisation's retention profile and the Office periods (contact
 * details and case records after closure). Once a privacy-notice version states the periods,
 * changing them needs a new notice version that states the new ones (409 otherwise). Shows the
 * last run of the retention job.
 */
import { RETENTION_PROFILES, type RetentionProfile, type RetentionResponse, type UpdateRetention } from '@ngao360/shared';
import { useEffect, useState } from 'react';
import { useHighRisk } from '@/components/admin/reauth';
import { FormField, textareaClass } from '@/components/office/correspondence/office-common';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { workspaceApi } from '@/components/workspace/workspace-api';
import { describeWorkspaceError, retentionNeedsNewNotice } from '@/components/workspace/workspace-model';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { SettingsSection } from './settings-section';

const isCancelled = (err: unknown) => err instanceof Error && err.message === 'Confirmation cancelled';
const PROFILE_LABELS: Record<RetentionProfile, string> = {
  minimal: 'Minimal: shortest periods the law and your processes allow',
  standard: 'Standard',
  extended: 'Extended: longer periods with a documented reason',
};

export function RetentionPanel() {
  const { can } = useAuth();
  const canConfigure = can('workspace.configure');
  const highRisk = useHighRisk();
  const data = useAsync(() => workspaceApi.retention(), []);
  const [profile, setProfile] = useState<string>('standard');
  const [contact, setContact] = useState('');
  const [cases, setCases] = useState('');
  const [newNotice, setNewNotice] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = (r: RetentionResponse) => {
    setProfile(r.retentionProfile);
    setContact(r.office ? String(r.office.contactRetentionMonths) : '');
    setCases(r.office ? String(r.office.caseRetentionMonths) : '');
  };
  useEffect(() => {
    if (data.data) load(data.data);
  }, [data.data]);

  const r = data.data;
  const next = r?.office ? { contactRetentionMonths: Number(contact), caseRetentionMonths: Number(cases) } : null;
  const needsNotice = !!next && retentionNeedsNewNotice(r?.statedUnderNotice ?? null, next);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const body: UpdateRetention = {
      retentionProfile: profile as RetentionProfile,
      ...(next ? { office: next } : {}),
      ...(newNotice.trim() ? { newNoticeVersion: newNotice.trim() } : {}),
      reason: reason.trim(),
    };
    try {
      const updated = await highRisk(() => workspaceApi.updateRetention(body));
      data.setData(updated);
      setNewNotice('');
      setReason('');
      setSaved(true);
    } catch (err) {
      if (!isCancelled(err)) setError(describeWorkspaceError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="retention" title="Data retention" description="How long personal data is kept. Saving records you as the reviewer for the onboarding checklist.">
      {data.error ? <Notice tone="error">{describeWorkspaceError(data.error)}</Notice> : null}
      {r ? (
        <form onSubmit={submit} noValidate>
          <FormField id="ret-profile" label="Retention profile" required>
            <select id="ret-profile" className="ngao-input pr-8" value={profile} disabled={!canConfigure} onChange={(e) => setProfile(e.target.value)}>
              {RETENTION_PROFILES.map((p) => (
                <option key={p} value={p}>
                  {PROFILE_LABELS[p]}
                </option>
              ))}
            </select>
          </FormField>
          {r.office ? (
            <div className="grid gap-x-4 sm:grid-cols-2">
              <FormField id="ret-contact" label="Office contact details (months after closure)" required>
                <input id="ret-contact" type="number" min={1} max={120} className="ngao-input w-32 tabular-nums" value={contact} disabled={!canConfigure} onChange={(e) => setContact(e.target.value)} />
              </FormField>
              <FormField id="ret-cases" label="Office case records (months after closure)" required>
                <input id="ret-cases" type="number" min={1} max={240} className="ngao-input w-32 tabular-nums" value={cases} disabled={!canConfigure} onChange={(e) => setCases(e.target.value)} />
              </FormField>
            </div>
          ) : (
            <p className="mb-4 text-meta text-slate">The Office module is off, so there are no Office retention periods to set.</p>
          )}
          {r.statedUnderNotice ? (
            <p className="mb-3 text-meta text-slate">
              Privacy notice {r.statedUnderNotice.noticeVersion} states {r.statedUnderNotice.contactRetentionMonths} months for contact details and{' '}
              {r.statedUnderNotice.caseRetentionMonths} months for case records.
            </p>
          ) : null}
          {needsNotice ? (
            <>
              <Notice tone="warning" className="mb-3" title="A new privacy-notice version is needed">
                People were told the periods above. Publish a notice version that states the new periods, then enter its version label.
              </Notice>
              <FormField id="ret-notice" label="New privacy notice version" required>
                <input id="ret-notice" className="ngao-input font-mono" value={newNotice} onChange={(e) => setNewNotice(e.target.value)} placeholder="e.g. 2026-12-v2" />
              </FormField>
            </>
          ) : null}
          {canConfigure ? (
            <FormField id="ret-reason" label="Reason" required hint="Recorded in the audit log.">
              <textarea id="ret-reason" className={textareaClass} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
            </FormField>
          ) : null}
          <p className="mb-3 text-meta text-slate">
            {r.reviewedAt ? `Last reviewed by ${r.reviewedBy?.displayName ?? 'an administrator'} · ${formatDateTime(r.reviewedAt)}. ` : 'Not reviewed yet. '}
            {r.lastRun ? `Retention job last ran ${formatDateTime(r.lastRun.startedAt)} (${r.lastRun.status.toLowerCase()}).` : 'The retention job has not run yet.'}
          </p>
          {error ? <Notice tone="error" className="mb-3">{error}</Notice> : null}
          {saved ? <Notice tone="success" className="mb-3">Saved.</Notice> : null}
          {canConfigure ? (
            <div className="flex justify-end">
              <Button type="submit" loading={busy} disabled={reason.trim().length < 3 || (needsNotice && !newNotice.trim())}>
                Confirm and save
              </Button>
            </div>
          ) : null}
        </form>
      ) : null}
    </SettingsSection>
  );
}
