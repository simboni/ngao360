import type { LucideIcon } from 'lucide-react';
import { formatDateTime, formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';

export interface KpiCardProps {
  label: string;
  value: number | string | null;
  /** Context such as "of 16 expected stations". */
  sublabel?: string;
  /** Source freshness timestamp (blueprint 12.3). */
  asOf?: string | null;
  icon?: LucideIcon;
  /** Only show a trend when statistically meaningful. */
  trend?: { value: string; direction: 'up' | 'down' | 'flat' } | null;
  className?: string;
}

export function KpiCard({ label, value, sublabel, asOf, icon: Icon, trend, className }: KpiCardProps) {
  return (
    <div className={cn('ngao-card flex flex-col gap-2 p-4', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-meta font-medium uppercase tracking-wide text-slate">{label}</span>
        {Icon ? <Icon className="h-4 w-4 text-slate" aria-hidden /> : null}
      </div>
      <div className="text-[28px] font-semibold leading-8 text-navy">
        {typeof value === 'number' ? formatNumber(value) : (value ?? '—')}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-slate">
        {sublabel ? <span>{sublabel}</span> : null}
        {trend ? <span>{trend.direction === 'up' ? '▲' : trend.direction === 'down' ? '▼' : '■'} {trend.value}</span> : null}
        {asOf ? <span>As of {formatDateTime(asOf)}</span> : null}
      </div>
    </div>
  );
}
