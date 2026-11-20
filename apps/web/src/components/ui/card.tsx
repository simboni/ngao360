import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ngao-card', className)} {...rest} />;
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 border-b border-line px-4 py-3', className)}>
      <div>
        <h2 className="text-card font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-meta text-slate">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...rest} />;
}
