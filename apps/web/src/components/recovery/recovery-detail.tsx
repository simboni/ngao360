'use client';

/**
 * One account-recovery request (CR AR8, API contract §32.3): who is recovered, who asked, who
 * approved; approve (second administrator, re-authentication), reject or cancel with a reason; the
 * one-time hand-off of the recovery link; and the request's audit trail.
 *
 * The recovery link is shown only when the approve response carries `devRecoveryPath` (no e-mail
 * channel, never in production), only to the approver, only until this drawer closes. It is kept in
 * component state only: never in the URL, browser storage, the list or a screenshot-friendly place.
 */
import type { AccountRecoverySummary, AuditEvent, Paginated } from '@ngao360/shared';
import { Ban, CheckCircle2, Copy, Mail, ScrollText, ShieldAlert, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Drawer, Facts, Notice } from '@/components/admin/primitives';
import { ReasonDialog, useHighRisk } from '@/components/admin/reauth';
import { describeError, useApiQuery } from '@/components/admin/use-api';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import {
  auditEventDetail,
  auditEventTitle,
  isOpenRecovery,
  isPastExpiry,
  RECOVERY_STATUS_LABELS,
  recoveryActionRules,
  recoveryHandoff,
  type RecoveryHandoff,
  recoveryTimeline,
  withoutHandoff,
} from './recovery-model';
import { RecoveryStatusBadge, RuleButton } from './recovery-ui';

type Decision = 'approve' | 'reject' | 'cancel';

const DECISION_TEXT: Record<Decision, { title: string; description: string; label: string; tone: 'primary' | 'danger' }> = {
  approve: {
    title: 'Approve this account recovery?',
    description:
      'You are the second administrator. Approve only if you agree the identity check was enough. A single-use link lets the person set a new password; their passkeys, authenticator, recovery codes and sessions are revoked when they use it.',
    label: 'Approve recovery',
    tone: 'primary',
  },
  reject: { title: 'Reject this request?', description: 'The person keeps their current sign-in factors. The requester and the person are not sent a link.', label: 'Reject', tone: 'danger' },
  cancel: { title: 'Cancel this request?', description: 'Any recovery link already sent stops working.', label: 'Cancel request', tone: 'danger' },
};

