import { Inbox, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
}: {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-cloud">
        <Icon className="h-6 w-6 text-slate" aria-hidden />
      </span>
      <div>
        <p className="text-card font-semibold text-ink">{title}</p>
        {description ? <p className="mt-1 max-w-md text-body text-slate">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
