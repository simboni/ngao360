'use client';

import type { CandidateReference, FormTemplate, SubmissionDetail } from '@ngao360/shared';
import { useMemo } from 'react';
import { buildRows, type CaptureRow } from './capture-model';
import { tallyApi } from './tally-api';
import { useAsync } from './use-async';

export interface SubmissionBundle {
  detail: SubmissionDetail | undefined;
  template: FormTemplate | undefined;
  candidates: CandidateReference[];
  rows: CaptureRow[];
  loading: boolean;
  /** Detail, template and candidates have each loaded or failed at least once. */
  ready: boolean;
  error: unknown;
  /** Template or candidates could not be loaded; rows fall back to stored values. */
  referenceError: unknown;
  reload: () => Promise<void>;
  setDetail: (d: SubmissionDetail) => void;
}

/** Load a submission with its form template and contest candidates for the capture and verify screens. */
export function useSubmission(id: string): SubmissionBundle {
  const detail = useAsync(() => tallyApi.submission(id), [id]);
  const templateId = detail.data?.formTemplateId;
  const contestId = detail.data?.contestId;
  const template = useAsync(() => tallyApi.formTemplate(templateId!), [templateId], !!templateId);
  const candidates = useAsync(() => tallyApi.candidates(contestId!), [contestId], !!contestId);

  const rows = useMemo(
    () => (detail.data ? buildRows(template.data?.fieldSchema, candidates.data ?? [], detail.data.values) : []),
    [detail.data, template.data, candidates.data],
  );

  return {
    detail: detail.data,
    template: template.data,
    candidates: candidates.data ?? [],
    rows,
    loading: detail.loading || template.loading || candidates.loading,
    ready:
      detail.data !== undefined &&
      (template.data !== undefined || !!template.error) &&
      (candidates.data !== undefined || !!candidates.error),
    error: detail.error,
    referenceError: template.error ?? candidates.error,
    reload: detail.reload,
    setDetail: detail.setData,
  };
}
