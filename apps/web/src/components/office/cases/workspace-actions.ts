/**
 * Which stage actions the S25 toolbar offers. Driven by the API's
 * `allowedActions` (permissions, scope, state and separation of duties) and
 * the shared transition table, so the UI never offers a move the API refuses.
 */
import { type CaseAction, type CaseDetail, type CaseStatus, type CaseTransition, canTransitionCase } from '@ngao360/shared';

export interface WorkspaceAction {
  key: 'triage' | 'assign' | 'start' | 'refer' | 'propose' | 'feedback' | 'close' | 'reopen' | 'edit' | 'evidence';
  label: string;
  /** Target of a generic transition (for `start`). */
  to?: CaseTransition['to'];
  primary: boolean;
}

const RESUME_FROM: CaseStatus[] = ['REFERRED', 'RESOLUTION_PROPOSED', 'CITIZEN_FEEDBACK', 'REOPENED'];

export function availableCaseActions(
  detail: Pick<CaseDetail, 'status' | 'assignee' | 'allowedActions'>,
  opts: { canManage: boolean },
): WorkspaceAction[] {
  const has = (a: CaseAction) => detail.allowedActions.includes(a);
  const s = detail.status;
  const manage = opts.canManage && has('edit');
  const out: WorkspaceAction[] = [];

  if (has('triage') && s === 'SUBMITTED') out.push({ key: 'triage', label: 'Start triage', to: 'TRIAGE', primary: true });
  if (has('assign')) {
    out.push({ key: 'assign', label: detail.assignee ? 'Change assignee' : 'Assign', primary: !detail.assignee && (s === 'TRIAGE' || s === 'REOPENED') });
  }
  if (manage && detail.assignee && (s === 'TRIAGE' || s === 'REOPENED') && canTransitionCase(s, 'ASSIGNED')) {
    out.push({ key: 'start', label: 'Mark assigned', to: 'ASSIGNED', primary: false });
  }
  if (manage && canTransitionCase(s, 'IN_PROGRESS')) {
    out.push({ key: 'start', label: RESUME_FROM.includes(s) ? 'Resume work' : 'Start work', to: 'IN_PROGRESS', primary: s === 'ASSIGNED' });
  }
  if (has('refer') && (s === 'TRIAGE' || s === 'ASSIGNED' || s === 'IN_PROGRESS' || s === 'REFERRED')) {
    out.push({ key: 'refer', label: s === 'REFERRED' ? 'Refer to another institution' : 'Refer', primary: false });
  }
  if (has('propose_resolution')) out.push({ key: 'propose', label: 'Propose resolution', primary: s === 'IN_PROGRESS' || s === 'REFERRED' });
  if (manage && s === 'RESOLUTION_PROPOSED' && canTransitionCase(s, 'CITIZEN_FEEDBACK')) {
    out.push({ key: 'feedback', label: 'Ask the requester for feedback', primary: true });
  }
  if (has('close')) out.push({ key: 'close', label: s === 'SUBMITTED' || s === 'TRIAGE' ? 'Close at triage' : 'Close case', primary: s === 'RESOLUTION_PROPOSED' || s === 'CITIZEN_FEEDBACK' });
  if (has('reopen') && s === 'CLOSED') out.push({ key: 'reopen', label: 'Reopen', primary: true });
  if (has('edit') && s !== 'CLOSED') out.push({ key: 'edit', label: 'Edit details', primary: false });
  if (has('add_evidence') && s !== 'CLOSED') out.push({ key: 'evidence', label: 'Add evidence', primary: false });
  return out;
}