export function RecoveryDetail({
  id,
  onClose,
  onChanged,
}: {
  id: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { me, can } = useAuth();
  const highRisk = useHighRisk();
  const [pending, setPending] = useState<Decision | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<RecoveryHandoff | null>(null);
  const [copied, setCopied] = useState(false);
  const canAudit = can('audit.view');

  // A different request (or closing) forgets the one-time link and any message.
  useEffect(() => {
    setHandoff(null);
    setNotice(null);
    setCopied(false);
  }, [id]);

  const q = useApiQuery<AccountRecoverySummary>(id ? `recovery:${id}` : null, (signal) => api.get<AccountRecoverySummary>(`/admin/account-recovery/${id}`, { signal }));
  const trail = useApiQuery<Paginated<AuditEvent>>(id && canAudit ? `recovery-audit:${id}:${q.loadedAt?.getTime() ?? 0}` : null, (signal) =>
    api.get<Paginated<AuditEvent>>('/admin/audit-events', { query: { entityType: 'AccountRecoveryRequest', entityId: id!, pageSize: 50 }, signal }),
  );
  const r = q.data ? withoutHandoff(q.data) : null;
  const rules = r ? recoveryActionRules(r, me?.user.id, can('users.reset_mfa')) : null;

  const decide = async (reason: string) => {
    if (!r || !pending) return;
    if (pending === 'approve') {
      const res = await highRisk(() => api.post<AccountRecoverySummary>(`/admin/account-recovery/${r.id}/approve`, { reason }));
      const h = recoveryHandoff(res, window.location.origin);
      setHandoff(h);
      setNotice(h.kind === 'SENT' ? `Approved. The recovery link was sent to ${r.user.displayName}'s account e-mail.` : 'Approved. Give the link below to the person yourself; it is shown only now.');
    } else if (pending === 'reject') {
      await api.post<AccountRecoverySummary>(`/admin/account-recovery/${r.id}/reject`, { reason });
      setNotice('The request was rejected.');
    } else {
      await api.post<AccountRecoverySummary>(`/admin/account-recovery/${r.id}/cancel`, { reason });
      setHandoff(null);
      setNotice('The request was cancelled. Any link already sent no longer works.');
    }
    await q.reload();
    onChanged();
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const close = () => {
    setHandoff(null);
    onClose();
  };

  const d = pending ? DECISION_TEXT[pending] : null;

  return (
    <Drawer
      open={id !== null}
      onClose={close}
      title={r ? `Recovery for ${r.user.displayName}` : 'Account recovery'}
      subtitle={r ? <span className="flex flex-wrap items-center gap-2"><RecoveryStatusBadge status={r.status} size="sm" /> {RECOVERY_STATUS_LABELS[r.status]}</span> : null}
    >
      {q.error ? <Notice tone="danger">{describeError(q.error)}</Notice> : null}
      {!r || !rules ? (
        q.error ? null : <div className="h-40 animate-pulse rounded-card bg-cloud" />
      ) : (
        <>
          {notice ? <Notice tone="success" className="mb-4">{notice}</Notice> : null}
          {handoff?.kind === 'SHOWN_ONCE' ? (
            <Notice tone="warning" className="mb-4" title="Recovery link (shown once)">
              <p className="mb-2">
                No e-mail channel is configured on this server, so the link is shown to you instead of being sent. Give it to {r.user.displayName} through a separate, trusted
                channel. It works once and expires {formatDateTime(r.expiresAt)}. Closing this panel hides it for good.
              </p>
              <code data-recovery-link className="block break-all rounded-md bg-surface px-2 py-1 font-mono text-meta text-ink">
                {handoff.url}
              </code>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => void copy(handoff.url)}>
                <Copy className="h-4 w-4" aria-hidden /> {copied ? 'Copied' : 'Copy link'}
              </Button>
            </Notice>
          ) : null}
          {handoff?.kind === 'SENT' ? (
            <Notice tone="info" className="mb-4" title="Recovery link sent to the account e-mail">
              <span className="inline-flex items-center gap-1">
                <Mail className="h-4 w-4 shrink-0" aria-hidden /> The link is never shown to administrators once e-mail delivery is configured. It expires {formatDateTime(r.expiresAt)}.
              </span>
            </Notice>
          ) : null}
          {!handoff && r.status === 'APPROVED' ? (
            <Notice tone="info" className="mb-4" title="Waiting for the person to use their link">
              <span className="inline-flex items-center gap-1">
                <Mail className="h-4 w-4 shrink-0" aria-hidden /> The single-use link went to their account e-mail (or, with no e-mail channel, was shown once to the approver). It is never shown
                again and expires {formatDateTime(r.expiresAt)}. Cancel the request if it was given to the wrong person.
              </span>
            </Notice>
          ) : null}
          {isOpenRecovery(r.status) && isPastExpiry(r) ? (
            <Notice tone="warning" className="mb-4">
              This request is past its expiry time and will be marked expired shortly. Start a new request if the person still needs help.
            </Notice>
          ) : null}

          <section aria-labelledby="recovery-people" className="mb-5">
            <h3 id="recovery-people" className="mb-2 text-card font-semibold text-ink">
              People involved
            </h3>
            <Facts
              items={[
                { label: 'Account being recovered', value: r.user.displayName },
                { label: 'Requested by', value: `${r.requestedBy.displayName} · ${formatDateTime(r.createdAt)}` },
                { label: 'Approved by', value: r.approvedBy ? `${r.approvedBy.displayName} · ${formatDateTime(r.approvedAt)}` : 'Not yet' },
                ...(r.rejectedBy ? [{ label: 'Rejected by', value: r.rejectedBy.displayName }] : []),
                { label: 'Expires', value: formatDateTime(r.expiresAt) },
                { label: 'Completed', value: r.completedAt ? formatDateTime(r.completedAt) : '—' },
              ]}
            />
            <p className="mt-3 flex items-start gap-2 text-meta text-slate">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              Two-person rule: the approver must be a different administrator from the requester, and nobody decides on their own account.
            </p>
          </section>

          <section aria-labelledby="recovery-check" className="mb-5">
            <h3 id="recovery-check" className="mb-2 text-card font-semibold text-ink">
              Identity check and reason
            </h3>
            <Facts
              items={[
                { label: 'How identity was checked', value: r.identityCheckNote },
                { label: 'Reason', value: r.reason },
                ...(r.rejectionReason ? [{ label: 'Rejection reason', value: r.rejectionReason }] : []),
              ]}
            />
          </section>

          {isOpenRecovery(r.status) ? (
            <section aria-label="Decisions" className="mb-6 flex flex-wrap items-start gap-3 rounded-lg border border-line p-3">
              {r.status === 'PENDING' ? (
                <>
                  <RuleButton rule={rules.approve} variant="primary" onClick={() => setPending('approve')}>
                    <CheckCircle2 className="h-4 w-4" aria-hidden /> Approve
                  </RuleButton>
                  <RuleButton rule={rules.reject} onClick={() => setPending('reject')}>
                    <XCircle className="h-4 w-4" aria-hidden /> Reject
                  </RuleButton>
                </>
              ) : null}
              <RuleButton rule={rules.cancel} onClick={() => setPending('cancel')}>
                <Ban className="h-4 w-4" aria-hidden /> Cancel request
              </RuleButton>
            </section>
          ) : null}

          <section aria-labelledby="recovery-trail">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 id="recovery-trail" className="text-card font-semibold text-ink">
                Audit trail
              </h3>
              {canAudit ? (
                <Link
                  href={`/admin/audit?entityType=AccountRecoveryRequest&entityId=${r.id}`}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-line px-3 text-meta hover:bg-cloud"
                >
                  <ScrollText className="h-4 w-4" aria-hidden /> Open in the audit log
                </Link>
              ) : null}
            </div>
            {canAudit ? (
              <>
                {trail.error ? <Notice tone="danger">{describeError(trail.error)}</Notice> : null}
                {trail.loading && !trail.data ? <p className="text-body text-slate">Loading the audit trail…</p> : null}
                {trail.data ? (
                  <ol className="divide-y divide-line rounded-lg border border-line">
                    {[...trail.data.items]
                      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
                      .map((e) => (
                        <li key={e.id} className="px-3 py-2">
                          <p className="font-medium text-ink">{auditEventTitle(e.action)}</p>
                          <p className="text-meta text-slate">
                            {formatDateTime(e.occurredAt)} · {e.actor?.displayName ?? (e.actorType === 'SYSTEM' ? 'System' : 'Unknown')}
                          </p>
                          {auditEventDetail(e) ? <p className="mt-0.5 text-meta text-ink/80">{auditEventDetail(e)}</p> : null}
                        </li>
                      ))}
                  </ol>
                ) : null}
              </>
            ) : (
              <>
                <p className="mb-2 text-meta text-slate">From the request record. The full, hash-chained trail is in the audit log (needs the audit permission).</p>
                <ol className="divide-y divide-line rounded-lg border border-line">
                  {recoveryTimeline(r).map((t) => (
                    <li key={t.key} className="px-3 py-2">
                      <p className="font-medium text-ink">{t.title}</p>
                      <p className="text-meta text-slate">{[t.at ? formatDateTime(t.at) : null, t.who].filter(Boolean).join(' · ') || '—'}</p>
                      {t.detail ? <p className="mt-0.5 text-meta text-ink/80">{t.detail}</p> : null}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>
        </>
      )}

      {d ? <ReasonDialog open onClose={() => setPending(null)} title={d.title} description={d.description} confirmLabel={d.label} tone={d.tone} onConfirm={decide} /> : null}
    </Drawer>
  );
}
