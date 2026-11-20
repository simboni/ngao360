/**
 * Pure communications workflow logic (blueprint 5.4, API §26): the workflow
 * stepper, the actions offered for an item, list tabs and a small line diff
 * for the revision and correction history. The API is the authority.
 */
import {
  CONTENT_FORBIDDEN_FIELDS,
  type ContentDetail,
  type ContentQuery,
  type ContentRevision,
  type ContentRevisionKind,
  type ContentStatus,
  type ContentTransition,
} from '@ngao360/shared';

/** The main path shown in the stepper (archive and withdrawal are end states after publication). */
export const WORKFLOW_STEPS: ReadonlyArray<{ status: ContentStatus; label: string }> = [
  { status: 'DRAFT', label: 'Draft' },
  { status: 'EDITORIAL_REVIEW', label: 'Editorial review' },
  { status: 'AWAITING_APPROVAL', label: 'Authorised approval' },
  { status: 'APPROVED', label: 'Approved' },
  { status: 'PUBLISHED', label: 'Published' },
  { status: 'ARCHIVED', label: 'Archived' },
];

/** Index of the current step; WITHDRAWN sits at the publication step. */
export function workflowStepIndex(status: ContentStatus): number {
  if (status === 'WITHDRAWN') return WORKFLOW_STEPS.findIndex((s) => s.status === 'PUBLISHED');
  return WORKFLOW_STEPS.findIndex((s) => s.status === status);
}

export type WorkflowAction = ContentTransition['action'];

export interface ActionSpec {
  action: WorkflowAction;
  label: string;
  /** Short explanation shown in the confirmation. */
  explain: string;
  noteRequired: boolean;
  /** The API asks for re-authentication (high-risk permission). */
  reauth: boolean;
  tone: 'primary' | 'secondary' | 'danger';
}

export const ACTION_SPECS: Record<WorkflowAction, ActionSpec> = {
  SUBMIT: { action: 'SUBMIT', label: 'Submit for editorial review', explain: 'Editors are notified. You can no longer edit the text unless it is returned.', noteRequired: false, reauth: false, tone: 'primary' },
  EDITORIAL_APPROVE: { action: 'EDITORIAL_APPROVE', label: 'Pass editorial review', explain: 'Sends the item to an authorised approver. You are recorded as the editor.', noteRequired: false, reauth: false, tone: 'primary' },
  RETURN: { action: 'RETURN', label: 'Return to author', explain: 'The item goes back to draft with your note; the author is notified.', noteRequired: true, reauth: false, tone: 'secondary' },
  APPROVE: { action: 'APPROVE', label: 'Approve for publication', explain: 'High-risk action: confirm your password. You cannot approve an item you wrote.', noteRequired: false, reauth: true, tone: 'primary' },
  PUBLISH: { action: 'PUBLISH', label: 'Record publication', explain: 'Records that the approved text was published on its channel. Nothing is sent from the platform.', noteRequired: false, reauth: false, tone: 'primary' },
  ARCHIVE: { action: 'ARCHIVE', label: 'Archive', explain: 'The item is kept read-only with its full history.', noteRequired: false, reauth: false, tone: 'secondary' },
  WITHDRAW: { action: 'WITHDRAW', label: 'Withdraw', explain: 'Marks the published item as withdrawn, with your reason. This is final.', noteRequired: true, reauth: true, tone: 'danger' },
};

/** Workflow actions offered for an item, in display order, from `allowedActions` (SoD already applied by the API). */
export function contentActions(d: Pick<ContentDetail, 'allowedActions'>): ActionSpec[] {
  const order: WorkflowAction[] = ['SUBMIT', 'EDITORIAL_APPROVE', 'APPROVE', 'PUBLISH', 'RETURN', 'ARCHIVE', 'WITHDRAW'];
  return order.filter((a) => d.allowedActions.includes(a)).map((a) => ACTION_SPECS[a]);
}

export type ContentTab = 'awaiting_me' | 'draft' | 'review' | 'approved' | 'published' | 'closed' | 'all';

export const CONTENT_TABS: ReadonlyArray<{ key: ContentTab; label: string }> = [
  { key: 'awaiting_me', label: 'Awaiting me' },
  { key: 'draft', label: 'Drafts' },
  { key: 'review', label: 'In review' },
  { key: 'approved', label: 'Approved' },
  { key: 'published', label: 'Published' },
  { key: 'closed', label: 'Archived and withdrawn' },
  { key: 'all', label: 'All' },
];

export function tabQuery(tab: ContentTab): Partial<ContentQuery> {
  switch (tab) {
    case 'awaiting_me':
      return { view: 'awaiting_me' };
    case 'draft':
      return { status: 'DRAFT' };
    case 'review':
      return { status: ['EDITORIAL_REVIEW', 'AWAITING_APPROVAL'] };
    case 'approved':
      return { status: 'APPROVED' };
    case 'published':
      return { status: 'PUBLISHED' };
    case 'closed':
      return { status: ['ARCHIVED', 'WITHDRAWN'] };
    default:
      return {};
  }
}

export const REVISION_KIND_LABELS: Record<ContentRevisionKind, string> = {
  CREATED: 'Draft created',
  EDITED: 'Text edited',
  SUBMITTED_FOR_REVIEW: 'Submitted for editorial review',
  RETURNED: 'Returned to author',
  EDITORIAL_APPROVED: 'Passed editorial review',
  APPROVED: 'Approved for publication',
  PUBLISHED: 'Publication recorded',
  CORRECTED: 'Correction published',
  ARCHIVED: 'Archived',
  WITHDRAWN: 'Withdrawn',
};

/** Revisions that changed the text (for "compare with previous"). */
export function textRevisions(revs: readonly ContentRevision[]): ContentRevision[] {
  return revs.filter((r) => r.kind === 'CREATED' || r.kind === 'EDITED' || r.kind === 'CORRECTED');
}

/** The previous text revision before `rev`, or null. */
export function previousText(revs: readonly ContentRevision[], rev: ContentRevision): ContentRevision | null {
  const texts = textRevisions(revs);
  const i = texts.findIndex((r) => r.id === rev.id);
  return i > 0 ? texts[i - 1]! : null;
}

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

/** Line diff (longest common subsequence); fine for press-release sized texts. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 250_000) return [...a.map((t) => ({ kind: 'removed' as const, text: t })), ...b.map((t) => ({ kind: 'added' as const, text: t }))];
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: 'removed', text: a[i++]! });
    else out.push({ kind: 'added', text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! });
  return out;
}

/**
 * Political boundary (blueprint 5.4, 15.2): the editor never sends a field the
 * API refuses as a recipient list. Returns the offending keys, if any.
 */
export function forbiddenFields(body: Record<string, unknown>): string[] {
  return CONTENT_FORBIDDEN_FIELDS.filter((k) => k in body);
}
