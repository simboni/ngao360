'use client';

import {
  COMMITMENT_SOURCE_LABELS,
  FUNDING_SOURCE_LABELS,
  INSTITUTION_TYPE_LABELS,
  MILESTONE_STATUS_LABELS,
  PROJECT_CATEGORY_LABELS,
  PROJECT_EVIDENCE_TYPE_LABELS,
  type ProjectDetail,
  type ProjectEvidence,
  type ProjectMilestone,
} from '@ngao360/shared';
import { ArrowLeft, Building2, Camera, FileText, History, Landmark, MapPin, Pencil, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { isAccessError } from '@/components/tally/errors';
import { Notice } from '@/components/tally/notice';
import { useAsync } from '@/components/tally/use-async';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { formatDateTime } from '@/lib/format';
import { describeOfficeError, Facts, formatDate, HistoryList, ViewTabs } from '../correspondence/office-common';
import { OfficeFilePreview } from '../correspondence/office-file-preview';
import { ProjectStatusBadge, PublishedBadge, StageKindBadge, VerificationBadge } from './project-badges';
import { AddEvidenceDialog, MilestoneDialog, projectTransitionTargets, TransitionDialog, VerifyCompletionDialog, VerifyRecordDialog } from './project-dialogs';
import { ProjectFormDialog } from './project-form-dialog';
import { completionLabel, completionVerifyState, statusAddsDetail, evidenceVerifyBlock, formatMoney, isPhoto, projectLocationLabel, spendShare } from './project-model';
import { projectsApi } from './projects-api';
import { PublicationPanel } from './publication-panel';

type Tab = 'summary' | 'milestones' | 'documents' | 'photos' | 'finance' | 'history' | 'public';

type DialogState =
  | { kind: 'edit' }
  | { kind: 'transition' }
  | { kind: 'verify_completion' }
  | { kind: 'verify_expenditure' }
  | { kind: 'milestone'; milestone?: ProjectMilestone }
  | { kind: 'verify_milestone'; milestone: ProjectMilestone }
  | { kind: 'evidence'; photo: boolean }
  | { kind: 'verify_evidence'; evidence: ProjectEvidence }
  | null;

/** S27 Project detail. API §12. */
export function ProjectDetailView({ id }: { id: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const { me, can } = useAuth();
  const meId = me?.user.id;
  const { data: project, error, loading, reload, setData } = useAsync(() => projectsApi.get(id), [id]);
  const [tab, setTab] = useState<Tab>((params?.get('tab') as Tab) || 'summary');
  const history = useAsync(() => projectsApi.history(id), [id, project?.version], tab === 'history');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notice, setNotice] = useState<string | null>(params?.get('new') ? 'Project recorded.' : null);
  const [showFileViews, setShowFileViews] = useState(false);

  if (loading && !project) return <p className="text-body text-slate">Loading project…</p>;
  if (error && !project) {
    return (
      <div className="ngao-card">
        <EmptyState
          title={isAccessError(error) ? 'This project is not available to you' : 'The project could not be loaded'}
          description={isAccessError(error) ? 'It may not exist, or it may be outside the wards or constituencies you cover.' : describeOfficeError(error)}
          action={
            <Link href="/office/projects" className="text-deep-blue underline">
              Back to the register
            </Link>
          }
        />
      </div>
    );
  }
  if (!project) return null;

  const allowed = new Set(project.allowedActions);
  const canVerify = can('office.projects.verify');
  const completion = completionVerifyState(project, meId, canVerify);
  const documents = project.evidence.filter((e) => !isPhoto(e.type));
  const photos = project.evidence.filter((e) => isPhoto(e.type));
  const refresh = async (message: string) => {
    setDialog(null);
    setNotice(message);
    await reload();
  };
  const saved = (next: ProjectDetail, message: string) => {
    setData(next);
    setDialog(null);
    setNotice(message);
  };
  const share = spendShare(project.expenditureReported, project.approvedAllocation);

  const tabs: Array<{ key: Tab; label: string; count?: number | null }> = [
    { key: 'summary', label: 'Summary' },
    { key: 'milestones', label: 'Milestones', count: project.milestones.length },
    { key: 'documents', label: 'Documents', count: documents.length },
    { key: 'photos', label: 'Photographs', count: photos.length },
    { key: 'finance', label: 'Finance' },
    { key: 'history', label: 'Update history' },
    { key: 'public', label: 'Public view' },
  ];

  return (
    <>
      <PageHeader
        title={project.name}
        breadcrumbs={[{ label: 'Office' }, { label: 'Projects', href: '/office/projects' }, { label: project.reference }]}
        status={
          <div className="flex flex-wrap items-center gap-2">
            <StageKindBadge stage={project.stageKind} />
            {statusAddsDetail(project.status) ? <ProjectStatusBadge status={project.status} /> : null}
            <PublishedBadge isPublic={project.isPublic} />
          </div>
        }
        description={
          <span className="text-meta">
            <span className="font-mono">{project.reference}</span> · {PROJECT_CATEGORY_LABELS[project.category]} · {projectLocationLabel(project)}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => router.push('/office/projects')}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Register
            </Button>
            <Button variant="secondary" onClick={() => void reload()} aria-label="Refresh">
              <RefreshCw className="h-4 w-4" aria-hidden />
            </Button>
          </>
        }
      />

      <div role="note" className="mb-4 flex items-start gap-3 rounded-card border border-deep-blue/20 bg-deep-blue/5 px-4 py-3">
        <Landmark className="mt-0.5 h-5 w-5 shrink-0 text-deep-blue" aria-hidden />
        <div className="text-body">
          <p>
            <strong>{project.responsibleInstitution.name}</strong> ({INSTITUTION_TYPE_LABELS[project.responsibleInstitution.type]}) is legally responsible for this project. This office tracks it.
          </p>
          <p className="text-meta text-slate">
            Source of commitment: {COMMITMENT_SOURCE_LABELS[project.commitmentSource]}
            {project.commitmentSourceDetail ? ` — ${project.commitmentSourceDetail}` : ''} · Completion: {completionLabel(project.status)}
          </p>
        </div>
      </div>

      {notice ? (
        <Notice tone="success" className="mb-4" action={<button type="button" className="text-meta underline" onClick={() => setNotice(null)}>Dismiss</button>}>
          {notice}
        </Notice>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2" aria-label="Project actions">
        {allowed.has('edit') ? (
          <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'edit' })}>
            <Pencil className="h-4 w-4" aria-hidden />
            Edit details
          </Button>
        ) : null}
        {allowed.has('transition') && projectTransitionTargets(project.status).length ? (
          <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'transition' })}>
            Change status
          </Button>
        ) : null}
        {canVerify && project.status === 'COMPLETED' ? (
          <Button
            size="sm"
            onClick={() => setDialog({ kind: 'verify_completion' })}
            disabled={!completion.enabled || !allowed.has('verify_completion')}
            aria-describedby={!completion.enabled ? 'verify-completion-why' : undefined}
          >
            <ShieldCheck className="h-4 w-4" aria-hidden />
            Verify completion
          </Button>
        ) : null}
      </div>
      {canVerify && project.status === 'COMPLETED' && !completion.enabled ? (
        <Notice tone="sod" className="mb-4" title="Completion cannot be verified yet">
          <ul id="verify-completion-why" className="list-disc pl-5">
            {completion.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <ViewTabs label="Project sections" value={tab} onChange={setTab} tabs={tabs} />

      {tab === 'summary' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Identity and location" />
            <CardBody>
              {project.description ? <p className="mb-4 whitespace-pre-wrap text-body">{project.description}</p> : null}
              <Facts
                items={[
                  { label: 'Category', value: PROJECT_CATEGORY_LABELS[project.category] },
                  { label: 'Location', value: projectLocationLabel(project), hint: project.location.description ?? undefined },
                  {
                    label: 'Coordinates',
                    value:
                      project.latitude !== null && project.longitude !== null ? (
                        <span className="inline-flex items-center gap-1 font-mono text-meta">
                          <MapPin className="h-3.5 w-3.5" aria-hidden />
                          {project.latitude.toFixed(5)}, {project.longitude.toFixed(5)}
                        </span>
                      ) : (
                        'Not recorded'
                      ),
                  },
                  { label: 'Recorded by', value: `${project.createdBy.displayName}, ${formatDateTime(project.createdAt)}` },
                ]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Governance" actions={<Building2 className="h-4 w-4 text-slate" aria-hidden />} />
            <CardBody>
              <Facts
                items={[
                  { label: 'Responsible institution', value: project.responsibleInstitution.name, hint: INSTITUTION_TYPE_LABELS[project.responsibleInstitution.type] },
                  { label: 'Implementing agency', value: project.implementingAgency?.name ?? 'Not recorded' },
                  { label: 'Named project owner', value: project.ownerName ?? 'Not recorded' },
                  { label: 'Approval authority', value: project.approvalAuthority ?? 'Not recorded' },
                  { label: 'Source of commitment', value: COMMITMENT_SOURCE_LABELS[project.commitmentSource], hint: project.commitmentSourceDetail ?? undefined },
                  { label: 'Tracking officer (this office)', value: project.trackingOfficer?.displayName ?? 'Not assigned' },
                ]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Schedule" />
            <CardBody>
              <Facts
                items={[
                  { label: 'Start date', value: formatDate(project.startDate) },
                  { label: 'Expected completion', value: formatDate(project.expectedCompletionDate) },
                  { label: 'Current milestone', value: project.currentMilestone?.title ?? '—' },
                  { label: 'Delay reason', value: project.delayReason ?? '—' },
                ]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Completion" />
            <CardBody>
              <Facts
                items={[
                  { label: 'State', value: completionLabel(project.status) },
                  { label: 'Actual completion date (reported)', value: formatDate(project.actualCompletionDate) },
                  {
                    label: 'Reported by',
                    value: project.completion.reportedBy ? `${project.completion.reportedBy.displayName}, ${formatDateTime(project.completion.reportedAt)}` : '—',
                  },
                  {
                    label: 'Verified by',
                    value: project.completion.verifiedBy ? `${project.completion.verifiedBy.displayName}, ${formatDateTime(project.completion.verifiedAt)}` : 'Not verified',
                    hint: project.completion.verificationNote ?? undefined,
                  },
                ]}
              />
            </CardBody>
          </Card>
        </div>
      ) : null}

      {tab === 'milestones' ? (
        <Card>
          <CardHeader
            title="Milestones"
            description="Reported progress. A milestone counts as verified only after a check by someone other than the person who reported it."
            actions={
              allowed.has('add_milestone') ? (
                <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'milestone' })}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Add milestone
                </Button>
              ) : null
            }
          />
          <CardBody>
            {project.milestones.length ? (
              <ol className="divide-y divide-line">
                {project.milestones.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink">
                        {m.sequence}. {m.title}
                      </p>
                      {m.description ? <p className="text-meta text-slate">{m.description}</p> : null}
                      <p className="text-meta text-slate">
                        Planned {formatDate(m.plannedDate)} · actual {formatDate(m.actualDate)} · {MILESTONE_STATUS_LABELS[m.status]}
                      </p>
                      {m.verifiedBy ? (
                        <p className="text-meta text-slate">
                          Checked by {m.verifiedBy.displayName}, {formatDateTime(m.verifiedAt)}
                          {m.verificationNote ? ` — ${m.verificationNote}` : ''}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <VerificationBadge status={m.verificationStatus} size="sm" />
                      {allowed.has('edit') && m.status !== 'CANCELLED' ? (
                        <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'milestone', milestone: m })}>
                          Update
                        </Button>
                      ) : null}
                      {canVerify && m.status === 'DONE' && m.verificationStatus !== 'VERIFIED' ? (
                        <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'verify_milestone', milestone: m })}>
                          Verify
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState title="No milestones yet" description="Add the responsible body's planned milestones so progress can be tracked against them." />
            )}
          </CardBody>
        </Card>
      ) : null}

      {tab === 'documents' || tab === 'photos' ? (
        <Card>
          <CardHeader
            title={tab === 'documents' ? 'Documents' : 'Photographs'}
            description={
              tab === 'documents'
                ? 'Inspection reports, certificates, handover documents, contracts, payment records and minutes.'
                : 'Progress photographs. A photograph alone is never proof of completion.'
            }
            actions={
              allowed.has('add_evidence') ? (
                <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'evidence', photo: tab === 'photos' })}>
                  <Plus className="h-4 w-4" aria-hidden />
                  {tab === 'documents' ? 'Add document' : 'Add photograph'}
                </Button>
              ) : null
            }
          />
          <CardBody>
            {(tab === 'documents' ? documents : photos).length ? (
              <ul className={tab === 'photos' ? 'grid gap-4 md:grid-cols-2' : 'space-y-4'}>
                {(tab === 'documents' ? documents : photos).map((e) => (
                  <EvidenceCard
                    key={e.id}
                    project={project}
                    evidence={e}
                    verifyBlock={evidenceVerifyBlock(e, meId, canVerify)}
                    showVerify={canVerify}
                    onVerify={() => setDialog({ kind: 'verify_evidence', evidence: e })}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState icon={tab === 'documents' ? FileText : Camera} title={tab === 'documents' ? 'No documents yet' : 'No photographs yet'} />
            )}
          </CardBody>
        </Card>
      ) : null}

      {tab === 'finance' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Funding and allocation" description="Every figure is shown with its source." />
            <CardBody>
              <Facts
                items={[
                  { label: 'Funding source', value: FUNDING_SOURCE_LABELS[project.fundingSource], hint: project.fundingSourceDetail ?? undefined },
                  { label: 'Approved allocation', value: formatMoney(project.approvedAllocation, project.currency), hint: project.allocationSource ? `Source: ${project.allocationSource}` : 'Source not recorded' },
                  {
                    label: 'Contract amount',
                    value: formatMoney(project.contractAmount, project.currency),
                    hint: project.contractAmountIsPublic ? 'Matter of public record' : 'Not public record: never shown on the portal',
                  },
                ]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="Reported expenditure"
              actions={
                allowed.has('verify_expenditure') ? (
                  <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'verify_expenditure' })}>
                    Verify expenditure
                  </Button>
                ) : null
              }
            />
            <CardBody>
              <Facts
                items={[
                  { label: 'Reported', value: formatMoney(project.expenditureReported, project.currency), hint: share !== null ? `${share}% of the approved allocation` : undefined },
                  { label: 'Source', value: project.expenditureSource ?? 'Not recorded' },
                  { label: 'As of', value: formatDate(project.expenditureAsOf) },
                  {
                    label: 'Verification',
                    value: <VerificationBadge status={project.expenditureVerificationStatus} size="sm" />,
                    hint: project.expenditureVerifiedBy ? `${project.expenditureVerifiedBy.displayName}, ${formatDateTime(project.expenditureVerifiedAt)}` : undefined,
                  },
                ]}
              />
              {canVerify && project.expenditureReported && !allowed.has('verify_expenditure') ? (
                <p className="mt-3 text-meta text-slate">You cannot verify this figure for this project.</p>
              ) : null}
              <p className="mt-3 text-meta text-slate">The person who last entered the expenditure cannot verify it. Changing the figure resets its verification.</p>
            </CardBody>
          </Card>
        </div>
      ) : null}

      {tab === 'history' ? (
        <Card>
          <CardHeader
            title="Update history"
            description="Append-only audit trail of this project, its milestones, evidence and publication."
            actions={
              <label className="flex items-center gap-2 text-meta text-slate">
                <input type="checkbox" checked={showFileViews} onChange={(e) => setShowFileViews(e.target.checked)} />
                Show file views
                <History className="h-4 w-4" aria-hidden />
              </label>
            }
          />
          <CardBody>
            {history.error ? <Notice tone="error">{describeOfficeError(history.error)}</Notice> : history.data ? <HistoryList events={history.data} hideFileAccess={!showFileViews} /> : <p className="text-slate">Loading…</p>}
          </CardBody>
        </Card>
      ) : null}

      {tab === 'public' ? <PublicationPanel project={project} canPublish={allowed.has('publish')} onSaved={(n) => saved(n, n.isPublic ? 'Public view saved.' : 'The project is not on the public portal.')} /> : null}

      {dialog?.kind === 'edit' ? <ProjectFormDialog project={project} onClose={() => setDialog(null)} onSaved={(n) => saved(n, 'Details saved.')} /> : null}
      {dialog?.kind === 'transition' ? <TransitionDialog project={project} onClose={() => setDialog(null)} onSaved={(n) => saved(n, 'Status changed.')} /> : null}
      {dialog?.kind === 'verify_completion' ? <VerifyCompletionDialog project={project} meId={meId} onClose={() => setDialog(null)} onSaved={(n) => saved(n, 'Completion verified.')} /> : null}
      {dialog?.kind === 'verify_expenditure' ? (
        <VerifyRecordDialog
          title="Verify reported expenditure"
          description={`${formatMoney(project.expenditureReported, project.currency)} reported${project.expenditureSource ? ` (source: ${project.expenditureSource})` : ''}. Check it against the responsible body's records.`}
          onClose={() => setDialog(null)}
          submit={async (body) => saved(await projectsApi.verifyExpenditure(project.id, { ...body, expectedVersion: project.version }), 'Expenditure check recorded.')}
        />
      ) : null}
      {dialog?.kind === 'milestone' ? <MilestoneDialog project={project} milestone={dialog.milestone} onClose={() => setDialog(null)} onSaved={() => void refresh('Milestone saved.')} /> : null}
      {dialog?.kind === 'verify_milestone' ? (
        <VerifyRecordDialog
          title={`Verify milestone ${dialog.milestone.sequence}`}
          description={`"${dialog.milestone.title}" is reported done${dialog.milestone.actualDate ? ` on ${formatDate(dialog.milestone.actualDate)}` : ''}. The person who reported it cannot verify it.`}
          onClose={() => setDialog(null)}
          submit={async (body) => {
            await projectsApi.verifyMilestone(project.id, dialog.milestone.id, body);
            await refresh('Milestone check recorded.');
          }}
        />
      ) : null}
      {dialog?.kind === 'evidence' ? (
        <AddEvidenceDialog project={project} defaultType={dialog.photo ? 'PHOTO' : 'INSPECTION_REPORT'} onClose={() => setDialog(null)} onSaved={() => void refresh('Evidence added. Another person must verify it.')} />
      ) : null}
      {dialog?.kind === 'verify_evidence' ? (
        <VerifyRecordDialog
          title={`Verify: ${PROJECT_EVIDENCE_TYPE_LABELS[dialog.evidence.type]}`}
          description={
            <>
              {dialog.evidence.description}
              {isPhoto(dialog.evidence.type) ? <span className="block text-meta">Verifying a photograph confirms what it shows; it never verifies completion.</span> : null}
              <span className="block text-meta">Disputed evidence is removed from the public view.</span>
            </>
          }
          onClose={() => setDialog(null)}
          submit={async (body) => {
            await projectsApi.verifyEvidence(project.id, dialog.evidence.id, body);
            await refresh('Evidence check recorded.');
          }}
        />
      ) : null}
    </>
  );
}

