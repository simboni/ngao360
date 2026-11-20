import type { ProjectStageKind } from '@ngao360/shared';
import { en } from './i18n';
import { Ban, BadgeCheck, ClipboardCheck, HardHat, Hourglass, type LucideIcon, MessageSquareQuote } from 'lucide-react';

/**
 * Short public stage labels. They keep a commitment, an approved project,
 * work under way, reported completion and verified completion visibly apart.
 * "Completed (reported)" never appears without "(reported)", and only
 * independent verification earns "Verified completed".
 */
export const PUBLIC_STAGE_SHORT: Record<ProjectStageKind, string> = {
  COMMITMENT: en['projects.stage.COMMITMENT'],
  APPROVED: en['projects.stage.APPROVED'],
  IMPLEMENTATION: en['projects.stage.IMPLEMENTATION'],
  REPORTED_COMPLETE: en['projects.stage.REPORTED_COMPLETE'],
  VERIFIED_COMPLETE: en['projects.stage.VERIFIED_COMPLETE'],
  CANCELLED: en['projects.stage.CANCELLED'],
};

export type StageTone = 'muted' | 'info' | 'pending' | 'success' | 'danger';

export const PUBLIC_STAGE_STYLE: Record<ProjectStageKind, { icon: LucideIcon; tone: StageTone }> = {
  COMMITMENT: { icon: MessageSquareQuote, tone: 'muted' },
  APPROVED: { icon: ClipboardCheck, tone: 'info' },
  IMPLEMENTATION: { icon: HardHat, tone: 'info' },
  REPORTED_COMPLETE: { icon: Hourglass, tone: 'pending' },
  VERIFIED_COMPLETE: { icon: BadgeCheck, tone: 'success' },
  CANCELLED: { icon: Ban, tone: 'muted' },
};

export const STAGE_TONE_CLASS: Record<StageTone, string> = {
  muted: 'border-slate/30 bg-slate/10 text-ink',
  info: 'border-deep-blue/25 bg-deep-blue/10 text-deep-blue',
  pending: 'border-gold/60 bg-gold/15 text-[#6b4f12]',
  success: 'border-success/40 bg-success/10 text-success',
  danger: 'border-error/30 bg-error/10 text-error',
};

/** Public stage filter order (matches PROJECT_STAGE_KINDS). */
export const PUBLIC_STAGE_ORDER: ProjectStageKind[] = ['COMMITMENT', 'APPROVED', 'IMPLEMENTATION', 'REPORTED_COMPLETE', 'VERIFIED_COMPLETE', 'CANCELLED'];

/** Format an API money string ("1250000.50") for display without float rounding. */
export function formatMoney(amount: string | null | undefined, currency: string): string | null {
  if (!amount) return null;
  const [whole, frac] = amount.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${grouped}${frac ? `.${frac.padEnd(2, '0')}` : ''}`;
}
