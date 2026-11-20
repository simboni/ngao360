import type { PublicCaseStage } from '@ngao360/shared';

export type StepState = 'done' | 'current' | 'upcoming';

/**
 * The simple progress line shown on the tracking page. "Referred" replaces
 * "Being worked on" as the third step when the request went to another
 * institution, so the line never suggests the office is doing work it handed
 * over. Reopened requests show as "Being reviewed" (the API maps them).
 */
export function publicStageSteps(stage: PublicCaseStage): Array<{ stage: PublicCaseStage; state: StepState }> {
  const third: PublicCaseStage = stage === 'REFERRED' ? 'REFERRED' : 'IN_PROGRESS';
  const order: PublicCaseStage[] = ['RECEIVED', 'UNDER_REVIEW', third, 'RESOLUTION_PROPOSED', 'CLOSED'];
  const idx = order.indexOf(stage);
  return order.map((s, i) => ({ stage: s, state: i < idx ? 'done' : i === idx ? 'current' : 'upcoming' }));
}

/** Normalise what people type: upper case, no spaces, common look-alikes kept as typed. */
export function normaliseReference(v: string): string {
  return v.trim().toUpperCase().replace(/\s+/g, '');
}
