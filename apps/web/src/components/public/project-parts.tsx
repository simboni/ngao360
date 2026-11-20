'use client';

import type { ProjectStageKind } from '@ngao360/shared';
import { Camera, Info } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePortal } from './portal-context';
import { PUBLIC_STAGE_ORDER, PUBLIC_STAGE_STYLE, STAGE_TONE_CLASS } from './project-labels';

/** Stage badge: icon + short word; the full explanation is in `title` and the legend. */
export function ProjectStageBadge({ kind, className }: { kind: ProjectStageKind; className?: string }) {
  const { t } = usePortal();
  const spec = PUBLIC_STAGE_STYLE[kind];
  const Icon = spec.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-body font-semibold', STAGE_TONE_CLASS[spec.tone], className)}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      {t(`projects.stage.${kind}`)}
    </span>
  );
}

/** "A photograph alone is not proof of completion" plus the API disclaimer. */
export function ProjectDisclaimer({ text, className }: { text?: string; className?: string }) {
  const { t } = usePortal();
  return (
    <div role="note" className={cn('flex items-start gap-3 rounded-lg border border-gold/60 bg-gold/10 p-3 text-base text-ink', className)}>
      <Camera className="mt-0.5 h-5 w-5 shrink-0 text-[#7a5a17]" aria-hidden />
      <div>
        <p className="font-semibold">{t('project.photoNote')}</p>
        {text ? <p className="mt-0.5 text-ink/90">{text}</p> : null}
      </div>
    </div>
  );
}

export function StageLegend() {
  const { t } = usePortal();
  return (
    <details className="rounded-lg border border-line bg-surface p-3 text-base">
      <summary className="flex min-h-[32px] cursor-pointer items-center gap-2 font-semibold text-deep-blue">
        <Info className="h-4 w-4" aria-hidden />
        {t('projects.legend.title')}
      </summary>
      <dl className="mt-3 space-y-3">
        {PUBLIC_STAGE_ORDER.map((k) => (
          <div key={k} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
            <dt className="shrink-0 sm:w-52">
              <ProjectStageBadge kind={k} />
            </dt>
            <dd className="text-ink/90">{t(`projects.legend.${k}`)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
