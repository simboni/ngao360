'use client';

import {
  CASE_CATEGORY_LABELS,
  CASE_CLOSURE_REASON_LABELS,
  CASE_SOURCE_LABELS,
  type CaseDetail,
  type CaseReferral,
  type CaseTransition,
  INSTITUTION_TYPE_LABELS,
} from '@ngao360/shared';
import {
  Archive,
  ArrowRight,
  CalendarClock,
  CheckCheck,
  Eraser as EraserIcon,
  Lock,
  MessageSquareReply,
  Paperclip,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  ShieldAlert,
  UserCheck,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { ReasonDialog, useHighRisk } from '@/components/admin/reauth';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { CaseStatusBadge, PriorityBadge, ReferralStatusBadge, SensitivityBadge, SlaBadge, VisibilityTag } from './case-badges';
import { CaseContactCard } from './case-contact';
import {
  AssignDialog,
  CloseDialog,
  EditCaseDialog,
  EvidenceDialog,
  ProposeResolutionDialog,
  REFERRAL_TRANSITIONS,
  ReferralDialog,
  ReferralUpdateDialog,
  ReopenDialog,
  TransitionDialog,
} from './case-dialogs';
import { casesApi } from './case-api';
import { describeCaseError } from './case-form';
import { locationLabel } from './case-list';
import { CaseTimeline } from './case-timeline';
import { caseSla, formatShortDate } from './sla';
import { availableCaseActions, type WorkspaceAction } from './workspace-actions';

type Open =
  | { kind: 'transition'; to: CaseTransition['to'] }
  | { kind: 'assign' | 'refer' | 'propose' | 'close' | 'reopen' | 'redact' | 'edit' | 'evidence' }
  | { kind: 'referral'; referral: CaseReferral }
  | null;

const ACTION_ICON: Record<WorkspaceAction['key'], typeof Search> = {
  triage: Search,
  assign: UserCheck,
  start: Wrench,
  refer: Share2,
  propose: MessageSquareReply,
  feedback: CheckCheck,
  close: Archive,
  reopen: RotateCcw,
  redact: EraserIcon,
  edit: Pencil,
  evidence: Paperclip,
};

/** S25 Case workspace (API §11). */
export function CaseWorkspace({ id }: { id: string }) {
  const { can } = useAuth();
  const { data: detail, error, loading, reload, setData } = useAsync(() => casesApi.get(id), [id]);
  const [open, setOpen] = useState<Open>(null);
  const highRisk = useHighRisk();

  if (loading && !detail) {
    return (
      <div className="space-y-3" aria-busy="true" aria-live="polite">
        <div className="h-8 w-1/2 animate-pulse rounded bg-surface" />
        <div className="h-48 animate-pulse rounded-card bg-surface" />
      </div>
    );
  }
  if (error && !detail) {
    return (
      <>
        <PageHeader title="Case" breadcrumbs={[{ label: 'Office' }, { label: 'Citizen cases', href: '/office/cases' }, { label: 'Case' }]} />
        <div className="ngao-card">
          <EmptyState icon={ShieldAlert} title="This case could not be opened" description={describeCaseError(error)} action={<Button variant="secondary" onClick={() => void reload()}>Try again</Button>} />
        </div>
      </>
    );
  }
  if (!detail) return null;

  const done = (d: CaseDetail) => setData(d);
  const refresh = () => void reload();
  const actions = availableCaseActions(detail, { canManage: can('office.cases.manage') });
  const sla = caseSla(detail);
  const canNote = detail.allowedActions.includes('add_note') && can('office.cases.internal_notes');
  const canUpdate = detail.allowedActions.includes('add_public_update');
  const evidenceEvents = detail.events.filter((e) => e.file);

  const runAction = (a: WorkspaceAction) => {
    if (a.key === 'triage') setOpen({ kind: 'transition', to: 'TRIAGE' });
    else if (a.key === 'start') setOpen({ kind: 'transition', to: a.to ?? 'IN_PROGRESS' });
    else if (a.key === 'feedback') setOpen({ kind: 'transition', to: 'CITIZEN_FEEDBACK' });
    else setOpen({ kind: a.key });
  };
  const primary = actions.filter((a) => a.primary);
  const secondary = actions.filter((a) => !a.primary);

  return (
    <>
      <PageHeader
        title={detail.title}
        breadcrumbs={[{ label: 'Office' }, { label: 'Citizen cases', href: '/office/cases' }, { label: detail.reference }]}
        status={
          <span className="flex flex-wrap items-center gap-2">
            <CaseStatusBadge status={detail.status} />
            <PriorityBadge priority={detail.priority} />
            <SlaBadge sla={sla} />
          </span>
        }
        description={
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            <span>{detail.reference}</span>
            <span>
              Public reference <span className="font-mono">{detail.publicReference}</span>
            </span>
            <span>{CASE_SOURCE_LABELS[detail.source]}</span>
            <span>Submitted {formatDateTime(detail.submittedAt)}</span>
          </span>
        }
        actions={
          <Button variant="ghost" size="sm" onClick={refresh} aria-label="Refresh case">
            <RefreshCw className="h-4 w-4" aria-hidden />
          </Button>
        }
      />

      {actions.length ? (
        <div className="ngao-card mb-4 flex flex-wrap items-center gap-2 p-3" role="toolbar" aria-label="Case actions">
          {primary.map((a) => {
            const Icon = ACTION_ICON[a.key];
            return (
              <Button key={`${a.key}-${a.to ?? ''}`} size="sm" variant={a.key === 'close' ? 'danger' : 'primary'} onClick={() => runAction(a)}>
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {a.label}
              </Button>
            );
          })}
          {secondary.map((a) => {
            const Icon = ACTION_ICON[a.key];
            return (
              <Button key={`${a.key}-${a.to ?? ''}`} size="sm" variant="secondary" onClick={() => runAction(a)}>
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {a.label}
              </Button>
            );
          })}
        </div>
      ) : null}

      {detail.status === 'RESOLUTION_PROPOSED' && detail.closeRequiresSecondPerson && detail.resolution ? (
        <Notice tone="sod" className="mb-4" title="Second-person closure">
          {detail.resolution.proposedBy.displayName} proposed the resolution. A different officer with closing rights must close the case.
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader
              title="What the requester reported"
              description={
                <span className="inline-flex items-center gap-1">
                  <Lock className="h-3 w-3" aria-hidden />
                  Original submission. It cannot be edited.
                </span>
              }
            />
            <CardBody>
              {detail.redactedAt ? (
                <Notice tone="info" className="mb-3" title="Personal details removed">
                  The description, location details, requester messages and photos were removed on {formatDateTime(detail.redactedAt)}. The record of what the office did is kept.
                </Notice>
              ) : null}
              <p className="whitespace-pre-line break-words text-body text-ink">{detail.description}</p>
              <p className="mt-3 text-meta text-slate">Privacy notice shown: {detail.privacyNoticeVersion}</p>
            </CardBody>
          </Card>

          {detail.resolution ? (
            <Card>
              <CardHeader title="Proposed resolution" actions={<VisibilityTag visibility="PUBLIC" />} />
              <CardBody>
                <p className="whitespace-pre-line text-body text-ink">{detail.resolution.summary}</p>
                <p className="mt-2 text-meta text-slate">
                  {detail.resolution.proposedBy.displayName} · {formatDateTime(detail.resolution.proposedAt)}
                </p>
              </CardBody>
            </Card>
          ) : null}

          {detail.closure ? (
            <Card>
              <CardHeader title="Closure" />
              <CardBody className="text-body">
                <p className="font-medium text-ink">{CASE_CLOSURE_REASON_LABELS[detail.closure.reason]}</p>
                {detail.closure.note ? <p className="mt-1 whitespace-pre-line text-ink">{detail.closure.note}</p> : null}
                <p className="mt-2 text-meta text-slate">
                  Closed by {detail.closure.closedBy.displayName} · {formatDateTime(detail.closure.closedAt)}
                </p>
              </CardBody>
            </Card>
          ) : null}

          <CaseTimeline detail={detail} canNote={canNote} canUpdate={canUpdate} onChanged={refresh} />
        </div>

        <aside className="min-w-0 space-y-4" aria-label="Case details">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="space-y-2 text-body">
                <Fact label="Assignee">
                  {detail.assignee ? detail.assignee.displayName : <span className="text-slate">Unassigned</span>}
                </Fact>
                <Fact label="Next review">
                  <span className="inline-flex items-center gap-1">
                    <CalendarClock className="h-3.5 w-3.5 text-slate" aria-hidden />
                    {detail.nextReviewDate ? formatShortDate(detail.nextReviewDate) : <span className="text-slate">Not set</span>}
                  </span>
                </Fact>
                <Fact label="Category">{CASE_CATEGORY_LABELS[detail.category]}</Fact>
                <Fact label="Location">
                  {locationLabel(detail)}
                  {detail.location.description ? <span className="block text-meta text-slate">{detail.location.description}</span> : null}
                </Fact>
                <Fact label="Sensitivity">
                  <SensitivityBadge level={detail.sensitivity} />
                </Fact>
                {detail.triagedBy ? (
                  <Fact label="Triaged">
                    {detail.triagedBy.displayName}
                    {detail.triagedAt ? <span className="block text-meta text-slate">{formatDateTime(detail.triagedAt)}</span> : null}
                  </Fact>
                ) : null}
                {detail.duplicateOf ? (
                  <Fact label="Duplicate of">
                    <Link href={`/office/cases/${detail.duplicateOf.id}`} className="text-deep-blue hover:underline">
                      {detail.duplicateOf.reference}
                    </Link>
                  </Fact>
                ) : null}
                {detail.linkedCorrespondence.length ? (
                  <Fact label="Correspondence">
                    {detail.linkedCorrespondence.map((r) => (
                      <Link key={r.id} href={`/office/correspondence/${r.id}`} className="block text-deep-blue hover:underline">
                        {r.reference}
                      </Link>
                    ))}
                  </Fact>
                ) : null}
                <Fact label="Last updated">{formatDateTime(detail.updatedAt)}</Fact>
              </dl>
            </CardBody>
          </Card>

          <CaseContactCard detail={detail} />

          <Card>
            <CardHeader
              title="Referrals"
              description="Institutions responsible for the issue."
              actions={
                actions.some((a) => a.key === 'refer') ? (
                  <Button size="sm" variant="secondary" onClick={() => setOpen({ kind: 'refer' })}>
                    <Share2 className="h-3.5 w-3.5" aria-hidden />
                    Refer
                  </Button>
                ) : null
              }
            />
            <CardBody>
              {detail.referrals.length === 0 ? (
                <p className="text-body text-slate">Not referred.</p>
              ) : (
                <ul className="space-y-3">
                  {detail.referrals.map((r) => (
                    <li key={r.id} className="rounded-lg border border-line p-3 text-body">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-medium text-ink">{r.institution.name}</p>
                          <p className="text-meta text-slate">{INSTITUTION_TYPE_LABELS[r.institution.type]}</p>
                        </div>
                        <ReferralStatusBadge status={r.status} />
                      </div>
                      <dl className="mt-2 space-y-0.5 text-meta">
                        <Fact label="Referred">{formatShortDate(r.referredAt)}</Fact>
                        {r.followUpDate ? <Fact label="Follow up">{formatShortDate(r.followUpDate)}</Fact> : null}
                        {r.institutionReference ? <Fact label="Their ref.">{r.institutionReference}</Fact> : null}
                        {r.contactPerson ? <Fact label="Desk">{[r.contactPerson, r.contactDetail].filter(Boolean).join(' · ')}</Fact> : null}
                        <Fact label="Contact shared">{r.requesterContactShared ? 'Yes (with consent)' : 'No'}</Fact>
                      </dl>
                      {r.responseSummary ? <p className="mt-2 whitespace-pre-line text-ink">{r.responseSummary}</p> : null}
                      {detail.allowedActions.includes('refer') && REFERRAL_TRANSITIONS[r.status].length ? (
                        <Button size="sm" variant="ghost" className="mt-1 px-0 text-deep-blue" onClick={() => setOpen({ kind: 'referral', referral: r })}>
                          Update referral
                          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Evidence"
              actions={
                actions.some((a) => a.key === 'evidence') ? (
                  <Button size="sm" variant="secondary" onClick={() => setOpen({ kind: 'evidence' })}>
                    <Paperclip className="h-3.5 w-3.5" aria-hidden />
                    Add
                  </Button>
                ) : null
              }
            />
            <CardBody>
              {evidenceEvents.length === 0 ? (
                <p className="text-body text-slate">No files yet.</p>
              ) : (
                <ul className="space-y-2 text-body">
                  {evidenceEvents.map((e) => (
                    <li key={e.id} className="flex flex-col gap-1 rounded-lg border border-line p-2">
                      <span className="break-all font-medium text-ink">{e.file!.originalFilename}</span>
                      {e.body ? <span className="text-meta text-slate">{e.body}</span> : null}
                      <span className="flex flex-wrap items-center gap-2 text-meta text-slate">
                        <VisibilityTag visibility={e.visibility} />
                        {e.file!.uploadedBy ? e.file!.uploadedBy.displayName : 'Public portal'} · {formatDateTime(e.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-meta text-slate">Open files from the timeline. Every view is audited.</p>
            </CardBody>
          </Card>
        </aside>
      </div>

      {open?.kind === 'transition' ? <TransitionDialog detail={detail} to={open.to} onClose={() => setOpen(null)} onDone={done} /> : null}
      {open?.kind === 'assign' ? <AssignDialog detail={detail} onClose={() => setOpen(null)} onDone={done} /> : null}
      {open?.kind === 'refer' ? <ReferralDialog detail={detail} onClose={() => setOpen(null)} onDone={done} /> : null}
      {open?.kind === 'referral' ? <ReferralUpdateDialog caseId={detail.id} referral={open.referral} onClose={() => setOpen(null)} onDone={refresh} /> : null}
      {open?.kind === 'propose' ? <ProposeResolutionDialog detail={detail} onClose={() => setOpen(null)} onDone={done} /> : null}
      {open?.kind === 'close' ? <CloseDialog detail={detail} onClose={() => setOpen(null)} onDone={done} /> : null}
      {open?.kind === 'reopen' ? <ReopenDialog detail={detail} onClose={() => setOpen(null)} onDone={done} /> : null}
      <ReasonDialog
        open={open?.kind === 'redact'}
        onClose={() => setOpen(null)}
        title="Remove personal details"
        description="For a data-subject request or when the retention period ends. The description, location details, requester messages and photos are removed and contact details are erased. The case can no longer be reopened. This cannot be undone."
        confirmLabel="Remove"
        tone="danger"
        onConfirm={async (reason) => {
          done(await highRisk(() => casesApi.redact(detail.id, { reason })));
        }}
      />
      {open?.kind === 'edit' ? <EditCaseDialog detail={detail} onClose={() => setOpen(null)} onDone={done} /> : null}
      {open?.kind === 'evidence' ? <EvidenceDialog detail={detail} onClose={() => setOpen(null)} onDone={refresh} /> : null}
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-2">
      <dt className="text-slate">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}