function EvidenceCard({
  project,
  evidence: e,
  verifyBlock,
  showVerify,
  onVerify,
}: {
  project: ProjectDetail;
  evidence: ProjectEvidence;
  verifyBlock: string | null;
  showVerify: boolean;
  onVerify: () => void;
}) {
  const milestone = project.milestones.find((m) => m.id === e.milestoneId);
  const hintId = `ev-why-${e.id}`;
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-ink">{PROJECT_EVIDENCE_TYPE_LABELS[e.type]}</p>
          <p className="text-body">{e.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <VerificationBadge status={e.verificationStatus} size="sm" />
          {e.isPublic ? <PublishedBadge isPublic size="sm" /> : null}
        </div>
      </div>
      <Facts
        className="mb-3 text-meta"
        items={[
          { label: isPhoto(e.type) ? 'Taken' : 'Issued', value: formatDate(e.capturedOn), hint: e.sourceDescription ?? undefined },
          { label: 'Uploaded by', value: `${e.uploadedBy.displayName}, ${formatDateTime(e.uploadedAt)}` },
          { label: 'Milestone', value: milestone ? `${milestone.sequence}. ${milestone.title}` : 'Whole project' },
          {
            label: 'Verifier',
            value: e.verifiedBy ? `${e.verifiedBy.displayName}, ${formatDateTime(e.verifiedAt)}` : 'Not verified',
            hint: e.verificationNote ?? undefined,
          },
          ...(e.latitude !== null && e.longitude !== null ? [{ label: 'Location metadata', value: `${e.latitude.toFixed(5)}, ${e.longitude.toFixed(5)}` }] : []),
        ]}
      />
      <OfficeFilePreview compact file={e.file} alt={`${PROJECT_EVIDENCE_TYPE_LABELS[e.type]}: ${e.description}`} loadUrl={(download) => projectsApi.evidenceUrl(project.id, e.id, download)} />
      {showVerify && e.verificationStatus !== 'VERIFIED' ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={onVerify} disabled={!!verifyBlock} aria-describedby={verifyBlock ? hintId : undefined}>
            <ShieldCheck className="h-4 w-4" aria-hidden />
            Verify
          </Button>
          {verifyBlock ? (
            <span id={hintId} className="text-meta text-slate">
              {verifyBlock}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
