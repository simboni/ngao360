import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';

/** One S30 settings section with an anchor (`/settings#<id>`) the onboarding checklist links to. */
export function SettingsSection({ id, title, description, actions, children }: { id: string; title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24">
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="text-card font-semibold text-ink">
              {title}
            </h2>
            {description ? <p className="mt-1 text-meta text-slate">{description}</p> : null}
          </div>
          {actions}
        </div>
        {children}
      </Card>
    </section>
  );
}
