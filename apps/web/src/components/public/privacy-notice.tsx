import type { PrivacyNotice as PrivacyNoticeDto } from '@ngao360/shared';
import { ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * The versioned privacy notice from GET /public/:tenantSlug/portal, shown in
 * full before the person submits anything (what / why / who / how long /
 * rights / contact). The text comes from the API so the stored version always
 * matches what was displayed.
 */
export function PrivacyNoticeView({
  notice,
  versionLabel,
  headingLevel = 2,
  className,
  id,
}: {
  notice: PrivacyNoticeDto;
  versionLabel?: string;
  headingLevel?: 2 | 3;
  className?: string;
  id?: string;
}) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const S = headingLevel === 2 ? 'h3' : 'h4';
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={cn('rounded-lg border border-deep-blue/20 bg-deep-blue/5 p-4', className)}>
      <H id={id ? `${id}-title` : undefined} className="flex items-start gap-2 text-section font-semibold text-navy">
        <ShieldCheck className="mt-1 h-5 w-5 shrink-0 text-deep-blue" aria-hidden />
        <span>{notice.title}</span>
      </H>
      <p className="mt-2 text-base text-ink">{notice.summary}</p>
      <dl className="mt-3 space-y-3">
        {notice.sections.map((s) => (
          <div key={s.heading}>
            <dt>
              <S className="text-base font-semibold text-ink">{s.heading}</S>
            </dt>
            <dd className="mt-0.5 text-base text-ink/90">{s.body}</dd>
          </div>
        ))}
      </dl>
      {versionLabel ? <p className="mt-3 text-meta text-slate">{versionLabel}</p> : null}
    </section>
  );
}
